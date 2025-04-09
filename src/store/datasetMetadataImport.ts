import {
  VuexModule,
  Module,
  Mutation,
  Action,
  getModule,
} from "vuex-module-decorators";
import store from "./root";
import { ISerializedData } from "./model";
import { logError } from "@/utils/log";

/**
 * Store module for handling dataset metadata import from external sources
 * This is used to store reference to non-image files (like JSON files with annotations, configs, etc.)
 * that will be applied to a dataset after it has been created
 */
interface IDatasetMetadataImportState {
  // Raw file references
  annotationFile: File | null;
  collectionFile: File | null;

  // Parsed file contents
  annotationData: ISerializedData | null;
  collectionData: any | null; // Using any for now as collection format may vary

  // Processing state
  datasetId: string | null;
  isLoading: boolean;
}

@Module({ dynamic: true, store, name: "datasetMetadataImport" })
class DatasetMetadataImport
  extends VuexModule
  implements IDatasetMetadataImportState
{
  // Raw file references
  annotationFile: File | null = null;
  collectionFile: File | null = null;

  // Parsed file contents
  annotationData: ISerializedData | null = null;
  collectionData: any | null = null;

  // Processing state
  datasetId: string | null = null;
  isLoading: boolean = false;

  @Mutation
  setAnnotationFile(file: File | null) {
    this.annotationFile = file;
  }

  @Mutation
  setCollectionFile(file: File | null) {
    this.collectionFile = file;
  }

  @Mutation
  setAnnotationData(data: ISerializedData | null) {
    this.annotationData = data;
  }

  @Mutation
  setCollectionData(data: any | null) {
    this.collectionData = data;
  }

  @Mutation
  setDatasetId(id: string | null) {
    this.datasetId = id;
  }

  @Mutation
  setIsLoading(loading: boolean) {
    this.isLoading = loading;
  }

  @Action
  async parseAnnotationFile() {
    if (!this.annotationFile) {
      return;
    }

    this.setIsLoading(true);
    try {
      const text = await this.annotationFile.text();
      const data = JSON.parse(text) as ISerializedData;
      this.setAnnotationData(data);
    } catch (error) {
      logError("Failed to parse annotation file", error);
      this.setAnnotationData(null);
    } finally {
      this.setIsLoading(false);
    }
  }

  @Action
  async parseCollectionFile() {
    if (!this.collectionFile) {
      return;
    }

    this.setIsLoading(true);
    try {
      const text = await this.collectionFile.text();
      const data = JSON.parse(text);
      this.setCollectionData(data);
    } catch (error) {
      logError("Failed to parse collection file", error);
      this.setCollectionData(null);
    } finally {
      this.setIsLoading(false);
    }
  }

  @Action
  storeAnnotationFile(file: File | null) {
    this.setAnnotationFile(file);
    if (file) {
      this.parseAnnotationFile();
    } else {
      this.setAnnotationData(null);
    }
  }

  @Action
  storeCollectionFile(file: File | null) {
    this.setCollectionFile(file);
    if (file) {
      this.parseCollectionFile();
    } else {
      this.setCollectionData(null);
    }
  }

  @Action
  clearAnnotationFile() {
    this.setAnnotationFile(null);
    this.setAnnotationData(null);
  }

  @Action
  clearCollectionFile() {
    this.setCollectionFile(null);
    this.setCollectionData(null);
  }

  @Action
  clearAllFiles() {
    this.setAnnotationFile(null);
    this.setAnnotationData(null);
    this.setCollectionFile(null);
    this.setCollectionData(null);
  }

  @Action
  setTargetDataset(id: string | null) {
    this.setDatasetId(id);
  }

  /**
   * Check if any metadata files are available for import
   */
  get hasMetadataFiles(): boolean {
    return !!(this.annotationFile || this.collectionFile);
  }

  /**
   * Convenience getter to check if annotation data is ready
   */
  get hasAnnotationData(): boolean {
    return !!this.annotationData;
  }

  /**
   * Convenience getter to check if collection data is ready
   */
  get hasCollectionData(): boolean {
    return !!this.collectionData;
  }
}

export default getModule(DatasetMetadataImport);
