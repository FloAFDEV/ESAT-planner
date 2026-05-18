import { supabase } from "@/integrations/supabase/client";

export type ProductionFeasibilityResult = {
  can_produce: boolean;
  summary: {
    total_missing: number;
    total_components: number;
  };
  components: Array<{
    composant_id: string;
    name: string;
    needed: number;
    available: number;
    missing: number;
    status: "ok" | "missing";
  }>;
  missing: Array<{
    composant_id: string;
    name: string;
    needed: number;
    available: number;
    missing: number;
  }>;
};

export async function getProductionFeasibility(
  coffretId: string,
  quantity: number
): Promise<ProductionFeasibilityResult> {
  const empty: ProductionFeasibilityResult = {
    can_produce: false,
    summary: { total_missing: 0, total_components: 0 },
    components: [],
    missing: [],
  };

  if (!coffretId) return empty;

  const qty = Math.trunc(Number(quantity));
  if (!Number.isFinite(qty) || qty <= 0) return empty;

  const sb = supabase as any;

  // Read BOM from nomenclatures (source of truth)
  const { data: bomRows, error: bomError } = await sb
    .from("nomenclatures")
    .select("composant_id,quantity")
    .eq("coffret_id", coffretId);
  if (bomError) throw bomError;

  const neededByComposant = new Map<string, number>();
  for (const line of (bomRows ?? []) as Array<{ composant_id: string; quantity: number }>) {
    const current = neededByComposant.get(line.composant_id) ?? 0;
    neededByComposant.set(line.composant_id, current + Number(line.quantity ?? 0) * qty);
  }

  const composantIds = Array.from(neededByComposant.keys());
  if (composantIds.length === 0) return empty;

  // Read stock directly from composants (stock − reserved_stock = disponible)
  const { data: composantRows, error: composantError } = await sb
    .from("composants")
    .select("id,name,stock,reserved_stock")
    .in("id", composantIds);
  if (composantError) throw composantError;

  const byId = new Map<string, { name: string; available: number }>(
    (composantRows ?? []).map((row: any) => [
      row.id,
      {
        name: String(row.name ?? "Inconnu"),
        available: Math.max(0, Number(row.stock ?? 0) - Number(row.reserved_stock ?? 0)),
      },
    ])
  );

  const components = composantIds.map((composantId) => {
    const needed = neededByComposant.get(composantId) ?? 0;
    const { name = "Inconnu", available = 0 } = byId.get(composantId) ?? {};
    const missing = Math.max(0, needed - available);
    return {
      composant_id: composantId,
      name,
      needed,
      available,
      missing,
      status: missing > 0 ? "missing" : "ok",
    } as const;
  });

  const missing = components.filter((c) => c.missing > 0).map(({ status: _s, ...c }) => c);

  return {
    can_produce: missing.length === 0,
    summary: {
      total_missing: missing.reduce((s, c) => s + c.missing, 0),
      total_components: components.length,
    },
    components,
    missing,
  };
}
