-- ============================================================
-- OF CUSTOM : support produits libres hors coffret
--
-- Ajout non-destructif sur production_orders :
--   - product_type : 'coffret' (défaut, flux existant) | 'custom'
--   - label        : nom libre pour les OF custom
--
-- Nouvelle RPC create_custom_production_order :
--   - bypass validation coffret + BOM
--   - insère directement avec coffret_id = NULL
--   - reprend la même logique d'idempotence
-- ============================================================

BEGIN;

-- ── 1. Colonnes ───────────────────────────────────────────────────────────

ALTER TABLE public.production_orders
  ADD COLUMN IF NOT EXISTS product_type text DEFAULT 'coffret';

ALTER TABLE public.production_orders
  ADD COLUMN IF NOT EXISTS label text DEFAULT NULL;

-- Backfill : tous les OFs existants sont des coffrets
UPDATE public.production_orders
SET product_type = 'coffret'
WHERE product_type IS NULL;

-- ── 2. RPC create_custom_production_order ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_custom_production_order(
  p_label           text,
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
  v_order_id   uuid;
  v_reference  text;
  v_inserted   integer;
BEGIN
  IF p_label IS NULL OR btrim(p_label) = '' THEN
    RAISE EXCEPTION 'p_label is required for custom production orders';
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

  -- Idempotence
  INSERT INTO public.production_order_idempotency (idempotency_key, order_id)
  VALUES (p_idempotency_key, NULL)
  ON CONFLICT (idempotency_key) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    SELECT poi.order_id, po.reference
    INTO   v_order_id, v_reference
    FROM   public.production_order_idempotency poi
    LEFT JOIN public.production_orders po ON po.id = poi.order_id
    WHERE  poi.idempotency_key = p_idempotency_key;

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

  -- Création OF custom sans coffret_id ni BOM
  INSERT INTO public.production_orders (
    coffret_id, quantity, status, priority, notes, product_type, label, can_start_now
  )
  VALUES (
    NULL,
    p_quantity,
    p_status::public.production_status,
    p_priority,
    p_notes,
    'custom',
    btrim(p_label),
    true  -- pas de BOM → toujours démarrable
  )
  RETURNING id, reference INTO v_order_id, v_reference;

  UPDATE public.production_order_idempotency
  SET order_id = v_order_id
  WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object(
    'success',   true,
    'order_id',  v_order_id,
    'reference', v_reference
  );
END;
$$;

COMMIT;
