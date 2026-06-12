-- FIX: product_variants ne doit pas filtrer deleted_at
-- Le filtre WHERE deleted_at IS NULL masquait des coffrets actifs dans le remote.
-- La vue expose TOUS les coffrets — le filtrage soft-delete se fait côté UI si nécessaire.

DO $$
DECLARE
  v_obj_type text;
BEGIN
  SELECT table_type INTO v_obj_type
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'product_variants';

  IF v_obj_type = 'VIEW' THEN
    EXECUTE $view$
      CREATE OR REPLACE VIEW public.product_variants AS
      SELECT
        c.id,
        c.reference,
        c.name,
        c.poids_coffret  AS weight,
        c.nb_par_palette,
        c.poids_palette,
        'coffret'::text  AS type,
        c.created_at,
        c.updated_at
      FROM public.coffrets c
    $view$;
  ELSIF v_obj_type = 'BASE TABLE' THEN
    -- TABLE : s'assurer que weight est synchronisé, rien d'autre à changer
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'weight'
    ) THEN
      EXECUTE 'ALTER TABLE public.product_variants ADD COLUMN weight numeric DEFAULT 0';
    END IF;
    EXECUTE 'UPDATE public.product_variants pv SET weight = c.poids_coffret FROM public.coffrets c WHERE pv.id = c.id';
  END IF;
END $$;
