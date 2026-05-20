-- ============================================================
-- CORRECTIF: décrémentage du stock lors de la fabrication
--
-- Problèmes identifiés:
--   1. validate_production_order (20260424) ne décrément plus le stock:
--      elle se contentait de mettre status='done' sans insérer de mouvements OUT.
--   2. create_production_order_atomic référençait coffret_components qui n'existe
--      pas dans les migrations, et insérait dans stock_movements (table ou vue
--      sans trigger sur composants.stock) au lieu de mouvements.
--   3. production_consumption (table d'audit) n'était jamais créée.
--
-- Corrections:
--   - Crée production_consumption si elle n'existe pas.
--   - validate_production_order : insère des mouvements OUT dans mouvements;
--     le trigger tg_apply_mouvement met automatiquement à jour composants.stock.
--   - create_production_order_atomic : utilise nomenclatures (source de vérité BOM)
--     au lieu de coffret_components; ne décrémente plus à la création (c'est
--     validate_production_order qui le fait).
-- ============================================================

-- ============ 1. Table d'audit des consommations ============

CREATE TABLE IF NOT EXISTS public.production_consumption (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_order_id uuid NOT NULL REFERENCES public.production_orders(id) ON DELETE CASCADE,
  composant_id        uuid NOT NULL REFERENCES public.composants(id) ON DELETE RESTRICT,
  quantity            integer NOT NULL CHECK (quantity > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (production_order_id, composant_id)
);

CREATE INDEX IF NOT EXISTS idx_production_consumption_order
  ON public.production_consumption(production_order_id);
CREATE INDEX IF NOT EXISTS idx_production_consumption_composant
  ON public.production_consumption(composant_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'production_consumption' AND policyname = 'open_all'
  ) THEN
    ALTER TABLE public.production_consumption ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "open_all" ON public.production_consumption FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ============ 2. validate_production_order ============
-- Insère les mouvements OUT dans mouvements (trigger tg_apply_mouvement → composants.stock).

CREATE OR REPLACE FUNCTION public.validate_production_order(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.production_orders%ROWTYPE;
  r       record;
BEGIN
  SELECT * INTO v_order
  FROM public.production_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order not found');
  END IF;

  IF v_order.status::text = 'done' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already done');
  END IF;

  IF v_order.status::text IN ('canceled', 'annule') THEN
    RETURN jsonb_build_object('success', false, 'error', 'order is canceled');
  END IF;

  -- Décrémenter le stock : un mouvement OUT par composant dans mouvements.
  -- Le trigger tg_apply_mouvement met à jour composants.stock automatiquement.
  FOR r IN
    SELECT n.composant_id,
           (n.quantity * v_order.quantity)::integer AS qty
    FROM public.nomenclatures n
    WHERE n.coffret_id = v_order.coffret_id
  LOOP
    INSERT INTO public.mouvements (
      composant_id,
      type,
      quantity,
      reason,
      production_order_id
    )
    VALUES (
      r.composant_id,
      'OUT',
      r.qty,
      'Production ' || v_order.reference,
      v_order.id
    );
  END LOOP;

  UPDATE public.production_orders
  SET
    status     = 'done'::public.production_status,
    done_at    = now(),
    updated_at = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true, 'order_id', p_order_id, 'status', 'done');
END;
$$;

-- ============ 3. create_production_order_atomic ============
-- Utilise nomenclatures au lieu de coffret_components.
-- Ne décrémente plus le stock à la création : c'est validate_production_order qui le fait.

CREATE OR REPLACE FUNCTION public.create_production_order_atomic(
  p_coffret_id       uuid,
  p_quantity         integer,
  p_status           public.production_status DEFAULT 'draft'::public.production_status,
  p_priority         integer DEFAULT 0,
  p_notes            text DEFAULT NULL,
  p_idempotency_key  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id   uuid;
  v_reference  text;
  v_inserted   integer;
  v_need       record;
  v_available  integer;
BEGIN
  IF p_coffret_id IS NULL THEN
    RAISE EXCEPTION 'p_coffret_id is required';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'p_quantity must be > 0';
  END IF;

  IF p_priority IS NULL OR p_priority NOT IN (0, 1) THEN
    RAISE EXCEPTION 'p_priority must be 0 or 1';
  END IF;

  IF p_status NOT IN ('draft'::public.production_status, 'priority'::public.production_status) THEN
    RAISE EXCEPTION 'invalid initial status (must be draft or priority)';
  END IF;

  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'p_idempotency_key is required';
  END IF;

  -- Idempotence
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

  -- Vérification coffret actif
  IF NOT EXISTS (
    SELECT 1 FROM public.coffrets WHERE id = p_coffret_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'coffret not found or archived: %', p_coffret_id;
  END IF;

  -- Vérification nomenclature non vide
  IF NOT EXISTS (
    SELECT 1 FROM public.nomenclatures WHERE coffret_id = p_coffret_id
  ) THEN
    RAISE EXCEPTION 'no BOM lines (nomenclature) found for coffret %', p_coffret_id;
  END IF;

  -- Verrouillage des composants (anti-race condition)
  PERFORM 1
  FROM public.composants c
  JOIN public.nomenclatures n ON n.composant_id = c.id
  WHERE n.coffret_id = p_coffret_id
  FOR UPDATE;

  -- Vérification du stock disponible (stock − reserved_stock)
  FOR v_need IN
    SELECT
      n.composant_id,
      (n.quantity * p_quantity)::integer AS qty_needed
    FROM public.nomenclatures n
    WHERE n.coffret_id = p_coffret_id
  LOOP
    SELECT GREATEST(0, COALESCE(c.stock, 0) - COALESCE(c.reserved_stock, 0))::integer
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

  -- Création de l'ordre
  INSERT INTO public.production_orders (
    coffret_id, quantity, status, priority, notes
  )
  VALUES (
    p_coffret_id, p_quantity, p_status, p_priority, p_notes
  )
  RETURNING id, reference
  INTO v_order_id, v_reference;

  -- Enregistrement des consommations prévues (audit)
  INSERT INTO public.production_consumption (
    production_order_id, composant_id, quantity
  )
  SELECT
    v_order_id,
    n.composant_id,
    (n.quantity * p_quantity)::integer
  FROM public.nomenclatures n
  WHERE n.coffret_id = p_coffret_id
  ON CONFLICT (production_order_id, composant_id) DO NOTHING;

  -- Finalisation de l'idempotency record
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
