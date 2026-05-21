-- ============================================================
-- EXTENSIONS D'ENUMS
-- Doit être appliquée en premier (les valeurs sont utilisées
-- dans les migrations suivantes).
-- ============================================================

-- 1. Type 'ADJUST' pour inventaire/correction stock
ALTER TYPE public.mouvement_type ADD VALUE IF NOT EXISTS 'ADJUST';

-- 2. Statuts production étendus
--    'partial'  : OF partiellement validé (produit_qty < quantity)
--    'canceled' : annulation (remplace 'annule' legacy en canonical)
ALTER TYPE public.production_status ADD VALUE IF NOT EXISTS 'partial';
ALTER TYPE public.production_status ADD VALUE IF NOT EXISTS 'canceled';
