<template>
  <router-view></router-view>
</template>
<script setup lang="ts">
import store from "@/store";
import { TLayerMode } from "@/store/model";
import { useRouteMapper } from "@/utils/useRouteMapper";

useRouteMapper(
  {
    datasetViewId: {
      parse: String,
      get: () => store.datasetView?.id || null,
      set: (value: string) => store.setDatasetViewId(value),
    },
  },
  {
    xy: {
      parse: (v: string) => parseInt(v, 10),
      get: () => store.xy,
      set: (value: number) => store.setXY(value || 0),
    },
    unrollXY: {
      parse: (v: string) => v === "true",
      get: () => store.unrollXY,
      set: (value: boolean) => store.setUnrollXY(value),
    },
    z: {
      parse: (v: string) => parseInt(v, 10),
      get: () => store.z,
      set: (value: number) => store.setZ(value || 0),
    },
    unrollZ: {
      parse: (v: string) => v === "true",
      get: () => store.unrollZ,
      set: (value: boolean) => store.setUnrollZ(value),
    },
    time: {
      parse: (v: string) => parseInt(v, 10),
      get: () => store.time,
      set: (value: number) => store.setTime(value || 0),
    },
    unrollT: {
      parse: (v: string) => v === "true",
      get: () => store.unrollT,
      set: (value: boolean) => store.setUnrollT(value),
    },
    layer: {
      parse: (v: string) => v,
      get: () => store.layerMode,
      set: (value: TLayerMode) =>
        store.setLayerMode(
          ["single", "multiple", "unroll"].indexOf(value) >= 0
            ? value
            : "multiple",
        ),
    },
  },
);
</script>
