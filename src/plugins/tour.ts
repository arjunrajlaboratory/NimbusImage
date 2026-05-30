import type { App } from "vue";
import type { Router } from "vue-router";
import { driver, type Driver, type PopoverDOM } from "driver.js";
import "driver.js/dist/driver.css";
import "./tour.scss";
import { tourBus } from "./tourBus";
import { logError, logWarning } from "@/utils/log";
import { ITourConfig, ITourMetadata, ITourStepRuntime } from "@/store/model";

const DEFAULT_WAIT_MS = 8000; // datasetview loads images; give async UI room

export class TourManager {
  private driverObj: Driver | null = null;
  private steps: ITourStepRuntime[] = [];
  private currentStepIndex = 0;
  private isActive = false;
  private tours: Record<string, ITourMetadata> = {};
  private activeTriggerEvent: string | null = null;

  constructor(
    private router: Router,
    app: App,
  ) {
    app.config.globalProperties.$startTour = this.startTour.bind(this);
    app.config.globalProperties.$nextStep = this.nextStep.bind(this);
    app.config.globalProperties.$loadAllTours = this.loadAllTours.bind(this);
    app.config.globalProperties.$isTourActive = this.isTourActive.bind(this);

    this.router.afterEach(() => {
      if (this.isActive) {
        this.showCurrentStep();
      }
    });
  }

  public isTourActive(): boolean {
    return this.isActive;
  }

  async startTour(tourName: string) {
    const tour = await this.loadTourConfig(tourName);
    if (!tour) {
      return;
    }

    this.stopTour();

    this.steps = tour.steps.map((step) => ({
      id: step.id,
      route: step.route,
      element: step.element,
      title: step.title,
      text: step.text,
      position: step.position ?? "bottom",
      waitForElement: step.waitForElement ?? DEFAULT_WAIT_MS,
      hasModalOverlay: step.modalOverlay ?? true,
      showNextButton: step.showNextButton !== false,
      onTriggerEvent: step.onTriggerEvent,
    }));
    this.currentStepIndex = 0;
    this.isActive = true;

    this.driverObj = driver({
      stagePadding: 8,
      popoverClass: "tour-popover",
      allowClose: true,
      overlayClickBehavior: "close",
      onCloseClick: () => this.stopTour(),
      onDestroyed: () => {
        if (this.isActive) {
          this.stopTour();
        }
      },
    });

    await this.showCurrentStep();
  }

  // Renders the current step IF we are on its route; otherwise navigates there.
  private async showCurrentStep() {
    if (!this.isActive || !this.driverObj) {
      return;
    }
    if (this.currentStepIndex >= this.steps.length) {
      return this.stopTour();
    }

    const step = this.steps[this.currentStepIndex];

    const currentRoute = this.router.currentRoute.value.name;
    if (step.route && currentRoute !== step.route) {
      try {
        await this.router.push({ name: step.route });
      } catch (error) {
        logError(`[Tour] Failed to navigate to route "${step.route}":`, error);
      }
      // afterEach will re-invoke showCurrentStep once the route settles.
      return;
    }

    this.clearTriggerListener();

    if (step.element) {
      try {
        await this.waitForElement(step.element, step.waitForElement);
      } catch {
        return this.showMissingTargetPopover(step);
      }
    }

    this.renderStep(step);

    if (step.onTriggerEvent) {
      this.activeTriggerEvent = step.onTriggerEvent;
      tourBus.on(step.onTriggerEvent, this.advance);
    }
  }

  private renderStep(step: ITourStepRuntime) {
    if (!this.driverObj) {
      return;
    }
    const isLast = this.currentStepIndex === this.steps.length - 1;
    this.driverObj.highlight({
      element: step.element ?? "body",
      disableActiveInteraction: step.hasModalOverlay,
      popover: {
        title: step.title,
        description: step.text,
        side: step.position,
        align: "center",
        showButtons: step.showNextButton ? ["next"] : [],
        nextBtnText: isLast ? "Done" : "Next",
        onNextClick: () => this.advance(),
        onPopoverRender: (popover) => {
          this.applyOverlayMode(step);
          this.appendProgress(popover);
        },
      },
    });
    this.applyOverlayMode(step);
  }

  // driver.js overlay opacity is global; toggle a body class the SCSS keys off.
  private applyOverlayMode(step: ITourStepRuntime) {
    document.body.classList.toggle("tour-no-overlay", !step.hasModalOverlay);
  }

  // Insert a "N of M" progress label into the popover footer.
  private appendProgress(popover: PopoverDOM) {
    const footer = popover.footer;
    if (!footer || footer.querySelector(".tour-progress")) {
      return;
    }
    const progress = document.createElement("span");
    progress.className = "tour-progress";
    progress.innerText = `${this.currentStepIndex + 1} of ${this.steps.length}`;
    footer.insertBefore(progress, footer.firstChild);
  }

  private showMissingTargetPopover(step: ITourStepRuntime) {
    if (!this.driverObj) {
      return;
    }
    logWarning(
      `[Tour] Target "${step.element}" for step "${step.id}" not found ` +
        `after ${step.waitForElement}ms. Showing recovery popover.`,
    );
    const isLast = this.currentStepIndex === this.steps.length - 1;
    document.body.classList.add("tour-no-overlay");
    this.driverObj.highlight({
      element: "body",
      popover: {
        title: "This step isn't available",
        description:
          "The screen for this step couldn't be found. You can skip it or " +
          "end the tour.",
        showButtons: ["next"],
        nextBtnText: isLast ? "End tour" : "Skip",
        onNextClick: () => this.advance(),
      },
    });
  }

  private advance = () => {
    this.clearTriggerListener();
    this.currentStepIndex++;
    this.showCurrentStep();
  };

  private clearTriggerListener() {
    if (this.activeTriggerEvent) {
      tourBus.off(this.activeTriggerEvent, this.advance);
      this.activeTriggerEvent = null;
    }
  }

  private waitForElement(selector: string, timeout: number): Promise<Element> {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) {
        return resolve(existing);
      }
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element ${selector} not found after ${timeout}ms`));
      }, timeout);
    });
  }

  async loadTourConfig(tourName: string): Promise<ITourConfig> {
    const tour = await import(`@/tours/${tourName}.yaml`);
    return tour.default;
  }

  stopTour() {
    this.clearTriggerListener();
    document.body.classList.remove("tour-no-overlay");
    this.isActive = false;
    if (this.driverObj) {
      const obj = this.driverObj;
      this.driverObj = null;
      obj.destroy();
    }
  }

  async nextStep(targetElementId?: string) {
    if (!this.isActive) {
      return;
    }
    if (targetElementId) {
      const targetIndex = this.steps.findIndex(
        (s) =>
          s.element === `#${targetElementId}` ||
          s.element === `[data-tour="${targetElementId}"]`,
      );
      this.currentStepIndex =
        targetIndex !== -1 ? targetIndex : this.currentStepIndex + 1;
    } else {
      this.currentStepIndex++;
    }
    await this.showCurrentStep();
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
}

// Vue 3: declare global properties for TypeScript
declare module "vue" {
  interface ComponentCustomProperties {
    $startTour: (tourName: string) => Promise<void>;
    $nextStep: (targetElementId?: string) => Promise<void>;
    $loadAllTours: () => Promise<Record<string, ITourMetadata>>;
    $isTourActive: () => boolean;
  }
}

export function installTour(app: App, router: Router) {
  return new TourManager(router, app);
}
