import { RestClientInstance, IGirderSelectAble } from "@/girder";
import { logError } from "@/utils/log";
import store from "@/store";

/**
 * Interface for Zenodo file metadata
 */
export interface IZenodoFile {
  id: string;
  key: string;
  size: number;
  checksum: string;
  links: {
    self: string;
    download: string;
  };
}

/**
 * Interface for Zenodo record/dataset metadata
 */
export interface IZenodoRecord {
  id: string;
  conceptdoi: string;
  doi: string;
  title: string;
  description: string;
  created: string;
  updated: string;
  files: IZenodoFile[];
  metadata: {
    title: string;
    description: string;
    creators: Array<{
      name: string;
      affiliation?: string;
    }>;
    keywords?: string[];
    license?: {
      id: string;
    };
    publication_date: string;
  };
  links: {
    self: string;
    html: string;
    latest: string;
    latest_html: string;
    files: string;
  };
}

/**
 * Interface for Zenodo search results
 */
export interface IZenodoSearchResponse {
  hits: {
    hits: IZenodoRecord[];
    total: number;
  };
  links: {
    self: string;
    next?: string;
    prev?: string;
  };
}

/**
 * Interface for Zenodo community data
 */
export interface IZenodoCommunity {
  id: string;
  title: string;
  description: string;
  created: string;
  updated: string;
  logo_url: string;
  links: {
    self: string;
    html: string;
  };
}

/**
 * Interface for Zenodo community records response
 */
export interface ICommunityRecordsResponse {
  hits: {
    hits: IZenodoRecord[];
    total: number;
  };
  links: {
    self: string;
    next?: string;
    prev?: string;
  };
}

/**
 * Class for interacting with the Zenodo API
 */
export default class ZenodoAPI {
  private readonly baseUrl: string = "https://zenodo.org/api";
  private readonly client: RestClientInstance;

  constructor(client: RestClientInstance) {
    this.client = client;
  }

  /**
   * Search for datasets in Zenodo
   * @param query Search query
   * @param page Page number for pagination
   * @param size Number of results per page
   * @returns Promise with search results
   */
  async searchDatasets(
    query: string,
    page: number = 1,
    size: number = 10,
  ): Promise<IZenodoSearchResponse> {
    try {
      const url = `${this.baseUrl}/records?q=${encodeURIComponent(query)}&page=${page}&size=${size}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Zenodo API error: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      logError("Failed to search Zenodo", error);
      throw error;
    }
  }

  /**
   * Get a specific dataset from Zenodo by ID
   * @param id Zenodo record ID
   * @returns Promise with record details
   */
  async getDataset(id: string): Promise<IZenodoRecord> {
    try {
      const url = `${this.baseUrl}/records/${id}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Zenodo API error: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      logError(`Failed to get Zenodo dataset ${id}`, error);
      throw error;
    }
  }

  /**
   * Download a file from Zenodo with progress monitoring
   * @param url File download URL
   * @param onProgress Optional callback for download progress
   * @returns Promise with file blob
   */
  async downloadFile(
    url: string,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url);
      xhr.responseType = "blob";

      // Handle progress events
      xhr.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress(event.loaded, event.total);
        }
      };

      xhr.onload = function () {
        if (this.status >= 200 && this.status < 300) {
          resolve(xhr.response);
        } else {
          reject(new Error(`HTTP error ${this.status}: ${this.statusText}`));
        }
      };

      xhr.onerror = function () {
        reject(new Error("Network error occurred while downloading file"));
      };

      xhr.send();
    });
  }

  /**
   * Download and import a Zenodo dataset into Girder
   * @param datasetId Zenodo dataset ID
   * @param girderFolderId Destination folder ID in Girder
   * @param onProgress Optional callback for progress updates
   * @param customName Optional custom name for the dataset
   * @param customDescription Optional custom description for the dataset
   * @returns Promise with created dataset ID and file IDs
   */
  async importDataset(
    datasetId: string,
    girderFolderId: string,
    onProgress?: (current: number, total: number, filename: string) => void,
    customName?: string,
    customDescription?: string,
  ): Promise<{ datasetId: string; fileIds: string[] }> {
    try {
      // Fetch dataset information from Zenodo
      const dataset = await this.getDataset(datasetId);
      const fileIds: string[] = [];

      // Instead of fetching the folder object, create a minimal path object
      // This ensures we're using the same authentication flow as the rest of the app
      const simplePath = {
        _id: girderFolderId,
        _modelType: "folder",
      } as IGirderSelectAble;

      // Create dataset folder - use custom name/description if provided
      const createdDataset = await store.createDataset({
        name:
          customName || dataset.metadata.title || `Zenodo Dataset ${datasetId}`,
        description:
          customDescription ||
          dataset.metadata.description ||
          dataset.description ||
          "",
        path: simplePath,
      });

      if (!createdDataset || !createdDataset.id) {
        throw new Error("Failed to create dataset folder in Girder");
      }

      // Create a subfolder for non-image files
      const datasetFolder = {
        _id: createdDataset.id,
        _modelType: "folder",
      } as IGirderSelectAble;

      const additionalFilesFolder = await store.api.createFolder(
        "additionalZenodoFiles",
        datasetFolder,
      );

      // Filter image files
      const imageFiles = this.filterImageFiles(dataset.files);
      const nonImageFiles = dataset.files.filter(
        (file) => !imageFiles.some((imgFile) => imgFile.id === file.id),
      );

      // Upload image files to the main dataset folder
      for (let i = 0; i < imageFiles.length; i++) {
        const file = imageFiles[i];

        if (onProgress) {
          onProgress(i, dataset.files.length, file.key);
        }

        const blob = await this.downloadFile(
          file.links.download,
          (loaded, total) => {
            if (onProgress) {
              onProgress(
                i,
                dataset.files.length,
                `${file.key} (${Math.round((loaded / total) * 100)}%)`,
              );
            }
          },
        );
        const downloadedFile = new File([blob], file.key);

        // Upload to the created dataset folder
        const uploadResponse = await store.api.uploadFile(
          downloadedFile,
          createdDataset.id,
        );

        fileIds.push(uploadResponse.data._id);
      }

      // Upload non-image files to the additional files subfolder
      for (let i = 0; i < nonImageFiles.length; i++) {
        const file = nonImageFiles[i];
        const progressIndex = imageFiles.length + i;

        if (onProgress) {
          onProgress(progressIndex, dataset.files.length, file.key);
        }

        const blob = await this.downloadFile(
          file.links.download,
          (loaded, total) => {
            if (onProgress) {
              onProgress(
                progressIndex,
                dataset.files.length,
                `${file.key} (${Math.round((loaded / total) * 100)}%)`,
              );
            }
          },
        );
        const downloadedFile = new File([blob], file.key);

        // Upload to the additional files subfolder
        const uploadResponse = await store.api.uploadFile(
          downloadedFile,
          additionalFilesFolder._id,
        );

        // Still track these file IDs
        fileIds.push(uploadResponse.data._id);
      }

      if (onProgress) {
        onProgress(dataset.files.length, dataset.files.length, "Complete");
      }

      return {
        datasetId: createdDataset.id,
        fileIds,
      };
    } catch (error) {
      logError(`Failed to import Zenodo dataset ${datasetId}`, error);
      throw error;
    }
  }

  /**
   * Filter Zenodo files to only include image files suitable for NimbusImage
   * @param files Array of Zenodo files
   * @returns Filtered array containing only image files
   */
  filterImageFiles(files: IZenodoFile[]): IZenodoFile[] {
    const imageExtensions = [
      ".tif",
      ".tiff",
      ".jpg",
      ".jpeg",
      ".png",
      ".bmp",
      ".svs",
      ".nd2",
      ".ndpi",
      ".scn",
      ".czi",
      ".zvi",
      ".zarr",
      ".lif",
      ".ome.tif",
      ".ome.tiff",
    ];

    return files.filter((file) =>
      imageExtensions.some((ext) => file.key.toLowerCase().endsWith(ext)),
    );
  }

  /**
   * Get information about a community
   * @param communityId Community identifier
   * @returns Promise with community details
   */
  async getCommunity(communityId: string): Promise<IZenodoCommunity> {
    try {
      const url = `${this.baseUrl}/communities/${communityId}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Zenodo API error: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      logError(`Failed to get Zenodo community ${communityId}`, error);
      throw error;
    }
  }

  /**
   * Get datasets from a specific community
   * @param communityId Community identifier
   * @param page Page number for pagination
   * @param size Number of results per page
   * @returns Promise with community records
   */
  async getCommunityRecords(
    communityId: string,
    page: number = 1,
    size: number = 10,
  ): Promise<ICommunityRecordsResponse> {
    try {
      const url = `${this.baseUrl}/communities/${communityId}/records?page=${page}&size=${size}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Zenodo API error: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      logError(
        `Failed to get records for Zenodo community ${communityId}`,
        error,
      );
      throw error;
    }
  }
}
