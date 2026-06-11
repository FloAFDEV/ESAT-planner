-- ============================================================
-- MIGRATION N : archivage des OFs terminés + purge en masse
--
-- 1. delete_archived_production_order (remplace delete_canceled_production_order)
--    → accepte done ET canceled. Stock physique NON modifié.
--
-- 2. delete_production_orders_period
--    → purge en masse par statuts + date limite.
--    → Stock, mouvements, coffrets.stock_fini NON touchés.
--    → Seuls supprimés : stock_reservations, production_consumption, production_orders.
-- ============================================================


-- ── 1. Suppression individuelle (done ou canceled) ────────────────────────

DROP FUNCTION IF EXISTS public.delete_archived_production_order(uuid);

CREATE OR REPLACE FUNCTION public.delete_archived_production_order(
  p_order_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.production_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order
  FROM   public.production_orders
  WHERE  id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'OF introuvable');
  END IF;

  IF v_order.status::text NOT IN ('done', 'termine', 'canceled', 'annule') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   'Seuls les OFs terminés ou annulés peuvent être supprimés (statut actuel : ' || v_order.status::text || ')'
    );
  END IF;

  -- Supprimer les enregistrements enfants explicitement
  -- (on ne suppose pas ON DELETE CASCADE sur les FK de production)
  -- mouvements.production_order_id → sans FK, historique conservé
  -- coffrets.stock_fini, composants.stock → NON modifiés (production physique conservée)
  DELETE FROM public.stock_reservations     WHERE production_order_id = p_order_id;
  DELETE FROM public.production_consumption WHERE production_order_id = p_order_id;
  DELETE FROM public.production_orders      WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success',   true,
    'order_id',  p_order_id,
    'reference', v_order.reference
  );
END;
$$;


-- ── 2. Purge en masse par statuts + période ───────────────────────────────

DROP FUNCTION IF EXISTS public.delete_production_orders_period(text[], timestamptz);

CREATE OR REPLACE FUNCTION public.delete_production_orders_period(
  p_statuses text[],          -- ex: ARRAY['done','canceled']
  p_before   timestamptz      -- NULL = aucune limite de date (tout)
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids   uuid[];
  v_count integer := 0;
BEGIN
  IF p_statuses IS NULL OR array_length(p_statuses, 1) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Au moins un statut requis');
  END IF;

  SELECT array_agg(id)
  INTO   v_ids
  FROM   public.production_orders
  WHERE  status::text = ANY(p_statuses)
    AND  (p_before IS NULL OR created_at < p_before);

  IF v_ids IS NULL OR array_length(v_ids, 1) = 0 THEN
    RETURN jsonb_build_object('success', true, 'deleted_count', 0);
  END IF;

  v_count := array_length(v_ids, 1);

  DELETE FROM public.stock_reservations     WHERE production_order_id = ANY(v_ids);
  DELETE FROM public.production_consumption WHERE production_order_id = ANY(v_ids);
  DELETE FROM public.production_orders      WHERE id = ANY(v_ids);

  RETURN jsonb_build_object('success', true, 'deleted_count', v_count);
END;
$$;
