import { createApp, reactive, toRefs } from "vue";
import "roboto-fontface/css/roboto/roboto-fontface.css";
import "@mdi/font/css/materialdesignicons.min.css";

import "reflect-metadata";
import "./registerServiceWorker";
import vuetify from "./plugins/vuetify";
import VueAsyncComputed from "vue-async-computed";

import main, { store } from "./store";
import router from "./router";

import App from "./App.vue";

import "./style.scss";

// Vuetify 3 styles
import "vuetify/styles";

// Mousetrap is configured for further imports (no need to import record plugin again)
import "mousetrap";
import "mousetrap/plugins/record/mousetrap-record.min.js";
import { mousetrapDirective } from "@/utils/v-mousetrap";
import { descriptionDirective } from "@/utils/v-description";
import chat from "./store/chat";
import { installTour } from "./plugins/tour";
import { tourTriggerDirective } from "./plugins/tour-trigger.directive";

// Registers `window.__nimbusMem` for browser-console memory diagnostics.
// Auto-tracking is opt-in via `__nimbusMem.enable()` and adds no overhead
// otherwise.
import { memDiag } from "@/utils/memoryDiagnostics";
import annotationStore from "./store/annotation";
import propertiesStore from "./store/properties";
import girderResourcesStore from "./store/girderResources";

main.initialize();
main.setupWatchers();
chat.initializeChatDatabase();

// Wire up live store/cache counts now that all store modules have finished
// initializing. memDiag does not import these stores itself to avoid a
// load-order cycle with index.ts.
memDiag.register(() => {
  const apiSizes = main.api.getCacheSizes();
  return {
    resourcesCache: Object.keys(girderResourcesStore.resources).length,
    resourcesLocks: Object.keys(girderResourcesStore.resourcesLocks).length,
    imageCache: apiSizes.imageCache,
    histogramCache: apiSizes.histogramCache,
    resolvedHistogramCache: apiSizes.resolvedHistogramCache,
    annotations: annotationStore.annotations.length,
    annotationConnections: annotationStore.annotationConnections.length,
    annotationCentroids: Object.keys(annotationStore.annotationCentroids)
      .length,
    selectedAnnotationIds: annotationStore.selectedAnnotationIds.size,
    activeAnnotationIds: annotationStore.activeAnnotationIds.length,
    copiedAnnotations: annotationStore.copiedAnnotations.length,
    pendingAnnotation: annotationStore.pendingAnnotation ? 1 : 0,
    submitPendingAnnotation: annotationStore.submitPendingAnnotation ? 1 : 0,
    propertyValues: Object.keys(propertiesStore.propertyValues).length,
    propertyStatuses: Object.keys(propertiesStore.propertyStatuses).length,
    workerImageList: Object.keys(propertiesStore.workerImageList).length,
    workerInterfaces: Object.keys(propertiesStore.workerInterfaces).length,
    workerPreviews: Object.keys(propertiesStore.workerPreviews).length,
    pendingWorkerPreviewTimeouts:
      propertiesStore.pendingWorkerPreviewTimeouts.size,
  };
});

const app = createApp(App);

app.use(router);
app.use(store);
app.use(vuetify);
app.use(VueAsyncComputed);

app.directive("mousetrap", mousetrapDirective as any);
app.directive("description", descriptionDirective as any);
app.directive("tour-trigger", tourTriggerDirective as any);

app.provide("girderRest", main.girderRestProxy);

// Provide 'girder' injection for @girder/components v4.0
// Components like GirderFileManager, GirderSearch, GirderBreadcrumb use inject('girder')
// expecting { rest, user, apiRoot, token }
const girderRestClient = main.girderRest as any;
const girderState = reactive({
  apiRoot: girderRestClient.apiRoot as string,
  user: girderRestClient.user as any,
  token: (girderRestClient.token as string) || null,
});
const syncGirderState = () => {
  girderState.user = girderRestClient.user;
  girderState.token = girderRestClient.token;
};
girderRestClient.on("userLoggedIn", syncGirderState);
girderRestClient.on("userLoggedOut", syncGirderState);
girderRestClient.on("userFetched", syncGirderState);
girderRestClient.on("apiRootUpdated", () => {
  girderState.apiRoot = girderRestClient.apiRoot;
  syncGirderState();
});
app.provide("girder", { rest: main.girderRestProxy, ...toRefs(girderState) });

// Install tour plugin before mounting
export const tourManager = installTour(app, router);
app.provide("tourManager", tourManager);

app.mount("#app");

export { app, router };
