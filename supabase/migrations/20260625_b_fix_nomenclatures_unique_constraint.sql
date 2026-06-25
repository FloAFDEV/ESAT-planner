-- ============================================================
-- Fix : contrainte UNIQUE nomenclatures + nettoyage orphelins
--
-- Problème : UNIQUE(coffret_id, composant_id) couvre TOUTES les lignes
--            y compris is_active = false → bloque la réinsertion d'un
--            composant après suppression si une ligne morte subsiste.
--
-- Solution :
--   1. Supprimer les lignes is_active = false orphelines
--   2. Remplacer la contrainte UNIQUE globale par un index partiel
--      WHERE is_active = true → seules les lignes actives sont uniques
-- ============================================================

BEGIN;

-- ── 1. Nettoyage des lignes mortes ──────────────────────────────────────────

DELETE FROM public.nomenclatures WHERE is_active = false;

-- ── 2. Remplacement de la contrainte UNIQUE ─────────────────────────────────

-- Supprimer la contrainte globale (bloque même sur les lignes inactives)
ALTER TABLE public.nomenclatures
  DROP CONSTRAINT IF EXISTS nomenclatures_coffret_id_composant_id_key;

-- Créer un index UNIQUE partiel : unicité uniquement sur les lignes actives
-- Un composant supprimé (is_active = false) ne bloque plus la réinsertion
CREATE UNIQUE INDEX IF NOT EXISTS nomenclatures_active_unique
  ON public.nomenclatures(coffret_id, composant_id)
  WHERE is_active = true;

COMMIT;
