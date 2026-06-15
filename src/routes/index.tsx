import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, Boxes, Factory, PackageX, Truck, TrendingDown } from "lucide-react";
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
    queryKey: ["production_orders", "active"],
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
    queryKey: ["shipments", "active"],
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

  // ── Stock signals ──────────────────────────────────────────────────────
  const stockSignals = useMemo(() => {
    const list = (composants.data ?? []) as any[];
    let totalStock = 0;
    let rupture = 0;
    let critique = 0;
    for (const c of list) {
      if (!(c.is_active ?? true)) continue;
      const dispo = Math.max(0, Number(c.stock ?? 0) - Number(c.reserved_stock ?? 0));
      const min   = Number(c.min_stock ?? 0);
      totalStock += Number(c.stock ?? 0);
      if (dispo <= 0)        rupture++;
      else if (dispo <= min) critique++;
    }
    return { totalStock, rupture, critique, alertes: rupture + critique };
  }, [composants.data]);

  // ── Production signals ────────────────────────────────────────────────
  const productionSignals = useMemo(() => {
    const list = (orders.data ?? []) as any[];
    const enCours        = list.filter((o) => o.status === "in_progress" || o.status === "partial").length;
    const urgents        = list.filter((o) => o.status === "priority" || (o.status === "draft" && Number(o.priority) === 1)).length;
    const pendingMat     = list.filter((o) => o.status === "pending_material").length;
    const draft          = list.filter((o) => o.status === "draft").length;
    return { enCours, urgents, pendingMat, draft };
  }, [orders.data]);

  // ── Livraisons signals ────────────────────────────────────────────────
  const livraisonSignals = useMemo(() => {
    const list = (shipments.data ?? []) as any[];
    const prets    = list.filter((s) => s.status === "ready").length;
    const expedies = list.filter((s) => s.status === "shipped").length;
    const livres   = list.filter((s) => s.status === "delivered").length;
    return { prets, expedies, livres };
  }, [shipments.data]);

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-6">
      <header className="mb-2">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Vue d'ensemble</p>
        <h1 className="text-2xl md:text-3xl font-semibold mt-1">{UI.dashboard}</h1>
      </header>

      {/* ── A. Stock ─────────────────────────────────────────────────────── */}
      <Section label="Stock" icon={<Boxes className="h-3.5 w-3.5" />} to="/stock" cta="Voir stock">
        <KPI
          icon={<Boxes className="h-4 w-4 text-muted-foreground" />}
          label="Pièces en stock"
          value={fmtInt(stockSignals.totalStock)}
        />
        <KPI
          icon={<TrendingDown className="h-4 w-4 text-warning" />}
          label="Seuil critique"
          value={String(stockSignals.critique)}
          accent={stockSignals.critique > 0 ? "warning" : undefined}
        />
        <KPI
          icon={<PackageX className="h-4 w-4 text-destructive" />}
          label="En rupture"
          value={String(stockSignals.rupture)}
          accent={stockSignals.rupture > 0 ? "destructive" : undefined}
        />
      </Section>

      {/* ── B. Production ────────────────────────────────────────────────── */}
      <Section label="Fabrication" icon={<Factory className="h-3.5 w-3.5" />} to="/production" cta="Voir fabrication">
        <KPI
          icon={<Factory className="h-4 w-4 text-muted-foreground" />}
          label="À produire"
          value={String(productionSignals.draft)}
        />
        <KPI
          icon={<Factory className="h-4 w-4 text-info" />}
          label="En cours"
          value={String(productionSignals.enCours)}
        />
        <KPI
          icon={<AlertTriangle className="h-4 w-4 text-destructive" />}
          label="Urgents"
          value={String(productionSignals.urgents)}
          accent={productionSignals.urgents > 0 ? "destructive" : undefined}
        />
        <KPI
          icon={<AlertTriangle className="h-4 w-4 text-warning" />}
          label="Pièces manquantes"
          value={String(productionSignals.pendingMat)}
          accent={productionSignals.pendingMat > 0 ? "warning" : undefined}
        />
      </Section>

      {/* ── C. Livraisons ────────────────────────────────────────────────── */}
      <Section label="Expéditions" icon={<Truck className="h-3.5 w-3.5" />} to="/livraisons" cta="Voir expéditions">
        <KPI
          icon={<Truck className="h-4 w-4 text-info" />}
          label="Prêtes à expédier"
          value={String(livraisonSignals.prets)}
          accent={livraisonSignals.prets > 0 ? "info" : undefined}
        />
        <KPI
          icon={<Truck className="h-4 w-4 text-warning" />}
          label="En cours d'expédition"
          value={String(livraisonSignals.expedies)}
        />
        <KPI
          icon={<Truck className="h-4 w-4 text-success" />}
          label="Livrées"
          value={String(livraisonSignals.livres)}
        />
      </Section>
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
          className="inline-flex items-center rounded-md border border-input px-3 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
        >
          {cta} →
        </Link>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {children}
      </div>
    </div>
  );
}

function KPI({ icon, label, value, accent }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: "warning" | "destructive" | "info";
}) {
  const valueColor =
    accent === "destructive" ? "text-destructive" :
    accent === "warning"     ? "text-warning" :
    accent === "info"        ? "text-info" : "";

  return (
    <Card>
      <CardContent className="p-3 space-y-1.5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          {icon}
          <span className="leading-tight">{label}</span>
        </div>
        <div className={`text-2xl font-semibold tabular leading-none ${valueColor}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
