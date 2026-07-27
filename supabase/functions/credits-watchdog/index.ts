/**
 * credits-watchdog — met le pipeline en pause a court de credits, le relance
 * quand ils reviennent.
 *
 * Pour chaque workspace ayant un provider payant actif :
 *   1. Interroge le solde du provider (FullEnrich /account/credits,
 *      Apify /users/me/limits).
 *   2. Solde sous le seuil -> `provider_credit_state` passe 'exhausted' et
 *      les jobs d'enrichissement vivants du workspace sont mis en pause
 *      (statut 'paused' : les items restent 'pending', rien n'est perdu).
 *   3. Solde revenu -> etat 'ok' + reprise de tous les jobs mis en pause pour
 *      motif credits : ils repassent 'pending' et `concurrency` workers sont
 *      relances. Le scraping repart de lui-meme au prochain run, puisque
 *      scrape-job-signals ne saute que les sources marquees 'exhausted'.
 *   4. Email aux admins a chaque transition (pause / reprise), une seule fois
 *      par bascule d'etat et non a chaque tick.
 *
 * Invocation :
 *   - pg_cron toutes les 10 min :
 *       SELECT public.call_credits_watchdog('https://<ref>.supabase.co/functions/v1');
 *   - manuellement depuis l'UI (bouton "Reprendre" de la modale
 *     d'enrichissement) : POST avec un JWT admin.
 *
 * Auth : Bearer SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, ou JWT d'un admin.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractUserId } from "../_shared/subscription-access.ts";
import { createResendService } from "../_shared/resend.ts";
import { resolveCredential } from "../_shared/providers/registry.ts";
import {
  getCreditState,
  setCreditState,
  shouldBlindRetry,
  verdictFromBalance,
  type CreditCategory,
} from "../_shared/credit-state.ts";

/**
 * Seuil sous lequel on considere le provider a sec. On s'arrete AVANT zero :
 * un enrichissement bulk consomme plusieurs credits d'un coup, partir sur un
 * solde de 2 revient a se prendre un 402 en plein milieu.
 */
const FULLENRICH_MIN_CREDITS = Number(Deno.env.get("FULLENRICH_MIN_CREDITS") || "5");
/**
 * Marge de reprise : on ne redemarre qu'avec un solde franchement au-dessus du
 * seuil de pause, sinon un compte qui oscille autour du seuil ferait
 * pause/reprise/pause a chaque tick de cron.
 */
const RESUME_MARGIN = Number(Deno.env.get("CREDITS_RESUME_MARGIN") || "10");
/** Budget Apify restant (USD) sous lequel on met la source en pause. */
const APIFY_MIN_USD = Number(Deno.env.get("APIFY_MIN_USD") || "0.5");
/**
 * Filet pour les providers dont on n'arrive pas a lire le solde : au bout de
 * ce delai on retente optimistement (etat remis a 'ok'). Si les credits ne
 * sont toujours pas la, le prochain 402 remettra la source en pause — on perd
 * un appel, pas une journee de pipeline.
 */
const BLIND_RETRY_MINUTES = Number(Deno.env.get("CREDITS_BLIND_RETRY_MINUTES") || "60");

const ALERT_RECIPIENTS = (Deno.env.get("ALERT_RECIPIENTS") || "")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);

interface ProviderCheck {
  workspaceId: string;
  category: CreditCategory;
  providerType: string;
  /** Solde lu, ou null si le provider ne l'expose pas / appel echoue. */
  balance: number | null;
  /** Unite affichee dans les logs et l'email. */
  unit: string;
  /** true = a sec, false = OK, null = indetermine (on ne change pas d'etat). */
  exhausted: boolean | null;
  error?: string;
}

// ─── Lecture des soldes ──────────────────────────────────────────────────────

/** FullEnrich expose un solde en credits. Selon la version : credits|balance|total. */
async function checkFullEnrich(apiKey: string): Promise<{ balance: number | null; error?: string }> {
  try {
    const res = await fetch("https://app.fullenrich.com/api/v2/account/credits", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { balance: null, error: `GET /account/credits HTTP ${res.status}` };
    }
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const raw = payload.credits ?? payload.balance ?? payload.total;
    return typeof raw === "number" ? { balance: raw } : { balance: null, error: "solde illisible dans la reponse" };
  } catch (err) {
    return { balance: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Apify : /users/me/limits donne l'usage du cycle courant et le plafond du
 * plan. On en deduit le budget restant en USD. La forme exacte varie selon le
 * plan (prepaye vs abonnement) : si on ne sait pas lire, on renvoie null et le
 * watchdog s'en remet au filet BLIND_RETRY_MINUTES plutot que d'inventer.
 */
async function checkApify(token: string): Promise<{ balance: number | null; error?: string }> {
  try {
    const res = await fetch(`https://api.apify.com/v2/users/me/limits?token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { balance: null, error: `GET /users/me/limits HTTP ${res.status}` };
    }
    const payload = (await res.json().catch(() => ({}))) as {
      data?: {
        limits?: { maxMonthlyUsageUsd?: number };
        current?: { monthlyUsageUsd?: number };
      };
    };
    const max = payload.data?.limits?.maxMonthlyUsageUsd;
    const used = payload.data?.current?.monthlyUsageUsd;
    if (typeof max !== "number" || typeof used !== "number") {
      return { balance: null, error: "budget mensuel illisible dans la reponse" };
    }
    return { balance: Math.max(0, max - used) };
  } catch (err) {
    return { balance: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500, corsHeaders);
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  if (!(await isAuthorized(supabase, req, serviceKey))) {
    return json({ error: "Unauthorized" }, 401, corsHeaders);
  }

  // INTERNAL_WORKER_JWT : meme raison que dans enqueue-enrichment — le gateway
  // verify_jwt=true rejette la cle sb_secret_*, les workers respawnes doivent
  // recevoir un vrai JWT.
  const workerJwt = Deno.env.get("INTERNAL_WORKER_JWT") || serviceKey;
  const functionsUrl = `${supabaseUrl}/functions/v1`;

  const checks = await runChecks(supabase);
  const transitions: Array<{ workspace_id: string; provider: string; from: string; to: string; balance: number | null; unit: string }> = [];
  const resumed: Array<{ workspace_id: string; jobs: number; spawned: number }> = [];
  const pausedJobs: Array<{ workspace_id: string; jobs: number }> = [];

  for (const check of checks) {
    const previous = await getCreditState(supabase, check.workspaceId, check.category, check.providerType);
    const wasExhausted = previous?.state === "exhausted";

    // Verdict indetermine (solde illisible, ou bande d'hysteresis) : on
    // conserve l'etat courant. Exception, le filet aveugle : un provider a sec
    // depuis assez longtemps dont on ne sait pas lire le solde est retente.
    let exhausted = check.exhausted;
    if (exhausted === null) {
      if (wasExhausted && check.balance === null && shouldBlindRetry(previous?.exhausted_at ?? null, BLIND_RETRY_MINUTES)) {
        console.log(
          `[credits-watchdog] ${check.providerType}: solde illisible depuis ${BLIND_RETRY_MINUTES}min — reprise optimiste`
        );
        exhausted = false;
      } else {
        exhausted = wasExhausted;
      }
    }

    const { changed } = await setCreditState(
      supabase,
      check.workspaceId,
      check.category,
      check.providerType,
      exhausted ? "exhausted" : "ok",
      { balance: check.balance, error: check.error ?? null },
    );

    if (changed) {
      transitions.push({
        workspace_id: check.workspaceId,
        provider: `${check.category}/${check.providerType}`,
        from: wasExhausted ? "exhausted" : "ok",
        to: exhausted ? "exhausted" : "ok",
        balance: check.balance,
        unit: check.unit,
      });
    }

    // Pause / reprise pilotees par le verdict, pas par la transition : les deux
    // RPC sont idempotentes (0 ligne si rien a faire) et ce choix rattrape les
    // etats incoherents — typiquement un job reste 'paused' parce que le
    // marquage 'exhausted' avait echoue au moment du 402.
    // Seul l'enrichissement a des jobs a suspendre ; le scraping est stateless,
    // scrape-job-signals relit provider_credit_state a chaque run.
    if (check.category !== "enricher") continue;

    if (exhausted) {
      const { data, error } = await supabase.rpc("pause_enrichment_jobs_for_workspace", {
        p_workspace_id: check.workspaceId,
        p_reason: `${check.providerType}_credits_exhausted`,
      });
      if (error) {
        console.error(`[credits-watchdog] pause jobs failed:`, error.message);
      } else {
        const jobs = (data?.[0]?.out_jobs as number | undefined) ?? 0;
        if (jobs > 0) {
          pausedJobs.push({ workspace_id: check.workspaceId, jobs });
          console.warn(`[credits-watchdog] ${jobs} job(s) mis en pause (${check.providerType})`);
        }
      }
    } else {
      const { data, error } = await supabase.rpc("resume_paused_enrichment_jobs", {
        p_functions_url: functionsUrl,
        p_service_role_key: workerJwt,
        p_workspace_id: check.workspaceId,
        p_reason_like: "%credits%",
      });
      if (error) {
        console.error(`[credits-watchdog] resume jobs failed:`, error.message);
      } else {
        const rows = (data ?? []) as Array<{ out_job_id: string; out_spawned: number }>;
        const spawned = rows.reduce((acc, r) => acc + (r.out_spawned ?? 0), 0);
        if (rows.length > 0) {
          resumed.push({ workspace_id: check.workspaceId, jobs: rows.length, spawned });
          console.log(`[credits-watchdog] ${rows.length} job(s) repris, ${spawned} worker(s) relances`);
        }
      }
    }
  }

  if (transitions.length > 0) {
    await notifyAdmins(transitions);
  }

  return json(
    {
      checked: checks.map((c) => ({
        workspace_id: c.workspaceId,
        provider: `${c.category}/${c.providerType}`,
        balance: c.balance,
        unit: c.unit,
        exhausted: c.exhausted,
        error: c.error ?? null,
      })),
      transitions,
      paused_jobs: pausedJobs,
      resumed_jobs: resumed,
    },
    200,
    corsHeaders,
  );
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** service_role, CRON_SECRET (pg_cron via Vault), ou JWT d'un admin (bouton UI). */
async function isAuthorized(supabase: SupabaseClient, req: Request, serviceKey: string): Promise<boolean> {
  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!bearer) return false;

  const cronSecret = Deno.env.get("CRON_SECRET");
  const workerJwt = Deno.env.get("INTERNAL_WORKER_JWT");
  if (bearer === serviceKey || (cronSecret && bearer === cronSecret) || (workerJwt && bearer === workerJwt)) {
    return true;
  }

  const { userId, error } = await extractUserId(supabase, req);
  if (error || !userId) return false;
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", userId).single();
  return profile?.role === "admin";
}

/** Un check par (workspace, provider payant actif). */
async function runChecks(supabase: SupabaseClient): Promise<ProviderCheck[]> {
  const { data: providers, error } = await supabase
    .from("workspace_providers")
    .select("workspace_id, category, provider_type")
    .eq("is_active", true)
    .in("provider_type", ["fullenrich", "apify_linkedin"]);

  if (error) {
    console.error("[credits-watchdog] workspace_providers query failed:", error.message);
    return [];
  }

  const checks: ProviderCheck[] = [];
  for (const row of (providers ?? []) as Array<{ workspace_id: string; category: CreditCategory; provider_type: string }>) {
    const creds = await resolveCredential(supabase, row.workspace_id, row.category, row.provider_type);
    if (!creds) {
      console.warn(`[credits-watchdog] ${row.provider_type}: aucune credential resolue, check saute`);
      continue;
    }

    const state = await getCreditState(supabase, row.workspace_id, row.category, row.provider_type);
    const currentlyExhausted = state?.state === "exhausted";

    if (row.provider_type === "fullenrich") {
      const { balance, error: err } = await checkFullEnrich(creds.api_key ?? "");
      checks.push({
        workspaceId: row.workspace_id,
        category: row.category,
        providerType: row.provider_type,
        balance,
        unit: "credits",
        exhausted: verdictFromBalance(balance, FULLENRICH_MIN_CREDITS, currentlyExhausted, RESUME_MARGIN),
        error: err,
      });
    } else {
      const { balance, error: err } = await checkApify(creds.api_token ?? creds.api_key ?? "");
      checks.push({
        workspaceId: row.workspace_id,
        category: row.category,
        providerType: row.provider_type,
        balance,
        unit: "USD",
        exhausted: verdictFromBalance(balance, APIFY_MIN_USD, currentlyExhausted, RESUME_MARGIN),
        error: err,
      });
    }
  }

  return checks;
}

async function notifyAdmins(
  transitions: Array<{ provider: string; from: string; to: string; balance: number | null; unit: string }>,
): Promise<void> {
  if (ALERT_RECIPIENTS.length === 0) {
    console.warn("[credits-watchdog] ALERT_RECIPIENTS non configure, email saute");
    return;
  }

  const paused = transitions.filter((t) => t.to === "exhausted");
  const back = transitions.filter((t) => t.to === "ok");
  const subject = paused.length > 0
    ? `Jay Reach : pipeline en pause (credits epuises)`
    : `Jay Reach : pipeline redemarre (credits de retour)`;

  const lines: string[] = [];
  for (const t of paused) {
    lines.push(`- ${t.provider} : credits epuises (solde ${t.balance ?? "inconnu"} ${t.unit}) -> pipeline en pause`);
  }
  for (const t of back) {
    lines.push(`- ${t.provider} : credits de retour (solde ${t.balance ?? "inconnu"} ${t.unit}) -> reprise automatique`);
  }
  if (paused.length > 0) {
    lines.push("", "Rien n'est perdu : les entreprises restantes sont conservees et reprendront la ou elles en etaient.");
    lines.push("Recharger : https://app.fullenrich.com/billing (enrichissement) / https://console.apify.com/billing (scraping).");
  }
  lines.push("", "-- credits-watchdog");

  const text = lines.join("\n");
  const html = lines
    .map((l) => (l.trim() === "" ? "<br>" : `<p style="margin:0 0 8px 0;">${escapeHtml(l)}</p>`))
    .join("");

  try {
    const resend = createResendService();
    const result = await resend.sendEmail({
      to: ALERT_RECIPIENTS,
      subject,
      html,
      text,
      tags: [{ name: "type", value: "credits_pipeline_state" }],
    });
    if (!result.success) {
      console.error("[credits-watchdog] email send failed:", result.error);
    }
  } catch (err) {
    console.error("[credits-watchdog] resend init failed:", (err as Error).message);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function json(payload: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
