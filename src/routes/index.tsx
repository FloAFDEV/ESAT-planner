import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Boxes, Factory, Flame, PackageX, TrendingDown, Truck } from "lucide-react";
import { fmtInt } from "@/lib/format";
import { normalizeLivraisonStatus, normalizeProductionStatus, productionStatusMeta } from "@/lib/domain";
import { UI } from "@/lib/uiLabels";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard — Coffret ERP" },
      { name: "description", content: "Vue d'ensemble du stock, des alertes et de la production en cours." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const sb = supabase as any;

  const downloadTextFile = (filename: string, content: string, mime = "text/plain;charset=utf-8") => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toCsv = (rows: Array<Record<string, unknown>>) => {
    if (rows.length === 0) return "";
    const headers = Object.keys(rows[0]);
    const escape = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [headers.join(";")];
    for (const row of rows) {
      lines.push(headers.map((h) => escape(row[h])).join(";"));
    }
    return lines.join("\n");
  };

  const composants = useQuery({
    queryKey: ["composants"],
    refetchInterval: 15000,
    queryFn: async () => {
      const { data, error } = await sb
        .from("composants")
        .select("id,reference,name,stock,reserved_stock,min_stock,is_active")
        .is("deleted_at", null)
        .order("reference");
      if (error) throw error;
      return data;
    },
  });

  const componentIds = useMemo(() => ((composants.data ?? []) as any[]).map((c) => c.id), [composants.data]);

  const orders = useQuery({
    queryKey: ["production_orders", "active"],
    refetchInterval: 10000,
    queryFn: async () => {
      const { data: ordersData, error } = await sb
        .from("production_orders")
        .select("*")
        .order("status", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw error;

      const activeOrders = ((ordersData ?? []) as any[])
        .map((o) => ({ ...o, status: normalizeProductionStatus(o.status) }))
        .filter((o) => ["draft", "priority", "in_progress", "partial"].includes(String(o.status)));

      const coffretIds = Array.from(new Set(activeOrders.map((o) => o.coffret_id).filter(Boolean)));
      let coffretMap = new Map<string, any>();
      if (coffretIds.length > 0) {
        const { data: coffretsData, error: coffretsError } = await sb
          .from("coffrets")
          .select("id,reference,name")
          .in("id", coffretIds);
        if (coffretsError) throw coffretsError;
        coffretMap = new Map((coffretsData ?? []).map((c: any) => [c.id, c]));
      }

      return activeOrders.map((o) => ({
        ...o,
        coffret: coffretMap.get(o.coffret_id) ?? null,
      }));
    },
  });

  const commercialOrders = useQuery({
    queryKey: ["orders", "open"],
    refetchInterval: 15000,
    queryFn: async () => {
      const { data: ordersData, error } = await sb
        .from("orders")
        .select("id, reference, status, created_at, client_id")
        .order("created_at", { ascending: false });
      if (error) throw error;

      const orderIds = ((ordersData ?? []) as any[]).map((o) => o.id);
      const clientIds = Array.from(new Set(((ordersData ?? []) as any[]).map((o) => o.client_id).filter(Boolean)));

      let clientMap = new Map<string, any>();
      if (clientIds.length > 0) {
        const { data: clientsData, error: clientsError } = await sb
          .from("clients")
          .select("id,name")
          .in("id", clientIds);
        if (clientsError) throw clientsError;
        clientMap = new Map((clientsData ?? []).map((c: any) => [c.id, c]));
      }

      let linesByOrder = new Map<string, any[]>();
      if (orderIds.length > 0) {
        const { data: linesData, error: linesError } = await sb
          .from("order_lines")
          .select("id,order_id,quantity,product_variant_id")
          .in("order_id", orderIds);
        if (linesError) throw linesError;
        for (const line of (linesData ?? []) as any[]) {
          const current = linesByOrder.get(line.order_id) ?? [];
          current.push(line);
          linesByOrder.set(line.order_id, current);
        }
      }

      return ((ordersData ?? []) as any[]).map((o) => ({
        ...o,
        client: clientMap.get(o.client_id) ?? null,
        lines: linesByOrder.get(o.id) ?? [],
      }));
    },
  });

  const activeBoms = useQuery({
    queryKey: ["coffret_components", "active"],
    refetchInterval: 30000,
    queryFn: async () => {
      const { data, error } = await sb
        .from("coffret_components")
        .select("coffret_id,composant_id,quantity");
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const shipments = useQuery({
    queryKey: ["shipments", "ready"],
    refetchInterval: 10000,
    queryFn: async () => {
      const { data, error } = await sb
        .from("shipments")
        .select("id,reference,status,client_id,created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as any[]).map((row) => ({ ...row, status: normalizeLivraisonStatus(row.status) }));
    },
  });

  const composantsWithStock = ((composants.data ?? []) as any[]).map((c: any) => {
    const stockBrut = Number(c.stock ?? 0);
    const stock = Math.max(0, stockBrut - Number(c.reserved_stock ?? 0));
    return { ...c, stockBrut, stock };
  });

  const totalStock = composantsWithStock.reduce((s: number, c: any) => s + Number(c.stockBrut ?? 0), 0);
  const totalReserve = composantsWithStock.reduce((s: number, c: any) => s + Math.max(0, Number(c.stockBrut ?? 0) - Number(c.stock ?? 0)), 0);
  const totalDisponible = composantsWithStock.reduce((s: number, c: any) => s + Number(c.stock ?? 0), 0);
  const alertes = composantsWithStock.filter((c: any) => (c.is_active ?? true) && Number(c.stock ?? 0) <= Number(c.min_stock ?? 0));
  const ruptureCount = composantsWithStock.filter((c: any) => (c.is_active ?? true) && Number(c.stock ?? 0) <= 0).length;
  const critiqueCount = composantsWithStock.filter((c: any) => (c.is_active ?? true) && Number(c.stock ?? 0) > 0 && Number(c.stock ?? 0) <= Number(c.min_stock ?? 0)).length;
  const ordersList: any[] = (orders.data ?? []) as any[];
  const enCours = ordersList.filter((o) => String(o.status) === "in_progress");
  const prioritaires = ordersList.filter((o) => String(o.status) === "priority" || Number(o.priority ?? 0) === 1);
  const ordresDone = ordersList.filter((o) => String(o.status) === "done");
  const shipmentsReady = ((shipments.data ?? []) as any[]).filter((s) => String(s.status ?? "") === "ready");
  const shipmentsInProgress = ((shipments.data ?? []) as any[]).filter((s) => String(s.status ?? "") === "shipped");
  const shipmentsDelivered = ((shipments.data ?? []) as any[]).filter((s) => String(s.status ?? "") === "delivered");
  const openCommercialOrders = ((commercialOrders.data ?? []) as any[]).filter((o) => !["done", "delivered", "canceled", "cancelled"].includes(String(o.status ?? "")));

  const componentDemandByOrder = new Map<string, number>();
  const bomByCoffret = new Map<string, any[]>();
  for (const line of (activeBoms.data ?? []) as any[]) {
    const current = bomByCoffret.get(line.coffret_id) ?? [];
    current.push(line);
    bomByCoffret.set(line.coffret_id, current);
  }

  for (const order of openCommercialOrders) {
    for (const line of (order.lines ?? []) as any[]) {
      const bom = bomByCoffret.get(line.product_variant_id);
      if (!bom) continue;
      for (const bomLine of bom) {
        const current = componentDemandByOrder.get(bomLine.composant_id) ?? 0;
        componentDemandByOrder.set(
          bomLine.composant_id,
          current + Number(bomLine.quantity ?? 0) * Number(line.quantity ?? 0)
        );
      }
    }
  }

  const projectedRuptures = composantsWithStock
    .map((c) => {
      const demand = componentDemandByOrder.get(c.id) ?? 0;
      const dispo = Number(c.stock ?? 0);
      const projected = dispo - demand;
      return { ...c, demand, dispo, projected };
    })
    .filter((c) => c.projected < 0)
    .sort((a, b) => a.projected - b.projected);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <header className="mb-4 md:mb-5">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Vue d'ensemble</p>
        <h1 className="text-2xl md:text-3xl font-semibold mt-1">{UI.dashboard}</h1>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link to="/production" className="inline-flex items-center rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground">Lancer production</Link>
          <Link to="/stock" className="inline-flex items-center rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground">Corriger stock</Link>
          <Link to="/livraisons" className="inline-flex items-center rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground">Expédier</Link>
          <a href="#exports-centre" className="inline-flex items-center rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground">Centre exports</a>
        </div>
      </header>

      <div className="space-y-2 mb-4">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Stock</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
          <KPI icon={<Boxes className="h-4 w-4" />} label="Stock total (pièces)" value={fmtInt(totalStock)} to="/stock" cta="Voir stock" />
          <KPI icon={<Boxes className="h-4 w-4 text-success" />} label="Stock disponible" value={fmtInt(totalDisponible)} to="/stock" cta="Sortie" />
          <KPI icon={<TrendingDown className="h-4 w-4 text-warning" />} label="Critique (seuil min)" value={String(critiqueCount)} accent={critiqueCount > 0 ? "warning" : undefined} to="/stock" cta="Corriger" />
          <KPI icon={<PackageX className="h-4 w-4 text-destructive" />} label="Rupture" value={String(ruptureCount)} accent={ruptureCount > 0 ? "destructive" : undefined} to="/stock" cta="Corriger" />
        </div>
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground pt-1">Fabrication</p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 md:gap-3">
          <KPI icon={<Factory className="h-4 w-4 text-info" />} label="OF en cours" value={String(enCours.length)} to="/production" cta="Reprendre" />
          <KPI icon={<Flame className="h-4 w-4 text-destructive" />} label="OF urgents" value={String(prioritaires.length)} accent={prioritaires.length > 0 ? "destructive" : undefined} to="/production" cta="Traiter" />
          <KPI icon={<Factory className="h-4 w-4 text-success" />} label="OF terminés" value={String(ordresDone.length)} to="/production" cta="Voir" />
        </div>
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground pt-1">Livraisons</p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 md:gap-3">
          <KPI icon={<Truck className="h-4 w-4 text-info" />} label="Prêtes à expédier" value={String(shipmentsReady.length)} to="/livraisons" cta="Expédier" />
          <KPI icon={<Truck className="h-4 w-4 text-warning" />} label="En cours d'expédition" value={String(shipmentsInProgress.length)} to="/livraisons" cta="Suivre" />
          <KPI icon={<Truck className="h-4 w-4 text-success" />} label="Livrées" value={String(shipmentsDelivered.length)} to="/livraisons" cta="Voir" />
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-3 mb-4">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">Commandes clients ouvertes</CardTitle>
            <Badge variant="outline">{openCommercialOrders.length}</Badge>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {openCommercialOrders.length === 0 ? (
              <div className="py-6 text-center space-y-2">
                <p>Aucune donnée disponible.</p>
                <Link to="/production" className="inline-flex items-center rounded-sm border border-input px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground">Créer fabrication</Link>
              </div>
            ) : (
              (openCommercialOrders.slice(0, 3) as any[]).map((o) => (
                <div key={o.id} className="py-1.5 flex items-center justify-between gap-2">
                  <span className="font-mono text-xs">{o.reference ?? o.id.slice(0, 8)}</span>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate">{o.client?.name ?? "Données manquantes"}</span>
                    <Link to="/production" className="inline-flex items-center rounded-sm border border-input px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground">Produire</Link>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" /> Rupture previsionnelle (BOM x commandes)
            </CardTitle>
            <Badge variant="outline">{projectedRuptures.length}</Badge>
          </CardHeader>
          <CardContent>
            {projectedRuptures.length === 0 ? (
              <div className="py-6 text-center space-y-2 text-sm text-muted-foreground">
                <p>Aucune donnée disponible.</p>
                <Link to="/stock" className="inline-flex items-center rounded-sm border border-input px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground">Voir stock</Link>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {projectedRuptures.slice(0, 6).map((c) => (
                  <li key={c.id} className="py-2.5 flex items-center justify-between text-sm">
                    <div>
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground font-mono">{c.reference}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-xs text-muted-foreground">besoin {fmtInt(c.demand)} / dispo {fmtInt(c.dispo)}</div>
                      <div className="font-mono font-semibold text-destructive">manque {fmtInt(Math.abs(c.projected))}</div>
                    </div>
                    <Link to="/stock" className="inline-flex items-center rounded-sm border border-input px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground">Corriger</Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-3 md:gap-4">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" /> Alertes stock bas
            </CardTitle>
            <Badge variant="outline">{alertes.length}</Badge>
          </CardHeader>
          <CardContent>
            {alertes.length === 0 ? (
              <div className="py-6 text-center space-y-2 text-sm text-muted-foreground">
                <p>Aucune donnée disponible.</p>
                <Link to="/stock" className="inline-flex items-center rounded-sm border border-input px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground">Corriger stock</Link>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {alertes.map((c: any) => {
                  const row = composantsWithStock.find((row: any) => row.id === c.id) ?? {};
                  const dispo = Number(row.stock ?? 0);
                  const minStock = Number(row.min_stock ?? 0);
                  return (
                  <li key={c.id} className="py-2.5 flex items-center justify-between text-sm gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground font-mono">{c.reference}</div>
                    </div>
                    <div className="flex-shrink-0 text-right">
                      <div className="font-mono font-semibold text-destructive">{fmtInt(dispo)}</div>
                      <div className="text-[11px] text-muted-foreground">min. {fmtInt(minStock)}</div>
                    </div>
                    <Link to="/stock" className="inline-flex items-center rounded-sm border border-input px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground">Corriger</Link>
                  </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Factory className="h-4 w-4 text-info" /> Ordres de fabrication actifs
            </CardTitle>
            <Badge variant="outline">{ordersList.length}</Badge>
          </CardHeader>
          <CardContent>
            {ordersList.length === 0 ? (
              <div className="py-6 text-center space-y-2 text-sm text-muted-foreground">
                <p>Aucune donnée disponible.</p>
                <Link to="/production" className="inline-flex items-center rounded-sm border border-input px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground">Créer fabrication</Link>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {ordersList.map((o) => (
                  <li key={o.id} className="py-2.5 flex items-center justify-between text-sm gap-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{o.coffret?.name}</div>
                      <div className="text-xs text-muted-foreground font-mono">{o.reference}</div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm">×{fmtInt(o.quantity)}</span>
                      <StatusBadge status={o.status} />
                      <Link to="/production" className="inline-flex items-center rounded-sm border border-input px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground">Reprendre</Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card id="exports-centre" className="mt-4">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Centre exports</CardTitle>
          <Badge variant="outline">Point d'accès unique</Badge>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <button
            className="inline-flex items-center rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => downloadTextFile("atelier-export.csv", toCsv((composants.data ?? []) as any[]), "text/csv;charset=utf-8")}
          >
            Export CSV
          </button>
          <button
            className="inline-flex items-center rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => downloadTextFile("atelier-export.pdf", JSON.stringify({ stocks: composants.data ?? [], production: orders.data ?? [], shipments: shipments.data ?? [] }, null, 2), "application/pdf")}
          >
            Export PDF
          </button>
          <button
            className="inline-flex items-center rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => downloadTextFile("atelier-export.xls", toCsv((composants.data ?? []) as any[]), "application/vnd.ms-excel")}
          >
            Export Excel
          </button>
          <button
            className="inline-flex items-center rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => downloadTextFile("atelier-export-comptable.csv", toCsv((shipments.data ?? []) as any[]), "text/csv;charset=utf-8")}
          >
            Export comptable
          </button>
        </CardContent>
      </Card>
    </div>
  );
}

function KPI({ icon, label, value, accent, to, cta }: { icon: React.ReactNode; label: string; value: string; accent?: "warning" | "destructive"; to?: "/" | "/stock" | "/production" | "/livraisons"; cta?: string }) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-3">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          {icon}
          <span>{label}</span>
        </div>
        <div className={"mt-1.5 text-xl md:text-2xl font-semibold tabular " + (accent === "destructive" ? "text-destructive" : accent === "warning" ? "text-warning" : "")}>
          {value}
        </div>
        {to && cta && (
          <Link to={to} className="mt-2 inline-flex items-center rounded-sm border border-input px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground">
            {cta}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const m = productionStatusMeta[status] ?? { label: "Statut inconnu", cls: "bg-muted text-muted-foreground" };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${m.cls}`}>{m.label}</span>;
}
