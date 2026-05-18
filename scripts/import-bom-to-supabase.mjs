#!/usr/bin/env node
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

function parseLine(line) {
  if (line.includes("\t")) {
    const parts = line.split("\t");
    if (parts.length < 4) return null;
    const coffretRef = (parts[0] ?? "").trim();
    const pieceRef = (parts[1] ?? "").trim();
    const pieceName = (parts[2] ?? "").trim();
    const qty = Number((parts[3] ?? "").trim().replace(",", "."));
    return { coffretRef, pieceRef, pieceName, qty };
  }

  const m = line.match(/^(\S+)\s+(\S+)\s+(.+?)\s+(-?\d+(?:[.,]\d+)?)$/);
  if (!m) return null;
  const coffretRef = m[1].trim();
  const pieceRef = m[2].trim();
  const pieceName = m[3].trim();
  const qty = Number(m[4].replace(",", "."));
  return { coffretRef, pieceRef, pieceName, qty };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: node scripts/import-bom-to-supabase.mjs <bom_input_file>");
    process.exit(1);
  }

  const SUPABASE_URL =
    process.env.VITE_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL;

  const SUPABASE_KEY =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Missing Supabase env vars. Set VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY/VITE_SUPABASE_ANON_KEY (or NEXT_PUBLIC_*). ");
    process.exit(1);
  }

  const raw = fs.readFileSync(inputPath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    console.error("Input file is empty or missing rows.");
    process.exit(1);
  }

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const parsed = parseLine(lines[i]);
    if (!parsed) continue;

    const { coffretRef, pieceRef, pieceName, qty } = parsed;
    if (!coffretRef || !pieceRef || !Number.isFinite(qty) || qty <= 0) continue;
    rows.push({
      coffretRef,
      pieceRef,
      pieceName: pieceName || pieceRef,
      qty: Math.round(qty),
    });
  }

  if (rows.length === 0) {
    console.error("No parsable rows found.");
    process.exit(1);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  const coffretRefs = [...new Set(rows.map((r) => r.coffretRef))];
  const composantMap = new Map();
  for (const r of rows) {
    if (!composantMap.has(r.pieceRef)) composantMap.set(r.pieceRef, r.pieceName);
  }

  const coffretUpserts = coffretRefs.map((reference) => ({ reference, name: reference }));
  const composantUpserts = [...composantMap.entries()].map(([reference, name]) => ({ reference, name }));

  for (const batch of chunk(coffretUpserts, 500)) {
    const { error } = await sb.from("coffrets").upsert(batch, { onConflict: "reference", ignoreDuplicates: false });
    if (error) throw error;
  }

  for (const batch of chunk(composantUpserts, 500)) {
    const { error } = await sb.from("composants").upsert(batch, { onConflict: "reference", ignoreDuplicates: false });
    if (error) throw error;
  }

  const { data: coffrets, error: eC } = await sb.from("coffrets").select("id, reference").in("reference", coffretRefs);
  if (eC) throw eC;

  const composantRefs = [...composantMap.keys()];
  const { data: composants, error: eP } = await sb.from("composants").select("id, reference").in("reference", composantRefs);
  if (eP) throw eP;

  const coffretIdByRef = new Map((coffrets ?? []).map((c) => [c.reference, c.id]));
  const composantIdByRef = new Map((composants ?? []).map((c) => [c.reference, c.id]));

  const bomUpserts = rows
    .map((r) => ({
      coffret_id: coffretIdByRef.get(r.coffretRef),
      composant_id: composantIdByRef.get(r.pieceRef),
      quantity: r.qty,
    }))
    .filter((r) => Boolean(r.coffret_id && r.composant_id));

  for (const batch of chunk(bomUpserts, 1000)) {
    const { error } = await sb.from("coffret_components").upsert(batch, {
      onConflict: "coffret_id,composant_id",
      ignoreDuplicates: false,
    });
    if (error) throw error;
  }

  console.log(`Import OK: ${rows.length} lignes source, ${coffretUpserts.length} coffrets, ${composantUpserts.length} composants.`);
}

main().catch((e) => {
  console.error("Import failed:", e?.message || e);
  process.exit(1);
});
