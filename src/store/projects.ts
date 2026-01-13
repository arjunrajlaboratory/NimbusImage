import {
  getModule,
  Action,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import store from "./root";
import main from "./index";
import sync from "./sync";
import { IProject, TProjectStatus } from "./model";
import { logError } from "@/utils/log";

@Module({ dynamic: true, store, name: "projects" })
export class Projects extends VuexModule {
  // State
  projects: IProject[] = [];
  currentProjectId: string | null = null;

  // Getters
  get currentProject(): IProject | null {
    if (!this.currentProjectId) return null;
    return this.projects.find((p) => p.id === this.currentProjectId) || null;
  }

  get getProjectById() {
    return (id: string): IProject | undefined =>
      this.projects.find((p) => p.id === id);
  }

  get recentProjects(): IProject[] {
    return [...this.projects]
      .sort(
        (a, b) =>
          new Date(b.updated).getTime() - new Date(a.updated).getTime(),
      )
      .slice(0, 5);
  }

  get projectsWithDataset() {
    return (datasetId: string): IProject[] =>
      this.projects.filter((p) =>
        p.meta.datasets.some((d) => d.datasetId === datasetId),
      );
  }

  // Mutations
  @Mutation
  setProjects(projects: IProject[]) {
    this.projects = projects;
  }

  @Mutation
  setCurrentProjectId(projectId: string | null) {
    this.currentProjectId = projectId;
  }

  @Mutation
  addProjectImpl(project: IProject) {
    // Check if project already exists
    const existingIndex = this.projects.findIndex((p) => p.id === project.id);
    if (existingIndex >= 0) {
      // Update existing project
      this.projects.splice(existingIndex, 1, project);
    } else {
      this.projects.push(project);
    }
  }

  @Mutation
  updateProjectImpl(updatedProject: IProject) {
    const index = this.projects.findIndex((p) => p.id === updatedProject.id);
    if (index !== -1) {
      this.projects.splice(index, 1, updatedProject);
    }
  }

  @Mutation
  removeProjectImpl(projectId: string) {
    this.projects = this.projects.filter((p) => p.id !== projectId);
    if (this.currentProjectId === projectId) {
      this.currentProjectId = null;
    }
  }

  // Actions
  @Action
  async fetchProjects(): Promise<IProject[]> {
    if (!main.isLoggedIn) {
      return [];
    }

    sync.setSaving(true);
    try {
      const projects = await main.projectsAPI.getProjects();
      this.setProjects(projects);
      sync.setSaving(false);
      return projects;
    } catch (error) {
      logError("Failed to fetch projects:", error);
      sync.setSaving(error as Error);
      return [];
    }
  }

  @Action
  async fetchProject(projectId: string): Promise<IProject | null> {
    // Note: removed isLoggedIn check to allow page refresh to work properly
    // The API call will fail if not authenticated anyway
    sync.setSaving(true);
    try {
      const project = await main.projectsAPI.getProject(projectId);
      if (project) {
        this.addProjectImpl(project);
      }
      sync.setSaving(false);
      return project;
    } catch (error) {
      logError(`Failed to fetch project ${projectId}:`, error);
      sync.setSaving(error as Error);
      return null;
    }
  }

  @Action
  async createProject(params: {
    name: string;
    description?: string;
  }): Promise<IProject | null> {
    if (!main.isLoggedIn) {
      return null;
    }

    sync.setSaving(true);
    try {
      const project = await main.projectsAPI.createProject(
        params.name,
        params.description || "",
      );
      if (project) {
        this.addProjectImpl(project);
      }
      sync.setSaving(false);
      return project;
    } catch (error) {
      logError("Failed to create project:", error);
      sync.setSaving(error as Error);
      return null;
    }
  }

  @Action
  async updateProject(params: {
    projectId: string;
    name?: string;
    description?: string;
  }): Promise<IProject | null> {
    if (!main.isLoggedIn) {
      return null;
    }

    sync.setSaving(true);
    try {
      const project = await main.projectsAPI.updateProject(
        params.projectId,
        params.name,
        params.description,
      );
      if (project) {
        this.updateProjectImpl(project);
      }
      sync.setSaving(false);
      return project;
    } catch (error) {
      logError(`Failed to update project ${params.projectId}:`, error);
      sync.setSaving(error as Error);
      return null;
    }
  }

  @Action
  async deleteProject(projectId: string): Promise<boolean> {
    if (!main.isLoggedIn) {
      return false;
    }

    sync.setSaving(true);
    try {
      const success = await main.projectsAPI.deleteProject(projectId);
      if (success) {
        this.removeProjectImpl(projectId);
      }
      sync.setSaving(false);
      return success;
    } catch (error) {
      logError(`Failed to delete project ${projectId}:`, error);
      sync.setSaving(error as Error);
      return false;
    }
  }

  @Action
  async addDatasetToProject(params: {
    projectId: string;
    datasetId: string;
  }): Promise<IProject | null> {
    if (!main.isLoggedIn) {
      return null;
    }

    sync.setSaving(true);
    try {
      const project = await main.projectsAPI.addDatasetToProject(
        params.projectId,
        params.datasetId,
      );
      if (project) {
        this.updateProjectImpl(project);
      }
      sync.setSaving(false);
      return project;
    } catch (error) {
      logError(
        `Failed to add dataset ${params.datasetId} to project ${params.projectId}:`,
        error,
      );
      sync.setSaving(error as Error);
      return null;
    }
  }

  @Action
  async removeDatasetFromProject(params: {
    projectId: string;
    datasetId: string;
  }): Promise<IProject | null> {
    if (!main.isLoggedIn) {
      return null;
    }

    sync.setSaving(true);
    try {
      const project = await main.projectsAPI.removeDatasetFromProject(
        params.projectId,
        params.datasetId,
      );
      if (project) {
        this.updateProjectImpl(project);
      }
      sync.setSaving(false);
      return project;
    } catch (error) {
      logError(
        `Failed to remove dataset ${params.datasetId} from project ${params.projectId}:`,
        error,
      );
      sync.setSaving(error as Error);
      return null;
    }
  }

  @Action
  async addCollectionToProject(params: {
    projectId: string;
    collectionId: string;
  }): Promise<IProject | null> {
    if (!main.isLoggedIn) {
      return null;
    }

    sync.setSaving(true);
    try {
      const project = await main.projectsAPI.addCollectionToProject(
        params.projectId,
        params.collectionId,
      );
      if (project) {
        this.updateProjectImpl(project);
      }
      sync.setSaving(false);
      return project;
    } catch (error) {
      logError(
        `Failed to add collection ${params.collectionId} to project ${params.projectId}:`,
        error,
      );
      sync.setSaving(error as Error);
      return null;
    }
  }

  @Action
  async removeCollectionFromProject(params: {
    projectId: string;
    collectionId: string;
  }): Promise<IProject | null> {
    if (!main.isLoggedIn) {
      return null;
    }

    sync.setSaving(true);
    try {
      const project = await main.projectsAPI.removeCollectionFromProject(
        params.projectId,
        params.collectionId,
      );
      if (project) {
        this.updateProjectImpl(project);
      }
      sync.setSaving(false);
      return project;
    } catch (error) {
      logError(
        `Failed to remove collection ${params.collectionId} from project ${params.projectId}:`,
        error,
      );
      sync.setSaving(error as Error);
      return null;
    }
  }

  @Action
  async updateProjectMetadata(params: {
    projectId: string;
    metadata: {
      title?: string;
      description?: string;
      license?: string;
      keywords?: string[];
    };
  }): Promise<IProject | null> {
    if (!main.isLoggedIn) {
      return null;
    }

    sync.setSaving(true);
    try {
      const project = await main.projectsAPI.updateProjectMetadata(
        params.projectId,
        params.metadata,
      );
      if (project) {
        this.updateProjectImpl(project);
      }
      sync.setSaving(false);
      return project;
    } catch (error) {
      logError(
        `Failed to update metadata for project ${params.projectId}:`,
        error,
      );
      sync.setSaving(error as Error);
      return null;
    }
  }

  @Action
  async setSelectedProject(projectId: string | null): Promise<void> {
    this.setCurrentProjectId(projectId);
    if (projectId && !this.getProjectById(projectId)) {
      await this.fetchProject(projectId);
    }
  }

  @Action
  async updateProjectStatus(params: {
    projectId: string;
    status: TProjectStatus;
  }): Promise<IProject | null> {
    if (!main.isLoggedIn) {
      return null;
    }

    sync.setSaving(true);
    try {
      const project = await main.projectsAPI.updateProjectStatus(
        params.projectId,
        params.status,
      );
      if (project) {
        this.updateProjectImpl(project);
      }
      sync.setSaving(false);
      return project;
    } catch (error) {
      logError(
        `Failed to update status for project ${params.projectId}:`,
        error,
      );
      sync.setSaving(error as Error);
      return null;
    }
  }
}

export default getModule(Projects);
