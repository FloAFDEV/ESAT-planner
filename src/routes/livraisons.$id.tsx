import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { ArrowLeft, Phone, Mail, MapPin } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { fmtDate, fmtInt, fmtKg, fmtPalette } from "@/lib/format";
import { livraisonStatusMeta, normalizeLivraisonStatus, type LivraisonStatus } from "@/lib/domain";
import { UI } from "@/lib/uiLabels";
import { Button } from "@/components/ui/button";
import agecetLogo from "@/assets/logo_agecet_hands.jpg";

export const Route = createFileRoute("/livraisons/$id")({
  head: () => ({
    meta: [
      { title: "Shipment — Coffret ERP" },
      { name: "description", content: "Détail shipment imprimable." },
    ],
  }),
  component: LivraisonDetail,
});

function LivraisonDetail() {
  const sb = supabase as any;
  const qc = useQueryClient();
  const { id } = Route.useParams();

  const { data, isLoading } = useQuery({
    queryKey: ["shipment", id],
    queryFn: async () => {
      const { data: shipment, error } = await sb
        .from("shipments")
        .select("id,reference,client_id,total_weight,total_pallets,status,created_at")
        .eq("id", id)
        .single();
      if (error) throw error;

      let clientEntity = null;
      if (shipment?.client_id) {
        const { data: clientData, error: clientError } = await sb
          .from("clients")
          .select("id,name,contact_name,phone,email,address,city,postal_code,country")
          .eq("id", shipment.client_id)
          .single();
        if (clientError) throw clientError;
        clientEntity = clientData;
      }

      const { data: lineRows, error: lineError } = await sb
        .from("shipment_lines")
        .select("id,shipment_id,product_variant_id,quantity,weight")
        .eq("shipment_id", id)
        .order("id", { ascending: true });
      if (lineError) throw lineError;

      const variantIds = Array.from(new Set(((lineRows ?? []) as any[]).map((l) => l.product_variant_id).filter(Boolean)));
      let variantMap = new Map<string, any>();
      if (variantIds.length > 0) {
        const { data: variantRows, error: variantError } = await sb
          .from("product_variants")
          .select("id,reference,name,weight")
          .in("id", variantIds);
        if (variantError) throw variantError;
        variantMap = new Map((variantRows ?? []).map((v: any) => [v.id, v]));
      }

      const { data: palletRows, error: palletError } = await sb
        .from("shipment_pallets")
        .select("id,label,type,weight,width,height,depth")
        .eq("shipment_id", id)
        .order("created_at", { ascending: true });
      if (palletError) throw palletError;

      const palletIds = (palletRows ?? []).map((p: any) => p.id).filter(Boolean);
      let palletLinesByPallet = new Map<string, any[]>();
      if (palletIds.length > 0) {
        const { data: palletLineRows, error: palletLineError } = await sb
          .from("shipment_pallet_lines")
          .select("id,pallet_id,shipment_line_id,quantity")
          .in("pallet_id", palletIds);
        if (palletLineError) throw palletLineError;
        for (const pl of (palletLineRows ?? []) as any[]) {
          const current = palletLinesByPallet.get(pl.pallet_id) ?? [];
          const shipmentLine = lineRows.find((l: any) => l.id === pl.shipment_line_id);
          current.push({
            ...pl,
            shipment_line: shipmentLine ? { ...shipmentLine, variant: variantMap.get(shipmentLine.product_variant_id) ?? null } : null,
          });
          palletLinesByPallet.set(pl.pallet_id, current);
        }
      }

      return {
        ...shipment,
        status: normalizeLivraisonStatus(shipment.status),
        client_entity: clientEntity,
        lines: ((lineRows ?? []) as any[]).map((l) => ({ ...l, variant: variantMap.get(l.product_variant_id) ?? null })),
        pallets: (palletRows ?? []).map((p: any) => ({
          ...p,
          pallet_lines: palletLinesByPallet.get(p.id) ?? [],
        })),
      };
    },
  });

  const updateStatus = useMutation({
    mutationFn: async (nextStatus: LivraisonStatus) => {
      const { error } = await sb
        .from("shipments")
        .update({ status: nextStatus })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Statut shipment mis à jour");
      qc.invalidateQueries({ queryKey: ["shipment", id] });
      qc.invalidateQueries({ queryKey: ["shipments"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const status = String(data?.status ?? "");
  const canSetReady = status === "draft";
  const canSetShipped = status === "ready";
  const canSetDelivered = status === "shipped";

  const totals = useMemo(() => {
    const lines = (data?.lines ?? []) as any[];
    const lineWeight = lines.reduce((s, it) => s + Number(it.weight ?? 0), 0);
    const palletWeight = ((data?.pallets ?? []) as any[]).reduce((s, p) => s + Number(p.weight ?? 0), 0);
    return {
      weight: Number(data?.total_weight ?? lineWeight + palletWeight),
      pallets: Number(data?.total_pallets ?? (data?.pallets ?? []).length),
    };
  }, [data]);

  if (isLoading) {
    return <div className="p-4 md:p-8 max-w-7xl mx-auto text-sm text-muted-foreground">Chargement...</div>;
  }

  if (!data) {
    return <div className="p-4 md:p-8 max-w-7xl mx-auto text-sm text-muted-foreground">Données manquantes</div>;
  }

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      <div className="print:hidden mb-4 flex items-center justify-between gap-2">
        <Link
          to="/livraisons"
          className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Retour
        </Link>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="p-6 border-b border-border flex items-start justify-between gap-4">
          <div>
            <img src={agecetLogo} alt="ESAT AGECET" className="h-10 w-auto rounded-sm border border-border mb-3" />
            <h1 className="text-xl font-semibold">{UI.livraisons} · Shipment</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Référence {data.reference ?? "Données manquantes"} · {fmtDate(data.created_at)}
            </p>
          </div>
          <div>
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${livraisonStatusMeta[status ?? ""]?.cls ?? "bg-muted text-muted-foreground"}`}>
              {livraisonStatusMeta[status ?? ""]?.label ?? "Données manquantes"}
            </span>
          </div>
        </div>

        <div className="p-6 grid md:grid-cols-2 gap-6">
          <div>
            <h2 className="text-sm font-semibold mb-2">Client</h2>
            <p className="text-sm font-medium">{data.client_entity?.name ?? "Données manquantes"}</p>
            {data.client_entity?.contact_name && (
              <p className="text-sm text-muted-foreground mt-0.5">{data.client_entity.contact_name}</p>
            )}
            {data.client_entity?.phone && (
              <a href={`tel:${data.client_entity.phone}`} className="mt-1 flex items-center gap-1.5 text-sm hover:underline">
                <Phone className="h-3.5 w-3.5 text-muted-foreground" /> {data.client_entity.phone}
              </a>
            )}
            {data.client_entity?.email && (
              <a href={`mailto:${data.client_entity.email}`} className="mt-1 flex items-center gap-1.5 text-sm hover:underline">
                <Mail className="h-3.5 w-3.5 text-muted-foreground" /> {data.client_entity.email}
              </a>
            )}
            {(data.client_entity?.address || data.client_entity?.city) && (
              <div className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground">
                <MapPin className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>
                  {[data.client_entity?.address, data.client_entity?.postal_code, data.client_entity?.city, data.client_entity?.country]
                    .filter(Boolean).join(", ")}
                </span>
              </div>
            )}
          </div>

          <div className="rounded-md border border-border p-3">
            <h2 className="text-sm font-semibold mb-2">Totaux</h2>
            <div className="text-sm text-muted-foreground">Palettes: {fmtPalette(totals.pallets)}</div>
            <div className="text-sm text-muted-foreground">Poids: {fmtKg(totals.weight)}</div>
          </div>
        </div>

        <div className="px-6 pb-6 space-y-4">
          <div>
            <h2 className="text-sm font-semibold mb-2">Lignes shipment</h2>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-[88px] md:top-0 z-10 bg-muted/95 text-xs uppercase tracking-wider text-muted-foreground backdrop-blur">
                  <tr>
                    <th className="text-left p-2">Variant</th>
                    <th className="text-right p-2">Quantité</th>
                    <th className="text-right p-2">Poids</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.lines ?? []).length === 0 ? (
                    <tr>
                      <td className="p-3 text-muted-foreground" colSpan={3}>Données manquantes</td>
                    </tr>
                  ) : (data.lines ?? []).map((it: any) => (
                    <tr key={it.id} className="border-t border-border">
                      <td className="p-2">
                        <div className="font-medium">{it.variant?.name ?? "Données manquantes"}</div>
                        <div className="text-xs text-muted-foreground font-mono">{it.variant?.reference ?? "Données manquantes"}</div>
                      </td>
                      <td className="p-2 text-right tabular">{fmtInt(it.quantity)}</td>
                      <td className="p-2 text-right tabular">{fmtKg(it.weight)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h2 className="text-sm font-semibold mb-2">Palettes</h2>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-[88px] md:top-0 z-10 bg-muted/95 text-xs uppercase tracking-wider text-muted-foreground backdrop-blur">
                  <tr>
                    <th className="text-left p-2">Label</th>
                    <th className="text-left p-2">Type</th>
                    <th className="text-right p-2">Poids</th>
                    <th className="text-right p-2">Dimensions</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.pallets ?? []).length === 0 ? (
                    <tr>
                      <td className="p-3 text-muted-foreground" colSpan={4}>Aucune palette</td>
                    </tr>
                  ) : (data.pallets ?? []).map((p: any) => (
                    <tr key={p.id} className="border-t border-border">
                      <td className="p-2">{p.label ?? p.id}</td>
                      <td className="p-2">{p.type ?? "n/a"}</td>
                      <td className="p-2 text-right tabular">{fmtKg(p.weight)}</td>
                      <td className="p-2 text-right tabular">{[p.width, p.height, p.depth].filter((x) => x != null).join(" x ") || "n/a"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div className="print:hidden mt-4 rounded-md border border-border p-4">
        <h2 className="text-sm font-semibold mb-3">Statut shipment</h2>
        <div className="flex flex-wrap gap-2 mb-3">
          <Button variant="outline" disabled={!canSetReady || updateStatus.isPending} onClick={() => updateStatus.mutate("ready")}>Préparer</Button>
          <Button variant="outline" disabled={!canSetShipped || updateStatus.isPending} onClick={() => updateStatus.mutate("shipped")}>Expédier</Button>
          <Button variant="outline" disabled={!canSetDelivered || updateStatus.isPending} onClick={() => updateStatus.mutate("delivered")}>Livrer</Button>
        </div>
      </div>
    </div>
  );
}
