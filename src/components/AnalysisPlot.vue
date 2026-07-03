<template>
  <div class="analysis-plot">
    <div ref="plotEl" class="analysis-plot-el"></div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useTheme } from "vuetify";
import { logError } from "@/utils/log";
import { IAnalysisPlot } from "@/store/AnalysisAPI";

const props = defineProps<{
  plot: IAnalysisPlot;
}>();

const theme = useTheme();
const plotEl = ref<HTMLElement>();

// Loaded lazily so plotly.js-dist-min never lands in the main bundle.
let PlotlyModule: any = null;

function buildLayout(): Record<string, unknown> {
  const fontColor = theme.current.value.colors["on-surface"];
  return {
    autosize: true,
    height: 380,
    margin: { l: 56, r: 24, t: 40, b: 48 },
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    font: { color: fontColor },
    ...props.plot.layout,
  };
}

async function renderPlot() {
  const el = plotEl.value;
  if (!el) {
    return;
  }
  try {
    if (!PlotlyModule) {
      const module = await import("plotly.js-dist-min");
      // plotly.js-dist-min is a CJS bundle; depending on interop the API
      // is either the namespace itself or its default export.
      PlotlyModule = module.default ?? module;
    }
    await PlotlyModule.newPlot(el, props.plot.data, buildLayout(), {
      responsive: true,
      displaylogo: false,
    });
  } catch (error) {
    logError("Failed to render analysis plot", error);
  }
}

watch(
  () => props.plot,
  () => {
    renderPlot();
  },
  { deep: true },
);

onMounted(() => {
  renderPlot();
});

onBeforeUnmount(() => {
  if (PlotlyModule && plotEl.value) {
    PlotlyModule.purge(plotEl.value);
  }
});
</script>

<style scoped>
.analysis-plot {
  width: 100%;
}

.analysis-plot-el {
  width: 100%;
  height: 380px;
}
</style>
