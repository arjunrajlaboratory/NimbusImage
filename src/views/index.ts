import Home from "./Home.vue";
import DatasetAndConfigurationRouter from "./DatasetAndConfigurationRouter.vue";
import EmptyRouterView from "./EmptyRouterView.vue";
import ProjectRouter from "./ProjectRouter.vue";
import SharedView from "./SharedView.vue";
import datasetRoutes from "./dataset";
import configurationRoutes from "./configuration";
import datasetViewRoutes from "./datasetView";
import projectRoutes from "./project";

import type { RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    name: "root",
    component: Home,
    meta: {
      hidden: true,
    },
  },
  {
    path: "/dataset",
    children: datasetRoutes,
    component: DatasetAndConfigurationRouter,
  },
  {
    path: "/configuration",
    children: configurationRoutes,
    component: DatasetAndConfigurationRouter,
  },
  {
    path: "/datasetView",
    children: datasetViewRoutes,
    component: EmptyRouterView,
  },
  {
    path: "/project",
    children: projectRoutes,
    component: ProjectRouter,
  },
  // Share-view links: the bearer opens exactly one dataset view (SHARING.md).
  {
    path: "/shared/:token",
    name: "shared",
    component: SharedView,
    meta: { hidden: true },
  },
  {
    path: "/embed/:token",
    name: "embed",
    component: SharedView,
    meta: { hidden: true },
  },
  {
    path: "/:pathMatch(.*)*",
    redirect: {
      name: "root",
    },
  },
];

export default routes;
