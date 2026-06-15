import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, Boxes, Factory, PackageX, Truck, TrendingDown, AlertCircle, Clock } from "lucide-react";
import { fmtInt } from "@/lib/format";
import { normalizeLivraisonStatus, normalizeProductionStatus } from "@/lib/domain";
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

  const composants = useQuery({
    queryKey: ["composants"],
    refetchOnMount: "always",
    refetchInterval: 15_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from("composants")
        .select("id,stock,reserved_stock,min_stock,is_active,deleted_at")
        .is("deleted_at", null);
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const orders = useQuery({
    queryKey: ["production_orders", "dashboard"],
    refetchOnMount: "always",
    refetchInterval: 10_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from("production_orders")
        .select("id,status,priority")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as any[]).map((o) => ({
        ...o,
        status: normalizeProductionStatus(o.status),
      }));
    },
  });

  const shipments = useQuery({
    queryKey: ["shipments", "dashboard"],
    refetchOnMount: "always",
    refetchInterval: 15_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from("shipments")
        .select("id,status")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as any[]).map((s) => ({
        ...s,
        status: normalizeLivraisonStatus(s.status),
      }));
    },
  });

  // ── Stock signals ──────────────────────────────────────────────────────────
  const stockSignals = useMemo(() => {
    const list = (composants.data ?? []) as any[];
    let totalRefs = 0;
    let totalStock = 0;
    let totalReserved = 0;
    let rupture = 0;
    let critique = 0;
    for (const c of list) {
      if (!(c.is_active ?? true)) continue;
      totalRefs++;
      const stock    = Number(c.stock ?? 0);
      const reserved = Number(c.reserved_stock ?? 0);
      const dispo    = Math.max(0, stock - reserved);
      const min      = Number(c.min_stock ?? 0);
      totalStock   += stock;
      totalReserved += reserved;
      if (dispo <= 0)        rupture++;
      else if (dispo <= min) critique++;
    }
    const pctCritique = totalRefs > 0 ? Math.round(((rupture + critique) / totalRefs) * 100) : 0;
    return { totalRefs, totalStock, totalReserved, rupture, critique, pctCritique };
  }, [composants.data]);

  // ── Production signals ────────────────────────────────────────────────────
  const productionSignals = useMemo(() => {
    const list = (orders.data ?? []) as any[];
    const draft       = list.filter((o) => o.status === "draft").length;
    const inProgress  = list.filter((o) => o.status === "in_progress").length;
    const pendingMat  = list.filter((o) => o.status === "pending_material").length;
    const partial     = list.filter((o) => o.status === "partial").length;
    const urgents     = list.filter((o) => o.status === "priority").length;
    const totalActive = draft + inProgress + pendingMat + partial + urgents;
    const pctBloques  = totalActive > 0 ? Math.round((pendingMat / totalActive) * 100) : 0;
    return { draft, inProgress, pendingMat, partial, urgents, totalActive, pctBloques };
  }, [orders.data]);

  // ── Livraisons signals ────────────────────────────────────────────────────
  const livraisonSignals = useMemo(() => {
    const list = (shipments.data ?? []) as any[];
    const ready    = list.filter((s) => s.status === "ready").length;
    const shipped  = list.filter((s) => s.status === "shipped").length;
    const delivered = list.filter((s) => s.status === "delivered").length;
    return { ready, shipped, delivered };
  }, [shipments.data]);

  // ── Alertes globales ──────────────────────────────────────────────────────
  const totalAlerts = stockSignals.rupture + stockSignals.critique + productionSignals.pendingMat;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-6">
      <header className="mb-2">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Pilotage</p>
        <h1 className="text-2xl md:text-3xl font-semibold mt-0.5">{UI.dashboard}</h1>
      </header>

      {/* ── A. Alertes globales ───────────────────────────────────────────── */}
      <div className={`rounded-lg border px-4 py-3 flex flex-wrap items-center gap-4 ${
        totalAlerts > 0 ? "border-destructive/30 bg-destructive/5" : "border-border bg-muted/20"
      }`}>
        <div className="flex items-center gap-2">
          <AlertCircle className={`h-4 w-4 ${totalAlerts > 0 ? "text-destructive" : "text-muted-foreground"}`} />
          <span className={`text-sm font-semibold ${totalAlerts > 0 ? "text-destructive" : "text-muted-foreground"}`}>
            {totalAlerts > 0 ? `${totalAlerts} alerte${totalAlerts !== 1 ? "s" : ""} actives` : "Aucune alerte"}
          </span>
        </div>
        {totalAlerts > 0 && (
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {stockSignals.rupture > 0 && (
              <span className="flex items-center gap-1 text-destructive">
                <PackageX className="h-3 w-3" />
                {stockSignals.rupture} rupture{stockSignals.rupture !== 1 ? "s" : ""}
              </span>
            )}
            {stockSignals.critique > 0 && (
              <span className="flex items-center gap-1 text-warning">
                <TrendingDown className="h-3 w-3" />
                {stockSignals.critique} seuil{stockSignals.critique !== 1 ? "s" : ""} critique{stockSignals.critique !== 1 ? "s" : ""}
              </span>
            )}
            {productionSignals.pendingMat > 0 && (
              <span className="flex items-center gap-1 text-warning">
                <Clock className="h-3 w-3" />
                {productionSignals.pendingMat} OF bloqué{productionSignals.pendingMat !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── B. Fabrication ───────────────────────────────────────────────── */}
      <Section label="Fabrication" icon={<Factory className="h-3.5 w-3.5" />} to="/production" cta="Voir fabrication">
        <KPI
          icon={<Factory className="h-4 w-4 text-muted-foreground" />}
          label="OF actifs"
          value={String(productionSignals.totalActive)}
          sub={productionSignals.totalActive > 0 ? `${productionSignals.pctBloques}% bloqués` : undefined}
        />
        <KPI
          icon={<Factory className="h-4 w-4 text-muted-foreground" />}
          label="À produire"
          value={String(productionSignals.draft + productionSignals.urgents)}
          sub={productionSignals.urgents > 0 ? `dont ${productionSignals.urgents} urgent${productionSignals.urgents !== 1 ? "s" : ""}` : undefined}
          accent={productionSignals.urgents > 0 ? "destructive" : undefined}
        />
        <KPI
          icon={<Factory className="h-4 w-4 text-info" />}
          label="En cours"
          value={String(productionSignals.inProgress + productionSignals.partial)}
          sub={productionSignals.partial > 0 ? `dont ${productionSignals.partial} partiel${productionSignals.partial !== 1 ? "s" : ""}` : undefined}
        />
        <KPI
          icon={<AlertTriangle className="h-4 w-4 text-warning" />}
          label="OF bloqués"
          value={String(productionSignals.pendingMat)}
          sub="pièces manquantes"
          accent={productionSignals.pendingMat > 0 ? "warning" : undefined}
        />
      </Section>

      {/* ── C. Stock + Expéditions ────────────────────────────────────────── */}
      <div className="grid md:grid-cols-2 gap-6">
        <Section label="Stock" icon={<Boxes className="h-3.5 w-3.5" />} to="/stock" cta="Voir stock">
          <KPI
            icon={<Boxes className="h-4 w-4 text-muted-foreground" />}
            label="Références actives"
            value={String(stockSignals.totalRefs)}
            sub={`${fmtInt(stockSignals.totalStock)} pièces`}
            cols={2}
          />
          <KPI
            icon={<TrendingDown className="h-4 w-4 text-warning" />}
            label="Critiques"
            value={String(stockSignals.critique)}
            sub={stockSignals.pctCritique > 0 ? `${stockSignals.pctCritique}% du catalogue` : undefined}
            accent={stockSignals.critique > 0 ? "warning" : undefined}
          />
          <KPI
            icon={<PackageX className="h-4 w-4 text-destructive" />}
            label="Ruptures"
            value={String(stockSignals.rupture)}
            accent={stockSignals.rupture > 0 ? "destructive" : undefined}
          />
        </Section>

        <Section label="Expéditions" icon={<Truck className="h-3.5 w-3.5" />} to="/livraisons" cta="Voir expéditions">
          <KPI
            icon={<Truck className="h-4 w-4 text-info" />}
            label="À expédier"
            value={String(livraisonSignals.ready)}
            accent={livraisonSignals.ready > 0 ? "info" : undefined}
            cols={2}
          />
          <KPI
            icon={<Truck className="h-4 w-4 text-warning" />}
            label="En transit"
            value={String(livraisonSignals.shipped)}
          />
          <KPI
            icon={<Truck className="h-4 w-4 text-success" />}
            label="Livrées"
            value={String(livraisonSignals.delivered)}
          />
        </Section>
      </div>
    </div>
  );
}

// ── Composants ─────────────────────────────────────────────────────────────

type SectionProps = {
  label: string;
  icon: React.ReactNode;
  to: "/" | "/stock" | "/production" | "/livraisons";
  cta: string;
  children: React.ReactNode;
};

function Section({ label, icon, to, cta, children }: SectionProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          {icon}
          {label}
        </div>
        <Link
          to={to}
          className="inline-flex items-center rounded-md border border-input px-3 py-1 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          {cta} →
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {children}
      </div>
    </div>
  );
}

function KPI({ icon, label, value, sub, accent, cols }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  accent?: "warning" | "destructive" | "info" | "success";
  cols?: 2;
}) {
  const valueColor =
    accent === "destructive" ? "text-destructive" :
    accent === "warning"     ? "text-warning" :
    accent === "info"        ? "text-info" :
    accent === "success"     ? "text-success" : "";

  return (
    <Card className={cols === 2 ? "col-span-2" : ""}>
      <CardContent className="p-3 space-y-1">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          {icon}
          <span className="leading-tight">{label}</span>
        </div>
        <div className={`text-2xl font-semibold tabular leading-none ${valueColor}`}>
          {value}
        </div>
        {sub && (
          <div className="text-[10px] text-muted-foreground leading-none">{sub}</div>
        )}
      </CardContent>
    </Card>
  );
}
