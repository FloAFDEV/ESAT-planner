-- ============================================================
-- ARCHITECTURE STOCK v2
--
-- Principe:
--   stock_reservations = source de vérité pour les réservations.
--   composants.reserved_stock = cache maintenu UNIQUEMENT par le
--   trigger tg_sync_reserved_stock. Aucun RPC ne le touche directement.
--
--   Flux OF:
--     CREATE → INSERT stock_reservations (active) → trigger ↑ reserved_stock
--     CANCEL → UPDATE stock_reservations (canceled) → trigger ↓ reserved_stock
--     VALIDATE(qty) → INSERT mouvements OUT + UPDATE/consume reservations
--                   → trigger ↓ reserved_stock + tg_apply_mouvement ↓ stock
--
-- ============================================================

-- ============ 1. create_production_order_atomic ============
-- Crée l'OF + réserve le stock via stock_reservations.
-- Remplace toutes les versions précédentes (public.production_status et text).

DROP FUNCTION IF EXISTS public.create_production_order_atomic(
  uuid, integer, public.production_status, integer, text
);
DROP FUNCTION IF EXISTS public.create_production_order_atomic(
  uuid, integer, public.production_status, integer, text, text
);

CREATE OR REPLACE FUNCTION public.create_production_order_atomic(
  p_coffret_id      uuid,
  p_quantity        integer,
  p_status          text    DEFAULT 'draft',
  p_priority        integer DEFAULT 0,
  p_notes           text    DEFAULT NULL,
  p_idempotency_key text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id  uuid;
  v_reference text;
  v_inserted  integer;
  v_need      record;
  v_available integer;
BEGIN
  -- ── Validation des paramètres ──────────────────────────────────────
  IF p_coffret_id IS NULL THEN
    RAISE EXCEPTION 'p_coffret_id is required';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'p_quantity must be > 0';
  END IF;
  IF p_priority IS NULL OR p_priority NOT IN (0, 1) THEN
    RAISE EXCEPTION 'p_priority must be 0 or 1';
  END IF;
  IF p_status NOT IN ('draft', 'priority') THEN
    RAISE EXCEPTION 'invalid initial status (must be draft or priority)';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'p_idempotency_key is required';
  END IF;

  -- ── Idempotence ────────────────────────────────────────────────────
  INSERT INTO public.production_order_idempotency (idempotency_key, order_id)
  VALUES (p_idempotency_key, NULL)
  ON CONFLICT (idempotency_key) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    SELECT poi.order_id, po.reference
    INTO v_order_id, v_reference
    FROM public.production_order_idempotency poi
    LEFT JOIN public.production_orders po ON po.id = poi.order_id
    WHERE poi.idempotency_key = p_idempotency_key;

    IF v_order_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success',           true,
        'order_id',          v_order_id,
        'reference',         v_reference,
        'idempotent_replay', true
      );
    END IF;
    RAISE EXCEPTION 'idempotency key conflict: %', p_idempotency_key;
  END IF;

  -- ── Vérifications métier ───────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM public.coffrets
    WHERE id = p_coffret_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'coffret not found or archived: %', p_coffret_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.nomenclatures
    WHERE coffret_id = p_coffret_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'no active BOM lines found for coffret %', p_coffret_id;
  END IF;

  -- ── Verrouillage anti-race condition ───────────────────────────────
  PERFORM 1
  FROM public.composants c
  JOIN public.nomenclatures n ON n.composant_id = c.id
  WHERE n.coffret_id = p_coffret_id
    AND n.is_active = true
  ORDER BY c.id  -- ordre déterministe pour éviter les deadlocks
  FOR UPDATE;

  -- ── Vérification stock disponible ─────────────────────────────────
  -- stock_disponible = stock - reserved_stock
  -- reserved_stock est maintenu par trigger depuis stock_reservations
  FOR v_need IN
    SELECT
      n.composant_id,
      (n.quantity * p_quantity)::integer AS qty_needed
    FROM public.nomenclatures n
    WHERE n.coffret_id = p_coffret_id
      AND n.is_active = true
  LOOP
    SELECT GREATEST(0,
      COALESCE(c.stock, 0) - COALESCE(c.reserved_stock, 0)
    )::integer
    INTO v_available
    FROM public.composants c
    WHERE c.id = v_need.composant_id;

    IF COALESCE(v_available, 0) < v_need.qty_needed THEN
      RAISE EXCEPTION
        'insufficient stock for composant % (needed %, available %)',
        v_need.composant_id,
        v_need.qty_needed,
        COALESCE(v_available, 0);
    END IF;
  END LOOP;

  -- ── Création de l'ordre ───────────────────────────────────────────
  INSERT INTO public.production_orders (
    coffret_id, quantity, status, priority, notes
  )
  VALUES (
    p_coffret_id,
    p_quantity,
    p_status::public.production_status,
    p_priority,
    p_notes
  )
  RETURNING id, reference INTO v_order_id, v_reference;

  -- ── Réservation du stock (trigger → reserved_stock) ───────────────
  INSERT INTO public.stock_reservations (
    composant_id, quantity, production_order_id, status
  )
  SELECT
    n.composant_id,
    (n.quantity * p_quantity)::integer,
    v_order_id,
    'active'
  FROM public.nomenclatures n
  WHERE n.coffret_id = p_coffret_id
    AND n.is_active = true;

  -- ── Audit BOM prévisionnel ────────────────────────────────────────
  INSERT INTO public.production_consumption (
    production_order_id, composant_id, quantity
  )
  SELECT
    v_order_id,
    n.composant_id,
    (n.quantity * p_quantity)::integer
  FROM public.nomenclatures n
  WHERE n.coffret_id = p_coffret_id
    AND n.is_active = true
  ON CONFLICT (production_order_id, composant_id) DO NOTHING;

  -- ── Finalisation idempotency ──────────────────────────────────────
  UPDATE public.production_order_idempotency
  SET order_id = v_order_id
  WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object(
    'success',           true,
    'order_id',          v_order_id,
    'reference',         v_reference,
    'coffret_id',        p_coffret_id,
    'quantity',          p_quantity,
    'status',            p_status,
    'priority',          p_priority,
    'idempotent_replay', false
  );
END;
$$;


-- ============ 2. validate_production_order ============
-- Idempotent. Supporte la validation partielle (p_qty < remaining).
-- Insère les mouvements OUT → trigger décrémente composants.stock.
-- Libère les réservations consommées.

-- DROP les deux surcharges pour éviter l'ambiguïté de surcharge
DROP FUNCTION IF EXISTS public.validate_production_order(uuid);
DROP FUNCTION IF EXISTS public.validate_production_order(uuid, integer);

CREATE OR REPLACE FUNCTION public.validate_production_order(
  p_order_id uuid,
  p_qty      integer DEFAULT NULL  -- NULL = valider tout le restant
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order         public.production_orders%ROWTYPE;
  v_validate_qty  integer;
  v_remaining     integer;
  r               record;
  v_final_status  public.production_status;
BEGIN
  SELECT * INTO v_order
  FROM public.production_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order not found');
  END IF;

  -- Idempotence : OF déjà terminé
  IF v_order.status::text = 'done' THEN
    RETURN jsonb_build_object(
      'success', true, 'order_id', p_order_id,
      'status', 'done', 'idempotent_replay', true
    );
  END IF;

  IF v_order.status::text IN ('canceled', 'annule') THEN
    RETURN jsonb_build_object('success', false, 'error', 'order is canceled');
  END IF;

  -- Calculer la quantité restante à produire
  v_remaining := v_order.quantity - v_order.produced_qty;
  IF v_remaining <= 0 THEN
    -- Incohérence : marquer done sans décrémentation supplémentaire
    UPDATE public.production_orders
    SET status = 'done'::public.production_status,
        done_at = COALESCE(done_at, now()),
        updated_at = now()
    WHERE id = p_order_id;
    RETURN jsonb_build_object('success', true, 'order_id', p_order_id, 'status', 'done');
  END IF;

  -- Déterminer la quantité à valider
  v_validate_qty := COALESCE(p_qty, v_remaining);

  IF v_validate_qty <= 0 THEN
    RAISE EXCEPTION 'validate quantity must be > 0';
  END IF;
  IF v_validate_qty > v_remaining THEN
    RAISE EXCEPTION
      'validate quantity (%) exceeds remaining (%) for order %',
      v_validate_qty, v_remaining, p_order_id;
  END IF;

  -- ── Insertion des mouvements OUT ──────────────────────────────────
  -- Le trigger tg_apply_mouvement met à jour composants.stock automatiquement.
  FOR r IN
    SELECT
      n.composant_id,
      (n.quantity * v_validate_qty)::integer AS qty
    FROM public.nomenclatures n
    WHERE n.coffret_id = v_order.coffret_id
      AND n.is_active = true
  LOOP
    INSERT INTO public.mouvements (
      composant_id, type, quantity, reason, production_order_id
    )
    VALUES (
      r.composant_id,
      'OUT',
      r.qty,
      'Production ' || v_order.reference ||
        CASE WHEN v_validate_qty < v_remaining
             THEN ' (partiel ' || (v_order.produced_qty + v_validate_qty)
                  || '/' || v_order.quantity || ')'
             ELSE ''
        END,
      v_order.id
    );
  END LOOP;

  -- ── Libération des réservations ───────────────────────────────────
  -- Lignes entièrement consommées → 'consumed'
  UPDATE public.stock_reservations sr
  SET status = 'consumed', updated_at = now()
  FROM public.nomenclatures n
  WHERE sr.production_order_id = p_order_id
    AND sr.composant_id = n.composant_id
    AND n.coffret_id = v_order.coffret_id
    AND sr.status = 'active'
    AND sr.quantity <= (n.quantity * v_validate_qty);

  -- Lignes partiellement consommées → réduire la quantité réservée
  UPDATE public.stock_reservations sr
  SET quantity = sr.quantity - (n.quantity * v_validate_qty),
      updated_at = now()
  FROM public.nomenclatures n
  WHERE sr.production_order_id = p_order_id
    AND sr.composant_id = n.composant_id
    AND n.coffret_id = v_order.coffret_id
    AND sr.status = 'active'
    AND sr.quantity > (n.quantity * v_validate_qty);

  -- ── Incrémenter stock de produits finis ───────────────────────────
  UPDATE public.coffrets
  SET stock_fini = stock_fini + v_validate_qty
  WHERE id = v_order.coffret_id;

  -- ── Déterminer le statut final ────────────────────────────────────
  v_final_status := CASE
    WHEN v_order.produced_qty + v_validate_qty >= v_order.quantity
      THEN 'done'::public.production_status
    ELSE 'partial'::public.production_status
  END;

  -- ── Mise à jour de l'OF ───────────────────────────────────────────
  UPDATE public.production_orders
  SET
    produced_qty  = produced_qty + v_validate_qty,
    status        = v_final_status,
    done_at       = CASE WHEN v_final_status = 'done' THEN now() ELSE done_at END,
    validated_at  = COALESCE(validated_at, now()),
    updated_at    = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success',       true,
    'order_id',      p_order_id,
    'validated_qty', v_validate_qty,
    'produced_qty',  v_order.produced_qty + v_validate_qty,
    'total_qty',     v_order.quantity,
    'status',        v_final_status::text
  );
END;
$$;


-- ============ 3. cancel_production_order_with_unreserve ============
-- Idempotent. Libère les réservations actives restantes.
-- Utilise le statut canonical 'canceled'.

CREATE OR REPLACE FUNCTION public.cancel_production_order_with_unreserve(
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
  FROM public.production_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order not found');
  END IF;

  -- Idempotent : déjà annulé
  IF v_order.status::text IN ('canceled', 'annule') THEN
    RETURN jsonb_build_object(
      'success', true, 'order_id', p_order_id, 'idempotent_replay', true
    );
  END IF;

  -- Bloquer l'annulation d'un OF terminé
  IF v_order.status::text IN ('done', 'termine') THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'cannot cancel a completed order'
    );
  END IF;

  -- Libérer les réservations actives restantes
  -- (pour un OF partiel, certaines ont déjà été 'consumed')
  UPDATE public.stock_reservations
  SET status = 'canceled', updated_at = now()
  WHERE production_order_id = p_order_id
    AND status = 'active';

  UPDATE public.production_orders
  SET status     = 'canceled'::public.production_status,
      updated_at = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success',  true,
    'order_id', p_order_id,
    'status',   'canceled'
  );
END;
$$;


-- ============ 4. transition_production_order_status ============
-- Machine à états propre.
-- 'priority' = marqueur d'urgence, pas un état terminal.
-- Seul 'done' est terminal.

CREATE OR REPLACE FUNCTION public.transition_production_order_status(
  p_order_id uuid,
  p_status   text,
  p_priority integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order          public.production_orders%ROWTYPE;
  v_canonical      public.production_status;
  v_allowed_from   text[];
BEGIN
  SELECT * INTO v_order
  FROM public.production_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order not found');
  END IF;

  -- Valider le statut cible
  IF p_status NOT IN ('draft', 'priority', 'in_progress', 'partial', 'done') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'invalid status (allowed: draft, priority, in_progress, partial, done)'
    );
  END IF;

  -- États terminaux : aucune transition possible depuis done/canceled/annule
  IF v_order.status::text IN ('done', 'termine', 'canceled', 'annule') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'cannot transition from terminal status ' || v_order.status::text
    );
  END IF;

  v_canonical := p_status::public.production_status;

  UPDATE public.production_orders
  SET
    status     = v_canonical,
    priority   = COALESCE(p_priority, priority),
    updated_at = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success',  true,
    'order_id', p_order_id,
    'status',   p_status,
    'priority', COALESCE(p_priority, v_order.priority)
  );
END;
$$;


-- ============ 5. RLS minimale sur tables critiques ============
-- Authentifié = accès complet. Anonyme = rien.
-- Utilise IF NOT EXISTS pour être idempotent si déjà partiellement appliqué.

DO $$
DECLARE
  tbl  text;
  pol  text := 'authenticated_full_access';
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'composants', 'coffrets', 'nomenclatures', 'mouvements',
    'production_orders', 'production_consumption', 'stock_reservations',
    'production_order_idempotency'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = tbl AND policyname = pol
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO authenticated'
        ' USING (true) WITH CHECK (true)',
        pol, tbl
      );
    END IF;
  END LOOP;
END $$;
