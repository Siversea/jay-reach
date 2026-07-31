import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractUserId } from "../_shared/subscription-access.ts";
import { shouldPushToSmartlead, type GateInput } from "../_shared/email-gate.ts";
import { resolveOutreachProvider } from "../_shared/outreach/registry.ts";
import { pushManyOrSequential, type OutreachLead, type OutreachPushResult } from "../_shared/outreach/types.ts";
import { validateOrRespond, z } from "../_shared/validation.ts";

/**
 * send-via-smartlead
 *
 * Ajoute un ou plusieurs prospects a la campagne Smartlead correspondante.
 * Le subject + body persos sont passes via custom_fields : {{subject}} et {{body}}
 * dans le template Smartlead liront ces custom fields.
 *
 * L'operateur doit avoir cree au prealable sa campagne dans Smartlead avec :
 * - Une sequence dont le step 1 utilise {{subject}} et {{body}} comme variables
 * - Le CV en piece jointe (upload manuel une fois)
 *
 * Deux modes, un seul chemin de code (l'unitaire est un lot de 1) :
 *
 * 1. Unitaire — { "prospect_id": "<uuid>", "channel": "email" }
 *    Reponse legacy : { ok, provider_type, provider_ref, added, skipped, lead_email, meta }
 *    Les refus renvoient les statuts historiques (404 / 400 / 422 / 412).
 *
 * 2. Lot — { "prospect_ids": ["<uuid>", ...] } (max 200)
 *    Toutes les requetes DB sont groupees et les leads d'une meme campagne
 *    partent en un seul appel Smartlead. Reponse 200 avec le detail par
 *    prospect : { ok, total, pushed, gate_refused, failed, results, errors }.
 *    Un prospect en echec n'interrompt jamais le reste du lot.
 *
 * Champs communs : user_id (requis si service_role auth), manual_override,
 * dry_run (unitaire uniquement).
 */

/** Garde-fou wall-clock de l'edge function. Le front decoupe en tranches de 100. */
const MAX_BATCH = 200;

const SendViaSmartleadRequestSchema = z.object({
  prospect_id: z.string().uuid().optional(),
  prospect_ids: z.array(z.string().uuid()).min(1).max(MAX_BATCH).optional(),
  channel: z.string().optional(),
  user_id: z.string().uuid().optional(),
  dry_run: z.boolean().optional(),
  manual_override: z.boolean().optional(),
});

interface RequestBody {
  prospect_id?: string;
  /** Push groupe. Exclusif avec dry_run. */
  prospect_ids?: string[];
  channel?: string;
  user_id?: string;
  /** Si true : build le HTML complet (body + attachments inline) mais skip le push Smartlead. Retourne { body_html, subject }. Utile pour preview. */
  dry_run?: boolean;
  /**
   * Push manuel volontaire (clic user dans l'UI). Bypass uniquement le reject
   * `pending_bouncer` (deliverability_status NULL). Les autres protections (invalid,
   * role, suspicious_name) restent : Smartlead bannerait vite si on push des
   * emails confirmes morts.
   */
  manual_override?: boolean;
}

type ItemStatus = "pushed" | "gate_refused" | "failed";

interface ItemResult {
  prospect_id: string;
  status: ItemStatus;
  /** Code machine : raison du gate, ou not_found / no_email / no_draft / no_provider / push_failed. */
  reason: string;
  /** Message lisible (detail du gate, erreur provider). */
  detail?: string;
  email?: string | null;
  /** Statut HTTP renvoye en mode unitaire (retro-compat stricte). */
  httpStatus?: number;
  push?: OutreachPushResult;
  provider_type?: string;
  demo?: boolean;
}

const PROSPECT_COLUMNS =
  "id, first_name, last_name, email, job_title, company_name, linkedin_url, persona_id, workspace_id, enrichment_data, " +
  "email_source, email_validation_status, deliverability_status, deliverability_reason, company_group_id";

interface ProspectRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  job_title: string | null;
  company_name: string | null;
  linkedin_url: string | null;
  persona_id: string | null;
  workspace_id: string;
  enrichment_data: Record<string, unknown> | null;
  email_source: string | null;
  email_validation_status: string | null;
  deliverability_status: string | null;
  deliverability_reason: string | null;
  company_group_id: string | null;
}

interface BrandAttachment {
  persona_id?: string | null;
  channel?: string | null;
  type: "inline_image";
  url: string;
  alt?: string;
}

const textToHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

/** Body final : texte converti en HTML + attachments inline configures dans workspace_brand. */
function buildBodyHtml(body: string, attachments: BrandAttachment[]): string {
  let html = textToHtml(body);
  for (const a of attachments) {
    const altSafe = (a.alt ?? "").replace(/"/g, "&quot;");
    html +=
      `<br><br><img src="${a.url}" alt="${altSafe}" ` +
      `style="max-width:600px;width:100%;display:block;border-radius:8px;margin-top:12px;" />`;
  }
  return html;
}

/** Attachments applicables a ce prospect (filtre persona + channel). */
function attachmentsFor(all: BrandAttachment[], personaId: string | null, channel: string): BrandAttachment[] {
  return all.filter(
    (a) =>
      a.type === "inline_image" &&
      (!a.persona_id || a.persona_id === personaId) &&
      (!a.channel || a.channel === channel),
  );
}

/**
 * Applique le gate a tout le lot : une seule requete domain_email_patterns pour
 * tous les domaines, et les decisions sont persistees groupees par verdict.
 */
async function runGate(
  supabase: SupabaseClient,
  prospects: ProspectRow[],
  manualOverride: boolean,
): Promise<{ allowed: ProspectRow[]; refused: ItemResult[] }> {
  const domains = [...new Set(prospects.map((p) => p.email!.split("@")[1]?.toLowerCase() ?? ""))].filter(Boolean);

  const { data: patterns } = await supabase
    .from("domain_email_patterns")
    .select("domain, pattern, confidence, tier, sample_count, empirical_sends, empirical_bounces, downgraded_at")
    .in("domain", domains);

  const patternByDomain = new Map((patterns ?? []).map((p) => [p.domain as string, p]));

  const allowed: ProspectRow[] = [];
  const refused: ItemResult[] = [];
  /** Clef "decision|reason" -> prospect_ids, pour grouper les UPDATE. */
  const decisionGroups = new Map<string, string[]>();

  for (const prospect of prospects) {
    const domain = prospect.email!.split("@")[1]?.toLowerCase() ?? "";
    const pattern = patternByDomain.get(domain);

    const gateInput: GateInput = {
      email: prospect.email!,
      email_source: (prospect.email_source ?? "unknown") as GateInput["email_source"],
      email_validation_status: prospect.email_validation_status ?? null,
      deliverability_status: (prospect.deliverability_status ?? null) as GateInput["deliverability_status"],
      deliverability_reason: prospect.deliverability_reason ?? null,
      first_name: prospect.first_name ?? "",
      last_name: prospect.last_name ?? "",
      domain_pattern: pattern
        ? {
          pattern: pattern.pattern,
          confidence: Number(pattern.confidence),
          tier: pattern.tier as "high" | "medium" | "low" | "skip",
          sample_count: pattern.sample_count,
          empirical_sends: pattern.empirical_sends,
          empirical_bounces: pattern.empirical_bounces,
          downgraded_at: pattern.downgraded_at,
        }
        : null,
    };

    let decision = shouldPushToSmartlead(gateInput);

    // Push manuel : si l'user clic explicite et le seul blocage est
    // `pending_bouncer` (deliverability_status NULL = pas encore verifie), on autorise.
    // Les autres rejects restent (invalid email, role, suspicious_name) :
    // Smartlead bannerait vite si on push des emails confirmes morts.
    if (manualOverride && !decision.allow && decision.reason === "pending_bouncer") {
      console.log(`[send-via-smartlead] manual override prospect=${prospect.id} bypass pending_bouncer`);
      decision = { allow: true, reason: "manual_override_pending_bouncer" };
    }

    const key = `${decision.allow ? "push" : decision.reason}|${decision.reason}`;
    const group = decisionGroups.get(key);
    if (group) group.push(prospect.id);
    else decisionGroups.set(key, [prospect.id]);

    if (decision.allow) {
      allowed.push(prospect);
    } else {
      console.log(`[send-via-smartlead] gate refused prospect=${prospect.id} reason=${decision.reason}`);
      refused.push({
        prospect_id: prospect.id,
        status: "gate_refused",
        reason: decision.reason,
        detail: decision.detail,
        email: prospect.email,
        httpStatus: 422,
      });
    }
  }

  for (const [key, prospectIds] of decisionGroups) {
    const [pushDecision, pushReason] = key.split("|");
    await supabase
      .from("prospect_profiles")
      .update({ smartlead_push_decision: pushDecision, smartlead_push_reason: pushReason })
      .in("id", prospectIds);
  }

  return { allowed, refused };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: getCorsHeaders(req.headers.get("origin")) });
  }

  let body: RequestBody = {};
  try {
    const rawText = await req.text();
    if (rawText && rawText.trim()) {
      body = JSON.parse(rawText) as RequestBody;
    }
  } catch {
    // empty
  }

  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  const json = (payload: unknown, status: number) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  const _validation = validateOrRespond(SendViaSmartleadRequestSchema, body, corsHeaders, "strict", {
    functionName: "send-via-smartlead",
  });
  if (_validation.response) return _validation.response;
  const validated = _validation.data;
  body = validated as RequestBody;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { userId, error: authError } = await extractUserId(supabase, req, body.user_id);
  if (authError || !userId) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Admin check
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();
  if (profile?.role !== "admin") {
    return json({ error: "Admin only" }, 403);
  }

  const batchMode = Array.isArray(body.prospect_ids) && body.prospect_ids.length > 0;
  const ids = batchMode ? [...new Set(body.prospect_ids)] : body.prospect_id ? [body.prospect_id] : [];

  if (ids.length === 0) {
    return json({ error: "Missing prospect_id" }, 400);
  }
  if (body.dry_run && batchMode) {
    return json({ error: "dry_run ne supporte qu'un seul prospect_id" }, 400);
  }

  const channel = body.channel || "email";
  if (channel !== "email") {
    return json({ error: `Channel not supported: ${channel}` }, 400);
  }

  try {
    const items: ItemResult[] = [];

    // 1. Fetch les prospects en une requete
    const { data: prospectRows, error: pErr } = await supabase
      .from("prospect_profiles")
      .select(PROSPECT_COLUMNS)
      .in("id", ids);
    if (pErr) throw new Error(pErr.message);

    // Le select est passe en chaine : supabase-js ne sait pas inferer les colonnes.
    const rows = (prospectRows ?? []) as unknown as ProspectRow[];
    const prospectById = new Map(rows.map((p) => [p.id, p]));

    const withEmail: ProspectRow[] = [];
    for (const id of ids) {
      const prospect = prospectById.get(id);
      if (!prospect) {
        items.push({ prospect_id: id, status: "failed", reason: "not_found", detail: "Prospect not found", httpStatus: 404 });
      } else if (!prospect.email) {
        items.push({
          prospect_id: id,
          status: "failed",
          reason: "no_email",
          detail: "Prospect has no email",
          httpStatus: 400,
        });
      } else {
        withEmail.push(prospect);
      }
    }

    // 2. Email gate : refuse si bouncer dit invalide ou pattern faible
    let candidates: ProspectRow[] = [];
    if (withEmail.length > 0) {
      const { allowed, refused } = await runGate(supabase, withEmail, body.manual_override === true);
      items.push(...refused);
      candidates = allowed;
    }

    // 3. Fetch les drafts email (le plus recent par prospect) en une requete
    const readyToPush: { prospect: ProspectRow; messageId: string; subject: string; body: string }[] = [];
    if (candidates.length > 0) {
      const { data: messages } = await supabase
        .from("prospect_messages")
        .select("id, prospect_id, subject, body")
        .in("prospect_id", candidates.map((p) => p.id))
        .eq("channel", "email")
        .eq("status", "draft")
        .order("created_at", { ascending: false });

      const draftByProspect = new Map<string, { id: string; subject: string | null; body: string }>();
      for (const m of messages ?? []) {
        if (!draftByProspect.has(m.prospect_id as string)) {
          draftByProspect.set(m.prospect_id as string, {
            id: m.id as string,
            subject: m.subject as string | null,
            body: m.body as string,
          });
        }
      }

      for (const prospect of candidates) {
        const draft = draftByProspect.get(prospect.id);
        if (!draft) {
          items.push({
            prospect_id: prospect.id,
            status: "failed",
            reason: "no_draft",
            detail: "No draft email message found",
            email: prospect.email,
            httpStatus: 404,
          });
          continue;
        }
        readyToPush.push({ prospect, messageId: draft.id, subject: draft.subject ?? "", body: draft.body });
      }
    }

    // 4. Push, groupe par workspace (le provider et le branding sont par workspace)
    const pushedMessageIds: string[] = [];
    const pushedActions: Record<string, unknown>[] = [];

    const byWorkspace = new Map<string, typeof readyToPush>();
    for (const entry of readyToPush) {
      const group = byWorkspace.get(entry.prospect.workspace_id);
      if (group) group.push(entry);
      else byWorkspace.set(entry.prospect.workspace_id, [entry]);
    }

    for (const [workspaceId, entries] of byWorkspace) {
      // 4a. Resolve le provider outreach actif (Phase 1.4 : abstraction Smartlead/autres)
      const resolved = await resolveOutreachProvider(supabase, workspaceId, channel);
      if (!resolved && !body.dry_run) {
        const detail =
          `No active outreach provider configured for workspace/channel=${channel}. Configure workspace_outreach_providers.`;
        for (const { prospect } of entries) {
          items.push({
            prospect_id: prospect.id,
            status: "failed",
            reason: "no_provider",
            detail,
            email: prospect.email,
            httpStatus: 412,
          });
        }
        continue;
      }

      // 4b. Mode demo : on bloque les vrais envois Smartlead. Le caller voit que
      // l'action a "reussi" en mode demo (UI affiche un toast), mais aucun
      // email n'est envoye et rien n'est trace dans Smartlead.
      if (resolved?.provider?.type === "demo") {
        for (const { prospect } of entries) {
          console.log(`[send-via-smartlead] demo mode : faking send for prospect ${prospect.id}`);
          items.push({
            prospect_id: prospect.id,
            status: "pushed",
            reason: "demo",
            detail: "Envoi simule en mode demo. Configurez un provider Smartlead reel pour les vrais envois.",
            email: prospect.email,
            provider_type: "demo",
            demo: true,
          });
        }
        continue;
      }

      // 4c. Branding : une seule lecture workspace_brand pour tout le lot
      const { data: brand } = await supabase
        .from("workspace_brand")
        .select("attachments")
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      const allAttachments = (brand?.attachments as BrandAttachment[] | undefined) ?? [];

      const leads: OutreachLead[] = entries.map(({ prospect, subject, body: messageBody }) => ({
        prospect_id: prospect.id,
        workspace_id: prospect.workspace_id,
        persona_id: prospect.persona_id,
        email: prospect.email!,
        first_name: prospect.first_name,
        last_name: prospect.last_name,
        company_name: prospect.company_name,
        job_title: prospect.job_title,
        linkedin_url: prospect.linkedin_url,
        body_html: buildBodyHtml(messageBody, attachmentsFor(allAttachments, prospect.persona_id, channel)),
        subject,
        enrichment: (prospect.enrichment_data as Record<string, unknown> | null) ?? {},
      }));

      // 4d. Dry-run : retourne le HTML rendu sans push (preview admin, unitaire uniquement)
      if (body.dry_run) {
        const lead = leads[0]!;
        return json(
          {
            ok: true,
            dry_run: true,
            subject: lead.subject,
            body_html: lead.body_html,
            email: lead.email,
            provider_type: resolved?.provider.type ?? null,
          },
          200,
        );
      }

      // 4e. Push : un seul appel provider par campagne pour tout le lot
      const pushResults = await pushManyOrSequential(resolved!.provider, leads, resolved!.context, supabase);
      const entryByProspect = new Map(entries.map((e) => [e.prospect.id, e]));

      for (const res of pushResults) {
        const entry = entryByProspect.get(res.prospect_id);
        if (!entry) continue;
        if (res.ok && res.result) {
          items.push({
            prospect_id: res.prospect_id,
            status: "pushed",
            reason: "pushed",
            email: entry.prospect.email,
            push: res.result,
            provider_type: resolved!.provider.type,
          });
          pushedMessageIds.push(entry.messageId);
          pushedActions.push({
            prospect_id: entry.prospect.id,
            workspace_id: entry.prospect.workspace_id,
            company_group_id: entry.prospect.company_group_id,
            action_type: "sent",
            channel: "email",
          });
        } else {
          items.push({
            prospect_id: res.prospect_id,
            status: "failed",
            reason: "push_failed",
            detail: res.error,
            email: entry.prospect.email,
            // Erreurs de configuration actionnables (campagne non reliee / persona
            // absent) -> 412, pas 500 : ce n'est pas un crash.
            httpStatus: /campagne smartlead|persona/i.test(res.error ?? "") ? 412 : 500,
          });
        }
      }
    }

    // 5. Bookkeeping groupe : statut des messages + tracking des actions
    if (pushedMessageIds.length > 0) {
      await supabase
        .from("prospect_messages")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .in("id", pushedMessageIds);
    }
    if (pushedActions.length > 0) {
      // Track l'action "sent/email" pour que useCompanyProgress remonte le %
      // company_group_id est requis (cle de jointure dans le hook progress)
      const { error: actionErr } = await supabase.from("prospect_actions").insert(pushedActions);
      if (actionErr) {
        // Pas bloquant pour le push mais on logge pour ne plus jamais avoir
        // des % a 0 alors que tout est parti (bug du 2026-05-18).
        console.warn(`[send-via-smartlead] Failed to log ${pushedActions.length} prospect_action(s): ${actionErr.message}`);
      }
    }

    // 6. Reponse
    if (!batchMode) {
      // Mode unitaire : on conserve strictement les payloads et statuts historiques.
      const item = items[0]!;
      if (item.status === "pushed") {
        if (item.demo) {
          return json({ ok: true, demo: true, message: item.detail }, 200);
        }
        return json(
          {
            ok: true,
            provider_type: item.provider_type,
            provider_ref: item.push?.provider_ref ?? null,
            added: item.push?.added ?? 0,
            skipped: item.push?.skipped ?? 0,
            lead_email: item.email,
            meta: item.push?.meta ?? {},
          },
          200,
        );
      }
      if (item.status === "gate_refused") {
        return json({ error: "Email gate refused", reason: item.reason, detail: item.detail }, 422);
      }
      return json({ error: item.detail ?? "Push failed" }, item.httpStatus ?? 500);
    }

    const pushed = items.filter((i) => i.status === "pushed");
    const gateRefused = items.filter((i) => i.status === "gate_refused");
    const failed = items.filter((i) => i.status === "failed");

    console.log(
      `[send-via-smartlead] batch termine : ${pushed.length} pousse(s), ` +
        `${gateRefused.length} bloque(s) par le gate, ${failed.length} en echec (total ${items.length})`,
    );

    return json(
      {
        ok: true,
        total: items.length,
        pushed: pushed.length,
        gate_refused: gateRefused.length,
        failed: failed.length,
        // Messages d'erreur distincts, pour que le front en affiche un utile
        // plutot qu'un simple compteur.
        errors: [...new Set(failed.map((i) => i.detail).filter(Boolean))],
        results: items.map((i) => ({
          prospect_id: i.prospect_id,
          status: i.status,
          reason: i.reason,
          detail: i.detail,
          added: i.push?.added,
          provider_ref: i.push?.provider_ref ?? null,
        })),
      },
      200,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    // Erreurs de configuration actionnables par l'utilisateur (campagne non reliée /
    // persona absent) -> 412, pas 500 : ce n'est pas un crash. Le front affiche le message.
    const isConfigError = /campagne smartlead|persona/i.test(msg);
    if (!isConfigError) console.error("[send-via-smartlead] Error:", err);
    return json({ error: msg }, isConfigError ? 412 : 500);
  }
});
