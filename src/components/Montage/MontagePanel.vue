<template>
  <div
    ref="root"
    class="montage-panel"
    :class="{ selected, hovered }"
    :style="{ width: `${size}px`, height: `${size}px` }"
    :title="error ?? undefined"
    @click="emit('toggle-select')"
    @mouseenter="emit('hover', true)"
    @mouseleave="emit('hover', false)"
  >
    <!-- 0×0 until visible (a canvas otherwise defaults to 300×150). -->
    <canvas ref="canvas" class="montage-canvas" width="0" height="0" />
    <v-icon v-if="error" class="montage-panel-error" size="18" color="warning">
      mdi-alert-circle-outline
    </v-icon>
    <!-- A button rather than double-click: a double-click also fires two
         clicks, which would toggle the selection off and on first. -->
    <v-btn
      class="montage-panel-goto"
      variant="flat"
      icon
      size="x-small"
      aria-label="Go to object"
      title="Go to this object in the image"
      @click.stop="emit('navigate')"
    >
      <v-icon size="16">mdi-crosshairs-gps</v-icon>
    </v-btn>
  </div>
</template>

<script setup lang="ts">
import {
  computed,
  ref,
  shallowRef,
  watch,
  onMounted,
  onBeforeUnmount,
} from "vue";
import {
  drawMontagePanel,
  IImageRect,
  IMontageCrop,
  IMontagePanelContent,
  MontageCropError,
  StaleCropError,
} from "@/utils/montage";
import {
  IMontageImageRequest,
  MontageAbortError,
  MontageImageLoader,
} from "@/utils/montageImageLoader";
import { logError } from "@/utils/log";

const props = defineProps<{
  content: Omit<IMontagePanelContent, "image" | "imageRect">;
  // Identifies the crop to show; null while its inputs are settling (the
  // current image stays up meanwhile).
  cropKey: string | null;
  loadCrop: (key: string) => Promise<IMontageCrop>;
  size: number;
  pixelRatio: number;
  loader: MontageImageLoader;
  selected: boolean;
  hovered: boolean;
}>();

const emit = defineEmits<{
  (e: "toggle-select"): void;
  (e: "navigate"): void;
  (e: "hover", entered: boolean): void;
}>();

const root = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
// The image is kept with the rect it was fetched for: the content's window
// can move on before the replacement crop arrives, and drawing the old image
// at its own rect keeps it aligned with the image coordinates meanwhile.
const loaded = shallowRef<{ image: ImageBitmap; imageRect: IImageRect } | null>(
  null,
);
const error = ref<string | null>(null);
// Crops are built and fetched only once the panel scrolls into view.
const isVisible = ref(false);
const isLoaded = computed(() => loaded.value !== null);

// The key being shown or loaded, the request keeping its image alive, and
// the one still loading. The loading one is released whenever the panel moves
// on, so the loader can drop it before it starts (fast paging/scrolling).
let activeKey: string | null = null;
let held: IMontageImageRequest | null = null;
let pending: IMontageImageRequest | null = null;

function releasePending() {
  pending?.release();
  pending = null;
}
let observer: IntersectionObserver | null = null;

async function show(key: string) {
  activeKey = key;
  releasePending();
  try {
    const crop = await props.loadCrop(key);
    if (activeKey !== key) return;
    const request = props.loader.load(crop.url);
    pending = request;
    const image = await request.promise;
    if (activeKey !== key) return;
    pending = null;
    // Swap only now, so the old crop stays up until the new one is ready.
    held?.release();
    held = request;
    error.value = null;
    loaded.value = { image, imageRect: crop.imageRect };
  } catch (err) {
    if (
      activeKey !== key ||
      err instanceof MontageAbortError ||
      err instanceof StaleCropError
    ) {
      return;
    }
    // Build errors (outside the image, no plane for a layer) are expected.
    if (!(err instanceof MontageCropError)) {
      logError("Montage crop failed to load", err);
    }
    error.value = err instanceof Error ? err.message : String(err);
    releasePending();
    held?.release();
    held = null;
    loaded.value = null;
    // Retry when the key changes or the panel re-enters view.
    activeKey = null;
  }
}

// Off screen (beyond the observer margin) a panel holds nothing: no canvas
// backing store and no decoded image. At 320px on a 2× display each is
// ~1.6MB, so a 200-object page would otherwise hold hundreds of MB. The image
// usually comes back from the loader's cache when the panel returns.
function release() {
  activeKey = null;
  releasePending();
  held?.release();
  held = null;
  loaded.value = null;
  if (canvas.value) {
    canvas.value.width = 0;
    canvas.value.height = 0;
  }
}

watch(
  () => [isVisible.value, props.cropKey] as const,
  ([visible, key]) => {
    if (!visible) {
      release();
    } else if (key && key !== activeKey) {
      show(key);
    }
  },
);

function draw() {
  const el = canvas.value;
  if (!el || !isVisible.value) {
    return;
  }
  const devicePixels = Math.round(props.size * props.pixelRatio);
  if (el.width !== devicePixels || el.height !== devicePixels) {
    el.width = devicePixels;
    el.height = devicePixels;
  }
  const ctx = el.getContext("2d");
  if (!ctx) {
    return;
  }
  drawMontagePanel(
    ctx,
    0,
    0,
    devicePixels,
    {
      ...props.content,
      image: loaded.value?.image ?? null,
      imageRect: loaded.value?.imageRect ?? null,
    },
    props.pixelRatio,
  );
}

watch(
  () => [
    props.content,
    props.size,
    props.pixelRatio,
    loaded.value,
    isVisible.value,
  ],
  draw,
  { flush: "post" },
);

onMounted(() => {
  draw();
  if (typeof IntersectionObserver === "undefined") {
    isVisible.value = true;
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      isVisible.value = entries.some((entry) => entry.isIntersecting);
    },
    // Observe within the scrolling grid (the panel's parent), not the
    // viewport: the grid clips, so a viewport margin would never pre-load the
    // next row. Start loading a little before a panel scrolls in.
    { root: root.value?.parentElement ?? null, rootMargin: "200px" },
  );
  if (root.value) {
    observer.observe(root.value);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  release();
});

defineExpose({ isVisible, isLoaded, error, loaded });
</script>

<style lang="scss" scoped>
.montage-panel {
  position: relative;
  cursor: pointer;
  outline: 2px solid transparent;
  outline-offset: 1px;

  &.hovered {
    outline-color: rgba(var(--v-theme-on-surface), 0.5);
  }

  &.selected {
    outline-color: rgb(var(--v-theme-primary));
  }

  &:hover .montage-panel-goto {
    opacity: 1;
  }
}

.montage-canvas {
  display: block;
  // Shown while a panel's canvas is unallocated (off screen) or loading.
  background: #000;
  width: 100%;
  height: 100%;
}

.montage-panel-error {
  position: absolute;
  top: 4px;
  right: 4px;
}

.montage-panel-goto {
  position: absolute;
  bottom: 4px;
  right: 4px;
  opacity: 0;
  transition: opacity 0.1s;

  &:focus-visible {
    opacity: 1;
  }
}
</style>
