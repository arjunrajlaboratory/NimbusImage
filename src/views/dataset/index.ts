import Dataset from "./Dataset.vue";
import NewDataset from "./NewDataset.vue";
import ImportDataset from "./ImportDataset.vue";
import DatasetInfo from "./DatasetInfo.vue";
import { Main } from "@/store";
import type { RouteRecordRaw } from "vue-router";
import MultiSourceConfiguration from "./MultiSourceConfiguration.vue";

const routes: RouteRecordRaw[] = [
  {
    path: "new",
    name: "newdataset",
    component: NewDataset,
    meta: {
      text: "Upload New Data",
    },
    props: (route) => ({ ...route.params }),
  },
  {
    path: "multi/:datasetId",
    name: "multi",
    component: MultiSourceConfiguration,
    props: (route) => ({ ...route.params }),
  },
  {
    path: "import",
    name: "importdataset",
    component: ImportDataset,
    meta: {
      text: "Use Existing Data",
    },
  },
  {
    path: ":datasetId",
    props: true,
    component: Dataset,
    children: [
      {
        path: "",
        name: "dataset",
        component: DatasetInfo,
        meta: {
          hidden: true,
        },
      },
    ],
    meta: {
      name: "dataset",
      text(store: Main) {
        return store.dataset?.name || store.selectedDatasetId;
      },
    },
  },
];

export default routes;
