import Project from "./Project.vue";
import ProjectInfo from "./ProjectInfo.vue";

import projects from "@/store/projects";
import { RouteConfig } from "vue-router";

const routes: RouteConfig[] = [
  {
    path: ":projectId",
    component: Project,
    props: true,
    meta: {
      name: "project",
      text() {
        return projects.currentProject?.name || projects.currentProjectId;
      },
    },
    children: [
      {
        path: "",
        name: "project",
        component: ProjectInfo,
        meta: {
          hidden: true,
        },
      },
    ],
  },
];

export default routes;
