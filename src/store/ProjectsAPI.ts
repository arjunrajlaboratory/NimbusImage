import { RestClientInstance } from "@/girder";
import { IProject } from "./model";
import { logError } from "@/utils/log";

/**
 * Convert backend project response to IProject interface
 */
function toProject(data: any): IProject {
  return {
    id: data._id,
    name: data.name,
    description: data.description,
    creatorId: data.creatorId,
    created: data.created,
    updated: data.updated,
    meta: {
      datasets: (data.meta?.datasets || []).map((d: any) => ({
        datasetId: typeof d.datasetId === "object" ? d.datasetId : d.datasetId,
        addedDate: d.addedDate,
      })),
      collections: (data.meta?.collections || []).map((c: any) => ({
        collectionId:
          typeof c.collectionId === "object" ? c.collectionId : c.collectionId,
        addedDate: c.addedDate,
      })),
      metadata: data.meta?.metadata || {
        title: data.name,
        description: data.description,
        license: "CC-BY-4.0",
        keywords: [],
      },
      status: data.meta?.status || "draft",
    },
  };
}

export default class ProjectsAPI {
  private readonly client: RestClientInstance;

  constructor(client: RestClientInstance) {
    this.client = client;
  }

  /**
   * Get all projects the current user has access to
   */
  async getProjects(params?: {
    creatorId?: string;
    status?: string;
  }): Promise<IProject[]> {
    try {
      const response = await this.client.get("project", { params });
      return response.data.map(toProject);
    } catch (error) {
      logError("Failed to fetch projects:", error);
      return [];
    }
  }

  /**
   * Get a single project by ID
   */
  async getProject(id: string): Promise<IProject | null> {
    try {
      const response = await this.client.get(`project/${id}`);
      return toProject(response.data);
    } catch (error) {
      logError(`Failed to fetch project ${id}:`, error);
      return null;
    }
  }

  /**
   * Create a new project
   */
  async createProject(
    name: string,
    description: string = "",
  ): Promise<IProject | null> {
    try {
      const response = await this.client.post("project", null, {
        params: { name, description },
      });
      return toProject(response.data);
    } catch (error) {
      logError("Failed to create project:", error);
      return null;
    }
  }

  /**
   * Update a project's name and/or description
   */
  async updateProject(
    id: string,
    name?: string,
    description?: string,
  ): Promise<IProject | null> {
    try {
      const params: { name?: string; description?: string } = {};
      if (name !== undefined) params.name = name;
      if (description !== undefined) params.description = description;

      const response = await this.client.put(`project/${id}`, null, {
        params,
      });
      return toProject(response.data);
    } catch (error) {
      logError(`Failed to update project ${id}:`, error);
      return null;
    }
  }

  /**
   * Delete a project
   */
  async deleteProject(id: string): Promise<boolean> {
    try {
      await this.client.delete(`project/${id}`);
      return true;
    } catch (error) {
      logError(`Failed to delete project ${id}:`, error);
      return false;
    }
  }

  /**
   * Add a dataset to a project
   */
  async addDatasetToProject(
    projectId: string,
    datasetId: string,
  ): Promise<IProject | null> {
    try {
      const response = await this.client.post(
        `project/${projectId}/dataset`,
        null,
        { params: { datasetId } },
      );
      return toProject(response.data);
    } catch (error) {
      logError(
        `Failed to add dataset ${datasetId} to project ${projectId}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Remove a dataset from a project
   */
  async removeDatasetFromProject(
    projectId: string,
    datasetId: string,
  ): Promise<IProject | null> {
    try {
      const response = await this.client.delete(
        `project/${projectId}/dataset/${datasetId}`,
      );
      return toProject(response.data);
    } catch (error) {
      logError(
        `Failed to remove dataset ${datasetId} from project ${projectId}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Add a collection to a project
   */
  async addCollectionToProject(
    projectId: string,
    collectionId: string,
  ): Promise<IProject | null> {
    try {
      const response = await this.client.post(
        `project/${projectId}/collection`,
        null,
        { params: { collectionId } },
      );
      return toProject(response.data);
    } catch (error) {
      logError(
        `Failed to add collection ${collectionId} to project ${projectId}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Remove a collection from a project
   */
  async removeCollectionFromProject(
    projectId: string,
    collectionId: string,
  ): Promise<IProject | null> {
    try {
      const response = await this.client.delete(
        `project/${projectId}/collection/${collectionId}`,
      );
      return toProject(response.data);
    } catch (error) {
      logError(
        `Failed to remove collection ${collectionId} from project ${projectId}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Update project publication metadata
   */
  async updateProjectMetadata(
    projectId: string,
    metadata: {
      title?: string;
      description?: string;
      license?: string;
      keywords?: string[];
    },
  ): Promise<IProject | null> {
    try {
      const response = await this.client.put(
        `project/${projectId}/metadata`,
        metadata,
      );
      return toProject(response.data);
    } catch (error) {
      logError(`Failed to update metadata for project ${projectId}:`, error);
      return null;
    }
  }

  /**
   * Update project status
   */
  async updateProjectStatus(
    projectId: string,
    status: "draft" | "exporting" | "exported",
  ): Promise<IProject | null> {
    try {
      const response = await this.client.put(`project/${projectId}/status`, null, {
        params: { status },
      });
      return toProject(response.data);
    } catch (error) {
      logError(`Failed to update status for project ${projectId}:`, error);
      return null;
    }
  }
}
