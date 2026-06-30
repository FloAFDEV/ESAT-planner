import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Download, Shield, CheckCircle2, Database } from "lucide-react";
import { fmtDate } from "@/lib/format";

export const Route = createFileRoute("/export")({
  head: () => ({
    meta: [
      { title: "Export données — Coffret ERP" },
      { name: "description", content: "Export complet des données de l'organisation." },
    ],
  }),
  component: ExportPage,
});

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function esc(v: unknown): string {
  const s = String(v ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"` : s;
}
function row(cells: unknown[]): string { return cells.map(esc).join(","); }

function downloadCsv(filename: string, header: string[], rows: unknown[][]): void {
  const lines = ["﻿" + row(header), ...rows.map(row)];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Trigger multiple downloads with small delay so browsers don't block them
function downloadAll(files: Array<{ name: string; header: string[]; rows: unknown[][] }>) {
  files.forEach((f, i) => {
    setTimeout(() => downloadCsv(f.name, f.header, f.rows), i * 300);
  });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

// 6-digit code generated once per page mount — user must re-type it to confirm
function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function ExportPage() {
  const sb = supabase as any;
  const today = new Date().toISOString().slice(0, 10);

  // Confirmation code — stable for the page lifetime
  const [confirmCode] = useState(generateCode);
  const [inputCode, setInputCode] = useState("");
  const [exported, setExported] = useState(false);

  const confirmed = inputCode === confirmCode;

  // ─── Data queries (load on mount so export is instant after confirm) ────────

  const clients = useQuery({
    queryKey: ["export", "clients"],
    queryFn: async () => {
      const { data, error } = await sb
        .from("clients")
        .select("id,name,contact_name,phone,email,address,postal_code,city,country,created_at")
        .order("name");
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const shipments = useQuery({
    queryKey: ["export", "shipments"],
    queryFn: async () => {
      const { data: sRows, error: sErr } = await sb
        .from("shipments")
        .select("id,reference,bl_number,client_id,client_of_reference,status,total_weight,total_pallets,created_at")
        .order("created_at", { ascending: false });
      if (sErr) throw sErr;
      const rows = (sRows ?? []) as any[];

      const clientIds = Array.from(new Set(rows.map((r) => r.client_id).filter(Boolean)));
      const { data: cRows } = clientIds.length
        ? await sb.from("clients").select("id,name").in("id", clientIds)
        : { data: [] };
      const clientMap = new Map<string, string>((cRows ?? []).map((c: any) => [c.id, c.name]));

      const { data: lRows, error: lErr } = await sb
        .from("shipment_lines")
        .select("id,shipment_id,product_variant_id,quantity,weight")
        .in("shipment_id", rows.map((r) => r.id).filter(Boolean));
      if (lErr) throw lErr;

      const variantIds = Array.from(new Set((lRows ?? []).map((l: any) => l.product_variant_id).filter(Boolean)));
      const { data: vRows } = variantIds.length
        ? await sb.from("product_variants").select("id,reference,name").in("id", variantIds)
        : { data: [] };
      const variantMap = new Map<string, any>((vRows ?? []).map((v: any) => [v.id, v]));

      return {
        shipments: rows.map((s) => ({ ...s, client_name: clientMap.get(s.client_id) ?? "" })),
        lines: (lRows ?? []).map((l: any) => {
          const v = variantMap.get(l.product_variant_id) ?? {};
          return { ...l, variant_reference: v.reference ?? "", variant_name: v.name ?? "" };
        }),
      };
    },
  });

  const orders = useQuery({
    queryKey: ["export", "production_orders"],
    queryFn: async () => {
      const { data: oRows, error: oErr } = await sb
        .from("production_orders")
        .select("id,reference,coffret_id,quantity,produced_qty,status,notes,client_of_reference,created_at,done_at")
        .order("created_at", { ascending: false });
      if (oErr) throw oErr;
      const rows = (oRows ?? []) as any[];

      const coffretIds = Array.from(new Set(rows.map((r) => r.coffret_id).filter(Boolean)));
      const { data: cRows } = coffretIds.length
        ? await sb.from("coffrets").select("id,reference,name").in("id", coffretIds)
        : { data: [] };
      const coffretMap = new Map<string, any>((cRows ?? []).map((c: any) => [c.id, c]));

      return rows.map((o) => {
        const c = coffretMap.get(o.coffret_id) ?? {};
        return { ...o, coffret_reference: c.reference ?? "", coffret_name: c.name ?? "" };
      });
    },
  });

  const loading = clients.isLoading || shipments.isLoading || orders.isLoading;
  const error = clients.error || shipments.error || orders.error;

  // ─── Stats ────────────────────────────────────────────────────────────────

  const stats = useMemo(() => ({
    clients: clients.data?.length ?? 0,
    shipments: shipments.data?.shipments.length ?? 0,
    lines: shipments.data?.lines.length ?? 0,
    orders: orders.data?.length ?? 0,
  }), [clients.data, shipments.data, orders.data]);

  // ─── Export ───────────────────────────────────────────────────────────────

  function handleExport() {
    if (!confirmed) return;

    const files = [
      {
        name: `clients-${today}.csv`,
        header: ["ID", "Nom", "Contact", "Téléphone", "Email", "Adresse", "Code postal", "Ville", "Pays", "Créé le"],
        rows: (clients.data ?? []).map((c) => [
          c.id, c.name, c.contact_name ?? "", c.phone ?? "", c.email ?? "",
          c.address ?? "", c.postal_code ?? "", c.city ?? "", c.country ?? "",
          c.created_at?.slice(0, 10) ?? "",
        ]),
      },
      {
        name: `expeditions-${today}.csv`,
        header: ["ID", "Référence", "BL", "Réf. OF client", "Client", "Statut", "Poids (kg)", "Nb palettes", "Créé le"],
        rows: (shipments.data?.shipments ?? []).map((s) => [
          s.id, s.reference ?? "", s.bl_number ?? "", s.client_of_reference ?? "",
          s.client_name, s.status ?? "", s.total_weight ?? 0, s.total_pallets ?? 0,
          s.created_at?.slice(0, 10) ?? "",
        ]),
      },
      {
        name: `lignes-expedition-${today}.csv`,
        header: ["ID", "ID expédition", "Référence variante", "Désignation", "Quantité", "Poids ligne (kg)"],
        rows: (shipments.data?.lines ?? []).map((l) => [
          l.id, l.shipment_id, l.variant_reference, l.variant_name,
          l.quantity ?? 0, l.weight ?? 0,
        ]),
      },
      {
        name: `ordres-fabrication-${today}.csv`,
        header: ["ID", "Référence", "Réf. coffret", "Coffret", "Quantité", "Produit", "Statut", "Notes", "Réf. OF client", "Créé le", "Terminé le"],
        rows: (orders.data ?? []).map((o) => [
          o.id, o.reference ?? "", o.coffret_reference, o.coffret_name,
          o.quantity ?? 0, o.produced_qty ?? 0, o.status ?? "",
          o.notes ?? "", o.client_of_reference ?? "",
          o.created_at?.slice(0, 10) ?? "", o.done_at?.slice(0, 10) ?? "",
        ]),
      },
    ];

    downloadAll(files);
    setExported(true);
  }

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto">
      <header className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-lg bg-primary/10">
            <Database className="h-6 w-6 text-primary" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-widest text-muted-foreground">Organisation</p>
            <h1 className="text-2xl font-display font-semibold">Export des données</h1>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-2">
          Exportez l'intégralité des données de votre organisation au format CSV. Les données vous appartiennent — cet export est disponible à tout moment.
        </p>
      </header>

      {/* Périmètre */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Périmètre de l'export</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: "Clients", value: stats.clients, file: "clients.csv" },
              { label: "Expéditions", value: stats.shipments, file: "expeditions.csv" },
              { label: "Lignes expédition", value: stats.lines, file: "lignes-expedition.csv" },
              { label: "Ordres de fabrication", value: stats.orders, file: "ordres-fabrication.csv" },
            ].map(({ label, value, file }) => (
              <div key={file} className="rounded-md border border-border bg-muted/20 p-3 text-center">
                <div className="text-2xl font-bold tabular">{loading ? "…" : value}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
                <div className="text-[10px] font-mono text-muted-foreground/60 mt-1">{file}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            4 fichiers CSV seront téléchargés simultanément. Aucune donnée n'est modifiée par cet export.
          </p>
        </CardContent>
      </Card>

      {/* Confirmation */}
      <Card className="mb-6 border-amber-200 bg-amber-50/50">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4 text-amber-600" />
            Confirmation requise
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Pour éviter tout export accidentel, recopiez le code ci-dessous :
          </p>

          <div className="flex justify-center">
            <div className="font-mono text-3xl font-bold tracking-[0.35em] bg-white border-2 border-amber-300 rounded-lg px-6 py-3 text-amber-800 select-all">
              {confirmCode}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Saisir le code</label>
            <Input
              value={inputCode}
              onChange={(e) => { setInputCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setExported(false); }}
              placeholder="______"
              className={`font-mono text-center text-lg tracking-widest max-w-[180px] ${
                inputCode.length === 6
                  ? confirmed ? "border-green-400 focus-visible:ring-green-400" : "border-destructive focus-visible:ring-destructive"
                  : ""
              }`}
              maxLength={6}
            />
            {inputCode.length === 6 && !confirmed && (
              <p className="text-xs text-destructive">Code incorrect.</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Export button */}
      <div className="flex items-center gap-4">
        {exported ? (
          <div className="flex items-center gap-2 text-sm text-green-700">
            <CheckCircle2 className="h-4 w-4" />
            Export lancé — 4 fichiers en cours de téléchargement.
          </div>
        ) : (
          <Button
            size="lg"
            onClick={handleExport}
            disabled={!confirmed || loading || !!error}
            className="gap-2"
          >
            <Download className="h-4 w-4" />
            Exporter les données ({today})
          </Button>
        )}
        {error && (
          <p className="text-xs text-destructive">Erreur lors du chargement des données.</p>
        )}
      </div>

      {exported && (
        <Button variant="ghost" size="sm" className="mt-3 text-muted-foreground" onClick={() => { setInputCode(""); setExported(false); }}>
          Relancer un export
        </Button>
      )}

      {/* Info légale */}
      <div className="mt-10 pt-6 border-t border-border text-xs text-muted-foreground space-y-1">
        <p>Les données exportées appartiennent à votre organisation. L'application est un outil de traitement — elle ne conserve pas vos données au-delà de son usage opérationnel.</p>
        <p>Conservez les exports dans un lieu sécurisé. Ils contiennent des données personnelles soumises au RGPD.</p>
      </div>
    </div>
  );
}
