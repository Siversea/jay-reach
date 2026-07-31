import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { EnrichedProfile } from '@/hooks/useEnrichedCompanies';
import { pushProspectsToSmartlead, type SmartleadPushSummary } from './pushProspects';

export type SmartleadPushResult = SmartleadPushSummary;

/**
 * Hook pour push bulk de leads vers Smartlead (Jay Reach 1.5.2).
 *
 * Filtre les profiles avec email + deliverability_status='valid' + pas deja envoyes,
 * puis les pousse en lot via send-via-smartlead (manual_override=true).
 *
 * Retourne :
 * - eligible : profiles a pousser
 * - alreadySent : profiles deja pousses (smartlead_push_decision='push')
 * - totalWithEmail : profiles ayant un email (eligible ou pas)
 * - push() : declenche l'envoi groupe
 * - sending : true pendant l'envoi
 */
export function useSmartleadPush(profiles: EnrichedProfile[]) {
  const queryClient = useQueryClient();
  const [sending, setSending] = useState(false);

  const eligible = useMemo(
    () => profiles.filter(
      (p) => !!p.email && p.deliverability_status === 'valid' && p.smartlead_push_decision !== 'push',
    ),
    [profiles],
  );
  const alreadySent = useMemo(
    () => profiles.filter((p) => p.smartlead_push_decision === 'push').length,
    [profiles],
  );
  const totalWithEmail = useMemo(
    () => profiles.filter((p) => !!p.email).length,
    [profiles],
  );

  const push = async (): Promise<SmartleadPushResult | null> => {
    if (eligible.length === 0) return null;
    setSending(true);
    try {
      const summary = await pushProspectsToSmartlead(eligible.map((p) => p.id));
      queryClient.invalidateQueries({ queryKey: ['enriched-companies'] });
      return summary;
    } finally {
      setSending(false);
    }
  };

  return { eligible, alreadySent, totalWithEmail, push, sending };
}
