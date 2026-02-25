import { createRouter, createWebHashHistory } from "vue-router";
import routes from "./views";

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
