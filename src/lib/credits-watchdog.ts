/**
 * Client de l'edge function `credits-watchdog`.
 *
 * Le watchdog relit le solde des providers payants (FullEnrich, Apify) et,
 * si les credits sont revenus, remet en marche ce qui avait ete mis en pause :
 * les jobs d'enrichissement 'paused' repassent 'pending' avec leurs workers,
 * et les sources de scraping cessent d'etre sautees.
 *
 * En production il est appele par pg_cron toutes les 10 min
 * (`call_credits_watchdog`). Cote UI on l'appelle en plus :
 *   - automatiquement, tant qu'un job suivi est en pause (useEnrichmentJob)
 *   - a la demande, via le bouton "Verifier les credits" de la modale
 */

import { invokeEdgeFunction } from './invokeEdgeFunction';

export interface CreditsWatchdogProviderCheck {
  workspace_id: string;
  /** Ex. "enricher/fullenrich". */
  provider: string;
  balance: number | null;
  unit: string;
  exhausted: boolean | null;
  error: string | null;
}

export interface CreditsWatchdogResponse {
  checked: CreditsWatchdogProviderCheck[];
  transitions: Array<{ provider: string; from: string; to: string; balance: number | null; unit: string }>;
  paused_jobs: Array<{ workspace_id: string; jobs: number }>;
  resumed_jobs: Array<{ workspace_id: string; jobs: number; spawned: number }>;
}

/**
 * Force une verification du solde et la reprise de ce qui peut l'etre.
 * Retourne le detail des providers verifies pour pouvoir l'afficher.
 */
export async function checkCreditsAndResume(): Promise<CreditsWatchdogResponse> {
  return invokeEdgeFunction<CreditsWatchdogResponse>('credits-watchdog', {}, { timeoutMs: 60_000 });
}

/** Nombre total de jobs relances par un passage du watchdog. */
export function countResumedJobs(res: CreditsWatchdogResponse): number {
  return res.resumed_jobs.reduce((acc, r) => acc + r.jobs, 0);
}
