import { supabase } from "@/integrations/supabase/client";

export type ProductionFeasibilityResult = {
  can_produce: boolean;
  summary: {
    total_missing: number;
    total_components: number;
  };
  components: Array<{
    composant_id: string;
    reference: string;
    name: string;
    needed: number;
    available: number;
    missing: number;
    status: "ok" | "missing";
  }>;
  missing: Array<{
    composant_id: string;
    reference: string;
    name: string;
    needed: number;
    available: number;
    missing: number;
  }>;
};

export type FeasibilityOptions = {
  /**
   * Exclure les réservations actives de cet OF du calcul du disponible.
   * À utiliser quand on réévalue un OF déjà créé (pending_material → relance)
   * pour éviter que l'OF se batte contre sa propre réservation.
   */
  excludeProductionOrderId?: string;
};

export async function getProductionFeasibility(
  coffretId: string,
  quantity: number,
  options: FeasibilityOptions = {}
): Promise<ProductionFeasibilityResult> {
  const { excludeProductionOrderId } = options;

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
    .eq("coffret_id", coffretId)
    .eq("is_active", true);
  if (bomError) throw bomError;

  const neededByComposant = new Map<string, number>();
  for (const line of (bomRows ?? []) as Array<{ composant_id: string; quantity: number }>) {
    const current = neededByComposant.get(line.composant_id) ?? 0;
    neededByComposant.set(line.composant_id, current + Number(line.quantity ?? 0) * qty);
  }

  const composantIds = Array.from(neededByComposant.keys());
  if (composantIds.length === 0) return empty;

  // Read stock + real-time reservations in parallel
  let reservationsQuery = sb
    .from("stock_reservations")
    .select("composant_id,quantity,production_order_id")
    .eq("status", "active")
    .in("composant_id", composantIds);

  const [composantResult, reservationsResult] = await Promise.all([
    sb.from("composants").select("id,reference,name,stock,reserved_stock").in("id", composantIds).is("deleted_at", null),
    reservationsQuery,
  ]);
  if (composantResult.error) throw composantResult.error;
  if (reservationsResult.error) throw reservationsResult.error;

  // Sum real-time reservations per composant, optionally excluding one OF's own reservations.
  // When excludeProductionOrderId is set, realtimeReserved is the sole source of truth
  // (cachedReserved cannot be filtered by order, so Math.max would re-introduce the excluded amount).
  const realtimeReserved = new Map<string, number>();
  for (const r of (reservationsResult.data ?? []) as Array<{ composant_id: string; quantity: number; production_order_id: string }>) {
    if (excludeProductionOrderId && r.production_order_id === excludeProductionOrderId) continue;
    realtimeReserved.set(r.composant_id, (realtimeReserved.get(r.composant_id) ?? 0) + Number(r.quantity ?? 0));
  }

  const byId = new Map<string, { reference: string; name: string; available: number }>(
    (composantResult.data ?? []).map((row: any) => {
      let reserved: number;
      if (excludeProductionOrderId) {
        // realtimeReserved already excludes the target OF → use it directly.
        // Math.max with cachedReserved would reintroduce the excluded reservation.
        reserved = realtimeReserved.get(row.id) ?? 0;
      } else {
        // No exclusion: stay conservative by taking the larger of cached vs realtime
        // in case the trigger cache is momentarily behind.
        const cachedReserved = Number(row.reserved_stock ?? 0);
        const realtimeRes = realtimeReserved.get(row.id) ?? 0;
        reserved = Math.max(cachedReserved, realtimeRes);
      }
      return [
        row.id,
        {
          reference: String(row.reference ?? ""),
          name: String(row.name ?? "Inconnu"),
          available: Math.max(0, Number(row.stock ?? 0) - reserved),
        },
      ];
    })
  );

  const components = composantIds.map((composantId) => {
    const needed = neededByComposant.get(composantId) ?? 0;
    const { reference = "", name = "Inconnu", available = 0 } = byId.get(composantId) ?? {};
    const missing = Math.max(0, needed - available);
    return {
      composant_id: composantId,
      reference,
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
