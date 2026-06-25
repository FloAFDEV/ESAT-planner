const PG_MESSAGES: Record<string, string> = {
  "23505": "Cette référence existe déjà.",
  "23503": "Impossible : cet élément est lié à d'autres données.",
  "42501": "Accès non autorisé.",
};

export function parseSupabaseError(e: unknown): string {
  if (e && typeof e === "object") {
    const err = e as Record<string, unknown>;
    const code = String(err.code ?? "");
    if (PG_MESSAGES[code]) return PG_MESSAGES[code];
    const msg = String(err.message ?? "");
    if (msg) return msg;
  }
  return "Une erreur inattendue est survenue.";
}
