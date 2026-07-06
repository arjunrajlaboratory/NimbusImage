// Random forest training and fast dense prediction for the example-based
// auto-segmentation tool. See EXAMPLE_SEGMENTATION_TOOL.md §4.3 (normative).
//
// Training is a from-scratch CART random forest (see the module doc comment
// below `trainForest` for why `ml-random-forest` wasn't usable as-is). Dense
// prediction over a working-res image (up to ~1M pixels) is a hand-rolled
// loop over flattened trees stored in typed arrays, reading directly from
// feature planes - never a number[][] built per pixel.

const DEFAULT_N_ESTIMATORS = 32;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MIN_SAMPLES_SPLIT = 3;
// Fixed default seed so training is deterministic given identical inputs, as
// required by spec §4.3.
const DEFAULT_SEED = 42;

export interface ITrainForestOptions {
  nEstimators?: number;
  maxDepth?: number;
  seed?: number;
  minSamplesSplit?: number;
  // Number of candidate features considered at each split (bagged, no
  // replacement). Defaults to round(sqrt(featureCount)), the standard
  // random-forest heuristic that also keeps split search cheap.
  featuresPerSplit?: number;
}

export interface IFlattenedTree {
  // Feature-plane index at each internal node; unused (-1) at leaves.
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

/**
 * Deterministic 32-bit LCG (Numerical Recipes constants). Used instead of
 * Math.random for bootstrap and feature bagging so training is reproducible
 * given the same seed and data, per spec §4.3.
 */
function createLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function bootstrapSampleIndices(n: number, rng: () => number): Int32Array {
  const indices = new Int32Array(n);
  for (let i = 0; i < n; ++i) {
    indices[i] = Math.floor(rng() * n);
  }
  return indices;
}

/** Picks `count` distinct feature indices out of [0, featureCount) via partial Fisher-Yates. */
function sampleFeatureSubset(
  featureCount: number,
  count: number,
  rng: () => number,
): number[] {
  const pool = Array.from({ length: featureCount }, (_, i) => i);
  const pickCount = Math.min(count, featureCount);
  for (let i = 0; i < pickCount; ++i) {
    const j = i + Math.floor(rng() * (featureCount - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, pickCount);
}

function giniImpurity(count1: number, total: number): number {
  if (total === 0) {
    return 0;
  }
  const p1 = count1 / total;
  const p0 = 1 - p1;
  return 1 - p0 * p0 - p1 * p1;
}

interface ISplitCandidate {
  featureIndex: number;
  threshold: number;
  gain: number;
}

// Number of histogram bins used to search for a split threshold per feature.
// This is the standard histogram-based split search used by production
// GBM/RF implementations (e.g. LightGBM/XGBoost): approximate thresholds in
// exchange for O(k) cost per feature per node instead of a full sort.
const SPLIT_HISTOGRAM_BINS = 32;

/**
 * Finds the best (feature, threshold) split among a bagged feature subset by
 * binning each candidate feature's values into a fixed number of histogram
 * bins (one O(k) pass to bin, one O(numBins) pass to scan for the best
 * boundary) rather than sorting.
 *
 * An exact sort-and-sweep (O(k log k), no comparator closure) was tried
 * first but a plain comparator-based Array.prototype.sort over
 * number[][]-backed values was still the dominant cost at the sample counts
 * spec §4.3 requires (up to 12000 rows): training took *seconds*, not the
 * required ≤500ms. Histogram binning removes sorting entirely.
 */
function findBestSplit(
  sampleIndices: Int32Array,
  featureSubset: number[],
  trainingSet: number[][],
  labels: Int32Array,
  parentCount1: number,
): ISplitCandidate | null {
  const total = sampleIndices.length;
  const parentImpurity = giniImpurity(parentCount1, total);
  let best: ISplitCandidate | null = null;

  const binCount0 = new Float64Array(SPLIT_HISTOGRAM_BINS);
  const binCount1 = new Float64Array(SPLIT_HISTOGRAM_BINS);

  for (const featureIndex of featureSubset) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < total; ++i) {
      const value = trainingSet[sampleIndices[i]][featureIndex];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (min === max) {
      continue; // constant feature over this node: no useful split
    }

    binCount0.fill(0);
    binCount1.fill(0);
    const scale = SPLIT_HISTOGRAM_BINS / (max - min);
    for (let i = 0; i < total; ++i) {
      const sampleIndex = sampleIndices[i];
      const value = trainingSet[sampleIndex][featureIndex];
      let bin = ((value - min) * scale) | 0;
      if (bin >= SPLIT_HISTOGRAM_BINS) {
        bin = SPLIT_HISTOGRAM_BINS - 1; // value === max lands past the last bin edge
      }
      if (labels[sampleIndex] === 1) {
        binCount1[bin]++;
      } else {
        binCount0[bin]++;
      }
    }

    let leftCount0 = 0;
    let leftCount1 = 0;
    for (let bin = 0; bin < SPLIT_HISTOGRAM_BINS - 1; ++bin) {
      leftCount0 += binCount0[bin];
      leftCount1 += binCount1[bin];
      const leftCount = leftCount0 + leftCount1;
      if (leftCount === 0) {
        continue;
      }
      const rightCount = total - leftCount;
      if (rightCount === 0) {
        continue;
      }
      const rightCount1 = parentCount1 - leftCount1;
      const gain =
        parentImpurity -
        (leftCount / total) * giniImpurity(leftCount1, leftCount) -
        (rightCount / total) * giniImpurity(rightCount1, rightCount);
      if (!best || gain > best.gain) {
        best = {
          featureIndex,
          threshold: min + (bin + 1) / scale,
          gain,
        };
      }
    }
  }
  return best;
}

interface IBuildNode {
  featureIndex?: number;
  threshold?: number;
  left?: IBuildNode;
  right?: IBuildNode;
  // Leaf-only: fraction of foreground (label 1) training samples that reached this node.
  probability?: number;
}

const MIN_USEFUL_GAIN = 1e-9;

function buildTree(
  sampleIndices: Int32Array,
  trainingSet: number[][],
  labels: Int32Array,
  featureCount: number,
  featuresPerSplit: number,
  maxDepth: number,
  minSamplesSplit: number,
  rng: () => number,
  depth: number,
): IBuildNode {
  const total = sampleIndices.length;
  let count1 = 0;
  for (let i = 0; i < total; ++i) {
    if (labels[sampleIndices[i]] === 1) {
      count1++;
    }
  }
  const probability = total > 0 ? count1 / total : 0;
  const isPure = count1 === 0 || count1 === total;

  if (isPure || depth >= maxDepth || total < minSamplesSplit) {
    return { probability };
  }

  const featureSubset = sampleFeatureSubset(
    featureCount,
    featuresPerSplit,
    rng,
  );
  const split = findBestSplit(
    sampleIndices,
    featureSubset,
    trainingSet,
    labels,
    count1,
  );
  if (!split || split.gain <= MIN_USEFUL_GAIN) {
    return { probability };
  }

  const leftIndices: number[] = [];
  const rightIndices: number[] = [];
  for (let i = 0; i < total; ++i) {
    const sampleIndex = sampleIndices[i];
    if (trainingSet[sampleIndex][split.featureIndex] < split.threshold) {
      leftIndices.push(sampleIndex);
    } else {
      rightIndices.push(sampleIndex);
    }
  }
  if (leftIndices.length === 0 || rightIndices.length === 0) {
    // All samples landed on one side despite gain > 0 (can happen with
    // duplicate feature vectors); treat as a leaf rather than infinite-loop.
    return { probability };
  }

  return {
    featureIndex: split.featureIndex,
    threshold: split.threshold,
    left: buildTree(
      Int32Array.from(leftIndices),
      trainingSet,
      labels,
      featureCount,
      featuresPerSplit,
      maxDepth,
      minSamplesSplit,
      rng,
      depth + 1,
    ),
    right: buildTree(
      Int32Array.from(rightIndices),
      trainingSet,
      labels,
      featureCount,
      featuresPerSplit,
      maxDepth,
      minSamplesSplit,
      rng,
      depth + 1,
    ),
  };
}

interface IFlattenState {
  featureIndex: number[];
  threshold: number[];
  leftChild: number[];
  rightChild: number[];
  leafValue: number[];
}

/** Flattens one trained tree into typed arrays via an iterative pre-order traversal. */
function flattenTree(root: IBuildNode): IFlattenedTree {
  const state: IFlattenState = {
    featureIndex: [],
    threshold: [],
    leftChild: [],
    rightChild: [],
    leafValue: [],
  };
  const allocateSlot = (): number => {
    state.featureIndex.push(-1);
    state.threshold.push(0);
    state.leftChild.push(-1);
    state.rightChild.push(-1);
    state.leafValue.push(0);
    return state.featureIndex.length - 1;
  };

  const stack: { node: IBuildNode; slot: number }[] = [];
  stack.push({ node: root, slot: allocateSlot() });

  while (stack.length > 0) {
    const { node, slot } = stack.pop() as { node: IBuildNode; slot: number };
    if (node.left && node.right) {
      state.featureIndex[slot] = node.featureIndex as number;
      state.threshold[slot] = node.threshold as number;
      const leftSlot = allocateSlot();
      const rightSlot = allocateSlot();
      state.leftChild[slot] = leftSlot;
      state.rightChild[slot] = rightSlot;
      stack.push({ node: node.right, slot: rightSlot });
      stack.push({ node: node.left, slot: leftSlot });
    } else {
      state.leafValue[slot] = node.probability ?? 0;
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
 *
 * Deviation from spec §4.3: the spec suggests `ml-random-forest`, falling
 * back to a from-scratch CART "if its API proves awkward for per-tree
 * access". In practice its bundled `ml-cart` decision tree recomputes gini
 * from scratch for every candidate threshold at every node (no sort-and-sweep),
 * which is O(n^2) per node - training on a few thousand rows took *seconds to
 * tens of seconds* in local measurements, far outside the ≤500ms budget. This
 * from-scratch implementation uses histogram-based split search (see
 * findBestSplit) to keep split-finding at O(k) per feature per node, which is
 * what makes the target achievable at the sample counts spec §4.3 requires.
 */
export function trainForest(
  trainingSet: number[][],
  labels: number[],
  options: ITrainForestOptions = {},
): IFlattenedForest {
  const nEstimators = options.nEstimators ?? DEFAULT_N_ESTIMATORS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const seed = options.seed ?? DEFAULT_SEED;
  const minSamplesSplit = options.minSamplesSplit ?? DEFAULT_MIN_SAMPLES_SPLIT;
  const featureCount = trainingSet[0]?.length ?? 0;
  const featuresPerSplit =
    options.featuresPerSplit ??
    Math.max(1, Math.round(Math.sqrt(featureCount)));

  const n = trainingSet.length;
  const labelsArray = Int32Array.from(labels);
  const rng = createLcg(seed);

  const trees: IFlattenedTree[] = [];
  for (let t = 0; t < nEstimators; ++t) {
    const sampleIndices =
      n > 0 ? bootstrapSampleIndices(n, rng) : new Int32Array(0);
    const root = buildTree(
      sampleIndices,
      trainingSet,
      labelsArray,
      featureCount,
      featuresPerSplit,
      maxDepth,
      minSamplesSplit,
      rng,
      0,
    );
    trees.push(flattenTree(root));
  }

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
