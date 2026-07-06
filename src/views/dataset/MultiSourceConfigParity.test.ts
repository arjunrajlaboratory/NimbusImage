import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";
import fs from "node:fs";
import path from "node:path";

// --- Top-level mock fn handles (hoisted before vi.mock calls) ---
const mockGetItems = vi.fn().mockResolvedValue([]);
const mockGetTiles = vi.fn().mockResolvedValue({});
const mockGetTilesInternalMetadata = vi.fn().mockResolvedValue({});
const mockCreateLargeImage = vi.fn().mockResolvedValue({});
const mockUpdateDatasetMetadata = vi.fn().mockResolvedValue({});
const mockAddMultiSourceMetadata = vi.fn().mockResolvedValue("item-123");
const mockRessourceChanged = vi.fn().mockResolvedValue(undefined);
const mockScheduleTileFramesComputation = vi.fn().mockResolvedValue(undefined);
const mockScheduleMaxMergeCache = vi.fn().mockResolvedValue(undefined);
const mockScheduleHistogramCache = vi.fn().mockResolvedValue(undefined);
const mockSetUploadDimensionStrategy = vi.fn();

// --- Store mock (mirrors MultiSourceConfiguration.test.ts) ---
vi.mock("@/store", () => ({
  default: {
    api: {
      getItems: (...args: any[]) => mockGetItems(...args),
      getTiles: (...args: any[]) => mockGetTiles(...args),
      getTilesInternalMetadata: (...args: any[]) =>
        mockGetTilesInternalMetadata(...args),
      createLargeImage: (...args: any[]) => mockCreateLargeImage(...args),
      updateDatasetMetadata: (...args: any[]) =>
        mockUpdateDatasetMetadata(...args),
    },
    addMultiSourceMetadata: (...args: any[]) =>
      mockAddMultiSourceMetadata(...args),
    girderResources: {
      ressourceChanged: (...args: any[]) => mockRessourceChanged(...args),
    },
    scheduleTileFramesComputation: (...args: any[]) =>
      mockScheduleTileFramesComputation(...args),
    scheduleMaxMergeCache: (...args: any[]) =>
      mockScheduleMaxMergeCache(...args),
    scheduleHistogramCache: (...args: any[]) =>
      mockScheduleHistogramCache(...args),
    get uploadWorkflow() {
      return { active: false, batchMode: false };
    },
    get uploadIsFirstDataset() {
      return false;
    },
    setUploadDimensionStrategy: (...args: any[]) =>
      mockSetUploadDimensionStrategy(...args),
  },
}));

// --- Utility mocks ---
vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
}));

vi.mock("@/utils/strings", () => ({
  parseTranscodeOutput: vi.fn(() => ({
    progressStatusText: "",
    transcodeProgress: undefined,
  })),
}));

// NOTE: @/utils/parsing and @/utils/ND2FileParsing are intentionally NOT
// mocked here: the parity harness must run the real label/parsing logic.

// p-limit: identity wrapper (no concurrency limiting in tests)
vi.mock("p-limit", () => ({
  default: () => (fn: any) => fn(),
}));

// p-retry: execute function immediately (no retries in tests)
vi.mock("p-retry", () => ({
  default: (fn: any) => fn(),
  AbortError: class AbortError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AbortError";
    }
  },
}));

// Import after mocks (real parsing is NOT mocked)
import { routerProvider } from "@/test/helpers";
import MultiSourceConfiguration from "./MultiSourceConfiguration.vue";
import { collectFilenameMetadata2 } from "@/utils/parsing";

// --- Fixture IO ---

// vitest root is the repo root (see vitest.config.js).
const FIXTURES_DIR = path.resolve(
  process.cwd(),
  "devops/girder/plugins/AnnotationPlugin/" +
    "upenncontrast_annotation/test/parity_fixtures",
);

const UPDATE_GOLDENS = !!process.env.UPDATE_PARITY_GOLDENS;

type TDim = "XY" | "Z" | "T" | "C";
const DIMS: TDim[] = ["XY", "Z", "T", "C"];

interface IFixtureFile {
  file: string;
  json: any;
}

function readFixtures(): IFixtureFile[] {
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({
      file: f,
      json: JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf-8")),
    }));
}

function writeFixture(file: string, json: any) {
  fs.writeFileSync(
    path.join(FIXTURES_DIR, file),
    JSON.stringify(json, null, 2) + "\n",
  );
}

const allFixtures = readFixtures();
const configFixtures = allFixtures.filter((f) => f.json.input.itemNames);
const parsingFixtures = allFixtures.filter((f) => f.json.input.filenames);

// --- Mount helper ---
const mockRouter = { push: vi.fn() };
const STUBS = {
  VContainer: true,
  VCard: true,
  VCardTitle: true,
  VCardText: true,
  VCardActions: true,
  VSubheader: true,
  VDivider: true,
  VBtn: true,
  VIcon: true,
  VMenu: true,
  VList: true,
  VListItem: true,
  VListItemContent: true,
  VCheckbox: true,
  VRow: true,
  VCol: true,
  VSpacer: true,
  VProgressCircular: true,
  VProgressLinear: true,
  VAlert: true,
  VSimpleTable: true,
  VDialog: true,
  VSnackbar: true,
  VTooltip: true,
  VChip: true,
};

function itemFromName(name: string, idx: number) {
  return {
    _id: `item-${idx}`,
    _modelType: "item",
    name,
    folderId: "folder1",
    creatorId: "user1",
    description: "",
    meta: {},
  };
}

function mountComponent() {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);

  const wrapper = shallowMount(MultiSourceConfiguration as any, {
    attachTo: app,
    props: { datasetId: "ds-1" },
    global: {
      provide: { ...routerProvider(mockRouter) },
      stubs: STUBS,
    },
  });

  const vm = wrapper.vm as any;
  if (vm.initialized) {
    vm.initialized.catch(() => {});
  }
  return wrapper;
}

// Extract {source, guess} | null from the current vm.assignments state.
function extractAssignments(vm: any): Record<TDim, any> {
  const result: Record<string, any> = {};
  for (const dim of DIMS) {
    const value = vm.assignments[dim]?.value;
    result[dim] = value
      ? { source: value.source, guess: value.guess }
      : null;
  }
  return result as Record<TDim, any>;
}

// Build a full strategy: keys present in the fixture strategy win (including
// explicit nulls); absent keys fall back to the vm's current strategy.
function buildFullStrategy(vm: any, fixtureStrategy: any) {
  const current = vm.getDimensionStrategy();
  const full: any = { transcode: vm.transcode };
  for (const dim of DIMS) {
    full[dim] = Object.prototype.hasOwnProperty.call(fixtureStrategy, dim)
      ? fixtureStrategy[dim]
      : current[dim];
  }
  return full;
}

// --- Tests ---

describe("MultiSourceConfig parity", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockGetItems.mockResolvedValue([]);
    mockGetTiles.mockResolvedValue({});
    mockGetTilesInternalMetadata.mockResolvedValue({});
    mockCreateLargeImage.mockResolvedValue({});
    mockUpdateDatasetMetadata.mockResolvedValue({});
    mockAddMultiSourceMetadata.mockResolvedValue("item-123");
    mockRessourceChanged.mockResolvedValue(undefined);
    mockScheduleTileFramesComputation.mockResolvedValue(undefined);
    mockScheduleMaxMergeCache.mockResolvedValue(undefined);
    mockScheduleHistogramCache.mockResolvedValue(undefined);
    mockSetUploadDimensionStrategy.mockReset();
    mockRouter.push = vi.fn();
  });

  afterEach(() => {
    document.querySelectorAll("[data-app]").forEach((el) => el.remove());
  });

  describe("config fixtures", () => {
    for (const fixture of configFixtures) {
      it(`${fixture.json.name} (${fixture.file})`, async () => {
        const { itemNames, tilesMetadata, tilesInternalMetadata, options } =
          fixture.json.input;

        const items = itemNames.map((n: string, i: number) =>
          itemFromName(n, i),
        );
        const tilesByName: Record<string, any> = {};
        const internalByName: Record<string, any> = {};
        itemNames.forEach((n: string, i: number) => {
          tilesByName[n] = tilesMetadata[i];
          internalByName[n] = tilesInternalMetadata[i];
        });

        mockGetItems.mockResolvedValue(items);
        // Key by item name/id, not call order (init runs concurrently).
        mockGetTiles.mockImplementation((item: any) =>
          Promise.resolve(tilesByName[item.name]),
        );
        mockGetTilesInternalMetadata.mockImplementation((item: any) =>
          Promise.resolve(internalByName[item.name]),
        );

        const wrapper = mountComponent();
        const vm = wrapper.vm as any;
        await vm.initialized;
        await nextTick();

        // Record defaults BEFORE applying any strategy.
        const defaultAssignments = extractAssignments(vm);
        const transcodeDefault = vm.transcode;

        // Apply options.
        vm.splitRGBBands = options.splitRGBBands;
        vm.enableCompositing = options.enableCompositing;
        if (options.assignmentStrategy) {
          vm.applyDimensionStrategy(
            buildFullStrategy(vm, options.assignmentStrategy),
          );
          await nextTick();
        }

        mockAddMultiSourceMetadata.mockClear();
        mockUpdateDatasetMetadata.mockClear();

        await vm.generateJson();

        expect(mockAddMultiSourceMetadata).toHaveBeenCalledTimes(1);
        const config = JSON.parse(
          mockAddMultiSourceMetadata.mock.calls[0][0].metadata,
        );
        const dimensionLabels =
          mockUpdateDatasetMetadata.mock.calls[0][1].dimensionLabels;

        const filenameVariables =
          itemNames.length > 1 ? collectFilenameMetadata2(itemNames) : [];

        const actual = {
          filenameVariables,
          defaultAssignments,
          transcodeDefault,
          config,
          dimensionLabels,
        };

        if (UPDATE_GOLDENS) {
          fixture.json.expected = actual;
          writeFixture(fixture.file, fixture.json);
        } else if (fixture.json.expected === null) {
          throw new Error(
            `Golden not generated for ${fixture.file}; ` +
              `run with UPDATE_PARITY_GOLDENS=1`,
          );
        } else {
          expect(actual).toEqual(fixture.json.expected);
        }
      });
    }
  });

  describe("parsing fixtures", () => {
    for (const fixture of parsingFixtures) {
      it(`${fixture.json.name} (${fixture.file})`, () => {
        const variables = collectFilenameMetadata2(
          fixture.json.input.filenames,
        );
        const actual = { variables };

        if (UPDATE_GOLDENS) {
          fixture.json.expected = actual;
          writeFixture(fixture.file, fixture.json);
        } else if (fixture.json.expected === null) {
          throw new Error(
            `Golden not generated for ${fixture.file}; ` +
              `run with UPDATE_PARITY_GOLDENS=1`,
          );
        } else {
          expect(actual).toEqual(fixture.json.expected);
        }
      });
    }
  });
});
