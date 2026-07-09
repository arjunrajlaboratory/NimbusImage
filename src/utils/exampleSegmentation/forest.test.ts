import { describe, expect, it } from "vitest";
import {
  deserializeForest,
  IFlattenedForest,
  predictDense,
  serializeForest,
  trainForest,
} from "@/utils/exampleSegmentation/forest";

// Builds a two-blob synthetic dataset: 2 features, class 0 clustered near the
// origin, class 1 clustered far away - trivially separable by any reasonable
// tree/forest.
function makeSeparableBlobs(pointsPerClass: number): {
  trainingSet: number[][];
  labels: number[];
} {
  const trainingSet: number[][] = [];
  const labels: number[] = [];
  for (let i = 0; i < pointsPerClass; ++i) {
    // Deterministic pseudo-jitter (no RNG) via a simple integer hash pattern.
    const jitterA = ((i * 37) % 11) / 10;
    const jitterB = ((i * 53) % 7) / 10;
    trainingSet.push([jitterA, jitterB]);
    labels.push(0);
    trainingSet.push([10 + jitterA, 10 + jitterB]);
    labels.push(1);
  }
  return { trainingSet, labels };
}

/** Feature planes where plane[f] is a constant equal to trainingSet row's f-th value. */
function planesForSingleRow(row: number[]): Float32Array[] {
  return row.map((value) => Float32Array.from([value]));
}

describe("trainForest / predictDense", () => {
  it("reaches ~100% train accuracy on separable blobs", () => {
    const { trainingSet, labels } = makeSeparableBlobs(50);
    const forest = trainForest(trainingSet, labels);

    let correct = 0;
    for (let i = 0; i < trainingSet.length; ++i) {
      const planes = planesForSingleRow(trainingSet[i]);
      const probability = predictDense(forest, planes, 1)[0];
      const predictedLabel = probability >= 0.5 ? 1 : 0;
      if (predictedLabel === labels[i]) {
        correct++;
      }
    }
    expect(correct / trainingSet.length).toBeGreaterThanOrEqual(0.98);
  });

  it("is deterministic across repeated training runs with the same seed", () => {
    const { trainingSet, labels } = makeSeparableBlobs(30);
    const forestA = trainForest(trainingSet, labels);
    const forestB = trainForest(trainingSet, labels);
    expect(serializeForest(forestA)).toEqual(serializeForest(forestB));
  });

  it("predicts the same probability map for the whole feature stack as pixel-by-pixel calls", () => {
    const { trainingSet, labels } = makeSeparableBlobs(20);
    const forest = trainForest(trainingSet, labels);

    // Build a small "image" from the training rows: 2 planes of length N.
    const featureCount = trainingSet[0].length;
    const pixelCount = trainingSet.length;
    const planes: Float32Array[] = [];
    for (let f = 0; f < featureCount; ++f) {
      planes.push(Float32Array.from(trainingSet.map((row) => row[f])));
    }

    const denseResult = predictDense(forest, planes, pixelCount);
    for (let i = 0; i < pixelCount; ++i) {
      const singlePixelPlanes = planesForSingleRow(trainingSet[i]);
      const single = predictDense(forest, singlePixelPlanes, 1)[0];
      expect(denseResult[i]).toBeCloseTo(single, 6);
    }
  });

  it("flattened tree traversal always lands on a valid leaf", () => {
    // This validates the flatten step itself: walking the flattened typed
    // arrays for any input must always terminate at a leaf slot (leftChild
    // === -1) holding a valid probability, never fall off the tree.
    const { trainingSet, labels } = makeSeparableBlobs(25);
    const forest = trainForest(trainingSet, labels, { nEstimators: 5 });

    for (const row of trainingSet.slice(0, 10)) {
      const planes = planesForSingleRow(row);
      for (const tree of forest.trees) {
        let node = 0;
        while (tree.leftChild[node] !== -1) {
          const featureValue = planes[tree.featureIndex[node]][0];
          node =
            featureValue < tree.threshold[node]
              ? tree.leftChild[node]
              : tree.rightChild[node];
        }
        // Leaf probability must be either exactly a training class ratio in [0, 1].
        expect(tree.leafValue[node]).toBeGreaterThanOrEqual(0);
        expect(tree.leafValue[node]).toBeLessThanOrEqual(1);
      }
    }
  });

  it("handles an all-background training set without crashing", () => {
    const trainingSet = [
      [0, 0],
      [0.1, 0.1],
      [0.2, 0],
    ];
    const labels = [0, 0, 0];
    const forest = trainForest(trainingSet, labels);
    const planes = planesForSingleRow([0.05, 0.05]);
    const probability = predictDense(forest, planes, 1)[0];
    expect(probability).toBe(0);
  });
});

describe("serializeForest / deserializeForest", () => {
  it("round-trips to a plain JSON-able object and back", () => {
    const { trainingSet, labels } = makeSeparableBlobs(15);
    const forest = trainForest(trainingSet, labels);

    const json = serializeForest(forest);
    const roundTripped = JSON.parse(JSON.stringify(json));
    const restored: IFlattenedForest = deserializeForest(roundTripped);

    const planes = planesForSingleRow(trainingSet[0]);
    const original = predictDense(forest, planes, 1)[0];
    const afterRoundTrip = predictDense(restored, planes, 1)[0];
    expect(afterRoundTrip).toBeCloseTo(original, 6);
  });
});
