import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CheckCircle2, XCircle, Loader2, Clock, Sparkles, Minimize2, PauseCircle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ProgressBar, StatTile } from '@/components/prospection/_shared/progress-ui';
import { useToast } from '@/hooks/use-toast';
import { checkCreditsAndResume, countResumedJobs } from '@/lib/credits-watchdog';
import { logger } from '@/lib/logger';
import type { EnrichmentJobState } from '@/hooks/useEnrichmentJob';
import type { EnrichmentJobItem } from '@/hooks/useEnrichmentJobItems';

/**
 * Modale de suivi live d'un enrichissement batch.
 *
 * - progress overall + stats (termines / echecs / en cours)
 * - liste scrollable des entreprises avec statut par ligne, trie :
 *   processing en haut, puis pending, puis completed (recents d'abord), puis failed
 * - bandeau dedie quand le job est en pause faute de credits provider, avec
 *   verification manuelle du solde (le backend re-verifie deja tout seul)
 * - fermable (la queue backend continue en arriere-plan, c'est explicite en footer)
 */
export function EnrichmentJobModal({
  open,
  onClose,
  job,
  items,
}: {
  open: boolean;
  onClose: () => void;
  job: EnrichmentJobState | null;
  items: EnrichmentJobItem[];
}) {
  const sortedItems = useMemo(() => sortItems(items), [items]);

  if (!job) return null;

  const done = job.completed + job.failed;
  const processing = items.filter(i => i.status === 'processing').length;
  const pending = items.filter(i => i.status === 'pending').length;
  const isFinal = job.status === 'completed' || job.status === 'failed';
  const isPaused = job.status === 'paused';

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl p-0 gap-0">
        {/* Header */}
        <DialogHeader className="p-6 pb-4 border-b border-border">
          <DialogTitle className="flex items-center gap-2 text-foreground">
            {isPaused
              ? <PauseCircle className="h-5 w-5 text-amber-500" />
              : <Sparkles className="h-5 w-5 text-violet-500" />}
            {isFinal
              ? (job.failed > 0 ? 'Enrichissement termine (avec erreurs)' : 'Enrichissement termine')
              : isPaused ? 'Enrichissement en pause' : 'Enrichissement en cours'}
          </DialogTitle>
          <ProgressBar value={done} total={job.total} className="mt-3" />
        </DialogHeader>

        {isPaused && <PausedBanner job={job} remaining={pending + processing} />}

        {/* Stats */}
        <div className="px-6 py-3 border-b border-border bg-muted/30">
          <div className="grid grid-cols-4 gap-3 text-xs">
            <StatTile icon={CheckCircle2} label="Termines" value={job.completed} tone="done" />
            <StatTile icon={Loader2} label="En cours" value={processing} tone="active" spin={processing > 0} />
            <StatTile icon={Clock} label="En attente" value={pending} tone="pending" />
            <StatTile icon={XCircle} label="Echecs" value={job.failed} tone="error" />
          </div>
        </div>

        {/* Items list */}
        <div className="max-h-[400px] overflow-y-auto">
          {sortedItems.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Chargement des entreprises...
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {sortedItems.map(item => (
                <ItemRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-border bg-muted/20 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {isFinal
              ? `Temps total : ${formatDuration(job.created_at, job.completed_at)}`
              : isPaused
                ? 'Reprend automatiquement des que les credits sont recharges.'
                : 'Continue meme si tu fermes cette fenetre.'}
          </p>
          <Button variant="ghost" size="sm" onClick={onClose} className="gap-1.5 h-7">
            <Minimize2 className="h-3.5 w-3.5" />
            {isFinal ? 'Fermer' : 'Reduire'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

/**
 * Bandeau affiche quand le job attend le retour des credits provider.
 *
 * Le message insiste sur le fait que rien n'est perdu : c'etait la principale
 * source d'inquietude avec l'ancien comportement (kill du job = items marques
 * 'failed', selection a refaire a la main).
 */
function PausedBanner({ job, remaining }: { job: EnrichmentJobState; remaining: number }) {
  const { toast } = useToast();
  const [checking, setChecking] = useState(false);

  const provider = providerLabel(job.pause_reason);

  const onCheck = async () => {
    setChecking(true);
    try {
      const res = await checkCreditsAndResume();
      const resumedJobs = countResumedJobs(res);
      if (resumedJobs > 0) {
        toast({ description: 'Credits de retour — l\'enrichissement redemarre.' });
      } else {
        const balances = res.checked
          .filter(c => c.balance !== null)
          .map(c => `${c.provider} : ${c.balance} ${c.unit}`)
          .join(' · ');
        toast({
          description: balances
            ? `Toujours pas assez de credits (${balances}).`
            : 'Toujours pas de credits disponibles.',
        });
      }
    } catch (err) {
      logger.error('[EnrichmentJobModal] checkCreditsAndResume failed', err);
      toast({ variant: 'destructive', description: 'Verification du solde impossible.' });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="px-6 py-4 border-b border-border bg-amber-500/10">
      <div className="flex items-start gap-3">
        <PauseCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" />
        <div className="flex-1 min-w-0 space-y-1">
          <p className="text-sm font-medium text-foreground">
            Credits {provider} epuises — enrichissement en pause
          </p>
          <p className="text-xs text-muted-foreground">
            {remaining} entreprise{remaining > 1 ? 's' : ''} conservee{remaining > 1 ? 's' : ''} en file.
            Le job reprendra exactement ou il s'est arrete des que le compte sera recharge —
            aucune selection a refaire, aucun credit gaspille.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onCheck} disabled={checking} className="gap-1.5 h-7 shrink-0">
          <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
          Verifier le solde
        </Button>
      </div>
    </div>
  );
}

/** "fullenrich_credits_exhausted" -> "FullEnrich". */
function providerLabel(pauseReason: string | null): string {
  if (!pauseReason) return 'provider';
  if (pauseReason.startsWith('fullenrich')) return 'FullEnrich';
  if (pauseReason.startsWith('apify')) return 'Apify';
  return 'provider';
}

function ItemRow({ item }: { item: EnrichmentJobItem }) {
  const name = item.company_name || 'Entreprise inconnue';
  const statusMeta = getStatusMeta(item);
  const duration = item.claimed_at
    ? formatDuration(item.claimed_at, item.completed_at)
    : null;

  return (
    <li className={cn(
      'flex items-center gap-3 px-6 py-3 transition-colors',
      item.status === 'processing' && 'bg-violet-500/5',
    )}>
      <statusMeta.Icon
        className={cn('h-4 w-4 shrink-0', statusMeta.color, statusMeta.spin && 'animate-spin')}
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-foreground truncate font-medium">{name}</div>
        <div className="text-xs text-muted-foreground truncate">
          {statusMeta.label}
          {item.attempts > 1 && <span className="ml-1.5">· tentative {item.attempts}</span>}
          {item.error && item.status === 'failed' && (
            <span className="ml-1.5 text-red-500/80">· {truncate(item.error, 60)}</span>
          )}
        </div>
      </div>
      {duration && (
        <div className="text-xs tabular-nums text-muted-foreground shrink-0">
          {duration}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStatusMeta(item: EnrichmentJobItem): {
  Icon: typeof CheckCircle2;
  color: string;
  spin: boolean;
  label: string;
} {
  switch (item.status) {
    case 'completed':
      return { Icon: CheckCircle2, color: 'text-emerald-500', spin: false, label: 'Termine' };
    case 'failed':
      return { Icon: XCircle, color: 'text-red-500', spin: false, label: 'Echec' };
    case 'processing':
      return { Icon: Loader2, color: 'text-violet-500', spin: true, label: 'Enrichissement en cours...' };
    case 'pending':
    default:
      return { Icon: Clock, color: 'text-muted-foreground/60', spin: false, label: 'En attente' };
  }
}

/**
 * Ordre d'affichage : processing (le plus interessant a regarder), pending,
 * completed (recents d'abord), failed.
 */
function sortItems(items: EnrichmentJobItem[]): EnrichmentJobItem[] {
  const rank = (s: EnrichmentJobItem['status']): number => {
    switch (s) {
      case 'processing': return 0;
      case 'pending': return 1;
      case 'completed': return 2;
      case 'failed': return 3;
    }
  };
  return [...items].sort((a, b) => {
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    // Dans completed/failed : recent d'abord
    if (a.completed_at && b.completed_at) {
      return b.completed_at.localeCompare(a.completed_at);
    }
    return 0;
  });
}

function formatDuration(from: string | null, to: string | null): string {
  if (!from) return '';
  const start = new Date(from).getTime();
  const end = to ? new Date(to).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
