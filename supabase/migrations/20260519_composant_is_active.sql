-- Ajoute is_active sur composants.
-- Utilisé par le dashboard et stock pour exclure les composants désactivés des alertes.
-- Distinct de deleted_at (archivage permanent): is_active = désactivation temporaire sans suppression.

ALTER TABLE public.composants
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_composants_is_active
  ON public.composants(is_active)
  WHERE is_active = false;
