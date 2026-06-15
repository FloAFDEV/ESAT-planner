import { useQuery } from "@tanstack/react-query";
import { getProductionFeasibility } from "@/lib/getProductionFeasibility";

export function useFeasibility(coffretId: string, quantity: number) {
  return useQuery({
    queryKey: ["production_feasibility", coffretId, quantity],
    enabled: Boolean(coffretId) && quantity > 0,
    queryFn: async () => getProductionFeasibility(coffretId, quantity),
  });
}
