<template>
  <router-view></router-view>
</template>
<script setup lang="ts">
import store from "@/store";
import { TLayerMode } from "@/store/model";
import { removeQueryKeys, useRouteMapper } from "@/utils/useRouteMapper";
import { useRoute, useRouter } from "vue-router";
import { watch } from "vue";
import { CAMERA_DEEP_LINK_QUERY_KEYS } from "@/utils/cameraDeepLink";

const route = useRoute();
const router = useRouter();

// A `?x=&y=&zoom=` change on the view that is already loaded (an external tool
// re-targeting an open tab). A view change carries its target through
// setDatasetViewId instead, and is skipped here: until it loads,
// store.datasetView is still the previous view. Only these keys are watched,
// so the z/time/xy writes that keep x and y in the URL never re-center.
watch(
  CAMERA_DEEP_LINK_QUERY_KEYS.map((key) => () => route.query[key]),
  () => {
    if (store.datasetView?.id === route.params.datasetViewId) {
      store.requestCameraDeepLink(route.query);
    }
  },
);

// Once ImageViewer has applied a target, drop its keys from the URL: left
// there, a reload or a copied URL would jump back to the linked point after
// the user has moved on. Only on apply: a navigation also clears the pending
// target, and stripping then would re-sync the route while its own view is
// still loading and drop the target it carries.
watch(
  () => store.appliedCameraDeepLinks,
  () => removeQueryKeys(CAMERA_DEEP_LINK_QUERY_KEYS, router, route),
);

useRouteMapper(
  {
    datasetViewId: {
      parse: String,
      get: () => store.datasetView?.id || null,
      set: (value: string) =>
        store.setDatasetViewId({ id: value, routeQuery: route.query }),
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
