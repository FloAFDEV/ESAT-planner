import { Link, createFileRoute } from "@tanstack/react-router";
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
import { Plus, Trash2 } from "lucide-react";
import { fmtInt } from "@/lib/format";
import { getProductionFeasibility } from "@/lib/getProductionFeasibility";

export const Route = createFileRoute("/coffrets")({
  head: () => ({
    meta: [
      { title: "Coffrets — Coffret ERP" },
      { name: "description", content: "Edition des coffrets et de leurs composants." },
    ],
  }),
  component: CoffretsPage,
});

function CoffretsPage() {
  const sb = supabase as any;
  const qc = useQueryClient();

  const [selectedId, setSelectedId] = useState<string>("");
  const [editRef, setEditRef] = useState("");
  const [editName, setEditName] = useState("");
  const [editWeight, setEditWeight] = useState("0");
  const [editNbPerPalette, setEditNbPerPalette] = useState("1");
  const [editPaletteWeight, setEditPaletteWeight] = useState("0");

  const [newCompId, setNewCompId] = useState("");
  const [newCompQty, setNewCompQty] = useState("1");
  const [feasibilityQty, setFeasibilityQty] = useState("1");

  // Dialog states
  const [newCoffretOpen, setNewCoffretOpen] = useState(false);
  const [newCoffretRef, setNewCoffretRef] = useState("");
  const [newCoffretName, setNewCoffretName] = useState("");

  const [newComposantOpen, setNewComposantOpen] = useState(false);
  const [newCompRef, setNewCompRef] = useState("");
  const [newCompName, setNewCompName] = useState("");
  const [newCompPoids, setNewCompPoids] = useState("0");

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const coffrets = useQuery({
    queryKey: ["coffrets", "manage"],
    queryFn: async () => {
      const { data, error } = await sb
        .from("coffrets")
        .select("*")
        .is("deleted_at", null)
        .order("reference");
      if (error) throw error;
      return data as any[];
    },
  });

  const composants = useQuery({
    queryKey: ["composants", "light"],
    queryFn: async () => {
      const { data, error } = await sb
        .from("composants")
        .select("id,reference,name")
        .is("deleted_at", null)
        .order("reference");
      if (error) throw error;
      return data as any[];
    },
  });

  // BOM uses nomenclatures (source of truth for production)
  const bomLines = useQuery({
    queryKey: ["nomenclatures", selectedId],
    enabled: Boolean(selectedId),
    queryFn: async () => {
      const { data: nomRows, error } = await sb
        .from("nomenclatures")
        .select("id, quantity, composant_id, is_active")
        .eq("coffret_id", selectedId)
        .order("created_at", { ascending: true });
      if (error) throw error;

      const composantIds = Array.from(
        new Set(((nomRows ?? []) as any[]).map((n) => n.composant_id).filter(Boolean))
      );
      let composantMap = new Map<string, any>();
      if (composantIds.length > 0) {
        const { data: composantsData, error: composantsError } = await sb
          .from("composants")
          .select("id,reference,name")
          .in("id", composantIds);
        if (composantsError) throw composantsError;
        composantMap = new Map((composantsData ?? []).map((c: any) => [c.id, c]));
      }

      return ((nomRows ?? []) as any[]).map((n) => ({
        ...n,
        composant: composantMap.get(n.composant_id) ?? null,
      })) as any[];
    },
  });

  useEffect(() => {
    if (!selectedId && (coffrets.data ?? []).length > 0) setSelectedId((coffrets.data ?? [])[0].id);
  }, [coffrets.data, selectedId]);

  useEffect(() => {
    const current = (coffrets.data ?? []).find((c) => c.id === selectedId);
    if (!current) return;
    setEditRef(current.reference ?? "");
    setEditName(current.name ?? "");
    setEditWeight(String(current.poids_coffret ?? 0));
    setEditNbPerPalette(String(current.nb_par_palette ?? 1));
    setEditPaletteWeight(String(current.poids_palette ?? 0));
  }, [coffrets.data, selectedId]);

  const activeCoffret = useMemo(() => (coffrets.data ?? []).find((c) => c.id === selectedId), [coffrets.data, selectedId]);

  // ─── Mutations ──────────────────────────────────────────────────────────────

  const createCoffret = useMutation({
    mutationFn: async () => {
      if (!newCoffretRef.trim()) throw new Error("Référence requise");
      if (!newCoffretName.trim()) throw new Error("Nom requis");
      const { data, error } = await sb
        .from("coffrets")
        .insert({ reference: newCoffretRef.trim(), name: newCoffretName.trim() })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: (id) => {
      toast.success("Coffret créé");
      qc.invalidateQueries({ queryKey: ["coffrets"] });
      setNewCoffretOpen(false);
      setNewCoffretRef("");
      setNewCoffretName("");
      setSelectedId(id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveCoffret = useMutation({
    mutationFn: async () => {
      if (!selectedId) throw new Error("Coffret non sélectionné");
      const { error } = await sb.from("coffrets").update({
        reference: editRef.trim(),
        name: editName.trim(),
        poids_coffret: Number(editWeight || 0),
        nb_par_palette: Number(editNbPerPalette || 1),
        poids_palette: Number(editPaletteWeight || 0),
      }).eq("id", selectedId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Coffret mis à jour");
      qc.invalidateQueries({ queryKey: ["coffrets"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteCoffret = useMutation({
    mutationFn: async () => {
      if (!selectedId) return;
      const { data, error } = await sb.rpc("soft_delete_coffret", { p_coffret_id: selectedId });
      if (error) throw error;
      if (data && data.success === false) throw new Error(data.error || "Archivage impossible");
    },
    onSuccess: () => {
      toast.success("Coffret archivé");
      qc.invalidateQueries({ queryKey: ["coffrets"] });
      setSelectedId("");
      setDeleteConfirmOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createComposant = useMutation({
    mutationFn: async () => {
      if (!newCompRef.trim()) throw new Error("Référence requise");
      if (!newCompName.trim()) throw new Error("Nom requis");
      const { error } = await sb.from("composants").insert({
        reference: newCompRef.trim(),
        name: newCompName.trim(),
        poids_unitaire: Number(newCompPoids || 0),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Composant créé");
      qc.invalidateQueries({ queryKey: ["composants"] });
      setNewComposantOpen(false);
      setNewCompRef("");
      setNewCompName("");
      setNewCompPoids("0");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const invalidateBom = () => {
    qc.invalidateQueries({ queryKey: ["nomenclatures", selectedId] });
  };

  const addBomLine = useMutation({
    mutationFn: async () => {
      if (!selectedId || !newCompId) throw new Error("Coffret et composant requis");
      const quantity = parseInt(newCompQty, 10);
      if (!quantity || quantity <= 0) throw new Error("Quantité invalide");
      const { error } = await sb.from("nomenclatures").insert({
        coffret_id: selectedId,
        composant_id: newCompId,
        quantity,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Composant ajouté");
      setNewCompId("");
      setNewCompQty("1");
      invalidateBom();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateBomLine = useMutation({
    mutationFn: async ({ id, quantity }: { id: string; quantity: number }) => {
      const { error } = await sb.from("nomenclatures").update({ quantity }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => invalidateBom(),
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteBomLine = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await sb.from("nomenclatures").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Composant retiré");
      invalidateBom();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const feasibilityQuantity = Math.max(0, Number(feasibilityQty || 0));
  const feasibility = useQuery({
    queryKey: ["production_feasibility", selectedId, feasibilityQuantity],
    enabled: Boolean(selectedId) && feasibilityQuantity > 0,
    queryFn: async () => getProductionFeasibility(selectedId, feasibilityQuantity),
  });

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <header className="mb-4 flex items-end justify-between flex-wrap gap-2">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Référentiel</p>
          <h1 className="text-2xl md:text-3xl font-semibold mt-1">Coffrets</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setNewComposantOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Nouveau composant
          </Button>
          <Button onClick={() => setNewCoffretOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Nouveau coffret
          </Button>
          <Link to="/production" className="inline-flex items-center rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground">Produire</Link>
        </div>
      </header>

      <div className="grid lg:grid-cols-4 gap-3">
        {/* Coffret list */}
        <Card className="lg:col-span-1">
          <CardHeader><CardTitle className="text-base">Coffrets ({(coffrets.data ?? []).length})</CardTitle></CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[70vh] overflow-y-auto">
              {(coffrets.data ?? []).map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={`w-full text-left px-3 py-2 border-t border-border text-xs transition-colors ${selectedId === c.id ? "bg-muted" : "hover:bg-muted/50"}`}
                >
                  <div className="font-mono">{c.reference}</div>
                  <div className="truncate text-muted-foreground">{c.name}</div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="lg:col-span-3 space-y-3">
          {/* Coffret editor */}
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle className="text-base">Édition coffret</CardTitle>
              {activeCoffret && (
                <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDeleteConfirmOpen(true)}>
                  <Trash2 className="h-3.5 w-3.5 mr-1" /> Archiver
                </Button>
              )}
            </CardHeader>
            <CardContent className="grid md:grid-cols-4 gap-3 items-end">
              <div className="space-y-1">
                <Label>Référence</Label>
                <Input value={editRef} onChange={(e) => setEditRef(e.target.value)} disabled={!activeCoffret} />
              </div>
              <div className="space-y-1 md:col-span-2">
                <Label>Désignation</Label>
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} disabled={!activeCoffret} />
              </div>
              <div className="space-y-1">
                <Label>Poids coffret (kg)</Label>
                <Input type="number" value={editWeight} onChange={(e) => setEditWeight(e.target.value)} disabled={!activeCoffret} />
              </div>
              <div className="space-y-1">
                <Label>Nb par palette</Label>
                <Input type="number" min="1" value={editNbPerPalette} onChange={(e) => setEditNbPerPalette(e.target.value)} disabled={!activeCoffret} />
              </div>
              <div className="space-y-1">
                <Label>Poids palette (kg)</Label>
                <Input type="number" min="0" value={editPaletteWeight} onChange={(e) => setEditPaletteWeight(e.target.value)} disabled={!activeCoffret} />
              </div>
              <div className="md:col-span-4 text-right">
                <Button onClick={() => saveCoffret.mutate()} disabled={!activeCoffret || saveCoffret.isPending}>Enregistrer</Button>
              </div>
            </CardContent>
          </Card>

          {/* BOM editor */}
          <Card>
            <CardHeader><CardTitle className="text-base">Nomenclature (composants du coffret)</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid md:grid-cols-4 gap-2 items-end">
                <div className="md:col-span-2 space-y-1">
                  <Label>Composant</Label>
                  <Select value={newCompId} onValueChange={setNewCompId}>
                    <SelectTrigger><SelectValue placeholder="Sélectionner…" /></SelectTrigger>
                    <SelectContent>
                      {(composants.data ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.reference} · {c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Qté</Label>
                  <Input type="number" min="1" value={newCompQty} onChange={(e) => setNewCompQty(e.target.value)} />
                </div>
                <Button onClick={() => addBomLine.mutate()} disabled={addBomLine.isPending || !selectedId || !newCompId}>
                  <Plus className="h-4 w-4 mr-1" /> Ajouter
                </Button>
              </div>

              <div className="overflow-x-auto border border-border rounded-sm">
                <table className="w-full text-sm">
                  <thead className="bg-muted/95 text-[11px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="text-left p-2">Réf.</th>
                      <th className="text-left p-2">Désignation</th>
                      <th className="text-right p-2">Qté</th>
                      <th className="text-right p-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(bomLines.data ?? []).map((n) => (
                      <BomComponentRow
                        key={n.id}
                        row={n}
                        onSave={(quantity) => updateBomLine.mutate({ id: n.id, quantity })}
                        onDelete={() => deleteBomLine.mutate(n.id)}
                      />
                    ))}
                    {(bomLines.data ?? []).length === 0 && (
                      <tr><td className="p-3 text-sm text-muted-foreground" colSpan={4}>Aucune ligne. Sélectionner un coffret et ajouter des composants.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Feasibility */}
          <Card>
            <CardHeader><CardTitle className="text-base">Faisabilité production</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="max-w-xs space-y-1">
                <Label>Quantité à produire</Label>
                <Input type="number" min="1" value={feasibilityQty} onChange={(e) => setFeasibilityQty(e.target.value)} />
              </div>

              {feasibilityQuantity <= 0 ? (
                <p className="text-sm text-muted-foreground">Saisir une quantité supérieure à 0.</p>
              ) : feasibility.isLoading ? (
                <p className="text-sm text-muted-foreground">Calcul en cours…</p>
              ) : !feasibility.data ? null : (
                <>
                  <div className={`rounded-md border px-3 py-2 text-sm font-medium ${feasibility.data.can_produce ? "border-success/30 bg-success/10 text-success" : "border-destructive/30 bg-destructive/10 text-destructive"}`}>
                    {feasibility.data.can_produce ? "Fabrication possible ✓" : "Fabrication impossible"}
                    <span className="ml-2 text-xs text-muted-foreground">
                      ({fmtInt(feasibility.data.summary.total_components)} composants · {fmtInt(feasibility.data.summary.total_missing)} manquants)
                    </span>
                  </div>
                  <div className="overflow-x-auto border border-border rounded-sm">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/95 text-[11px] uppercase tracking-wider text-muted-foreground">
                        <tr>
                          <th className="text-left p-2">Composant</th>
                          <th className="text-right p-2">Besoin</th>
                          <th className="text-right p-2">Disponible</th>
                          <th className="text-center p-2">État</th>
                        </tr>
                      </thead>
                      <tbody>
                        {feasibility.data.components.map((c) => (
                          <tr key={c.composant_id} className="border-t border-border">
                            <td className="p-2 font-medium">{c.name}</td>
                            <td className="p-2 text-right tabular">{fmtInt(c.needed)}</td>
                            <td className="p-2 text-right tabular">{fmtInt(c.available)}</td>
                            <td className="p-2 text-center">
                              {c.status === "ok"
                                ? <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-success/15 text-success border border-success/30">OK</span>
                                : <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-destructive/15 text-destructive border border-destructive/30">Manque {fmtInt(c.missing)}</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Nouveau coffret dialog ── */}
      <Dialog open={newCoffretOpen} onOpenChange={setNewCoffretOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nouveau coffret</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1">
              <Label>Référence <span className="text-destructive">*</span></Label>
              <Input value={newCoffretRef} onChange={(e) => setNewCoffretRef(e.target.value)} placeholder="ex: CST250THD" />
            </div>
            <div className="space-y-1">
              <Label>Désignation <span className="text-destructive">*</span></Label>
              <Input value={newCoffretName} onChange={(e) => setNewCoffretName(e.target.value)} placeholder="Nom du coffret" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewCoffretOpen(false)}>Annuler</Button>
            <Button onClick={() => createCoffret.mutate()} disabled={createCoffret.isPending}>Créer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Nouveau composant dialog ── */}
      <Dialog open={newComposantOpen} onOpenChange={setNewComposantOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nouveau composant</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1">
              <Label>Référence <span className="text-destructive">*</span></Label>
              <Input value={newCompRef} onChange={(e) => setNewCompRef(e.target.value)} placeholder="ex: 857432" />
            </div>
            <div className="space-y-1">
              <Label>Désignation <span className="text-destructive">*</span></Label>
              <Input value={newCompName} onChange={(e) => setNewCompName(e.target.value)} placeholder="Nom de la pièce" />
            </div>
            <div className="space-y-1">
              <Label>Poids unitaire (kg)</Label>
              <Input type="number" min="0" step="0.001" value={newCompPoids} onChange={(e) => setNewCompPoids(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewComposantOpen(false)}>Annuler</Button>
            <Button onClick={() => createComposant.mutate()} disabled={createComposant.isPending}>Créer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Archive coffret confirm ── */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Archiver {activeCoffret?.reference} ?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            Le coffret sera archivé et n'apparaîtra plus dans les listes. Les ordres de fabrication existants conservent leur historique complet grâce au snapshot intégré.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>Annuler</Button>
            <Button variant="destructive" onClick={() => deleteCoffret.mutate()} disabled={deleteCoffret.isPending}>Archiver</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BomComponentRow({ row, onSave, onDelete }: { row: any; onSave: (q: number) => void; onDelete: () => void }) {
  const [qty, setQty] = useState(String(row.quantity ?? 1));
  return (
    <tr className="border-t border-border">
      <td className="p-2 font-mono text-xs text-muted-foreground">{row.composant?.reference}</td>
      <td className="p-2">{row.composant?.name}</td>
      <td className="p-2 text-right w-28">
        <Input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} className="text-right" />
      </td>
      <td className="p-2 text-right">
        <div className="inline-flex gap-1">
          <Button variant="outline" size="sm" onClick={() => onSave(parseInt(qty, 10) || 1)}>Sauver</Button>
          <Button variant="outline" size="sm" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      </td>
    </tr>
  );
}
