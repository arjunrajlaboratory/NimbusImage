import { isEqual } from "lodash";

import {
  clampToMaterializablePropertyShape,
  IAnnotationPipelineStep,
  TPipelineStep,
} from "@/store/model";

// Tag auto-wiring (spec: WORKER_PIPELINES.md §5). Shared by the pipeline
// editor (as it shows and saves the pipeline) and the runner (on the steps as
// they will run, so a linked tool whose output tags changed since the last
// save still feeds the property steps after it).
// Pure function: every property step flagged `autoWired: true` takes its
// tags/shape from the nearest preceding enabled annotation step. A step
// without the flag is left alone: the editor sets it on every step it adds,
// so an unflagged step was made elsewhere and its tags may be deliberate.
// Idempotent, so re-running after every edit is safe.
export function computeAutoWiredSteps(steps: TPipelineStep[]): TPipelineStep[] {
  let lastAnnotation: IAnnotationPipelineStep | null = null;
  return steps.map((step) => {
    if (step.kind === "annotation") {
      if (step.enabled) {
        lastAnnotation = step;
      }
      return step;
    }
    // A step linked to an existing property computes on that property's
    // own tags and shape.
    if (step.autoWired !== true || step.sourcePropertyId || !lastAnnotation) {
      return step;
    }
    const wiredTags = lastAnnotation.annotation.tags;
    const wiredShape = clampToMaterializablePropertyShape(
      lastAnnotation.annotation.shape,
    );
    if (step.shape === wiredShape && isEqual(step.inputTags.tags, wiredTags)) {
      return step;
    }
    return {
      ...step,
      shape: wiredShape,
      inputTags: { ...step.inputTags, tags: [...wiredTags] },
    };
  });
}
