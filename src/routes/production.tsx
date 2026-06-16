import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Archive, AlertTriangle, ChevronDown, ChevronRight, ChevronsUpDown, Copy, FileDown, Search, Trash2, Truck, X } from "lucide-react";
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
import { fmtInt, splitPalettes } from "@/lib/format";
import { normalizeProductionStatus, productionStatusMeta } from "@/lib/domain";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { getProductionFeasibility } from "@/lib/getProductionFeasibility";
import { MSG } from "@/lib/messages";

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
  missing: Array<{ reference: string; name: string; needed: number; available: number; manquant: number }>;
  remaining: Array<{ reference: string; name: string; apres_production: number }>;
};

export const Route = createFileRoute("/production")({
  head: () => ({
    meta: [
      { title: "Production — Atelier" },
      { name: "description", content: "Fabrication de coffrets et suivi d'avancement." },
    ],
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    filterStatus: typeof search.filterStatus === "string" ? search.filterStatus : "all",
    showDone:     search.showDone === "true" || search.showDone === true,
  }),
  component: ProductionPage,
});


function ProductionPage() {
  const sb = supabase as any;
  const qc = useQueryClient();

  const [rows, setRows] = useState<ProdRow[]>([{ id: crypto.randomUUID(), coffret_id: "", quantity: 1 }]);
  const [ofType, setOfType] = useState<"coffret" | "custom">("coffret");
  const [customLabel, setCustomLabel] = useState<string>("");
  const [customQty, setCustomQty] = useState<number>(1);
  const [urgent, setUrgent] = useState(false);
  const [clientOfRef, setClientOfRef] = useState<string>("");
  const [ofNotes, setOfNotes] = useState<string>("");
  const [exportOpen, setExportOpen] = useState(false);
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
  const [archiveOpenedAt, setArchiveOpenedAt] = useState<Date | null>(null);
  const [archivePeriod, setArchivePeriod] = useState<"3m" | "6m" | "1an" | "tout">("tout");
  const [archiveIncludeDone, setArchiveIncludeDone] = useState(true);
  const [archiveIncludeCanceled, setArchiveIncludeCanceled] = useState(true);
  const [archiveCode, setArchiveCode] = useState<string>("");
  const [archiveInput, setArchiveInput] = useState<string>("");
  const [archiveExporting, setArchiveExporting] = useState(false);

  // ── Filtres suivi fabrication ────────────────────────────────────────────
  const urlSearch = Route.useSearch();
  const navigate = useNavigate();
  const [filterSearch, setFilterSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>(() => urlSearch.filterStatus ?? "all");
  const showDone = urlSearch.showDone ?? false;
  function setShowDone(v: boolean) {
    navigate({ to: "/production", search: (prev: any) => ({ ...prev, showDone: v || undefined }), replace: true });
  }
  const [filterClientRef, setFilterClientRef] = useState<string>("all");
  const [filterDatePreset, setFilterDatePreset] = useState<string>("all");
  const [filterDateFrom, setFilterDateFrom] = useState<string>("");
  const [filterDateTo, setFilterDateTo] = useState<string>("");

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
        const missing: Array<{ reference: string; name: string; needed: number; available: number; manquant: number }> = feasibility.missing.map((item) => ({
          reference: item.reference || item.composant_id,
          name: item.name,
          needed: item.needed,
          available: item.available,
          manquant: item.missing,
        }));
        const remaining: Array<{ reference: string; name: string; apres_production: number }> = feasibility.components.map((item) => ({
          reference: item.reference || item.composant_id,
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
    queryKey: ["production_orders", "atelier", showDone],
    queryFn: async () => {
      const activeStatuses = ["draft", "priority", "in_progress", "pending_material", "partial"];
      const statuses = showDone ? [...activeStatuses, "done"] : activeStatuses;
      let q = sb
        .from("production_orders")
        .select("*, coffret_snapshot")
        .in("status", statuses)
        .order("created_at", { ascending: false })
        .limit(200);
      if (showDone) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30);
        q = q.or(`status.neq.done,created_at.gte.${cutoff.toISOString()}`);
      }
      const { data: rawOrders, error } = await q;
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
          .select("id,reference,name,nb_par_palette,poids_coffret")
          .in("id", ids);
        if (coffretsError) throw coffretsError;
        coffretMap = new Map((coffretsData ?? []).map((c: any) => [c.id, c]));
      }

      return filtered.map((o) => ({ ...o, coffret: coffretMap.get(o.coffret_id) ?? null }));
    },
  });

  // OF en attente matière (statut DB réel)
  const pendingMaterialOrders = useMemo(
    () => (orders.data ?? []).filter((o: any) => o.status === "pending_material"),
    [orders.data]
  );

  // Valeurs uniques de client_of_reference pour le filtre déroulant
  const clientRefOptions = useMemo(() => {
    const vals = new Set<string>();
    for (const o of (orders.data ?? []) as any[]) {
      if (o.client_of_reference) vals.add(o.client_of_reference);
    }
    return Array.from(vals).sort();
  }, [orders.data]);

  // OFs filtrés
  const filteredOrders = useMemo(() => {
    let list = (orders.data ?? []) as any[];

    // Recherche libre
    const q = filterSearch.trim().toLowerCase();
    if (q) {
      list = list.filter((o) => {
        const snap = o.coffret_snapshot as { reference?: string; name?: string } | null;
        const coffretRef  = o.coffret?.reference ?? snap?.reference ?? "";
        const coffretName = o.coffret?.name ?? snap?.name ?? "";
        return (
          (o.client_of_reference ?? "").toLowerCase().includes(q) ||
          coffretRef.toLowerCase().includes(q) ||
          coffretName.toLowerCase().includes(q)
        );
      });
    }

    // Filtre statut
    if (filterStatus !== "all") {
      list = list.filter((o) => o.status === filterStatus);
    }

    // Filtre référence client
    if (filterClientRef !== "all") {
      list = list.filter((o) => o.client_of_reference === filterClientRef);
    }

    // Filtre date
    const now = new Date();
    if (filterDatePreset !== "all" || filterDateFrom || filterDateTo) {
      let from: Date | null = null;
      let to: Date | null = null;
      if (filterDatePreset === "today") {
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        to   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
      } else if (filterDatePreset === "week") {
        const day = now.getDay() === 0 ? 6 : now.getDay() - 1;
        from = new Date(now); from.setDate(now.getDate() - day); from.setHours(0,0,0,0);
        to   = new Date(from); to.setDate(from.getDate() + 6); to.setHours(23,59,59,999);
      } else if (filterDatePreset === "month") {
        from = new Date(now.getFullYear(), now.getMonth(), 1);
        to   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      } else {
        if (filterDateFrom) from = new Date(filterDateFrom);
        if (filterDateTo)   { to = new Date(filterDateTo); to.setHours(23,59,59,999); }
      }
      if (from) list = list.filter((o) => new Date(o.created_at) >= from!);
      if (to)   list = list.filter((o) => new Date(o.created_at) <= to!);
    }

    return list;
  }, [orders.data, filterSearch, filterStatus, filterClientRef, filterDatePreset, filterDateFrom, filterDateTo]);

  const hasActiveFilters = filterSearch || filterStatus !== "all" || filterClientRef !== "all" || filterDatePreset !== "all" || filterDateFrom || filterDateTo || showDone;

  function resetFilters() {
    setFilterSearch("");
    setFilterStatus("all");
    setFilterClientRef("all");
    setFilterDatePreset("all");
    setFilterDateFrom("");
    setFilterDateTo("");
    setShowDone(false);
  }

  const deficitChecks = useQuery({
    queryKey: ["deficit_checks", pendingMaterialOrders.map((o: any) => o.id)],
    queryFn: async () => {
      const results = await Promise.all(
        pendingMaterialOrders.map(async (o: any) => ({
          orderId: o.id,
          feasibility: await getProductionFeasibility(o.coffret_id, o.quantity),
        }))
      );
      return new Map(results.map((r) => [r.orderId, r.feasibility]));
    },
    enabled: pendingMaterialOrders.length > 0,
    staleTime: 30_000,
  });

  const createCustom = useMutation({
    retry: 0,
    mutationFn: async () => {
      const p = urgent ? 1 : 0;
      const key = `custom:${customLabel}:${customQty}:${p}:${Date.now()}`;
      const { data, error } = await sb.rpc("create_custom_production_order", {
        p_label:           customLabel.trim(),
        p_quantity:        customQty,
        p_status:          urgent ? "priority" : "draft",
        p_priority:        p,
        p_notes:           ofNotes.trim() || null,
        p_idempotency_key: key,
      });
      if (error) throw error;
      if (data && data.success === false) throw new Error(data.error || "Création impossible");
      if (clientOfRef.trim() && data?.order_id) {
        await sb.from("production_orders")
          .update({ client_of_reference: clientOfRef.trim() })
          .eq("id", data.order_id);
      }
      return data;
    },
    onSuccess: () => {
      toast.success(MSG.OF_CREATED);
      qc.invalidateQueries({ queryKey: ["production_orders"] });
      setCustomLabel("");
      setCustomQty(1);
      setUrgent(false);
      setClientOfRef("");
      setOfNotes("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createFabrication = useMutation({
    retry: 0,  // jamais de retry auto : la clé d'idempotence couvre les erreurs réseau
    mutationFn: async () => {
      const results: Array<{ ok: boolean }> = [];
      for (const row of validRows) {
        const p = urgent ? 1 : 0;
        const { data, error } = await sb.rpc("create_production_order_atomic", {
          p_coffret_id:      row.coffret_id,
          p_quantity:        row.quantity,
          p_status:          urgent ? "priority" : "draft",
          p_priority:        p,
          p_notes:           ofNotes.trim() || null,
          p_idempotency_key: getIdempotencyKey(row.coffret_id, row.quantity, p),
        });
        if (error) throw error;
        if (data && data.success === false) throw new Error(data.error || "Création impossible");
        clearIdempotencyKey(row.coffret_id, row.quantity, p);
        // Propagation OF client — UPDATE séparé pour ne pas modifier la RPC
        if (clientOfRef.trim() && data?.order_id) {
          await sb.from("production_orders")
            .update({ client_of_reference: clientOfRef.trim() })
            .eq("id", data.order_id);
        }
        results.push({ ok: true });
      }
      return results;
    },
    onSuccess: (results) => {
      toast.success(MSG.OF_CREATED);
      qc.invalidateQueries({ queryKey: ["production_orders"] });
      qc.invalidateQueries({ queryKey: ["composants"] });
      qc.invalidateQueries({ queryKey: ["stock_snapshot"] });
      setRows([{ id: crypto.randomUUID(), coffret_id: "", quantity: 1 }]);
      setUrgent(false);
      setClientOfRef("");
      setOfNotes("");
      setOfType("coffret");
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
      return data as {
        status?: string;
        split?: boolean;
        qty_launched?: number;
        qty_pending?: number;
        split_reference?: string;
        missing_count?: number;
      } | null;
    },
    onSuccess: (data) => {
      if (data?.split) {
        toast.success(MSG.OF_SPLIT(data.qty_launched!, data.qty_pending!, data.split_reference!), { duration: 8000 });
      } else if (data?.status === "in_progress") {
        toast.success(MSG.OF_STARTED);
      } else if (data?.status === "pending_material") {
        toast.warning(MSG.OF_LAUNCH_PENDING, { duration: 6000 });
      }
      qc.invalidateQueries({ queryKey: ["production_orders"] });
      qc.invalidateQueries({ queryKey: ["composants"] });
      qc.invalidateQueries({ queryKey: ["deficit_checks"] });
      qc.invalidateQueries({ queryKey: ["reservations_by_of"] });
      qc.invalidateQueries({ queryKey: ["composant_reservations"] });
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
      toast.success(MSG.OF_CANCELED);
      qc.invalidateQueries({ queryKey: ["production_orders"] });
      qc.invalidateQueries({ queryKey: ["composants"] });
      qc.invalidateQueries({ queryKey: ["stock_snapshot"] });
      qc.invalidateQueries({ queryKey: ["reservations_by_of"] });
      qc.invalidateQueries({ queryKey: ["composant_reservations"] });
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
      toast.success(MSG.OF_DELETED);
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
    const now = new Date();
    setArchiveOpenedAt(now);
    qc.invalidateQueries({ queryKey: ["production_orders", "atelier"] });
    setArchiveOpen(true);
  }

  const archiveBefore = useMemo<string | null>(() => {
    const ref = archiveOpenedAt ?? new Date();
    if (archivePeriod === "3m") { const d = new Date(ref); d.setMonth(d.getMonth() - 3); return d.toISOString(); }
    if (archivePeriod === "6m") { const d = new Date(ref); d.setMonth(d.getMonth() - 6); return d.toISOString(); }
    if (archivePeriod === "1an") { const d = new Date(ref); d.setFullYear(d.getFullYear() - 1); return d.toISOString(); }
    return null;
  }, [archivePeriod, archiveOpenedAt]);

  const archiveStatuses = useMemo(() => {
    const s: string[] = [];
    if (archiveIncludeDone) s.push("done");
    if (archiveIncludeCanceled) s.push("canceled");
    return s;
  }, [archiveIncludeDone, archiveIncludeCanceled]);

  const archivePreview = useMemo(() => {
    if (!archiveOpen) return [] as any[];
    const cutoff = archiveBefore ? new Date(archiveBefore) : null;
    return (orders.data ?? []).filter((o: any) => {
      const st = String(o.status);
      const matches =
        (archiveIncludeDone && st === "done") ||
        (archiveIncludeCanceled && st === "canceled");
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
      toast.success(MSG.OF_ARCHIVED(n));
      qc.invalidateQueries({ queryKey: ["production_orders"] });
      setArchiveOpen(false);
      setArchiveInput("");
      setArchiveOpenedAt(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function generateArchiveCsv() {
    setArchiveExporting(true);
    try {
      const orderIds = archivePreview.map((o: any) => o.id as string);
      if (orderIds.length === 0) { toast.error(MSG.OF_EXPORT_EMPTY); return; }
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

      // P0.4 — batcher les UUIDs par tranches de 100 pour éviter HTTP 414.
      // PostgREST sérialise .in() en query-string GET ; au-delà de ~250 UUIDs
      // (≈9 KB) la requête dépasse la limite nginx et échoue silencieusement.
      const CONSUMPTION_BATCH = 100;
      let allConsumData: any[] = [];
      for (let i = 0; i < orderIds.length; i += CONSUMPTION_BATCH) {
        const batch = orderIds.slice(i, i + CONSUMPTION_BATCH);
        const { data: batchData, error: batchError } = await sb
          .from("production_consumption")
          .select("production_order_id, quantity, composant:composants(reference, name)")
          .in("production_order_id", batch);
        if (batchError) throw batchError;
        if (batchData) allConsumData = allConsumData.concat(batchData);
      }

      const orderRefMap = new Map((archivePreview as any[]).map((o: any) => [o.id as string, o.reference ?? (o.id as string).slice(0, 8)]));
      const consumLines: string[] = [
        "",
        "=== 2. CONSOMMATIONS ===",
        "Référence OF;Réf. composant;Nom composant;Quantité consommée",
      ];
      for (const c of allConsumData) {
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
      const shipLines: string[] = ["", "=== 4. EXPÉDITIONS ===", "Référence;Client;Statut;Poids total (kg);Nb palettes;Date création"];
      let shipQuery = (sb as any)
        .from("shipments")
        .select("reference, status, total_weight, total_pallets, created_at, client:clients(name)")
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
          shipLines.push(`${s.reference ?? "—"};${(s.client as any)?.name ?? "—"};${s.status ?? "—"};${Number(s.total_weight ?? 0).toFixed(3)};${s.total_pallets ?? 0};${(s.created_at ?? "").slice(0, 10)}`);
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
      toast.success(MSG.OF_EXPORT_OK);
    } catch (e: any) {
      toast.error((e as Error).message ?? "Erreur lors de l'export CSV");
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
      if (data?.status === "done") toast.success(MSG.OF_DONE);
      else toast.success(MSG.OF_PARTIAL(data?.produced_qty ?? "?", data?.total_qty ?? "?"));
      qc.invalidateQueries({ queryKey: ["production_orders"] });
      qc.invalidateQueries({ queryKey: ["composants"] });
      qc.invalidateQueries({ queryKey: ["stock_movements"] });
      qc.invalidateQueries({ queryKey: ["composant_movements"] });
      setValidateTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function exportOFActifs() {
    const list = filteredOrders as any[];
    if (list.length === 0) { toast.error("Aucun OF à exporter."); return; }
    const now = new Date().toISOString().slice(0, 10);
    const filterNote = filterStatus !== "all" ? ` — statut : ${filterStatus}` : "";
    const lines: string[] = [
      `﻿Export OF actifs — ${now}${filterNote}`,
      "",
      "Référence OF;OF client;Coffret (réf);Coffret (nom);Qté planifiée;Qté produite;Statut;Priorité;Date création",
    ];
    for (const o of list) {
      const snap = (o.coffret_snapshot ?? {}) as { reference?: string; name?: string };
      const coffretRef  = o.coffret?.reference ?? snap.reference ?? "—";
      const coffretName = o.coffret?.name      ?? snap.name      ?? "—";
      const statusLabel = productionStatusMeta[String(o.status)]?.label ?? o.status;
      const priorite = o.priority > 0 ? "Urgent" : "Normal";
      lines.push(`${o.reference ?? o.id.slice(0, 8)};${o.client_of_reference ?? "—"};${coffretRef};${coffretName};${o.quantity};${o.produced_qty ?? 0};${statusLabel};${priorite};${(o.created_at ?? "").slice(0, 10)}`);
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `of-actifs-${now}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast.success("Export OF actifs téléchargé.");
  }

  function openExportDialog() {
    setExportOpen(true);
  }

  function runExport() {
    const coffretById = new Map((coffrets.data ?? []).map((c: any) => [c.id, c as { reference: string; name: string }]));

    // Source 1 : lignes du planificateur (non encore converties en OF)
    const rowsWithMissing = validRows
      .map((r) => ({ row: r, check: checksByRow.get(r.id) }))
      .filter(({ check }) => check && !check.ok && check.missing.length > 0);

    // Source 2 : OF pending_material déjà créés
    const ofWithMissing = pendingMaterialOrders
      .map((o: any) => ({ order: o, feasibility: deficitChecks.data?.get(o.id) }))
      .filter(({ feasibility }) => feasibility && (feasibility.missing ?? []).length > 0);

    if (rowsWithMissing.length === 0 && ofWithMissing.length === 0) {
      toast.error(MSG.OF_QTY_REQUIRED);
      return;
    }

    const now = new Date().toISOString().slice(0, 10);
    const csvLines: string[] = [
      `﻿Export pièces manquantes — ${now}`,
      "",
      "OF / Source;Coffret;Nom coffret;Tirage;Réf. composant;Nom composant;Qté requise;Stock dispo;Qté manquante;Statut",
    ];

    let totalManquant = 0;
    const totauxParComposant = new Map<string, { ref: string; name: string; total: number }>();

    const addLine = (source: string, coffretRef: string, coffretName: string, qty: number, l: { reference: string; name: string; needed: number; available: number; manquant: number }) => {
      const statut = l.available === 0 ? "BLOQUÉ" : "PARTIEL";
      csvLines.push(`${source};${coffretRef};${coffretName};${qty};${l.reference};${l.name};${l.needed};${l.available};${l.manquant};${statut}`);
      totalManquant += l.manquant;
      const ex = totauxParComposant.get(l.reference);
      if (ex) ex.total += l.manquant;
      else totauxParComposant.set(l.reference, { ref: l.reference, name: l.name, total: l.manquant });
    };

    for (const { row, check } of rowsWithMissing) {
      const coffret = coffretById.get(row.coffret_id) as any;
      for (const l of check!.missing) addLine("Planificateur", coffret?.reference ?? row.coffret_id, coffret?.name ?? row.coffret_id, row.quantity, l);
    }

    for (const { order, feasibility } of ofWithMissing) {
      const coffret = coffretById.get(order.coffret_id) as any;
      const ref = order.reference ?? order.id?.slice(0, 8) ?? "OF";
      for (const item of feasibility!.missing) {
        addLine(ref, coffret?.reference ?? order.coffret_id, coffret?.name ?? order.coffret_id, order.quantity, {
          reference: item.reference || item.composant_id,
          name: item.name,
          needed: item.needed,
          available: item.available,
          manquant: item.missing,
        });
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
    toast.success(MSG.OF_EXPORT_OK);
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
                  Saisir {fmtInt(validateRemaining)} pour terminer la fabrication complètement.
                  Un nombre inférieur enregistre ce qui a été produit et met le stock à jour en conséquence.
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
          <h1 className="text-3xl md:text-4xl font-display font-semibold mt-1">Fabrication</h1>
        </div>
        <div className="flex gap-2 mt-2">
          <Button variant="outline" onClick={exportOFActifs} className="flex items-center gap-2">
            <FileDown className="h-4 w-4" /> Export OF actifs
          </Button>
          <Button variant="outline" onClick={openExportDialog} className="flex items-center gap-2">
            <FileDown className="h-4 w-4" /> Export pièces manquantes
          </Button>
        </div>
      </header>

      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="max-w-lg" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Export pièces manquantes</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Inclut les OF en attente matière + les lignes du planificateur avec stock insuffisant.
          </p>
          {(() => {
            const coffretById = new Map((coffrets.data ?? []).map((c: any) => [c.id, c as { reference: string; name: string }]));
            const rowsWithMissing = validRows
              .map((r) => ({ row: r, check: checksByRow.get(r.id) }))
              .filter(({ check }) => check && !check.ok && check.missing.length > 0);
            const ofWithMissing = pendingMaterialOrders
              .map((o: any) => ({ order: o, feasibility: deficitChecks.data?.get(o.id) }))
              .filter(({ feasibility }) => feasibility && (feasibility.missing ?? []).length > 0);
            if (rowsWithMissing.length === 0 && ofWithMissing.length === 0) {
              return (
                <p className="text-sm text-muted-foreground py-2">
                  Aucune pièce manquante détectée.
                </p>
              );
            }
            return (
              <div className="max-h-72 overflow-y-auto space-y-3 pr-1">
                {ofWithMissing.map(({ order, feasibility }) => {
                  const coffret = coffretById.get(order.coffret_id) as any;
                  return (
                    <div key={order.id} className="border border-border rounded-sm p-2.5 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold">{coffret?.name ?? order.coffret_id}</span>
                        <span className="text-xs font-mono text-muted-foreground">OF {order.reference ?? order.id?.slice(0, 8)} · ×{order.quantity}</span>
                      </div>
                      <div className="space-y-1">
                        {feasibility!.missing.map((m: any) => (
                          <div key={m.reference || m.composant_id} className="flex items-center justify-between text-xs">
                            <span className="font-mono text-muted-foreground">{m.reference || m.composant_id}</span>
                            <span className="text-destructive font-medium">−{fmtInt(m.missing)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {rowsWithMissing.map(({ row, check }) => {
                  const coffret = coffretById.get(row.coffret_id) as any;
                  return (
                    <div key={row.id} className="border border-border rounded-sm p-2.5 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold">{coffret?.name ?? row.coffret_id}</span>
                        <span className="text-xs font-mono text-muted-foreground">Planificateur · ×{row.quantity}</span>
                      </div>
                      <div className="space-y-1">
                        {check!.missing.map((m) => (
                          <div key={m.reference} className="flex items-center justify-between text-xs">
                            <span className="font-mono text-muted-foreground">{m.reference}</span>
                            <span className="text-destructive font-medium">−{fmtInt(m.manquant)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setExportOpen(false)}>Annuler</Button>
            <Button
              onClick={runExport}
              className="flex items-center gap-2"
            >
              <FileDown className="h-4 w-4" /> Exporter CSV
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Créer fabrication</CardTitle>
            <div className="flex items-center rounded-md border border-border overflow-hidden text-xs">
              <button
                className={`px-3 py-1.5 transition-colors ${ofType === "coffret" ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted"}`}
                onClick={() => setOfType("coffret")}
              >
                Coffret
              </button>
              <button
                className={`px-3 py-1.5 transition-colors ${ofType === "custom" ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted"}`}
                onClick={() => setOfType("custom")}
              >
                Fabrication libre
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {ofType === "coffret" && coffrets.data && coffrets.data.length === 0 && (
            <p className="text-sm text-muted-foreground">Aucune donnée disponible</p>
          )}

          {ofType === "custom" && (
            <div className="rounded-md border border-border p-3 space-y-3">
              <div className="grid md:grid-cols-12 gap-3 items-end">
                <div className="md:col-span-8">
                  <label className="text-xs text-muted-foreground">Nom du produit / travail</label>
                  <Input
                    placeholder="ex: Sachets de vis M4 × 50, Boîtes chocolat…"
                    value={customLabel}
                    onChange={(e) => setCustomLabel(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="md:col-span-4">
                  <label className="text-xs text-muted-foreground">Quantité</label>
                  <Input
                    type="number"
                    min="1"
                    value={String(customQty)}
                    onChange={(e) => setCustomQty(Math.max(1, Number(e.target.value || 1)))}
                  />
                </div>
              </div>
            </div>
          )}

          {ofType === "coffret" && rows.map((row, idx) => {
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

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Référence OF client <span className="text-muted-foreground font-normal">(optionnel)</span></label>
            <Input
              placeholder="ex: CMD-2026-042"
              value={clientOfRef}
              onChange={(e) => setClientOfRef(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">Référence externe transmise par le client — visible sur BL et suivi.</p>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
            <div>
              <div className="text-sm font-medium">Priorité</div>
              <div className="text-xs text-muted-foreground">{urgent ? "Urgent" : "Normal"}</div>
            </div>
            <Switch checked={urgent} onCheckedChange={setUrgent} />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Commentaire atelier</label>
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
              rows={2}
              placeholder="Instructions, numéro de lot, remarques…"
              value={ofNotes}
              onChange={(e) => setOfNotes(e.target.value)}
            />
          </div>

          {ofType === "coffret" ? (
            <Button className="w-full" onClick={() => createFabrication.mutate()} disabled={!canCreate || createFabrication.isPending}>
              {createFabrication.isPending ? "Création…" : "Créer fabrication"}
            </Button>
          ) : (
            <Button
              className="w-full"
              onClick={() => createCustom.mutate()}
              disabled={!customLabel.trim() || customQty < 1 || createCustom.isPending}
            >
              {createCustom.isPending ? "Création…" : "Créer fabrication libre"}
            </Button>
          )}
        </CardContent>
      </Card>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Suivi fabrication
            {orders.data && <span className="ml-2 text-xs font-normal text-muted-foreground">({(orders.data as any[]).length} OF{(orders.data as any[]).length !== 1 ? "s" : ""})</span>}
          </h2>
          <Button size="sm" variant="outline" onClick={openArchiveDialog} className="flex items-center gap-2">
            <Archive className="h-4 w-4" /> Archiver
          </Button>
        </div>

        {/* ── Barre de filtres ── */}
        <div className="mb-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            {/* Recherche libre */}
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={filterSearch}
                onChange={(e) => setFilterSearch(e.target.value)}
                placeholder="OF client, référence, produit…"
                className="pl-8 h-8 text-xs"
              />
              {filterSearch && (
                <button onClick={() => setFilterSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {/* Statut */}
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="h-8 text-xs w-[160px]">
                <SelectValue placeholder="Statut" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les statuts</SelectItem>
                <SelectItem value="draft">À produire</SelectItem>
                <SelectItem value="priority">Urgent</SelectItem>
                <SelectItem value="in_progress">En cours</SelectItem>
                <SelectItem value="pending_material">Pièces manquantes</SelectItem>
                <SelectItem value="partial">Partiel</SelectItem>
                <SelectItem value="done">Terminé</SelectItem>
                <SelectItem value="canceled">Annulé</SelectItem>
              </SelectContent>
            </Select>

            {/* Référence client (OF client unique) */}
            {clientRefOptions.length > 0 && (
              <Select value={filterClientRef} onValueChange={setFilterClientRef}>
                <SelectTrigger className="h-8 text-xs w-[180px]">
                  <SelectValue placeholder="Réf. client" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Toutes les réf. client</SelectItem>
                  {clientRefOptions.map((ref) => (
                    <SelectItem key={ref} value={ref}>{ref}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Date préréglages */}
            <Select value={filterDatePreset} onValueChange={(v) => { setFilterDatePreset(v); if (v !== "custom") { setFilterDateFrom(""); setFilterDateTo(""); } }}>
              <SelectTrigger className="h-8 text-xs w-[150px]">
                <SelectValue placeholder="Date" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Toutes dates</SelectItem>
                <SelectItem value="today">Aujourd'hui</SelectItem>
                <SelectItem value="week">Cette semaine</SelectItem>
                <SelectItem value="month">Ce mois</SelectItem>
                <SelectItem value="custom">Plage personnalisée</SelectItem>
              </SelectContent>
            </Select>

            {/* Toggle OF terminés */}
            <button
              onClick={() => setShowDone(!showDone)}
              className={`flex items-center gap-1.5 h-8 px-2.5 rounded-md border text-xs transition-colors ${showDone ? "bg-primary text-primary-foreground border-primary" : "border-input text-muted-foreground hover:bg-muted"}`}
            >
              <span className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center shrink-0 ${showDone ? "bg-primary-foreground border-primary-foreground" : "border-muted-foreground"}`}>
                {showDone && <span className="text-primary text-[10px] font-bold leading-none">✓</span>}
              </span>
              Terminés récents
            </button>

            {/* Reset */}
            {hasActiveFilters && (
              <Button size="sm" variant="ghost" onClick={resetFilters} className="h-8 text-xs text-muted-foreground">
                <X className="h-3 w-3 mr-1" /> Réinitialiser
              </Button>
            )}
          </div>

          {/* Plage personnalisée */}
          {filterDatePreset === "custom" && (
            <div className="flex flex-wrap gap-2 items-center">
              <Input type="date" value={filterDateFrom} onChange={(e) => setFilterDateFrom(e.target.value)} className="h-8 text-xs w-[150px]" />
              <span className="text-xs text-muted-foreground">→</span>
              <Input type="date" value={filterDateTo} onChange={(e) => setFilterDateTo(e.target.value)} className="h-8 text-xs w-[150px]" />
            </div>
          )}

          {/* Résumé */}
          {hasActiveFilters && (
            <p className="text-xs text-muted-foreground">
              {filteredOrders.length} OF{filteredOrders.length !== 1 ? "s" : ""} affiché{filteredOrders.length !== 1 ? "s" : ""}
              {(orders.data ?? []).length !== filteredOrders.length && ` sur ${(orders.data ?? []).length}`}
            </p>
          )}
        </div>

        {(orders.data ?? []).length === 0 && (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground space-y-2">
              <p>Aucun ordre de fabrication en cours.</p>
              <p className="text-xs">Utilisez le formulaire ci-dessus pour créer une fabrication.</p>
            </CardContent>
          </Card>
        )}

        {filteredOrders.length === 0 && (orders.data ?? []).length > 0 && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground space-y-2">
              <p>Aucun OF ne correspond aux filtres sélectionnés.</p>
              <Button size="sm" variant="outline" onClick={resetFilters}>Réinitialiser les filtres</Button>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filteredOrders.map((o: any) => {
            const status = String(o.status);
            const canStart  = status === "draft" || status === "priority";
            const canFinish = status === "in_progress" || status === "partial";
            const canCancel = status === "draft" || status === "priority"
                           || status === "in_progress" || status === "partial"
                           || status === "pending_material";
            const isCustom = o.product_type === "custom";
            const snapshot = o.coffret_snapshot as { reference?: string; name?: string } | null;
            const coffretName = isCustom ? (o.label ?? "Fabrication libre") : (o.coffret?.name ?? snapshot?.name ?? "Coffret archivé");
            const coffretRef  = isCustom ? null : (o.coffret?.reference ?? snapshot?.reference ?? "—");
            const isUrgent = Number(o.priority ?? 0) === 1;
            const producedQty = Number(o.produced_qty ?? 0);
            const progress = o.quantity > 0 ? Math.min(100, Math.round((producedQty / o.quantity) * 100)) : 0;
            const showProgress = canFinish || status === "done";
            const nbParPalette = Number(o.coffret?.nb_par_palette ?? 0);
            const paletteSplit = splitPalettes(o.quantity, nbParPalette);
            const poidsUnitaire = Number(o.coffret?.poids_coffret ?? 0);
            const poidsTotal = poidsUnitaire > 0 ? poidsUnitaire * o.quantity : null;
            const ofRef = o.reference ?? o.id.slice(0, 8);
            const clientOfRef = o.client_of_reference as string | null | undefined;
            const isPendingMaterial = status === "pending_material";
            const displayStatus = status;
            const missingParts = isPendingMaterial ? (deficitChecks.data?.get(o.id)?.missing ?? null) : null;

            return (
              <div
                key={o.id}
                className={`rounded-lg border bg-card text-card-foreground shadow-sm transition-shadow hover:shadow-md flex flex-col ${isUrgent ? "border-destructive/40" : "border-border"}`}
              >
                {/* Header — OF client (principal) + OF système + statut */}
                <div className={`flex items-start justify-between gap-2 px-4 pt-4 pb-3 border-b ${isUrgent ? "border-destructive/20 bg-destructive/5" : "border-border bg-muted/20"} rounded-t-lg`}>
                  <div className="min-w-0 flex-1">
                    {/* OF client — toujours affiché, "—" si non renseigné */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">OF client</span>
                      {clientOfRef ? (
                        <button
                          type="button"
                          className="group flex items-center gap-1 font-mono text-sm font-bold text-foreground hover:text-info transition-colors cursor-copy"
                          title="Copier la référence OF client"
                          onClick={() => { navigator.clipboard.writeText(clientOfRef); toast.success(MSG.OF_COPIED(clientOfRef)); }}
                        >
                          {clientOfRef}
                          <Copy className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity shrink-0" />
                        </button>
                      ) : (
                        <span className="font-mono text-sm text-muted-foreground">—</span>
                      )}
                    </div>
                    {/* OF système — toujours affiché */}
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <button
                        type="button"
                        className="group flex items-center gap-1 text-[11px] text-muted-foreground font-mono hover:text-foreground transition-colors cursor-copy"
                        title="Copier la référence OF système"
                        onClick={() => { navigator.clipboard.writeText(ofRef); toast.success(MSG.OF_COPIED(ofRef)); }}
                      >
                        {ofRef}
                        <Copy className="h-2.5 w-2.5 opacity-0 group-hover:opacity-60 transition-opacity shrink-0" />
                      </button>
                      {isCustom && (
                        <span className="inline-flex items-center rounded-sm border border-info/30 bg-info/10 text-info px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                          LIBRE
                        </span>
                      )}
                      {isUrgent && (
                        <span className="inline-flex items-center rounded-sm border border-destructive/30 bg-destructive/15 text-destructive px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                          URGENT
                        </span>
                      )}
                      <span className="text-[11px] text-muted-foreground">
                        {new Date(o.created_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" })}
                      </span>
                    </div>
                  </div>
                  <span className={`inline-flex items-center shrink-0 rounded-sm border px-2 py-0.5 text-[11px] font-medium ${productionStatusMeta[displayStatus]?.cls ?? "bg-muted text-muted-foreground border-border"}`}>
                    {productionStatusMeta[displayStatus]?.label ?? status}
                  </span>
                </div>

                {/* Body */}
                <div className="px-4 py-3 flex-1 space-y-3">
                  {/* Coffret / produit identity */}
                  <div>
                    <div className="font-semibold text-base leading-tight">{coffretName}</div>
                    {coffretRef && <div className="text-xs font-mono text-muted-foreground mt-0.5">{coffretRef}</div>}
                  </div>

                  {/* Commentaire atelier */}
                  {o.notes && (
                    <div className="text-xs text-muted-foreground italic border-l-2 border-border pl-2">
                      {o.notes}
                    </div>
                  )}

                  {/* Quantité + poids total */}
                  <div className="flex items-baseline gap-4">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Qté planifiée</div>
                      <div className="text-2xl font-display font-bold tabular leading-none mt-0.5">{fmtInt(o.quantity)}</div>
                    </div>
                    {poidsTotal !== null && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Poids produits</div>
                        <div className="text-lg font-semibold tabular leading-none mt-0.5 text-foreground">{poidsTotal.toFixed(1)} kg</div>
                      </div>
                    )}
                    {showProgress && producedQty > 0 && (
                      <div className="text-sm text-muted-foreground">
                        → <span className="font-medium text-foreground">{fmtInt(producedQty)}</span> prod.
                      </div>
                    )}
                  </div>

                  {/* Logistique palettes — pour préparation BL (coffret uniquement) */}
                  {!isCustom && paletteSplit !== null && (
                    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Conditionnement</span>
                        <span className="text-[11px] text-muted-foreground">{paletteSplit.capacite} u./pal.</span>
                      </div>
                      <div className="space-y-0.5 text-xs">
                        {/* Palettes complètes — si resteType = "full", le reste compte aussi comme complète */}
                        {(() => {
                          const totalCompletes = paletteSplit.resteType === "full"
                            ? paletteSplit.completes + 1
                            : paletteSplit.completes;
                          const unitsCompletes = paletteSplit.resteType === "full"
                            ? paletteSplit.completes * paletteSplit.capacite + paletteSplit.reste
                            : paletteSplit.completes * paletteSplit.capacite;
                          return totalCompletes > 0 ? (
                            <div className="flex items-center justify-between">
                              <span className="text-muted-foreground">
                                {totalCompletes} palette{totalCompletes > 1 ? "s" : ""} complète{totalCompletes > 1 ? "s" : ""}
                              </span>
                              <span className="font-mono font-medium text-foreground tabular">{unitsCompletes} u.</span>
                            </div>
                          ) : null;
                        })()}

                        {/* Palette partielle qualifiée */}
                        {paletteSplit.reste > 0 && paletteSplit.resteType !== "full" && (
                          <div className="space-y-0.5">
                            <div className="flex items-center justify-between">
                              <span className={paletteSplit.resteType === "demi" ? "text-info" : "text-warning"}>
                                {paletteSplit.resteType === "demi" ? "Demi-palette" : "Palette partielle (mini)"}
                              </span>
                              <span className="font-mono font-medium text-foreground tabular">
                                {paletteSplit.reste} / {paletteSplit.capacite} u.
                              </span>
                            </div>
                            {paletteSplit.resteType === "mini" && (
                              <div className="text-[10px] text-warning flex items-center gap-1">
                                <AlertTriangle className="h-3 w-3 shrink-0" />
                                Sous-optimisé — regroupement conseillé
                              </div>
                            )}
                          </div>
                        )}

                        <div className="flex items-center justify-between border-t border-border/60 pt-1 mt-0.5">
                          <span className="font-medium text-foreground">Total palettes physiques</span>
                          <span className="font-mono font-bold text-foreground tabular">{paletteSplit.total}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Barre de progression */}
                  {showProgress && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px] text-muted-foreground">
                        <span>Avancement</span>
                        <span className="tabular font-medium">{progress}%</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${status === "done" ? "bg-success" : "bg-info"}`}
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* En attente matière — pièces manquantes (coffret uniquement) */}
                  {isPendingMaterial && !isCustom && (
                    <div className="rounded-md border border-orange-300 bg-orange-50 dark:bg-orange-900/10 dark:border-orange-700 px-3 py-2 space-y-1.5">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-orange-700 dark:text-orange-400">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        Pièces manquantes
                      </div>
                      {missingParts === null ? (
                        <div className="text-[11px] text-muted-foreground">Vérification en cours…</div>
                      ) : missingParts.length === 0 ? (
                        <div className="text-[11px] text-success font-medium">✓ Stock maintenant suffisant — cliquez Reprendre</div>
                      ) : (
                        <ul className="space-y-0.5 font-mono text-[11px]">
                          {missingParts.map((m: any) => (
                            <li key={m.composant_id} className="flex items-center justify-between gap-2">
                              <Link
                                to="/stock"
                                search={{ filterSearch: m.reference || m.name } as any}
                                className="text-foreground font-medium hover:underline hover:text-orange-700 dark:hover:text-orange-300 transition-colors"
                              >
                                {m.reference || m.name}
                              </Link>
                              <span className="text-orange-600 dark:text-orange-400 shrink-0">manque {m.missing}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>

                {/* Footer actions */}
                <div className="px-4 pb-4 pt-2 border-t border-border/60 flex flex-wrap gap-1.5">
                  {isPendingMaterial && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 border-orange-300 text-orange-700 hover:bg-orange-50 dark:text-orange-400 dark:border-orange-700"
                      onClick={() => transition.mutate({ id: o.id, status: "in_progress" })}
                      disabled={transition.isPending}
                    >
                      Relancer (vérifier stock)
                    </Button>
                  )}
                  {canStart && (
                    <Button size="sm" variant="default" className="flex-1" onClick={() => transition.mutate({ id: o.id, status: "in_progress" })} disabled={transition.isPending}>
                      Lancer fabrication
                    </Button>
                  )}
                  {canFinish && isCustom && (
                    <Button
                      size="sm"
                      variant="default"
                      className="flex-1"
                      disabled={transition.isPending}
                      onClick={() => transition.mutate({ id: o.id, status: "done" })}
                    >
                      Terminer
                    </Button>
                  )}
                  {canFinish && !isCustom && (
                    <Button
                      size="sm"
                      variant="default"
                      className="flex-1"
                      disabled={finish.isPending}
                      onClick={() => {
                        setValidateQty(String(o.quantity - producedQty));
                        setValidateTarget({ id: o.id, quantity: o.quantity, produced_qty: producedQty, coffretName });
                      }}
                    >
                      Valider
                    </Button>
                  )}
                  {canCancel && (
                    <Button size="sm" variant="outline" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => cancelOrder.mutate(o.id)} disabled={cancelOrder.isPending}>
                      Annuler
                    </Button>
                  )}
                  {status === "done" && (
                    <Link
                      to="/livraisons"
                      search={{} as any}
                      className="inline-flex items-center gap-1 rounded-md border border-input px-2.5 py-1 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
                    >
                      <Truck className="h-3 w-3" /> Expédier →
                    </Link>
                  )}
                  {(status === "canceled" || status === "done") && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          disabled={deleteOrder.isPending}
                          onClick={() => status === "done" ? openDeleteOfDialog(o) : deleteOrder.mutate(o.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent className="text-xs">Supprimer définitivement</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>

    {/* ── Dialog archivage en masse ── */}
    <Dialog open={archiveOpen} onOpenChange={(open) => { if (!open) { setArchiveOpen(false); setArchiveInput(""); setArchiveOpenedAt(null); } }}>
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
            <div className="text-xs text-muted-foreground/70 mt-1">Aperçu basé sur les 200 derniers OFs chargés. L'archivage côté serveur traite l'intégralité.</div>
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
          <Button variant="outline" onClick={() => { setArchiveOpen(false); setArchiveInput(""); setArchiveOpenedAt(null); }}>Annuler</Button>
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
