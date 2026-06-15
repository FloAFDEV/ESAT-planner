import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { MSG } from "@/lib/messages";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, FileDown, Info, Search, Trash2, X } from "lucide-react";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { record_stock_movement } from "@/lib/stockMovements";
import { getStockHealth, normalizeProductionStatus, productionStatusMeta, stockHealthMeta, type StockHealth } from "@/lib/domain";

type StockRow = {
  id: string;
  name: string;
  reference?: string | null;
  min_stock?: number | null;
  is_active?: boolean | null;
  stockActuel: number;
  stockDisponible: number;
  stockReserve: number;
  health: StockHealth;
};

export const Route = createFileRoute("/stock")({
  head: () => ({
    meta: [
      { title: "Stock — Coffret ERP" },
      { name: "description", content: "Liste des composants, niveaux de stock et historique des mouvements." },
    ],
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    filterSearch: typeof search.filterSearch === "string" ? search.filterSearch : "",
    filterHealth: typeof search.filterHealth === "string" ? search.filterHealth : "all",
  }),
  component: StockPage,
});

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Info className="inline h-3 w-3 ml-1 text-muted-foreground cursor-help align-middle" />
      </TooltipTrigger>
      <TooltipContent className="max-w-[220px] text-xs">{children}</TooltipContent>
    </Tooltip>
  );
}

function StockPage() {
  const sb = supabase as any;
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [presetComponentId, setPresetComponentId] = useState<string>("");
  const [presetType, setPresetType] = useState<"IN" | "OUT" | "ADJUST">("IN");
  const [presetReason, setPresetReason] = useState<string>("");
  const urlSearch = Route.useSearch();
  const [filter, setFilter] = useState<"all" | "rupture" | "critical" | "ok">(() => (urlSearch.filterHealth as any) ?? "all");
  const [search, setSearch] = useState(() => urlSearch.filterSearch ?? "");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; reference: string; name: string; stock: number } | null>(null);
  const [deleteCode, setDeleteCode] = useState<string>("");
  const [deleteInput, setDeleteInput] = useState<string>("");

  const composants = useQuery({
    queryKey: ["composants"],
    refetchOnMount: "always",
    refetchInterval: 10_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from("composants")
        .select("id,reference,name,stock,reserved_stock,min_stock,is_active,deleted_at")
        .is("deleted_at", null)
        .order("reference");
      if (error) throw error;
      return data ?? [];
    },
  });

  const deleteComposant = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await sb.rpc("safe_delete_composant", { p_composant_id: id });
      if (error) throw error;
      if (data && data.success === false) throw new Error(data.message || data.error || "Suppression impossible");
    },
    onSuccess: () => {
      toast.success(MSG.COMPOSANT_DELETED);
      qc.invalidateQueries({ queryKey: ["composants"] });
      qc.invalidateQueries({ queryKey: ["nomenclatures"] });
      setDeleteTarget(null);
      setDeleteInput("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function openDeleteDialog(c: StockRow) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    setDeleteCode(code);
    setDeleteInput("");
    setDeleteTarget({ id: c.id, reference: c.reference ?? "", name: c.name ?? "", stock: c.stockActuel });
  }

  const stockRows = useMemo<StockRow[]>(() => {
    return (composants.data ?? []).map((c: any) => {
      const stockActuel = Number(c.stock ?? 0);
      const stockReserve = Math.max(0, Number(c.reserved_stock ?? 0));
      const stockDisponible = stockActuel - stockReserve;
      const health = getStockHealth(stockDisponible, Number(c.min_stock ?? 0));
      return { ...c, stockActuel, stockDisponible, stockReserve, health };
    });
  }, [composants.data]);

  const filteredRows = useMemo<StockRow[]>(() => {
    let rows = filter === "all" ? stockRows : stockRows.filter((r) => r.health === filter);
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) =>
        (r.reference ?? "").toLowerCase().includes(q) ||
        (r.name ?? "").toLowerCase().includes(q)
      );
    }
    return rows;
  }, [filter, search, stockRows]);

  const counts = useMemo(() => ({
    all: stockRows.length,
    rupture: stockRows.filter((r) => r.health === "rupture").length,
    critical: stockRows.filter((r) => r.health === "critical").length,
    ok: stockRows.filter((r) => r.health === "ok").length,
  }), [stockRows]);

  function exportStock() {
    if (filteredRows.length === 0) { toast.error("Aucun composant à exporter."); return; }
    const now = new Date().toISOString().slice(0, 10);
    const healthLabel = { ok: "OK", critical: "Critique", rupture: "Rupture" };
    const filterLabel = filter !== "all" ? ` — filtre : ${filter}` : "";
    const searchLabel = search.trim() ? ` — recherche : "${search.trim()}"` : "";
    const lines: string[] = [
      `﻿Export stock — ${now}${filterLabel}${searchLabel}`,
      "",
      "Référence;Désignation;Stock physique;Stock réservé;Stock disponible;Seuil mini;Santé",
    ];
    for (const r of filteredRows) {
      const sante = healthLabel[r.health] ?? r.health;
      lines.push(`${r.reference ?? "—"};${r.name};${r.stockActuel};${r.stockReserve};${r.stockDisponible};${r.min_stock ?? 0};${sante}`);
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `stock-${now}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast.success("Export stock téléchargé.");
  }

  return (
    <TooltipProvider delayDuration={400}>
      <div className="p-4 md:p-8 max-w-7xl mx-auto">
        <header className="mb-6 flex items-end justify-between flex-wrap gap-3">
          <div>
            <p className="text-xs uppercase tracking-widest text-muted-foreground">Inventaire</p>
            <h1 className="text-3xl md:text-4xl font-display font-semibold mt-1">Stock</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={exportStock} className="flex items-center gap-2">
              <FileDown className="h-4 w-4" /> Export stock
            </Button>
            <Link to="/production" search={{ filterStatus: "all" } as any} className="inline-flex items-center rounded-md border border-input px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground">Réserver pour OF</Link>
            <Button variant="outline" onClick={() => { setPresetComponentId(""); setPresetType("OUT"); setPresetReason("Sortie atelier"); setDialogOpen(true); }}>Sortie stock</Button>
            <Button onClick={() => { setPresetComponentId(""); setPresetType("IN"); setPresetReason("Réapprovisionnement"); setDialogOpen(true); }}>+ Réapprovisionnement</Button>
          </div>
        </header>

        <MouvementDialog
          composants={composants.data ?? []}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          presetComponentId={presetComponentId}
          presetType={presetType}
          presetReason={presetReason}
        />

        {/* Filter bar */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {([
            ["all", "Tous", counts.all],
            ["rupture", "En rupture", counts.rupture],
            ["critical", "Presque vide", counts.critical],
            ["ok", "OK", counts.ok],
          ] as const).map(([key, label, count]) => (
            <Button key={key} size="sm" variant={filter === key ? "default" : "outline"} onClick={() => setFilter(key)}>
              {label} ({count})
            </Button>
          ))}
          <div className="relative ml-auto w-full sm:w-56">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Référence ou désignation…"
              className="pl-8 pr-7 h-8 text-xs"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Stock table */}
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-[88px] md:top-0 z-10 bg-muted/95 text-xs uppercase tracking-wider text-muted-foreground backdrop-blur">
                  <tr>
                    <th className="w-8 p-3" />
                    <th className="text-left p-3">Référence / Désignation</th>
                    <th className="text-right p-3">
                      Stock
                      <Tip>Quantité physique en stock. Mis à jour à chaque entrée ou sortie.</Tip>
                    </th>
                    <th className="text-right p-3">
                      Réservé
                      <Tip>Quantité bloquée pour des ordres de fabrication en cours. Non disponible pour d'autres OFs.</Tip>
                    </th>
                    <th className="text-right p-3">
                      Disponible
                      <Tip>Stock − Réservé. Ce qu'on peut encore utiliser pour de nouveaux OFs.</Tip>
                    </th>
                    <th className="text-center p-3">État</th>
                    <th className="text-right p-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {stockRows.length === 0 ? (
                    <tr>
                      <td className="p-4 text-sm text-muted-foreground text-center" colSpan={7}>
                        Aucun composant trouvé.
                      </td>
                    </tr>
                  ) : filteredRows.length === 0 ? (
                    <tr>
                      <td className="p-4 text-sm text-muted-foreground text-center" colSpan={7}>
                        <Button size="sm" variant="outline" onClick={() => setFilter("all")}>Voir tous les stocks</Button>
                      </td>
                    </tr>
                  ) : filteredRows.map((c) => {
                    const meta = stockHealthMeta[c.health];
                    const expanded = expandedId === c.id;
                    return [
                      <tr key={c.id} className="border-t border-border hover:bg-muted/30 cursor-pointer" onClick={() => setExpandedId(expanded ? null : c.id)}>
                        <td className="p-3 text-muted-foreground">
                          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </td>
                        <td className="p-3">
                          <div className="font-mono text-xs text-muted-foreground">{c.reference}</div>
                          <div className="font-medium">{c.name}</div>
                        </td>
                        <td className="p-3 text-right tabular font-semibold">{fmtInt(c.stockActuel)}</td>
                        <td className="p-3 text-right tabular text-blue-600 dark:text-blue-400">
                          {c.stockReserve > 0 ? fmtInt(c.stockReserve) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className={`p-3 text-right tabular font-semibold ${c.health === "rupture" ? "text-destructive" : c.health === "critical" ? "text-warning" : "text-success"}`}>
                          {fmtInt(c.stockDisponible)}
                        </td>
                        <td className="p-3 text-center">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${meta.cls}`}>{meta.label}</span>
                        </td>
                        <td className="p-3 text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="inline-flex flex-wrap justify-end gap-1.5">
                            <Button size="sm" variant="outline" onClick={() => { setPresetComponentId(c.id); setPresetType("IN"); setPresetReason("Réapprovisionnement"); setDialogOpen(true); }}>
                              + Entrée
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => { setPresetComponentId(c.id); setPresetType("OUT"); setPresetReason("Sortie atelier"); setDialogOpen(true); }}>
                              Sortie
                            </Button>
                            <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => openDeleteDialog(c)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>,
                      expanded && (
                        <tr key={`${c.id}-detail`} className="bg-muted/20 border-t border-dashed border-border">
                          <td colSpan={7} className="p-0">
                            <ComponentDetail composantId={c.id} composantName={c.name} />
                          </td>
                        </tr>
                      ),
                    ];
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <ReservationsByOf />
      </div>

      {/* ── Dialog suppression composant avec code de confirmation ── */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteInput(""); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-destructive">Supprimer le composant</DialogTitle>
          </DialogHeader>
          {deleteTarget && (
            <div className="space-y-4">
              <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm space-y-1">
                <div className="font-mono text-xs text-muted-foreground">{deleteTarget.reference}</div>
                <div className="font-semibold">{deleteTarget.name}</div>
                {deleteTarget.stock > 0 && (
                  <div className="text-xs text-warning mt-1">
                    ⚠ Stock actuel : {fmtInt(deleteTarget.stock)} unités — un mouvement de sortie sera enregistré automatiquement.
                  </div>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                Cette action est irréversible. L'historique des mouvements de stock sera conservé. Le composant sera retiré de toutes les listes.
              </p>
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-center">
                <div className="text-xs text-muted-foreground mb-1">Code de confirmation</div>
                <div className="text-2xl font-mono font-bold tracking-widest text-destructive">{deleteCode}</div>
              </div>
              <div className="space-y-2">
                <Label>Saisissez le code ci-dessus pour confirmer</Label>
                <Input
                  value={deleteInput}
                  onChange={(e) => setDeleteInput(e.target.value)}
                  placeholder="_ _ _ _"
                  className="text-center font-mono text-lg tracking-widest"
                  maxLength={4}
                  autoFocus
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDeleteTarget(null); setDeleteInput(""); }}>Annuler</Button>
            <Button
              variant="destructive"
              disabled={deleteInput !== deleteCode || deleteComposant.isPending}
              onClick={() => deleteTarget && deleteComposant.mutate(deleteTarget.id)}
            >
              Supprimer définitivement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

function ComponentDetail({ composantId, composantName }: { composantId: string; composantName: string }) {
  const sb = supabase as any;

  const movements = useQuery({
    queryKey: ["composant_movements", composantId],
    queryFn: async () => {
      const { data, error } = await sb
        .from("stock_movements")
        .select("*")
        .eq("composant_id", composantId)
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const reservations = useQuery({
    queryKey: ["composant_reservations", composantId],
    queryFn: async () => {
      const { data, error } = await sb
        .from("stock_reservations")
        .select("quantity, production_order_id, status")
        .eq("composant_id", composantId)
        .eq("status", "active");
      if (error) throw error;
      const rows = (data ?? []) as any[];
      if (rows.length === 0) return [];

      const orderIds = rows.map((r: any) => r.production_order_id).filter(Boolean);
      const { data: orders } = await sb
        .from("production_orders")
        .select("id, reference, status, coffret_snapshot, coffret_id, client_of_reference")
        .in("id", orderIds);
      const orderMap = new Map<string, any>((orders ?? []).map((o: any) => [o.id as string, o]));

      // Fallback: fetch coffrets for orders missing snapshot
      const missingCoffretIds = (orders ?? [])
        .filter((o: any) => !o.coffret_snapshot?.reference && o.coffret_id)
        .map((o: any) => o.coffret_id as string);
      const coffretMap = new Map<string, any>();
      if (missingCoffretIds.length > 0) {
        const { data: coffrets } = await sb
          .from("coffrets")
          .select("id, reference, name")
          .in("id", missingCoffretIds);
        (coffrets ?? []).forEach((c: any) => coffretMap.set(c.id, c));
      }

      return rows.map((r: any) => {
        const order: any = orderMap.get(r.production_order_id) ?? null;
        const snap = (order?.coffret_snapshot ?? {}) as { reference?: string; name?: string };
        const fallback = coffretMap.get(order?.coffret_id) ?? null;
        return {
          ...r, order,
          coffretRef: snap.reference ?? fallback?.reference ?? null,
          coffretName: snap.name ?? fallback?.name ?? null,
        };
      });
    },
  });

  return (
    <div className="px-6 py-4 grid md:grid-cols-2 gap-6">
      {/* Reservations */}
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          Réservations actives
        </div>
        {reservations.isLoading ? (
          <p className="text-xs text-muted-foreground">Chargement…</p>
        ) : (reservations.data ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucune réservation en cours pour ce composant.</p>
        ) : (
          <div className="space-y-1.5">
            {(reservations.data ?? []).map((r: any) => (
              <div key={r.production_order_id} className="rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950 px-3 py-2 text-xs space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-medium">{r.order?.reference ?? r.production_order_id?.slice(0, 8)}</span>
                  <span className="font-semibold tabular shrink-0">{fmtInt(r.quantity)} unités</span>
                </div>
                {r.order?.client_of_reference && (
                  <div className="text-muted-foreground font-semibold">OF client : {r.order.client_of_reference}</div>
                )}
                <div className="flex items-center justify-between gap-2 text-muted-foreground">
                  {(r.coffretRef || r.coffretName) ? (
                    <span className="font-mono truncate">{[r.coffretRef, r.coffretName].filter(Boolean).join(" · ")}</span>
                  ) : (
                    <span className="italic">Coffret non trouvé</span>
                  )}
                  {r.order?.status ? (
                    <span className={`shrink-0 inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium ${productionStatusMeta[normalizeProductionStatus(r.order.status)]?.cls ?? "bg-muted text-muted-foreground border-border"}`}>
                      {productionStatusMeta[normalizeProductionStatus(r.order.status)]?.label ?? r.order.status}
                    </span>
                  ) : (
                    <span className="shrink-0">—</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Movement history */}
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          Derniers mouvements
        </div>
        {movements.isLoading ? (
          <p className="text-xs text-muted-foreground">Chargement…</p>
        ) : (movements.data ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucun mouvement enregistré pour ce composant.</p>
        ) : (
          <div className="space-y-1">
            {(movements.data ?? []).map((m: any) => (
              <div key={m.id} className="flex items-center gap-3 text-xs border-b border-border/40 py-1 last:border-0">
                <span className="text-muted-foreground tabular w-32 shrink-0">{fmtDateTime(m.created_at)}</span>
                {m.type === "IN" ? (
                  <span className="inline-flex items-center gap-1 rounded-sm border border-success/30 bg-success/10 px-1.5 py-0.5 font-medium">
                    <ArrowDown className="h-3 w-3 text-success" /> Entrée
                  </span>
                ) : m.type === "OUT" ? (
                  <span className="inline-flex items-center gap-1 rounded-sm border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 font-medium">
                    <ArrowUp className="h-3 w-3 text-destructive" /> Sortie
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-sm border border-border bg-muted px-1.5 py-0.5 font-medium">Ajust.</span>
                )}
                <span className="font-semibold tabular">{m.type === "OUT" ? "-" : "+"}{fmtInt(m.quantity)}</span>
                {m.reason && <span className="text-muted-foreground truncate">{m.reason}</span>}
                {m.source_type === "production_order" && !m.reason && (
                  <span className="text-muted-foreground italic">OF production</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MouvementDialog({
  composants,
  open,
  onOpenChange,
  presetComponentId,
  presetType,
  presetReason,
}: {
  composants: { id: string; reference: string; name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presetComponentId?: string;
  presetType?: "IN" | "OUT" | "ADJUST";
  presetReason?: string;
}) {
  const [composantId, setComposantId] = useState<string>("");
  const [type, setType] = useState<"IN" | "OUT" | "ADJUST">("IN");
  const [qty, setQty] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const qc = useQueryClient();

  useEffect(() => {
    if (!open) return;
    setComposantId(presetComponentId ?? "");
    setType(presetType ?? "IN");
    setReason(presetReason ?? "");
    setQty("");
  }, [open, presetComponentId, presetType, presetReason]);

  const mut = useMutation({
    mutationFn: async () => {
      const quantity = parseInt(qty, 10);
      if (!composantId || !quantity || quantity <= 0) throw new Error("Composant et quantité requis");
      await record_stock_movement({
        composant_id: composantId,
        type,
        quantity,
        reason: reason || null,
        source_type: "manual_fix",
        source_id: null,
      });
    },
    onSuccess: () => {
      toast.success(MSG.STOCK_MOVEMENT_SAVED);
      qc.invalidateQueries({ queryKey: ["composants"] });
      qc.invalidateQueries({ queryKey: ["composant_movements"] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const typeLabel = type === "IN" ? "Entrée" : type === "OUT" ? "Sortie" : "Ajustement";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{typeLabel} de stock</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Composant</Label>
            <Select value={composantId} onValueChange={setComposantId}>
              <SelectTrigger><SelectValue placeholder="Sélectionner…" /></SelectTrigger>
              <SelectContent>
                {composants.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <span className="font-mono text-xs mr-2">{c.reference}</span>{c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Type de mouvement</Label>
              <Select value={type} onValueChange={(v) => setType(v as "IN" | "OUT" | "ADJUST")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="IN">Entrée (+) — réapprovisionnement</SelectItem>
                  <SelectItem value="OUT">Sortie (−) — perte, casse</SelectItem>
                  <SelectItem value="ADJUST">Inventaire — fixe le stock à cette valeur</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Quantité</Label>
              <Input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Motif <span className="text-muted-foreground text-xs">(optionnel)</span></Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex : Réception fournisseur, casse, inventaire…" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>Enregistrer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Réservations par OF ──────────────────────────────────────────────────────

function ReservationsByOf() {
  const sb = supabase as any;
  const [filterOf, setFilterOf] = useState("");
  const [filterRef, setFilterRef] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next; });

  const { data, isLoading } = useQuery({
    queryKey: ["reservations_by_of"],
    queryFn: async () => {
      const { data, error } = await sb
        .from("v_reservations_by_of")
        .select("reservation_id,production_order_id,of_number,product_reference,composant_reference,composant_name,quantity,status,created_at,of_status")
        .order("of_number", { ascending: true })
        .order("product_reference", { ascending: true });
      if (error) throw error;
      const rows = (data ?? []) as any[];
      const poIds = [...new Set(rows.map((r) => r.production_order_id))];
      if (poIds.length > 0) {
        const { data: poData } = await sb
          .from("production_orders")
          .select("id,client_of_reference")
          .in("id", poIds);
        const poMap = new Map((poData ?? []).map((p: any) => [p.id, p.client_of_reference]));
        return rows.map((r) => ({ ...r, client_of_reference: poMap.get(r.production_order_id) ?? null }));
      }
      return rows;
    },
  });

  const filtered = useMemo(() => {
    let rows = data ?? [];
    if (filterStatus !== "all") rows = rows.filter((r) => r.status === filterStatus);
    const q = filterOf.trim().toLowerCase();
    if (q) rows = rows.filter((r) => (r.of_number ?? "").toLowerCase().includes(q) || (r.client_of_reference ?? "").toLowerCase().includes(q));
    const qr = filterRef.trim().toLowerCase();
    if (qr) rows = rows.filter((r) => (r.product_reference ?? "").toLowerCase().includes(qr));
    return rows;
  }, [data, filterOf, filterRef, filterStatus]);

  const grouped = useMemo(() => {
    const map = new Map<string, { of_number: string; of_status: string; client_of_reference: string | null; rows: any[] }>();
    for (const row of filtered) {
      const key = row.production_order_id;
      if (!map.has(key)) map.set(key, { of_number: row.of_number, of_status: row.of_status, client_of_reference: row.client_of_reference ?? null, rows: [] });
      map.get(key)!.rows.push(row);
    }
    return Array.from(map.values());
  }, [filtered]);

  const statusLabel: Record<string, string> = { active: "Réservé", consumed: "Consommé", canceled: "Annulé" };
  const statusCls: Record<string, string> = {
    active:   "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    consumed: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300",
    canceled: "bg-muted text-muted-foreground",
  };

  return (
    <Card className="mt-6">
      <CardHeader className="flex-row items-center justify-between flex-wrap gap-2">
        <CardTitle className="text-base">Réservations de stock par OF</CardTitle>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <Input value={filterOf} onChange={(e) => setFilterOf(e.target.value)} placeholder="Filtrer par OF…" className="h-8 w-36 text-sm" />
          <Input value={filterRef} onChange={(e) => setFilterRef(e.target.value)} placeholder="Filtrer par produit…" className="h-8 w-36 text-sm" />
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="h-8 w-36 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tous statuts</SelectItem>
              <SelectItem value="active">Réservé</SelectItem>
              <SelectItem value="consumed">Consommé</SelectItem>
              <SelectItem value="canceled">Annulé</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading && <div className="p-4 text-sm text-muted-foreground">Chargement…</div>}
        {!isLoading && grouped.length === 0 && <div className="p-4 text-sm text-muted-foreground">Aucune réservation.</div>}
        {grouped.map((group) => {
          const key = group.of_number;
          const isOpen = openGroups.has(key);
          const count = group.rows.length;
          return (
            <div key={key} className="border-t border-border">
              <button
                type="button"
                onClick={() => toggleGroup(key)}
                className="w-full flex items-center justify-between gap-3 px-4 py-2.5 bg-muted/40 hover:bg-muted/70 transition-colors text-left"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                  <span className="text-xs font-mono font-semibold text-foreground">{group.of_number}</span>
                  {group.client_of_reference && (
                    <span className="text-xs font-mono font-bold text-primary truncate">{group.client_of_reference}</span>
                  )}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${statusCls[group.of_status] ?? "bg-muted text-muted-foreground"}`}>
                    {group.rows[0]?.product_reference ?? "—"}
                  </span>
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {count} composant{count !== 1 ? "s" : ""} réservé{count !== 1 ? "s" : ""}
                </span>
              </button>
              {isOpen && (
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase tracking-wider text-muted-foreground bg-muted/20">
                    <tr>
                      <th className="text-left p-2 pl-8">Produit</th>
                      <th className="text-left p-2">Composant</th>
                      <th className="text-right p-2">Qté</th>
                      <th className="text-center p-2">Statut</th>
                      <th className="text-right p-2 pr-4">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((r) => (
                      <tr key={r.reservation_id} className="border-t border-border/50 hover:bg-muted/20">
                        <td className="p-2 pl-8 font-mono text-xs">{r.product_reference ?? "—"}</td>
                        <td className="p-2">
                          <div className="font-medium">{r.composant_name}</div>
                          <div className="text-xs text-muted-foreground font-mono">{r.composant_reference}</div>
                        </td>
                        <td className="p-2 text-right tabular">{fmtInt(r.quantity)}</td>
                        <td className="p-2 text-center">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${statusCls[r.status] ?? ""}`}>
                            {statusLabel[r.status] ?? r.status}
                          </span>
                        </td>
                        <td className="p-2 pr-4 text-right text-xs text-muted-foreground tabular">
                          {new Date(r.created_at).toLocaleDateString("fr-FR")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
