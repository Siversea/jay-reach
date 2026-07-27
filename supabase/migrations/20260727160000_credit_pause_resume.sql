-- =============================================================================
-- Pause / reprise automatique sur epuisement des credits provider
-- =============================================================================
-- Avant : quand FullEnrich renvoyait 402 (solde insuffisant), enrich-company
-- appelait kill_enrichment_job -> tous les items restants passaient 'failed'
-- avec l'erreur "fullenrich_credits_exhausted". L'operateur devait
-- re-selectionner a la main les entreprises non traitees une fois le compte
-- recharge, et le scraping Apify continuait a bruler des runs en erreur.
--
-- Apres : on met le pipeline EN PAUSE au lieu de le tuer.
--   1. `provider_credit_state` mémorise, par (workspace, categorie, provider),
--      si le fournisseur est a sec. C'est la source de verite lue par
--      enqueue-enrichment / enrich-company / scrape-job-signals.
--   2. Un job d'enrichissement passe en statut 'paused' : ses items restent
--      'pending', rien n'est perdu, aucun worker ne peut les claim.
--   3. Quand les credits reviennent (detecte par l'edge function
--      `credits-watchdog`), on remet le job en 'pending' et on relance
--      `concurrency` workers : le job reprend exactement ou il s'etait arrete.
--
-- Cf edge functions : credits-watchdog, enrich-company, enqueue-enrichment,
--                     scrape-job-signals
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Etat de credit par provider
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.provider_credit_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- Meme vocabulaire que workspace_providers : 'enricher', 'source', 'validator'...
  category text NOT NULL,
  provider_type text NOT NULL,
  state text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'exhausted')),
  -- Dernier solde connu (credits FullEnrich, USD restants Apify...). NULL si
  -- le provider n'expose pas de solde lisible : on ne se fie alors qu'aux 402.
  last_balance numeric,
  last_error text,
  exhausted_at timestamptz,
  restored_at timestamptz,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, category, provider_type)
);

CREATE INDEX IF NOT EXISTS provider_credit_state_exhausted_idx
  ON public.provider_credit_state (state) WHERE state = 'exhausted';

COMMENT ON TABLE public.provider_credit_state IS
  'Etat de credit par provider. state=exhausted met en pause enrichissement + scraping jusqu''au retour des credits.';

ALTER TABLE public.provider_credit_state ENABLE ROW LEVEL SECURITY;

-- Lecture par les membres du workspace (l'UI affiche le bandeau "en pause").
-- Aucune policy write : seules les edge functions en service_role ecrivent.
DROP POLICY IF EXISTS "members read" ON public.provider_credit_state;
CREATE POLICY "members read" ON public.provider_credit_state FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT public.user_workspaces('viewer')));

-- -----------------------------------------------------------------------------
-- 2. Statut 'paused' sur les jobs d'enrichissement
-- -----------------------------------------------------------------------------
ALTER TABLE public.prospect_enrichment_jobs
  DROP CONSTRAINT IF EXISTS prospect_enrichment_jobs_status_check;
ALTER TABLE public.prospect_enrichment_jobs
  ADD CONSTRAINT prospect_enrichment_jobs_status_check
  CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed'));

ALTER TABLE public.prospect_enrichment_jobs
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS pause_reason text,
  ADD COLUMN IF NOT EXISTS resumed_at timestamptz;

-- L'index partiel des jobs "vivants" doit inclure les jobs en pause : c'est
-- justement eux que le watchdog cherche pour les relancer.
DROP INDEX IF EXISTS prospect_enrichment_jobs_status_idx;
CREATE INDEX prospect_enrichment_jobs_status_idx
  ON public.prospect_enrichment_jobs (status)
  WHERE status IN ('pending', 'running', 'paused');

COMMENT ON COLUMN public.prospect_enrichment_jobs.pause_reason IS
  'Motif de mise en pause, ex. fullenrich_credits_exhausted. Sert au watchdog pour savoir quels jobs relancer quand les credits reviennent.';

-- -----------------------------------------------------------------------------
-- 3. Le scraping peut logger un run saute pour cause de credits
-- -----------------------------------------------------------------------------
ALTER TABLE public.prospect_scraping_logs
  DROP CONSTRAINT IF EXISTS prospect_scraping_logs_status_check;
ALTER TABLE public.prospect_scraping_logs
  ADD CONSTRAINT prospect_scraping_logs_status_check
  CHECK (status IN ('success', 'rate_limited', 'blocked', 'error', 'timeout', 'paused'));

-- -----------------------------------------------------------------------------
-- 4. RPC : marquer un provider a sec / recharge
-- -----------------------------------------------------------------------------
-- Retourne `out_changed` = true seulement si l'etat a reellement bascule, ce
-- qui permet aux appelants de n'envoyer l'email d'alerte qu'une fois par
-- transition (et pas a chaque tick de cron).
CREATE OR REPLACE FUNCTION public.set_provider_credit_state(
  p_workspace_id uuid,
  p_category text,
  p_provider_type text,
  p_state text,
  p_balance numeric DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS TABLE (out_changed boolean, out_previous_state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_previous text;
BEGIN
  IF p_state NOT IN ('ok', 'exhausted') THEN
    RAISE EXCEPTION 'set_provider_credit_state: state invalide "%"', p_state;
  END IF;

  SELECT state INTO v_previous
  FROM provider_credit_state
  WHERE workspace_id = p_workspace_id
    AND category = p_category
    AND provider_type = p_provider_type;

  INSERT INTO provider_credit_state AS pcs (
    workspace_id, category, provider_type, state, last_balance, last_error,
    exhausted_at, restored_at, last_checked_at, updated_at
  )
  VALUES (
    p_workspace_id, p_category, p_provider_type, p_state, p_balance, p_error,
    CASE WHEN p_state = 'exhausted' THEN now() END,
    CASE WHEN p_state = 'ok' THEN now() END,
    now(), now()
  )
  ON CONFLICT (workspace_id, category, provider_type) DO UPDATE
  SET state = EXCLUDED.state,
      -- On garde le dernier solde connu si l'appelant n'a pas su le lire.
      last_balance = COALESCE(EXCLUDED.last_balance, pcs.last_balance),
      last_error = CASE WHEN EXCLUDED.state = 'ok' THEN NULL ELSE COALESCE(EXCLUDED.last_error, pcs.last_error) END,
      -- exhausted_at ne bouge pas tant qu'on reste a sec : c'est le debut de
      -- la panne, pas le dernier check.
      exhausted_at = CASE
        WHEN EXCLUDED.state = 'exhausted' AND pcs.state <> 'exhausted' THEN now()
        ELSE pcs.exhausted_at
      END,
      restored_at = CASE
        WHEN EXCLUDED.state = 'ok' AND pcs.state <> 'ok' THEN now()
        ELSE pcs.restored_at
      END,
      last_checked_at = now(),
      updated_at = now();

  RETURN QUERY SELECT (v_previous IS DISTINCT FROM p_state), v_previous;
END;
$$;

REVOKE ALL ON FUNCTION public.set_provider_credit_state(uuid, text, text, text, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_provider_credit_state(uuid, text, text, text, numeric, text) TO service_role;

-- -----------------------------------------------------------------------------
-- 5. RPC : mettre un job en pause (sans rien perdre)
-- -----------------------------------------------------------------------------
-- `p_requeue_item_id` = l'item que le worker appelant tenait quand il a pris
-- le 402. On le repasse 'pending' et on annule sa tentative : il sera
-- re-traite tel quel a la reprise. Les AUTRES items 'processing' sont laisses
-- tranquilles — leurs workers sont deja en vol et vont finir normalement,
-- les requeuer ferait re-payer leur enrichissement a la reprise.
CREATE OR REPLACE FUNCTION public.pause_enrichment_job(
  p_job_id uuid,
  p_reason text,
  p_requeue_item_id uuid DEFAULT NULL
)
RETURNS TABLE (out_paused boolean, out_requeued int, out_pending int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_paused_rows int := 0;
  v_requeued int := 0;
  v_pending int := 0;
BEGIN
  UPDATE prospect_enrichment_jobs
  SET status = 'paused',
      paused_at = now(),
      pause_reason = p_reason,
      updated_at = now()
  WHERE id = p_job_id AND status IN ('pending', 'running');
  GET DIAGNOSTICS v_paused_rows = ROW_COUNT;

  IF p_requeue_item_id IS NOT NULL THEN
    UPDATE prospect_enrichment_job_items
    SET status = 'pending',
        claimed_at = NULL,
        -- La tentative avortee sur credits epuises ne compte pas : ce n'est
        -- pas un echec de l'item.
        attempts = GREATEST(attempts - 1, 0)
    WHERE id = p_requeue_item_id AND job_id = p_job_id AND status = 'processing';
    GET DIAGNOSTICS v_requeued = ROW_COUNT;
  END IF;

  SELECT COUNT(*) INTO v_pending
  FROM prospect_enrichment_job_items
  WHERE job_id = p_job_id AND status IN ('pending', 'processing');

  RETURN QUERY SELECT (v_paused_rows > 0), v_requeued, v_pending;
END;
$$;

REVOKE ALL ON FUNCTION public.pause_enrichment_job(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pause_enrichment_job(uuid, text, uuid) TO service_role;

-- Met en pause tous les jobs vivants d'un workspace (appele par le watchdog
-- quand il constate un solde a zero, avant meme qu'un 402 ne tombe).
CREATE OR REPLACE FUNCTION public.pause_enrichment_jobs_for_workspace(
  p_workspace_id uuid,
  p_reason text
)
RETURNS TABLE (out_jobs int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_jobs int;
BEGIN
  UPDATE prospect_enrichment_jobs
  SET status = 'paused',
      paused_at = now(),
      pause_reason = p_reason,
      updated_at = now()
  WHERE workspace_id = p_workspace_id AND status IN ('pending', 'running');
  GET DIAGNOSTICS v_jobs = ROW_COUNT;

  RETURN QUERY SELECT v_jobs;
END;
$$;

REVOKE ALL ON FUNCTION public.pause_enrichment_jobs_for_workspace(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pause_enrichment_jobs_for_workspace(uuid, text) TO service_role;

-- -----------------------------------------------------------------------------
-- 6. RPC : reprendre un job en pause
-- -----------------------------------------------------------------------------
-- Repasse le job en 'pending' et relance min(concurrency, items restants)
-- workers. Recupere au passage les items bloques en 'processing' depuis plus
-- de `p_stale_minutes` : ce sont des workers tues en vol (timeout edge, deploy)
-- dont personne n'appellera jamais complete_enrichment_item.
CREATE OR REPLACE FUNCTION public.resume_enrichment_job(
  p_job_id uuid,
  p_functions_url text,
  p_service_role_key text,
  p_stale_minutes int DEFAULT 10
)
RETURNS TABLE (out_resumed boolean, out_reclaimed int, out_spawned int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_concurrency int;
  v_pending int;
  v_processing int;
  v_reclaimed int := 0;
  v_spawned int := 0;
BEGIN
  SELECT concurrency INTO v_concurrency
  FROM prospect_enrichment_jobs
  WHERE id = p_job_id AND status = 'paused'
  FOR UPDATE;

  IF v_concurrency IS NULL THEN
    -- Job absent, deja repris ou termine : rien a faire (idempotent).
    RETURN QUERY SELECT false, 0, 0;
    RETURN;
  END IF;

  UPDATE prospect_enrichment_job_items
  SET status = 'pending',
      claimed_at = NULL,
      attempts = GREATEST(attempts - 1, 0)
  WHERE job_id = p_job_id
    AND status = 'processing'
    AND claimed_at < now() - make_interval(mins => p_stale_minutes);
  GET DIAGNOSTICS v_reclaimed = ROW_COUNT;

  SELECT
    COUNT(*) FILTER (WHERE status = 'pending'),
    COUNT(*) FILTER (WHERE status = 'processing')
  INTO v_pending, v_processing
  FROM prospect_enrichment_job_items
  WHERE job_id = p_job_id;

  IF v_pending = 0 THEN
    IF v_processing = 0 THEN
      -- Plus rien a enrichir : le job avait ete mis en pause sur son dernier
      -- item. On le cloture proprement plutot que de le laisser en 'pending'
      -- sans worker pour le finir.
      UPDATE prospect_enrichment_jobs
      SET status = 'completed',
          completed_at = now(),
          resumed_at = now(),
          pause_reason = NULL,
          paused_at = NULL,
          updated_at = now()
      WHERE id = p_job_id;
    ELSE
      -- Rien a claim mais des workers encore en vol (pause prise pendant qu'ils
      -- travaillaient) : on repasse 'running' sans spawn. C'est leur appel a
      -- complete_enrichment_item qui cloturera le job.
      UPDATE prospect_enrichment_jobs
      SET status = 'running',
          resumed_at = now(),
          pause_reason = NULL,
          paused_at = NULL,
          updated_at = now()
      WHERE id = p_job_id;
    END IF;
    RETURN QUERY SELECT true, v_reclaimed, 0;
    RETURN;
  END IF;

  UPDATE prospect_enrichment_jobs
  SET status = 'pending',
      resumed_at = now(),
      pause_reason = NULL,
      paused_at = NULL,
      updated_at = now()
  WHERE id = p_job_id;

  -- Le job est en 'pending' AVANT les spawns : spawn_enrichment_worker refuse
  -- les jobs qui ne sont pas vivants.
  FOR i IN 1..LEAST(v_concurrency, v_pending) LOOP
    PERFORM public.spawn_enrichment_worker(p_functions_url, p_service_role_key, p_job_id);
    v_spawned := v_spawned + 1;
  END LOOP;

  RETURN QUERY SELECT true, v_reclaimed, v_spawned;
END;
$$;

REVOKE ALL ON FUNCTION public.resume_enrichment_job(uuid, text, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resume_enrichment_job(uuid, text, text, int) TO service_role;

-- Reprend tous les jobs mis en pause pour un motif donne (par defaut : tous
-- les motifs "credits"). p_workspace_id NULL = tous les workspaces.
CREATE OR REPLACE FUNCTION public.resume_paused_enrichment_jobs(
  p_functions_url text,
  p_service_role_key text,
  p_workspace_id uuid DEFAULT NULL,
  p_reason_like text DEFAULT '%credits%'
)
RETURNS TABLE (out_job_id uuid, out_reclaimed int, out_spawned int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_job record;
  v_res record;
BEGIN
  FOR v_job IN
    SELECT id
    FROM prospect_enrichment_jobs
    WHERE status = 'paused'
      AND (p_workspace_id IS NULL OR workspace_id = p_workspace_id)
      AND COALESCE(pause_reason, '') LIKE p_reason_like
    ORDER BY created_at
  LOOP
    SELECT * INTO v_res
    FROM public.resume_enrichment_job(v_job.id, p_functions_url, p_service_role_key);

    out_job_id := v_job.id;
    out_reclaimed := v_res.out_reclaimed;
    out_spawned := v_res.out_spawned;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.resume_paused_enrichment_jobs(text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resume_paused_enrichment_jobs(text, text, uuid, text) TO service_role;

-- -----------------------------------------------------------------------------
-- 7. Les workers ne doivent plus toucher a un job en pause
-- -----------------------------------------------------------------------------
-- claim_next_enrichment_item : un worker en vol au moment de la pause (ou
-- re-spawn en retard par pg_net) ne doit pas piocher dans un job 'paused'.
-- On verrouille donc le claim sur le statut du job parent.
CREATE OR REPLACE FUNCTION public.claim_next_enrichment_item(p_job_id uuid)
RETURNS TABLE (out_item_id uuid, out_signal_id uuid, out_attempts int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_item_id uuid;
  v_signal_id uuid;
  v_attempts int;
  v_job_status text;
BEGIN
  SELECT status INTO v_job_status
  FROM prospect_enrichment_jobs
  WHERE id = p_job_id;

  -- Job en pause / termine / inconnu : le worker sort sans rien claim.
  -- Lecture sans lock volontairement : verrouiller le job serialiserait tous
  -- les claims concurrents. La fenetre de course (pause pile entre ce SELECT
  -- et l'UPDATE) laisse au pire passer un item de plus ; son worker terminera
  -- normalement puis son re-spawn sera refuse par spawn_enrichment_worker.
  IF v_job_status IS NULL OR v_job_status NOT IN ('pending', 'running') THEN
    RETURN;
  END IF;

  WITH next_item AS (
    SELECT id
    FROM prospect_enrichment_job_items
    WHERE job_id = p_job_id AND status = 'pending'
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE prospect_enrichment_job_items AS item
  SET
    status = 'processing',
    claimed_at = now(),
    attempts = item.attempts + 1
  FROM next_item
  WHERE item.id = next_item.id
  RETURNING item.id, item.signal_id, item.attempts
  INTO v_item_id, v_signal_id, v_attempts;

  IF v_item_id IS NOT NULL THEN
    UPDATE prospect_enrichment_jobs
    SET status = 'running', updated_at = now()
    WHERE id = p_job_id AND status = 'pending';

    RETURN QUERY SELECT v_item_id, v_signal_id, v_attempts;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_enrichment_item(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_enrichment_item(uuid) TO service_role;

-- spawn_enrichment_worker : garde-fou global. Tous les chemins de spawn
-- (enqueue-enrichment, chainage worker, resume) passent par ici, donc un seul
-- check suffit pour garantir qu'aucun worker n'est lance sur un job en pause.
CREATE OR REPLACE FUNCTION public.spawn_enrichment_worker(
  p_functions_url text,
  p_service_role_key text,
  p_job_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'extensions', 'net'
AS $$
DECLARE
  v_status text;
  v_request_id bigint;
BEGIN
  SELECT status INTO v_status FROM prospect_enrichment_jobs WHERE id = p_job_id;
  IF v_status IS NULL OR v_status NOT IN ('pending', 'running') THEN
    RAISE NOTICE 'spawn_enrichment_worker: job % en statut % — aucun worker lance', p_job_id, v_status;
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url := p_functions_url || '/enrich-company',
    body := jsonb_build_object('job_id', p_job_id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || p_service_role_key
    ),
    timeout_milliseconds := 2000
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.spawn_enrichment_worker(text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.spawn_enrichment_worker(text, text, uuid) TO service_role;

-- -----------------------------------------------------------------------------
-- 8. Wrapper pg_cron pour le watchdog
-- -----------------------------------------------------------------------------
-- Pas de cron.schedule ici : l'URL du projet varie d'une installation a
-- l'autre (cf 20260616220000_remove_jay_prod_url). L'operateur planifie
-- lui-meme, en passant son URL de functions :
--
--   SELECT cron.schedule(
--     'credits-watchdog',
--     '*/10 * * * *',
--     $$SELECT public.call_credits_watchdog('https://<ref>.supabase.co/functions/v1')$$
--   );
--
-- Sans cron, la reprise reste declenchable depuis l'UI (bouton "Reprendre"
-- sur la modale d'enrichissement, qui appelle la meme edge function).
CREATE OR REPLACE FUNCTION public.call_credits_watchdog(p_functions_url text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'extensions', 'net'
AS $$
DECLARE
  v_cron_secret text;
  v_request_id bigint;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_cron_secret
    FROM vault.decrypted_secrets
    WHERE name = 'CRON_SECRET'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_cron_secret := NULL;
  END;

  IF v_cron_secret IS NULL OR v_cron_secret = '' THEN
    RAISE WARNING 'CRON_SECRET absent du Vault — credits-watchdog non appele.';
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url := p_functions_url || '/credits-watchdog',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_cron_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

COMMENT ON FUNCTION public.call_credits_watchdog(text) IS
  'Wrapper pg_net vers credits-watchdog. A planifier via pg_cron toutes les 10 min avec l''URL des functions du projet.';

REVOKE ALL ON FUNCTION public.call_credits_watchdog(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.call_credits_watchdog(text) TO service_role;
