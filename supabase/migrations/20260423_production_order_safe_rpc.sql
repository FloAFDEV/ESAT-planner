-- ============================================================
-- MIGRATION: RPC pour création atomique d'OF avec réservations
-- Sécurise la création contre les race conditions
-- Date: 2026-04-23
-- ============================================================

-- ============ 0. EXTENSION DU SCHÉMA COURANT ==========
-- Stock réservé matérialisé côté composants + table d'audit des réservations
ALTER TABLE public.composants
  ADD COLUMN IF NOT EXISTS reserved_stock integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.stock_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  composant_id uuid NOT NULL REFERENCES public.composants(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  production_order_id uuid NOT NULL REFERENCES public.production_orders(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'canceled')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_reservations_composant ON public.stock_reservations(composant_id);
CREATE INDEX IF NOT EXISTS idx_stock_reservations_order ON public.stock_reservations(production_order_id);
CREATE INDEX IF NOT EXISTS idx_stock_reservations_status ON public.stock_reservations(status);

CREATE OR REPLACE FUNCTION public.tg_sync_reserved_stock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_ids := ARRAY[NEW.composant_id];
  ELSIF TG_OP = 'DELETE' THEN
    v_ids := ARRAY[OLD.composant_id];
  ELSE
    v_ids := ARRAY[OLD.composant_id, NEW.composant_id];
  END IF;

  WITH affected AS (
    SELECT DISTINCT unnest(v_ids) AS composant_id
  ), totals AS (
    SELECT composant_id, COALESCE(SUM(quantity), 0) AS total_reserved
    FROM public.stock_reservations
    WHERE status = 'active'
      AND composant_id = ANY(v_ids)
    GROUP BY composant_id
  )
  UPDATE public.composants c
  SET reserved_stock = COALESCE(t.total_reserved, 0)
  FROM affected a
  LEFT JOIN totals t ON t.composant_id = a.composant_id
  WHERE c.id = a.composant_id;

  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS tg_sync_reserved_stock ON public.stock_reservations;
CREATE TRIGGER tg_sync_reserved_stock
  AFTER INSERT OR UPDATE OR DELETE ON public.stock_reservations
  FOR EACH ROW EXECUTE FUNCTION public.tg_sync_reserved_stock();

-- ============ 1. RPC: create_production_order_safe ============
-- Crée un OF + réservations en transaction atomique
-- Refait le check de faisabilité côté backend
-- Rejette si inconsistance
CREATE OR REPLACE FUNCTION public.create_production_order_safe(
  p_coffret_id uuid,
  p_quantity integer,
  p_status text DEFAULT 'draft',
  p_notes text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_coffret public.coffrets%ROWTYPE;
  v_bom_version public.bom_versions%ROWTYPE;
  v_order_id uuid;
  v_reference text;
  r record;
  v_total_missing int := 0;
  v_available int;
  v_missing int;
BEGIN
  -- 1. Validate input
  IF p_quantity <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'quantity must be > 0');
  END IF;

  IF p_status = 'done' THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot create an order already done');
  END IF;

  -- 2. Get coffret (lock for update)
  SELECT * INTO v_coffret FROM public.coffrets 
  WHERE id = p_coffret_id FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'coffret not found');
  END IF;

  -- 3. Get active BOM
  SELECT * INTO v_bom_version FROM public.bom_versions
  WHERE product_variant_id = p_coffret_id AND is_active = true
  ORDER BY version DESC LIMIT 1 FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no active BOM for coffret');
  END IF;

  -- 4. Verify feasibility (refait le check côté backend)
  FOR r IN
    SELECT
      bl.id,
      bl.composant_id,
      bl.quantity as qty_per_unit,
      (bl.quantity * p_quantity) AS qty_needed,
      c.stock,
      c.reserved_stock,
      c.min_stock
    FROM public.bom_lines bl
    JOIN public.composants c ON c.id = bl.composant_id
    WHERE bl.bom_version_id = v_bom_version.id
    FOR UPDATE OF c
  LOOP
    v_available := COALESCE(r.stock, 0) - COALESCE(r.reserved_stock, 0);
    v_missing := GREATEST(0, r.qty_needed - v_available);

    IF v_missing > 0 THEN
      v_total_missing := v_total_missing + 1;
    END IF;
  END LOOP;

  -- 5. Reject if missing
  IF v_total_missing > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('%s composant(s) insuffisant(s)', v_total_missing)
    );
  END IF;

  -- 6. Create production order
  INSERT INTO public.production_orders(
    coffret_id, quantity, status, notes
  )
  VALUES(p_coffret_id, p_quantity, p_status, p_notes)
  RETURNING id INTO v_order_id;

  -- 7. Create stock reservations for each component
  INSERT INTO public.stock_reservations(
    composant_id, quantity, production_order_id, status
  )
  SELECT
    bl.composant_id,
    (bl.quantity * p_quantity),
    v_order_id,
    'active'
  FROM public.bom_lines bl
  WHERE bl.bom_version_id = v_bom_version.id;

  -- 8. Return success
  SELECT reference INTO v_reference
  FROM public.production_orders
  WHERE id = v_order_id;

  RETURN jsonb_build_object(
    'success', true,
    'order_id', v_order_id,
    'reference', v_reference,
    'coffret_id', p_coffret_id,
    'quantity', p_quantity,
    'status', p_status
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'error', SQLERRM
  );
END $$;

-- ============ 2. RPC: check_production_feasibility_multi ============
-- Vérifie la faisabilité de plusieurs coffrets en même temps
-- Cumul les besoins par composant
-- Détecte les conflits
CREATE OR REPLACE FUNCTION public.check_production_feasibility_multi(
  p_orders jsonb
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_composant_needs jsonb := '{}'::jsonb;
  v_composant_status jsonb := '[]'::jsonb;
  v_total_missing int := 0;
  v_total_low int := 0;
  v_total_components int := 0;
  v_ok_count int := 0;
  r record;
  v_order_item jsonb;
  v_coffret_id text;
  v_quantity int;
  v_comp jsonb;
  v_available int;
  v_needed int;
  v_missing int;
  v_after int;
  v_status text;
BEGIN
  -- Parse each order item
  FOR v_order_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_orders, '[]'::jsonb)) AS value
  LOOP
    v_coffret_id := v_order_item->>'variant_id';
    v_quantity := COALESCE((v_order_item->>'quantity')::int, 0);

    IF v_coffret_id IS NULL OR v_quantity <= 0 THEN
      CONTINUE;
    END IF;

    -- Get BOM lines for this coffret
    FOR r IN
      SELECT
        bl.composant_id,
        (bl.quantity * v_quantity) AS qty_needed,
        c.stock,
        c.reserved_stock,
        c.min_stock,
        c.reference,
        c.name
      FROM public.bom_lines bl
      JOIN public.bom_versions bv ON bv.id = bl.bom_version_id
      JOIN public.composants c ON c.id = bl.composant_id
      WHERE bv.product_variant_id = v_coffret_id::uuid
        AND bv.is_active = true
    LOOP
      -- Cumul des besoins par composant
      IF v_composant_needs ? r.composant_id::text THEN
        v_composant_needs := jsonb_set(
          v_composant_needs,
          ARRAY[r.composant_id::text],
          jsonb_build_object(
            'reference', v_composant_needs->r.composant_id::text->>'reference',
            'name', v_composant_needs->r.composant_id::text->>'name',
            'stock', (v_composant_needs->r.composant_id::text->>'stock')::int,
            'reserved_stock', (v_composant_needs->r.composant_id::text->>'reserved_stock')::int,
            'min_stock', (v_composant_needs->r.composant_id::text->>'min_stock')::int,
            'total_needed', ((v_composant_needs->r.composant_id::text->>'total_needed')::int + r.qty_needed)
          )
        );
      ELSE
        v_composant_needs := v_composant_needs || jsonb_build_object(
          r.composant_id::text,
          jsonb_build_object(
            'reference', r.reference,
            'name', r.name,
            'stock', r.stock,
            'reserved_stock', r.reserved_stock,
            'min_stock', r.min_stock,
            'total_needed', r.qty_needed
          )
        );
      END IF;
    END LOOP;
  END LOOP;

  SELECT COUNT(*) INTO v_total_components
  FROM jsonb_object_keys(v_composant_needs) AS comp_id;

  -- Analyze each component
  FOR r IN SELECT key AS comp_id, value AS comp FROM jsonb_each(v_composant_needs)
  LOOP
    v_comp := r.comp;
    v_available := (v_comp->>'stock')::int - (v_comp->>'reserved_stock')::int;
    v_needed := (v_comp->>'total_needed')::int;
    v_missing := GREATEST(0, v_needed - v_available);
    v_after := v_available - v_needed;

    IF v_missing > 0 THEN
      v_status := 'MISSING';
      v_total_missing := v_total_missing + 1;
    ELSIF v_after <= (v_comp->>'min_stock')::int THEN
      v_status := 'LOW';
      v_total_low := v_total_low + 1;
    ELSE
      v_status := 'OK';
      v_ok_count := v_ok_count + 1;
    END IF;

    v_composant_status := v_composant_status || jsonb_build_array(jsonb_build_object(
      'composant_id', r.comp_id,
      'reference', v_comp->>'reference',
      'name', v_comp->>'name',
      'stock', (v_comp->>'stock')::int,
      'reserved', (v_comp->>'reserved_stock')::int,
      'available', v_available,
      'needed', v_needed,
      'missing', v_missing,
      'after_production', v_after,
      'min_stock', (v_comp->>'min_stock')::int,
      'status', v_status
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'ok', v_total_missing = 0,
    'summary', jsonb_build_object(
      'total_components', v_total_components,
      'ok_count', v_ok_count,
      'low_count', v_total_low,
      'missing_count', v_total_missing
    ),
    'components', v_composant_status
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'error', SQLERRM
  );
END $$;

-- ============ 3. RPC: cancel_production_order_with_unreserve ============
-- Annule un OF et libère les réservations
CREATE OR REPLACE FUNCTION public.cancel_production_order_with_unreserve(
  p_order_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.production_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.production_orders 
  WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order not found');
  END IF;

  IF v_order.status = 'done' THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot cancel completed order');
  END IF;

  -- Cancel all active reservations
  UPDATE public.stock_reservations
  SET status = 'canceled'
  WHERE production_order_id = p_order_id AND status = 'active';

  -- Update order status
  UPDATE public.production_orders
  SET status = 'canceled'
  WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true, 'order_id', p_order_id);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;

-- ============ 4. VIEW: composants_with_reservations ============
-- Vue pour voir le stock disponible réel (tenant compte des réservations)
CREATE OR REPLACE VIEW public.composants_with_reservations AS
SELECT
  c.id,
  c.reference,
  c.name,
  c.stock,
  c.min_stock,
  c.poids_unitaire,
  COALESCE(c.reserved_stock, 0) AS reserved_direct,
  COALESCE(r.total_reserved, 0) AS reserved_by_orders,
  COALESCE(c.reserved_stock, 0) + COALESCE(r.total_reserved, 0) AS total_reserved,
  c.stock - COALESCE(c.reserved_stock, 0) - COALESCE(r.total_reserved, 0) AS available_for_new_orders,
  c.is_active,
  c.created_at,
  c.updated_at
FROM public.composants c
LEFT JOIN (
  SELECT
    composant_id,
    SUM(quantity) AS total_reserved
  FROM public.stock_reservations
  WHERE status IN ('active', 'pending')
  GROUP BY composant_id
) r ON r.composant_id = c.id;

-- ============ 5. TRIGGER: auto-mark reservations as consumed when OF done ============
CREATE OR REPLACE FUNCTION public.tg_production_order_done()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'done' AND OLD.status != 'done' THEN
    -- Mark reservations as consumed
    UPDATE public.stock_reservations
    SET status = 'consumed'
    WHERE production_order_id = NEW.id AND status = 'active';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tg_production_order_done ON public.production_orders;
CREATE TRIGGER tg_production_order_done AFTER UPDATE ON public.production_orders
  FOR EACH ROW EXECUTE FUNCTION public.tg_production_order_done();

COMMIT;
