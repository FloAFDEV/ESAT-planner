/**
 * Calcule le stock disponible à partir des champs déjà chargés.
 * Source de vérité unique pour tout affichage côté frontend.
 * Pour la faisabilité d'un OF, utiliser getProductionFeasibility() qui fait
 * un calcul conservatif supplémentaire sur les réservations temps-réel.
 */
export function calcStockDispo(stockActuel: number, reserved: number): number {
  return Math.max(0, stockActuel - Math.max(0, reserved));
}

/**
 * Détecte une incohérence entre le stock physique et le stock réservé.
 * reserved_stock > stock = réservation orpheline ou mouvement non appliqué.
 */
export function hasStockInconsistency(stockActuel: number, reserved: number): boolean {
  return reserved > stockActuel;
}
