<template>
  <div class="wrapper" ref="overviewWrapper">
    <div class="header" @mousedown="headerMouseDown">
      <v-icon
        v-for="(item, idx) in cornerItems"
        :key="`overview-header-icon-${idx}`"
        class="header-icon"
        @click="moveOverviewToCorner(item)"
      >
        {{ cornerToIcon(item) }}
      </v-icon>
    </div>
    <div class="map" ref="overviewMap"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import geojs from "geojs";

import store from "@/store";
import {
  IGeoJSFeature,
  IGeoJSFeatureLayer,
  IGeoJSMap,
  IGeoJSOsmLayer,
  ICameraInfo,
  IDownloadParameters,
} from "@/store/model";
import {
  getBaseURLFromDownloadParameters,
  getLayersDownloadUrls,
} from "@/utils/screenshot";

interface ICorner {
  top: boolean;
  left: boolean;
}

const props = defineProps<{
  parentCameraInfo: ICameraInfo;
}>();

const emit = defineEmits<{
  (e: "centerChange", geo: any): void;
  (e: "cornersChange", corners: any): void;
}>();

const overviewMap = ref<HTMLElement>();
const overviewWrapper = ref<HTMLElement>();

const map = ref<IGeoJSMap | null>(null);
const observer = ref<ResizeObserver | null>(null);
const osmLayer = ref<IGeoJSOsmLayer | null>(null);
const featureLayer = ref<IGeoJSFeatureLayer | null>(null);
const outlineFeature = ref<IGeoJSFeature | null>(null);

const downState = ref<
  | (ICameraInfo & {
      state: any;
      mouse: any;
      distanceToOutline: number;
    })
  | null
>(null);

// Each possible corner: top-left, bottom-left, top-right, bottom-right
const cornerItems: ICorner[] = [
  { top: true, left: true },
  { top: false, left: true },
  { top: true, left: false },
  { top: false, left: false },
];

function cornerToIcon({ top, left }: ICorner) {
  return `mdi-arrow-${top ? "top" : "bottom"}-${left ? "left" : "right"}`;
}

function moveOverviewToCorner({ top, left }: ICorner) {
  const elem = overviewWrapper.value;
  if (!elem) {
    return;
  }
  elem.style.top = top ? "0" : "auto";
  elem.style.bottom = top ? "auto" : "0";
  elem.style.left = left ? "0" : "auto";
  elem.style.right = left ? "auto" : "0";
  return { top, left };
}

function headerMouseDown(evt: MouseEvent) {
  const elem = overviewWrapper.value;
  if (!elem) {
    return;
  }
  const baseX = elem.offsetLeft - evt.clientX;
  const baseY = elem.offsetTop - evt.clientY;

  const mouseMove = (evt: MouseEvent) => {
    evt.preventDefault();
    evt.stopPropagation();

    let top = baseY + evt.clientY;
    let left = baseX + evt.clientX;

    top = Math.max(0, top);
    left = Math.max(0, left);

    const parent = elem.offsetParent;
    if (parent) {
      const parentBottom = parent.clientTop + parent.clientHeight;
      const parentRight = parent.clientLeft + parent.clientWidth;
      const elemBottom = top + elem.clientHeight;
      const elemRight = left + elem.clientWidth;
      top -= Math.max(0, elemBottom - parentBottom);
      left -= Math.max(0, elemRight - parentRight);
    }

    elem.style.top = `${top}px`;
    elem.style.left = `${left}px`;
    elem.style.bottom = "auto";
    elem.style.right = "auto";
  };

  const mouseUp = () => {
    document.removeEventListener("mousemove", mouseMove);
    document.removeEventListener("mouseup", mouseUp);
  };

  document.addEventListener("mousemove", mouseMove);
  document.addEventListener("mouseup", mouseUp);
}

const dataset = computed(() => store.dataset);

/* eslint-disable vue/no-async-in-computed-properties */
const urlPromise = computed(() => {
  if (!dataset.value || !map.value) {
    return;
  }

  const anyImage = dataset.value.anyImage();
  if (!anyImage) {
    return;
  }

  // Always use level 0
  const unitsPerPixel = map.value.unitsPerPixel(0);
  const params: IDownloadParameters = {
    encoding: "JPEG",
    contentDisposition: "inline",
    contentDispositionFilename: "overview.jpeg",
    width: Math.round(anyImage.sizeX / unitsPerPixel),
    height: Math.round(anyImage.sizeY / unitsPerPixel),
  };
  const itemId = anyImage.item._id;
  const apiRoot = store.girderRest.apiRoot;
  const baseUrl = getBaseURLFromDownloadParameters(params, itemId, apiRoot);

  const layers = store.layers;
  return getLayersDownloadUrls(
    baseUrl,
    "composite",
    layers,
    dataset.value,
    store.currentLocation,
  ).then((urls) => urls[0].url);
});
/* eslint-enable vue/no-async-in-computed-properties */

function create() {
  const elem = overviewMap.value;
  const someImage = dataset.value?.anyImage();
  if (!someImage || !elem) {
    return;
  }

  const params = geojs.util.pixelCoordinateParams(
    elem,
    someImage.sizeX,
    someImage.sizeY,
    someImage.tileWidth,
    someImage.tileHeight,
  );
  params.layer.crossDomain = "use-credentials";
  params.layer.url = "";
  params.layer.renderer = "canvas";
  /* We want the actions to trigger on the overview, but affect the main
   * image, so we have to rerig all of the actions */
  params.map.interactor = geojs.mapInteractor({
    actions: [
      {
        action: "overview_pan",
        input: "left",
        modifiers: { shift: false, ctrl: false },
        owner: "nimbusimage.overview",
        name: "button pan",
      },
      {
        action: "overview_zoomselect",
        input: "left",
        modifiers: { shift: true, ctrl: false },
        selectionRectangle: geojs.event.zoomselect,
        owner: "nimbusimage.overview",
        name: "drag zoom",
      },
    ],
    keyboard: {
      actions: {},
    },
  });
  map.value = geojs.map(params.map);

  if (window.ResizeObserver) {
    observer.value = new window.ResizeObserver(() => {
      if (!map.value) {
        return;
      }
      const node = map.value.node();
      const width = node.width();
      const height = node.height();
      if (width && height) {
        map.value.size({ width, height });
      }
    });
    observer.value.observe(map.value.node()[0]);
  }

  params.layer.autoshareRenderer = false;
  // Always use level 0
  params.layer.tileRounding = () => 0;
  osmLayer.value = map.value.createLayer("osm", params.layer);
  featureLayer.value = map.value.createLayer("feature", {
    features: ["polygon"],
  });
  outlineFeature.value = featureLayer.value.createFeature("polygon", {
    style: {
      stroke: true,
      strokeColor: "cyan",
      strokeWidth: 2,
      fill: false,
    },
  });
  /* Clicking in the overview recenters to that spot */
  featureLayer.value.geoOn(geojs.event.mouseclick, (evt: any) => {
    emit("centerChange", evt.geo);
  });
  featureLayer.value.geoOn(geojs.event.actiondown, (evt: any) => {
    if (!map.value || !outlineFeature.value) {
      return;
    }
    downState.value = {
      ...props.parentCameraInfo,
      state: evt.state,
      mouse: evt.mouse,
      distanceToOutline:
        geojs.util.distanceToPolygon2d(
          evt.mouse.geo,
          outlineFeature.value.data()[0],
        ) / map.value.unitsPerPixel(map.value.zoom()),
    };
  });
  const panOutlineDistance = 5;
  featureLayer.value.geoOn(geojs.event.actionmove, (evt: any) => {
    if (
      evt.state.action === "overview_pan" &&
      downState.value &&
      downState.value.distanceToOutline >= -panOutlineDistance
    ) {
      const delta = {
        x: evt.mouse.geo.x - downState.value.mouse.geo.x,
        y: evt.mouse.geo.y - downState.value.mouse.geo.y,
      };
      const center = props.parentCameraInfo.center;
      delta.x -= center.x - downState.value.center.x;
      delta.y -= center.y - downState.value.center.y;
      if (delta.x || delta.y) {
        emit("centerChange", {
          x: center.x + delta.x,
          y: center.y + delta.y,
        });
      }
    }
  });
  featureLayer.value.geoOn(geojs.event.actionselection, (evt: any) => {
    if (
      evt.lowerLeft.x === evt.upperRight.x ||
      evt.lowerLeft.y === evt.upperRight.y ||
      !map.value
    ) {
      return;
    }
    const lowerLeftGcs = map.value.displayToGcs(evt.lowerLeft);
    const upperRightGcs = map.value.displayToGcs(evt.upperRight);
    emit("cornersChange", { lowerLeftGcs, upperRightGcs });
  });
  map.value.draw();
}

function onParentPan() {
  if (map.value && props.parentCameraInfo.rotate !== map.value.rotation()) {
    map.value.rotation(props.parentCameraInfo.rotate);
    // Always use the smallest zoom possible
    // It will be clamped automatically
    map.value.zoom(-Infinity);
  }
  outlineFeature.value?.data([props.parentCameraInfo.gcsBounds]).draw();
}

async function onUrlChanged() {
  if (!osmLayer.value) {
    return;
  }
  if (urlPromise.value) {
    const url = await urlPromise.value;
    osmLayer.value.url(url.toString());
  } else {
    osmLayer.value.url("");
  }
}

watch(dataset, () => create());
watch(() => props.parentCameraInfo, onParentPan);
watch([urlPromise, osmLayer], onUrlChanged);

onMounted(() => create());

onBeforeUnmount(() => {
  if (observer.value) {
    observer.value.disconnect();
    observer.value = null;
  }
});
</script>

<style scoped lang="scss">
.wrapper {
  position: absolute;
  background: black;
  border: 1px solid white;
  z-index: 100;
}
.map {
  width: 150px;
  height: 150px;
}
.header {
  display: flex;
  justify-content: center;
  width: 100%;
  height: 16px;
  background: rgb(2, 119, 189);
  font-size: 16px;
  line-height: 0;
}
.header-icon {
  font-size: 16px;
  margin: 0 4px;
}
</style>
