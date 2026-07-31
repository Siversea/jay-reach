// SmartleadProvider : implementation actuelle du push Smartlead.
// Resout le campaign_id depuis smartlead_campaigns par persona_id uniquement,
// puis push via l'API Smartlead.
//
// Le push unitaire delegue a pushMany : un seul chemin de code, donc pas de
// divergence de comportement entre l'envoi d'un lead et celui d'un lot.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { addLeadsToCampaign, setCampaignStatus, type SmartleadLead } from "../smartlead.ts";
import type {
  OutreachBatchItemResult,
  OutreachLead,
  OutreachProvider,
  OutreachProviderConfig,
  OutreachPushResult,
} from "./types.ts";

/** Plafond impose par l'API Smartlead (cf addLeadsToCampaign). */
const MAX_LEADS_PER_REQUEST = 400;

const NO_PERSONA_ERROR = "Ce contact n'a pas de persona : impossible de résoudre la campagne Smartlead.";
const NO_CAMPAIGN_ERROR =
  "Aucune campagne Smartlead reliée à ce persona. Relie-le à une campagne dans l'onglet Campagnes.";

function toSmartleadLead(lead: OutreachLead): SmartleadLead {
  return {
    email: lead.email,
    first_name: lead.first_name || undefined,
    last_name: lead.last_name || undefined,
    company_name: lead.company_name || undefined,
    linkedin_profile: lead.linkedin_url || undefined,
    website: (lead.enrichment.company_website as string) || undefined,
    location: (lead.enrichment.company_city as string) || undefined,
    custom_fields: {
      subject: lead.subject,
      body: lead.body_html,
      job_title: lead.job_title || "",
      prospect_id: lead.prospect_id,
      persona_id: lead.persona_id ?? "",
    },
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const smartleadProvider: OutreachProvider = {
  type: "smartlead",

  async push(lead: OutreachLead, ctx: OutreachProviderConfig, supabase: SupabaseClient): Promise<OutreachPushResult> {
    const [item] = await smartleadProvider.pushMany!([lead], ctx, supabase);
    // Retro-compat : le chemin unitaire remonte l'echec en exception (mappee en
    // 412 par send-via-smartlead quand c'est une erreur de configuration).
    if (!item || !item.ok || !item.result) throw new Error(item?.error ?? "Smartlead push failed");
    return item.result;
  },

  async pushMany(
    leads: OutreachLead[],
    ctx: OutreachProviderConfig,
    supabase: SupabaseClient,
  ): Promise<OutreachBatchItemResult[]> {
    const results = new Map<string, OutreachBatchItemResult>();

    // 1. Resolve les campagnes : persona_id uniquement, une seule requete pour tout le lot.
    const routable: OutreachLead[] = [];
    for (const lead of leads) {
      if (!lead.persona_id) {
        results.set(lead.prospect_id, { prospect_id: lead.prospect_id, ok: false, error: NO_PERSONA_ERROR });
      } else {
        routable.push(lead);
      }
    }

    if (routable.length > 0) {
      const { data: campaigns } = await supabase
        .from("smartlead_campaigns")
        .select("campaign_id, campaign_name, enabled, persona_id, workspace_id")
        .in("workspace_id", [...new Set(routable.map((l) => l.workspace_id))])
        .in("persona_id", [...new Set(routable.map((l) => l.persona_id as string))]);

      const campaignByKey = new Map<string, { campaign_id: string; campaign_name: string | null }>();
      for (const row of campaigns ?? []) {
        if (!row.enabled) continue;
        campaignByKey.set(`${row.workspace_id}::${row.persona_id}`, {
          campaign_id: row.campaign_id,
          campaign_name: row.campaign_name,
        });
      }

      // 2. Regroupe par campagne : 1 appel Smartlead par campagne (par tranche de 400)
      //    au lieu d'un appel par lead.
      const groups = new Map<string, { campaign_name: string | null; leads: OutreachLead[] }>();
      for (const lead of routable) {
        const campaign = campaignByKey.get(`${lead.workspace_id}::${lead.persona_id}`);
        if (!campaign) {
          results.set(lead.prospect_id, { prospect_id: lead.prospect_id, ok: false, error: NO_CAMPAIGN_ERROR });
          continue;
        }
        const group = groups.get(campaign.campaign_id);
        if (group) group.leads.push(lead);
        else groups.set(campaign.campaign_id, { campaign_name: campaign.campaign_name, leads: [lead] });
      }

      // 3. Push par campagne. Un lot en echec ne bloque pas les autres campagnes.
      for (const [campaignId, group] of groups) {
        let pushedAtLeastOne = false;

        for (const slice of chunk(group.leads, MAX_LEADS_PER_REQUEST)) {
          try {
            const res = await addLeadsToCampaign(campaignId, slice.map(toSmartleadLead), ctx.apiKey);
            pushedAtLeastOne = true;
            console.log(
              `[smartlead-provider] pushed ${slice.length} lead(s) -> campaign ${campaignId} ` +
                `(added=${res.added_count ?? 0} skipped=${res.skipped_count ?? 0})`,
            );
            for (const lead of slice) {
              results.set(lead.prospect_id, {
                prospect_id: lead.prospect_id,
                ok: true,
                result: {
                  // added/skipped sont les compteurs du lot : Smartlead ne les
                  // ventile pas par lead. Sur un lot de 1 ils valent pour ce lead.
                  added: res.added_count ?? 0,
                  skipped: res.skipped_count ?? 0,
                  provider_ref: campaignId,
                  meta: { campaign_name: group.campaign_name, batch_size: slice.length },
                },
              });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : "Smartlead push failed";
            console.error(`[smartlead-provider] push failed for campaign ${campaignId}:`, err);
            for (const lead of slice) {
              results.set(lead.prospect_id, { prospect_id: lead.prospect_id, ok: false, error: message });
            }
          }
        }

        // Smartlead laisse une campagne en COMPLETED apres le dernier lead ; on
        // reveille une seule fois par campagne, pas une fois par lead.
        if (pushedAtLeastOne) {
          try {
            await setCampaignStatus(campaignId, "START", ctx.apiKey);
          } catch (err) {
            console.warn(`[smartlead-provider] could not wake campaign ${campaignId}:`, err);
          }
        }
      }
    }

    return leads.map(
      (lead) =>
        results.get(lead.prospect_id) ?? { prospect_id: lead.prospect_id, ok: false, error: "Smartlead push failed" },
    );
  },
};
