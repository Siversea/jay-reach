import { supabase } from '@/lib/supabase';

/**
 * Push groupe vers Smartlead.
 *
 * Avant : une invocation de send-via-smartlead par prospect (N cold starts,
 * N appels a l'API Smartlead). Maintenant : une invocation par tranche, et le
 * backend regroupe les leads d'une meme campagne en un seul appel Smartlead.
 *
 * Les erreurs sont remontees (dedupliquees) au lieu d'etre juste comptees :
 * une campagne non reliee a un persona est actionnable, un compteur ne l'est pas.
 */

export interface SmartleadPushSummary {
  /** Leads effectivement pousses. */
  ok: number;
  /** Leads bloques par l'email gate (non pousses, ce n'est pas une erreur). */
  skipped: number;
  failed: number;
  total: number;
  /** Messages d'erreur distincts, le plus utile en premier. */
  errors: string[];
}

/** Taille de tranche : borne le wall-clock d'une invocation edge (plafond backend : 200). */
const CHUNK_SIZE = 100;

interface BatchResponse {
  ok?: boolean;
  pushed?: number;
  gate_refused?: number;
  failed?: number;
  errors?: string[];
  error?: string;
}

function addError(summary: SmartleadPushSummary, message: string | undefined) {
  if (!message || summary.errors.includes(message)) return;
  summary.errors.push(message);
}

export async function pushProspectsToSmartlead(prospectIds: string[]): Promise<SmartleadPushSummary> {
  const summary: SmartleadPushSummary = { ok: 0, skipped: 0, failed: 0, total: prospectIds.length, errors: [] };
  if (prospectIds.length === 0) return summary;

  const { data: session } = await supabase.auth.getSession();
  const accessToken = session?.session?.access_token;
  if (!accessToken) throw new Error('Auth manquante : reconnecte-toi');

  for (let i = 0; i < prospectIds.length; i += CHUNK_SIZE) {
    const chunk = prospectIds.slice(i, i + CHUNK_SIZE);
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-via-smartlead`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospect_ids: chunk, channel: 'email', manual_override: true }),
      });

      const payload = (await res.json().catch(() => null)) as BatchResponse | null;

      if (!res.ok || !payload?.ok) {
        // Echec global de la tranche (auth, validation, crash) : tout le lot compte en erreur.
        summary.failed += chunk.length;
        addError(summary, payload?.error ?? `Erreur ${res.status}`);
        continue;
      }

      summary.ok += payload.pushed ?? 0;
      summary.skipped += payload.gate_refused ?? 0;
      summary.failed += payload.failed ?? 0;
      for (const message of payload.errors ?? []) addError(summary, message);
    } catch (err) {
      summary.failed += chunk.length;
      addError(summary, err instanceof Error ? err.message : 'Erreur réseau');
    }
  }

  return summary;
}
