export const fmtInt = (n: number | null | undefined) =>
  new Intl.NumberFormat("fr-FR").format(Number(n ?? 0));

export const fmtKg = (n: number | null | undefined) =>
  `${new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n ?? 0))} kg`;

export const fmtPalette = (n: number | null | undefined) =>
  new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n ?? 0));

export type PaletteResteType =
  | "none"       // reste = 0 : aucune palette partielle
  | "full"       // reste >= 75% : compter comme palette complète
  | "demi"       // 25% < reste < 75% : demi-palette suggérée
  | "mini";      // reste <= 25% : regroupement / optimisation conseillé

export type PaletteSplit = {
  completes: number;
  reste: number;
  resteType: PaletteResteType;
  total: number;          // palettes physiques (completes + 0 ou 1 partielle)
  capacite: number;
};

/** Décompose une quantité en palettes complètes + qualification du reste. */
export function splitPalettes(qty: number, capaciteParPalette: number): PaletteSplit | null {
  if (!Number.isFinite(qty) || qty <= 0) return null;
  if (!Number.isFinite(capaciteParPalette) || capaciteParPalette <= 0) return null;
  const completes = Math.floor(qty / capaciteParPalette);
  const reste     = qty % capaciteParPalette;
  const ratio     = reste / capaciteParPalette;
  const resteType: PaletteResteType =
    reste === 0         ? "none" :
    ratio >= 0.75       ? "full" :
    ratio >= 0.25       ? "demi" :
                          "mini";
  return { completes, reste, resteType, total: completes + (reste > 0 ? 1 : 0), capacite: capaciteParPalette };
}

export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

export const fmtDateTime = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
