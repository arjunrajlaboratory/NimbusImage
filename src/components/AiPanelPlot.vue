<template>
  <div v-if="plot && !renderFailed" ref="plotEl" class="plot-container"></div>
  <div v-else class="plot-missing">
    This plot wasn't saved — ask the assistant to recreate it.
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { useTheme } from "vuetify";
import { getPlot } from "@/agent/plotRegistry";
import { logError } from "@/utils/log";

const props = defineProps<{
  plotId: string;
}>();

const theme = useTheme();
const plotEl = ref<HTMLElement>();
const renderFailed = ref(false);

// Registry entries are immutable, so a single lookup suffices: the plot is
// rendered once on mount and never re-rendered. A missing entry (pruned from
// persistence) falls through to the placeholder.
const plot = getPlot(props.plotId);

// Loaded lazily so plotly.js-dist-min never lands in the main bundle.
let PlotlyModule: any = null;

onMounted(async () => {
  if (!plot || !plotEl.value) {
    return;
  }
  try {
    const module = await import("plotly.js-dist-min");
    PlotlyModule = module.default ?? module; // CJS interop
    await PlotlyModule.newPlot(
      plotEl.value,
      plot.data,
      {
        autosize: true,
        height: 300,
        margin: { l: 56, r: 16, t: 36, b: 44 },
        paper_bgcolor: "transparent",
        plot_bgcolor: "transparent",
        font: {
          color: theme.current.value.colors["on-surface"],
          size: 11,
        },
        ...plot.layout,
      },
      { responsive: true, displaylogo: false },
    );
  } catch (error) {
    // A broken plot must never crash the transcript; show the placeholder.
    logError("Failed to render AI panel plot:", error);
    renderFailed.value = true;
  }
});

onBeforeUnmount(() => {
  if (PlotlyModule && plotEl.value) {
    PlotlyModule.purge(plotEl.value);
  }
});
</script>

<style scoped>
.plot-container {
  width: 100%;
  height: 300px;
}

/* Same muted look as AiPanel.vue's .info items */
.plot-missing {
  text-align: center;
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.65);
  background-color: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 6px 12px;
  margin: 2px 0;
}
</style>
