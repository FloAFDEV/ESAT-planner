
-- ============ TABLES ============

CREATE TABLE public.composants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  name text NOT NULL,
  stock integer NOT NULL DEFAULT 0,
  min_stock integer NOT NULL DEFAULT 0,
  poids_unitaire numeric(10,3) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.coffrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  name text NOT NULL,
  poids_coffret numeric(10,3) NOT NULL DEFAULT 0,
  nb_par_palette integer NOT NULL DEFAULT 1,
  poids_palette numeric(10,3) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.nomenclatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coffret_id uuid NOT NULL REFERENCES public.coffrets(id) ON DELETE CASCADE,
  composant_id uuid NOT NULL REFERENCES public.composants(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(coffret_id, composant_id)
);

CREATE TYPE public.mouvement_type AS ENUM ('IN', 'OUT');

CREATE TABLE public.mouvements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  composant_id uuid NOT NULL REFERENCES public.composants(id) ON DELETE RESTRICT,
  type public.mouvement_type NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  reason text,
  production_order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE public.production_status AS ENUM ('draft', 'in_progress', 'done', 'priority');

CREATE TABLE public.production_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE DEFAULT ('OF-' || to_char(now(), 'YYMMDD-HH24MISS')),
  coffret_id uuid NOT NULL REFERENCES public.coffrets(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  status public.production_status NOT NULL DEFAULT 'draft',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz
);

CREATE TABLE public.livraisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE DEFAULT ('BL-' || to_char(now(), 'YYMMDD-HH24MISS')),
  client text NOT NULL,
  adresse text NOT NULL,
  date date NOT NULL DEFAULT CURRENT_DATE,
  signature text,
  total_palette numeric(10,2) NOT NULL DEFAULT 0,
  total_poids numeric(10,3) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.livraison_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  livraison_id uuid NOT NULL REFERENCES public.livraisons(id) ON DELETE CASCADE,
  coffret_id uuid NOT NULL REFERENCES public.coffrets(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  palettes numeric(10,2) NOT NULL DEFAULT 0,
  poids numeric(10,3) NOT NULL DEFAULT 0
);

-- ============ INDEX ============
CREATE INDEX idx_nomenclatures_coffret ON public.nomenclatures(coffret_id);
CREATE INDEX idx_nomenclatures_composant ON public.nomenclatures(composant_id);
CREATE INDEX idx_mouvements_composant ON public.mouvements(composant_id);
CREATE INDEX idx_mouvements_created ON public.mouvements(created_at DESC);
CREATE INDEX idx_orders_status ON public.production_orders(status);
CREATE INDEX idx_livraison_items_livraison ON public.livraison_items(livraison_id);

-- ============ TRIGGERS updated_at ============
CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER set_updated_at_composants BEFORE UPDATE ON public.composants
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER set_updated_at_coffrets BEFORE UPDATE ON public.coffrets
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER set_updated_at_orders BEFORE UPDATE ON public.production_orders
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- ============ TRIGGER: stock auto via mouvements ============
CREATE OR REPLACE FUNCTION public.tg_apply_mouvement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.type = 'IN' THEN
    UPDATE public.composants SET stock = stock + NEW.quantity WHERE id = NEW.composant_id;
  ELSE
    UPDATE public.composants SET stock = stock - NEW.quantity WHERE id = NEW.composant_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER apply_mouvement AFTER INSERT ON public.mouvements
  FOR EACH ROW EXECUTE FUNCTION public.tg_apply_mouvement();

-- ============ RPC: simulate_production ============
CREATE OR REPLACE FUNCTION public.simulate_production(p_coffret_id uuid, p_quantity integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_coffret public.coffrets%ROWTYPE;
  v_missing jsonb := '[]'::jsonb;
  v_remaining jsonb := '[]'::jsonb;
  v_fabricable boolean := true;
  v_palettes numeric;
  v_poids numeric;
  r record;
  -- Stock dispo = stock - réservations des ordres in_progress/priority (sauf l'OF courant pour edge cases)
BEGIN
  SELECT * INTO v_coffret FROM public.coffrets WHERE id = p_coffret_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'coffret not found');
  END IF;

  FOR r IN
    SELECT
      c.id, c.reference, c.name, c.stock,
      n.quantity AS per_unit,
      (n.quantity * p_quantity) AS needed,
      COALESCE((
        SELECT SUM(po.quantity * n2.quantity)
        FROM public.production_orders po
        JOIN public.nomenclatures n2 ON n2.coffret_id = po.coffret_id AND n2.composant_id = c.id
        WHERE po.status IN ('in_progress','priority')
      ), 0) AS reserved
    FROM public.nomenclatures n
    JOIN public.composants c ON c.id = n.composant_id
    WHERE n.coffret_id = p_coffret_id
  LOOP
    DECLARE
      v_dispo integer := r.stock - r.reserved;
      v_after integer := v_dispo - r.needed;
    BEGIN
      IF v_after < 0 THEN
        v_fabricable := false;
        v_missing := v_missing || jsonb_build_object(
          'composant_id', r.id, 'reference', r.reference, 'name', r.name,
          'needed', r.needed, 'available', v_dispo, 'manquant', -v_after
        );
      END IF;
      v_remaining := v_remaining || jsonb_build_object(
        'composant_id', r.id, 'reference', r.reference, 'name', r.name,
        'stock_actuel', r.stock, 'reserve', r.reserved, 'apres_production', v_after
      );
    END;
  END LOOP;

  v_palettes := CEIL(p_quantity::numeric / GREATEST(v_coffret.nb_par_palette, 1));
  v_poids := p_quantity * v_coffret.poids_coffret;

  RETURN jsonb_build_object(
    'fabricable', v_fabricable,
    'coffret', jsonb_build_object('id', v_coffret.id, 'reference', v_coffret.reference, 'name', v_coffret.name),
    'quantity', p_quantity,
    'composants_manquants', v_missing,
    'stock_restant', v_remaining,
    'palettes', v_palettes,
    'poids_total', v_poids
  );
END $$;

-- ============ RPC: validate_production_order ============
CREATE OR REPLACE FUNCTION public.validate_production_order(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.production_orders%ROWTYPE;
  v_sim jsonb;
  r record;
BEGIN
  SELECT * INTO v_order FROM public.production_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'order not found'); END IF;
  IF v_order.status = 'done' THEN RETURN jsonb_build_object('success', false, 'error', 'already done'); END IF;

  v_sim := public.simulate_production(v_order.coffret_id, v_order.quantity);
  IF NOT (v_sim->>'fabricable')::boolean THEN
    RETURN jsonb_build_object('success', false, 'error', 'composants insuffisants', 'simulation', v_sim);
  END IF;

  -- Décrémenter via mouvements OUT
  FOR r IN
    SELECT n.composant_id, (n.quantity * v_order.quantity) AS qty
    FROM public.nomenclatures n WHERE n.coffret_id = v_order.coffret_id
  LOOP
    INSERT INTO public.mouvements(composant_id, type, quantity, reason, production_order_id)
    VALUES (r.composant_id, 'OUT', r.qty, 'Production ' || v_order.reference, v_order.id);
  END LOOP;

  UPDATE public.production_orders
  SET status = 'done', done_at = now()
  WHERE id = v_order.id;

  RETURN jsonb_build_object('success', true, 'order_id', v_order.id);
END $$;

-- ============ RLS (lecture/écriture publique anon — pas d'auth pour cet ERP interne) ============
ALTER TABLE public.composants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coffrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nomenclatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mouvements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.livraisons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.livraison_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "open_all" ON public.composants FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.coffrets FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.nomenclatures FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.mouvements FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.production_orders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.livraisons FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.livraison_items FOR ALL USING (true) WITH CHECK (true);
