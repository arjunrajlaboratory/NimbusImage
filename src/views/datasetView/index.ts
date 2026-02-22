import DatasetView from "./DatasetView.vue";
import Viewer from "./Viewer.vue";
import type { RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  {
    path: ":datasetViewId",
    component: DatasetView,
    children: [
      {
        path: "view",
        name: "datasetview",
        component: Viewer,
        meta: {
          text: "Explore",
        },
      },
    ],
  },
];

export default routes;
