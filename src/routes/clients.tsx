import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { MSG } from "@/lib/messages";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Pencil, Plus, Trash2, Download, Truck } from "lucide-react";
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
    queryKey: ["shipments", "clients"],
    queryFn: async () => {
      const { data, error } = await sb
        .from("shipments")
        .select("id,reference,client_id,status,total_weight,total_pallets,created_at")
        .order("created_at", { ascending: false });
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
      toast.success(MSG.CLIENT_SAVED(editMode));
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
      toast.success(MSG.CLIENT_DELETED);
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
      const d = new Date(l.created_at);
      return d.getFullYear() === year && d.getMonth() + 1 === month;
    });
    if (rows.length === 0) {
      toast.info(MSG.SHIPMENT_EXPORT_EMPTY);
      return;
    }
    const clientMap = new Map((clients.data ?? []).map((c) => [c.id, c.name]));
    const header = toCsvRow(["Référence", "Date", "Client", "Statut", "Poids (kg)", "Palettes"]);
    const lines = rows.map((l) =>
      toCsvRow([
        l.reference ?? l.id,
        l.created_at?.slice(0, 10),
        clientMap.get(l.client_id) ?? "",
        l.status ?? "",
        l.total_weight ?? 0,
        l.total_pallets ?? 0,
      ])
    );
    downloadCsv(`expeditions-${exportMonth}.csv`, [header, ...lines]);
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
        <div className="flex flex-col sm:flex-row flex-wrap items-start sm:items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Input
              type="month"
              value={exportMonth}
              onChange={(e) => setExportMonth(e.target.value)}
              className="w-full sm:w-40 text-sm"
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
            <div className="max-h-[45vh] sm:max-h-[70vh] overflow-y-auto divide-y divide-border">
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
                  <div className="flex flex-wrap gap-1.5 shrink-0">
                    <Button size="sm" variant="outline" onClick={() => openEdit(selected)}>
                      <Pencil className="h-3.5 w-3.5 mr-1" /> Modifier
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link to="/livraisons" search={{ filterClient: selected.name } as any}>
                        <Truck className="h-3.5 w-3.5 mr-1" /> Expéditions
                      </Link>
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
                  <CardTitle className="text-base">Historique expéditions</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs md:text-sm">
                      <thead className="bg-muted/95 text-xs uppercase tracking-wider text-muted-foreground">
                        <tr>
                          <th className="text-left p-1.5 md:p-3">Référence</th>
                          <th className="text-left p-1.5 md:p-3">Date</th>
                          <th className="text-right p-1.5 md:p-3">Poids</th>
                          <th className="text-right p-1.5 md:p-3">Palettes</th>
                          <th className="text-center p-1.5 md:p-3">Statut</th>
                        </tr>
                      </thead>
                      <tbody>
                        {clientLivraisons.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="p-4 text-sm text-muted-foreground text-center">
                              Aucune expédition pour ce client.
                            </td>
                          </tr>
                        ) : (
                          clientLivraisons.map((l) => (
                            <tr key={l.id} className="border-t border-border">
                              <td className="p-1.5 md:p-3 font-mono text-xs">{l.reference ?? l.id.slice(0, 8)}</td>
                              <td className="p-1.5 md:p-3 text-muted-foreground">{fmtDate(l.created_at)}</td>
                              <td className="p-1.5 md:p-3 text-right tabular">{fmtKg(l.total_weight ?? 0)}</td>
                              <td className="p-1.5 md:p-3 text-right tabular">{fmtInt(l.total_pallets ?? 0)}</td>
                              <td className="p-1.5 md:p-3 text-center">
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
                            <td className="p-1.5 md:p-3" colSpan={2}>Total ({clientLivraisons.length} expédition{clientLivraisons.length > 1 ? "s" : ""})</td>
                            <td className="p-1.5 md:p-3 text-right tabular">{fmtKg(clientLivraisons.reduce((s, l) => s + Number(l.total_weight ?? 0), 0))}</td>
                            <td className="p-1.5 md:p-3 text-right tabular">{fmtInt(clientLivraisons.reduce((s, l) => s + Number(l.total_pallets ?? 0), 0))}</td>
                            <td />
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </CardContent>
              </Card>

              <ClientHistorySummary clientId={selectedId!} shipments={livraisons.data ?? []} />
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

    </div>
  );
}

// ── Statistiques CRM par client ──────────────────────────────────────────────

function ClientHistorySummary({ clientId, shipments }: { clientId: string; shipments: any[] }) {
  const clientShipments = shipments.filter((s) => s.client_id === clientId);
  if (clientShipments.length === 0) return null;

  const totalWeight = clientShipments.reduce((sum, s) => sum + Number(s.total_weight ?? 0), 0);
  const totalPallets = clientShipments.reduce((sum, s) => sum + Number(s.total_pallets ?? 0), 0);
  const dates = clientShipments.map((s) => new Date(s.created_at)).sort((a, b) => a.getTime() - b.getTime());
  const first = dates[0];
  const last = dates[dates.length - 1];
  const avgFreqDays = dates.length <= 1
    ? null
    : Math.round((last.getTime() - first.getTime()) / (1000 * 60 * 60 * 24) / (dates.length - 1));

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-base">Statistiques CRM</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">Expéditions</div>
            <div className="font-semibold tabular">{fmtInt(clientShipments.length)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Poids total</div>
            <div className="font-semibold tabular">{fmtKg(totalWeight)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Palettes</div>
            <div className="font-semibold tabular">{fmtInt(totalPallets)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Fréquence moy.</div>
            <div className="font-semibold tabular">{avgFreqDays == null ? "—" : `${fmtInt(avgFreqDays)} j`}</div>
          </div>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          Première livraison : {fmtDate(first.toISOString())} · Dernière : {fmtDate(last.toISOString())}
        </div>
      </CardContent>
    </Card>
  );
}

