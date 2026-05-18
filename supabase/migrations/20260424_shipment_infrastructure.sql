-- ============================================================
-- MIGRATION: Création infrastructure complète shipments
-- Basée sur schéma réel Supabase (avril 2026)
-- Tables: shipments, shipment_lines, shipment_pallets, shipment_pallet_lines
-- ============================================================

-- ============ 1. SHIPMENTS (livraisons commerciales) ============
CREATE TABLE IF NOT EXISTS public.shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text UNIQUE,
  client_id uuid REFERENCES public.clients(id) ON DELETE RESTRICT,
  total_weight numeric DEFAULT 0,
  total_pallets integer DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'shipped', 'delivered')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shipments_client ON public.shipments(client_id);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON public.shipments(status);
CREATE INDEX IF NOT EXISTS idx_shipments_created ON public.shipments(created_at DESC);

-- ============ 2. SHIPMENT_LINES (lignes produit du shipment) ============
CREATE TABLE IF NOT EXISTS public.shipment_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
  product_variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  weight numeric DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shipment_lines_shipment ON public.shipment_lines(shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_lines_variant ON public.shipment_lines(product_variant_id);

-- ============ 3. SHIPMENT_PALLETS (palettes physiques) ============
CREATE TABLE IF NOT EXISTS public.shipment_pallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
  label text,
  type text,
  weight numeric DEFAULT 0,
  width numeric,
  height numeric,
  depth numeric,
  computed_weight boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shipment_pallets_shipment ON public.shipment_pallets(shipment_id);

-- ============ 4. SHIPMENT_PALLET_LINES (traçabilité: quelle ligne sur quelle palette) ============
CREATE TABLE IF NOT EXISTS public.shipment_pallet_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pallet_id uuid NOT NULL REFERENCES public.shipment_pallets(id) ON DELETE CASCADE,
  shipment_line_id uuid NOT NULL REFERENCES public.shipment_lines(id) ON DELETE CASCADE,
  quantity integer NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shipment_pallet_lines_pallet ON public.shipment_pallet_lines(pallet_id);
CREATE INDEX IF NOT EXISTS idx_shipment_pallet_lines_line ON public.shipment_pallet_lines(shipment_line_id);

-- ============ 5. TRIGGERS updated_at ============
CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER set_updated_at_shipments BEFORE UPDATE ON public.shipments
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER set_updated_at_shipment_lines BEFORE UPDATE ON public.shipment_lines
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER set_updated_at_shipment_pallets BEFORE UPDATE ON public.shipment_pallets
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- ============ 6. RPC: Créer shipment vide ============
CREATE OR REPLACE FUNCTION public.create_shipment(
  p_client_id uuid,
  p_reference text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_shipment_id uuid;
  v_reference text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE id = p_client_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Client not found');
  END IF;

  v_reference := COALESCE(p_reference, 'SHP-' || to_char(now(), 'YYMMDD-HH24MISS'));

  INSERT INTO public.shipments (reference, client_id, status)
  VALUES (v_reference, p_client_id, 'draft')
  RETURNING id INTO v_shipment_id;

  RETURN jsonb_build_object(
    'success', true,
    'shipment_id', v_shipment_id,
    'reference', v_reference
  );
END $$;

-- ============ 7. RPC: Ajouter ligne au shipment ============
CREATE OR REPLACE FUNCTION public.add_shipment_line(
  p_shipment_id uuid,
  p_variant_id uuid,
  p_quantity integer
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_line_id uuid;
  v_weight numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.shipments WHERE id = p_shipment_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Shipment not found');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.product_variants WHERE id = p_variant_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Variant not found');
  END IF;

  SELECT weight INTO v_weight FROM public.product_variants WHERE id = p_variant_id;

  INSERT INTO public.shipment_lines (shipment_id, product_variant_id, quantity, weight)
  VALUES (p_shipment_id, p_variant_id, p_quantity, COALESCE(v_weight, 0) * p_quantity)
  RETURNING id INTO v_line_id;

  -- Recalcul totaux shipment
  UPDATE public.shipments
  SET
    total_weight = (
      SELECT COALESCE(SUM(weight), 0) + COALESCE(SUM(sp.weight), 0)
      FROM public.shipment_lines sl
      FULL OUTER JOIN public.shipment_pallets sp ON sp.shipment_id = p_shipment_id
      WHERE sl.shipment_id = p_shipment_id
    ),
    total_pallets = (
      SELECT COUNT(*) FROM public.shipment_pallets WHERE shipment_id = p_shipment_id
    )
  WHERE id = p_shipment_id;

  RETURN jsonb_build_object(
    'success', true,
    'line_id', v_line_id
  );
END $$;

-- ============ 8. RPC: Créer palette et mapper lignes ============
CREATE OR REPLACE FUNCTION public.create_pallet_with_mapping(
  p_shipment_id uuid,
  p_label text,
  p_type text,
  p_weight numeric DEFAULT 0,
  p_width numeric DEFAULT NULL,
  p_height numeric DEFAULT NULL,
  p_depth numeric DEFAULT NULL,
  p_line_mappings jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pallet_id uuid;
  v_mapping jsonb;
  v_line_id uuid;
  v_qty integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.shipments WHERE id = p_shipment_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Shipment not found');
  END IF;

  INSERT INTO public.shipment_pallets (
    shipment_id, label, type, weight, width, height, depth
  )
  VALUES (p_shipment_id, p_label, p_type, p_weight, p_width, p_height, p_depth)
  RETURNING id INTO v_pallet_id;

  -- Ajouter mappages ligne → palette
  FOR v_mapping IN SELECT * FROM jsonb_array_elements(p_line_mappings)
  LOOP
    v_line_id := (v_mapping->>'shipment_line_id')::uuid;
    v_qty := (v_mapping->>'quantity')::integer;

    IF EXISTS (SELECT 1 FROM public.shipment_lines WHERE id = v_line_id AND shipment_id = p_shipment_id) THEN
      INSERT INTO public.shipment_pallet_lines (pallet_id, shipment_line_id, quantity)
      VALUES (v_pallet_id, v_line_id, v_qty)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  -- Recalcul totaux shipment
  UPDATE public.shipments
  SET
    total_weight = (
      SELECT COALESCE(SUM(weight), 0) + COALESCE(SUM(sp.weight), 0)
      FROM public.shipment_lines sl
      FULL OUTER JOIN public.shipment_pallets sp ON sp.shipment_id = p_shipment_id
      WHERE sl.shipment_id = p_shipment_id
    ),
    total_pallets = (
      SELECT COUNT(*) FROM public.shipment_pallets WHERE shipment_id = p_shipment_id
    )
  WHERE id = p_shipment_id;

  RETURN jsonb_build_object(
    'success', true,
    'pallet_id', v_pallet_id
  );
END $$;

-- ============ 9. RPC: Transition statut shipment ============
CREATE OR REPLACE FUNCTION public.transition_shipment_status(
  p_shipment_id uuid,
  p_status text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_shipment public.shipments%ROWTYPE;
BEGIN
  SELECT * INTO v_shipment FROM public.shipments WHERE id = p_shipment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Shipment not found');
  END IF;

  IF p_status NOT IN ('draft', 'ready', 'shipped', 'delivered') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid status');
  END IF;

  IF v_shipment.status = 'delivered' AND p_status <> 'draft' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot modify delivered shipment');
  END IF;

  UPDATE public.shipments
  SET status = p_status, updated_at = now()
  WHERE id = p_shipment_id;

  RETURN jsonb_build_object(
    'success', true,
    'shipment_id', p_shipment_id,
    'status', p_status
  );
END $$;

-- ============ 10. RPC: Consulter détail shipment avec pallet_lines ============
CREATE OR REPLACE FUNCTION public.get_shipment_detail(p_shipment_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_shipment public.shipments%ROWTYPE;
  v_result jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_pallets jsonb := '[]'::jsonb;
  r_line record;
  r_pallet record;
  r_pallet_line record;
BEGIN
  SELECT * INTO v_shipment FROM public.shipments WHERE id = p_shipment_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Shipment not found');
  END IF;

  -- Lignes shipment avec pallet_lines
  FOR r_line IN
    SELECT
      sl.id,
      sl.product_variant_id,
      pv.reference,
      pv.name,
      sl.quantity,
      sl.weight,
      array_agg(jsonb_build_object(
        'pallet_id', spl.pallet_id,
        'quantity', spl.quantity
      )) FILTER (WHERE spl.id IS NOT NULL) AS pallet_mappings
    FROM public.shipment_lines sl
    LEFT JOIN public.product_variants pv ON pv.id = sl.product_variant_id
    LEFT JOIN public.shipment_pallet_lines spl ON spl.shipment_line_id = sl.id
    WHERE sl.shipment_id = p_shipment_id
    GROUP BY sl.id, sl.product_variant_id, pv.reference, pv.name, sl.quantity, sl.weight
  LOOP
    v_lines := v_lines || jsonb_build_object(
      'id', r_line.id,
      'product_variant_id', r_line.product_variant_id,
      'reference', r_line.reference,
      'name', r_line.name,
      'quantity', r_line.quantity,
      'weight', r_line.weight,
      'pallet_mappings', COALESCE(r_line.pallet_mappings, ARRAY[]::jsonb[])
    );
  END LOOP;

  -- Palettes avec composition
  FOR r_pallet IN
    SELECT
      sp.id,
      sp.label,
      sp.type,
      sp.weight,
      sp.width,
      sp.height,
      sp.depth,
      array_agg(jsonb_build_object(
        'line_id', spl.shipment_line_id,
        'quantity', spl.quantity
      )) FILTER (WHERE spl.id IS NOT NULL) AS line_mappings
    FROM public.shipment_pallets sp
    LEFT JOIN public.shipment_pallet_lines spl ON spl.pallet_id = sp.id
    WHERE sp.shipment_id = p_shipment_id
    GROUP BY sp.id, sp.label, sp.type, sp.weight, sp.width, sp.height, sp.depth
  LOOP
    v_pallets := v_pallets || jsonb_build_object(
      'id', r_pallet.id,
      'label', r_pallet.label,
      'type', r_pallet.type,
      'weight', r_pallet.weight,
      'dimensions', jsonb_build_object(
        'width', r_pallet.width,
        'height', r_pallet.height,
        'depth', r_pallet.depth
      ),
      'line_mappings', COALESCE(r_pallet.line_mappings, ARRAY[]::jsonb[])
    );
  END LOOP;

  v_result := jsonb_build_object(
    'shipment', jsonb_build_object(
      'id', v_shipment.id,
      'reference', v_shipment.reference,
      'client_id', v_shipment.client_id,
      'status', v_shipment.status,
      'total_weight', v_shipment.total_weight,
      'total_pallets', v_shipment.total_pallets,
      'created_at', v_shipment.created_at
    ),
    'lines', v_lines,
    'pallets', v_pallets
  );

  RETURN v_result;
END $$;

COMMIT;
