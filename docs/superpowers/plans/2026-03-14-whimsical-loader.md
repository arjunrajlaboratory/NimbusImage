# Whimsical Loader Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all indeterminate progress spinners with fun, science-themed CSS animations via a single `WhimsicalLoader` component.

**Architecture:** One Vue 3 component (`WhimsicalLoader.vue`) with a `size` prop that determines animation selection and dimensions. CSS-only animations (DNA helix, bubbling beaker, Newton's cradle, orbiting atom, tiny atom). Integrates into existing progress system and replaces `v-progress-circular indeterminate` across 7 priority files.

**Tech Stack:** Vue 3 (`<script setup>`, TypeScript), pure CSS animations, Vitest

**Spec:** `docs/superpowers/specs/2026-03-14-whimsical-loader-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/components/WhimsicalLoader.vue` | Component: props, random selection, template dispatching to animation sub-templates, fun text |
| Create | `src/components/__tests__/WhimsicalLoader.test.ts` | Unit tests for prop behavior, size rendering, accessibility |
| Modify | `src/components/ProgressBarGroup.vue` | Use WhimsicalLoader for indeterminate progress items |
| Modify | `src/views/Home.vue` | Replace 128px spinner with WhimsicalLoader lg |
| Modify | `src/views/dataset/Dataset.vue` | Replace 128px spinner with WhimsicalLoader lg |
| Modify | `src/views/project/ProjectInfo.vue` | Replace 64px spinner with WhimsicalLoader lg |
| Modify | `src/components/AnnotationWorkerMenu.vue` | Replace both spinners (md + sm) |
| Modify | `src/components/Snapshots.vue` | Replace spinner with WhimsicalLoader md |
| Modify | `src/components/AnnotationBrowser/AnnotationProperties/Property.vue` | Replace spinner with WhimsicalLoader md |
| Modify | `src/components/ImageViewer.vue` | Replace 18px SAM spinner with WhimsicalLoader sm |

---

## Chunk 1: WhimsicalLoader Component

### Task 1: Create WhimsicalLoader with tiny atom animation (sm)

**Files:**
- Create: `src/components/__tests__/WhimsicalLoader.test.ts`
- Create: `src/components/WhimsicalLoader.vue`

- [ ] **Step 1: Write failing tests for the sm size**

```typescript
// src/components/__tests__/WhimsicalLoader.test.ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import WhimsicalLoader from "@/components/WhimsicalLoader.vue";

describe("WhimsicalLoader", () => {
  describe("sm size", () => {
    it("renders the tiny-atom animation", () => {
      const wrapper = mount(WhimsicalLoader, { props: { size: "sm" } });
      expect(wrapper.find(".whimsical-loader--sm").exists()).toBe(true);
      expect(wrapper.find(".animation-tiny-atom").exists()).toBe(true);
    });

    it("does not render text", () => {
      const wrapper = mount(WhimsicalLoader, { props: { size: "sm" } });
      expect(wrapper.find(".whimsical-loader__text").exists()).toBe(false);
    });

    it("does not render text even with text prop", () => {
      const wrapper = mount(WhimsicalLoader, {
        props: { size: "sm", text: "Loading..." },
      });
      expect(wrapper.find(".whimsical-loader__text").exists()).toBe(false);
    });
  });

  describe("accessibility", () => {
    it("has role=status and aria-label", () => {
      const wrapper = mount(WhimsicalLoader, { props: { size: "sm" } });
      expect(wrapper.attributes("role")).toBe("status");
      expect(wrapper.attributes("aria-label")).toBe("Loading");
    });
  });

  describe("color prop", () => {
    it("applies light color class when color=light", () => {
      const wrapper = mount(WhimsicalLoader, {
        props: { size: "sm", color: "light" },
      });
      expect(wrapper.classes()).toContain("whimsical-loader--color-light");
    });

    it("applies dark color class when color=dark", () => {
      const wrapper = mount(WhimsicalLoader, {
        props: { size: "md", color: "dark" },
      });
      expect(wrapper.classes()).toContain("whimsical-loader--color-dark");
    });

    it("does not apply color class when color=auto", () => {
      const wrapper = mount(WhimsicalLoader, { props: { size: "sm" } });
      expect(wrapper.classes()).not.toContain("whimsical-loader--color-light");
      expect(wrapper.classes()).not.toContain("whimsical-loader--color-dark");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --run src/components/__tests__/WhimsicalLoader.test.ts`
Expected: FAIL — component does not exist yet

- [ ] **Step 3: Create WhimsicalLoader.vue with sm/tiny-atom implementation**

Create `src/components/WhimsicalLoader.vue` with:

```vue
<template>
  <div
    class="whimsical-loader"
    :class="[`whimsical-loader--${size}`, color !== 'auto' && `whimsical-loader--color-${color}`]"
    role="status"
    aria-label="Loading"
  >
    <div class="whimsical-loader__animation" :class="[`animation-${selectedAnimation}`]">
      <!-- Tiny Atom: one nucleus + one orbiting electron -->
      <template v-if="selectedAnimation === 'tiny-atom'">
        <div class="tiny-atom">
          <div class="tiny-atom__nucleus"></div>
          <div class="tiny-atom__orbit">
            <div class="tiny-atom__electron"></div>
          </div>
        </div>
      </template>
    </div>
    <div v-if="displayText" class="whimsical-loader__text">
      {{ displayText }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

const MD_LG_ANIMATIONS = [
  "dna-helix",
  "bubbling-beaker",
  "newtons-cradle",
  "orbiting-atom",
] as const;

const FUN_MESSAGES = [
  "Crunching pixels with extra enthusiasm...",
  "Teaching the computer to see...",
  "Consulting the literature...",
  "Sprinkling some digital magic...",
  "Doing science...",
  "Peer-reviewing your request...",
  "Running the gel... digitally...",
  "Calibrating the microscope...",
];

const props = withDefaults(
  defineProps<{
    size?: "sm" | "md" | "lg";
    text?: string;
    color?: "auto" | "light" | "dark";
  }>(),
  {
    size: "md",
    text: undefined,
    color: "auto",
  },
);

const selectedAnimation = ref(
  props.size === "sm"
    ? "tiny-atom"
    : MD_LG_ANIMATIONS[Math.floor(Math.random() * MD_LG_ANIMATIONS.length)],
);

const randomMessage = ref(
  FUN_MESSAGES[Math.floor(Math.random() * FUN_MESSAGES.length)],
);

const displayText = computed(() => {
  if (props.size === "sm") return null;
  if (props.text !== undefined) return props.text;
  if (props.size === "lg") return randomMessage.value;
  return null;
});
</script>

<style lang="scss" scoped>
.whimsical-loader {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.whimsical-loader--sm {
  .whimsical-loader__animation {
    width: 20px;
    height: 20px;
  }
}

.whimsical-loader--md {
  .whimsical-loader__animation {
    width: 48px;
    height: 48px;
  }
}

.whimsical-loader--lg {
  .whimsical-loader__animation {
    width: 64px;
    height: 64px;
  }
}

.whimsical-loader--color-light {
  color: white;
}

.whimsical-loader--color-dark {
  color: rgba(0, 0, 0, 0.87);
}

.whimsical-loader__text {
  font-size: 0.85rem;
  opacity: 0.85;
  text-align: center;
  max-width: 250px;
}

// --- Tiny Atom Animation ---
.tiny-atom {
  position: relative;
  width: 100%;
  height: 100%;
}

.tiny-atom__nucleus {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 25%;
  height: 25%;
  background: currentColor;
  border-radius: 50%;
  transform: translate(-50%, -50%);
}

.tiny-atom__orbit {
  position: absolute;
  top: 10%;
  left: 10%;
  width: 80%;
  height: 80%;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  opacity: 0.4;
  animation: tiny-atom-spin 1.5s linear infinite;
}

.tiny-atom__electron {
  position: absolute;
  top: -3px;
  left: 50%;
  width: 20%;
  height: 20%;
  background: currentColor;
  border-radius: 50%;
  transform: translateX(-50%);
}

@keyframes tiny-atom-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

// --- Reduced motion ---
@media (prefers-reduced-motion: reduce) {
  .tiny-atom__orbit {
    animation: none;
  }

  .tiny-atom__nucleus {
    animation: pulse-reduced 1.5s ease-in-out infinite;
  }
}

@keyframes pulse-reduced {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
</style>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --run src/components/__tests__/WhimsicalLoader.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/WhimsicalLoader.vue src/components/__tests__/WhimsicalLoader.test.ts
git commit -m "feat: add WhimsicalLoader component with tiny atom animation (sm size)"
```

---

### Task 2: Add md/lg animations (DNA helix, bubbling beaker, Newton's cradle, orbiting atom)

**Files:**
- Modify: `src/components/__tests__/WhimsicalLoader.test.ts`
- Modify: `src/components/WhimsicalLoader.vue`

- [ ] **Step 1: Write failing tests for md and lg sizes**

Add to the test file:

```typescript
describe("md size", () => {
  it("renders at md size with an animation from the full set", () => {
    const wrapper = mount(WhimsicalLoader, { props: { size: "md" } });
    expect(wrapper.find(".whimsical-loader--md").exists()).toBe(true);
    const animDiv = wrapper.find(".whimsical-loader__animation");
    // Should have one of the md/lg animation classes
    const validAnimations = [
      "animation-dna-helix",
      "animation-bubbling-beaker",
      "animation-newtons-cradle",
      "animation-orbiting-atom",
    ];
    const hasValidAnimation = validAnimations.some((cls) =>
      animDiv.classes().includes(cls),
    );
    expect(hasValidAnimation).toBe(true);
  });

  it("does not render text by default", () => {
    const wrapper = mount(WhimsicalLoader, { props: { size: "md" } });
    expect(wrapper.find(".whimsical-loader__text").exists()).toBe(false);
  });

  it("renders text when text prop is provided", () => {
    const wrapper = mount(WhimsicalLoader, {
      props: { size: "md", text: "Processing..." },
    });
    expect(wrapper.find(".whimsical-loader__text").text()).toBe(
      "Processing...",
    );
  });
});

describe("lg size", () => {
  it("renders at lg size with a fun message", () => {
    const wrapper = mount(WhimsicalLoader, { props: { size: "lg" } });
    expect(wrapper.find(".whimsical-loader--lg").exists()).toBe(true);
    expect(wrapper.find(".whimsical-loader__text").exists()).toBe(true);
    // Text should be non-empty (one of the fun messages)
    expect(wrapper.find(".whimsical-loader__text").text().length).toBeGreaterThan(0);
  });

  it("uses text prop over random message when provided", () => {
    const wrapper = mount(WhimsicalLoader, {
      props: { size: "lg", text: "Custom loading text" },
    });
    expect(wrapper.find(".whimsical-loader__text").text()).toBe(
      "Custom loading text",
    );
  });
});

describe("default size", () => {
  it("defaults to md when no size prop", () => {
    const wrapper = mount(WhimsicalLoader);
    expect(wrapper.find(".whimsical-loader--md").exists()).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `pnpm test -- --run src/components/__tests__/WhimsicalLoader.test.ts`
Expected: New md/lg tests FAIL (animation templates not yet rendered)

- [ ] **Step 3: Add the four md/lg animation templates and CSS**

Add to the `<template>` section of `WhimsicalLoader.vue`, after the tiny-atom template:

```vue
<!-- DNA Helix: two strands of dots twisting -->
<template v-else-if="selectedAnimation === 'dna-helix'">
  <div class="dna-helix">
    <div v-for="i in 8" :key="i" class="dna-helix__pair" :style="{ animationDelay: `${(i - 1) * -0.3}s` }">
      <div class="dna-helix__dot dna-helix__dot--left"></div>
      <div class="dna-helix__bar"></div>
      <div class="dna-helix__dot dna-helix__dot--right"></div>
    </div>
  </div>
</template>

<!-- Bubbling Beaker: flask outline with rising bubbles -->
<template v-else-if="selectedAnimation === 'bubbling-beaker'">
  <div class="beaker">
    <div class="beaker__body">
      <div class="beaker__liquid">
        <div v-for="i in 4" :key="i" class="beaker__bubble" :style="{ animationDelay: `${(i - 1) * 0.7}s`, left: `${15 + (i * 17)}%` }"></div>
      </div>
    </div>
    <div class="beaker__neck"></div>
  </div>
</template>

<!-- Newton's Cradle: swinging balls -->
<template v-else-if="selectedAnimation === 'newtons-cradle'">
  <div class="cradle">
    <div v-for="i in 5" :key="i" class="cradle__arm" :class="{ 'cradle__arm--left': i === 1, 'cradle__arm--right': i === 5 }">
      <div class="cradle__ball"></div>
    </div>
  </div>
</template>

<!-- Orbiting Atom: nucleus with electron orbits -->
<template v-else-if="selectedAnimation === 'orbiting-atom'">
  <div class="atom">
    <div class="atom__nucleus"></div>
    <div class="atom__orbit atom__orbit--1">
      <div class="atom__electron"></div>
    </div>
    <div class="atom__orbit atom__orbit--2">
      <div class="atom__electron"></div>
    </div>
    <div class="atom__orbit atom__orbit--3">
      <div class="atom__electron"></div>
    </div>
  </div>
</template>
```

Add to the `<style>` section:

```scss
// --- DNA Helix Animation ---
.dna-helix {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 2px;
  width: 100%;
  height: 100%;
}

.dna-helix__pair {
  display: flex;
  align-items: center;
  gap: 1px;
  animation: dna-twist 2.5s ease-in-out infinite;
}

.dna-helix__dot {
  width: 15%;
  height: 0;
  padding-bottom: 15%;
  background: currentColor;
  border-radius: 50%;
  flex-shrink: 0;
}

.dna-helix__bar {
  height: 1.5px;
  background: currentColor;
  opacity: 0.3;
  flex-grow: 1;
}

@keyframes dna-twist {
  0%, 100% { transform: scaleX(1); }
  25% { transform: scaleX(0.3); }
  50% { transform: scaleX(1); }
  75% { transform: scaleX(0.3); }
}

// --- Bubbling Beaker Animation ---
.beaker {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
}

.beaker__body {
  width: 70%;
  height: 60%;
  border: 2px solid currentColor;
  border-top: none;
  border-radius: 0 0 15% 15%;
  position: relative;
  overflow: hidden;
}

.beaker__liquid {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 65%;
  background: currentColor;
  opacity: 0.2;
}

.beaker__bubble {
  position: absolute;
  bottom: 0;
  width: 15%;
  padding-bottom: 15%;
  background: currentColor;
  border-radius: 50%;
  opacity: 0.5;
  animation: bubble-rise 3s ease-in infinite;
}

.beaker__neck {
  width: 45%;
  height: 12%;
  border: 2px solid currentColor;
  border-bottom: none;
  border-radius: 2px 2px 0 0;
}

@keyframes bubble-rise {
  0% { transform: translateY(0) scale(0.5); opacity: 0; }
  10% { opacity: 0.5; }
  80% { opacity: 0.3; }
  100% { transform: translateY(-200%) scale(1); opacity: 0; }
}

// --- Newton's Cradle Animation ---
.cradle {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 0;
  width: 100%;
  height: 100%;
  padding-top: 15%;
}

.cradle__arm {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 14%;
  transform-origin: top center;

  &::before {
    content: "";
    width: 1.5px;
    height: 55%;
    background: currentColor;
    opacity: 0.4;
    display: block;
  }
}

.cradle__ball {
  width: 100%;
  padding-bottom: 100%;
  background: currentColor;
  border-radius: 50%;
}

.cradle__arm--left {
  animation: cradle-left 2s ease-in-out infinite;
}

.cradle__arm--right {
  animation: cradle-right 2s ease-in-out infinite;
}

@keyframes cradle-left {
  0% { transform: rotate(0deg); }
  25% { transform: rotate(-30deg); }
  50% { transform: rotate(0deg); }
  100% { transform: rotate(0deg); }
}

@keyframes cradle-right {
  0% { transform: rotate(0deg); }
  50% { transform: rotate(0deg); }
  75% { transform: rotate(30deg); }
  100% { transform: rotate(0deg); }
}

// --- Orbiting Atom Animation ---
.atom {
  position: relative;
  width: 100%;
  height: 100%;
}

.atom__nucleus {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 18%;
  height: 18%;
  background: currentColor;
  border-radius: 50%;
  transform: translate(-50%, -50%);
}

.atom__orbit {
  position: absolute;
  top: 10%;
  left: 10%;
  width: 80%;
  height: 80%;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  opacity: 0.3;
}

.atom__orbit--1 {
  animation: atom-spin 2s linear infinite;
}

.atom__orbit--2 {
  transform: rotate(60deg);
  animation: atom-spin-2 2s linear infinite;
}

.atom__orbit--3 {
  transform: rotate(120deg);
  animation: atom-spin-3 2s linear infinite;
}

.atom__electron {
  position: absolute;
  top: -4px;
  left: 50%;
  width: 14%;
  height: 14%;
  background: currentColor;
  border-radius: 50%;
  transform: translateX(-50%);
}

@keyframes atom-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes atom-spin-2 {
  from { transform: rotate(60deg); }
  to { transform: rotate(420deg); }
}

@keyframes atom-spin-3 {
  from { transform: rotate(120deg); }
  to { transform: rotate(480deg); }
}

// --- Reduced motion for all ---
@media (prefers-reduced-motion: reduce) {
  .dna-helix__pair,
  .beaker__bubble,
  .cradle__arm--left,
  .cradle__arm--right,
  .atom__orbit--1,
  .atom__orbit--2,
  .atom__orbit--3,
  .tiny-atom__orbit {
    animation: none;
  }

  // Hide detail elements, show a single pulsing dot for all animations
  .dna-helix__bar,
  .beaker__neck,
  .beaker__liquid,
  .atom__orbit,
  .cradle__arm::before {
    opacity: 0;
  }

  // Hide all but one dot/ball in multi-element animations
  .dna-helix__pair:not(:nth-child(4)),
  .cradle__arm:not(:nth-child(3)) {
    visibility: hidden;
  }

  // Pulse the remaining visible element
  .atom__nucleus,
  .tiny-atom__nucleus,
  .dna-helix__pair:nth-child(4) .dna-helix__dot--left,
  .beaker__body,
  .cradle__arm:nth-child(3) .cradle__ball {
    animation: pulse-reduced 1.5s ease-in-out infinite;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --run src/components/__tests__/WhimsicalLoader.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/WhimsicalLoader.vue src/components/__tests__/WhimsicalLoader.test.ts
git commit -m "feat: add DNA helix, bubbling beaker, Newton's cradle, orbiting atom animations"
```

---

## Chunk 2: Integration into ProgressBarGroup and Priority Replacements

### Task 3: Integrate WhimsicalLoader into ProgressBarGroup

**Files:**
- Modify: `src/components/ProgressBarGroup.vue`

- [ ] **Step 1: Add WhimsicalLoader import and replace indeterminate progress bars**

In `ProgressBarGroup.vue`, add the import:

```typescript
import WhimsicalLoader from "@/components/WhimsicalLoader.vue";
```

Replace the single-display template (lines 34-51) with:

```vue
<template v-if="group.display === 'single'">
  <!-- Indeterminate: show whimsical animation + title -->
  <div v-if="group.indeterminate" class="indeterminate-group">
    <WhimsicalLoader size="md" color="light" />
    <div class="indeterminate-info">
      <strong>{{ group.title }}</strong>
      <template v-if="group.count > 1">
        <span class="remaining-count">({{ group.count }} remaining)</span>
      </template>
    </div>
  </div>
  <!-- Determinate: show progress bar as before -->
  <v-progress-linear
    v-else
    :model-value="group.value"
    color="primary"
    height="16"
  >
    <strong>
      {{ group.title }}
      <template v-if="group.total !== undefined">
        ({{ group.progress }}/{{ group.total }})
      </template>
      <template v-if="group.count > 1">
        ({{ group.count }} remaining)
      </template>
    </strong>
  </v-progress-linear>
</template>
```

Replace the stacked-progress template (lines 54-75) — for indeterminate items in stacked display, show WhimsicalLoader inline:

```vue
<template v-else>
  <div class="stacked-progress">
    <template v-for="progress in group.items" :key="progress.id">
      <!-- Indeterminate item in stack -->
      <div v-if="progress.total === 0" class="indeterminate-group indeterminate-group--stacked">
        <WhimsicalLoader size="sm" color="light" />
        <strong class="caption">{{ progress.title }}</strong>
      </div>
      <!-- Determinate item in stack -->
      <v-progress-linear
        v-else
        :model-value="(100 * progress.progress) / progress.total"
        color="primary"
        height="10"
        class="mb-1"
      >
        <strong class="caption">
          {{ progress.title }}
          ({{ progress.progress }}/{{ progress.total }})
        </strong>
      </v-progress-linear>
    </template>
  </div>
</template>
```

Add styles for the indeterminate layout:

```scss
.indeterminate-group {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 8px;
  min-height: 32px;
}

.indeterminate-group--stacked {
  gap: 8px;
  min-height: 24px;
  font-size: 0.7rem;
}

.indeterminate-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 0.75rem;
}

.remaining-count {
  opacity: 0.7;
  font-size: 0.7rem;
}
```

- [ ] **Step 2: Run type check and full test suite**

Run: `pnpm tsc && pnpm test -- --run`
Expected: No type errors, all tests pass

- [ ] **Step 3: Commit**

```bash
git add src/components/ProgressBarGroup.vue
git commit -m "feat: use WhimsicalLoader for indeterminate progress in ProgressBarGroup"
```

---

### Task 4: Replace large overlay spinners (Home, Dataset, ProjectInfo)

**Files:**
- Modify: `src/views/Home.vue`
- Modify: `src/views/dataset/Dataset.vue`
- Modify: `src/views/project/ProjectInfo.vue`

- [ ] **Step 1: Replace spinner in Home.vue**

Find the `v-progress-circular` in the loading overlay and replace with:

```vue
<WhimsicalLoader size="lg" text="Loading dataset information..." class="mb-4" />
```

Remove the `<div class="loading-text">Loading dataset information...</div>` line (text is now handled by the component).

Add import: `import WhimsicalLoader from "@/components/WhimsicalLoader.vue";`

- [ ] **Step 2: Replace spinner in Dataset.vue**

Same pattern as Home.vue — replace `v-progress-circular` and loading-text div with:

```vue
<WhimsicalLoader size="lg" text="Loading dataset information..." class="mb-4" />
```

Add import.

- [ ] **Step 3: Replace spinner in ProjectInfo.vue**

Replace `v-progress-circular` and `<div class="mt-4 text-body-1">Loading project...</div>` with:

```vue
<WhimsicalLoader size="lg" text="Loading project..." />
```

Add import.

- [ ] **Step 4: Run type check**

Run: `pnpm tsc`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/views/Home.vue src/views/dataset/Dataset.vue src/views/project/ProjectInfo.vue
git commit -m "feat: replace large overlay spinners with WhimsicalLoader"
```

---

### Task 5: Replace medium and small spinners

**Files:**
- Modify: `src/components/AnnotationWorkerMenu.vue`
- Modify: `src/components/Snapshots.vue`
- Modify: `src/components/AnnotationBrowser/AnnotationProperties/Property.vue`
- Modify: `src/components/ImageViewer.vue`

- [ ] **Step 1: Replace spinners in AnnotationWorkerMenu.vue**

Add import: `import WhimsicalLoader from "@/components/WhimsicalLoader.vue";`

Line 39 — replace `<v-progress-circular indeterminate />` with:
```vue
<WhimsicalLoader size="md" />
```

Line 106 — replace `<v-progress-circular size="16" indeterminate />` with:
```vue
<WhimsicalLoader size="sm" />
```

- [ ] **Step 2: Replace spinner in Snapshots.vue**

Add import and replace `<v-progress-circular v-if="downloading" indeterminate />` with:
```vue
<WhimsicalLoader v-if="downloading" size="md" />
```

- [ ] **Step 3: Replace spinner in Property.vue**

Add import and replace `<v-progress-circular indeterminate />` with:
```vue
<WhimsicalLoader size="md" />
```

- [ ] **Step 4: Replace spinner in ImageViewer.vue**

Add import and replace `<v-progress-circular indeterminate size="18" width="2" color="white" />` with:
```vue
<WhimsicalLoader size="sm" color="light" />
```

- [ ] **Step 5: Run type check and full test suite**

Run: `pnpm tsc && pnpm test -- --run`
Expected: No errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/components/AnnotationWorkerMenu.vue src/components/Snapshots.vue src/components/AnnotationBrowser/AnnotationProperties/Property.vue src/components/ImageViewer.vue
git commit -m "feat: replace medium and small spinners with WhimsicalLoader"
```

---

## Chunk 3: Polish and Verify

### Task 6: Visual verification and animation tuning

- [ ] **Step 1: Start the dev server**

Run: `pnpm run dev`

- [ ] **Step 2: Manually verify each integration point**

Check in browser at `http://localhost:5173`:
1. Navigate to home page — should see whimsical animation during dataset loading
2. Open a dataset — verify loading overlay uses whimsical animation
3. Open project info — verify loading spinner
4. Open a worker tool — verify md animation while fetching interface, sm atom in cancel button
5. Trigger an indeterminate progress (e.g., fetch annotations) — verify ProgressBarGroup shows animation + title, then transitions to progress bar when determinate

- [ ] **Step 3: Tune animations if needed**

Adjust CSS timing, sizes, or colors based on how they look in context. Common adjustments:
- Animation speed (too fast/slow)
- Dot/element sizes relative to container
- Color opacity on dark backgrounds
- Gap between animation and text

- [ ] **Step 4: Run full test suite one final time**

Run: `pnpm tsc && pnpm test -- --run`
Expected: All pass

- [ ] **Step 5: Final commit if any tuning was done**

```bash
git add src/components/WhimsicalLoader.vue src/components/ProgressBarGroup.vue
git commit -m "fix: tune whimsical loader animations after visual review"
```
