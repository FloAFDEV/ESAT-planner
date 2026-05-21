-- ============================================================
-- HOTFIX I : mouvement_type_v2 manque les valeurs IN/OUT/ADJUST
--
-- La colonne mouvements.type utilise mouvement_type_v2 (pas mouvement_type).
-- validate_production_order insère 'OUT' → "invalid input value for enum
-- mouvement_type_v2: OUT".
-- Migration A ciblait mouvement_type (mauvais enum).
-- ============================================================

ALTER TYPE public.mouvement_type_v2 ADD VALUE IF NOT EXISTS 'IN';
ALTER TYPE public.mouvement_type_v2 ADD VALUE IF NOT EXISTS 'OUT';
ALTER TYPE public.mouvement_type_v2 ADD VALUE IF NOT EXISTS 'ADJUST';
