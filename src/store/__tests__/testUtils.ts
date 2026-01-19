/**
 * Test utilities for annotation store testing
 * Provides mock factories and helpers for testing vuex-module-decorators stores
 */
import { vi } from "vitest";
import {
  IAnnotation,
  IAnnotationConnection,
  IAnnotationBase,
  IAnnotationConnectionBase,
  AnnotationShape,
  IDataset,
  IDatasetConfiguration,
  IDisplayLayer,
} from "../model";

// Counter for generating unique IDs
let idCounter = 0;

/**
 * Reset the ID counter (useful between tests)
 */
export function resetIdCounter() {
  idCounter = 0;
}

/**
 * Generate a unique ID for test data
 */
export function generateId(): string {
  return `test-id-${++idCounter}`;
}

/**
 * Create a mock annotation with optional overrides
 */
export function createMockAnnotation(
  overrides: Partial<IAnnotation> = {},
): IAnnotation {
  const id = overrides.id ?? generateId();
  return {
    id,
    name: overrides.name ?? null,
    tags: overrides.tags ?? ["test-tag"],
    shape: overrides.shape ?? AnnotationShape.Point,
    channel: overrides.channel ?? 0,
    location: overrides.location ?? { XY: 0, Z: 0, Time: 0 },
    coordinates: overrides.coordinates ?? [{ x: 100, y: 100 }],
    datasetId: overrides.datasetId ?? "test-dataset-id",
    color: overrides.color ?? null,
    ...overrides,
  };
}

/**
 * Create a mock annotation base (for creating new annotations)
 */
export function createMockAnnotationBase(
  overrides: Partial<IAnnotationBase> = {},
): IAnnotationBase {
  return {
    tags: overrides.tags ?? ["test-tag"],
    shape: overrides.shape ?? AnnotationShape.Point,
    channel: overrides.channel ?? 0,
    location: overrides.location ?? { XY: 0, Z: 0, Time: 0 },
    coordinates: overrides.coordinates ?? [{ x: 100, y: 100 }],
    datasetId: overrides.datasetId ?? "test-dataset-id",
    color: overrides.color ?? null,
    ...overrides,
  };
}

/**
 * Create a mock connection with optional overrides
 */
export function createMockConnection(
  overrides: Partial<IAnnotationConnection> = {},
): IAnnotationConnection {
  const id = overrides.id ?? generateId();
  return {
    id,
    label: overrides.label ?? "test-connection",
    tags: overrides.tags ?? ["connection-tag"],
    parentId: overrides.parentId ?? "parent-id",
    childId: overrides.childId ?? "child-id",
    datasetId: overrides.datasetId ?? "test-dataset-id",
    ...overrides,
  };
}

/**
 * Create a mock connection base (for creating new connections)
 */
export function createMockConnectionBase(
  overrides: Partial<IAnnotationConnectionBase> = {},
): IAnnotationConnectionBase {
  return {
    label: overrides.label ?? "test-connection",
    tags: overrides.tags ?? ["connection-tag"],
    parentId: overrides.parentId ?? "parent-id",
    childId: overrides.childId ?? "child-id",
    datasetId: overrides.datasetId ?? "test-dataset-id",
    ...overrides,
  };
}

/**
 * Create a mock AnnotationsAPI with all methods as vi mocks
 */
export function createMockAnnotationsAPI() {
  return {
    createAnnotation: vi.fn().mockResolvedValue(null),
    createMultipleAnnotations: vi.fn().mockResolvedValue([]),
    deleteAnnotation: vi.fn().mockResolvedValue(undefined),
    deleteMultipleAnnotations: vi.fn().mockResolvedValue(undefined),
    updateAnnotations: vi.fn().mockResolvedValue(undefined),
    updateAnnotation: vi.fn().mockResolvedValue(undefined),
    getAnnotationsForDatasetId: vi.fn().mockResolvedValue([]),
    createConnection: vi.fn().mockResolvedValue(null),
    createConnections: vi.fn().mockResolvedValue([]),
    createMultipleConnections: vi.fn().mockResolvedValue([]),
    deleteMultipleConnections: vi.fn().mockResolvedValue(undefined),
    getConnectionsForDatasetId: vi.fn().mockResolvedValue([]),
    deleteConnection: vi.fn().mockResolvedValue(undefined),
    updateConnection: vi.fn().mockResolvedValue(undefined),
    computeAnnotationWithWorker: vi.fn().mockResolvedValue({ data: [] }),
    undo: vi.fn().mockResolvedValue(undefined),
    redo: vi.fn().mockResolvedValue(undefined),
    toAnnotation: vi.fn((item) => item),
    toConnection: vi.fn((item) => item),
  };
}

/**
 * Create a mock display layer
 */
export function createMockDisplayLayer(
  overrides: Partial<IDisplayLayer> = {},
): IDisplayLayer {
  const id = overrides.id ?? generateId();
  return {
    id,
    name: overrides.name ?? "Test Layer",
    color: overrides.color ?? "#FF0000",
    channel: overrides.channel ?? 0,
    xy: overrides.xy ?? { type: "current", value: null },
    z: overrides.z ?? { type: "current", value: null },
    time: overrides.time ?? { type: "current", value: null },
    visible: overrides.visible ?? true,
    contrast: overrides.contrast ?? {
      mode: "percentile",
      blackPoint: 0,
      whitePoint: 100,
    },
    layerGroup: overrides.layerGroup ?? null,
    ...overrides,
  };
}

/**
 * Create a minimal mock dataset
 */
export function createMockDataset(overrides: Partial<IDataset> = {}): IDataset {
  return {
    id: overrides.id ?? "test-dataset-id",
    name: overrides.name ?? "Test Dataset",
    description: overrides.description ?? "",
    creatorId: overrides.creatorId ?? "test-creator-id",
    xy: overrides.xy ?? [0],
    z: overrides.z ?? [0],
    time: overrides.time ?? [0],
    channels: overrides.channels ?? [0],
    channelNames: overrides.channelNames ?? new Map([[0, "Channel 0"]]),
    width: overrides.width ?? 1000,
    height: overrides.height ?? 1000,
    images: overrides.images ?? (() => []),
    anyImage: overrides.anyImage ?? (() => null),
    allImages: overrides.allImages ?? [],
    ...overrides,
  } as IDataset;
}

/**
 * Create a minimal mock configuration
 */
export function createMockConfiguration(
  overrides: Partial<IDatasetConfiguration> = {},
): IDatasetConfiguration {
  return {
    id: overrides.id ?? "test-config-id",
    name: overrides.name ?? "Test Configuration",
    description: overrides.description ?? "",
    compatibility: overrides.compatibility ?? {
      xyDimensions: "one",
      zDimensions: "one",
      tDimensions: "one",
      channels: {},
    },
    layers: overrides.layers ?? [],
    tools: overrides.tools ?? [],
    snapshots: overrides.snapshots ?? [],
    propertyIds: overrides.propertyIds ?? [],
    scales: overrides.scales ?? {
      pixelSize: { value: 1, unit: "µm" },
      zStep: { value: 1, unit: "µm" },
      tStep: { value: 1, unit: "s" },
    },
    ...overrides,
  } as IDatasetConfiguration;
}

/**
 * Create a mock main store module with common state
 */
export function createMockMainStore(overrides: Record<string, any> = {}) {
  const mockAnnotationsAPI = createMockAnnotationsAPI();
  return {
    dataset: overrides.dataset ?? null,
    configuration: overrides.configuration ?? null,
    isLoggedIn: overrides.isLoggedIn ?? true,
    xy: overrides.xy ?? 0,
    z: overrides.z ?? 0,
    time: overrides.time ?? 0,
    layers: overrides.layers ?? [],
    scales: overrides.scales ?? {
      pixelSize: { value: 1, unit: "µm" },
      zStep: { value: 1, unit: "µm" },
      tStep: { value: 1, unit: "s" },
    },
    annotationsAPI: overrides.annotationsAPI ?? mockAnnotationsAPI,
    getLayerFromId: overrides.getLayerFromId ?? vi.fn().mockReturnValue(null),
    layerSliceIndexes:
      overrides.layerSliceIndexes ??
      vi.fn().mockReturnValue({ xyIndex: 0, zIndex: 0, tIndex: 0 }),
    loadLargeImages: overrides.loadLargeImages ?? vi.fn().mockResolvedValue(false),
    scheduleTileFramesComputation:
      overrides.scheduleTileFramesComputation ?? vi.fn(),
    scheduleMaxMergeCache: overrides.scheduleMaxMergeCache ?? vi.fn(),
    scheduleHistogramCache: overrides.scheduleHistogramCache ?? vi.fn(),
    ...overrides,
  };
}

/**
 * Create a mock sync store module
 */
export function createMockSyncStore() {
  return {
    loading: false,
    saving: false,
    datasetLoading: false,
    lastError: null,
    setSaving: vi.fn(),
    setLoading: vi.fn(),
    setDatasetLoading: vi.fn(),
  };
}

/**
 * Create a mock progress store module
 */
export function createMockProgressStore() {
  return {
    items: [],
    notifications: [],
    create: vi.fn().mockResolvedValue("progress-id"),
    update: vi.fn(),
    complete: vi.fn(),
    handleJobProgress: vi.fn(),
    createNotification: vi.fn().mockResolvedValue("notification-id"),
    dismissNotification: vi.fn(),
    dismissAllNotifications: vi.fn(),
  };
}

/**
 * Create a mock jobs store module
 */
export function createMockJobsStore() {
  return {
    addJob: vi.fn().mockResolvedValue(true),
    getJobStatus: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Helper to create multiple mock annotations
 */
export function createMockAnnotations(
  count: number,
  baseOverrides: Partial<IAnnotation> = {},
): IAnnotation[] {
  return Array.from({ length: count }, (_, i) =>
    createMockAnnotation({
      ...baseOverrides,
      id: `annotation-${i + 1}`,
      name: baseOverrides.name ?? `Annotation ${i + 1}`,
    }),
  );
}

/**
 * Helper to create multiple mock connections
 */
export function createMockConnections(
  count: number,
  baseOverrides: Partial<IAnnotationConnection> = {},
): IAnnotationConnection[] {
  return Array.from({ length: count }, (_, i) =>
    createMockConnection({
      ...baseOverrides,
      id: `connection-${i + 1}`,
      parentId: baseOverrides.parentId ?? `parent-${i + 1}`,
      childId: baseOverrides.childId ?? `child-${i + 1}`,
    }),
  );
}
