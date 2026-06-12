ALTER TABLE public.shipment_pallets
  ADD COLUMN IF NOT EXISTS tare_weight numeric NOT NULL DEFAULT 0;
