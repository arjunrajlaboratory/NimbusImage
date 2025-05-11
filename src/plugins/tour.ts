import Vue from "vue";
import Shepherd from "shepherd.js";
import Router from "vue-router";
import "shepherd.js/dist/css/shepherd.css";
import "./tour.scss";
import { tourBus } from "./tourBus";
import { logError } from "@/utils/log";
import {
  ITourConfig,
  ITourMetadata,
  IExtendedShepherdStep,
} from "@/store/model";

interface ShepherdShowEvent {
  step: IExtendedShepherdStep;
}

export class TourManager {
  private shepherd!: Shepherd.Tour;
  private currentStepIndex = 0;
  private isActive = false;
  private tours: Record<string, ITourMetadata> = {};

  constructor(private router: Router) {
    Vue.prototype.$startTour = this.startTour.bind(this);
    Vue.prototype.$nextStep = this.nextStep.bind(this);
    Vue.prototype.$loadAllTours = this.loadAllTours.bind(this);
    Vue.prototype.$isTourActive = this.isTourActive.bind(this);

    // Watch for route changes
    this.router.afterEach(() => {
      if (this.shepherd && this.isActive) {
        this.checkCurrentStep();
      }
    });
  }

  public isTourActive(): boolean {
    return this.isActive;
  }

  private async checkCurrentStep() {
    if (!this.isActive) {
      return;
    }

    if (
      !this.shepherd ||
      !this.shepherd.steps ||
      this.shepherd.steps.length === 0
    ) {
      return;
    }

    if (this.currentStepIndex >= this.shepherd.steps.length) {
      this.isActive = false;
      this.shepherd.complete();
      return;
    }

    const currentStep = this.shepherd.steps[
      this.currentStepIndex
    ] as IExtendedShepherdStep;
    const currentRoute = this.router.currentRoute.name;
    const expectedRoute = currentStep.options.route;

    if (currentRoute === expectedRoute) {
      try {
        // Execute beforeShow hook if it exists
        if (currentStep.options.beforeShow) {
          try {
            await currentStep.options.beforeShow();
          } catch (error) {
            logError(`[Tour] Error in beforeShow hook:`, error);
          }
        }

        // Wait for element to be available
        if (currentStep.options.attachTo?.element) {
          await this.waitForElement(
            currentStep.options.attachTo.element.toString(),
            currentStep.options.waitForElement,
          );
        }

        this.shepherd.show(currentStep.id);
      } catch (error) {
        logError(`[Tour] Error showing step:`, error);
        // Optionally advance to next step on error
        this.currentStepIndex++;
        this.checkCurrentStep();
      }
    }
    // No else block - let route changes trigger new checks
  }

  private waitForElement(
    selector: string,
    timeout: number = 1000,
  ): Promise<Element> {
    return new Promise((resolve, reject) => {
      if (document.querySelector(selector)) {
        return resolve(document.querySelector(selector)!);
      }

      const observer = new MutationObserver(() => {
        if (document.querySelector(selector)) {
          observer.disconnect();
          resolve(document.querySelector(selector)!);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      // Use configurable timeout
      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element ${selector} not found after ${timeout}ms`));
      }, timeout);
    });
  }

  async startTour(tourName: string) {
    const tour = await this.loadTourConfig(tourName);
    if (!tour) {
      return;
    }

    this.currentStepIndex = 0;
    this.isActive = true;

    this.shepherd = new Shepherd.Tour({
      useModalOverlay: true,
      defaultStepOptions: {
        classes: "shepherd-theme-custom",
        scrollTo: false,
        cancelIcon: {
          enabled: true,
        },
        buttons: [
          {
            text: "Next",
            classes: "v-btn v-btn--elevated primary",
            action: () => {
              const currentStep = this.shepherd.steps[
                this.currentStepIndex
              ] as IExtendedShepherdStep;
              // Execute onNext hook if it exists
              if (currentStep.options.onNext) {
                try {
                  // Convert string to function if necessary
                  const onNext =
                    typeof currentStep.options.onNext === "string"
                      ? new Function(currentStep.options.onNext)
                      : currentStep.options.onNext;
                  onNext();
                } catch (error) {
                  logError("[Tour] Error executing onNext hook:", error);
                }
              }
              this.currentStepIndex++;
              this.shepherd.hide();
              // Immediately check for the next step
              this.checkCurrentStep();
            },
          },
        ],
      },
    });

    // Immediately hide the overlay if needed for the first step
    requestAnimationFrame(() => {
      const overlay = document.querySelector(
        ".shepherd-modal-overlay-container",
      );
      if (overlay && this.shepherd.steps[0]) {
        const firstStep = this.shepherd.steps[0] as IExtendedShepherdStep;
        (overlay as HTMLElement).style.display =
          firstStep.options.hasModalOverlay === false ? "none" : "block";
      }
    });

    // Add a show event handler
    this.shepherd.on("show", (event: ShepherdShowEvent) => {
      const step = event.step;
      const overlay = document.querySelector(
        ".shepherd-modal-overlay-container",
      );
      if (overlay) {
        (overlay as HTMLElement).style.display = step.options.hasModalOverlay
          ? "block"
          : "none";
      }
    });

    // Add steps
    this.shepherd.addSteps(
      tour.steps.map((step, index: number) => {
        const isLastStep = index === tour.steps.length - 1;

        // Convert hook strings to functions
        const beforeShow = step.beforeShow
          ? new Function(step.beforeShow)
          : undefined;
        const onNext = step.onNext ? new Function(step.onNext) : undefined;

        // Define buttons based on showNextButton option
        const buttons =
          step.showNextButton !== false
            ? [
                {
                  text: isLastStep ? "Done" : "Next",
                  classes: "v-btn v-btn--elevated primary",
                  action: () => {
                    const currentStep = this.shepherd.steps[
                      this.currentStepIndex
                    ] as IExtendedShepherdStep;
                    // Execute onNext hook if it exists
                    if (currentStep.options.onNext) {
                      try {
                        const onNext =
                          typeof currentStep.options.onNext === "string"
                            ? new Function(currentStep.options.onNext)
                            : currentStep.options.onNext;
                        onNext();
                      } catch (error) {
                        logError("[Tour] Error executing onNext hook:", error);
                      }
                    }
                    this.currentStepIndex++;
                    this.shepherd.hide();
                    this.checkCurrentStep();
                  },
                },
              ]
            : [];

        return {
          id: step.id,
          attachTo: step.element
            ? {
                element: step.element,
                on: step.position || "bottom",
              }
            : undefined,
          popperOptions: {
            // NOTE: LLMs often suggest that I use "fixed" strategy, but it
            // has not seemed to solve any problems. Still, leaving here in case
            // anyone wants to try it in the future.
            // strategy: "fixed",
            modifiers: [
              {
                name: "offset",
                options: {
                  offset: [0, 15],
                },
              },
              {
                name: "preventOverflow",
                options: {
                  boundary: "viewport",
                  padding: 10,
                },
              },
              // NOTE: Although not needed now, this option was helpful when
              // a tour step was clipped by some other element, thus hiding it.
              // May be useful for future debugging purposes in case some tour
              // step is hidden unexpectedly.
              // { name: "hide", enabled: false },
            ],
          },
          title: step.title,
          text: step.text,
          classes: "shepherd-theme-custom",
          arrow: true,
          route: step.route,
          waitForElement: step.waitForElement,
          beforeShow,
          onNext,
          hasModalOverlay: step.modalOverlay ?? true,
          onTriggerEvent: step.onTriggerEvent,
          buttons, // Use our conditional buttons array
          when: {
            show: () => {
              // First call the existing step listeners
              this.setupStepListeners(step);

              // Then add progress indicator
              const currentStep = this.shepherd.getCurrentStep();
              const currentStepElement = currentStep?.getElement();
              const footer =
                currentStepElement?.querySelector(".shepherd-footer");
              const progress = document.createElement("span");
              progress.className = "shepherd-progress";
              progress.innerText = `${this.currentStepIndex + 1} of ${this.shepherd.steps.length}`;
              if (currentStepElement) {
                if (footer) {
                  // If there already is a button, insert the progress before it
                  footer.insertBefore(
                    progress,
                    currentStepElement.querySelector(
                      ".shepherd-button:last-child",
                    ),
                  );
                } else {
                  // make a footer and add the progress to it
                  const footer = document.createElement("div");
                  footer.className = "shepherd-footer";
                  footer.appendChild(progress);
                  currentStepElement.appendChild(footer);
                }
              }
            },

            hide: () => {
              return this.removeStepListeners(step);
            },
          },
        };
      }),
    );

    // Start by checking if we can show the first step
    this.checkCurrentStep();
  }

  async loadTourConfig(tourName: string): Promise<ITourConfig> {
    const tour = await import(`@/tours/${tourName}.yaml`);
    return tour.default;
  }

  stopTour() {
    if (this.shepherd) {
      this.isActive = false;
      this.shepherd.complete();
    }
  }

  async nextStep(targetElementId?: string) {
    if (!this.shepherd || !this.isActive) {
      return;
    }

    if (targetElementId) {
      // Find the index of the step with the matching element
      const targetIndex = this.shepherd.steps.findIndex(
        (step: any) => step.options.attachTo.element === `#${targetElementId}`,
      );

      if (targetIndex !== -1) {
        this.currentStepIndex = targetIndex;
      } else {
        // If target not found, just go to next step
        this.currentStepIndex++;
      }
    } else {
      // Normal next step behavior
      this.currentStepIndex++;
    }

    this.shepherd.hide();
    await this.checkCurrentStep();
  }

  async loadAllTours(): Promise<Record<string, ITourMetadata>> {
    if (Object.keys(this.tours).length > 0) {
      return this.tours;
    }

    // Get all tour YAML files from the tours directory
    const tourModules = import.meta.glob("@/tours/*.yaml");

    for (const path in tourModules) {
      const tourName = path.split("/").pop()?.replace(".yaml", "");
      if (tourName) {
        const tour = await import(`@/tours/${tourName}.yaml`);
        this.tours[tourName] = {
          name: tour.default.name,
          entryPoint: tour.default.entryPoint,
          popular: tour.default.popular,
          category: tour.default.category || "General",
        };
      }
    }

    return this.tours;
  }

  private setupStepListeners = (step: any) => {
    if (step.onTriggerEvent) {
      tourBus.$on(step.onTriggerEvent, this.handleNextStep);
    }
  };

  private removeStepListeners = (step: any) => {
    if (step.onTriggerEvent) {
      tourBus.$off(step.onTriggerEvent, this.handleNextStep);
    }
  };

  private handleNextStep = () => {
    this.currentStepIndex++;
    this.shepherd.hide();
    this.checkCurrentStep();
  };
}

declare module "vue/types/vue" {
  interface Vue {
    $startTour: (tourName: string) => Promise<void>;
    $nextStep: (targetElementId?: string) => Promise<void>;
    $loadAllTours: () => Promise<Record<string, ITourMetadata>>;
    $isTourActive: () => boolean;
  }
}

export function installTour(router: Router) {
  return new TourManager(router);
}
