-- ============================================================
-- MIGRATION: Correction nomenclatures.coffret_id CASCADE → RESTRICT
--
-- Problème: la migration initiale créait la FK avec ON DELETE CASCADE,
-- ce qui permettrait de détruire les nomenclatures en supprimant un coffret.
-- Avec le soft delete coffrets (deleted_at), ce n'est jamais voulu.
--
-- Règle finale (non négociable):
--   nomenclatures.coffret_id → coffrets(id) ON DELETE RESTRICT
--   nomenclatures.composant_id → composants(id) ON DELETE RESTRICT (déjà correct)
-- ============================================================

ALTER TABLE public.nomenclatures
  DROP CONSTRAINT IF EXISTS nomenclatures_coffret_id_fkey;

ALTER TABLE public.nomenclatures
  ADD CONSTRAINT nomenclatures_coffret_id_fkey
  FOREIGN KEY (coffret_id)
  REFERENCES public.coffrets(id)
  ON DELETE RESTRICT;
