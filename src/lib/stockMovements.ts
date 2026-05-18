import { supabase } from "@/integrations/supabase/client";

export type StockMovementType = "IN" | "OUT" | "ADJUST";

export type StockMovementInput = {
  composant_id: string;
  type: StockMovementType;
  quantity: number;
  reason?: string | null;
  source_type?: string | null;
  source_id?: string | null;
};

export async function record_stock_movement(
  input: StockMovementInput
): Promise<void> {
  if (!input.composant_id) throw new Error("composant_id requis");
  if (!Number.isFinite(input.quantity) || input.quantity <= 0)
    throw new Error("quantity doit être > 0");
  if (!["IN", "OUT", "ADJUST"].includes(input.type))
    throw new Error("type de mouvement invalide");

  const { error } = await (supabase as any).from("stock_movements").insert({
    composant_id: input.composant_id,
    type: input.type,
    quantity: Math.trunc(input.quantity),
    reason: input.reason ?? null,
    source_type: input.source_type ?? null,
    source_id: input.source_id ?? null,
  });

  if (error) throw error;
}
