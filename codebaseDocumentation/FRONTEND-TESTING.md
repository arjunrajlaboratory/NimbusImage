# Frontend Testing Infrastructure

## Overview

This document describes the frontend testing setup for NimbusImage, focusing on Vuex store testing patterns established for the annotation store.

## Test Framework

- **Vitest**: Test runner (configured in `vitest.config.js`)
- **Test command**: `pnpm test` (runs in watch mode) or `npx vitest run` (single run)

## Test File Locations

```
src/
├── store/
│   └── __tests__/
│       ├── testUtils.ts      # Mock factories and helpers
│       └── annotation.test.ts # Annotation store tests (59 tests)
└── utils/
    └── parsing.test.ts       # Existing parsing tests (3 tests)
```

## Testing Vuex-Module-Decorators Stores

The stores use `vuex-module-decorators` which requires special mocking. Key pattern:

### 1. Use `vi.hoisted()` for Mock Objects

Vitest hoists `vi.mock()` calls to the top of files. To reference mock objects within mocks, use `vi.hoisted()`:

```typescript
const { mockAnnotationsAPI, mockMainStore } = vi.hoisted(() => {
  const mockAnnotationsAPI = {
    createAnnotation: vi.fn().mockResolvedValue(null),
    // ... other methods
  };

  const mockMainStore = {
    dataset: null,
    isLoggedIn: true,
    // ... other properties
  };

  return { mockAnnotationsAPI, mockMainStore };
});

// Now these can be used in vi.mock() calls
vi.mock("../index", () => ({ default: mockMainStore }));
```

### 2. Mock vuex-module-decorators

Replace decorators with no-ops and VuexModule with a simple class:

```typescript
vi.mock("vuex-module-decorators", () => ({
  Module: () => (target: any) => target,
  Mutation: () => (_target: any, _key: string) => {},
  Action: () => (_target: any, _key: string) => {},
  VuexModule: class VuexModule {
    context = { dispatch: vi.fn() };
  },
  getModule: (ModuleClass: any) => new ModuleClass({}),
}));
```

### 3. Mock Vue.set

For reactive updates in mutations:

```typescript
vi.mock("vue", () => ({
  default: {
    set: (obj: any, key: string, value: any) => { obj[key] = value; },
  },
  markRaw: (obj: any) => obj,
}));
```

## Test Utilities (`src/store/__tests__/testUtils.ts`)

### Mock Factories

```typescript
// Create mock annotation with optional overrides
createMockAnnotation({ id: "custom-id", tags: ["tag1"] })

// Create multiple annotations
createMockAnnotations(5) // Creates 5 annotations with IDs annotation-1 through annotation-5

// Create mock connection
createMockConnection({ parentId: "p1", childId: "c1" })

// Create mock API
createMockAnnotationsAPI() // Returns object with all API methods as vi.fn()

// Create mock stores
createMockMainStore({ isLoggedIn: false })
createMockSyncStore()
createMockProgressStore()
```

### ID Counter

```typescript
resetIdCounter() // Call in beforeEach to ensure consistent IDs
generateId()     // Returns "test-id-1", "test-id-2", etc.
```

## Writing Store Tests

### Basic Pattern

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockAnnotation, resetIdCounter } from "./testUtils";
import { Annotations } from "../annotation";

describe("annotation store", () => {
  let store: Annotations;

  beforeEach(() => {
    vi.clearAllMocks();
    resetIdCounter();

    // Reset mock state
    mockMainStore.isLoggedIn = true;
    mockMainStore.dataset = null;

    // Create fresh store instance
    store = new Annotations({});
    store.annotationsAPI = mockAnnotationsAPI;
  });

  it("example test", () => {
    const annotation = createMockAnnotation();
    store.setAnnotations([annotation]);
    expect(store.annotations).toHaveLength(1);
  });
});
```

### Testing Mutations

Mutations can be called directly:

```typescript
it("setSelected replaces selection", () => {
  const annotations = createMockAnnotations(3);
  store.setSelected(annotations);
  expect(store.selectedAnnotations).toEqual(annotations);
});
```

### Testing Actions

Actions are async and may call APIs:

```typescript
it("deleteAnnotations calls API and updates state", async () => {
  mockMainStore.isLoggedIn = true;
  const annotations = createMockAnnotations(3);
  store.setAnnotations(annotations);

  await store.deleteAnnotations([annotations[0].id]);

  expect(mockAnnotationsAPI.deleteMultipleAnnotations).toHaveBeenCalledWith(
    [annotations[0].id]
  );
  expect(store.annotations).toHaveLength(2);
});
```

### Handling Non-Awaited Async Calls

Some actions call other async actions without awaiting:

```typescript
// deleteSelectedAnnotations doesn't await deleteAnnotations
it("deletes selected annotations", async () => {
  const ids = store.selectedAnnotationIds;
  store.deleteSelectedAnnotations();

  // Wait for microtask queue
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(mockAnnotationsAPI.deleteMultipleAnnotations).toHaveBeenCalledWith(ids);
});
```

### Avoiding Array Mutation Issues

Some mutations use `splice` which modifies arrays in place:

```typescript
// BAD - annotations array gets mutated
store.setSelected(annotations);
store.unselectAnnotation(annotations[1]); // annotations array modified!

// GOOD - use spread to avoid mutation
store.setSelected([...annotations]);
store.unselectAnnotation(annotations[1]); // original array unchanged
```

## Test Coverage

### Annotation Store Tests (59 total)

| Category | Tests | Description |
|----------|-------|-------------|
| Selection | 13 | setSelected, selectAnnotation, unselectAnnotation, toggleSelected |
| Copy/Paste | 5 | copySelectedAnnotations, pasteAnnotations |
| CRUD | 10 | createMultipleAnnotations, deleteAnnotations, deleteSelectedAnnotations |
| Tags | 6 | addTagsByAnnotationIds, removeTagsByAnnotationIds, replaceTagsByAnnotationIds |
| Fetching | 5 | fetchAnnotations with various scenarios |
| setAnnotations | 3 | Building centroids and index maps |
| Getters | 5 | getAnnotationFromId, annotationTags |
| Connections | 2 | setConnections, addMultipleConnections |
| Active | 5 | activateAnnotations, deactivateAnnotations, toggleActiveAnnotations |
| Hover | 2 | setHoveredAnnotationId |
| Color | 3 | colorAnnotationIds, colorSelectedAnnotations |

## Running Tests

```bash
# Run all tests in watch mode
pnpm test

# Run all tests once
npx vitest run

# Run specific test file
npx vitest run src/store/__tests__/annotation.test.ts

# Run with coverage
npx vitest run --coverage
```

## Adding New Store Tests

1. Add mock factories to `testUtils.ts` if needed
2. Create test file in `src/store/__tests__/`
3. Follow the mocking pattern for vuex-module-decorators
4. Mock all imported store dependencies
5. Use `beforeEach` to reset state between tests

## Known Limitations

1. **Decorator behavior**: Tests bypass actual Vuex behavior, testing method logic directly
2. **Action chaining**: Non-awaited action calls require manual promise handling
3. **Reactivity**: Vue reactivity is mocked, not fully tested
4. **Context**: `this.context.dispatch` is mocked, cross-module dispatches not tested

## Future Improvements

- [ ] Add component tests with Vue Test Utils
- [ ] Add E2E tests with Playwright
- [ ] Test cross-store interactions
- [ ] Add snapshot tests for complex state
