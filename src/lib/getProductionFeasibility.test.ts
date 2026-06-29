/**
 * Tests unitaires pour getProductionFeasibility.
 *
 * Prérequis : vitest + @vitest/ui
 *   npm install -D vitest @vitest/ui
 *   Ajouter dans vite.config.ts → test: { environment: "node" }
 *
 * Les tests mockent le client Supabase via vi.mock pour isoler la logique.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FeasibilityOptions } from "./getProductionFeasibility";

// ── Mock Supabase ────────────────────────────────────────────────────────────

type MockData = {
  nomenclatures: Array<{ coffret_id: string; composant_id: string; quantity: number; is_active: boolean }>;
  composants: Array<{ id: string; reference: string; name: string; stock: number; reserved_stock: number; deleted_at: string | null }>;
  stock_reservations: Array<{ composant_id: string; quantity: number; production_order_id: string; status: string }>;
};

let mockData: MockData = { nomenclatures: [], composants: [], stock_reservations: [] };

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      let filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => { filters[col] = val; return builder; },
        in: (col: string, vals: unknown[]) => { filters[`${col}__in`] = vals; return builder; },
        is: (col: string, val: unknown) => { filters[`${col}__is`] = val; return builder; },
        neq: (col: string, val: unknown) => { filters[`${col}__neq`] = val; return builder; },
        then: (resolve: (v: { data: unknown[]; error: null }) => void) => {
          let rows: unknown[] = [];

          if (table === "nomenclatures") {
            rows = mockData.nomenclatures.filter((r) => {
              if (filters["coffret_id"] && (r as any).coffret_id !== filters["coffret_id"]) return false;
              if (filters["is_active"] !== undefined && r.is_active !== filters["is_active"]) return false;
              return true;
            });
          } else if (table === "composants") {
            rows = mockData.composants.filter((r) => {
              const ids = filters["id__in"] as string[] | undefined;
              if (ids && !ids.includes(r.id)) return false;
              if (filters["deleted_at__is"] === null && r.deleted_at !== null) return false;
              return true;
            });
          } else if (table === "stock_reservations") {
            rows = mockData.stock_reservations.filter((r) => {
              if (filters["status"] && r.status !== filters["status"]) return false;
              const ids = filters["composant_id__in"] as string[] | undefined;
              if (ids && !ids.includes(r.composant_id)) return false;
              return true;
            });
          }
          resolve({ data: rows, error: null });
        },
      };
      return builder;
    },
  },
}));

import { getProductionFeasibility } from "./getProductionFeasibility";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const COFFRET_ID = "coffret-1";
const COMP_A = "comp-a";
const OF_1 = "of-1";
const OF_2 = "of-2";

function bom(qty: number) {
  return [{ coffret_id: COFFRET_ID, composant_id: COMP_A, quantity: qty, is_active: true }];
}

function composant(stock: number, reserved: number, deleted_at: string | null = null) {
  return [{ id: COMP_A, reference: "REF-A", name: "Composant A", stock, reserved_stock: reserved, deleted_at }];
}

function reservations(...rows: Array<{ order: string; qty: number; status?: string }>) {
  return rows.map((r) => ({
    composant_id: COMP_A,
    quantity: r.qty,
    production_order_id: r.order,
    status: r.status ?? "active",
  }));
}

beforeEach(() => {
  mockData = { nomenclatures: [], composants: [], stock_reservations: [] };
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("getProductionFeasibility", () => {

  describe("OF unique — sans concurrent", () => {
    it("stock suffisant sans réservation → can_produce=true", async () => {
      mockData.nomenclatures = bom(1);
      mockData.composants = composant(50, 0);
      const result = await getProductionFeasibility(COFFRET_ID, 10);
      expect(result.can_produce).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it("stock insuffisant → can_produce=false avec manquant correct", async () => {
      mockData.nomenclatures = bom(1);
      mockData.composants = composant(5, 0);
      const result = await getProductionFeasibility(COFFRET_ID, 10);
      expect(result.can_produce).toBe(false);
      expect(result.missing[0].missing).toBe(5); // besoin 10 - dispo 5
    });
  });

  describe("OF pending_material — exclusion de sa propre réservation", () => {
    it("OF avec réservation propre : sans exclusion → faussement bloqué", async () => {
      // Stock 182, réservé 103 par OF-1, OF-1 a besoin de 103
      mockData.nomenclatures = bom(1);
      mockData.composants = composant(182, 103);
      mockData.stock_reservations = reservations({ order: OF_1, qty: 103 });

      const result = await getProductionFeasibility(COFFRET_ID, 103);
      // Sans exclusion : available = 182 - max(103, 103) = 79, needed = 103 → missing = 24
      expect(result.can_produce).toBe(false);
      expect(result.missing[0].missing).toBe(24);
    });

    it("OF avec réservation propre : avec exclusion → libéré correctement", async () => {
      mockData.nomenclatures = bom(1);
      mockData.composants = composant(182, 103);
      mockData.stock_reservations = reservations({ order: OF_1, qty: 103 });

      const opts: FeasibilityOptions = { excludeProductionOrderId: OF_1 };
      const result = await getProductionFeasibility(COFFRET_ID, 103, opts);
      // Avec exclusion : reserved_sans_OF1 = 0, available = 182, needed = 103 → OK
      expect(result.can_produce).toBe(true);
      expect(result.missing).toHaveLength(0);
    });
  });

  describe("plusieurs OF concurrents", () => {
    it("deux OF actifs — sans exclusion : les deux réservations comptent", async () => {
      // Stock 200, OF-1 réserve 103, OF-2 réserve 103 → reserved=206, available=-6
      mockData.nomenclatures = bom(1);
      mockData.composants = composant(200, 206);
      mockData.stock_reservations = reservations(
        { order: OF_1, qty: 103 },
        { order: OF_2, qty: 103 }
      );

      const result = await getProductionFeasibility(COFFRET_ID, 103);
      expect(result.can_produce).toBe(false);
    });

    it("deux OF actifs — exclusion OF-1 : OF-2 reste réservé", async () => {
      mockData.nomenclatures = bom(1);
      mockData.composants = composant(200, 206);
      mockData.stock_reservations = reservations(
        { order: OF_1, qty: 103 },
        { order: OF_2, qty: 103 }
      );

      const opts: FeasibilityOptions = { excludeProductionOrderId: OF_1 };
      const result = await getProductionFeasibility(COFFRET_ID, 103, opts);
      // Avec exclusion OF-1 : reserved = 103 (OF-2), available = 200 - 103 = 97
      // besoin = 103, missing = 6
      expect(result.can_produce).toBe(false);
      expect(result.missing[0].missing).toBe(6);
    });

    it("deux OF actifs — stock suffisant pour les deux", async () => {
      mockData.nomenclatures = bom(1);
      mockData.composants = composant(300, 206);
      mockData.stock_reservations = reservations(
        { order: OF_1, qty: 103 },
        { order: OF_2, qty: 103 }
      );

      const opts: FeasibilityOptions = { excludeProductionOrderId: OF_1 };
      const result = await getProductionFeasibility(COFFRET_ID, 103, opts);
      // reserved = 103 (OF-2), available = 300 - 103 = 197, besoin = 103 → OK
      expect(result.can_produce).toBe(true);
    });
  });

  describe("annulation et reprise", () => {
    it("réservation annulée (status=canceled) exclue du calcul", async () => {
      mockData.nomenclatures = bom(1);
      mockData.composants = composant(50, 0); // reserved_stock remis à 0 par trigger
      mockData.stock_reservations = reservations({ order: OF_1, qty: 30, status: "canceled" });

      const result = await getProductionFeasibility(COFFRET_ID, 50);
      // La réservation annulée ne compte pas → available = 50, needed = 50 → OK
      expect(result.can_produce).toBe(true);
    });

    it("reprise pending_material après annulation d'un autre OF → OF libéré", async () => {
      // OF-2 était bloqué car OF-1 avait réservé tout le stock
      // OF-1 est maintenant canceled → OF-2 doit passer
      mockData.nomenclatures = bom(1);
      mockData.composants = composant(100, 100); // reserved_stock = 100 par OF-2
      mockData.stock_reservations = [
        { composant_id: COMP_A, quantity: 100, production_order_id: OF_2, status: "active" },
        { composant_id: COMP_A, quantity: 100, production_order_id: OF_1, status: "canceled" },
      ];

      const opts: FeasibilityOptions = { excludeProductionOrderId: OF_2 };
      const result = await getProductionFeasibility(COFFRET_ID, 100, opts);
      // Hors OF-2 : aucune réservation active → available = 100, needed = 100 → OK
      expect(result.can_produce).toBe(true);
    });
  });

  describe("composants archivés", () => {
    it("composant archivé exclu de la BOM → coffret vide → empty result", async () => {
      mockData.nomenclatures = [
        { coffret_id: COFFRET_ID, composant_id: COMP_A, quantity: 1, is_active: true },
      ];
      // composant archivé : deleted_at non null → exclu par le filtre .is("deleted_at", null)
      mockData.composants = composant(100, 0, "2026-01-01T00:00:00Z");

      const result = await getProductionFeasibility(COFFRET_ID, 10);
      // composant_ids trouvés mais aucun retourné par la query composants (deleted_at filtre)
      // byId est vide → available=0, needed=10, missing=10
      expect(result.can_produce).toBe(false);
    });

    it("ligne BOM inactive (is_active=false) exclue du calcul", async () => {
      mockData.nomenclatures = [
        { coffret_id: COFFRET_ID, composant_id: COMP_A, quantity: 5, is_active: false },
      ];
      mockData.composants = composant(100, 0);

      const result = await getProductionFeasibility(COFFRET_ID, 10);
      // is_active=false filtré → BOM vide → composantIds vide → empty
      expect(result.can_produce).toBe(false);
      expect(result.components).toHaveLength(0);
    });
  });

  describe("doublons historiques dans stock_reservations", () => {
    it("deux lignes actives pour le même (OF, composant) — surcomptage sans exclusion", async () => {
      // Simule un doublon historique avant la contrainte UNIQUE
      mockData.nomenclatures = bom(1);
      mockData.composants = composant(100, 60); // cached = 60 (doublon)
      mockData.stock_reservations = [
        { composant_id: COMP_A, quantity: 30, production_order_id: OF_1, status: "active" },
        { composant_id: COMP_A, quantity: 30, production_order_id: OF_1, status: "active" }, // doublon
      ];

      const result = await getProductionFeasibility(COFFRET_ID, 50);
      // Sans exclusion : realtimeReserved=60, cachedReserved=60 → reserved=60, available=40
      // needed=50, missing=10 → faux positif dû au doublon
      expect(result.missing[0].missing).toBe(10);
    });

    it("deux lignes actives — avec exclusion : les deux doublons exclus", async () => {
      mockData.nomenclatures = bom(1);
      mockData.composants = composant(100, 60);
      mockData.stock_reservations = [
        { composant_id: COMP_A, quantity: 30, production_order_id: OF_1, status: "active" },
        { composant_id: COMP_A, quantity: 30, production_order_id: OF_1, status: "active" },
      ];

      const opts: FeasibilityOptions = { excludeProductionOrderId: OF_1 };
      const result = await getProductionFeasibility(COFFRET_ID, 50, opts);
      // Les deux lignes OF-1 exclues → realtimeReserved=0, available=100, needed=50 → OK
      expect(result.can_produce).toBe(true);
    });
  });
});
