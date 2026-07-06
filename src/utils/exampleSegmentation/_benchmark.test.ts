import { describe, it } from "vitest";
import { buildFeatureStack } from "@/utils/exampleSegmentation/features";
import { rasterizePolygon } from "@/utils/exampleSegmentation/rasterize";
import { trainForest, predictDense } from "@/utils/exampleSegmentation/forest";
import {
  thresholdProbabilityMap,
  labelConnectedComponents,
  computeComponentAreas,
  filterComponentsBySize,
  traceAllContours,
} from "@/utils/exampleSegmentation/postprocess";

// Manual benchmark: run with `pnpm vitest run src/utils/exampleSegmentation/_benchmark.test.ts`
// after removing .skip. Excluded from the regular suite (exceeds the default
// test timeout by design — it times full-resolution stages).
describe.skip("performance benchmark (manual, not asserting)", () => {
  it("times each stage at ~1MP working resolution", { timeout: 120000 }, () => {
    const width = 1024;
    const height = 1000; // ~1.024 MP
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; ++i) {
      const v = (i * 37) % 256;
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = (v + 40) % 256;
      rgba[i * 4 + 2] = (v + 80) % 256;
      rgba[i * 4 + 3] = 255;
    }

    let t0 = performance.now();
    const stack = buildFeatureStack(rgba, width, height);
    const featuresMs = performance.now() - t0;

    const fgPolygon = [
      { x: 100, y: 100 },
      { x: 160, y: 100 },
      { x: 160, y: 160 },
      { x: 100, y: 160 },
    ];
    const fgMask = rasterizePolygon(fgPolygon, width, height);
    const trainingSet: number[][] = [];
    const labels: number[] = [];
    for (let i = 0; i < fgMask.length; i += 50) {
      if (fgMask[i]) {
        trainingSet.push(stack.planes.map((p) => p[i]));
        labels.push(1);
      } else if (i % 500 === 0) {
        trainingSet.push(stack.planes.map((p) => p[i]));
        labels.push(0);
      }
    }

    t0 = performance.now();
    const forest = trainForest(trainingSet, labels);
    const trainMs = performance.now() - t0;

    t0 = performance.now();
    const probabilityMap = predictDense(forest, stack.planes, width * height);
    const predictMs = performance.now() - t0;

    t0 = performance.now();
    const binary = thresholdProbabilityMap(probabilityMap, 0.5);
    const { labels: ccLabels, componentCount } = labelConnectedComponents(
      binary,
      width,
      height,
    );
    const areas = computeComponentAreas(ccLabels, componentCount);
    const keep = filterComponentsBySize(areas, 0, Infinity);
    traceAllContours(ccLabels, width, height, componentCount, keep);
    const postprocessMs = performance.now() - t0;

    // eslint-disable-next-line no-console
    console.log(
      `[benchmark] channels=${stack.channelCount} planes=${stack.planes.length} rows=${trainingSet.length}\n` +
        `featuresMs=${featuresMs.toFixed(1)} trainMs=${trainMs.toFixed(1)} predictMs=${predictMs.toFixed(1)} postprocessMs=${postprocessMs.toFixed(1)}`,
    );
  });
});
