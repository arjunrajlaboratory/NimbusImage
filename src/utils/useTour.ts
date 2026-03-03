import { inject } from "vue";
import type { TourManager } from "@/plugins/tour";
import type { ITourMetadata } from "@/store/model";

const TOUR_MANAGER_KEY = "tourManager";

export function useTour() {
  const manager = inject<TourManager>(TOUR_MANAGER_KEY);
  if (!manager) {
    throw new Error(
      "TourManager not provided. Did you forget app.provide('tourManager', tourManager)?",
    );
  }
  return {
    startTour: (tourName: string): Promise<void> => manager.startTour(tourName),
    loadAllTours: (): Promise<Record<string, ITourMetadata>> =>
      manager.loadAllTours(),
    isTourActive: (): boolean => manager.isTourActive(),
    nextStep: (targetElementId?: string): Promise<void> =>
      manager.nextStep(targetElementId),
  };
}
