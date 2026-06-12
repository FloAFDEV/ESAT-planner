import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ArrowLeft, Phone, Mail, MapPin, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { fmtDate, fmtInt, fmtKg, fmtPalette } from "@/lib/format";
import { livraisonStatusMeta, normalizeLivraisonStatus, type LivraisonStatus } from "@/lib/domain";
import { UI } from "@/lib/uiLabels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  const [palletDialogOpen, setPalletDialogOpen] = useState(false);

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
        .select("id,label,type,weight,tare_weight,width,height,depth")
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

      const lines = ((lineRows ?? []) as any[]).map((l) => ({ ...l, variant: variantMap.get(l.product_variant_id) ?? null }));
      const pallets = (palletRows ?? []).map((p: any) => {
        const palletLines = palletLinesByPallet.get(p.id) ?? [];
        const contentWeight = palletLines.reduce((sum, pl) => {
          const unitWeight = Number(pl.shipment_line?.variant?.weight ?? 0);
          return sum + Number(pl.quantity) * unitWeight;
        }, 0);
        return {
          ...p,
          pallet_lines: palletLines,
          content_weight: contentWeight,
          total_weight: Number(p.tare_weight ?? 0) + contentWeight,
        };
      });

      return {
        ...shipment,
        status: normalizeLivraisonStatus(shipment.status),
        client_entity: clientEntity,
        lines,
        pallets,
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

  const deletePallet = useMutation({
    mutationFn: async (palletId: string) => {
      const { error } = await sb.from("shipment_pallets").delete().eq("id", palletId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Palette supprimée");
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
    const pallets = (data?.pallets ?? []) as any[];
    const totalWeight = pallets.reduce((s, p) => s + Number(p.total_weight ?? 0), 0);
    return {
      weight: totalWeight,
      pallets: pallets.length,
    };
  }, [data]);

  if (isLoading) {
    return <div className="p-4 md:p-8 max-w-7xl mx-auto text-sm text-muted-foreground">Chargement...</div>;
  }

  if (!data) {
    return <div className="p-4 md:p-8 max-w-7xl mx-auto text-sm text-muted-foreground">Données manquantes</div>;
  }

  const nextPalletLabel = `P${((data.pallets ?? []) as any[]).length + 1}`;

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
            <h2 className="text-sm font-semibold mb-2">Totaux expédition</h2>
            <div className="text-sm text-muted-foreground">Palettes : {fmtPalette(totals.pallets)}</div>
            <div className="text-sm text-muted-foreground">Poids total : {fmtKg(totals.weight)}</div>
          </div>
        </div>

        <div className="px-6 pb-6 space-y-4">
          {/* Lignes shipment */}
          <div>
            <h2 className="text-sm font-semibold mb-2">Lignes shipment</h2>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-[88px] md:top-0 z-10 bg-muted/95 text-xs uppercase tracking-wider text-muted-foreground backdrop-blur">
                  <tr>
                    <th className="text-left p-2">Produit</th>
                    <th className="text-right p-2">Quantité</th>
                    <th className="text-right p-2">Poids ligne</th>
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

          {/* Palettes */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold">Palettes</h2>
              <Button
                variant="outline"
                size="sm"
                className="print:hidden h-8 gap-1.5"
                onClick={() => setPalletDialogOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" /> Palette
              </Button>
            </div>

            {(data.pallets ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune palette. Cliquez sur « Palette » pour en ajouter une.</p>
            ) : (
              <div className="space-y-3">
                {(data.pallets ?? []).map((p: any) => (
                  <div key={p.id} className="rounded-md border border-border p-3">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <span className="text-sm font-semibold">{p.label ?? p.id}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="print:hidden h-7 w-7 text-destructive hover:bg-destructive/10"
                        onClick={() => deletePallet.mutate(p.id)}
                        disabled={deletePallet.isPending}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>

                    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm mb-2">
                      {(p.depth != null || p.width != null) && (
                        <div className="text-muted-foreground">
                          Dimensions&nbsp;:&nbsp;
                          <span className="text-foreground tabular">
                            {p.depth != null ? `${p.depth} cm` : "—"} × {p.width != null ? `${p.width} cm` : "—"}
                          </span>
                        </div>
                      )}
                      <div className="text-muted-foreground">
                        Palette vide&nbsp;:&nbsp;
                        <span className="text-foreground tabular">{fmtKg(p.tare_weight)}</span>
                      </div>
                      <div className="text-muted-foreground">
                        Contenu&nbsp;:&nbsp;
                        <span className="text-foreground tabular">{fmtKg(p.content_weight)}</span>
                      </div>
                      <div className="font-medium">
                        Total estimé&nbsp;:&nbsp;
                        <span className="tabular">{fmtKg(p.total_weight)}</span>
                      </div>
                    </div>

                    {(p.pallet_lines ?? []).length > 0 && (
                      <div className="mt-2 pt-2 border-t border-border">
                        <table className="w-full text-xs">
                          <thead className="text-muted-foreground">
                            <tr>
                              <th className="text-left pb-1">Produit</th>
                              <th className="text-right pb-1">Qté</th>
                              <th className="text-right pb-1">Poids</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(p.pallet_lines ?? []).map((pl: any) => {
                              const unitWeight = Number(pl.shipment_line?.variant?.weight ?? 0);
                              return (
                                <tr key={pl.id} className="border-t border-border/50">
                                  <td className="py-0.5">{pl.shipment_line?.variant?.name ?? "—"}</td>
                                  <td className="py-0.5 text-right tabular">{fmtInt(pl.quantity)}</td>
                                  <td className="py-0.5 text-right tabular">{fmtKg(pl.quantity * unitWeight)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Transitions statut */}
      <div className="print:hidden mt-4 rounded-md border border-border p-4">
        <h2 className="text-sm font-semibold mb-3">Statut shipment</h2>
        <div className="flex flex-wrap gap-2 mb-3">
          <Button variant="outline" disabled={!canSetReady || updateStatus.isPending} onClick={() => updateStatus.mutate("ready")}>Préparer</Button>
          <Button variant="outline" disabled={!canSetShipped || updateStatus.isPending} onClick={() => updateStatus.mutate("shipped")}>Expédier</Button>
          <Button variant="outline" disabled={!canSetDelivered || updateStatus.isPending} onClick={() => updateStatus.mutate("delivered")}>Livrer</Button>
        </div>
      </div>

      {/* Dialog ajout palette */}
      {palletDialogOpen && (
        <AddPalletDialog
          shipmentId={id}
          lines={(data.lines ?? []) as any[]}
          nextLabel={nextPalletLabel}
          onClose={() => setPalletDialogOpen(false)}
          onSuccess={() => {
            setPalletDialogOpen(false);
            qc.invalidateQueries({ queryKey: ["shipment", id] });
            qc.invalidateQueries({ queryKey: ["shipments"] });
          }}
        />
      )}
    </div>
  );
}

type PalletLineEntry = { shipment_line_id: string; quantity: number; enabled: boolean };

function AddPalletDialog({
  shipmentId,
  lines,
  nextLabel,
  onClose,
  onSuccess,
}: {
  shipmentId: string;
  lines: any[];
  nextLabel: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const sb = supabase as any;

  const [label, setLabel] = useState(nextLabel);
  const [longueur, setLongueur] = useState("");
  const [largeur, setLargeur] = useState("");
  const [tareWeight, setTareWeight] = useState("");
  const [lineEntries, setLineEntries] = useState<PalletLineEntry[]>(
    lines.map((l) => ({ shipment_line_id: l.id, quantity: l.quantity, enabled: false }))
  );

  const paletteTypes = useQuery({
    queryKey: ["palette_types"],
    queryFn: async () => {
      const { data, error } = await sb
        .from("palette_types")
        .select("id,label,length,width,tare_weight")
        .order("label");
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const applyPaletteType = (typeId: string) => {
    if (typeId === "custom") return;
    const pt = (paletteTypes.data ?? []).find((p: any) => p.id === typeId);
    if (!pt) return;
    if (pt.length != null) setLongueur(String(pt.length));
    if (pt.width != null) setLargeur(String(pt.width));
    if (pt.tare_weight != null) setTareWeight(String(pt.tare_weight));
  };

  const contentWeight = useMemo(() => {
    return lineEntries.reduce((sum, entry) => {
      if (!entry.enabled) return sum;
      const line = lines.find((l) => l.id === entry.shipment_line_id);
      const unitWeight = Number(line?.variant?.weight ?? 0);
      return sum + Number(entry.quantity) * unitWeight;
    }, 0);
  }, [lineEntries, lines]);

  const tare = Number(tareWeight) || 0;
  const totalEstimated = tare + contentWeight;

  const create = useMutation({
    mutationFn: async () => {
      const activeEntries = lineEntries.filter((e) => e.enabled && e.quantity > 0);
      if (activeEntries.length === 0) throw new Error("Affectez au moins un produit à cette palette");
      if (!label.trim()) throw new Error("Label requis");

      const { data: palletRow, error: palletError } = await sb
        .from("shipment_pallets")
        .insert({
          shipment_id: shipmentId,
          label: label.trim(),
          tare_weight: tare,
          weight: totalEstimated,
          depth: longueur !== "" ? Number(longueur) : null,
          width: largeur !== "" ? Number(largeur) : null,
        })
        .select("id")
        .single();
      if (palletError) throw palletError;

      const { error: linesError } = await sb.from("shipment_pallet_lines").insert(
        activeEntries.map((e) => ({
          pallet_id: palletRow.id,
          shipment_line_id: e.shipment_line_id,
          quantity: e.quantity,
        }))
      );
      if (linesError) throw linesError;
    },
    onSuccess,
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Ajouter une palette</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Label */}
          <div className="space-y-1">
            <Label>Label palette</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="P1" />
          </div>

          {/* Type de palette — pré-remplit les champs */}
          <div className="space-y-1">
            <Label>Type de palette</Label>
            <Select onValueChange={applyPaletteType} defaultValue="custom">
              <SelectTrigger>
                <SelectValue placeholder="Choisir un type…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="custom">— Personnalisé (saisie manuelle) —</SelectItem>
                {(paletteTypes.data ?? []).map((pt: any) => (
                  <SelectItem key={pt.id} value={pt.id}>
                    {pt.label}
                    {pt.length && pt.width ? ` · ${pt.length}×${pt.width} cm` : ""}
                    {pt.tare_weight ? ` · tare ${pt.tare_weight} kg` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Sélectionner un type pré-remplit les champs — modifiables ensuite.
            </p>
          </div>

          {/* Dimensions */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Longueur (cm)</Label>
              <Input
                type="number" min="0" step="1"
                value={longueur}
                onChange={(e) => setLongueur(e.target.value)}
                placeholder="ex : 120"
              />
            </div>
            <div className="space-y-1">
              <Label>Largeur (cm)</Label>
              <Input
                type="number" min="0" step="1"
                value={largeur}
                onChange={(e) => setLargeur(e.target.value)}
                placeholder="ex : 80"
              />
            </div>
          </div>

          {/* Poids palette vide */}
          <div className="space-y-1">
            <Label>Poids palette vide (kg)</Label>
            <Input
              type="number" min="0" step="0.5"
              value={tareWeight}
              onChange={(e) => setTareWeight(e.target.value)}
              placeholder="ex : 22"
            />
          </div>

          {/* Affectation coffrets */}
          <div className="space-y-1">
            <Label>Coffrets affectés à cette palette</Label>
            {lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune ligne dans ce shipment.</p>
            ) : (
              <div className="rounded-md border border-border divide-y divide-border">
                {lines.map((line: any) => {
                  const entry = lineEntries.find((e) => e.shipment_line_id === line.id)!;
                  return (
                    <div key={line.id} className="flex items-center gap-3 p-2">
                      <input
                        type="checkbox"
                        checked={entry.enabled}
                        onChange={(e) =>
                          setLineEntries((prev) =>
                            prev.map((x) => x.shipment_line_id === line.id ? { ...x, enabled: e.target.checked } : x)
                          )
                        }
                        className="h-4 w-4 rounded border-input"
                      />
                      <span className="flex-1 text-sm">
                        <span className="font-medium">{line.variant?.name ?? "—"}</span>
                        <span className="ml-2 text-xs text-muted-foreground font-mono">{line.variant?.reference ?? ""}</span>
                      </span>
                      <Input
                        type="number" min="1" max={line.quantity}
                        value={entry.quantity}
                        disabled={!entry.enabled}
                        onChange={(e) =>
                          setLineEntries((prev) =>
                            prev.map((x) =>
                              x.shipment_line_id === line.id
                                ? { ...x, quantity: Math.min(Number(e.target.value) || 1, line.quantity) }
                                : x
                            )
                          )
                        }
                        className="w-20 text-right"
                      />
                      <span className="text-xs text-muted-foreground w-12 text-right">/ {line.quantity}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Récapitulatif poids */}
          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm space-y-1">
            <div className="flex justify-between text-muted-foreground">
              <span>Palette vide</span>
              <span className="tabular">{fmtKg(tare)}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Contenu</span>
              <span className="tabular">{fmtKg(contentWeight)}</span>
            </div>
            <div className="flex justify-between font-semibold border-t border-border pt-1 mt-1">
              <span>Total estimé</span>
              <span className="tabular">{fmtKg(totalEstimated)}</span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            Ajouter la palette
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
