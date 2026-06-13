export const fmtInt = (n: number | null | undefined) =>
  new Intl.NumberFormat("fr-FR").format(Number(n ?? 0));

export const fmtKg = (n: number | null | undefined) =>
  `${new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n ?? 0))} kg`;

export const fmtPalette = (n: number | null | undefined) =>
  new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n ?? 0));

export type PaletteSplit = {
  completes: number;      // palettes remplies à capacité max
  reste: number;          // unités sur la palette partielle (0 = pas de partielle)
  total: number;          // nombre physique de palettes
  capacite: number;       // unités par palette
};

/** Décompose une quantité en palettes complètes + palette partielle éventuelle. */
export function splitPalettes(qty: number, capaciteParPalette: number): PaletteSplit | null {
  if (!Number.isFinite(qty) || qty <= 0) return null;
  if (!Number.isFinite(capaciteParPalette) || capaciteParPalette <= 0) return null;
  const completes = Math.floor(qty / capaciteParPalette);
  const reste     = qty % capaciteParPalette;
  return { completes, reste, total: completes + (reste > 0 ? 1 : 0), capacite: capaciteParPalette };
}

export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

export const fmtDateTime = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
