import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Plus, Search, Trash2, Truck, Phone, Mail, MapPin, X, Pencil, Layers } from "lucide-react";
import { fmtDate, fmtInt, fmtKg, fmtPalette } from "@/lib/format";
import { livraisonStatusMeta, normalizeLivraisonStatus, type LivraisonStatus } from "@/lib/domain";
import { UI } from "@/lib/uiLabels";
import { MSG } from "@/lib/messages";
import agecetLogo from "@/assets/logo_agecet_hands.jpg";

export const Route = createFileRoute("/livraisons")({
  head: () => ({
    meta: [
      { title: "Livraisons — Coffret ERP" },
      { name: "description", content: "Préparation, palettisation et suivi des expéditions." },
    ],
  }),
  component: LivraisonsPage,
});

type ShipmentLineDraft = { product_variant_id: string; quantity: number };

function LivraisonsPage() {
  const sb = supabase as any;
  const qc = useQueryClient();

  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editShipment, setEditShipment] = useState<any | null>(null);
  const [shipSearch, setShipSearch] = useState("");
  const [shipStatus, setShipStatus] = useState<string>("all");
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
    onError: (e: Error) => toast.error(e.message),
  });

  const transitionShipment = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: LivraisonStatus }) => {
      const { error } = await sb.from("shipments").update({ status }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shipments"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const commercialOrders = useQuery({
    queryKey: ["orders", "history"],
    queryFn: async () => {
      const { data: ordersData, error } = await sb
        .from("orders")
        .select("id, created_at, status, client_id")
        .order("created_at", { ascending: false });
      if (error) throw error;

      const orderIds = ((ordersData ?? []) as any[]).map((o) => o.id);
      let linesByOrder = new Map<string, any[]>();
      if (orderIds.length > 0) {
        const { data: linesData, error: linesError } = await sb
          .from("order_lines")
          .select("id,order_id,quantity")
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
        lines: linesByOrder.get(o.id) ?? [],
      }));
    },
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
        (s.client_entity?.city  ?? "").toLowerCase().includes(q) ||
        (s.client_entity?.address ?? "").toLowerCase().includes(q) ||
        String(s.total_weight   ?? "").includes(q)
      );
    }
    return rows;
  }, [shipments.data, shipSearch, shipStatus, dateFrom, dateTo]);

  const activeFilters = (shipStatus !== "all" ? 1 : 0) + (dateFrom ? 1 : 0) + (dateTo ? 1 : 0) + (shipSearch.trim() ? 1 : 0);

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
          <CreateClientDialog />
          <NewShipmentDialog />
        </div>
      </header>

      <ClientHistoryPanel
        shipments={(shipments.data ?? []) as any[]}
        clients={(clientsList.data ?? []) as any[]}
        commercialOrders={(commercialOrders.data ?? []) as any[]}
      />

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
        {filteredShipments.map((s: any) => {
          const status = String(s.status);
          const canPrepare = status === "draft";
          const canLoad = status === "ready";
          const canShip = status === "shipped";
          return (
            <Card key={s.id}>
              <CardHeader className="flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Truck className="h-4 w-4 text-info" />
                    <ClientPopover client={s.client_entity} />
                  </CardTitle>
                  <div className="mt-1 space-y-0.5">
                    {s.client_of_reference && (
                      <div className="font-mono text-sm font-semibold text-foreground">{s.client_of_reference}</div>
                    )}
                    <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-mono">{s.reference ?? s.id}</span>
                      {s.bl_number && (
                        <span className="inline-flex items-center gap-1 font-mono bg-info/10 text-info border border-info/20 rounded px-1.5 py-0">
                          BL {s.bl_number}
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
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setEditShipment(s)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:bg-destructive/10"
                    onClick={() => setDeleteId(s.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-2 flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" className="w-full sm:w-auto" disabled={!canPrepare || transitionShipment.isPending} onClick={() => transitionShipment.mutate({ id: s.id, status: "ready" })}>Préparer</Button>
                  <Button size="sm" variant="outline" className="w-full sm:w-auto" disabled={!canLoad || transitionShipment.isPending} onClick={() => transitionShipment.mutate({ id: s.id, status: "shipped" })}>Expédier</Button>
                  <Button size="sm" variant="outline" className="w-full sm:w-auto" disabled={!canShip || transitionShipment.isPending} onClick={() => transitionShipment.mutate({ id: s.id, status: "delivered" })}>Livrer</Button>
                  <Button asChild size="sm" variant="secondary" className="w-full sm:w-auto gap-1.5">
                    <Link to="/livraisons/$id" params={{ id: s.id }}>
                      <Layers className="h-3.5 w-3.5" />
                      Palettes{s.pallet_count > 0 ? ` (${s.pallet_count})` : ""}
                    </Link>
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
    </div>
  );
}

function ClientHistoryPanel({
  shipments,
  clients,
  commercialOrders,
}: {
  shipments: any[];
  clients: any[];
  commercialOrders: any[];
}) {
  const rows = useMemo(() => {
    const byClient = new Map<string, {
      name: string;
      deliveries: number;
      totalWeight: number;
      totalPallets: number;
      totalUnits: number;
      dates: Date[];
    }>();

    for (const c of clients) {
      byClient.set(c.id, {
        name: c.name,
        deliveries: 0,
        totalWeight: 0,
        totalPallets: 0,
        totalUnits: 0,
        dates: [],
      });
    }

    for (const s of shipments) {
      const key = s.client_id ?? `unknown-${s.id}`;
      const row: {
        name: string;
        deliveries: number;
        totalWeight: number;
        totalPallets: number;
        totalUnits: number;
        dates: Date[];
      } = byClient.get(key) ?? {
        name: s.client_entity?.name ?? "Données manquantes",
        deliveries: 0,
        totalWeight: 0,
        totalPallets: 0,
        totalUnits: 0,
        dates: [],
      };

      row.deliveries += 1;
      row.totalWeight += Number(s.total_weight ?? 0);
      row.totalPallets += Number(s.pallet_count ?? s.total_pallets ?? 0);
      row.dates.push(new Date(s.created_at));

      for (const line of (s.lines ?? []) as any[]) {
        row.totalUnits += Number(line.quantity ?? 0);
      }

      byClient.set(key, row);
    }

    const ordersByClient = new Map<string, number>();
    for (const o of commercialOrders ?? []) {
      const status = String(o.status ?? "").toLowerCase();
      if (status === "canceled" || status === "cancelled") continue;
      const key = o.client_id;
      if (!key) continue;
      const current = ordersByClient.get(key) ?? 0;
      const units = ((o.lines ?? []) as any[]).reduce((s, l) => s + Number(l.quantity ?? 0), 0);
      ordersByClient.set(key, current + units);
    }

    return Array.from(byClient.entries())
      .map(([id, r]) => {
        const dates = [...r.dates].sort((a, b) => a.getTime() - b.getTime());
        const first = dates[0];
        const last = dates[dates.length - 1];
        const avgFreqDays = dates.length <= 1
          ? null
          : Math.round((last.getTime() - first.getTime()) / (1000 * 60 * 60 * 24) / (dates.length - 1));

        return {
          id,
          name: r.name,
          deliveries: r.deliveries,
          totalWeight: r.totalWeight,
          totalPallets: r.totalPallets,
          totalUnits: r.totalUnits,
          avgFreqDays,
          lastDate: last,
          indirectProductionUnits: ordersByClient.get(id) ?? 0,
        };
      })
      .filter((r) => r.deliveries > 0)
      .sort((a, b) => b.deliveries - a.deliveries);
  }, [clients, shipments, commercialOrders]);

  return (
    <Card className="mb-4">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base">Historique clients (shipments / volumes / poids / fréquence)</CardTitle>
        <span className="text-xs text-muted-foreground">{rows.length} client(s) actif(s)</span>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs md:text-sm">
            <thead className="sticky top-[88px] md:top-0 z-10 bg-muted/95 text-[11px] uppercase tracking-wider text-muted-foreground backdrop-blur">
              <tr>
                <th className="text-left p-1.5 md:p-2.5">Client</th>
                <th className="text-right p-1.5 md:p-2.5">Shipments</th>
                <th className="text-right p-1.5 md:p-2.5">Volume (u.)</th>
                <th className="text-right p-1.5 md:p-2.5">Poids total</th>
                <th className="text-right p-1.5 md:p-2.5">Palettes</th>
                <th className="text-right p-1.5 md:p-2.5">Fréquence (j)</th>
                <th className="text-right p-1.5 md:p-2.5">Demande cmd (u.)</th>
                <th className="text-right p-1.5 md:p-2.5">Dernier shipment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="p-1.5 md:p-2.5 font-medium">{r.name}</td>
                  <td className="p-1.5 md:p-2.5 text-right tabular">{fmtInt(r.deliveries)}</td>
                  <td className="p-1.5 md:p-2.5 text-right tabular">{fmtInt(r.totalUnits)}</td>
                  <td className="p-1.5 md:p-2.5 text-right tabular">{fmtKg(r.totalWeight)}</td>
                  <td className="p-1.5 md:p-2.5 text-right tabular">{fmtPalette(r.totalPallets)}</td>
                  <td className="p-1.5 md:p-2.5 text-right tabular">{r.avgFreqDays == null ? "—" : fmtInt(r.avgFreqDays)}</td>
                  <td className="p-1.5 md:p-2.5 text-right tabular">{fmtInt(r.indirectProductionUnits)}</td>
                  <td className="p-1.5 md:p-2.5 text-right tabular text-muted-foreground">{r.lastDate ? fmtDate(r.lastDate.toISOString()) : "—"}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="p-3 text-sm text-muted-foreground" colSpan={8}>Aucun historique client exploitable pour le moment.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function ClientPopover({ client }: { client: any | null }) {
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
        {!client.phone && !client.email && !address && (
          <p className="text-xs text-muted-foreground italic">Aucune coordonnée renseignée.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

function CreateClientDialog() {
  const sb = supabase as any;
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("France");

  const create = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Nom client requis");
      const { error } = await sb.from("clients").insert({
        name: name.trim(),
        address: address.trim() || null,
        postal_code: postalCode.trim() || null,
        city: city.trim() || null,
        country: country.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clients"] });
      toast.success(MSG.CLIENT_CREATED);
      setOpen(false);
      setName("");
      setAddress("");
      setPostalCode("");
      setCity("");
      setCountry("France");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Nouveau client</Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>Créer un client</DialogTitle></DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1">
            <Label>Nom</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Adresse</Label>
            <Textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label>Code postal</Label>
              <Input value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Ville</Label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Pays</Label>
              <Input value={country} onChange={(e) => setCountry(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending}>Créer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

      await sb.from("shipments").update({ client_id: clientId, total_weight: totals.weight, client_of_reference: clientOfRef || null, bl_number: blNumber || null }).eq("id", shipment.id);
      await sb.from("shipment_lines").delete().eq("shipment_id", shipment.id);
      const { error: lineError } = await sb.from("shipment_lines").insert(
        totals.items.map((it) => ({
          shipment_id: shipment.id,
          product_variant_id: it.product_variant_id,
          quantity: it.quantity,
          weight: it.weight,
        }))
      );
      if (lineError) throw lineError;
    },
    onSuccess: () => {
      toast.success(MSG.SHIPMENT_UPDATED);
      qc.invalidateQueries({ queryKey: ["shipments"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
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
    onError: (e: Error) => toast.error(e.message),
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
