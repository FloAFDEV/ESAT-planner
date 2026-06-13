// Couche de messages utilisateur centralisée — FR uniquement
// Utiliser ces constantes dans tous les toast.success / toast.error / toast.warning

export const MSG = {
  // ── Fabrication / Production ────────────────────────────────────────────────
  OF_CREATED:               "Fabrication créée — stock réservé",
  OF_PLANNED_DEFICIT:       "Fabrication créée, mais il manque des pièces. Vérifiez la carte.",
  OF_STARTED:               "Fabrication démarrée",
  OF_RESUMED:               "Pièces disponibles — fabrication lancée",
  OF_CANCELED:              "Fabrication annulée — réservations libérées",
  OF_DELETED:               "Fabrication supprimée",
  OF_DONE:                  "Fabrication terminée — stock mis à jour",
  OF_COPIED:                (ref: string) => `OF client ${ref} copié`,
  OF_ARCHIVED:              (n: number) => `${n} OF${n > 1 ? "s" : ""} archivé${n > 1 ? "s" : ""}`,
  OF_EXPORT_EMPTY:          "Aucun OF à exporter",
  OF_EXPORT_OK:             "Export CSV téléchargé",
  OF_PARTIAL:               (produced: number | string, total: number | string) =>
                              `${produced} coffret${Number(produced) > 1 ? "s" : ""} fabriqué${Number(produced) > 1 ? "s" : ""} sur ${total} demandé${Number(total) > 1 ? "s" : ""}`,
  OF_STILL_MISSING:         (list: string) => `Il manque encore des pièces :\n${list}`,
  OF_QTY_REQUIRED:          "Saisissez au moins une quantité",

  // ── Expéditions / Livraisons ────────────────────────────────────────────────
  SHIPMENT_CREATED:         "Expédition créée",
  SHIPMENT_UPDATED:         "Expédition mise à jour",
  SHIPMENT_DELETED:         "Expédition supprimée",
  SHIPMENT_STATUS_UPDATED:  "Statut expédition mis à jour",
  SHIPMENT_EXPORT_EMPTY:    "Aucune expédition pour cette période",

  // ── Palettes ────────────────────────────────────────────────────────────────
  PALLET_DELETED:           "Palette supprimée",
  PALLET_ERROR:             "Erreur lors de l'ajout de la palette",

  // ── Clients ─────────────────────────────────────────────────────────────────
  CLIENT_CREATED:           "Client créé",
  CLIENT_UPDATED:           "Client mis à jour",
  CLIENT_DELETED:           "Client supprimé",
  CLIENT_SAVED:             (editMode: "create" | "edit") =>
                              editMode === "create" ? "Client créé" : "Client mis à jour",

  // ── Coffrets ────────────────────────────────────────────────────────────────
  COFFRET_CREATED:          "Coffret créé",
  COFFRET_UPDATED:          "Coffret mis à jour",
  COFFRET_ARCHIVED:         "Coffret archivé",

  // ── Composants ──────────────────────────────────────────────────────────────
  COMPOSANT_CREATED:        "Composant créé",
  COMPOSANT_ADDED:          "Composant ajouté",
  COMPOSANT_REMOVED:        "Composant retiré",
  COMPOSANT_DELETED:        "Composant supprimé",

  // ── Stock ───────────────────────────────────────────────────────────────────
  STOCK_MOVEMENT_SAVED:     "Mouvement enregistré",
  STOCK_EXPORT_OK:          "Export CSV téléchargé",
} as const;
