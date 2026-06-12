-- ============================================================
-- 1. Re-sync product_variants.weight depuis coffrets.poids_coffret
--    + trigger pour synchronisation automatique future
-- 2. Seed palette_types avec les 3 types standards utilisateur
-- ============================================================

-- ── 1. Re-sync weight (TABLE uniquement – la VIEW est toujours live) ──────
DO $$
DECLARE
  v_obj_type text;
BEGIN
  SELECT table_type INTO v_obj_type
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'product_variants';

  IF v_obj_type = 'BASE TABLE' THEN
    -- Re-sync complet depuis coffrets.poids_coffret
    UPDATE public.product_variants pv
    SET weight = COALESCE(c.poids_coffret, 0)
    FROM public.coffrets c
    WHERE pv.id = c.id;

    RAISE NOTICE 'product_variants.weight re-synced from coffrets.poids_coffret (% rows)', (
      SELECT COUNT(*) FROM public.product_variants WHERE weight > 0
    );
  ELSE
    RAISE NOTICE 'product_variants est une VIEW — weight est toujours live via poids_coffret, rien à faire.';
  END IF;
END $$;

-- ── 2. Re-sync nb_par_palette (TABLE uniquement) ─────────────────────────
DO $$
DECLARE
  v_obj_type text;
BEGIN
  SELECT table_type INTO v_obj_type
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'product_variants';

  IF v_obj_type = 'BASE TABLE' THEN
    -- Ajouter nb_par_palette si absent
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'nb_par_palette'
    ) THEN
      ALTER TABLE public.product_variants ADD COLUMN nb_par_palette integer NOT NULL DEFAULT 1;
    END IF;

    -- Re-sync depuis coffrets.nb_par_palette
    UPDATE public.product_variants pv
    SET nb_par_palette = COALESCE(c.nb_par_palette, 1)
    FROM public.coffrets c
    WHERE pv.id = c.id;
  END IF;
END $$;

-- ── 3. Trigger : synchronisation automatique quand coffrets change ────────
CREATE OR REPLACE FUNCTION public.tg_sync_pv_from_coffret()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Ne s'exécute que si product_variants est une TABLE (sinon c'est une VIEW live)
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'product_variants'
      AND table_type = 'BASE TABLE'
  ) THEN
    UPDATE public.product_variants
    SET
      weight        = COALESCE(NEW.poids_coffret, 0),
      nb_par_palette = COALESCE(NEW.nb_par_palette, 1)
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_sync_pv_from_coffret ON public.coffrets;
CREATE TRIGGER tg_sync_pv_from_coffret
  AFTER INSERT OR UPDATE OF poids_coffret, nb_par_palette ON public.coffrets
  FOR EACH ROW EXECUTE FUNCTION public.tg_sync_pv_from_coffret();

-- ── 3. Seed palette_types — types standards utilisateur ──────────────────
-- Crée la table si elle n'existe pas (idempotent)
CREATE TABLE IF NOT EXISTS public.palette_types (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  label       text        NOT NULL,
  length      numeric,
  width       numeric,
  height      numeric,
  poids_max   numeric,
  tare_weight numeric      NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.palette_types
  ADD COLUMN IF NOT EXISTS tare_weight numeric NOT NULL DEFAULT 0;

-- Insère uniquement si le label exact n'existe pas déjà
INSERT INTO public.palette_types (label, length, width, poids_max, tare_weight)
SELECT t.label, t.length, t.width, t.poids_max, t.tare_weight
FROM (VALUES
  ('Palette Europe 80x120',   120::numeric, 80::numeric, 1500::numeric, 10::numeric),
  ('Palette Standard 80x120', 120::numeric, 80::numeric, 1500::numeric,  0.7::numeric),
  ('Demi-palette 40x60',       60::numeric, 40::numeric,  750::numeric,  0.4::numeric)
) AS t(label, length, width, poids_max, tare_weight)
WHERE NOT EXISTS (
  SELECT 1 FROM public.palette_types WHERE palette_types.label = t.label
);
