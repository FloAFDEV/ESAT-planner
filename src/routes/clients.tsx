import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Pencil, Plus, Trash2, Download, Package } from "lucide-react";
import { fmtDate, fmtInt, fmtKg } from "@/lib/format";

export const Route = createFileRoute("/clients")({
  head: () => ({
    meta: [
      { title: "Clients — Coffret ERP" },
      { name: "description", content: "Gestion des clients, contacts et historique d'expéditions." },
    ],
  }),
  component: ClientsPage,
});

type Client = {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  country: string | null;
};

type ClientForm = Omit<Client, "id">;

const emptyForm = (): ClientForm => ({
  name: "",
  contact_name: "",
  phone: "",
  email: "",
  address: "",
  postal_code: "",
  city: "",
  country: "France",
});

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function escapeCsv(v: unknown): string {
  const s = String(v ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsvRow(cells: unknown[]): string {
  return cells.map(escapeCsv).join(",");
}

function downloadCsv(filename: string, rows: string[]): void {
  const blob = new Blob(["﻿" + rows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function ClientsPage() {
  const sb = supabase as any;
  const qc = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editMode, setEditMode] = useState<"create" | "edit">("create");
  const [editForm, setEditForm] = useState<ClientForm>(emptyForm());
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [livOpen, setLivOpen] = useState(false);
  const [exportMonth, setExportMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });

  const clients = useQuery({
    queryKey: ["clients", "full"],
    queryFn: async () => {
      const { data, error } = await sb.from("clients").select("*").order("name");
      if (error) throw error;
      return (data ?? []) as Client[];
    },
  });

  const livraisons = useQuery({
    queryKey: ["livraisons", "clients"],
    queryFn: async () => {
      const { data, error } = await sb
        .from("livraisons")
        .select("id,reference,date,client_id,status,total_poids,total_palette,created_at")
        .order("date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return (clients.data ?? []).filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.city ?? "").toLowerCase().includes(q) ||
        (c.email ?? "").toLowerCase().includes(q)
    );
  }, [clients.data, search]);

  const selected = useMemo(
    () => (clients.data ?? []).find((c) => c.id === selectedId) ?? null,
    [clients.data, selectedId]
  );

  const clientLivraisons = useMemo(
    () => (livraisons.data ?? []).filter((l) => l.client_id === selectedId),
    [livraisons.data, selectedId]
  );

  // ─── Mutations ──────────────────────────────────────────────────────────────

  const saveClient = useMutation({
    mutationFn: async () => {
      if (!editForm.name.trim()) throw new Error("Nom client requis");
      const payload = {
        name: editForm.name.trim(),
        contact_name: editForm.contact_name?.trim() || null,
        phone: editForm.phone?.trim() || null,
        email: editForm.email?.trim() || null,
        address: editForm.address?.trim() || null,
        postal_code: editForm.postal_code?.trim() || null,
        city: editForm.city?.trim() || null,
        country: editForm.country?.trim() || null,
      };
      if (editMode === "create") {
        const { data, error } = await sb.from("clients").insert(payload).select("id").single();
        if (error) throw error;
        return data.id as string;
      } else {
        const { error } = await sb.from("clients").update(payload).eq("id", selectedId!);
        if (error) throw error;
        return selectedId!;
      }
    },
    onSuccess: (id) => {
      toast.success(editMode === "create" ? "Client créé" : "Client mis à jour");
      qc.invalidateQueries({ queryKey: ["clients"] });
      setEditOpen(false);
      setSelectedId(id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteClient = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await sb.from("clients").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Client supprimé");
      qc.invalidateQueries({ queryKey: ["clients"] });
      setSelectedId(null);
      setDeleteId(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ─── CSV export ─────────────────────────────────────────────────────────────

  function exportMonthCsv() {
    const [year, month] = exportMonth.split("-").map(Number);
    const rows = (livraisons.data ?? []).filter((l) => {
      const d = new Date(l.date ?? l.created_at);
      return d.getFullYear() === year && d.getMonth() + 1 === month;
    });
    if (rows.length === 0) {
      toast.info("Aucune livraison pour cette période");
      return;
    }
    const clientMap = new Map((clients.data ?? []).map((c) => [c.id, c.name]));
    const header = toCsvRow(["Référence", "Date", "Client", "Statut", "Poids (kg)", "Palettes"]);
    const lines = rows.map((l) =>
      toCsvRow([
        l.reference ?? l.id,
        l.date ?? l.created_at?.slice(0, 10),
        clientMap.get(l.client_id) ?? "",
        l.status ?? "",
        l.total_poids ?? 0,
        l.total_palette ?? 0,
      ])
    );
    downloadCsv(`livraisons-${exportMonth}.csv`, [header, ...lines]);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function openCreate() {
    setEditForm(emptyForm());
    setEditMode("create");
    setEditOpen(true);
  }

  function openEdit(c: Client) {
    setEditForm({
      name: c.name,
      contact_name: c.contact_name ?? "",
      phone: c.phone ?? "",
      email: c.email ?? "",
      address: c.address ?? "",
      postal_code: c.postal_code ?? "",
      city: c.city ?? "",
      country: c.country ?? "France",
    });
    setEditMode("edit");
    setEditOpen(true);
  }

  function setField(field: keyof ClientForm, value: string) {
    setEditForm((f) => ({ ...f, [field]: value }));
  }

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      <header className="mb-6 flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Référentiel</p>
          <h1 className="text-3xl md:text-4xl font-display font-semibold mt-1">Clients</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Input
              type="month"
              value={exportMonth}
              onChange={(e) => setExportMonth(e.target.value)}
              className="w-40 text-sm"
            />
            <Button variant="outline" onClick={exportMonthCsv} title="Exporter CSV mensuel">
              <Download className="h-4 w-4 mr-1" /> Export CSV
            </Button>
          </div>
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1" /> Nouveau client
          </Button>
        </div>
      </header>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Left: client list */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2">
            <Input
              placeholder="Rechercher…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="text-sm"
            />
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[70vh] overflow-y-auto divide-y divide-border">
              {filtered.length === 0 && (
                <p className="p-4 text-sm text-muted-foreground">Aucun client.</p>
              )}
              {filtered.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={`w-full text-left px-4 py-3 text-sm transition-colors ${
                    selectedId === c.id ? "bg-muted" : "hover:bg-muted/40"
                  }`}
                >
                  <div className="font-medium">{c.name}</div>
                  {c.city && (
                    <div className="text-xs text-muted-foreground">
                      {c.postal_code} {c.city}
                    </div>
                  )}
                  {c.email && (
                    <div className="text-xs text-muted-foreground truncate">{c.email}</div>
                  )}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Right: client detail */}
        <div className="lg:col-span-2 space-y-4">
          {!selected ? (
            <Card>
              <CardContent className="py-16 text-center text-muted-foreground text-sm">
                Sélectionner un client pour voir les détails
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader className="flex-row items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-lg">{selected.name}</CardTitle>
                    {selected.contact_name && (
                      <p className="text-sm text-muted-foreground mt-0.5">Contact : {selected.contact_name}</p>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button size="sm" variant="outline" onClick={() => openEdit(selected)}>
                      <Pencil className="h-3.5 w-3.5 mr-1" /> Modifier
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setLivOpen(true)}>
                      <Package className="h-3.5 w-3.5 mr-1" /> Livraison
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeleteId(selected.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid sm:grid-cols-2 gap-4 text-sm">
                    <div className="space-y-1.5">
                      {selected.phone && (
                        <div>
                          <span className="text-xs text-muted-foreground block">Téléphone</span>
                          <a href={`tel:${selected.phone}`} className="hover:underline">{selected.phone}</a>
                        </div>
                      )}
                      {selected.email && (
                        <div>
                          <span className="text-xs text-muted-foreground block">Email</span>
                          <a href={`mailto:${selected.email}`} className="hover:underline">{selected.email}</a>
                        </div>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      {(selected.address || selected.city) && (
                        <div>
                          <span className="text-xs text-muted-foreground block">Adresse</span>
                          {selected.address && <div>{selected.address}</div>}
                          {(selected.postal_code || selected.city) && (
                            <div>{selected.postal_code} {selected.city}</div>
                          )}
                          {selected.country && <div className="text-muted-foreground">{selected.country}</div>}
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Shipping history */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Historique livraisons</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/80 text-xs uppercase tracking-wider text-muted-foreground">
                        <tr>
                          <th className="text-left p-3">Référence</th>
                          <th className="text-left p-3">Date</th>
                          <th className="text-right p-3">Poids</th>
                          <th className="text-right p-3">Palettes</th>
                          <th className="text-center p-3">Statut</th>
                        </tr>
                      </thead>
                      <tbody>
                        {clientLivraisons.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="p-4 text-sm text-muted-foreground text-center">
                              Aucune livraison pour ce client.
                            </td>
                          </tr>
                        ) : (
                          clientLivraisons.map((l) => (
                            <tr key={l.id} className="border-t border-border">
                              <td className="p-3 font-mono text-xs">{l.reference ?? l.id.slice(0, 8)}</td>
                              <td className="p-3 text-muted-foreground">{fmtDate(l.date ?? l.created_at)}</td>
                              <td className="p-3 text-right tabular">{fmtKg(l.total_poids ?? 0)}</td>
                              <td className="p-3 text-right tabular">{fmtInt(l.total_palette ?? 0)}</td>
                              <td className="p-3 text-center">
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-muted text-muted-foreground border border-border">
                                  {l.status ?? "—"}
                                </span>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                      {clientLivraisons.length > 0 && (
                        <tfoot>
                          <tr className="border-t-2 border-border bg-muted/30 font-semibold text-sm">
                            <td className="p-3" colSpan={2}>Total ({clientLivraisons.length} livraison{clientLivraisons.length > 1 ? "s" : ""})</td>
                            <td className="p-3 text-right tabular">{fmtKg(clientLivraisons.reduce((s, l) => s + Number(l.total_poids ?? 0), 0))}</td>
                            <td className="p-3 text-right tabular">{fmtInt(clientLivraisons.reduce((s, l) => s + Number(l.total_palette ?? 0), 0))}</td>
                            <td />
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>

      {/* ── Client create/edit dialog ── */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editMode === "create" ? "Nouveau client" : "Modifier le client"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1">
                <Label>Nom <span className="text-destructive">*</span></Label>
                <Input value={editForm.name} onChange={(e) => setField("name", e.target.value)} placeholder="Raison sociale" />
              </div>
              <div className="space-y-1">
                <Label>Contact</Label>
                <Input value={editForm.contact_name ?? ""} onChange={(e) => setField("contact_name", e.target.value)} placeholder="Prénom Nom" />
              </div>
              <div className="space-y-1">
                <Label>Téléphone</Label>
                <Input value={editForm.phone ?? ""} onChange={(e) => setField("phone", e.target.value)} placeholder="06 xx xx xx xx" />
              </div>
              <div className="col-span-2 space-y-1">
                <Label>Email</Label>
                <Input type="email" value={editForm.email ?? ""} onChange={(e) => setField("email", e.target.value)} placeholder="contact@societe.fr" />
              </div>
              <div className="col-span-2 space-y-1">
                <Label>Adresse</Label>
                <Textarea rows={2} value={editForm.address ?? ""} onChange={(e) => setField("address", e.target.value)} placeholder="Numéro et rue" />
              </div>
              <div className="space-y-1">
                <Label>Code postal</Label>
                <Input value={editForm.postal_code ?? ""} onChange={(e) => setField("postal_code", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Ville</Label>
                <Input value={editForm.city ?? ""} onChange={(e) => setField("city", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Pays</Label>
                <Input value={editForm.country ?? ""} onChange={(e) => setField("country", e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Annuler</Button>
            <Button onClick={() => saveClient.mutate()} disabled={saveClient.isPending}>
              {editMode === "create" ? "Créer" : "Enregistrer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm ── */}
      <Dialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Supprimer le client ?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            Cette action est irréversible. Les livraisons associées conserveront l'identifiant client mais le nom ne sera plus résolu.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>Annuler</Button>
            <Button
              variant="destructive"
              disabled={deleteClient.isPending}
              onClick={() => deleteId && deleteClient.mutate(deleteId)}
            >
              Supprimer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── New livraison dialog ── */}
      {selected && (
        <NouvelleLivraisonDialog
          open={livOpen}
          onOpenChange={setLivOpen}
          clientId={selected.id}
          clientName={selected.name}
          clientAddress={[selected.address, selected.postal_code, selected.city, selected.country].filter(Boolean).join(", ")}
        />
      )}
    </div>
  );
}

// ─── Livraison creation dialog with weight calculator ─────────────────────────

type LigneDraft = { coffret_id: string; quantity: number };

function NouvelleLivraisonDialog({
  open,
  onOpenChange,
  clientId,
  clientName,
  clientAddress,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  clientId: string;
  clientName: string;
  clientAddress: string;
}) {
  const sb = supabase as any;
  const qc = useQueryClient();

  const [lignes, setLignes] = useState<LigneDraft[]>([{ coffret_id: "", quantity: 1 }]);
  const [paletteTypeId, setPaletteTypeId] = useState<string>("none");
  const [palettePoidsSurcharge, setPalettePoidsSurcharge] = useState<string>("");

  const coffrets = useQuery({
    queryKey: ["coffrets", "livraison"],
    queryFn: async () => {
      const { data, error } = await sb
        .from("coffrets")
        .select("id,reference,name,poids_coffret,nb_par_palette,poids_palette")
        .order("reference");
      if (error) throw error;
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

  useEffect(() => {
    if (!open) {
      setLignes([{ coffret_id: "", quantity: 1 }]);
      setPaletteTypeId("none");
      setPalettePoidsSurcharge("");
    }
  }, [open]);

  const coffretMap = useMemo(
    () => new Map((coffrets.data ?? []).map((c: any) => [c.id, c])),
    [coffrets.data]
  );

  const selectedPaletteType = useMemo(
    () => paletteTypeId === "none" ? null : ((paletteTypes.data ?? []).find((p: any) => p.id === paletteTypeId) ?? null),
    [paletteTypes.data, paletteTypeId]
  );

  const calc = useMemo(() => {
    let poidsItems = 0;
    let nbPalettesTotal = 0;

    const details = lignes
      .filter((l) => l.coffret_id && l.quantity > 0)
      .map((l) => {
        const c = coffretMap.get(l.coffret_id);
        if (!c) return null;
        const poidsCoffrets = l.quantity * Number(c.poids_coffret ?? 0);
        const nbPalettes = c.nb_par_palette > 0 ? Math.ceil(l.quantity / Number(c.nb_par_palette)) : 0;
        const poidsPaletteBase = Number(c.poids_palette ?? 0);
        poidsItems += poidsCoffrets;
        nbPalettesTotal += nbPalettes;
        return { coffret: c, quantity: l.quantity, poidsCoffrets, nbPalettes, poidsPaletteBase };
      })
      .filter(Boolean) as any[];

    const paletteUnitWeight =
      palettePoidsSurcharge !== ""
        ? Number(palettePoidsSurcharge)
        : selectedPaletteType
        ? Number(selectedPaletteType.poids_max ?? 0)
        : details[0]?.poidsPaletteBase ?? 0;

    const poidsPalettes = nbPalettesTotal * paletteUnitWeight;
    const totalPoids = poidsItems + poidsPalettes;

    return { details, poidsItems, poidsPalettes, paletteUnitWeight, nbPalettesTotal, totalPoids };
  }, [lignes, coffretMap, paletteTypeId, palettePoidsSurcharge, selectedPaletteType]);

  const create = useMutation({
    mutationFn: async () => {
      if (calc.details.length === 0) throw new Error("Ajoutez au moins une ligne");

      const reference = `LIV-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

      const { data: liv, error: livError } = await sb
        .from("livraisons")
        .insert({
          reference,
          client: clientName,
          adresse: clientAddress,
          client_id: clientId,
          date: new Date().toISOString().slice(0, 10),
          total_poids: calc.totalPoids,
          total_palette: calc.nbPalettesTotal,
          status: "draft",
        })
        .select("id")
        .single();
      if (livError) throw livError;

      const items = calc.details.map((d: any) => ({
        livraison_id: liv.id,
        coffret_id: d.coffret.id,
        quantity: d.quantity,
        palettes: d.nbPalettes,
        poids: d.poidsCoffrets,
      }));

      const { error: itemsError } = await sb.from("livraison_items").insert(items);
      if (itemsError) throw itemsError;
    },
    onSuccess: () => {
      toast.success("Livraison créée");
      qc.invalidateQueries({ queryKey: ["livraisons"] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function addLigne() {
    setLignes((ls) => [...ls, { coffret_id: "", quantity: 1 }]);
  }

  function removeLigne(i: number) {
    setLignes((ls) => ls.filter((_, idx) => idx !== i));
  }

  function setLigne(i: number, field: keyof LigneDraft, value: string | number) {
    setLignes((ls) => ls.map((l, idx) => (idx === i ? { ...l, [field]: value } : l)));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Nouvelle livraison — {clientName}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1 max-h-[70vh] overflow-y-auto pr-1">
          {/* Lignes coffrets */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Coffrets</Label>
              <Button size="sm" variant="outline" onClick={addLigne}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Ligne
              </Button>
            </div>
            {lignes.map((l, i) => {
              const c = coffretMap.get(l.coffret_id);
              const poidsLigne = l.quantity * Number(c?.poids_coffret ?? 0);
              const nbPal = c?.nb_par_palette > 0 ? Math.ceil(l.quantity / Number(c.nb_par_palette)) : 0;
              return (
                <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center">
                  <Select value={l.coffret_id} onValueChange={(v) => setLigne(i, "coffret_id", v)}>
                    <SelectTrigger><SelectValue placeholder="Coffret…" /></SelectTrigger>
                    <SelectContent>
                      {(coffrets.data ?? []).map((c: any) => (
                        <SelectItem key={c.id} value={c.id}>
                          <span className="font-mono text-xs mr-1">{c.reference}</span> {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    min="1"
                    className="w-20 text-right"
                    value={l.quantity}
                    onChange={(e) => setLigne(i, "quantity", Math.max(1, parseInt(e.target.value) || 1))}
                  />
                  {c && (
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {fmtKg(poidsLigne)} · {nbPal} pal.
                    </span>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => removeLigne(i)} disabled={lignes.length === 1}>
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>
              );
            })}
          </div>

          {/* Palette */}
          <div className="space-y-2">
            <Label>Type de palette</Label>
            <div className="grid grid-cols-2 gap-3">
              <Select value={paletteTypeId} onValueChange={(v) => { setPaletteTypeId(v); setPalettePoidsSurcharge(""); }}>
                <SelectTrigger><SelectValue placeholder="Choisir un type…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— Aucun (poids issu du coffret) —</SelectItem>
                  {(paletteTypes.data ?? []).map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label} · {p.length}×{p.width}×{p.height} cm · max {p.poids_max} kg
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div>
                <Input
                  type="number"
                  min="0"
                  step="0.5"
                  value={palettePoidsSurcharge}
                  onChange={(e) => setPalettePoidsSurcharge(e.target.value)}
                  placeholder={`Poids palette (kg) ${selectedPaletteType ? `[défaut: ${selectedPaletteType.poids_max}]` : ""}`}
                />
              </div>
            </div>
            {selectedPaletteType && (
              <p className="text-xs text-muted-foreground">
                Dimensions : {selectedPaletteType.length} × {selectedPaletteType.width} × {selectedPaletteType.height} cm
              </p>
            )}
          </div>

          {/* Calcul en temps réel */}
          {calc.details.length > 0 && (
            <div className="rounded-md border border-border bg-muted/30 p-4 space-y-2 text-sm">
              <div className="font-semibold text-xs uppercase tracking-wider text-muted-foreground mb-2">Calcul poids</div>
              {calc.details.map((d: any, i: number) => (
                <div key={i} className="flex justify-between text-xs">
                  <span className="font-mono">{d.coffret.reference}</span>
                  <span>{d.quantity} × {d.coffret.poids_coffret} kg = <strong>{fmtKg(d.poidsCoffrets)}</strong> · {d.nbPalettes} pal.</span>
                </div>
              ))}
              <div className="border-t border-border pt-2 mt-1 space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Poids coffrets</span>
                  <strong>{fmtKg(calc.poidsItems)}</strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Palettes ({calc.nbPalettesTotal} × {calc.paletteUnitWeight} kg)
                  </span>
                  <strong>{fmtKg(calc.poidsPalettes)}</strong>
                </div>
                <div className="flex justify-between text-base font-semibold border-t border-border pt-1 mt-1">
                  <span>Total</span>
                  <span>{fmtKg(calc.totalPoids)} · {calc.nbPalettesTotal} palette{calc.nbPalettesTotal > 1 ? "s" : ""}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || calc.details.length === 0}>
            Créer la livraison
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
