import Vue from "vue";
import "roboto-fontface/css/roboto/roboto-fontface.css";
import "@mdi/font/css/materialdesignicons.min.css";

import "reflect-metadata";
import "./registerServiceWorker";
import vuetify from "./plugins/vuetify";
import VueAsyncComputed from "vue-async-computed";
import VueRouter from "vue-router";
import "./plugins/resize";

Vue.use(VueRouter);

import main, { store } from "./store";

import routes from "./views";
import App from "./App.vue";

import "./style.scss";

// Mousetrap is configured for further imports (no need to import record plugin again)
import "mousetrap";
import "mousetrap/plugins/record/mousetrap-record.min.js";
import vMousetrap from "@/utils/v-mousetrap";
import vDescription from "@/utils/v-description";
import chat from "./store/chat";
import VueTooltipDirective from "vue-tooltip-directive";
import NimbusTooltip from "@/components/NimbusTooltip.vue";
import { installTour } from "./plugins/tour";
import "./plugins/tour-trigger.directive";

Vue.config.productionTip = false;

Vue.use(VueAsyncComputed);
Vue.use(vMousetrap);
Vue.use(vDescription);
Vue.use(VueTooltipDirective, { component: NimbusTooltip });

main.initialize();
main.setupWatchers();
chat.initializeChatDatabase();

const router = new VueRouter({
  routes,
});

// Install tour plugin before creating Vue instance
export const tourManager = installTour(router);

const app = new Vue({
  provide: {
    girderRest: main.girderRestProxy,
  },
  router,
  store,
  vuetify,
  render: (h: any) => h(App),
}).$mount("#app");

export { app };
