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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Check, ChevronsUpDown, Package, Plus, Save, Scale, Trash2 } from "lucide-react";
import { fmtInt } from "@/lib/format";
import { useFeasibility } from "@/hooks/useFeasibility";

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

  const [newCoffretOpen, setNewCoffretOpen] = useState(false);
  const [newCoffretRef, setNewCoffretRef] = useState("");
  const [newCoffretName, setNewCoffretName] = useState("");

  const [newComposantOpen, setNewComposantOpen] = useState(false);
  const [newCompRef, setNewCompRef] = useState("");
  const [newCompName, setNewCompName] = useState("");
  const [newCompPoids, setNewCompPoids] = useState("0");

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [coffretComboOpen, setCoffretComboOpen] = useState(false);

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
        .select("id,reference,name,stock,min_stock,reserved_stock")
        .is("deleted_at", null)
        .order("reference");
      if (error) throw error;
      return data as any[];
    },
  });

  const composantMap = useMemo(() => new Map((composants.data ?? []).map((c: any) => [c.id, c])), [composants.data]);

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
      let composantMapLocal = new Map<string, any>();
      if (composantIds.length > 0) {
        const { data: composantsData, error: composantsError } = await sb
          .from("composants")
          .select("id,reference,name,stock,min_stock,reserved_stock")
          .in("id", composantIds);
        if (composantsError) throw composantsError;
        composantMapLocal = new Map((composantsData ?? []).map((c: any) => [c.id, c]));
      }

      return ((nomRows ?? []) as any[]).map((n) => ({
        ...n,
        composant: composantMapLocal.get(n.composant_id) ?? null,
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

  const reservedByShipment = useQuery({
    queryKey: ["shipment_lines_reserved"],
    queryFn: async () => {
      const { data, error } = await sb
        .from("shipment_lines")
        .select("product_variant_id, quantity, shipment:shipments!inner(status)")
        .in("shipment.status", ["draft", "ready", "shipped"]);
      if (error) throw error;
      const map = new Map<string, number>();
      for (const l of (data ?? []) as any[]) {
        const id = l.product_variant_id as string;
        map.set(id, (map.get(id) ?? 0) + Number(l.quantity));
      }
      return map;
    },
    staleTime: 30_000,
  });

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
      toast.success(MSG.COFFRET_CREATED);
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
      toast.success(MSG.COFFRET_UPDATED);
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
      toast.success(MSG.COFFRET_ARCHIVED);
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
      toast.success(MSG.COMPOSANT_CREATED);
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
      toast.success(MSG.COMPOSANT_ADDED);
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
      toast.success(MSG.COMPOSANT_REMOVED);
      invalidateBom();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const feasibilityQuantity = Math.max(0, Number(feasibilityQty || 0));
  const feasibility = useFeasibility(selectedId, feasibilityQuantity);

  const totalCoffrets = (coffrets.data ?? []).length;

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">
      {/* ── Header ── */}
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Référentiel</p>
          <h1 className="text-2xl md:text-3xl font-semibold mt-0.5">Coffrets</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setNewComposantOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Nouveau composant
          </Button>
          <Button size="sm" onClick={() => setNewCoffretOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Nouveau coffret
          </Button>
          <Link to="/production" search={{ filterStatus: "all" } as any} className="inline-flex items-center rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors">
            Produire →
          </Link>
        </div>
      </header>

      {/* ── Stock fini disponible ── */}
      {(coffrets.data ?? []).some((c: any) => Number(c.stock_fini ?? 0) > 0) && (
        <Card>
          <CardHeader className="pb-2 pt-4">
            <CardTitle className="text-sm font-medium">Disponibilité stock fini</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground uppercase tracking-wider">
                    <th className="text-left px-4 py-2">Référence</th>
                    <th className="text-left px-4 py-2">Produit</th>
                    <th className="text-right px-4 py-2">Fabriqué</th>
                    <th className="text-right px-4 py-2">Réservé expédition</th>
                    <th className="text-right px-4 py-2">Disponible</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(coffrets.data ?? [])
                    .filter((c: any) => Number(c.stock_fini ?? 0) > 0)
                    .map((c: any) => {
                      const fabrique = Number(c.stock_fini ?? 0);
                      const reserve = reservedByShipment.data?.get(c.id) ?? 0;
                      const disponible = fabrique - reserve;
                      return (
                        <tr key={c.id} className="hover:bg-muted/20 transition-colors">
                          <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{c.reference}</td>
                          <td className="px-4 py-2.5 font-medium">{c.name}</td>
                          <td className="px-4 py-2.5 text-right tabular">{fabrique}</td>
                          <td className="px-4 py-2.5 text-right tabular text-muted-foreground">{reserve > 0 ? reserve : "—"}</td>
                          <td className={`px-4 py-2.5 text-right tabular font-semibold ${disponible < 0 ? "text-destructive" : disponible === 0 ? "text-muted-foreground" : "text-foreground"}`}>
                            {disponible}
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

      {/* ── Coffret selector ── */}
      <div className="flex items-center gap-3 py-1">
        <Popover open={coffretComboOpen} onOpenChange={setCoffretComboOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={coffretComboOpen}
              className="w-full max-w-md justify-between h-9 text-sm font-normal"
            >
              {activeCoffret ? (
                <span className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-xs text-muted-foreground shrink-0">{activeCoffret.reference}</span>
                  <span className="truncate">{activeCoffret.name}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">Sélectionner un coffret…</span>
              )}
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-40" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[480px] p-0" align="start">
            <Command>
              <CommandInput placeholder="Référence ou désignation…" className="h-9" />
              <CommandList>
                <CommandEmpty>Aucun coffret trouvé.</CommandEmpty>
                <CommandGroup>
                  {(coffrets.data ?? []).map((c: any) => (
                    <CommandItem
                      key={c.id}
                      value={`${c.reference} ${c.name}`}
                      onSelect={() => { setSelectedId(c.id); setCoffretComboOpen(false); }}
                      className="flex items-center gap-2 py-2"
                    >
                      <Check className={`h-3.5 w-3.5 shrink-0 text-primary ${selectedId === c.id ? "opacity-100" : "opacity-0"}`} />
                      <span className="font-mono text-xs text-muted-foreground w-32 shrink-0 truncate">{c.reference}</span>
                      <span className="truncate text-sm">{c.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <span className="text-xs text-muted-foreground shrink-0 tabular">
          {totalCoffrets} coffret{totalCoffrets !== 1 ? "s" : ""}
        </span>
      </div>

      {/* ── Content (only when coffret selected) ── */}
      {!activeCoffret && !coffrets.isLoading && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Sélectionnez un coffret pour voir et éditer ses informations.
          </CardContent>
        </Card>
      )}

      {activeCoffret && (
        <div className="space-y-4">
          {/* ── Fiche coffret ── */}
          <Card>
            <CardHeader className="pb-3 flex-row items-center justify-between gap-2">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-0.5">Identité</p>
                <CardTitle className="text-base leading-none">{activeCoffret.reference} — {activeCoffret.name}</CardTitle>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive border-destructive/30 hover:border-destructive/50 hover:bg-destructive/5"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Archiver
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Identité */}
              <div className="grid sm:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground uppercase tracking-wide">Référence</Label>
                  <Input value={editRef} onChange={(e) => setEditRef(e.target.value)} className="font-mono" />
                </div>
                <div className="sm:col-span-2 space-y-1.5">
                  <Label className="text-xs text-muted-foreground uppercase tracking-wide">Désignation</Label>
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
                </div>
              </div>

              {/* Poids & palette */}
              <div className="border border-border/60 rounded-md p-3 bg-muted/20 space-y-2">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground flex items-center gap-1">
                  <Scale className="h-3 w-3" /> Poids & conditionnement
                </p>
                <div className="grid sm:grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Poids coffret (kg)</Label>
                    <Input type="number" min="0" step="0.01" value={editWeight} onChange={(e) => setEditWeight(e.target.value)} className="tabular" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Nb par palette</Label>
                    <Input type="number" min="1" value={editNbPerPalette} onChange={(e) => setEditNbPerPalette(e.target.value)} className="tabular" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Poids palette vide (kg)</Label>
                    <Input type="number" min="0" step="0.1" value={editPaletteWeight} onChange={(e) => setEditPaletteWeight(e.target.value)} className="tabular" />
                  </div>
                </div>
              </div>

              {/* Save bar */}
              <div className="flex justify-end pt-1">
                <Button onClick={() => saveCoffret.mutate()} disabled={saveCoffret.isPending} className="gap-1.5">
                  <Save className="h-3.5 w-3.5" />
                  {saveCoffret.isPending ? "Enregistrement…" : "Enregistrer"}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* ── Nomenclature ── */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-0.5">Nomenclature</p>
                  <CardTitle className="text-base leading-none flex items-center gap-1.5">
                    <Package className="h-4 w-4 text-muted-foreground" />
                    Composants du coffret
                    {(bomLines.data ?? []).length > 0 && (
                      <span className="text-xs font-normal text-muted-foreground">
                        · {(bomLines.data ?? []).length} ligne{(bomLines.data ?? []).length !== 1 ? "s" : ""}
                      </span>
                    )}
                  </CardTitle>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Add line */}
              <div className="flex gap-2 items-end bg-muted/30 rounded-md p-3 border border-border/50">
                <div className="flex-1 space-y-1">
                  <Label className="text-xs text-muted-foreground">Composant</Label>
                  <Select value={newCompId} onValueChange={setNewCompId}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Sélectionner un composant…" />
                    </SelectTrigger>
                    <SelectContent>
                      {(composants.data ?? []).map((c: any) => (
                        <SelectItem key={c.id} value={c.id} className="text-xs">
                          <span className="font-mono mr-1.5 text-muted-foreground">{c.reference}</span>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-20 space-y-1">
                  <Label className="text-xs text-muted-foreground">Qté</Label>
                  <Input type="number" min="1" value={newCompQty} onChange={(e) => setNewCompQty(e.target.value)} className="h-8 text-xs text-right tabular" />
                </div>
                <Button
                  size="sm"
                  onClick={() => addBomLine.mutate()}
                  disabled={addBomLine.isPending || !newCompId}
                  className="h-8"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Ajouter
                </Button>
              </div>

              {/* BOM table */}
              <div className="border border-border rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/60 border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground">
                      <th className="text-left px-3 py-2 w-32">Réf.</th>
                      <th className="text-left px-3 py-2">Désignation</th>
                      <th className="text-right px-3 py-2 w-24">Qté</th>
                      <th className="text-right px-3 py-2 w-28">Stock</th>
                      <th className="text-right px-3 py-2 w-28">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {(bomLines.data ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-6 text-center text-xs text-muted-foreground">
                          Aucune ligne — ajoutez des composants ci-dessus.
                        </td>
                      </tr>
                    ) : (
                      (bomLines.data ?? []).map((n: any) => (
                        <BomComponentRow
                          key={n.id}
                          row={n}
                          onSave={(quantity) => updateBomLine.mutate({ id: n.id, quantity })}
                          onDelete={() => deleteBomLine.mutate(n.id)}
                        />
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* ── Faisabilité ── */}
          <Card>
            <CardHeader className="pb-3">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-0.5">Simulation</p>
              <CardTitle className="text-base leading-none">Faisabilité production</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-end gap-3 max-w-xs">
                <div className="flex-1 space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Quantité à produire</Label>
                  <Input type="number" min="1" value={feasibilityQty} onChange={(e) => setFeasibilityQty(e.target.value)} className="tabular" />
                </div>
              </div>

              {feasibilityQuantity <= 0 ? (
                <p className="text-sm text-muted-foreground">Saisir une quantité supérieure à 0.</p>
              ) : feasibility.isLoading ? (
                <p className="text-sm text-muted-foreground">Calcul en cours…</p>
              ) : !feasibility.data ? null : (
                <div className="space-y-3">
                  <div className={`rounded-md border px-4 py-2.5 text-sm font-medium flex items-center justify-between ${
                    feasibility.data.can_produce
                      ? "border-success/30 bg-success/10 text-success"
                      : "border-destructive/30 bg-destructive/10 text-destructive"
                  }`}>
                    <span>{feasibility.data.can_produce ? "Fabrication possible ✓" : "Fabrication impossible ✗"}</span>
                    <span className="text-xs font-normal opacity-70">
                      {fmtInt(feasibility.data.summary.total_components)} composants · {fmtInt(feasibility.data.summary.total_missing)} manquant{feasibility.data.summary.total_missing !== 1 ? "s" : ""}
                    </span>
                  </div>

                  <div className="border border-border rounded-md overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-muted/60 border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground">
                          <th className="text-left px-3 py-2">Composant</th>
                          <th className="text-right px-3 py-2 w-24">Besoin</th>
                          <th className="text-right px-3 py-2 w-28">Disponible</th>
                          <th className="text-center px-3 py-2 w-28">État</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {feasibility.data.components.map((c) => (
                          <tr key={c.composant_id} className="hover:bg-muted/20 transition-colors">
                            <td className="px-3 py-2 font-medium">{c.name}</td>
                            <td className="px-3 py-2 text-right tabular">{fmtInt(c.needed)}</td>
                            <td className="px-3 py-2 text-right tabular">{fmtInt(c.available)}</td>
                            <td className="px-3 py-2 text-center">
                              {c.status === "ok" ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-[11px] font-medium bg-success/15 text-success border border-success/30">OK</span>
                              ) : (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-[11px] font-medium bg-destructive/15 text-destructive border border-destructive/30">
                                  −{fmtInt(c.missing)}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Nouveau coffret dialog ── */}
      <Dialog open={newCoffretOpen} onOpenChange={setNewCoffretOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nouveau coffret</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <Label>Référence <span className="text-destructive">*</span></Label>
              <Input value={newCoffretRef} onChange={(e) => setNewCoffretRef(e.target.value)} placeholder="ex: CST250THD" className="font-mono" />
            </div>
            <div className="space-y-1.5">
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
            <div className="space-y-1.5">
              <Label>Référence <span className="text-destructive">*</span></Label>
              <Input value={newCompRef} onChange={(e) => setNewCompRef(e.target.value)} placeholder="ex: 857432" className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label>Désignation <span className="text-destructive">*</span></Label>
              <Input value={newCompName} onChange={(e) => setNewCompName(e.target.value)} placeholder="Nom de la pièce" />
            </div>
            <div className="space-y-1.5">
              <Label>Poids unitaire (kg)</Label>
              <Input type="number" min="0" step="0.001" value={newCompPoids} onChange={(e) => setNewCompPoids(e.target.value)} className="tabular" />
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
  const isDirty = qty !== String(row.quantity ?? 1);

  const dispo = Math.max(0, Number(row.composant?.stock ?? 0) - Number(row.composant?.reserved_stock ?? 0));
  const min = Number(row.composant?.min_stock ?? 0);
  const isRupture = dispo <= 0;
  const isCritique = !isRupture && dispo <= min && min > 0;

  return (
    <tr className="hover:bg-muted/20 transition-colors group">
      <td className="px-3 py-2">
        {row.composant?.reference ? (
          <Link to="/stock" search={{ filterSearch: row.composant.reference } as any} className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline transition-colors">
            {row.composant.reference}
          </Link>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2">
        <span className="text-sm">{row.composant?.name ?? "—"}</span>
      </td>
      <td className="px-3 py-2 text-right w-24">
        <Input
          type="number"
          min="1"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className="text-right h-7 text-xs w-20 tabular ml-auto"
        />
      </td>
      <td className="px-3 py-2 text-right w-28">
        {row.composant ? (
          isRupture ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-destructive">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-destructive" />
              Rupture
            </span>
          ) : isCritique ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning" />
              {fmtInt(dispo)}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground tabular">{fmtInt(dispo)}</span>
          )
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right w-28">
        <div className="inline-flex gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
          <Button
            variant={isDirty ? "default" : "outline"}
            size="sm"
            className="h-7 text-xs px-2"
            onClick={() => onSave(parseInt(qty, 10) || 1)}
          >
            <Save className="h-3 w-3 mr-1" />
            Sauver
          </Button>
          <Button variant="outline" size="sm" className="h-7 px-2 text-destructive hover:text-destructive hover:bg-destructive/5" onClick={onDelete}>
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </td>
    </tr>
  );
}
