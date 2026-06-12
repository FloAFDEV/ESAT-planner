-- ============================================================
-- FIX: product_variants weight + product_reference réservations
--
-- product_variants peut être une TABLE ou une VIEW selon l'env.
-- Ce bloc DO $$ gère les deux cas sans échouer.
-- ============================================================

-- ── 1. Ajout du champ weight sur product_variants (TABLE ou VIEW) ─────────
DO $$
DECLARE
  v_obj_type text;
  v_has_weight boolean;
BEGIN
  SELECT table_type INTO v_obj_type
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'product_variants';

  IF v_obj_type = 'BASE TABLE' THEN
    -- product_variants est une TABLE : ajouter weight si absent, puis synchroniser
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'product_variants'
        AND column_name  = 'weight'
    ) INTO v_has_weight;

    IF NOT v_has_weight THEN
      EXECUTE 'ALTER TABLE public.product_variants ADD COLUMN weight numeric DEFAULT 0';
    END IF;

    -- Synchronise weight depuis coffrets.poids_coffret (par id)
    EXECUTE '
      UPDATE public.product_variants pv
      SET weight = c.poids_coffret
      FROM public.coffrets c
      WHERE pv.id = c.id
    ';

  ELSIF v_obj_type = 'VIEW' THEN
    -- product_variants est une VIEW : recréer avec l'alias weight + filtre soft-delete
    EXECUTE $view$
      CREATE OR REPLACE VIEW public.product_variants AS
      SELECT
        c.id,
        c.reference,
        c.name,
        c.poids_coffret          AS weight,
        c.nb_par_palette,
        c.poids_palette,
        'coffret'::text          AS type,
        c.created_at,
        c.updated_at
      FROM public.coffrets c
      WHERE c.deleted_at IS NULL
    $view$;

  ELSE
    -- N'existe pas : créer la VIEW
    EXECUTE $view$
      CREATE VIEW public.product_variants AS
      SELECT
        c.id,
        c.reference,
        c.name,
        c.poids_coffret          AS weight,
        c.nb_par_palette,
        c.poids_palette,
        'coffret'::text          AS type,
        c.created_at,
        c.updated_at
      FROM public.coffrets c
      WHERE c.deleted_at IS NULL
    $view$;
  END IF;
END $$;

-- ── 2. Colonne product_reference sur stock_reservations ───────────────────
ALTER TABLE public.stock_reservations
  ADD COLUMN IF NOT EXISTS product_reference text;

-- Backfill via coffret_snapshot (priorité) ou référence courante du coffret
UPDATE public.stock_reservations sr
SET product_reference = COALESCE(
  po.coffret_snapshot->>'reference',
  c.reference
)
FROM public.production_orders po
JOIN public.coffrets c ON c.id = po.coffret_id
WHERE sr.production_order_id = po.id
  AND sr.product_reference IS NULL;

-- ── 3. Mise à jour de create_production_order_atomic ─────────────────────
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
  v_order_id         uuid;
  v_reference        text;
  v_coffret_ref      text;
  v_inserted         integer;
  v_need             record;
  v_available        integer;
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
  IF p_status NOT IN ('draft', 'priority') THEN
    RAISE EXCEPTION 'invalid initial status (must be draft or priority)';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'p_idempotency_key is required';
  END IF;

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

  IF NOT EXISTS (
    SELECT 1 FROM public.coffrets WHERE id = p_coffret_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'coffret not found or archived: %', p_coffret_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.nomenclatures WHERE coffret_id = p_coffret_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'no active BOM lines found for coffret %', p_coffret_id;
  END IF;

  -- Snapshot de la référence coffret (figée au moment de la création OF)
  SELECT reference INTO v_coffret_ref FROM public.coffrets WHERE id = p_coffret_id;

  PERFORM 1
  FROM public.composants c
  JOIN public.nomenclatures n ON n.composant_id = c.id
  WHERE n.coffret_id = p_coffret_id AND n.is_active = true
  ORDER BY c.id
  FOR UPDATE;

  FOR v_need IN
    SELECT n.composant_id, (n.quantity * p_quantity)::integer AS qty_needed
    FROM public.nomenclatures n
    WHERE n.coffret_id = p_coffret_id AND n.is_active = true
  LOOP
    SELECT GREATEST(0, COALESCE(c.stock, 0) - COALESCE(c.reserved_stock, 0))::integer
    INTO v_available
    FROM public.composants c WHERE c.id = v_need.composant_id;

    IF COALESCE(v_available, 0) < v_need.qty_needed THEN
      RAISE EXCEPTION 'insufficient stock for composant % (needed %, available %)',
        v_need.composant_id, v_need.qty_needed, COALESCE(v_available, 0);
    END IF;
  END LOOP;

  INSERT INTO public.production_orders (coffret_id, quantity, status, priority, notes)
  VALUES (p_coffret_id, p_quantity, p_status::public.production_status, p_priority, p_notes)
  RETURNING id, reference INTO v_order_id, v_reference;

  -- Réservation avec product_reference figée
  INSERT INTO public.stock_reservations (
    composant_id, quantity, production_order_id, status, product_reference
  )
  SELECT
    n.composant_id,
    (n.quantity * p_quantity)::integer,
    v_order_id,
    'active',
    v_coffret_ref
  FROM public.nomenclatures n
  WHERE n.coffret_id = p_coffret_id AND n.is_active = true;

  INSERT INTO public.production_consumption (production_order_id, composant_id, quantity)
  SELECT v_order_id, n.composant_id, (n.quantity * p_quantity)::integer
  FROM public.nomenclatures n
  WHERE n.coffret_id = p_coffret_id AND n.is_active = true
  ON CONFLICT (production_order_id, composant_id) DO NOTHING;

  UPDATE public.production_order_idempotency
  SET order_id = v_order_id WHERE idempotency_key = p_idempotency_key;

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

-- ── 4. Vue métier v_reservations_by_of ───────────────────────────────────
CREATE OR REPLACE VIEW public.v_reservations_by_of AS
SELECT
  sr.id                        AS reservation_id,
  sr.production_order_id,
  po.reference                 AS of_number,
  sr.product_reference,
  co.reference                 AS composant_reference,
  co.name                      AS composant_name,
  sr.quantity,
  sr.status,
  sr.created_at,
  po.status                    AS of_status,
  po.coffret_id
FROM public.stock_reservations sr
JOIN public.production_orders  po ON po.id = sr.production_order_id
JOIN public.composants         co ON co.id = sr.composant_id
ORDER BY po.reference, sr.product_reference, co.reference;
