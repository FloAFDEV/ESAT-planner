#!/usr/bin/env node
import fs from "node:fs";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/import-bom-tsv.mjs <bom.tsv>");
  process.exit(1);
}

const raw = fs.readFileSync(inputPath, "utf8");
const lines = raw
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);

if (lines.length < 2) {
  console.error("TSV vide ou incomplet.");
  process.exit(1);
}

function parseLine(line) {
  // Preferred format: TSV (4 columns)
  if (line.includes("\t")) {
    const parts = line.split("\t");
    if (parts.length < 4) return null;
    const coffretRef = (parts[0] ?? "").trim();
    const pieceRef = (parts[1] ?? "").trim();
    const pieceName = (parts[2] ?? "").trim();
    const qty = Number((parts[3] ?? "").trim().replace(",", "."));
    return { coffretRef, pieceRef, pieceName, qty };
  }

  // Fallback format: free text with spaces, where qty is last token.
  // Example: ASBNEP1101 PMFONDV250001 FOND V5 250X250 1
  const m = line.match(/^(\S+)\s+(\S+)\s+(.+?)\s+(-?\d+(?:[.,]\d+)?)$/);
  if (!m) return null;
  const coffretRef = m[1].trim();
  const pieceRef = m[2].trim();
  const pieceName = m[3].trim();
  const qty = Number(m[4].replace(",", "."));
  return { coffretRef, pieceRef, pieceName, qty };
}

const rows = [];
for (let i = 1; i < lines.length; i += 1) {
  const parsed = parseLine(lines[i]);
  if (!parsed) continue;

  const { coffretRef, pieceRef, pieceName, qty } = parsed;

  if (!coffretRef || !pieceRef || !Number.isFinite(qty) || qty <= 0) continue;

  rows.push({ coffretRef, pieceRef, pieceName, qty: Math.round(qty) });
}

if (rows.length === 0) {
  console.error("Aucune ligne exploitable detectee.");
  process.exit(1);
}

const esc = (v) => String(v).replace(/'/g, "''");

const sql = [];
sql.push("begin;");
sql.push("set local search_path = public;");

// Upsert coffrets.
const coffretRefs = [...new Set(rows.map((r) => r.coffretRef))];
for (const ref of coffretRefs) {
  sql.push(
    `insert into coffrets(reference, name) values ('${esc(ref)}', '${esc(ref)}') on conflict (reference) do nothing;`
  );
}

// Upsert composants.
const composants = new Map();
for (const r of rows) {
  if (!composants.has(r.pieceRef)) composants.set(r.pieceRef, r.pieceName || r.pieceRef);
}
for (const [ref, name] of composants.entries()) {
  sql.push(
    `insert into composants(reference, name) values ('${esc(ref)}', '${esc(name)}') on conflict (reference) do update set name = excluded.name;`
  );
}

// Upsert BOM into coffret_components.
for (const r of rows) {
  sql.push(`
insert into coffret_components (coffret_id, composant_id, quantity)
select c.id, p.id, ${r.qty}
from coffrets c
join composants p on p.reference = '${esc(r.pieceRef)}'
where c.reference = '${esc(r.coffretRef)}'
on conflict (coffret_id, composant_id)
do update set quantity = excluded.quantity;`.trim());
}

sql.push("commit;");

process.stdout.write(sql.join("\n") + "\n");
