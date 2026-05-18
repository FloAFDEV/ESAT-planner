-- Ajout de la colonne reason sur stock_movements.
-- La table mouvements (origine) avait ce champ ; stock_movements (table actuelle)
-- en était dépourvue, rendant le motif saisi en UI silencieusement ignoré.
ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS reason text;
