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
import { initSentry } from "@/utils/sentry";
import chat from "./store/chat";
import { installTour } from "./plugins/tour";
import { tourTriggerDirective } from "./plugins/tour-trigger.directive";

main.initialize();
main.setupWatchers();
chat.initializeChatDatabase();

const app = createApp(App);

initSentry(app);

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
