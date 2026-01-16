import Home from "./Home.vue";
import DatasetAndConfigurationRouter from "./DatasetAndConfigurationRouter.vue";
import EmptyRouterView from "./EmptyRouterView.vue";
import ProjectRouter from "./ProjectRouter.vue";
import datasetRoutes from "./dataset";
import configurationRoutes from "./configuration";
import datasetViewRoutes from "./datasetView";
import projectRoutes from "./project";

import { RouteConfig } from "vue-router";

const routes: RouteConfig[] = [
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
  {
    path: "*",
    redirect: {
      name: "root",
    },
  },
];

export default routes;
