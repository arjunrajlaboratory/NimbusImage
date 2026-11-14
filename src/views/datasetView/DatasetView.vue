<template>
  <router-view></router-view>
</template>
<script setup lang="ts">
import store from "@/store";
import { TLayerMode } from "@/store/model";
import { useRouteMapper } from "@/utils/useRouteMapper";
import { useRoute } from "vue-router";
import { useCameraDeepLinkUrlCleanup } from "@/utils/useCameraDeepLinkUrl";
import { watch } from "vue";
import { CAMERA_DEEP_LINK_QUERY_KEYS } from "@/utils/cameraDeepLink";

const route = useRoute();

// A camera target for the view that is already loaded: the keys changed on an
// open view (an external tool re-targeting a tab), or this route opened
// (immediate) on the view the store still holds, e.g. a link followed back
// from Home, where the route mapper skips setDatasetViewId. A view change
// carries its target through setDatasetViewId instead, and is skipped here:
// until it loads, store.datasetView is still the previous view. Only these
// keys are watched, so the z/time/xy writes never re-center.
watch(
  CAMERA_DEEP_LINK_QUERY_KEYS.map((key) => () => route.query[key]),
  () => {
    if (store.datasetView?.id === route.params.datasetViewId) {
      store.requestCameraDeepLink(route.query);
    }
  },
  { immediate: true },
);

useCameraDeepLinkUrlCleanup();

useRouteMapper(
  {
    datasetViewId: {
      parse: String,
      get: () => store.datasetView?.id || null,
      set: (value: string) =>
        store.setDatasetViewId({ id: value, routeQuery: route.query }),
      // A store-driven switch to another view (a snapshot, a new dataset)
      // must not carry the last view's camera target into its URL.
      clearsQuery: CAMERA_DEEP_LINK_QUERY_KEYS,
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
