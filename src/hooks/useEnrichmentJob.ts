import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { checkCreditsAndResume } from '@/lib/credits-watchdog';
import {
  clearPersistedJobId,
  getPersistedJobId,
  persistJobId,
} from '@/lib/prospect-enrichment-job';

/**
 * Etat d'un job d'enrichissement backend. Les champs correspondent aux
 * colonnes de la table prospect_enrichment_jobs.
 */
export interface EnrichmentJobState {
  id: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  total: number;
  completed: number;
  failed: number;
  concurrency: number;
  created_at: string;
  completed_at: string | null;
  /** Renseigne quand status='paused' : ex. fullenrich_credits_exhausted. */
  pause_reason: string | null;
  paused_at: string | null;
}

export interface UseEnrichmentJobReturn {
  job: EnrichmentJobState | null;
  /** True tant que le job n'est pas en etat terminal (pause comprise). */
  running: boolean;
  /** True quand le job attend le retour des credits provider. */
  paused: boolean;
  /** Demarre le suivi d'un nouveau job (remplace celui en cours). */
  trackJob: (jobId: string) => void;
  /** Efface le job courant (ne supprime pas les rows en DB, juste l'affichage). */
  clear: () => void;
}

/**
 * Poll l'etat d'un job d'enrichissement backend toutes les 2s tant qu'il
 * tourne. Charge automatiquement le dernier job connu depuis localStorage
 * au mount, ce qui permet de re-afficher le progress apres un reload.
 *
 * Un job en pause (credits provider epuises) reste suivi : on ralentit le
 * polling et on redemande au backend de verifier le solde toutes les
 * CREDIT_RECHECK_MS. Le job repart donc tout seul des que le compte est
 * recharge, meme sans pg_cron configure — a condition qu'un onglet reste
 * ouvert. Avec le cron `call_credits_watchdog`, la reprise a lieu de toute
 * facon cote serveur.
 */
const POLL_ACTIVE_MS = 2000;
const POLL_PAUSED_MS = 15_000;
const CREDIT_RECHECK_MS = 90_000;

export function useEnrichmentJob(): UseEnrichmentJobReturn {
  const [jobId, setJobId] = useState<string | null>(() => getPersistedJobId());
  const [job, setJob] = useState<EnrichmentJobState | null>(null);
  // Ref pour eviter un setState apres unmount (React StrictMode + async effect)
  const cancelledRef = useRef(false);
  const lastRecheckRef = useRef(0);

  useEffect(() => {
    cancelledRef.current = false;
    if (!jobId) {
      setJob(null);
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const pollOnce = async (): Promise<number | null> => {
      const { data, error } = await supabase
        .from('prospect_enrichment_jobs')
        .select('id, status, total, completed, failed, concurrency, created_at, completed_at, pause_reason, paused_at')
        .eq('id', jobId)
        .maybeSingle();

      if (cancelledRef.current) return null;
      if (error || !data) {
        // Job supprime ou RLS bloque → on arrete et on oublie
        setJob(null);
        return null;
      }

      setJob(data);

      // Etat terminal → stop
      if (data.status === 'completed' || data.status === 'failed') return null;

      if (data.status === 'paused') {
        // Ping le watchdog au plus une fois par CREDIT_RECHECK_MS : c'est lui
        // qui relit le solde provider et relance le job si les credits sont
        // revenus. Un echec (pas admin, function absente) est sans
        // consequence, on retentera au tick suivant.
        if (Date.now() - lastRecheckRef.current >= CREDIT_RECHECK_MS) {
          lastRecheckRef.current = Date.now();
          void checkCreditsAndResume().catch(() => { /* silencieux : simple tentative */ });
        }
        return POLL_PAUSED_MS;
      }

      return POLL_ACTIVE_MS;
    };

    const loop = async () => {
      const nextDelay = await pollOnce();
      if (!cancelledRef.current && nextDelay !== null) {
        timeoutId = setTimeout(loop, nextDelay);
      }
    };
    loop();

    return () => {
      cancelledRef.current = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [jobId]);

  const trackJob = useCallback((id: string) => {
    persistJobId(id);
    setJobId(id);
  }, []);

  const clear = useCallback(() => {
    clearPersistedJobId();
    setJobId(null);
    setJob(null);
  }, []);

  const paused = job?.status === 'paused';
  // 'paused' compte comme "en cours" : le job n'est pas fini, il attend juste
  // le retour des credits. Le sortir de `running` ferait afficher un toast
  // "enrichissement termine" alors qu'il reste des entreprises a traiter.
  const running = !!job && (job.status === 'pending' || job.status === 'running' || job.status === 'paused');

  return { job, running, paused, trackJob, clear };
}
