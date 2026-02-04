import { RestClientInstance, IGirderFolder, IUPennCollection } from "@/girder";
import { IProject, IAnnotation } from "./model";

/**
 * Extract string ID from MongoDB ObjectId (handles both {$oid: string} format and plain strings)
 */
function toStringId(id: any): string {
  if (typeof id === "object" && id !== null && "$oid" in id) {
    return id.$oid;
  }
  return String(id);
}

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
        datasetId: toStringId(d.datasetId),
        addedDate: d.addedDate,
      })),
      collections: (data.meta?.collections || []).map((c: any) => ({
        collectionId: toStringId(c.collectionId),
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
    const response = await this.client.get("project", { params });
    return response.data.map(toProject);
  }

  /**
   * Get a single project by ID
   */
  async getProject(id: string): Promise<IProject> {
    const response = await this.client.get(`project/${id}`);
    return toProject(response.data);
  }

  /**
   * Create a new project
   */
  async createProject(
    name: string,
    description: string = "",
  ): Promise<IProject> {
    const response = await this.client.post("project", null, {
      params: { name, description },
    });
    return toProject(response.data);
  }

  /**
   * Update a project's name and/or description
   */
  async updateProject(
    id: string,
    name?: string,
    description?: string,
  ): Promise<IProject> {
    const params: { name?: string; description?: string } = {};
    if (name !== undefined) params.name = name;
    if (description !== undefined) params.description = description;

    const response = await this.client.put(`project/${id}`, null, {
      params,
    });
    return toProject(response.data);
  }

  /**
   * Delete a project
   */
  async deleteProject(id: string): Promise<void> {
    await this.client.delete(`project/${id}`);
  }

  /**
   * Add a dataset to a project
   */
  async addDatasetToProject(
    projectId: string,
    datasetId: string,
  ): Promise<IProject> {
    const response = await this.client.post(
      `project/${projectId}/dataset`,
      null,
      { params: { datasetId } },
    );
    return toProject(response.data);
  }

  /**
   * Remove a dataset from a project
   */
  async removeDatasetFromProject(
    projectId: string,
    datasetId: string,
  ): Promise<IProject> {
    const response = await this.client.delete(
      `project/${projectId}/dataset/${datasetId}`,
    );
    return toProject(response.data);
  }

  /**
   * Add a collection to a project
   */
  async addCollectionToProject(
    projectId: string,
    collectionId: string,
  ): Promise<IProject> {
    const response = await this.client.post(
      `project/${projectId}/collection`,
      null,
      { params: { collectionId } },
    );
    return toProject(response.data);
  }

  /**
   * Remove a collection from a project
   */
  async removeCollectionFromProject(
    projectId: string,
    collectionId: string,
  ): Promise<IProject> {
    const response = await this.client.delete(
      `project/${projectId}/collection/${collectionId}`,
    );
    return toProject(response.data);
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
      authors?: string;
      doi?: string;
      publicationDate?: string;
      funding?: string;
    },
  ): Promise<IProject> {
    const response = await this.client.put(
      `project/${projectId}/metadata`,
      metadata,
    );
    return toProject(response.data);
  }

  /**
   * Update project status
   */
  async updateProjectStatus(
    projectId: string,
    status: "draft" | "exporting" | "exported",
  ): Promise<IProject> {
    const response = await this.client.put(
      `project/${projectId}/status`,
      null,
      {
        params: { status },
      },
    );
    return toProject(response.data);
  }

  // =========================================================================
  // Project-scoped access endpoints (permission masking)
  // =========================================================================

  /**
   * List datasets in a project with permission masking.
   *
   * Only returns datasets where the user has READ access to both
   * the project and the individual dataset.
   */
  async listProjectDatasets(
    projectId: string,
    params?: { limit?: number; offset?: number },
  ): Promise<IGirderFolder[]> {
    const response = await this.client.get(`project/${projectId}/datasets`, {
      params,
    });
    return response.data;
  }

  /**
   * List collections in a project with permission masking.
   *
   * Only returns collections where the user has READ access to both
   * the project and the individual collection.
   */
  async listProjectCollections(
    projectId: string,
    params?: { limit?: number; offset?: number },
  ): Promise<IUPennCollection[]> {
    const response = await this.client.get(`project/${projectId}/collections`, {
      params,
    });
    return response.data;
  }

  /**
   * Get annotations for a dataset within project context.
   *
   * Applies permission masking - user must have access to both
   * the project and the dataset.
   */
  async getProjectDatasetAnnotations(
    projectId: string,
    datasetId: string,
    params?: {
      shape?: string;
      tags?: string[];
      limit?: number;
      offset?: number;
    },
  ): Promise<IAnnotation[]> {
    const response = await this.client.get(
      `project/${projectId}/dataset/${datasetId}/annotations`,
      { params },
    );
    return response.data;
  }

  // =========================================================================
  // Access management endpoints
  // =========================================================================

  /**
   * Get the access control list for a project.
   * Requires ADMIN access to the project.
   */
  async getProjectAccess(projectId: string): Promise<{
    users: Array<{
      id: string;
      login: string;
      firstName: string;
      lastName: string;
      level: number;
    }>;
    groups: Array<{ id: string; name: string; level: number }>;
  }> {
    const response = await this.client.get(`project/${projectId}/access`);
    return response.data;
  }

  /**
   * Set access permissions for a project.
   * Requires ADMIN access to the project.
   *
   * @param projectId - The project ID
   * @param access - The access control list
   * @param isPublic - Whether the project should be public
   */
  async setProjectAccess(
    projectId: string,
    access: {
      users?: Array<{ id: string; level: number }>;
      groups?: Array<{ id: string; level: number }>;
    },
    isPublic?: boolean,
  ): Promise<IProject> {
    const params: { public?: boolean } = {};
    if (isPublic !== undefined) {
      params.public = isPublic;
    }
    const response = await this.client.put(
      `project/${projectId}/access`,
      access,
      { params },
    );
    return toProject(response.data);
  }

  /**
   * Set whether a project is publicly visible.
   * Requires ADMIN access to the project.
   */
  async setProjectPublic(
    projectId: string,
    isPublic: boolean,
  ): Promise<IProject> {
    const response = await this.client.put(
      `project/${projectId}/public`,
      null,
      { params: { public: isPublic } },
    );
    return toProject(response.data);
  }
}
