import { createApp } from "vue";
import "roboto-fontface/css/roboto/roboto-fontface.css";
import "@mdi/font/css/materialdesignicons.min.css";

import "reflect-metadata";
import "./registerServiceWorker";
import vuetify from "./plugins/vuetify";
import VueAsyncComputed from "vue-async-computed";
import { createRouter, createWebHashHistory } from "vue-router";

import main, { store } from "./store";

import routes from "./views";
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

main.initialize();
main.setupWatchers();
chat.initializeChatDatabase();

const router = createRouter({
  history: createWebHashHistory(),
  routes,
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

// Install tour plugin before mounting
export const tourManager = installTour(app, router);
app.provide("tourManager", tourManager);

app.mount("#app");

export { app, router };
