import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { smartleadProvider } from "./smartlead-provider.ts";
import type { OutreachLead, OutreachProviderConfig } from "./types.ts";

const CTX: OutreachProviderConfig = { workspace_id: "ws-1", config: {}, apiKey: "test-key" };

interface CampaignRow {
  campaign_id: string;
  campaign_name: string | null;
  enabled: boolean;
  persona_id: string;
  workspace_id: string;
}

/** Stub du query builder supabase : .select().in().in() puis await -> { data }. */
function fakeSupabase(campaigns: CampaignRow[]): SupabaseClient {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  builder.select = self;
  builder.in = self;
  builder.eq = self;
  builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: campaigns, error: null });
  return { from: () => builder } as unknown as SupabaseClient;
}

function lead(prospectId: string, personaId: string | null, workspaceId = "ws-1"): OutreachLead {
  return {
    prospect_id: prospectId,
    workspace_id: workspaceId,
    persona_id: personaId,
    email: `${prospectId}@example.com`,
    first_name: "Jean",
    last_name: "Dupont",
    company_name: "ACME",
    job_title: "DAF",
    linkedin_url: null,
    body_html: "<p>Bonjour</p>",
    subject: "Sujet",
    enrichment: {},
  };
}

interface FetchCall {
  url: string;
  campaignId: string;
  leadCount: number;
  isStatusCall: boolean;
}

/**
 * Remplace globalThis.fetch. `failingCampaigns` : campagnes dont l'ajout de leads
 * renvoie une 500 (pour verifier l'isolation des echecs).
 */
function stubFetch(calls: FetchCall[], failingCampaigns: string[] = []) {
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const campaignId = url.match(/campaigns\/([^/]+)\//)?.[1] ?? "";
    const isStatusCall = url.includes("/status");
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const leadCount = Array.isArray(body.lead_list) ? body.lead_list.length : 0;

    calls.push({ url, campaignId, leadCount, isStatusCall });

    if (!isStatusCall && failingCampaigns.includes(campaignId)) {
      return Promise.resolve(new Response(JSON.stringify({ message: "quota exceeded" }), { status: 500 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, added_count: leadCount, skipped_count: 0 }), { status: 200 }),
    );
  };
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test("pushMany — regroupe les leads d'une meme campagne en un seul appel", async () => {
  const calls: FetchCall[] = [];
  const restore = stubFetch(calls);
  try {
    const supabase = fakeSupabase([
      { campaign_id: "111", campaign_name: "DAF", enabled: true, persona_id: "p-daf", workspace_id: "ws-1" },
      { campaign_id: "222", campaign_name: "CEO", enabled: true, persona_id: "p-ceo", workspace_id: "ws-1" },
    ]);

    const results = await smartleadProvider.pushMany!(
      [lead("a", "p-daf"), lead("b", "p-daf"), lead("c", "p-ceo")],
      CTX,
      supabase,
    );

    const addCalls = calls.filter((c) => !c.isStatusCall);
    assertEquals(addCalls.length, 2, "1 appel par campagne, pas 1 par lead");
    assertEquals(addCalls.find((c) => c.campaignId === "111")?.leadCount, 2);
    assertEquals(addCalls.find((c) => c.campaignId === "222")?.leadCount, 1);

    // Reveil de campagne : une fois par campagne, pas une fois par lead.
    assertEquals(calls.filter((c) => c.isStatusCall).length, 2);

    assertEquals(results.map((r) => r.ok), [true, true, true]);
    assertEquals(results.map((r) => r.prospect_id), ["a", "b", "c"]);
    assertEquals(results[0]?.result?.provider_ref, "111");
  } finally {
    restore();
  }
});

Deno.test("pushMany — decoupe en tranches de 400 (plafond API Smartlead)", async () => {
  const calls: FetchCall[] = [];
  const restore = stubFetch(calls);
  try {
    const supabase = fakeSupabase([
      { campaign_id: "111", campaign_name: "DAF", enabled: true, persona_id: "p-daf", workspace_id: "ws-1" },
    ]);
    const leads = Array.from({ length: 401 }, (_, i) => lead(`p${i}`, "p-daf"));

    const results = await smartleadProvider.pushMany!(leads, CTX, supabase);

    const addCalls = calls.filter((c) => !c.isStatusCall);
    assertEquals(addCalls.map((c) => c.leadCount), [400, 1]);
    assertEquals(results.filter((r) => r.ok).length, 401);
  } finally {
    restore();
  }
});

Deno.test("pushMany — un lead sans persona echoue seul, le lot continue", async () => {
  const calls: FetchCall[] = [];
  const restore = stubFetch(calls);
  try {
    const supabase = fakeSupabase([
      { campaign_id: "111", campaign_name: "DAF", enabled: true, persona_id: "p-daf", workspace_id: "ws-1" },
    ]);

    const results = await smartleadProvider.pushMany!([lead("a", null), lead("b", "p-daf")], CTX, supabase);

    assertEquals(results[0]?.ok, false);
    assertStringIncludes(results[0]?.error ?? "", "persona");
    assertEquals(results[1]?.ok, true);
    assertEquals(calls.filter((c) => !c.isStatusCall).length, 1);
  } finally {
    restore();
  }
});

Deno.test("pushMany — persona sans campagne activee : erreur actionnable, pas d'appel", async () => {
  const calls: FetchCall[] = [];
  const restore = stubFetch(calls);
  try {
    const supabase = fakeSupabase([
      { campaign_id: "111", campaign_name: "DAF", enabled: false, persona_id: "p-daf", workspace_id: "ws-1" },
    ]);

    const results = await smartleadProvider.pushMany!([lead("a", "p-daf")], CTX, supabase);

    assertEquals(results[0]?.ok, false);
    assertStringIncludes(results[0]?.error ?? "", "Aucune campagne Smartlead");
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

Deno.test("pushMany — l'echec d'une campagne n'affecte pas l'autre", async () => {
  const calls: FetchCall[] = [];
  const restore = stubFetch(calls, ["111"]);
  try {
    const supabase = fakeSupabase([
      { campaign_id: "111", campaign_name: "DAF", enabled: true, persona_id: "p-daf", workspace_id: "ws-1" },
      { campaign_id: "222", campaign_name: "CEO", enabled: true, persona_id: "p-ceo", workspace_id: "ws-1" },
    ]);

    const results = await smartleadProvider.pushMany!([lead("a", "p-daf"), lead("b", "p-ceo")], CTX, supabase);

    assertEquals(results[0]?.ok, false);
    assertStringIncludes(results[0]?.error ?? "", "quota exceeded");
    assertEquals(results[1]?.ok, true);
    // La campagne en echec n'est pas reveillee.
    assertEquals(calls.filter((c) => c.isStatusCall).map((c) => c.campaignId), ["222"]);
  } finally {
    restore();
  }
});

Deno.test("push — chemin unitaire : delegue a pushMany et leve sur echec", async () => {
  const calls: FetchCall[] = [];
  const restore = stubFetch(calls);
  try {
    const supabase = fakeSupabase([
      { campaign_id: "111", campaign_name: "DAF", enabled: true, persona_id: "p-daf", workspace_id: "ws-1" },
    ]);

    const result = await smartleadProvider.push(lead("a", "p-daf"), CTX, supabase);
    assertEquals(result.added, 1);
    assertEquals(result.provider_ref, "111");
    assertEquals(result.meta?.campaign_name, "DAF");

    let thrown: string | null = null;
    try {
      await smartleadProvider.push(lead("b", null), CTX, supabase);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    assertStringIncludes(thrown ?? "", "persona");
  } finally {
    restore();
  }
});
