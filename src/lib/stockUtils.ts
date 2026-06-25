/**
 * Calcule le stock disponible à partir des champs déjà chargés.
 * Remplace les calculs inline dupliqués (DRY uniquement — pas de règle métier).
 * Pour la faisabilité d'un OF, utiliser getProductionFeasibility().
 */
export function calcStockDispo(stockActuel: number, reserved: number): number {
  return Math.max(0, stockActuel - Math.max(0, reserved));
}
