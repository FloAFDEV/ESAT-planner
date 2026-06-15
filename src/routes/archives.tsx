import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Copy, FileDown, Search, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtInt } from "@/lib/format";
import { normalizeProductionStatus, productionStatusMeta } from "@/lib/domain";
import { MSG } from "@/lib/messages";

export const Route = createFileRoute("/archives")({
  head: () => ({
    meta: [
      { title: "Archives — Fabrication" },
      { name: "description", content: "Historique des ordres de fabrication terminés et annulés." },
    ],
  }),
  component: ArchivesPage,
});

function ArchivesPage() {
  const sb = supabase as any;

  const [filterSearch, setFilterSearch]     = useState("");
  const [filterStatus, setFilterStatus]     = useState<string>("all");
  const [filterDateFrom, setFilterDateFrom] = useState<string>("");
  const [filterDateTo, setFilterDateTo]     = useState<string>("");
  const [exporting, setExporting]           = useState(false);

  const orders = useQuery({
    queryKey: ["production_orders", "archives"],
    refetchOnMount: "always",
    queryFn: async () => {
      const { data: rawOrders, error } = await sb
        .from("production_orders")
        .select("id,reference,client_of_reference,coffret_id,coffret_snapshot,quantity,produced_qty,status,priority,notes,created_at,done_at")
        .in("status", ["done", "canceled"])
        .order("created_at", { ascending: false })
        .limit(2000);
      if (error) throw error;

      const orders = ((rawOrders ?? []) as any[]).map((o) => ({
        ...o,
        status: normalizeProductionStatus(o.status),
      }));

      const coffretIds = Array.from(new Set(orders.map((o) => o.coffret_id).filter(Boolean)));
      let coffretMap = new Map<string, any>();
      if (coffretIds.length > 0) {
        const { data: coffretsData } = await sb
          .from("coffrets")
          .select("id,reference,name")
          .in("id", coffretIds);
        coffretMap = new Map((coffretsData ?? []).map((c: any) => [c.id, c]));
      }

      return orders.map((o) => ({ ...o, coffret: coffretMap.get(o.coffret_id) ?? null }));
    },
  });

  const filtered = useMemo(() => {
    let list = (orders.data ?? []) as any[];

    if (filterStatus !== "all") {
      list = list.filter((o) => o.status === filterStatus);
    }

    const q = filterSearch.trim().toLowerCase();
    if (q) {
      list = list.filter((o) => {
        const snap = o.coffret_snapshot as { reference?: string; name?: string } | null;
        return (
          (o.client_of_reference ?? "").toLowerCase().includes(q) ||
          (o.reference ?? "").toLowerCase().includes(q) ||
          (o.coffret?.reference ?? snap?.reference ?? "").toLowerCase().includes(q) ||
          (o.coffret?.name ?? snap?.name ?? "").toLowerCase().includes(q)
        );
      });
    }

    if (filterDateFrom) {
      list = list.filter((o) => new Date(o.created_at) >= new Date(filterDateFrom));
    }
    if (filterDateTo) {
      const to = new Date(filterDateTo); to.setHours(23, 59, 59, 999);
      list = list.filter((o) => new Date(o.created_at) <= to);
    }

    return list;
  }, [orders.data, filterSearch, filterStatus, filterDateFrom, filterDateTo]);

  const hasFilters = filterSearch || filterStatus !== "all" || filterDateFrom || filterDateTo;

  function resetFilters() {
    setFilterSearch(""); setFilterStatus("all"); setFilterDateFrom(""); setFilterDateTo("");
  }

  async function exportCsv() {
    if (filtered.length === 0) { toast.error(MSG.OF_EXPORT_EMPTY); return; }
    setExporting(true);
    try {
      const orderIds = filtered.map((o: any) => o.id as string);
      const dateStr = new Date().toISOString().slice(0, 10);

      const fabricLines: string[] = [
        "=== 1. FABRICATIONS ===",
        "Référence OF;OF client;Coffret (réf);Coffret (nom);Qté planifiée;Qté produite;Statut;Date création",
      ];
      for (const o of filtered as any[]) {
        const snap = (o.coffret_snapshot ?? {}) as { reference?: string; name?: string };
        const coffretRef  = o.coffret?.reference ?? snap.reference ?? "—";
        const coffretName = o.coffret?.name      ?? snap.name      ?? "Coffret archivé";
        const statusLabel = productionStatusMeta[String(o.status)]?.label ?? o.status;
        fabricLines.push(
          `${o.reference ?? o.id.slice(0, 8)};${o.client_of_reference ?? "—"};${coffretRef};${coffretName};${o.quantity};${o.produced_qty ?? 0};${statusLabel};${(o.created_at ?? "").slice(0, 10)}`
        );
      }

      // Batcher par 100 pour éviter HTTP 414 avec .in() en GET
      const BATCH = 100;
      let allConsum: any[] = [];
      for (let i = 0; i < orderIds.length; i += BATCH) {
        const batch = orderIds.slice(i, i + BATCH);
        const { data: batchData, error } = await sb
          .from("production_consumption")
          .select("production_order_id, quantity, composant:composants(reference, name)")
          .in("production_order_id", batch);
        if (error) throw error;
        if (batchData) allConsum = allConsum.concat(batchData);
      }

      const orderRefMap = new Map((filtered as any[]).map((o: any) => [o.id as string, o.reference ?? (o.id as string).slice(0, 8)]));
      const consumLines: string[] = [
        "",
        "=== 2. CONSOMMATIONS ===",
        "Référence OF;Réf. composant;Nom composant;Quantité consommée",
      ];
      for (const c of allConsum) {
        consumLines.push(
          `${orderRefMap.get(c.production_order_id) ?? c.production_order_id.slice(0, 8)};${c.composant?.reference ?? "—"};${c.composant?.name ?? "—"};${c.quantity}`
        );
      }

      const allLines = [
        `﻿Export archives OFs — ${dateStr}`,
        `OFs inclus : ${filtered.length}`,
        "",
        ...fabricLines,
        ...consumLines,
      ];

      const blob = new Blob([allLines.join("\n")], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `archives-of-${dateStr}.csv`; a.click();
      URL.revokeObjectURL(url);
      toast.success(MSG.OF_EXPORT_OK);
    } catch (e: any) {
      toast.error((e as Error).message ?? "Erreur export CSV");
    } finally {
      setExporting(false);
    }
  }

  const total = (orders.data ?? []).length;

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-4">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Lecture seule</p>
          <h1 className="text-3xl md:text-4xl font-display font-semibold mt-1">Archives</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Historique des fabrications terminées et annulées.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={exportCsv}
          disabled={exporting || filtered.length === 0}
          className="flex items-center gap-2"
        >
          <FileDown className="h-4 w-4" />
          {exporting ? "Export…" : `Exporter CSV (${filtered.length})`}
        </Button>
      </header>

      {/* Filtres */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={filterSearch}
            onChange={(e) => setFilterSearch(e.target.value)}
            placeholder="OF client, référence, coffret…"
            className="pl-8 h-8 text-xs"
          />
          {filterSearch && (
            <button onClick={() => setFilterSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="h-8 text-xs w-[150px]">
            <SelectValue placeholder="Statut" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous</SelectItem>
            <SelectItem value="done">Terminés</SelectItem>
            <SelectItem value="canceled">Annulés</SelectItem>
          </SelectContent>
        </Select>

        <Input type="date" value={filterDateFrom} onChange={(e) => setFilterDateFrom(e.target.value)} className="h-8 text-xs w-[150px]" placeholder="Du" />
        <Input type="date" value={filterDateTo}   onChange={(e) => setFilterDateTo(e.target.value)}   className="h-8 text-xs w-[150px]" placeholder="Au" />

        {hasFilters && (
          <Button size="sm" variant="ghost" onClick={resetFilters} className="h-8 text-xs text-muted-foreground">
            <X className="h-3 w-3 mr-1" /> Réinitialiser
          </Button>
        )}
      </div>

      {hasFilters && (
        <p className="text-xs text-muted-foreground">
          {filtered.length} OF{filtered.length !== 1 ? "s" : ""} affiché{filtered.length !== 1 ? "s" : ""} sur {total}
        </p>
      )}

      {/* Table */}
      {orders.isLoading ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">Chargement…</CardContent></Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground space-y-2">
            <p>{hasFilters ? "Aucun OF ne correspond aux filtres." : "Aucune archive disponible."}</p>
            {hasFilters && <Button size="sm" variant="outline" onClick={resetFilters}>Réinitialiser</Button>}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {total} OF archivé{total !== 1 ? "s" : ""}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground uppercase tracking-wider">
                    <th className="text-left px-4 py-2.5">OF client</th>
                    <th className="text-left px-4 py-2.5">OF système</th>
                    <th className="text-left px-4 py-2.5">Coffret</th>
                    <th className="text-right px-4 py-2.5">Planifié</th>
                    <th className="text-right px-4 py-2.5">Produit</th>
                    <th className="text-left px-4 py-2.5">Statut</th>
                    <th className="text-left px-4 py-2.5">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(filtered as any[]).map((o) => {
                    const snap        = o.coffret_snapshot as { reference?: string; name?: string } | null;
                    const coffretName = o.coffret?.name      ?? snap?.name      ?? "—";
                    const coffretRef  = o.coffret?.reference ?? snap?.reference ?? "—";
                    const sysRef      = o.reference ?? o.id.slice(0, 8);
                    const clientRef   = o.client_of_reference as string | null;
                    const meta        = productionStatusMeta[String(o.status)];

                    return (
                      <tr key={o.id} className="hover:bg-muted/20 transition-colors">
                        {/* OF client */}
                        <td className="px-4 py-3">
                          {clientRef ? (
                            <button
                              type="button"
                              className="group flex items-center gap-1 font-mono text-xs font-semibold hover:text-info transition-colors cursor-copy"
                              onClick={() => { navigator.clipboard.writeText(clientRef); toast.success(MSG.OF_COPIED(clientRef)); }}
                              title="Copier"
                            >
                              {clientRef}
                              <Copy className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity" />
                            </button>
                          ) : (
                            <span className="text-muted-foreground font-mono text-xs">—</span>
                          )}
                        </td>
                        {/* OF système */}
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            className="group flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground transition-colors cursor-copy"
                            onClick={() => { navigator.clipboard.writeText(sysRef); toast.success(MSG.OF_COPIED(sysRef)); }}
                            title="Copier"
                          >
                            {sysRef}
                            <Copy className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity" />
                          </button>
                        </td>
                        {/* Coffret */}
                        <td className="px-4 py-3">
                          <div className="font-medium leading-tight">{coffretName}</div>
                          <div className="text-xs font-mono text-muted-foreground">{coffretRef}</div>
                        </td>
                        {/* Qté */}
                        <td className="px-4 py-3 text-right font-mono tabular">{fmtInt(o.quantity)}</td>
                        <td className="px-4 py-3 text-right font-mono tabular">{fmtInt(o.produced_qty ?? 0)}</td>
                        {/* Statut */}
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[11px] font-medium ${meta?.cls ?? "bg-muted text-muted-foreground border-border"}`}>
                            {meta?.label ?? o.status}
                          </span>
                        </td>
                        {/* Date */}
                        <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(o.created_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
