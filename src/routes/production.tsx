import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Archive, AlertTriangle, ChevronsUpDown, FileDown, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { fmtInt } from "@/lib/format";
import { normalizeProductionStatus, productionStatusMeta } from "@/lib/domain";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { getProductionFeasibility } from "@/lib/getProductionFeasibility";

type ProdRow = { id: string; coffret_id: string; quantity: number };

// Génère ou récupère une clé d'idempotence stable pour la session courante.
// Clé stockée dans sessionStorage → survit aux re-renders mais pas au
// rechargement complet de l'onglet. Évite les doublons d'OF sur retry réseau.
function getIdempotencyKey(coffret_id: string, quantity: number, priority: number): string {
  const fingerprint = `${coffret_id}:${quantity}:${priority}`;
  const storageKey  = `ikey:${fingerprint}`;
  let key = sessionStorage.getItem(storageKey);
  if (!key) {
    key = `of:${fingerprint}:${Date.now()}`;
    sessionStorage.setItem(storageKey, key);
  }
  return key;
}
function clearIdempotencyKey(coffret_id: string, quantity: number, priority: number): void {
  sessionStorage.removeItem(`ikey:${coffret_id}:${quantity}:${priority}`);
}

type LineCheck = {
  rowId: string;
  ok: boolean;
  missing: Array<{ reference: string; name: string; manquant: number }>;
  remaining: Array<{ reference: string; name: string; apres_production: number }>;
};

export const Route = createFileRoute("/production")({
  head: () => ({
    meta: [
      { title: "Production — Atelier" },
      { name: "description", content: "Fabrication de coffrets et suivi d'avancement." },
    ],
  }),
  component: ProductionPage,
});


function ProductionPage() {
  const sb = supabase as any;
  const qc = useQueryClient();

  const [rows, setRows] = useState<ProdRow[]>([{ id: crypto.randomUUID(), coffret_id: "", quantity: 1 }]);
  const [urgent, setUrgent] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportQtys, setExportQtys] = useState<Record<string, string>>({});
  const [comboOpen, setComboOpen] = useState<Record<string, boolean>>({});
  const [comboSearch, setComboSearch] = useState<Record<string, string>>({});
  const [validateTarget, setValidateTarget] = useState<{
    id: string; quantity: number; produced_qty: number; coffretName: string;
  } | null>(null);
  const [validateQty, setValidateQty] = useState<string>("");
  const [deleteOfTarget, setDeleteOfTarget] = useState<{ id: string; reference: string; coffretName: string } | null>(null);
  const [deleteOfCode, setDeleteOfCode] = useState<string>("");
  const [deleteOfInput, setDeleteOfInput] = useState<string>("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archivePeriod, setArchivePeriod] = useState<"3m" | "6m" | "1an" | "tout">("3m");
  const [archiveIncludeDone, setArchiveIncludeDone] = useState(true);
  const [archiveIncludeCanceled, setArchiveIncludeCanceled] = useState(true);
  const [archiveCode, setArchiveCode] = useState<string>("");
  const [archiveInput, setArchiveInput] = useState<string>("");
  const [archiveExporting, setArchiveExporting] = useState(false);

  const coffrets = useQuery({
    queryKey: ["coffrets", "production"],
    queryFn: async () => {
      const { data, error } = await sb
        .from("coffrets")
        .select("id,reference,name")
        .is("deleted_at", null)
        .order("reference");
      if (error) throw error;
      return data ?? [];
    },
  });

  const lineChecks = useQuery({
    queryKey: ["production", "checks", rows.map((r) => ({ coffret_id: r.coffret_id, quantity: r.quantity }))],
    enabled: rows.some((r) => r.coffret_id && r.quantity > 0),
    queryFn: async () => {
      const checks: LineCheck[] = [];

      for (const row of rows) {
        if (!row.coffret_id || row.quantity <= 0) {
          checks.push({ rowId: row.id, ok: false, missing: [], remaining: [] });
          continue;
        }

        const feasibility = await getProductionFeasibility(row.coffret_id, row.quantity);
        const missing: Array<{ reference: string; name: string; manquant: number }> = feasibility.missing.map((item) => ({
          reference: item.composant_id,
          name: item.name,
          manquant: item.missing,
        }));
        const remaining: Array<{ reference: string; name: string; apres_production: number }> = feasibility.components.map((item) => ({
          reference: item.composant_id,
          name: item.name,
          apres_production: item.available - item.needed,
        }));

        checks.push({
          rowId: row.id,
          ok: feasibility.can_produce,
          missing,
          remaining,
        });
      }

      return checks;
    },
  });

  const checksByRow = useMemo(() => {
    const m = new Map<string, LineCheck>();
    for (const check of lineChecks.data ?? []) m.set(check.rowId, check);
    return m;
  }, [lineChecks.data]);

  const validRows = rows.filter((r) => r.coffret_id && r.quantity > 0);
  // Autorise la création dès que les checks ont chargé, même avec stock insuffisant.
  // La faisabilité est affichée visuellement mais ne bloque plus la création (planification anticipée).
  // P0.3 (transition → in_progress) constitue la garde d'exécution.
  const canCreate =
    validRows.length > 0 &&
    !lineChecks.isLoading &&
    validRows.every((row) => !!checksByRow.get(row.id));

  const orders = useQuery({
    queryKey: ["production_orders", "atelier"],
    queryFn: async () => {
      const { data: rawOrders, error } = await sb
        .from("production_orders")
        .select("*, coffret_snapshot")
        .order("created_at", { ascending: false });
      if (error) throw error;

      const filtered = ((rawOrders ?? []) as any[]).map((row) => ({
        ...row,
        status:      normalizeProductionStatus(row.status),
        produced_qty: Number(row.produced_qty ?? 0),
      }));
      const ids = Array.from(new Set(filtered.map((o) => o.coffret_id).filter(Boolean)));

      let coffretMap = new Map<string, any>();
      if (ids.length > 0) {
        const { data: coffretsData, error: coffretsError } = await sb
          .from("coffrets")
          .select("id,reference,name")
          .in("id", ids);
        if (coffretsError) throw coffretsError;
        coffretMap = new Map((coffretsData ?? []).map((c: any) => [c.id, c]));
      }

      return filtered.map((o) => ({ ...o, coffret: coffretMap.get(o.coffret_id) ?? null }));
    },
  });

  const createFabrication = useMutation({
    retry: 0,  // jamais de retry auto : la clé d'idempotence couvre les erreurs réseau
    mutationFn: async () => {
      const results: Array<{ can_start_now: boolean }> = [];
      for (const row of validRows) {
        const p = urgent ? 1 : 0;
        const { data, error } = await sb.rpc("create_production_order_atomic", {
          p_coffret_id:      row.coffret_id,
          p_quantity:        row.quantity,
          p_status:          urgent ? "priority" : "draft",
          p_priority:        p,
          p_notes:           null,
          p_idempotency_key: getIdempotencyKey(row.coffret_id, row.quantity, p),
        });
        if (error) throw error;
        if (data && data.success === false) throw new Error(data.error || "Création impossible");
        clearIdempotencyKey(row.coffret_id, row.quantity, p);
        results.push({ can_start_now: data?.can_start_now !== false });
      }
      return results;
    },
    onSuccess: (results) => {
      const hasDeficit = results.some((r) => !r.can_start_now);
      if (hasDeficit) {
        toast.warning("OF planifié — stock insuffisant au moment de la création (voir liste)");
      } else {
        toast.success("Fabrication créée — stock réservé");
      }
      qc.invalidateQueries({ queryKey: ["production_orders"] });
      qc.invalidateQueries({ queryKey: ["composants"] });
      qc.invalidateQueries({ queryKey: ["stock_snapshot"] });
      setRows([{ id: crypto.randomUUID(), coffret_id: "", quantity: 1 }]);
      setUrgent(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const transition = useMutation({
    retry: 0,
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { data, error } = await sb.rpc("transition_production_order_status", {
        p_order_id: id,
        p_status:   status,
      });
      if (error) throw error;
      if (data && data.success === false) throw new Error(data.error || "Transition impossible");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production_orders"] });
      qc.invalidateQueries({ queryKey: ["composants"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelOrder = useMutation({
    retry: 0,
    mutationFn: async (id: string) => {
      const { data, error } = await sb.rpc("cancel_production_order_with_unreserve", {
        p_order_id: id,
      });
      if (error) throw error;
      if (data && data.success === false) throw new Error(data.error || "Annulation impossible");
    },
    onSuccess: () => {
      toast.success("Fabrication annulée — réservations libérées");
      qc.invalidateQueries({ queryKey: ["production_orders"] });
      qc.invalidateQueries({ queryKey: ["composants"] });
      qc.invalidateQueries({ queryKey: ["stock_snapshot"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteOrder = useMutation({
    retry: 0,
    mutationFn: async (id: string) => {
      const { data, error } = await sb.rpc("delete_archived_production_order", {
        p_order_id: id,
      });
      if (error) throw error;
      if (data && data.success === false) throw new Error(data.error || "Suppression impossible");
    },
    onSuccess: () => {
      toast.success("Fabrication supprimée");
      qc.invalidateQueries({ queryKey: ["production_orders"] });
      setDeleteOfTarget(null);
      setDeleteOfInput("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function openDeleteOfDialog(o: { id: string; reference?: string; coffret?: { name?: string } | null; coffret_snapshot?: { name?: string } | null }) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    setDeleteOfCode(code);
    setDeleteOfInput("");
    setDeleteOfTarget({
      id: o.id,
      reference: o.reference ?? o.id.slice(0, 8),
      coffretName: (o.coffret as any)?.name ?? (o.coffret_snapshot as any)?.name ?? "Coffret archivé",
    });
  }

  function openArchiveDialog() {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    setArchiveCode(code);
    setArchiveInput("");
    setArchiveOpen(true);
  }

  const archiveBefore = useMemo<string | null>(() => {
    const now = new Date();
    if (archivePeriod === "3m") { const d = new Date(now); d.setMonth(d.getMonth() - 3); return d.toISOString(); }
    if (archivePeriod === "6m") { const d = new Date(now); d.setMonth(d.getMonth() - 6); return d.toISOString(); }
    if (archivePeriod === "1an") { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); return d.toISOString(); }
    return null;
  }, [archivePeriod]);

  const archiveStatuses = useMemo(() => {
    const s: string[] = [];
    if (archiveIncludeDone) s.push("done", "termine");
    if (archiveIncludeCanceled) s.push("canceled", "annule");
    return s;
  }, [archiveIncludeDone, archiveIncludeCanceled]);

  const archivePreview = useMemo(() => {
    if (!archiveOpen) return [] as any[];
    const cutoff = archiveBefore ? new Date(archiveBefore) : null;
    return (orders.data ?? []).filter((o: any) => {
      const st = String(o.status);
      const matches =
        (archiveIncludeDone && (st === "done" || st === "termine")) ||
        (archiveIncludeCanceled && (st === "canceled" || st === "annule"));
      if (!matches) return false;
      if (cutoff && new Date(o.created_at) >= cutoff) return false;
      return true;
    });
  }, [archiveOpen, archiveBefore, archiveIncludeDone, archiveIncludeCanceled, orders.data]);

  const archiveOrders = useMutation({
    retry: 0,
    mutationFn: async () => {
      const { data, error } = await sb.rpc("delete_production_orders_period", {
        p_statuses: archiveStatuses,
        p_before: archiveBefore,
      });
      if (error) throw error;
      if (data && data.success === false) throw new Error(data.error || "Archivage impossible");
      return data as { success: boolean; deleted_count: number };
    },
    onSuccess: (data) => {
      const n = data.deleted_count;
      toast.success(`${n} OF${n !== 1 ? "s" : ""} archivé${n !== 1 ? "s" : ""}`);
      qc.invalidateQueries({ queryKey: ["production_orders"] });
      setArchiveOpen(false);
      setArchiveInput("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function generateArchiveCsv() {
    setArchiveExporting(true);
    try {
      const orderIds = archivePreview.map((o: any) => o.id as string);
      if (orderIds.length === 0) { toast.error("Aucun OF à exporter"); return; }
      const dateStr = new Date().toISOString().slice(0, 10);
      const cutoff = archiveBefore;
      const periodLabel = archivePeriod === "tout" ? "Tout" : archivePeriod === "1an" ? "1 an" : archivePeriod === "6m" ? "6 mois" : "3 mois";

      const fabricLines: string[] = [
        "=== 1. FABRICATIONS ===",
        "Référence OF;Coffret (réf);Coffret (nom);Qté planifiée;Qté produite;Statut;Date création",
      ];
      for (const o of archivePreview as any[]) {
        const snap = (o.coffret_snapshot ?? {}) as { reference?: string; name?: string };
        const coffretRef = o.coffret?.reference ?? snap.reference ?? "—";
        const coffretName = o.coffret?.name ?? snap.name ?? "Coffret archivé";
        const statusLabel = productionStatusMeta[String(o.status)]?.label ?? o.status;
        fabricLines.push(`${o.reference ?? o.id.slice(0, 8)};${coffretRef};${coffretName};${o.quantity};${o.produced_qty ?? 0};${statusLabel};${(o.created_at ?? "").slice(0, 10)}`);
      }

      const { data: consumData, error: consumError } = await sb
        .from("production_consumption")
        .select("production_order_id, quantity, composant:composants(reference, name)")
        .in("production_order_id", orderIds);
      if (consumError) throw consumError;

      const orderRefMap = new Map((archivePreview as any[]).map((o: any) => [o.id as string, o.reference ?? (o.id as string).slice(0, 8)]));
      const consumLines: string[] = [
        "",
        "=== 2. CONSOMMATIONS ===",
        "Référence OF;Réf. composant;Nom composant;Quantité consommée",
      ];
      for (const c of (consumData ?? []) as any[]) {
        const ofRef = orderRefMap.get(c.production_order_id) ?? (c.production_order_id as string).slice(0, 8);
        consumLines.push(`${ofRef};${c.composant?.reference ?? "—"};${c.composant?.name ?? "—"};${c.quantity}`);
      }

      // P0.2 — exclure les composants supprimés (soft-delete) du snapshot stock
      const { data: stockData, error: stockError } = await sb
        .from("composants")
        .select("reference, name, stock, reserved_stock")
        .is("deleted_at", null)
        .order("reference");
      if (stockError) throw stockError;

      const stockLines: string[] = [
        "",
        "=== 3. STOCK ACTUEL ===",
        "Réf. composant;Nom composant;Stock physique;Stock réservé;Disponible",
      ];
      for (const c of (stockData ?? []) as any[]) {
        const dispo = Math.max(0, Number(c.stock) - Number(c.reserved_stock ?? 0));
        stockLines.push(`${c.reference};${c.name};${c.stock};${c.reserved_stock ?? 0};${dispo}`);
      }

      // P0.3 — filtrer les expéditions côté serveur pour éviter la troncature
      // silencieuse à 1000 lignes (limite PostgREST par défaut).
      // On passe la date limite directement dans la requête SQL ;
      // pour le mode "tout" (cutoff=null), on applique un .limit(5000) explicite
      // qui remplace le plafond par défaut de 1000.
      const shipLines: string[] = ["", "=== 4. EXPÉDITIONS ===", "Référence;Client;Statut;Date création"];
      let shipQuery = (sb as any)
        .from("shipments")
        .select("reference, status, created_at, client:clients(name)")
        .order("created_at", { ascending: false })
        .limit(5000);
      if (cutoff) {
        shipQuery = shipQuery.lt("created_at", cutoff);
      }
      const { data: shipData, error: shipError } = await shipQuery;
      if (shipError) {
        shipLines.push("(données non disponibles)");
      } else {
        for (const s of (shipData ?? []) as any[]) {
          shipLines.push(`${s.reference ?? "—"};${(s.client as any)?.name ?? "—"};${s.status ?? "—"};${(s.created_at ?? "").slice(0, 10)}`);
        }
      }

      const allLines = [
        `﻿Export archives OFs — ${dateStr}`,
        `Période : ${periodLabel}`,
        `OFs inclus : ${orderIds.length}`,
        "",
        ...fabricLines,
        ...consumLines,
        ...stockLines,
        ...shipLines,
      ];

      const blob = new Blob([allLines.join("\n")], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `archives-of-${dateStr}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Export CSV téléchargé");
    } catch (e: any) {
      toast.error((e as Error).message ?? "Erreur export CSV");
    } finally {
      setArchiveExporting(false);
    }
  }

  const finish = useMutation({
    retry: 0,  // idempotent côté SQL mais on n'accepte pas de double soumission
    mutationFn: async ({ id, qty }: { id: string; qty?: number }) => {
      const { data, error } = await sb.rpc("validate_production_order", {
        p_order_id: id,
        p_qty:      qty ?? null,
      });
      if (error) throw error;
      if (data && data.success === false) throw new Error(data.error || "Validation impossible");
      return data as { status: string; validated_qty: number; produced_qty: number; total_qty: number };
    },
    onSuccess: (data) => {
      if (data?.status === "done") toast.success("Fabrication terminée — stock mis à jour");
      else toast.success(`Validation partielle : ${data?.produced_qty ?? "?"}/${data?.total_qty ?? "?"}`);
      qc.invalidateQueries({ queryKey: ["production_orders"] });
      qc.invalidateQueries({ queryKey: ["composants"] });
      qc.invalidateQueries({ queryKey: ["stock_movements"] });
      qc.invalidateQueries({ queryKey: ["composant_movements"] });
      setValidateTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function openExportDialog() {
    // Pre-fill with current planner rows (coffret_id → quantity)
    const prefill: Record<string, string> = {};
    for (const r of rows) {
      if (r.coffret_id && r.quantity > 0) prefill[r.coffret_id] = String(r.quantity);
    }
    setExportQtys(prefill);
    setExportOpen(true);
  }

  async function runExport() {
    const activeQtys = Object.entries(exportQtys).filter(([, v]) => Number(v) > 0);
    if (activeQtys.length === 0) { toast.error("Saisissez au moins une quantité"); return; }

    const coffretIds = activeQtys.map(([id]) => id);
    const { data, error } = await (sb
      .from("nomenclatures")
      .select("quantity, coffret_id, coffret:coffrets(id,reference,name), composant:composants(reference,name,stock,reserved_stock)")
      .eq("is_active", true)
      .in("coffret_id", coffretIds) as any);
    if (error) { toast.error(error.message); return; }

    type NomRow = { quantity: number; coffret_id: string; coffret: any; composant: any };
    const qtyMap = Object.fromEntries(activeQtys.map(([id, v]) => [id, Number(v)]));

    const byCoffret = new Map<string, { coffretRef: string; coffretName: string; prodQty: number; lines: { ref: string; name: string; requis: number; dispo: number; manquant: number; statut: string }[] }>();
    for (const r of (data ?? []) as NomRow[]) {
      const prodQty = qtyMap[r.coffret_id] ?? 0;
      const requis = Number(r.quantity) * prodQty;
      const dispo = Math.max(0, Number(r.composant?.stock ?? 0) - Number(r.composant?.reserved_stock ?? 0));
      const manquant = Math.max(0, requis - dispo);
      if (manquant <= 0) continue;
      const key = r.coffret?.reference ?? r.coffret_id;
      if (!byCoffret.has(key)) byCoffret.set(key, { coffretRef: key, coffretName: r.coffret?.name ?? key, prodQty, lines: [] });
      byCoffret.get(key)!.lines.push({
        ref: r.composant?.reference ?? "?",
        name: r.composant?.name ?? "?",
        requis,
        dispo,
        manquant,
        statut: dispo === 0 ? "BLOQUÉ" : "PARTIEL",
      });
    }

    const now = new Date().toISOString().slice(0, 10);
    const csvLines: string[] = [
      `﻿Export pièces manquantes — ${now}`,
      "",
      "Coffret;Nom coffret;Tirage;Réf. composant;Nom composant;Qté requise;Stock dispo;Qté manquante;Statut",
    ];

    let totalManquant = 0;
    const totauxParComposant = new Map<string, { ref: string; name: string; total: number }>();

    for (const [, c] of Array.from(byCoffret.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const l of c.lines) {
        csvLines.push(`${c.coffretRef};${c.coffretName};${c.prodQty};${l.ref};${l.name};${l.requis};${l.dispo};${l.manquant};${l.statut}`);
        totalManquant += l.manquant;
        const ex = totauxParComposant.get(l.ref);
        if (ex) ex.total += l.manquant;
        else totauxParComposant.set(l.ref, { ref: l.ref, name: l.name, total: l.manquant });
      }
    }

    csvLines.push("", "=== TOTAL GLOBAL PAR COMPOSANT ===", "Réf. composant;Nom composant;Total manquant");
    for (const [, v] of Array.from(totauxParComposant.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      csvLines.push(`${v.ref};${v.name};${v.total}`);
    }
    csvLines.push("", `TOTAL GLOBAL;;${totalManquant}`);

    const blob = new Blob([csvLines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pieces-manquantes-${now}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setExportOpen(false);
    toast.success("Export CSV téléchargé");
  }

  const validateRemaining = validateTarget
    ? validateTarget.quantity - validateTarget.produced_qty
    : 0;
  const validateQtyNum = Math.trunc(Number(validateQty));
  const validateQtyValid =
    Number.isFinite(validateQtyNum) && validateQtyNum > 0 && validateQtyNum <= validateRemaining;

  return (
    <TooltipProvider delayDuration={300}>
    <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-6">
      {/* ── Dialog de validation (totale ou partielle) ── */}
      <Dialog
        open={!!validateTarget}
        onOpenChange={(open) => { if (!open) setValidateTarget(null); }}
      >
        <DialogContent className="max-w-sm" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Valider la fabrication</DialogTitle>
          </DialogHeader>
          {validateTarget && (
            <div className="space-y-4">
              <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm space-y-1">
                <div className="font-semibold">{validateTarget.coffretName}</div>
                <div className="text-muted-foreground text-xs">
                  Déjà produit : {fmtInt(validateTarget.produced_qty)} / {fmtInt(validateTarget.quantity)}
                  &ensp;·&ensp;Restant : {fmtInt(validateRemaining)}
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Quantité à valider</label>
                <Input
                  type="number"
                  min={1}
                  max={validateRemaining}
                  value={validateQty}
                  onChange={(e) => setValidateQty(e.target.value)}
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Saisir {fmtInt(validateRemaining)} pour terminer l&rsquo;OF complètement.
                  Un chiffre inférieur crée une validation partielle.
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setValidateTarget(null)}>Annuler</Button>
            <Button
              disabled={!validateQtyValid || finish.isPending}
              onClick={() => validateTarget && finish.mutate({
                id:  validateTarget.id,
                qty: validateQtyNum < validateRemaining ? validateQtyNum : undefined,
              })}
            >
              {finish.isPending
                ? "Validation…"
                : validateQtyNum === validateRemaining
                  ? "Terminer l'OF"
                  : `Valider ${validateQtyNum > 0 ? fmtInt(validateQtyNum) : "?"} / ${fmtInt(validateTarget?.quantity ?? 0)}`
              }
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Production</p>
          <h1 className="text-3xl md:text-4xl font-display font-semibold mt-1">Fabrication de coffrets</h1>
        </div>
        <Button variant="outline" onClick={openExportDialog} className="flex items-center gap-2 mt-2">
          <FileDown className="h-4 w-4" /> Export pièces manquantes
        </Button>
      </header>

      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="max-w-lg" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Export pièces manquantes</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Indiquez le tirage souhaité par coffret. Seuls les coffrets avec une quantité &gt; 0 seront inclus.</p>
          <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
            {(coffrets.data ?? []).map((c: any) => (
              <div key={c.id} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{c.name}</div>
                  <div className="text-xs font-mono text-muted-foreground">{c.reference}</div>
                </div>
                <Input
                  type="number"
                  min={0}
                  placeholder="Qté"
                  className="w-28 text-right"
                  value={exportQtys[c.id] ?? ""}
                  onChange={(e) => setExportQtys((prev) => ({ ...prev, [c.id]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExportOpen(false)}>Annuler</Button>
            <Button onClick={runExport} className="flex items-center gap-2">
              <FileDown className="h-4 w-4" /> Exporter CSV
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Créer fabrication</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {coffrets.data && coffrets.data.length === 0 && (
            <p className="text-sm text-muted-foreground">Aucune donnée disponible</p>
          )}

          {rows.map((row, idx) => {
            const check = checksByRow.get(row.id);
            const feasible = check?.ok === true;
            const hasMissing = !feasible && check && check.missing.length > 0;
            const notConfigured = !feasible && check && check.missing.length === 0;

            const statusCls = feasible
              ? "bg-success/15 text-success border border-success/30"
              : hasMissing
                ? "bg-warning/15 text-warning border border-warning/30"
                : "bg-destructive/15 text-destructive border border-destructive/30";

            const statusTxt = feasible
              ? "Fabrication possible"
              : hasMissing
                ? `${check.missing.length} pièce${check.missing.length > 1 ? "s" : ""} manquante${check.missing.length > 1 ? "s" : ""}`
                : notConfigured
                  ? "Nomenclature manquante"
                  : "—";

            return (
              <div key={row.id} className="rounded-md border border-border p-3 space-y-3">
                <div className="grid md:grid-cols-12 gap-3 items-end">
                  <div className="md:col-span-6">
                    <label className="text-xs text-muted-foreground">Coffret</label>
                    {(() => {
                      const selected = (coffrets.data ?? []).find((c: any) => c.id === row.coffret_id);
                      const search = (comboSearch[row.id] ?? "").toLowerCase();
                      const filtered = (coffrets.data ?? []).filter((c: any) =>
                        !search || c.reference.toLowerCase().includes(search) || c.name.toLowerCase().includes(search)
                      );
                      return (
                        <Popover
                          open={comboOpen[row.id] ?? false}
                          onOpenChange={(open) => setComboOpen((p) => ({ ...p, [row.id]: open }))}
                        >
                          <PopoverTrigger asChild>
                            <Button variant="outline" className="w-full justify-between font-normal truncate">
                              {selected
                                ? <span className="truncate"><span className="font-mono text-xs mr-2">{selected.reference}</span>{selected.name}</span>
                                : <span className="text-muted-foreground">Sélectionner un coffret…</span>}
                              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-[340px] p-0" align="start">
                            <Command shouldFilter={false}>
                              <CommandInput
                                placeholder="Rechercher par référence ou nom…"
                                value={comboSearch[row.id] ?? ""}
                                onValueChange={(v) => setComboSearch((p) => ({ ...p, [row.id]: v }))}
                              />
                              <CommandList>
                                {filtered.length === 0 && <CommandEmpty>Aucun coffret trouvé</CommandEmpty>}
                                {filtered.map((c: any) => (
                                  <CommandItem
                                    key={c.id}
                                    value={c.id}
                                    onSelect={() => {
                                      setRows((prev) => prev.map((r) => r.id === row.id ? { ...r, coffret_id: c.id } : r));
                                      setComboOpen((p) => ({ ...p, [row.id]: false }));
                                      setComboSearch((p) => ({ ...p, [row.id]: "" }));
                                    }}
                                  >
                                    <span className="font-mono text-xs mr-2 text-muted-foreground">{c.reference}</span>
                                    <span>{c.name}</span>
                                  </CommandItem>
                                ))}
                              </CommandList>
                            </Command>
                          </PopoverContent>
                        </Popover>
                      );
                    })()}
                  </div>

                  <div className="md:col-span-3">
                    <label className="text-xs text-muted-foreground">Quantité</label>
                    <Input
                      type="number"
                      min="1"
                      value={String(row.quantity)}
                      onChange={(e) =>
                        setRows((prev) =>
                          prev.map((r) => (r.id === row.id ? { ...r, quantity: Math.max(0, Number(e.target.value || 0)) } : r))
                        )
                      }
                    />
                  </div>

                  <div className="md:col-span-3 flex gap-2">
                    <span className={`inline-flex items-center rounded-sm px-2 py-1 text-[11px] font-medium ${statusCls}`}>
                      {statusTxt}
                    </span>

                    {rows.length > 1 && (
                      <Button
                        variant="outline"
                        onClick={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
                      >
                        Retirer
                      </Button>
                    )}
                  </div>
                </div>

                {!!check && (
                  <div className="grid md:grid-cols-2 gap-3 text-xs">
                    <div className="rounded-md border border-border p-2">
                      <div className="font-medium mb-1">Pièces manquantes</div>
                      {check.missing.length === 0 ? (
                        <div className="text-success">Aucune</div>
                      ) : (
                        <ul className="space-y-1">
                          {check.missing.slice(0, 4).map((m) => (
                            <li key={`${row.id}-${m.reference}`} className="text-destructive">
                              {m.reference} · {m.name} : {fmtInt(m.manquant)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div className="rounded-md border border-border p-2">
                      <div className="font-medium mb-1">Stock après fabrication</div>
                      {check.remaining.length === 0 ? (
                        <div className="text-muted-foreground">Aucune donnée disponible</div>
                      ) : (
                        <ul className="space-y-1">
                          {check.remaining.slice(0, 4).map((m) => (
                            <li key={`${row.id}-${m.reference}-rest`}>
                              {m.reference} · {m.name} : {fmtInt(m.apres_production)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}

                {idx === rows.length - 1 && (
                  <Button
                    variant="outline"
                    onClick={() => setRows((prev) => [...prev, { id: crypto.randomUUID(), coffret_id: "", quantity: 1 }])}
                  >
                    Ajouter ligne
                  </Button>
                )}
              </div>
            );
          })}

          <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
            <div>
              <div className="text-sm font-medium">Priorité</div>
              <div className="text-xs text-muted-foreground">{urgent ? "Urgent" : "Normal"}</div>
            </div>
            <Switch checked={urgent} onCheckedChange={setUrgent} />
          </div>

          {validRows.some((r) => {
            const c = checksByRow.get(r.id);
            return c && !c.ok && c.missing.length > 0;
          }) && (
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                Certains composants manquent. L'OF sera planifié avec des réservations en déficit —
                le démarrage sera bloqué tant que le stock n'est pas réapprovisionné.
              </span>
            </div>
          )}

          <Button className="w-full" onClick={() => createFabrication.mutate()} disabled={!canCreate || createFabrication.isPending}>
            {validRows.some((r) => {
              const c = checksByRow.get(r.id);
              return c && !c.ok && c.missing.length > 0;
            }) ? "Planifier (stock insuffisant)" : "Créer fabrication"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base">Suivi fabrication</CardTitle>
          <Button size="sm" variant="outline" onClick={openArchiveDialog} className="flex items-center gap-2">
            <Archive className="h-4 w-4" /> Archiver
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-[88px] md:top-0 z-10 bg-muted/95 text-xs uppercase tracking-wider text-muted-foreground backdrop-blur">
                <tr>
                  <th className="text-left p-3">Coffret</th>
                  <th className="text-right p-3">Qté</th>
                  <th className="text-right p-3">Produit</th>
                  <th className="text-center p-3">Priorité</th>
                  <th className="text-center p-3">Statut</th>
                  <th className="text-right p-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {(orders.data ?? []).length === 0 ? (
                  <tr>
                    <td className="p-4 text-sm text-muted-foreground" colSpan={5}>
                      <div className="flex flex-col items-center gap-2 py-2 text-center">
                        <span>Aucune donnée disponible</span>
                        <Link to="/production" className="inline-flex items-center rounded-sm border border-input px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground">Créer fabrication</Link>
                      </div>
                    </td>
                  </tr>
                ) : (orders.data ?? []).map((o: any) => (
                  (() => {
                    const status = String(o.status);
                    const canStart  = status === "draft" || status === "priority";
                    const canFinish = status === "in_progress" || status === "partial";
                    const canCancel = status === "draft" || status === "priority"
                                   || status === "in_progress" || status === "partial";
                    const snapshot = o.coffret_snapshot as { reference?: string; name?: string } | null;
                    const coffretName = o.coffret?.name ?? snapshot?.name ?? "Coffret archivé";
                    const coffretRef = o.coffret?.reference ?? snapshot?.reference ?? "—";

                    return (
                      <tr key={o.id} className="border-t border-border">
                        <td className="p-3">
                          <div className="font-medium">{coffretName}</div>
                          <div className="text-xs text-muted-foreground font-mono">{coffretRef}</div>
                        </td>
                        <td className="p-3 text-right tabular font-semibold">{fmtInt(o.quantity)}</td>
                        <td className="p-3 text-right tabular text-sm text-muted-foreground">
                          {o.produced_qty > 0 ? fmtInt(o.produced_qty) : <span className="opacity-40">—</span>}
                        </td>
                        <td className="p-3 text-center">
                          <span className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[11px] font-medium ${Number(o.priority ?? 0) === 1 ? "border-destructive/30 bg-destructive/15 text-destructive" : "border-border bg-muted text-muted-foreground"}`}>
                            {Number(o.priority ?? 0) === 1 ? "Urgent" : "Normal"}
                          </span>
                        </td>
                        <td className="p-3 text-center">
                          <div className="flex flex-col items-center gap-1">
                            <span className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[11px] font-medium ${productionStatusMeta[status]?.cls ?? "bg-muted text-muted-foreground border border-border"}`}>
                              {productionStatusMeta[status]?.label ?? "Statut inconnu"}
                            </span>
                            {o.can_start_now === false && canStart && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex items-center gap-1 rounded-sm border border-warning/30 bg-warning/15 text-warning px-2 py-0.5 text-[11px] font-medium cursor-help">
                                    <AlertTriangle className="h-3 w-3" /> Déficit stock
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-[240px] text-xs">
                                  Stock insuffisant lors de la planification — état au moment de la création.
                                  Réapprovisionner avant de démarrer.
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        </td>
                        <td className="p-3 text-right">
                          <div className="inline-flex gap-1.5">
                            {canStart && (
                              <Button size="sm" variant="outline" onClick={() => transition.mutate({ id: o.id, status: "in_progress" })} disabled={transition.isPending}>
                                Démarrer
                              </Button>
                            )}
                            {canFinish && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={finish.isPending}
                                onClick={() => {
                                  setValidateQty(String(o.quantity - o.produced_qty));
                                  setValidateTarget({
                                    id: o.id,
                                    quantity: o.quantity,
                                    produced_qty: o.produced_qty,
                                    coffretName: o.coffret?.name ?? "—",
                                  });
                                }}
                              >
                                Valider
                              </Button>
                            )}
                            {canCancel && (
                              <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => cancelOrder.mutate(o.id)} disabled={cancelOrder.isPending}>
                                Annuler
                              </Button>
                            )}
                            {status === "canceled" && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="text-destructive hover:text-destructive"
                                    disabled={deleteOrder.isPending}
                                    onClick={() => deleteOrder.mutate(o.id)}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent className="text-xs">Supprimer définitivement</TooltipContent>
                              </Tooltip>
                            )}
                            {status === "done" && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="text-destructive hover:text-destructive"
                                    onClick={() => openDeleteOfDialog(o)}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent className="text-xs">Supprimer définitivement</TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })()
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>

    {/* ── Dialog archivage en masse ── */}
    <Dialog open={archiveOpen} onOpenChange={(open) => { if (!open) { setArchiveOpen(false); setArchiveInput(""); } }}>
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Archiver les fabrications</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Supprime définitivement les OFs sélectionnés. Le stock physique, les coffrets et l'historique des mouvements sont conservés.
          </p>
          <div className="space-y-2">
            <div className="text-sm font-medium">Statuts à archiver</div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Checkbox id="arch-done" checked={archiveIncludeDone} onCheckedChange={(v) => setArchiveIncludeDone(!!v)} />
                <label htmlFor="arch-done" className="text-sm cursor-pointer">Terminés</label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="arch-canceled" checked={archiveIncludeCanceled} onCheckedChange={(v) => setArchiveIncludeCanceled(!!v)} />
                <label htmlFor="arch-canceled" className="text-sm cursor-pointer">Annulés</label>
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-sm font-medium">Période</div>
            <Select value={archivePeriod} onValueChange={(v) => setArchivePeriod(v as "3m" | "6m" | "1an" | "tout")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="3m">3 derniers mois</SelectItem>
                <SelectItem value="6m">6 derniers mois</SelectItem>
                <SelectItem value="1an">Dernière année</SelectItem>
                <SelectItem value="tout">Tout</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm">
            <div className="font-medium">
              {archivePreview.length} OF{archivePreview.length !== 1 ? "s" : ""} concerné{archivePreview.length !== 1 ? "s" : ""}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {archiveStatuses.length === 0
                ? "Aucun statut sélectionné"
                : [archiveIncludeDone ? "Terminés" : null, archiveIncludeCanceled ? "Annulés" : null].filter(Boolean).join(" + ")}
            </div>
          </div>
          {(archivePeriod === "1an" || archivePeriod === "tout") && archivePreview.length > 0 && (
            <Button
              variant="outline"
              className="w-full flex items-center gap-2"
              disabled={archiveExporting}
              onClick={generateArchiveCsv}
            >
              <FileDown className="h-4 w-4" />
              {archiveExporting ? "Export en cours…" : "Exporter CSV récapitulatif"}
            </Button>
          )}
          {archivePreview.length > 0 && archiveStatuses.length > 0 && (
            <>
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-center">
                <div className="text-xs text-muted-foreground mb-1">Code de confirmation</div>
                <div className="text-2xl font-mono font-bold tracking-widest text-destructive">{archiveCode}</div>
              </div>
              <div className="space-y-2">
                <Label>Saisissez le code ci-dessus pour confirmer</Label>
                <Input
                  value={archiveInput}
                  onChange={(e) => setArchiveInput(e.target.value)}
                  placeholder="_ _ _ _"
                  className="text-center font-mono text-lg tracking-widest"
                  maxLength={4}
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setArchiveOpen(false); setArchiveInput(""); }}>Annuler</Button>
          <Button
            variant="destructive"
            disabled={
              archivePreview.length === 0 ||
              archiveStatuses.length === 0 ||
              archiveInput !== archiveCode ||
              archiveOrders.isPending
            }
            onClick={() => archiveOrders.mutate()}
          >
            {archiveOrders.isPending
              ? "Archivage…"
              : `Archiver ${archivePreview.length} OF${archivePreview.length !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* ── Dialog suppression OF terminé avec code de confirmation ── */}
    <Dialog open={!!deleteOfTarget} onOpenChange={(open) => { if (!open) { setDeleteOfTarget(null); setDeleteOfInput(""); } }}>
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="text-destructive">Supprimer la fabrication terminée</DialogTitle>
        </DialogHeader>
        {deleteOfTarget && (
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm space-y-1">
              <div className="font-mono text-xs text-muted-foreground">{deleteOfTarget.reference}</div>
              <div className="font-semibold">{deleteOfTarget.coffretName}</div>
            </div>
            <p className="text-sm text-muted-foreground">
              Cette action est irréversible. L'historique des mouvements de stock associés sera conservé.
            </p>
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-center">
              <div className="text-xs text-muted-foreground mb-1">Code de confirmation</div>
              <div className="text-2xl font-mono font-bold tracking-widest text-destructive">{deleteOfCode}</div>
            </div>
            <div className="space-y-2">
              <Label>Saisissez le code ci-dessus pour confirmer</Label>
              <Input
                value={deleteOfInput}
                onChange={(e) => setDeleteOfInput(e.target.value)}
                placeholder="_ _ _ _"
                className="text-center font-mono text-lg tracking-widest"
                maxLength={4}
                autoFocus
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => { setDeleteOfTarget(null); setDeleteOfInput(""); }}>Annuler</Button>
          <Button
            variant="destructive"
            disabled={deleteOfInput !== deleteOfCode || deleteOrder.isPending}
            onClick={() => deleteOfTarget && deleteOrder.mutate(deleteOfTarget.id)}
          >
            Supprimer définitivement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    </TooltipProvider>
  );
}
