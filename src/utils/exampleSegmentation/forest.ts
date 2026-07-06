// Random forest training and fast dense prediction for the example-based
// auto-segmentation tool. See EXAMPLE_SEGMENTATION_TOOL.md §4.3 (normative).
//
// Training uses the `ml-random-forest` package (small sample counts, up to
// ~12000 rows - fine as number[][]). Dense prediction over a working-res
// image (up to ~1M pixels) is a hand-rolled loop over flattened trees stored
// in typed arrays, reading directly from feature planes - never a
// number[][] built per pixel.

import { RandomForestClassifier } from "ml-random-forest";

const DEFAULT_N_ESTIMATORS = 32;
const DEFAULT_MAX_DEPTH = 12;
// Fixed default seed so training is deterministic given identical inputs,
// as required by spec §4.3. ml-random-forest seeds its (sample and feature)
// bagging RNG from this value.
const DEFAULT_SEED = 42;

export interface ITrainForestOptions {
  nEstimators?: number;
  maxDepth?: number;
  seed?: number;
}

export interface IFlattenedTree {
  // Global feature-plane index at each internal node; unused (-1) at leaves.
  featureIndex: Int32Array;
  // Split threshold at each internal node: left iff featureValue < threshold.
  threshold: Float32Array;
  // Child node index within this tree's arrays; -1 marks a leaf.
  leftChild: Int32Array;
  rightChild: Int32Array;
  // Leaf probability of the foreground class (label 1); unused at internal nodes.
  leafValue: Float32Array;
}

export interface IFlattenedForest {
  featureCount: number;
  trees: IFlattenedTree[];
}

// Plain-object mirror of IFlattenedForest, safe to JSON.stringify - for the
// future backend batch-apply path (§9): ship a trained model to a worker job.
export interface ISerializedTree {
  featureIndex: number[];
  threshold: number[];
  leftChild: number[];
  rightChild: number[];
  leafValue: number[];
}

export interface ISerializedForest {
  featureCount: number;
  trees: ISerializedTree[];
}

// Minimal shape of the `ml-cart` TreeNode instances backing each estimator.
// ml-random-forest's own type declarations reference undeclared ml-cart
// types, so we describe only the fields we actually read.
interface ICartTreeNode {
  splitColumn?: number;
  splitValue?: number;
  left?: ICartTreeNode;
  right?: ICartTreeNode;
  distribution?: { columns: number; get(row: number, col: number): number };
}

interface IFlattenState {
  featureIndex: number[];
  threshold: number[];
  leftChild: number[];
  rightChild: number[];
  leafValue: number[];
}

/** Probability of the foreground class (label 1) encoded in a leaf's class distribution. */
function leafForegroundProbability(
  distribution: ICartTreeNode["distribution"],
): number {
  if (!distribution || distribution.columns < 2) {
    // Only label 0 was ever observed at this leaf (see ml-cart's
    // toDiscreteDistribution: the distribution only gets a column for label 1
    // once at least one label-1 sample reaches the leaf).
    return 0;
  }
  return distribution.get(0, 1);
}

/**
 * Flattens one trained tree into typed arrays, remapping the tree's local
 * (feature-bagged) column indices back to global feature indices via
 * `featureIndexMap` (ml-random-forest's per-tree `indexes[i]`).
 */
function flattenTree(
  root: ICartTreeNode,
  featureIndexMap: number[],
): IFlattenedTree {
  const state: IFlattenState = {
    featureIndex: [],
    threshold: [],
    leftChild: [],
    rightChild: [],
    leafValue: [],
  };

  // Iterative pre-order flatten: push a node with the array slot reserved for
  // it (`slot`), and if it has children, remember the slot to backpatch once
  // the children are flattened.
  const stack: { node: ICartTreeNode; slot: number }[] = [];
  const allocateSlot = (): number => {
    state.featureIndex.push(-1);
    state.threshold.push(0);
    state.leftChild.push(-1);
    state.rightChild.push(-1);
    state.leafValue.push(0);
    return state.featureIndex.length - 1;
  };

  const rootSlot = allocateSlot();
  stack.push({ node: root, slot: rootSlot });

  while (stack.length > 0) {
    const { node, slot } = stack.pop() as { node: ICartTreeNode; slot: number };
    if (node.left && node.right) {
      state.featureIndex[slot] = featureIndexMap[node.splitColumn as number];
      state.threshold[slot] = node.splitValue as number;

      const leftSlot = allocateSlot();
      const rightSlot = allocateSlot();
      state.leftChild[slot] = leftSlot;
      state.rightChild[slot] = rightSlot;

      stack.push({ node: node.right, slot: rightSlot });
      stack.push({ node: node.left, slot: leftSlot });
    } else {
      state.leafValue[slot] = leafForegroundProbability(node.distribution);
    }
  }

  return {
    featureIndex: Int32Array.from(state.featureIndex),
    threshold: Float32Array.from(state.threshold),
    leftChild: Int32Array.from(state.leftChild),
    rightChild: Int32Array.from(state.rightChild),
    leafValue: Float32Array.from(state.leafValue),
  };
}

/**
 * Trains a random forest classifier on a small, already-subsampled labeled
 * pixel set (labels must be 0 = background, 1 = foreground) and returns it
 * flattened into typed arrays for fast dense prediction.
 */
export function trainForest(
  trainingSet: number[][],
  labels: number[],
  options: ITrainForestOptions = {},
): IFlattenedForest {
  const nEstimators = options.nEstimators ?? DEFAULT_N_ESTIMATORS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const seed = options.seed ?? DEFAULT_SEED;
  const featureCount = trainingSet[0]?.length ?? 0;

  const classifier = new RandomForestClassifier({
    nEstimators,
    seed,
    treeOptions: { maxDepth },
    useSampleBagging: true,
    // Out-of-bag bookkeeping isn't used here and can throw when a sample is
    // never left out across all trees; skip it entirely.
    noOOB: true,
  });
  classifier.train(trainingSet, labels);

  const estimators = classifier.estimators as { root: ICartTreeNode }[];
  const featureIndexMaps = classifier.indexes as number[][];
  const trees = estimators.map((estimator, treeIndex) =>
    flattenTree(estimator.root, featureIndexMaps[treeIndex]),
  );

  return { featureCount, trees };
}

/**
 * Dense prediction over every pixel of a working-resolution feature stack.
 * Reads directly from the feature planes; never materializes a per-pixel
 * feature vector. Output is the mean of each tree's leaf probability
 * (soft voting).
 */
export function predictDense(
  forest: IFlattenedForest,
  featurePlanes: Float32Array[],
  pixelCount: number,
): Float32Array {
  const { trees } = forest;
  const nTrees = trees.length;
  const probabilities = new Float32Array(pixelCount);
  if (nTrees === 0) {
    return probabilities;
  }
  const inverseTreeCount = 1 / nTrees;

  for (let pixel = 0; pixel < pixelCount; ++pixel) {
    let sum = 0;
    for (let t = 0; t < nTrees; ++t) {
      const tree = trees[t];
      let node = 0;
      while (tree.leftChild[node] !== -1) {
        const featureValue = featurePlanes[tree.featureIndex[node]][pixel];
        node =
          featureValue < tree.threshold[node]
            ? tree.leftChild[node]
            : tree.rightChild[node];
      }
      sum += tree.leafValue[node];
    }
    probabilities[pixel] = sum * inverseTreeCount;
  }
  return probabilities;
}

export function serializeForest(forest: IFlattenedForest): ISerializedForest {
  return {
    featureCount: forest.featureCount,
    trees: forest.trees.map((tree) => ({
      featureIndex: Array.from(tree.featureIndex),
      threshold: Array.from(tree.threshold),
      leftChild: Array.from(tree.leftChild),
      rightChild: Array.from(tree.rightChild),
      leafValue: Array.from(tree.leafValue),
    })),
  };
}

export function deserializeForest(json: ISerializedForest): IFlattenedForest {
  return {
    featureCount: json.featureCount,
    trees: json.trees.map((tree) => ({
      featureIndex: Int32Array.from(tree.featureIndex),
      threshold: Float32Array.from(tree.threshold),
      leftChild: Int32Array.from(tree.leftChild),
      rightChild: Int32Array.from(tree.rightChild),
      leafValue: Float32Array.from(tree.leafValue),
    })),
  };
}
