-- Trigger: recalcul server-side de total_weight + total_pallets
-- Déclenché sur shipment_lines ET shipment_pallets (INSERT/UPDATE/DELETE)
-- total_weight = SUM(lignes.weight) + SUM(palettes.tare_weight)

CREATE OR REPLACE FUNCTION public.tg_sync_shipment_totals_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shipment_id uuid;
BEGIN
  v_shipment_id := COALESCE(
    CASE WHEN TG_OP = 'DELETE' THEN OLD.shipment_id ELSE NEW.shipment_id END,
    OLD.shipment_id
  );

  UPDATE public.shipments
  SET
    total_weight = (
      SELECT COALESCE(SUM(sl.weight), 0)
      FROM public.shipment_lines sl
      WHERE sl.shipment_id = v_shipment_id
    ) + (
      SELECT COALESCE(SUM(sp.tare_weight), 0)
      FROM public.shipment_pallets sp
      WHERE sp.shipment_id = v_shipment_id
    ),
    total_pallets = (
      SELECT COUNT(*)
      FROM public.shipment_pallets sp
      WHERE sp.shipment_id = v_shipment_id
    )
  WHERE id = v_shipment_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS tg_sync_shipment_totals_lines ON public.shipment_lines;
CREATE TRIGGER tg_sync_shipment_totals_lines
  AFTER INSERT OR UPDATE OR DELETE ON public.shipment_lines
  FOR EACH ROW EXECUTE FUNCTION public.tg_sync_shipment_totals_fn();

DROP TRIGGER IF EXISTS tg_sync_shipment_totals_pallets ON public.shipment_pallets;
CREATE TRIGGER tg_sync_shipment_totals_pallets
  AFTER INSERT OR UPDATE OR DELETE ON public.shipment_pallets
  FOR EACH ROW EXECUTE FUNCTION public.tg_sync_shipment_totals_fn();
