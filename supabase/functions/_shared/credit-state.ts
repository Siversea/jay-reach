/**
 * Etat de credit des providers — pause / reprise du pipeline.
 *
 * Quand un provider payant tombe a court (FullEnrich 402, Apify usage limit),
 * on ne tue plus le travail en cours : on marque le provider 'exhausted' dans
 * `provider_credit_state`, on met les jobs d'enrichissement en pause et on
 * saute les scrapes concernes. L'edge function `credits-watchdog` surveille le
 * solde et remet tout en marche des que les credits reviennent.
 *
 * Migration : 20260727160000_credit_pause_resume.sql
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/** Categories de provider suivies (memes valeurs que workspace_providers.category). */
export type CreditCategory = "enricher" | "source" | "validator";

/** Motifs de pause. Le watchdog reprend les jobs dont le motif contient "credits". */
export const PAUSE_REASON = {
  fullenrichCredits: "fullenrich_credits_exhausted",
  apifyCredits: "apify_credits_exhausted",
} as const;

export interface ProviderCreditState {
  state: "ok" | "exhausted";
  last_balance: number | null;
  last_error: string | null;
  exhausted_at: string | null;
  restored_at: string | null;
  last_checked_at: string;
}

/**
 * Lit l'etat de credit d'un provider. Absence de row = jamais tombe en panne
 * = 'ok' : on ne bloque jamais le pipeline sur une donnee manquante.
 */
export async function getCreditState(
  supabase: SupabaseClient,
  workspaceId: string,
  category: CreditCategory,
  providerType: string,
): Promise<ProviderCreditState | null> {
  const { data, error } = await supabase
    .from("provider_credit_state")
    .select("state, last_balance, last_error, exhausted_at, restored_at, last_checked_at")
    .eq("workspace_id", workspaceId)
    .eq("category", category)
    .eq("provider_type", providerType)
    .maybeSingle();

  if (error) {
    console.error(`[credit-state] read failed (${category}/${providerType}):`, error.message);
    return null;
  }
  return (data as ProviderCreditState | null) ?? null;
}

/** Raccourci booleen. Toute erreur de lecture => false (on laisse passer). */
export async function isCreditsExhausted(
  supabase: SupabaseClient,
  workspaceId: string,
  category: CreditCategory,
  providerType: string,
): Promise<boolean> {
  const state = await getCreditState(supabase, workspaceId, category, providerType);
  return state?.state === "exhausted";
}

/**
 * Bascule l'etat d'un provider. Retourne `changed` = true uniquement si l'etat
 * a reellement bascule, ce qui permet a l'appelant de n'alerter qu'une fois par
 * transition plutot qu'a chaque tick de watchdog.
 */
export async function setCreditState(
  supabase: SupabaseClient,
  workspaceId: string,
  category: CreditCategory,
  providerType: string,
  state: "ok" | "exhausted",
  opts: { balance?: number | null; error?: string | null } = {},
): Promise<{ changed: boolean; previousState: string | null }> {
  const { data, error } = await supabase.rpc("set_provider_credit_state", {
    p_workspace_id: workspaceId,
    p_category: category,
    p_provider_type: providerType,
    p_state: state,
    p_balance: opts.balance ?? null,
    p_error: opts.error ?? null,
  });

  if (error) {
    console.error(`[credit-state] set failed (${category}/${providerType} -> ${state}):`, error.message);
    return { changed: false, previousState: null };
  }

  const row = Array.isArray(data) ? data[0] : null;
  return {
    changed: Boolean(row?.out_changed),
    previousState: (row?.out_previous_state as string | null) ?? null,
  };
}

export const markCreditsExhausted = (
  supabase: SupabaseClient,
  workspaceId: string,
  category: CreditCategory,
  providerType: string,
  opts: { balance?: number | null; error?: string | null } = {},
) => setCreditState(supabase, workspaceId, category, providerType, "exhausted", opts);

export const markCreditsRestored = (
  supabase: SupabaseClient,
  workspaceId: string,
  category: CreditCategory,
  providerType: string,
  opts: { balance?: number | null } = {},
) => setCreditState(supabase, workspaceId, category, providerType, "ok", opts);

/**
 * Met un job d'enrichissement en pause. `requeueItemId` = l'item que le worker
 * appelant tenait quand il a pris le 402 : il repasse 'pending' pour etre
 * re-traite tel quel a la reprise, sans compter la tentative avortee.
 */
export async function pauseEnrichmentJob(
  supabase: SupabaseClient,
  jobId: string,
  reason: string,
  requeueItemId?: string | null,
): Promise<{ paused: boolean; requeued: number; pending: number }> {
  const { data, error } = await supabase.rpc("pause_enrichment_job", {
    p_job_id: jobId,
    p_reason: reason,
    p_requeue_item_id: requeueItemId ?? null,
  });

  if (error) {
    console.error(`[credit-state] pause_enrichment_job(${jobId}) failed:`, error.message);
    return { paused: false, requeued: 0, pending: 0 };
  }

  const row = Array.isArray(data) ? data[0] : null;
  return {
    paused: Boolean(row?.out_paused),
    requeued: (row?.out_requeued as number | undefined) ?? 0,
    pending: (row?.out_pending as number | undefined) ?? 0,
  };
}

// ─── Decision pause / reprise (logique pure, testee) ─────────────────────────

/**
 * Traduit un solde en verdict, avec hysteresis.
 *
 * On met en pause sous `minBalance`, mais on ne reprend qu'au-dessus de
 * `minBalance + resumeMargin`. Sans cette marge, un compte qui stagne pile au
 * seuil ferait pause / reprise / pause a chaque tick de watchdog, en brulant
 * un appel provider a chaque aller-retour.
 *
 * @returns true = a sec, false = OK, null = indetermine (garder l'etat courant)
 */
export function verdictFromBalance(
  balance: number | null,
  minBalance: number,
  currentlyExhausted: boolean,
  resumeMargin: number,
): boolean | null {
  if (balance === null) return null;
  if (balance < minBalance) return true;
  if (currentlyExhausted) return balance >= minBalance + resumeMargin ? false : null;
  return false;
}

/**
 * Filet pour les providers dont on ne sait pas lire le solde (Apify sur
 * certains plans) : au bout de `retryAfterMinutes` a sec, on retente
 * optimistement. Si les credits ne sont toujours pas la, le prochain 402
 * remettra la source en pause — on perd un appel, pas une journee de pipeline.
 */
export function shouldBlindRetry(
  exhaustedAt: string | null,
  retryAfterMinutes: number,
  now: number = Date.now(),
): boolean {
  if (!exhaustedAt) return false;
  const startedAt = new Date(exhaustedAt).getTime();
  if (Number.isNaN(startedAt)) return false;
  return (now - startedAt) / 60_000 >= retryAfterMinutes;
}
