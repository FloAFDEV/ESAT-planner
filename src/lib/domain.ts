export type ProductionStatus =
  | "draft"
  | "in_progress"
  | "done"
  | "priority";

export type ProductionPriority = 0 | 1;

export type LivraisonStatus =
  | "draft"
  | "ready"
  | "shipped"
  | "delivered";

export type ShipmentStatus = LivraisonStatus;

export const productionStatusMeta: Record<string, { label: string; cls: string }> = {
  draft: { label: "À produire", cls: "bg-muted text-muted-foreground" },
  in_progress: { label: "En cours", cls: "bg-info/15 text-info border border-info/30" },
  done: { label: "Terminé", cls: "bg-success/15 text-success border border-success/30" },
  priority: { label: "Urgent", cls: "bg-destructive/15 text-destructive border border-destructive/30" },
};

export const productionPriorityMeta: Record<ProductionPriority, { label: string; cls: string }> = {
  0: { label: "Normal", cls: "bg-muted text-muted-foreground border border-border" },
  1: { label: "Urgent", cls: "bg-destructive/15 text-destructive border border-destructive/30" },
};

export const livraisonStatusMeta: Record<string, { label: string; cls: string }> = {
  draft: { label: "À expédier", cls: "bg-muted text-muted-foreground" },
  ready: { label: "Prêt", cls: "bg-info/15 text-info border border-info/30" },
  shipped: { label: "Expédié", cls: "bg-warning/15 text-warning border border-warning/30" },
  delivered: { label: "Livré", cls: "bg-success/15 text-success border border-success/30" },
};

export const shipmentStatusMeta: Record<string, { label: string; cls: string }> = {
  draft: { label: "À expédier", cls: "bg-muted text-muted-foreground" },
  ready: { label: "Prêt", cls: "bg-info/15 text-info border border-info/30" },
  shipped: { label: "Expédié", cls: "bg-warning/15 text-warning border border-warning/30" },
  delivered: { label: "Livré", cls: "bg-success/15 text-success border border-success/30" },
};


export function normalizeProductionStatus(status?: string | null): ProductionStatus {
  const value = String(status ?? "draft");
  // Source unique : UNIQUEMENT canoniques en production_orders
  // Les statuts legacy ne doivent jamais être stockés
  if (value === "draft" || value === "in_progress" || value === "done" || value === "priority") {
    return value;
  }
  // Fallback strict : default à draft si donnée inattendue
  return "draft";
}

export function normalizeLivraisonStatus(status?: string | null): LivraisonStatus {
  const value = String(status ?? "draft");
  // Source unique : UNIQUEMENT canoniques en shipments
  if (value === "draft" || value === "ready" || value === "shipped" || value === "delivered") {
    return value;
  }
  // Fallback strict : default à draft si donnée inattendue
  return "draft";
}

export type StockHealth = "ok" | "critical" | "rupture";

export const stockHealthMeta: Record<StockHealth, { label: string; cls: string }> = {
  ok: { label: "OK", cls: "bg-success/15 text-success border border-success/30" },
  critical: { label: "CRITIQUE", cls: "bg-warning/15 text-warning border border-warning/30" },
  rupture: { label: "RUPTURE", cls: "bg-destructive/15 text-destructive border border-destructive/30" },
};

export function getStockHealth(stock: number, minStock: number): StockHealth {
  if (stock <= 0) return "rupture";
  if (stock <= minStock) return "critical";
  return "ok";
}

export function formatClientAddress(client: {
  address?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country?: string | null;
}) {
  const line1 = (client.address ?? "").trim();
  const line2 = [client.postal_code, client.city].filter(Boolean).join(" ").trim();
  const line3 = (client.country ?? "").trim();
  return [line1, line2, line3].filter(Boolean).join("\n");
}
