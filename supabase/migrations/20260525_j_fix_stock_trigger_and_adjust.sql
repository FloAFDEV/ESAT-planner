-- ============================================================
-- HOTFIX J : trigger apply_mouvement + sémantique ADJUST
--
-- Problèmes corrigés :
--   1. Le trigger apply_mouvement sur mouvements n'existe peut-être
--      pas si la migration 20260422051408 a été partielle.
--      → DROP IF EXISTS + CREATE pour garantir sa présence.
--
--   2. ADJUST = incrément (même comportement qu'IN) → incorrect.
--      L'ajustement inventaire doit SET le stock à la valeur absolue.
--      Exemple : stock actuel = 80, ADJUST 50 → stock devient 50
--      (pas 130).
--
--   3. Protection : stock ne peut pas devenir négatif via OUT.
--      → GREATEST(0, stock - quantity)
-- ============================================================

-- 1. Recréer la fonction trigger avec la sémantique correcte
CREATE OR REPLACE FUNCTION public.tg_apply_mouvement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  CASE NEW.type::text
    WHEN 'IN' THEN
      UPDATE public.composants
      SET stock = stock + NEW.quantity,
          updated_at = now()
      WHERE id = NEW.composant_id;

    WHEN 'OUT' THEN
      UPDATE public.composants
      SET stock = GREATEST(0, stock - NEW.quantity),
          updated_at = now()
      WHERE id = NEW.composant_id;

    WHEN 'ADJUST' THEN
      -- L'ajustement inventaire fixe le stock à la valeur absolue saisie
      UPDATE public.composants
      SET stock = NEW.quantity,
          updated_at = now()
      WHERE id = NEW.composant_id;

    ELSE
      -- Type inconnu : ne rien faire (ne pas bloquer l'INSERT)
      NULL;
  END CASE;

  RETURN NEW;
END $$;

-- 2. Garantir que le trigger existe sur mouvements
--    (DROP IF EXISTS pour éviter "trigger already exists")
DROP TRIGGER IF EXISTS apply_mouvement ON public.mouvements;

CREATE TRIGGER apply_mouvement
  AFTER INSERT ON public.mouvements
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_apply_mouvement();
