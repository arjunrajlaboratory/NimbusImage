import Configuration from "./Configuration.vue";
import ConfigurationInfo from "./ConfigurationInfo.vue";
import ImportConfiguration from "./ImportConfiguration.vue";
import NewConfiguration from "./NewConfiguration.vue";
import DuplicateImportConfiguration from "./DuplicateImportConfiguration.vue";

import { Main } from "@/store";
import type { RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  {
    path: "new",
    name: "newconfiguration",
    component: NewConfiguration,
    meta: {
      text: "New Configuration",
    },
  },
  {
    path: "import",
    name: "importconfiguration",
    component: ImportConfiguration,
    meta: {
      text: "Import one or several existing configurations",
    },
  },
  {
    path: "duplicate-import",
    name: "duplicateimportconfiguration",
    component: DuplicateImportConfiguration,
    meta: {
      text: "Duplicate and import one or several existing configurations",
    },
  },
  {
    path: ":configurationId",
    component: Configuration,
    props: true,
    meta: {
      name: "configuration",
      text(store: Main) {
        return store.configuration?.name || store.selectedConfigurationId;
      },
    },
    children: [
      {
        path: "",
        name: "configuration",
        component: ConfigurationInfo,
        meta: {
          hidden: true,
        },
      },
    ],
  },
];

export default routes;
