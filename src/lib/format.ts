export const fmtInt = (n: number | null | undefined) =>
  new Intl.NumberFormat("fr-FR").format(Number(n ?? 0));

export const fmtKg = (n: number | null | undefined) =>
  `${new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n ?? 0))} kg`;

export const fmtPalette = (n: number | null | undefined) =>
  new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n ?? 0));

export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

export const fmtDateTime = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
