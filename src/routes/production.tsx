import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { FileDown } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fmtInt } from "@/lib/format";
import { normalizeProductionStatus, productionStatusMeta } from "@/lib/domain";
import { getProductionFeasibility } from "@/lib/getProductionFeasibility";

type ProdRow = { id: string; coffret_id: string; quantity: number };

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
  const canCreate =
    validRows.length > 0 &&
    validRows.every((row) => {
      const check = checksByRow.get(row.id);
      return check?.ok;
    });

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
        status: normalizeProductionStatus(row.status),
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
    mutationFn: async () => {
      for (const row of validRows) {
        const { data, error } = await sb.rpc("create_production_order_atomic", {
          p_coffret_id: row.coffret_id,
          p_quantity: row.quantity,
          p_status: urgent ? "priority" : "draft",
          p_priority: urgent ? 1 : 0,
          p_notes: null,
          p_idempotency_key: `production:${row.id}:${row.coffret_id}:${row.quantity}:${urgent ? 1 : 0}`,
        });
        if (error) throw error;

        if (data && data.success === false) {
          throw new Error(data.error || "Création production impossible");
        }
      }
    },
    onSuccess: () => {
      toast.success("Fabrication créée");
      qc.invalidateQueries({ queryKey: ["production_orders"] });
      qc.invalidateQueries({ queryKey: ["composants"] });
      // La RPC insère des mouvements OUT : invalider le snapshot de stock
      qc.invalidateQueries({ queryKey: ["stock_snapshot"] });
      setRows([{ id: crypto.randomUUID(), coffret_id: "", quantity: 1 }]);
      setUrgent(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const transition = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: "in_progress" | "done" }) => {
      const { data, error } = await sb.rpc("transition_production_order_status", {
        p_order_id: id,
        p_status: status,
      });
      if (error) throw error;
      if (data && data.success === false) {
        throw new Error(data.error || "Transition production impossible");
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production_orders"] });
      qc.invalidateQueries({ queryKey: ["composants"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelOrder = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await sb.rpc("cancel_production_order_with_unreserve", {
        p_order_id: id,
      });
      if (error) throw error;
      if (data && data.success === false) {
        throw new Error(data.error || "Annulation impossible");
      }
    },
    onSuccess: () => {
      toast.success("Fabrication annulée");
      qc.invalidateQueries({ queryKey: ["production_orders"] });
      qc.invalidateQueries({ queryKey: ["composants"] });
      qc.invalidateQueries({ queryKey: ["stock_snapshot"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const finish = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await sb.rpc("validate_production_order", {
        p_order_id: id,
      });
      if (error) throw error;
      if (data && data.success === false) {
        throw new Error(data.error || "Validation production impossible");
      }
    },
    onSuccess: () => {
      toast.success("Fabrication terminée");
      qc.invalidateQueries({ queryKey: ["production_orders"] });
      qc.invalidateQueries({ queryKey: ["composants"] });
      qc.invalidateQueries({ queryKey: ["stock_movements"] });
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

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-6">
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
        <DialogContent className="max-w-lg">
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

            const statusCls = feasible
              ? "bg-success/15 text-success border border-success/30"
              : "bg-destructive/15 text-destructive border border-destructive/30";

            const statusTxt = feasible
              ? "Fabrication possible"
              : "Fabrication impossible";

            return (
              <div key={row.id} className="rounded-md border border-border p-3 space-y-3">
                <div className="grid md:grid-cols-12 gap-3 items-end">
                  <div className="md:col-span-6">
                    <label className="text-xs text-muted-foreground">Coffret</label>
                    <Select
                      value={row.coffret_id}
                      onValueChange={(value) =>
                        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, coffret_id: value } : r)))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Sélectionner" />
                      </SelectTrigger>
                      <SelectContent>
                        {(coffrets.data ?? []).map((c: any) => (
                          <SelectItem key={c.id} value={c.id}>
                            <span className="font-mono text-xs mr-2">{c.reference}</span>{c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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

          <Button className="w-full" onClick={() => createFabrication.mutate()} disabled={!canCreate || createFabrication.isPending}>
            Créer fabrication
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Suivi fabrication</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-[88px] md:top-0 z-10 bg-muted/95 text-xs uppercase tracking-wider text-muted-foreground backdrop-blur">
                <tr>
                  <th className="text-left p-3">Coffret</th>
                  <th className="text-right p-3">Quantité</th>
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
                    const canStart = status === "draft" || status === "priority";
                    const canFinish = status === "in_progress";
                    const canCancel = status === "draft" || status === "priority" || status === "in_progress";
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
                        <td className="p-3 text-center">
                          <span className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[11px] font-medium ${Number(o.priority ?? 0) === 1 ? "border-destructive/30 bg-destructive/15 text-destructive" : "border-border bg-muted text-muted-foreground"}`}>
                            {Number(o.priority ?? 0) === 1 ? "Urgent" : "Normal"}
                          </span>
                        </td>
                        <td className="p-3 text-center">
                          <span className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[11px] font-medium ${productionStatusMeta[status]?.cls ?? "bg-muted text-muted-foreground border border-border"}`}>
                            {productionStatusMeta[status]?.label ?? "Statut inconnu"}
                          </span>
                        </td>
                        <td className="p-3 text-right">
                          <div className="inline-flex gap-1.5">
                            {canStart && (
                              <Button size="sm" variant="outline" onClick={() => transition.mutate({ id: o.id, status: "in_progress" })} disabled={transition.isPending}>
                                Démarrer
                              </Button>
                            )}
                            {canFinish && (
                              <Button size="sm" variant="outline" onClick={() => finish.mutate(o.id)} disabled={finish.isPending}>
                                Terminer
                              </Button>
                            )}
                            {canCancel && (
                              <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => cancelOrder.mutate(o.id)} disabled={cancelOrder.isPending}>
                                Annuler
                              </Button>
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
  );
}
