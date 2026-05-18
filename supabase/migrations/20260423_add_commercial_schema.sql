-- ============================================================
-- MIGRATION: Schéma commercial manquant (commandes clients, BOM versionné, clients)
-- Aligne base avec frontend (orders, clients, product_variants, bom_versions, bom_lines)
-- Date: 2026-04-23
-- ============================================================

-- ============ 1. CLIENTS ============
CREATE TABLE IF NOT EXISTS public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text UNIQUE,
  name text NOT NULL,
  address text,
  city text,
  postal_code text,
  country text DEFAULT 'FR',
  contact_email text,
  contact_phone text,
  payment_terms text,
  notes text,
  is_active boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_clients_name ON public.clients(name);
CREATE INDEX idx_clients_active ON public.clients(is_active);

-- ============ 2. PRODUCT_VARIANTS (alias pour coffrets, permet extension future) ============
-- Normalement: product_variants référence coffrets
-- Strategy: product_variants = VIEW sur coffrets (façade)
--           ou: table parallèle avec FK vers coffrets
-- 
-- On choisit la VIEW pour compatibilité maximale sans refacto
CREATE OR REPLACE VIEW public.product_variants AS
SELECT
  c.id,
  c.reference,
  c.name,
  c.poids_coffret,
  c.nb_par_palette,
  c.poids_palette,
  'coffret'::text AS type,
  c.created_at,
  c.updated_at
FROM public.coffrets c;

-- ============ 3. BOM_VERSIONS (versions de nomenclatures) ============
CREATE TABLE IF NOT EXISTS public.bom_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_variant_id uuid NOT NULL REFERENCES public.coffrets(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(product_variant_id, version)
);

CREATE INDEX idx_bom_versions_variant ON public.bom_versions(product_variant_id);
CREATE INDEX idx_bom_versions_active ON public.bom_versions(is_active);

-- ============ 4. BOM_LINES (lignes de nomenclature) ============
CREATE TABLE IF NOT EXISTS public.bom_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_version_id uuid NOT NULL REFERENCES public.bom_versions(id) ON DELETE CASCADE,
  composant_id uuid NOT NULL REFERENCES public.composants(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(bom_version_id, composant_id)
);

CREATE INDEX idx_bom_lines_version ON public.bom_lines(bom_version_id);
CREATE INDEX idx_bom_lines_composant ON public.bom_lines(composant_id);

-- ============ 5. ORDERS (commandes commerciales) ============
CREATE TABLE IF NOT EXISTS public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE DEFAULT ('CMD-' || to_char(now(), 'YYMMDD-HH24MISS')),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'confirmed', 'in_production', 'ready', 'delivered', 'canceled', 'cancelled')),
  order_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_client ON public.orders(client_id);
CREATE INDEX idx_orders_status ON public.orders(status);
CREATE INDEX idx_orders_created ON public.orders(created_at DESC);

-- ============ 6. ORDER_LINES (lignes de commandes) ============
CREATE TABLE IF NOT EXISTS public.order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_variant_id uuid NOT NULL REFERENCES public.coffrets(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(12, 2),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_lines_order ON public.order_lines(order_id);
CREATE INDEX idx_order_lines_variant ON public.order_lines(product_variant_id);

-- ============ 7. SYNC: Nomenclatures → BOM_VERSIONS/BOM_LINES ============
-- Migration helper: copie nomenclatures existantes vers bom_versions
-- Chaque coffret avec une nomenclature devient bom_version v1
DO $$
DECLARE
  v_bom_id uuid;
  v_coffret record;
  v_nomen record;
BEGIN
  FOR v_coffret IN SELECT DISTINCT coffret_id FROM public.nomenclatures
  LOOP
    -- Crée une bom_version v1 pour ce coffret
    INSERT INTO public.bom_versions (product_variant_id, version, is_active, description)
    VALUES (v_coffret.coffret_id, 1, true, 'Migré de nomenclatures')
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_bom_id;

    IF v_bom_id IS NOT NULL THEN
      -- Copie nomenclatures → bom_lines
      INSERT INTO public.bom_lines (bom_version_id, composant_id, quantity)
      SELECT v_bom_id, n.composant_id, n.quantity
      FROM public.nomenclatures n
      WHERE n.coffret_id = v_coffret.coffret_id
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- ============ 8. TRIGGER: updated_at pour nouvelles tables ============
CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER set_updated_at_clients BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER set_updated_at_orders BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER set_updated_at_order_lines BEFORE UPDATE ON public.order_lines
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER set_updated_at_bom_versions BEFORE UPDATE ON public.bom_versions
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- ============ 9. RPC: get_production_stock_status ============
-- Version simplifiée pour le front: retourne {ok, missing[], low[], details}
-- Utilise PRIORITAIREMENT bom_versions, fallback sur nomenclatures
-- Format de réponse optimisé pour UI
CREATE OR REPLACE FUNCTION public.get_production_stock_status(
  p_coffret_id uuid,
  p_quantity integer
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_coffret public.coffrets%ROWTYPE;
  v_result jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_low_stock jsonb := '[]'::jsonb;
  v_ok_items jsonb := '[]'::jsonb;
  v_has_bom boolean := false;
  r record;
BEGIN
  SELECT * INTO v_coffret FROM public.coffrets WHERE id = p_coffret_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Coffret not found');
  END IF;

  -- Détermine s'il y a une bom_version
  SELECT EXISTS(SELECT 1 FROM public.bom_versions WHERE product_variant_id = p_coffret_id AND is_active = true)
  INTO v_has_bom;

  IF v_has_bom THEN
    -- Utilise bom_versions/bom_lines (nouvelle structure)
    FOR r IN
      SELECT
        c.id,
        c.reference,
        c.name,
        c.stock,
        c.min_stock,
        bl.quantity AS qty_per_unit,
        (bl.quantity * p_quantity) AS qty_needed,
        COALESCE((
          SELECT SUM(po.quantity * bl2.quantity)
          FROM public.production_orders po
          JOIN public.bom_lines bl2 ON bl2.bom_version_id IN (
            SELECT id FROM public.bom_versions WHERE product_variant_id = po.coffret_id AND is_active = true
          ) AND bl2.composant_id = c.id
          WHERE po.status IN ('in_progress', 'priority')
        ), 0) AS reserved
      FROM public.bom_lines bl
      JOIN public.bom_versions bv ON bv.id = bl.bom_version_id
      JOIN public.composants c ON c.id = bl.composant_id
      WHERE bv.product_variant_id = p_coffret_id AND bv.is_active = true
    LOOP
      DECLARE
        v_dispo integer := r.stock - r.reserved;
        v_after integer := v_dispo - r.qty_needed;
      BEGIN
        IF v_after < 0 THEN
          v_missing := v_missing || jsonb_build_object(
            'reference', r.reference,
            'name', r.name,
            'available', v_dispo,
            'needed', r.qty_needed,
            'missing', ABS(v_after),
            'status', 'MISSING'
          );
        ELSIF v_after <= r.min_stock THEN
          v_low_stock := v_low_stock || jsonb_build_object(
            'reference', r.reference,
            'name', r.name,
            'available', v_dispo,
            'needed', r.qty_needed,
            'after_production', v_after,
            'min_stock', r.min_stock,
            'status', 'LOW'
          );
        ELSE
          v_ok_items := v_ok_items || jsonb_build_object(
            'reference', r.reference,
            'name', r.name,
            'available', v_dispo,
            'needed', r.qty_needed,
            'after_production', v_after,
            'status', 'OK'
          );
        END IF;
      END;
    END LOOP;
  ELSE
    -- Fallback sur nomenclatures (ancienne structure)
    FOR r IN
      SELECT
        c.id,
        c.reference,
        c.name,
        c.stock,
        c.min_stock,
        n.quantity AS qty_per_unit,
        (n.quantity * p_quantity) AS qty_needed,
        COALESCE((
          SELECT SUM(po.quantity * n2.quantity)
          FROM public.production_orders po
          JOIN public.nomenclatures n2 ON n2.coffret_id = po.coffret_id AND n2.composant_id = c.id
          WHERE po.status IN ('in_progress', 'priority')
        ), 0) AS reserved
      FROM public.nomenclatures n
      JOIN public.composants c ON c.id = n.composant_id
      WHERE n.coffret_id = p_coffret_id
    LOOP
      DECLARE
        v_dispo integer := r.stock - r.reserved;
        v_after integer := v_dispo - r.qty_needed;
      BEGIN
        IF v_after < 0 THEN
          v_missing := v_missing || jsonb_build_object(
            'reference', r.reference,
            'name', r.name,
            'available', v_dispo,
            'needed', r.qty_needed,
            'missing', ABS(v_after),
            'status', 'MISSING'
          );
        ELSIF v_after <= r.min_stock THEN
          v_low_stock := v_low_stock || jsonb_build_object(
            'reference', r.reference,
            'name', r.name,
            'available', v_dispo,
            'needed', r.qty_needed,
            'after_production', v_after,
            'min_stock', r.min_stock,
            'status', 'LOW'
          );
        ELSE
          v_ok_items := v_ok_items || jsonb_build_object(
            'reference', r.reference,
            'name', r.name,
            'available', v_dispo,
            'needed', r.qty_needed,
            'after_production', v_after,
            'status', 'OK'
          );
        END IF;
      END;
    END LOOP;
  END IF;

  v_result := jsonb_build_object(
    'ok', (v_missing = '[]'::jsonb),
    'coffret', jsonb_build_object('id', v_coffret.id, 'reference', v_coffret.reference, 'name', v_coffret.name),
    'quantity', p_quantity,
    'summary', jsonb_build_object(
      'total_ok', jsonb_array_length(v_ok_items),
      'total_low', jsonb_array_length(v_low_stock),
      'total_missing', jsonb_array_length(v_missing)
    ),
    'missing_components', v_missing,
    'low_stock_components', v_low_stock,
    'ok_components', v_ok_items
  );

  RETURN v_result;
END $$;

-- ============ 11. RLS: open_all policies pour les tables commerciales ============
-- ERP interne → no auth required, open read/write
ALTER TABLE public.bom_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bom_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "open_all" ON public.bom_versions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.bom_lines FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.orders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.order_lines FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.clients FOR ALL USING (true) WITH CHECK (true);

COMMIT;
