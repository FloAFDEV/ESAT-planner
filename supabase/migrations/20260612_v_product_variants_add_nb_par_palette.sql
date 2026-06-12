-- product_variants TABLE : ajouter nb_par_palette depuis coffrets (les IDs correspondent)
ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS nb_par_palette integer NOT NULL DEFAULT 1;

UPDATE public.product_variants pv
SET nb_par_palette = c.nb_par_palette
FROM public.coffrets c
WHERE pv.id = c.id;
