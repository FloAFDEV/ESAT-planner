import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { parseSupabaseError } from "@/lib/supabaseError";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FileDown, Plus, Search, Trash2, Truck, Phone, Mail, MapPin, X, Pencil, Layers, Printer, AlertTriangle } from "lucide-react";
import { CreateClientDialog } from "@/components/CreateClientDialog";
import { fmtDate, fmtInt, fmtKg, fmtPalette } from "@/lib/format";
import { livraisonStatusMeta, normalizeLivraisonStatus, type LivraisonStatus } from "@/lib/domain";
import { UI } from "@/lib/uiLabels";
import { MSG } from "@/lib/messages";
import agecetLogo from "@/assets/logo_agecet_hands.jpg";
import { clientCompleteness } from "@/lib/clientCompleteness";

export const Route = createFileRoute("/livraisons")({
  head: () => ({
    meta: [
      { title: "Livraisons — Coffret ERP" },
      { name: "description", content: "Préparation, palettisation et suivi des expéditions." },
    ],
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    filterClient: typeof search.filterClient === "string" ? search.filterClient : "",
    filterStatus: typeof search.filterStatus === "string" ? search.filterStatus : "",
  }),
  component: LivraisonsPage,
});

type ShipmentLineDraft = { product_variant_id: string; quantity: number };

// "BL2606003", "BL 2606003", "BL BL2606003" → "2606003"
function normalizeBl(raw: string): string {
  return raw.trim().replace(/^BL\s*/i, "").trim();
}

const BL_STATUS_ORDER = ["draft", "ready", "shipped", "delivered"] as const;
function blGroupStatus(items: any[]): string {
  const statuses = new Set(items.map((s) => String(s.status)));
  for (const s of BL_STATUS_ORDER) {
    if (statuses.has(s)) return s;
  }
  return String(items[0]?.status ?? "draft");
}

function LivraisonsPage() {
  const sb = supabase as any;
  const qc = useQueryClient();

  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editShipment, setEditShipment] = useState<any | null>(null);
  const [palettesShipment, setPalettesShipment] = useState<any | null>(null);
  const [blDocumentGroup, setBlDocumentGroup] = useState<{ blNumber: string; shipments: any[] } | null>(null);
  const urlSearch = Route.useSearch();
  const [shipSearch, setShipSearch] = useState(() => urlSearch.filterClient || "");
  const [shipStatus, setShipStatus] = useState<string>(() => urlSearch.filterStatus || "all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const deleteShipment = useMutation({
    mutationFn: async (id: string) => {
      const { error: lineError } = await sb.from("shipment_lines").delete().eq("shipment_id", id);
      if (lineError) throw lineError;
      const { error } = await sb.from("shipments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shipments"] });
      toast.success(MSG.SHIPMENT_DELETED);
      setDeleteId(null);
    },
    onError: (e: unknown) => toast.error(parseSupabaseError(e)),
  });

  const transitionShipment = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: LivraisonStatus }) => {
      const { error } = await sb.from("shipments").update({ status }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shipments"] });
    },
    onError: (e: unknown) => toast.error(parseSupabaseError(e)),
  });

  const clientsList = useQuery({
    queryKey: ["clients"],
    queryFn: async () => {
      const { data, error } = await sb.from("clients").select("id,name").order("name");
      if (error) throw error;
      return data;
    },
  });

  const shipments = useQuery({
    queryKey: ["shipments"],
    queryFn: async () => {
      // Round 1: base shipments
      const { data: shipmentRows, error } = await sb
        .from("shipments")
        .select("id,reference,bl_number,client_of_reference,client_id,total_weight,total_pallets,status,created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;

      const rows = (shipmentRows ?? []) as any[];
      const shipmentIds = rows.map((s) => s.id);
      const clientIds = Array.from(new Set(rows.map((s) => s.client_id).filter(Boolean)));

      // Round 2: clients + lines + pallets in parallel
      const [clientsResult, linesResult, palletsResult] = await Promise.all([
        clientIds.length > 0
          ? sb.from("clients").select("id,name,contact_name,phone,email,address,city,postal_code,country").in("id", clientIds)
          : Promise.resolve({ data: [], error: null }),
        shipmentIds.length > 0
          ? sb.from("shipment_lines").select("id,shipment_id,product_variant_id,quantity,weight").in("shipment_id", shipmentIds)
          : Promise.resolve({ data: [], error: null }),
        shipmentIds.length > 0
          ? sb.from("shipment_pallets").select("id,shipment_id,label,type,weight,width,height,depth").in("shipment_id", shipmentIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (clientsResult.error) throw clientsResult.error;
      if (linesResult.error) throw linesResult.error;
      if (palletsResult.error) throw palletsResult.error;

      const clientMap = new Map<string, any>((clientsResult.data ?? []).map((c: any) => [c.id, c]));
      const lineRows: any[] = linesResult.data ?? [];
      const palletRows: any[] = palletsResult.data ?? [];

      const variantIds = Array.from(new Set(lineRows.map((l) => l.product_variant_id).filter(Boolean)));
      const palletIds = palletRows.map((p) => p.id).filter(Boolean);

      // Round 3: product_variants + pallet_lines in parallel
      const [variantsResult, palletLinesResult] = await Promise.all([
        variantIds.length > 0
          ? sb.from("product_variants").select("id,reference,name,weight").in("id", variantIds)
          : Promise.resolve({ data: [], error: null }),
        palletIds.length > 0
          ? sb.from("shipment_pallet_lines").select("id,pallet_id,shipment_line_id,quantity").in("pallet_id", palletIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (variantsResult.error) throw variantsResult.error;
      if (palletLinesResult.error) throw palletLinesResult.error;

      const variantMap = new Map<string, any>((variantsResult.data ?? []).map((v: any) => [v.id, v]));

      const linesByShipment = new Map<string, any[]>();
      for (const line of lineRows) {
        const variant = variantMap.get(line.product_variant_id) ?? null;
        const displayWeight = Number(line.weight) > 0
          ? Number(line.weight)
          : Number(line.quantity) * Number(variant?.weight ?? 0);
        const current = linesByShipment.get(line.shipment_id) ?? [];
        current.push({ ...line, variant, displayWeight });
        linesByShipment.set(line.shipment_id, current);
      }

      const palletsByShipment = new Map<string, any[]>();
      for (const pallet of palletRows) {
        const current = palletsByShipment.get(pallet.shipment_id) ?? [];
        current.push(pallet);
        palletsByShipment.set(pallet.shipment_id, current);
      }

      const palletLineMap = new Map<string, any[]>();
      for (const pl of (palletLinesResult.data ?? []) as any[]) {
        const current = palletLineMap.get(pl.pallet_id) ?? [];
        current.push(pl);
        palletLineMap.set(pl.pallet_id, current);
      }

      return rows.map((s) => {
        const shipmentPallets = (palletsByShipment.get(s.id) ?? []).map((p: any) => ({
          ...p,
          pallet_lines: palletLineMap.get(p.id) ?? [],
        }));
        return {
          ...s,
          status: normalizeLivraisonStatus(s.status),
          client_entity: s.client_id ? clientMap.get(s.client_id) ?? null : null,
          lines: linesByShipment.get(s.id) ?? [],
          pallets: shipmentPallets,
          pallet_count: shipmentPallets.length,
        };
      });
    },
  });

  const filteredShipments = useMemo(() => {
    let rows = (shipments.data ?? []) as any[];
    if (shipStatus !== "all") rows = rows.filter((s) => s.status === shipStatus);
    if (dateFrom) rows = rows.filter((s) => new Date(s.created_at) >= new Date(dateFrom));
    if (dateTo)   rows = rows.filter((s) => new Date(s.created_at) <= new Date(dateTo + "T23:59:59"));
    const q = shipSearch.trim().toLowerCase();
    if (q) {
      rows = rows.filter((s) =>
        (s.client_entity?.name  ?? "").toLowerCase().includes(q) ||
        (s.reference            ?? "").toLowerCase().includes(q) ||
        (s.bl_number            ?? "").toLowerCase().includes(q) ||
        (s.client_entity?.city  ?? "").toLowerCase().includes(q) ||
        (s.client_entity?.address ?? "").toLowerCase().includes(q) ||
        String(s.total_weight   ?? "").includes(q)
      );
    }
    return rows;
  }, [shipments.data, shipSearch, shipStatus, dateFrom, dateTo]);

  // Groupe les expéditions par bl_number normalisé. Les expéditions sans BL restent isolées.
  const groupedShipments = useMemo(() => {
    const groups: Array<{ blNumber: string | null; shipments: any[] }> = [];
    const byBl = new Map<string, any[]>();
    for (const s of filteredShipments) {
      const raw = s.bl_number?.trim() || null;
      if (!raw) {
        groups.push({ blNumber: null, shipments: [s] });
      } else {
        const key = normalizeBl(raw);
        if (!byBl.has(key)) byBl.set(key, []);
        byBl.get(key)!.push(s);
      }
    }
    for (const [bl, items] of byBl) {
      groups.push({ blNumber: bl, shipments: items });
    }
    return groups.sort((a, b) => {
      const dateA = a.shipments.reduce((max, s) => s.created_at > max ? s.created_at : max, "");
      const dateB = b.shipments.reduce((max, s) => s.created_at > max ? s.created_at : max, "");
      return dateB.localeCompare(dateA);
    });
  }, [filteredShipments]);

  const activeFilters = (shipStatus !== "all" ? 1 : 0) + (dateFrom ? 1 : 0) + (dateTo ? 1 : 0) + (shipSearch.trim() ? 1 : 0);

  function exportExpeditions() {
    if (filteredShipments.length === 0) { toast.error("Aucune expédition à exporter."); return; }
    const now = new Date().toISOString().slice(0, 10);
    const { livraisonStatusMeta: meta } = { livraisonStatusMeta };
    const lines: string[] = [
      `﻿Export expéditions — ${now}`,
      dateFrom || dateTo ? `Période : ${dateFrom || "…"} → ${dateTo || "…"}` : "Toutes dates",
      "",
      "Référence;BL;OF client;Client;Statut;Date;Poids (kg);Palettes",
    ];
    for (const s of filteredShipments as any[]) {
      const clientName = s.client_entity?.name ?? "—";
      const statusLabel = (livraisonStatusMeta as any)[String(s.status)]?.label ?? s.status;
      const poids = Number(s.total_weight ?? 0).toFixed(2).replace(".", ",");
      lines.push(`${s.reference ?? s.id?.slice(0, 8) ?? "—"};${s.bl_number ?? "—"};${s.client_of_reference ?? "—"};${clientName};${statusLabel};${(s.created_at ?? "").slice(0, 10)};${poids};${s.total_pallets ?? 0}`);
    }
    lines.push("", `Total : ${filteredShipments.length} expédition(s)`);
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `expeditions-${now}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast.success("Export expéditions téléchargé.");
  }

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      <header className="mb-6 flex items-end justify-between flex-wrap gap-3">
        <div>
          <img src={agecetLogo} alt="ESAT AGECET" className="h-10 w-auto rounded-sm border border-border mb-2" />
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Logistique</p>
          <h1 className="text-3xl md:text-4xl font-display font-semibold mt-1">{UI.livraisons} / Shipments</h1>
          <p className="text-xs text-muted-foreground mt-1">Préparation, palettisation, expédition et livraison finale.</p>
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <Button variant="outline" onClick={exportExpeditions} className="flex items-center gap-2">
            <FileDown className="h-4 w-4" /> Export
          </Button>
          <CreateClientDialog />
          <NewShipmentDialog />
        </div>
      </header>


      {/* Filter bar */}
      <div className="mb-4 flex flex-col sm:flex-row flex-wrap items-start sm:items-end gap-2">
        {/* Text search */}
        <div className="relative w-full sm:w-60">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={shipSearch}
            onChange={(e) => setShipSearch(e.target.value)}
            placeholder="Client, référence, ville…"
            className="pl-8 pr-7 h-9 text-sm"
          />
          {shipSearch && (
            <button onClick={() => setShipSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Status */}
        <Select value={shipStatus} onValueChange={setShipStatus}>
          <SelectTrigger className="h-9 w-full sm:w-40 text-sm">
            <SelectValue placeholder="Statut" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous les statuts</SelectItem>
            <SelectItem value="draft">À expédier</SelectItem>
            <SelectItem value="ready">Prêt</SelectItem>
            <SelectItem value="shipped">Expédié</SelectItem>
            <SelectItem value="delivered">Livré</SelectItem>
          </SelectContent>
        </Select>

        {/* Date range */}
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            title="Date de début"
            className="h-9 rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <span className="text-xs text-muted-foreground">→</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            title="Date de fin"
            className="h-9 rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {/* Reset button */}
        {activeFilters > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 text-muted-foreground hover:text-foreground gap-1.5"
            onClick={() => { setShipSearch(""); setShipStatus("all"); setDateFrom(""); setDateTo(""); }}
          >
            <X className="h-3.5 w-3.5" />
            Réinitialiser ({activeFilters})
          </Button>
        )}

        {/* Result count */}
        {shipments.data && (
          <span className="ml-auto text-xs text-muted-foreground">
            {filteredShipments.length} / {(shipments.data as any[]).length} expéditions
          </span>
        )}
      </div>

      <div className="grid gap-4">
        {(shipments.data ?? []).length === 0 && (
          <Card><CardContent className="py-12 text-center text-muted-foreground text-sm">Aucun shipment pour le moment.</CardContent></Card>
        )}
        {filteredShipments.length === 0 && (shipments.data ?? []).length > 0 && (
          <Card><CardContent className="py-8 text-center text-muted-foreground text-sm">Aucune expédition ne correspond aux filtres.</CardContent></Card>
        )}
        {groupedShipments.map((group) => {
          if (group.blNumber) {
            const totalWeight = group.shipments.reduce((sum, s) => sum + Number(s.total_weight ?? 0), 0);
            const totalPallets = group.shipments.reduce((sum, s) => sum + Number(s.total_pallets ?? 0), 0);
            const latestDate = group.shipments.reduce((max, s) => s.created_at > max ? s.created_at : max, "");
            const status = blGroupStatus(group.shipments);
            return (
              <div key={`bl-${group.blNumber}`} className="rounded-lg border border-info/30 bg-info/5">
                <div className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 border-b border-info/20">
                  <div className="flex items-center gap-2 min-w-0">
                    <Truck className="h-4 w-4 text-info shrink-0" />
                    <span className="font-mono font-bold text-base text-info">BL {group.blNumber}</span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${livraisonStatusMeta[status]?.cls ?? "bg-muted text-muted-foreground"}`}>
                      {livraisonStatusMeta[status]?.label ?? status}
                    </span>
                  </div>
                  <div className="flex items-center gap-x-3 text-xs text-muted-foreground flex-wrap sm:ml-auto">
                    <span>{group.shipments.length} expédition{group.shipments.length > 1 ? "s" : ""}</span>
                    <span>{fmtKg(totalWeight)}</span>
                    <span>{totalPallets} palette{totalPallets !== 1 ? "s" : ""}</span>
                    <span>{fmtDate(latestDate)}</span>
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 ml-1" onClick={() => setBlDocumentGroup({ blNumber: group.blNumber!, shipments: group.shipments })}>
                      <Printer className="h-3 w-3" /> Voir BL
                    </Button>
                  </div>
                </div>
                <div className="grid gap-3 p-3">
                  {group.shipments.map((s: any) => <ShipmentCard key={s.id} s={s} hideBl onEdit={setEditShipment} onDelete={setDeleteId} onPalettes={setPalettesShipment} transitionShipment={transitionShipment} />)}
                </div>
              </div>
            );
          }
          return <ShipmentCard key={group.shipments[0].id} s={group.shipments[0]} onEdit={setEditShipment} onDelete={setDeleteId} onPalettes={setPalettesShipment} transitionShipment={transitionShipment} />;
        })}
      </div>

      {editShipment && (
        <EditShipmentDialog
          shipment={editShipment}
          onClose={() => setEditShipment(null)}
        />
      )}

      <Dialog open={deleteId !== null} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Supprimer l'expédition ?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Cette action est irréversible. L'expédition et ses lignes seront définitivement supprimées.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>Annuler</Button>
            <Button
              variant="destructive"
              disabled={deleteShipment.isPending}
              onClick={() => { if (deleteId) deleteShipment.mutate(deleteId); }}
            >
              Supprimer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {palettesShipment && (
        <PalettesDetailDialog
          shipment={palettesShipment}
          onClose={() => setPalettesShipment(null)}
        />
      )}

      {blDocumentGroup && (
        <BLDocumentDialog
          group={blDocumentGroup}
          onClose={() => setBlDocumentGroup(null)}
        />
      )}
    </div>
  );
}


function ShipmentCard({ s, hideBl = false, onEdit, onDelete, onPalettes, transitionShipment }: {
  s: any;
  hideBl?: boolean;
  onEdit: (s: any) => void;
  onDelete: (id: string) => void;
  onPalettes: (s: any) => void;
  transitionShipment: { isPending: boolean; mutate: (args: { id: string; status: string }) => void };
}) {
  const status = String(s.status);
  const canPrepare = status === "draft";
  const canLoad = status === "ready";
  const canShip = status === "shipped";
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Truck className="h-4 w-4 text-info" />
            <ClientPopover client={s.client_entity} shipmentDate={s.created_at} shipmentStatus={s.status} />
          </CardTitle>
          <div className="mt-1 space-y-0.5">
            {s.client_of_reference && (
              <div className="font-mono text-sm font-semibold text-foreground">{s.client_of_reference}</div>
            )}
            <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-mono">{s.reference ?? s.id}</span>
              {!hideBl && s.bl_number && (
                <span className="inline-flex items-center gap-1 font-mono bg-info/10 text-info border border-info/20 rounded px-1.5 py-0">
                  BL {normalizeBl(s.bl_number)}
                </span>
              )}
              <span>{fmtDate(s.created_at)}</span>
            </div>
          </div>
          <div className="mt-1">
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${livraisonStatusMeta[status ?? ""]?.cls ?? "bg-muted text-muted-foreground"}`}>
              {livraisonStatusMeta[status ?? ""]?.label ?? String(s.status ?? "")}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {status !== "shipped" && status !== "delivered" && (
            <Button variant="ghost" size="icon" onClick={() => onEdit(s)}>
              <Pencil className="h-4 w-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10" onClick={() => onDelete(s.id)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-2 flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" className="w-full sm:w-auto" disabled={!canPrepare || transitionShipment.isPending} onClick={() => transitionShipment.mutate({ id: s.id, status: "ready" })}>Préparer</Button>
          <Button size="sm" variant="outline" className="w-full sm:w-auto" disabled={!canLoad || transitionShipment.isPending} onClick={() => transitionShipment.mutate({ id: s.id, status: "shipped" })}>Expédier</Button>
          <Button size="sm" variant="outline" className="w-full sm:w-auto" disabled={!canShip || transitionShipment.isPending} onClick={() => transitionShipment.mutate({ id: s.id, status: "delivered" })}>Livrer</Button>
          <Button size="sm" variant="secondary" className="w-full sm:w-auto gap-1.5" onClick={() => onPalettes(s)}>
            <Layers className="h-3.5 w-3.5" />
            Palettes{s.pallet_count > 0 ? ` (${s.pallet_count})` : ""}
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs md:text-sm">
            <thead className="sticky top-[88px] md:top-0 z-10 bg-muted/95 backdrop-blur text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left p-1.5 md:p-2">Variant</th>
                <th className="text-right p-1.5 md:p-2">Quantité</th>
                <th className="text-right p-1.5 md:p-2">Poids ligne</th>
              </tr>
            </thead>
            <tbody>
              {(s.lines ?? []).map((it: any) => (
                <tr key={it.id} className="border-t border-border">
                  <td className="p-1.5 md:p-2">
                    <div className="font-medium">{it.variant?.name ?? "Données manquantes"}</div>
                    <div className="text-xs text-muted-foreground font-mono">{it.variant?.reference ?? "Données manquantes"}</div>
                  </td>
                  <td className="p-1.5 md:p-2 text-right tabular">{fmtInt(it.quantity)}</td>
                  <td className="p-1.5 md:p-2 text-right tabular">{fmtKg(it.displayWeight)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                <td className="p-1.5 md:p-2">Total</td>
                <td className="p-1.5 md:p-2 text-right tabular">
                  {fmtInt((s.lines ?? []).reduce((sum: number, l: any) => sum + Number(l.quantity ?? 0), 0))} u.
                </td>
                <td className="p-1.5 md:p-2 text-right tabular">{fmtKg((s.lines ?? []).reduce((sum: number, l: any) => sum + Number(l.displayWeight ?? 0), 0))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}


function ClientPopover({ client, shipmentDate, shipmentStatus }: {
  client: any | null;
  shipmentDate?: string;
  shipmentStatus?: string;
}) {
  if (!client) return <span className="text-muted-foreground">Client inconnu</span>;

  const address = [client.address, client.postal_code, client.city, client.country]
    .filter(Boolean)
    .join(", ");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="font-semibold underline-offset-2 hover:underline focus:outline-none">
          {client.name}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-4 space-y-2.5 text-sm" align="start">
        <div className="font-semibold text-base">{client.name}</div>
        {client.contact_name && (
          <div className="text-muted-foreground">{client.contact_name}</div>
        )}
        {client.phone && (
          <a href={`tel:${client.phone}`} className="flex items-center gap-2 hover:underline text-foreground">
            <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            {client.phone}
          </a>
        )}
        {client.email && (
          <a href={`mailto:${client.email}`} className="flex items-center gap-2 hover:underline text-foreground">
            <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            {client.email}
          </a>
        )}
        {address && (
          <div className="flex items-start gap-2 text-muted-foreground">
            <MapPin className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{address}</span>
          </div>
        )}
        {(() => {
          const { missingFields } = clientCompleteness(client);
          return missingFields.length > 0 ? (
            <div className="pt-2 border-t border-amber-200 flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 rounded px-2 py-1.5">
              <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
              <span>Profil incomplet — manquant : {missingFields.join(", ")}</span>
            </div>
          ) : null;
        })()}
        {shipmentDate && (
          <div className="pt-2 border-t border-border text-[11px] text-muted-foreground">
            Ce shipment : {new Date(shipmentDate).toLocaleDateString("fr-FR")}
            {shipmentStatus && <span className="ml-1 font-medium">· {shipmentStatus}</span>}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}


function EditShipmentDialog({ shipment, onClose }: { shipment: any; onClose: () => void }) {
  const sb = supabase as any;
  const qc = useQueryClient();

  const [clientId, setClientId] = useState<string>(shipment.client_id ?? "");
  const [clientOfRef, setClientOfRef] = useState<string>(shipment.client_of_reference ?? "");
  const [blNumber, setBlNumber] = useState<string>(shipment.bl_number ?? "");
  const [lines, setLines] = useState<ShipmentLineDraft[]>(
    (shipment.lines ?? []).length > 0
      ? (shipment.lines as any[]).map((l: any) => ({ product_variant_id: l.product_variant_id, quantity: l.quantity }))
      : [{ product_variant_id: "", quantity: 1 }]
  );

  const clients = useQuery({
    queryKey: ["clients"],
    queryFn: async () => {
      const { data, error } = await sb.from("clients").select("id,name").order("name");
      if (error) throw error;
      return data;
    },
  });

  const variants = useQuery({
    queryKey: ["product_variants"],
    queryFn: async () => {
      const { data, error } = await sb
        .from("product_variants")
        .select("id,reference,name,weight,nb_par_palette")
        .order("reference");
      if (error) throw error;
      return data;
    },
  });

  const vMap = useMemo(() => {
    const m = new Map<string, { weight: number; nb_par_palette: number }>();
    (variants.data ?? []).forEach((v: any) =>
      m.set(v.id, { weight: Number(v.weight ?? 0), nb_par_palette: Number(v.nb_par_palette ?? 0) })
    );
    return m;
  }, [variants.data]);

  const totals = useMemo(() => {
    let weight = 0;
    const items = lines
      .filter((l) => l.product_variant_id && l.quantity > 0)
      .map((l) => {
        const v = vMap.get(l.product_variant_id);
        const lineWeight = Number(l.quantity) * Number(v?.weight ?? 0);
        weight += lineWeight;
        return { ...l, weight: lineWeight };
      });
    return { items, weight, hasZeroWeight: items.some((it) => it.weight === 0) };
  }, [lines, vMap]);

  const save = useMutation({
    mutationFn: async () => {
      if (!clientId) throw new Error("Client requis");
      if (totals.items.length === 0) throw new Error("Ajoutez au moins une ligne");

      // Insert new lines first — if this fails, old lines are still intact
      const newLines = totals.items.map((it) => ({
        shipment_id: shipment.id,
        product_variant_id: it.product_variant_id,
        quantity: it.quantity,
        weight: it.weight,
      }));
      const { data: inserted, error: lineError } = await sb.from("shipment_lines").insert(newLines).select("id");
      if (lineError) throw lineError;
      // Delete old lines only after insert succeeded
      const newIds = (inserted ?? []).map((r: any) => r.id);
      await sb.from("shipment_lines").delete().eq("shipment_id", shipment.id).not("id", "in", `(${newIds.join(",")})`);
      await sb.from("shipments").update({ client_id: clientId, total_weight: totals.weight, client_of_reference: clientOfRef || null, bl_number: blNumber || null }).eq("id", shipment.id);
    },
    onSuccess: () => {
      toast.success(MSG.SHIPMENT_UPDATED);
      qc.invalidateQueries({ queryKey: ["shipments"] });
      onClose();
    },
    onError: (e: unknown) => toast.error(parseSupabaseError(e)),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>Modifier le shipment</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Client</Label>
            <Select value={clientId} onValueChange={setClientId}>
              <SelectTrigger><SelectValue placeholder="Sélectionner un client" /></SelectTrigger>
              <SelectContent>
                {(clients.data ?? []).map((c: any) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {clientId && (() => {
              const selectedClient = (clients.data ?? []).find((c: any) => c.id === clientId);
              const { missingFields } = clientCompleteness(selectedClient);
              return missingFields.length > 0 ? (
                <div className="flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                  <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                  <span>Profil incomplet — manquant : {missingFields.join(", ")}.</span>
                </div>
              ) : null;
            })()}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Référence OF client</Label>
              <Input value={clientOfRef} onChange={(e) => setClientOfRef(e.target.value)} placeholder="Réf. client…" />
            </div>
            <div className="space-y-2">
              <Label>Numéro BL</Label>
              <Input value={blNumber} onChange={(e) => setBlNumber(e.target.value)} placeholder="BL-XXXXXX…" />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Lignes</Label>
              <Button variant="outline" size="sm" onClick={() => setLines((l) => [...l, { product_variant_id: "", quantity: 1 }])}>
                <Plus className="h-3.5 w-3.5" /> Ligne
              </Button>
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => {
                const v = vMap.get(l.product_variant_id);
                const lineWeight = l.product_variant_id && l.quantity > 0
                  ? Number(l.quantity) * Number(v?.weight ?? 0)
                  : null;
                return (
                  <div key={i} className="flex items-center gap-2">
                    <div className="flex-1">
                      <Select value={l.product_variant_id} onValueChange={(val) => setLines((arr) => arr.map((x, j) => (j === i ? { ...x, product_variant_id: val } : x)))}>
                        <SelectTrigger><SelectValue placeholder="Produit" /></SelectTrigger>
                        <SelectContent>
                          {(variants.data ?? []).map((v: any) => (
                            <SelectItem key={v.id} value={v.id}>
                              <span className="font-mono text-xs mr-2">{v.reference}</span>
                              {v.name}
                              {Number(v.weight) > 0
                                ? <span className="ml-2 text-muted-foreground text-xs">· {fmtKg(v.weight)}/u.</span>
                                : <span className="ml-2 text-warning text-xs">· poids manquant</span>
                              }
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Input
                      type="number" min="1" className="w-20"
                      value={l.quantity}
                      onChange={(e) => setLines((arr) => arr.map((x, j) => (j === i ? { ...x, quantity: parseInt(e.target.value, 10) || 0 } : x)))}
                    />
                    <div className="w-24 text-right text-sm tabular text-muted-foreground">
                      {lineWeight !== null ? fmtKg(lineWeight) : "—"}
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => setLines((arr) => arr.filter((_, j) => j !== i))} disabled={lines.length === 1}>
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm space-y-1">
            <div className="flex justify-between border-t border-border pt-1">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Poids total estimé</span>
              <span className="font-display text-lg font-semibold tabular">{fmtKg(totals.weight)}</span>
            </div>
            {totals.hasZeroWeight && totals.items.length > 0 && (
              <p className="text-xs text-warning">⚠ Un ou plusieurs produits n'ont pas de poids renseigné.</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>Enregistrer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type PalletDraft = {
  label: string;
  palette_type_id: string; // "custom" = personnalisée
  tare_weight: string;
  longueur: string;
  largeur: string;
};

function emptyPallet(): PalletDraft {
  return { label: "", palette_type_id: "custom", tare_weight: "", longueur: "", largeur: "" };
}

// Fallback si palette_types est vide ou indisponible en DB (migration non appliquée)
const FALLBACK_PALETTE_TYPES: { id: string; label: string; length: number; width: number; poids_max: number; tare_weight: number }[] = [
  { id: "fallback-eur",      label: "Palette Europe 80x120",   length: 120, width: 80, poids_max: 1500, tare_weight: 10   },
  { id: "fallback-std",      label: "Palette Standard 80x120", length: 120, width: 80, poids_max: 1500, tare_weight: 0.7  },
  { id: "fallback-demi",     label: "Demi-palette 40x60",      length:  60, width: 40, poids_max:  750, tare_weight: 0.4  },
];

function NewShipmentDialog() {
  const sb = supabase as any;
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [blNumber, setBlNumber] = useState("");
  const [clientOfRef, setClientOfRef] = useState("");
  const [status, setStatus] = useState<LivraisonStatus>("draft");
  const [lines, setLines] = useState<ShipmentLineDraft[]>([{ product_variant_id: "", quantity: 1 }]);
  const [pallets, setPallets] = useState<PalletDraft[]>([]);

  const clients = useQuery({
    queryKey: ["clients"],
    queryFn: async () => {
      const { data, error } = await sb.from("clients").select("id,name").order("name");
      if (error) throw error;
      return data;
    },
  });

  // Poids unitaire — chemin critique, sans nb_par_palette pour éviter 400 si migration absente
  const variants = useQuery({
    queryKey: ["product_variants", "weights"],
    queryFn: async () => {
      const { data, error } = await sb
        .from("product_variants")
        .select("id,reference,name,weight")
        .order("reference");
      if (error) throw error;
      return data;
    },
  });

  // Capacité par palette — requête séparée, échec silencieux (suggestion seulement)
  const variantsCapacity = useQuery({
    queryKey: ["product_variants", "capacity"],
    queryFn: async () => {
      const { data, error } = await sb
        .from("product_variants")
        .select("id,nb_par_palette");
      if (error) return [] as any[];
      return (data ?? []) as any[];
    },
  });

  const paletteTypes = useQuery({
    queryKey: ["palette_types"],
    queryFn: async () => {
      const { data, error } = await sb.from("palette_types").select("*").order("label");
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  // Si la table palette_types n'existe pas encore en DB, on utilise les types standards hardcodés
  const effectivePaletteTypes = (paletteTypes.data ?? []).length > 0
    ? (paletteTypes.data ?? [])
    : FALLBACK_PALETTE_TYPES;

  const ptMap = useMemo(
    () => new Map(effectivePaletteTypes.map((p: any) => [p.id, p])),
    [effectivePaletteTypes]
  );

  const vMap = useMemo(() => {
    const m = new Map<string, { weight: number }>();
    (variants.data ?? []).forEach((v: any) =>
      m.set(v.id, { weight: Number(v.weight ?? 0) })
    );
    return m;
  }, [variants.data]);

  // Map capacité pour la suggestion — nullable, pas critique
  const capacityMap = useMemo(() => {
    const m = new Map<string, number>();
    (variantsCapacity.data ?? []).forEach((v: any) =>
      m.set(v.id, Number(v.nb_par_palette ?? 0))
    );
    return m;
  }, [variantsCapacity.data]);

  const productWeight = useMemo(() => {
    return lines
      .filter((l) => l.product_variant_id && l.quantity > 0)
      .reduce((sum, l) => {
        const v = vMap.get(l.product_variant_id);
        return sum + Number(l.quantity) * Number(v?.weight ?? 0);
      }, 0);
  }, [lines, vMap]);

  const lineItems = useMemo(() => {
    return lines
      .filter((l) => l.product_variant_id && l.quantity > 0)
      .map((l) => {
        const v = vMap.get(l.product_variant_id);
        return { ...l, weight: Number(l.quantity) * Number(v?.weight ?? 0) };
      });
  }, [lines, vMap]);

  const palletTareWeight = useMemo(() =>
    pallets.reduce((sum, p) => sum + Number(p.tare_weight || 0), 0),
  [pallets]);

  const totalWeight = productWeight + palletTareWeight;
  const hasZeroWeight = lineItems.some((it) => it.weight === 0) && lineItems.length > 0;


  // Suggestion automatique : ceil(qty / nb_par_palette) par variant
  const palletSuggestion = useMemo(() => {
    const validLines = lines.filter((l) => l.product_variant_id && l.quantity > 0);
    if (validLines.length === 0 || !variants.data) return null;

    // Aggregate by variant
    const byVariant = new Map<string, { qty: number; vd: any }>();
    for (const l of validLines) {
      const vd = (variants.data as any[]).find((v: any) => v.id === l.product_variant_id);
      const cur = byVariant.get(l.product_variant_id);
      if (cur) cur.qty += l.quantity;
      else byVariant.set(l.product_variant_id, { qty: l.quantity, vd });
    }

    const details: { reference: string; name: string; qty: number; maxPerPallet: number; palletsNeeded: number }[] = [];
    let totalNeeded = 0;
    for (const [vid, { qty, vd }] of byVariant) {
      const max = capacityMap.get(vid) ?? 0;
      if (max <= 0) continue;
      const n = Math.ceil(qty / max);
      totalNeeded += n;
      details.push({ reference: vd?.reference ?? "?", name: vd?.name ?? "?", qty, maxPerPallet: max, palletsNeeded: n });
    }
    if (details.length === 0) return null;

    // Recommend palette type: prefer EUR label, else first
    const recommended = effectivePaletteTypes.find((pt: any) => /eur/i.test(pt.label)) ?? effectivePaletteTypes[0] ?? null;
    return { totalNeeded, details, recommended };
  }, [lines, variants.data, capacityMap, effectivePaletteTypes]);

  function applySuggestion() {
    if (!palletSuggestion) return;
    const { totalNeeded, recommended } = palletSuggestion;
    setPallets(
      Array.from({ length: totalNeeded }, () =>
        recommended
          ? {
              label: "",
              palette_type_id: recommended.id,
              // tare_weight = poids vide de la palette (pas poids_max = charge max)
              tare_weight: String(recommended.tare_weight ?? ""),
              longueur: String(recommended.length ?? ""),
              largeur: String(recommended.width ?? ""),
            }
          : emptyPallet()
      )
    );
  }

  // Validation palette par palette — tare obligatoire pour tous, dimensions uniquement pour custom
  const palletErrors = useMemo(() => pallets.map((p) => {
    const isCustom = p.palette_type_id === "custom";
    if (isCustom && (!p.tare_weight || Number(p.tare_weight) <= 0)) return "Poids vide requis";
    if (isCustom && (!p.longueur || !p.largeur)) return "Dimensions requises (palette personnalisée)";
    return null;
  }), [pallets]);

  const hasPalletErrors = palletErrors.some(Boolean);
  const canSubmit = clientId && lineItems.length > 0 && pallets.length > 0 && !hasPalletErrors;

  function setPalletField(i: number, field: keyof PalletDraft, value: string) {
    setPallets((arr) => arr.map((p, j) => j === i ? { ...p, [field]: value } : p));
  }

  function selectPalletType(i: number, typeId: string) {
    const pt = ptMap.get(typeId);
    setPallets((arr) => arr.map((p, j) => j === i ? {
      ...p,
      palette_type_id: typeId,
      // tare_weight = poids vide de la palette (champ tare_weight, pas poids_max qui est la charge max)
      tare_weight: pt ? String(pt.tare_weight ?? "") : p.tare_weight,
      longueur: pt ? String(pt.length ?? "") : p.longueur,
      largeur: pt ? String(pt.width ?? "") : p.largeur,
    } : p));
  }

  function reset() {
    setClientId(""); setBlNumber(""); setClientOfRef(""); setStatus("draft");
    setLines([{ product_variant_id: "", quantity: 1 }]);
    setPallets([]);
  }

  const create = useMutation({
    mutationFn: async () => {
      if (!clientId) throw new Error("Client requis");
      if (lineItems.length === 0) throw new Error("Ajoutez au moins une ligne produit");
      if (pallets.length === 0) throw new Error("Au moins une palette est requise");
      for (const p of pallets) {
        if (!p.tare_weight || Number(p.tare_weight) <= 0) throw new Error("Toutes les palettes doivent avoir un poids tare > 0");
        if (p.palette_type_id === "custom" && (!p.longueur || !p.largeur)) throw new Error("Les palettes personnalisées doivent avoir longueur et largeur");
      }

      // total_weight sera recalculé par trigger DB — on envoie 0 comme placeholder
      const { data: shipment, error: shipmentError } = await sb
        .from("shipments")
        .insert({ client_id: clientId, status, total_weight: 0, total_pallets: 0, bl_number: blNumber.trim() || null, client_of_reference: clientOfRef.trim() || null })
        .select("id")
        .single();
      if (shipmentError) throw shipmentError;

      const { error: lineError } = await sb.from("shipment_lines").insert(
        lineItems.map((it) => ({
          shipment_id: shipment.id,
          product_variant_id: it.product_variant_id,
          quantity: it.quantity,
          weight: it.weight,
        }))
      );
      if (lineError) throw lineError;

      const { error: palletError } = await sb.from("shipment_pallets").insert(
        pallets.map((p, i) => {
          const pt = ptMap.get(p.palette_type_id);
          const tare = Number(p.tare_weight);
          return {
            shipment_id: shipment.id,
            label: p.label.trim() || `Palette ${i + 1}`,
            type: pt ? pt.label : "custom",
            tare_weight: tare,
            weight: tare,
            depth: p.longueur !== "" ? Number(p.longueur) : null,
            width: p.largeur !== "" ? Number(p.largeur) : null,
          };
        })
      );
      if (palletError) throw palletError;
      // Le trigger tg_sync_shipment_totals_pallets met à jour total_weight + total_pallets
    },
    onSuccess: () => {
      toast.success(MSG.SHIPMENT_CREATED);
      qc.invalidateQueries({ queryKey: ["shipments"] });
      setOpen(false);
      reset();
    },
    onError: (e: unknown) => toast.error(parseSupabaseError(e)),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button><Plus className="h-4 w-4" /> Nouveau shipment</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>Nouveau shipment</DialogTitle></DialogHeader>
        <div className="space-y-5 py-2">

          {/* Références OF client + BL */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Référence OF client <span className="text-muted-foreground font-normal">(optionnel)</span></Label>
              <Input
                placeholder="ex: CMD-2026-042"
                value={clientOfRef}
                onChange={(e) => setClientOfRef(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Numéro BL <span className="text-muted-foreground font-normal">(optionnel)</span></Label>
              <Input
                placeholder="ex: BL-2026-001"
                value={blNumber}
                onChange={(e) => setBlNumber(e.target.value)}
              />
            </div>
          </div>

          {/* Client + statut */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Client</Label>
              <Select value={clientId} onValueChange={setClientId}>
                <SelectTrigger><SelectValue placeholder="Sélectionner un client" /></SelectTrigger>
                <SelectContent>
                  {(clients.data ?? []).map((c: any) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {clientId && (() => {
                const selectedClient = (clients.data ?? []).find((c: any) => c.id === clientId);
                const { missingFields } = clientCompleteness(selectedClient);
                return missingFields.length > 0 ? (
                  <div className="flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                    <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                    <span>Profil incomplet — manquant : {missingFields.join(", ")}. Le BL sera incomplet.</span>
                  </div>
                ) : null;
              })()}
            </div>
            <div className="space-y-2">
              <Label>Statut</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as LivraisonStatus)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Brouillon</SelectItem>
                  <SelectItem value="ready">Prêt</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Lignes produits */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Produits</Label>
              <Button variant="outline" size="sm" onClick={() => setLines((l) => [...l, { product_variant_id: "", quantity: 1 }])}>
                <Plus className="h-3.5 w-3.5" /> Ligne
              </Button>
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => {
                const v = vMap.get(l.product_variant_id);
                const lineWeight = l.product_variant_id && l.quantity > 0
                  ? Number(l.quantity) * Number(v?.weight ?? 0) : null;
                return (
                  <div key={i} className="flex items-center gap-2">
                    <div className="flex-1">
                      <Select value={l.product_variant_id} onValueChange={(val) => setLines((arr) => arr.map((x, j) => (j === i ? { ...x, product_variant_id: val } : x)))}>
                        <SelectTrigger><SelectValue placeholder="Produit" /></SelectTrigger>
                        <SelectContent>
                          {(variants.data ?? []).map((v: any) => (
                            <SelectItem key={v.id} value={v.id}>
                              <span className="font-mono text-xs mr-2">{v.reference}</span>{v.name}
                              {Number(v.weight) > 0
                                ? <span className="ml-2 text-muted-foreground text-xs">· {fmtKg(v.weight)}/u.</span>
                                : <span className="ml-2 text-warning text-xs">· poids manquant</span>}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Input type="number" min="1" className="w-20"
                      value={l.quantity}
                      onChange={(e) => setLines((arr) => arr.map((x, j) => (j === i ? { ...x, quantity: parseInt(e.target.value, 10) || 0 } : x)))} />
                    <div className="w-20 text-right text-sm tabular text-muted-foreground">
                      {lineWeight !== null ? fmtKg(lineWeight) : "—"}
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => setLines((arr) => arr.filter((_, j) => j !== i))} disabled={lines.length === 1}>
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Palettes */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Palettes <span className="text-destructive ml-0.5">*</span></Label>
              <Button variant="outline" size="sm" onClick={() => setPallets((p) => [...p, emptyPallet()])}>
                <Plus className="h-3.5 w-3.5" /> Palette
              </Button>
            </div>

            {/* Suggestion automatique */}
            {palletSuggestion && (
              <div className="rounded-md border border-info/40 bg-info/5 px-3 py-2.5 mb-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-info">
                    Suggestion : {palletSuggestion.totalNeeded} palette{palletSuggestion.totalNeeded > 1 ? "s" : ""} nécessaire{palletSuggestion.totalNeeded > 1 ? "s" : ""}
                    {palletSuggestion.recommended && (
                      <span className="ml-1 text-muted-foreground font-normal">· type {palletSuggestion.recommended.label}</span>
                    )}
                  </div>
                  <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={applySuggestion}>
                    Appliquer
                  </Button>
                </div>
                <ul className="text-xs text-muted-foreground space-y-0.5">
                  {palletSuggestion.details.map((d, i) => (
                    <li key={i}>
                      <span className="font-mono">{d.reference}</span> — {d.qty} u. ÷ {d.maxPerPallet}/pal. = <span className="font-medium text-foreground">{d.palletsNeeded} pal.</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {pallets.length === 0 && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                ⚠ Au moins une palette est requise pour créer un shipment.
              </div>
            )}
            <div className="space-y-3">
              {pallets.map((p, i) => {
                const pt = ptMap.get(p.palette_type_id);
                const isCustom = p.palette_type_id === "custom";
                const err = palletErrors[i];
                return (
                  <div key={i} className={`rounded-md border p-3 space-y-2 bg-muted/20 ${err ? "border-destructive/60" : "border-border"}`}>
                    {/* Label + type selector */}
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder={`Palette ${i + 1}`}
                        className="flex-1 h-8 text-sm"
                        value={p.label}
                        onChange={(e) => setPalletField(i, "label", e.target.value)}
                      />
                      <div className="w-52">
                        <Select value={p.palette_type_id} onValueChange={(v) => selectPalletType(i, v)}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Sélectionner…" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="custom">Personnalisée…</SelectItem>
                            {effectivePaletteTypes.map((pt: any) => (
                              <SelectItem key={pt.id} value={pt.id}>
                                {pt.label} ({pt.tare_weight} kg)
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setPallets((arr) => arr.filter((_, j) => j !== i))}>
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </div>

                    {/* Standard : affichage read-only des valeurs figées depuis DB */}
                    {!isCustom && pt && (
                      <div className="flex gap-4 text-xs text-muted-foreground bg-muted/40 rounded px-2 py-1.5">
                        <span>{pt.length} × {pt.width} cm</span>
                        <span>·</span>
                        <span>Tare : <span className="font-medium text-foreground">{fmtKg(pt.tare_weight)}</span></span>
                        <span>·</span>
                        <span>Charge max : {fmtKg(pt.poids_max)}</span>
                      </div>
                    )}

                    {/* Custom : champs de saisie */}
                    {isCustom && (
                      <div className="grid grid-cols-3 gap-2">
                        <div className="space-y-1">
                          <Label className="text-xs">Longueur (cm)</Label>
                          <Input type="number" min="0" className="h-8 text-sm"
                            value={p.longueur} onChange={(e) => setPalletField(i, "longueur", e.target.value)}
                            placeholder="ex: 80" />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Largeur (cm)</Label>
                          <Input type="number" min="0" className="h-8 text-sm"
                            value={p.largeur} onChange={(e) => setPalletField(i, "largeur", e.target.value)}
                            placeholder="ex: 120" />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Poids vide (kg) <span className="text-destructive">*</span></Label>
                          <Input type="number" min="0" step="0.1" className="h-8 text-sm"
                            value={p.tare_weight} onChange={(e) => setPalletField(i, "tare_weight", e.target.value)}
                            placeholder="ex: 22" />
                        </div>
                      </div>
                    )}

                    {err && <p className="text-xs text-destructive">{err}</p>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Récapitulatif poids */}
          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm space-y-1.5">
            <div className="flex justify-between text-muted-foreground">
              <span>Poids produits</span>
              <span className="tabular font-medium text-foreground">{fmtKg(productWeight)}</span>
            </div>
            {pallets.length > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>Palettes vides ({pallets.length})</span>
                <span className="tabular font-medium text-foreground">{fmtKg(palletTareWeight)}</span>
              </div>
            )}
            <div className="flex justify-between border-t border-border pt-1.5">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Poids total expédition</span>
              <span className="font-display text-lg font-semibold tabular">{fmtKg(totalWeight)}</span>
            </div>
            {hasZeroWeight && (
              <p className="text-xs text-warning">⚠ Certains produits n'ont pas de poids renseigné.</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setOpen(false); reset(); }}>Annuler</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || !canSubmit}>
            Créer le shipment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Bon de Livraison (document imprimable) ────────────────────────────────────

function BLDocumentDialog({ group, onClose }: { group: { blNumber: string; shipments: any[] }; onClose: () => void }) {
  // Aggregate data from all shipments in the BL group
  let client: any = null;
  let latestDate = "";
  const allLines: any[] = [];
  const allPallets: any[] = [];

  for (const s of group.shipments) {
    if (!client && s.client_entity) client = s.client_entity;
    if (s.created_at > latestDate) latestDate = s.created_at;
    allLines.push(...(s.lines ?? []));
    allPallets.push(...(s.pallets ?? []));
  }

  // Consolidate lines by variant reference
  const linesByVariant = new Map<string, { variant: any; quantity: number; weight: number }>();
  for (const l of allLines) {
    const key = l.variant?.reference ?? l.product_variant_id ?? "?";
    const cur = linesByVariant.get(key);
    if (cur) { cur.quantity += Number(l.quantity ?? 0); cur.weight += Number(l.displayWeight ?? 0); }
    else linesByVariant.set(key, { variant: l.variant, quantity: Number(l.quantity ?? 0), weight: Number(l.displayWeight ?? 0) });
  }

  const totalProductWeight = allLines.reduce((s, l) => s + Number(l.displayWeight ?? 0), 0);
  const totalTareWeight = allPallets.reduce((s, p) => s + Number(p.weight ?? 0), 0);
  const totalWeight = totalProductWeight + totalTareWeight;
  const status = blGroupStatus(group.shipments);
  const statusMeta = livraisonStatusMeta[status];
  const address = client ? [client.address, client.postal_code, client.city, client.country].filter(Boolean).join(", ") : null;

  const { missingFields: missingClientFields } = clientCompleteness(client);

  const Needed = () => (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-amber-100 text-amber-700 border border-amber-300 rounded px-1.5 py-0.5 print:hidden">
      À renseigner
    </span>
  );

  const refs = group.shipments.map((s) => s.client_of_reference).filter(Boolean);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader className="print:hidden flex-row items-center justify-between">
          <DialogTitle className="flex items-center gap-2">
            <Truck className="h-4 w-4" /> Bon de Livraison — BL {group.blNumber}
          </DialogTitle>
          {missingClientFields.length > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              Profil client incomplet ({missingClientFields.length} champ{missingClientFields.length > 1 ? "s" : ""} manquant{missingClientFields.length > 1 ? "s" : ""})
            </div>
          )}
        </DialogHeader>

        {/* ─── Document imprimable ─── */}
        <div className="space-y-5 text-sm">

          {/* En-tête */}
          <div className="flex items-start justify-between gap-4 border-b-2 border-foreground pb-4">
            <div className="flex items-center gap-3">
              <img src={agecetLogo} alt="ESAT AGECET" className="h-14 w-auto rounded" />
              <div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground">ESAT AGECET</div>
                <div className="font-bold text-xl leading-tight">Bon de Livraison</div>
              </div>
            </div>
            <div className="text-right space-y-1">
              <div className="font-mono font-bold text-2xl text-info">BL {group.blNumber}</div>
              <div className="text-xs text-muted-foreground">{fmtDate(latestDate)}</div>
              <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${statusMeta?.cls ?? "bg-muted text-muted-foreground"}`}>
                {statusMeta?.label ?? status}
              </span>
            </div>
          </div>

          {group.shipments.length > 1 && (
            <div className="text-[11px] text-muted-foreground">
              {group.shipments.length} expéditions : {group.shipments.map((s) => s.reference ?? s.id?.slice(0, 8)).join(" · ")}
            </div>
          )}

          {/* Destinataire + Contact */}
          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-widest font-semibold text-muted-foreground border-b pb-1">Destinataire</div>
              {client ? (
                <div className="space-y-0.5">
                  <div className="font-semibold text-base">{client.name}</div>
                  {address
                    ? <div className="text-xs text-muted-foreground">{address}</div>
                    : <div className="flex items-center gap-1.5 text-xs text-muted-foreground">Adresse : <Needed /></div>
                  }
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">Client inconnu — <Needed /></div>
              )}
            </div>

            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-widest font-semibold text-muted-foreground border-b pb-1">Contact & Références</div>
              <div className="space-y-0.5 text-xs">
                {client?.contact_name
                  ? <div>{client.contact_name}</div>
                  : <div className="flex items-center gap-1.5 text-muted-foreground">Contact : <Needed /></div>
                }
                {client?.phone
                  ? <div className="flex items-center gap-1"><Phone className="h-3 w-3 text-muted-foreground" /> {client.phone}</div>
                  : <div className="flex items-center gap-1.5 text-muted-foreground">Téléphone : <Needed /></div>
                }
                {client?.email
                  ? <div className="flex items-center gap-1"><Mail className="h-3 w-3 text-muted-foreground" /> {client.email}</div>
                  : <div className="flex items-center gap-1.5 text-muted-foreground">E-mail : <Needed /></div>
                }
                {refs.length > 0 && (
                  <div className="pt-1 border-t border-border font-mono font-medium">OF : {refs.join(" · ")}</div>
                )}
              </div>
            </div>
          </div>

          {/* Logistique — données non disponibles en DB */}
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-2">
            <div className="text-[11px] uppercase tracking-widest font-semibold text-amber-700 flex items-center gap-1.5">
              <AlertTriangle className="h-3 w-3 print:hidden" /> Logistique <span className="font-normal text-amber-600">(à compléter manuellement)</span>
            </div>
            <div className="grid grid-cols-3 gap-4 text-xs">
              {["Transporteur", "Date de livraison prévue", "Instructions spéciales"].map((label) => (
                <div key={label}>
                  <div className="text-muted-foreground mb-1">{label}</div>
                  <div className="h-7 border-b border-dashed border-amber-300" />
                </div>
              ))}
            </div>
          </div>

          {/* Lignes produits */}
          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-widest font-semibold text-muted-foreground border-b pb-1">Produits expédiés</div>
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2 font-medium">Référence</th>
                  <th className="text-left p-2 font-medium">Désignation</th>
                  <th className="text-right p-2 font-medium">Quantité</th>
                  <th className="text-right p-2 font-medium">Poids/u.</th>
                  <th className="text-right p-2 font-medium">Poids ligne</th>
                </tr>
              </thead>
              <tbody>
                {[...linesByVariant.values()].map((item, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="p-2 font-mono">{item.variant?.reference ?? "—"}</td>
                    <td className="p-2">{item.variant?.name ?? "—"}</td>
                    <td className="p-2 text-right tabular">{fmtInt(item.quantity)}</td>
                    <td className="p-2 text-right tabular">{item.variant?.weight ? fmtKg(item.variant.weight) : "—"}</td>
                    <td className="p-2 text-right tabular font-medium">{fmtKg(item.weight)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-foreground bg-muted/30 font-semibold">
                  <td className="p-2" colSpan={2}>Total produits</td>
                  <td className="p-2 text-right tabular">{fmtInt([...linesByVariant.values()].reduce((s, it) => s + it.quantity, 0))} u.</td>
                  <td />
                  <td className="p-2 text-right tabular">{fmtKg(totalProductWeight)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Palettes */}
          {allPallets.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-widest font-semibold text-muted-foreground border-b pb-1">Conditionnement</div>
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left p-2 font-medium">Palette</th>
                    <th className="text-left p-2 font-medium">Type</th>
                    <th className="text-right p-2 font-medium">Dimensions</th>
                    <th className="text-right p-2 font-medium">Tare</th>
                  </tr>
                </thead>
                <tbody>
                  {allPallets.map((p, i) => {
                    const dims = [p.depth, p.width].filter(Boolean);
                    return (
                      <tr key={p.id ?? i} className="border-t border-border">
                        <td className="p-2 font-medium">{p.label || `Palette ${i + 1}`}</td>
                        <td className="p-2 text-muted-foreground">{p.type ?? "—"}</td>
                        <td className="p-2 text-right">{dims.length > 0 ? `${dims.join(" × ")} cm` : "—"}</td>
                        <td className="p-2 text-right tabular">{fmtKg(p.weight ?? 0)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Récapitulatif poids */}
          <div className="rounded-md border border-border bg-muted/20 p-4 space-y-1.5 text-sm">
            <div className="font-semibold text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Récapitulatif poids</div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Poids produits</span>
              <span className="font-medium tabular">{fmtKg(totalProductWeight)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Palettes vides ({allPallets.length})</span>
              <span className="font-medium tabular">{fmtKg(totalTareWeight)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-1.5 font-bold text-base">
              <span>Poids total expédition</span>
              <span className="tabular">{fmtKg(totalWeight)}</span>
            </div>
          </div>

          {/* Zones de signature */}
          <div className="grid grid-cols-2 gap-8 pt-4 border-t border-border">
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-widest font-semibold text-muted-foreground">Émis par l'ESAT</div>
              <div className="h-16 border-b border-dashed border-border" />
              <div className="text-xs text-muted-foreground">Nom, signature et date</div>
            </div>
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-widest font-semibold text-muted-foreground">Reçu par le client / transporteur</div>
              <div className="h-16 border-b border-dashed border-border" />
              <div className="text-xs text-muted-foreground">Nom, signature et date</div>
            </div>
          </div>
        </div>

        <DialogFooter className="print:hidden">
          <Button variant="outline" onClick={onClose}>Fermer</Button>
          <Button onClick={() => window.print()} className="gap-2">
            <Printer className="h-4 w-4" /> Imprimer / PDF
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Dialog détail conditionnement palettes ───────────────────────────────────

function PalettesDetailDialog({ shipment, onClose }: { shipment: any; onClose: () => void }) {
  const linesById = new Map<string, any>((shipment.lines ?? []).map((l: any) => [l.id, l]));

  const palettes = (shipment.pallets ?? []).map((p: any) => {
    const tare = Number(p.weight ?? 0);
    const contentWeight = (p.pallet_lines ?? []).reduce((sum: number, pl: any) => {
      const line = linesById.get(pl.shipment_line_id);
      const unitWeight = Number(line?.variant?.weight ?? 0);
      return sum + pl.quantity * unitWeight;
    }, 0);
    return { ...p, tare, contentWeight, totalWeight: tare + contentWeight };
  });

  const totalTare = palettes.reduce((s: number, p: any) => s + p.tare, 0);
  // Use shipment lines aggregate when pallet_lines not assigned per-palette
  const anyPalletLines = palettes.some((p: any) => (p.pallet_lines ?? []).length > 0);
  const totalContent = anyPalletLines
    ? palettes.reduce((s: number, p: any) => s + p.contentWeight, 0)
    : (shipment.lines ?? []).reduce((s: number, l: any) => s + Number(l.displayWeight ?? 0), 0);
  const totalWeight = totalTare + totalContent;
  const hasMissingWeight = (shipment.lines ?? []).some(
    (l: any) => !l.displayWeight || Number(l.displayWeight) === 0
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto data-[state=open]:slide-in-from-left-[0%] data-[state=open]:slide-in-from-top-[0%]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4" />
            Conditionnement — {shipment.reference ?? shipment.id?.slice(0, 8)}
          </DialogTitle>
        </DialogHeader>

        {palettes.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            Aucune palette enregistrée pour cette expédition.
          </p>
        ) : (
          <div className="space-y-3">
            {palettes.map((p: any, i: number) => {
              const dims = [p.depth, p.width].filter(Boolean);
              return (
                <div key={p.id} className="rounded-md border border-border bg-muted/20 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <span className="font-semibold text-sm">{p.label || `Palette ${i + 1}`}</span>
                      {p.type && <span className="ml-2 text-xs text-muted-foreground">{p.type}</span>}
                    </div>
                    <span className="text-xs font-semibold tabular">{fmtKg(p.tare)}</span>
                  </div>

                  {dims.length > 0 && (
                    <div className="text-xs">
                      <div className="text-muted-foreground">Dimensions</div>
                      <div className="font-medium">{dims.join(" × ")} cm</div>
                    </div>
                  )}

                  {(p.pallet_lines ?? []).length > 0 && (
                    <div className="border-t border-border/50 pt-2 space-y-0.5">
                      {(p.pallet_lines as any[]).map((pl: any) => {
                        const line = linesById.get(pl.shipment_line_id);
                        const lineWeight = pl.quantity * Number(line?.variant?.weight ?? 0);
                        return (
                          <div key={pl.id} className="flex items-center justify-between text-xs text-muted-foreground">
                            <span className="truncate font-mono">{line?.variant?.reference ?? "—"}</span>
                            <span className="shrink-0 ml-2">{fmtInt(pl.quantity)} u. · {fmtKg(lineWeight)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {palettes.length > 0 && (
          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1 text-sm mt-2">
            <div className="font-semibold text-xs uppercase tracking-wider text-muted-foreground mb-2">Récapitulatif</div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Nombre de palettes</span>
              <span className="font-medium tabular">{palettes.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Poids palettes vides</span>
              <span className="font-medium tabular">{fmtKg(totalTare)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Poids marchandises</span>
              <span className="font-medium tabular">{fmtKg(totalContent)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-1 mt-1">
              <span className="font-semibold">Poids total expédition</span>
              <span className="font-semibold tabular">{fmtKg(totalWeight)}</span>
            </div>
            {hasMissingWeight && (
              <p className="text-[11px] text-warning mt-1">⚠ Certains produits n'ont pas de poids renseigné — totaux indicatifs.</p>
            )}
          </div>
        )}

        <DialogFooter className="mt-2">
          <Button variant="outline" size="sm" onClick={onClose}>Fermer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
