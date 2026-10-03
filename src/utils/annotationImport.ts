import store from "@/store";
import annotationStore from "@/store/annotation";
import propertyStore from "@/store/properties";
import { IAnnotationImportPayload, ISerializedData } from "@/store/model";
import { logError } from "@/utils/log";

export interface ImportOptions {
  importAnnotations: boolean;
  importConnections: boolean;
  importProperties: boolean;
  importValues: boolean;
  overwriteAnnotations: boolean;
  overwriteProperties: boolean;
}

export const defaultImportOptions: ImportOptions = {
  importAnnotations: true,
  importConnections: true,
  importProperties: true,
  importValues: true,
  overwriteAnnotations: false,
  overwriteProperties: false,
};

/**
 * Import annotations, connections, properties and values from serialized data.
 *
 * Annotations/connections in `serializedData` are raw documents as produced
 * by `GET /export/json` (identified by `_id`, not `id`); this function
 * passes them through to the backend as-is. The `annotation_import`
 * endpoint sanitizes those documents and remaps parent/child/property ids
 * server-side, rolling back everything it created if it fails. Only
 * properties are still created client-side, since creating a property also
 * needs to attach it to the current configuration via the properties store.
 *
 * @param serializedData The parsed JSON data containing annotations, connections, properties and values
 * @param options Import configuration options
 * @returns A promise that resolves when the import is complete
 */
export async function importAnnotationsFromData(
  serializedData: ISerializedData,
  options: ImportOptions = defaultImportOptions,
): Promise<void> {
  const {
    importAnnotations,
    importConnections,
    importProperties,
    importValues,
    overwriteAnnotations,
    overwriteProperties,
  } = options;

  // Check if a dataset is selected
  if (!store.dataset) {
    throw new Error("No dataset selected");
  }
  const datasetId = store.dataset.id;

  // Snapshot ids to remove if overwriting. These are only deleted once the
  // import has succeeded. annotationsForIteration (not annotations) so that
  // stub-only mode, where the full annotations[] array is empty, still
  // captures every annotation to overwrite.
  let annotationIdsToRemove: string[] = overwriteAnnotations
    ? annotationStore.annotationsForIteration.map(({ id }) => id)
    : [];
  let propertyIdsToRemove: string[] = overwriteProperties
    ? propertyStore.properties.map(({ id }) => id)
    : [];

  // Properties created so far, tracked so they can be rolled back if the
  // import fails partway through.
  const createdPropertyIds: string[] = [];

  try {
    // Import properties client-side, since creating a property also
    // attaches it to the current configuration.
    const propertyIdMap: { [oldPropertyId: string]: string } = {};
    if (importProperties) {
      for (const oldProperty of serializedData.annotationProperties) {
        const newProperty = await propertyStore.createProperty(oldProperty);
        if (!newProperty) {
          throw new Error("Failed to create property during import");
        }
        createdPropertyIds.push(newProperty.id);
        const oldPropertyId = oldProperty.id ?? oldProperty._id;
        if (oldPropertyId) {
          propertyIdMap[oldPropertyId] = newProperty.id;
        }
      }
    }

    // Build the payload for the backend import endpoint, only including
    // what was requested. Annotations/connections/values are passed through
    // untouched; the backend sanitizes and remaps them.
    if (importAnnotations) {
      const payload: IAnnotationImportPayload = {
        datasetId,
        annotations: serializedData.annotations,
      };
      if (importConnections) {
        payload.connections = serializedData.annotationConnections;
      }
      if (importValues && importProperties) {
        payload.propertyValues = serializedData.annotationPropertyValues;
        payload.propertyIdMap = propertyIdMap;
      }
      await store.annotationsAPI.importAnnotationData(payload);
    }
  } catch (error) {
    // The backend rolls back any annotations/connections/values it created,
    // so only the client-created properties need cleanup here. Since the
    // import failed, keep the pre-existing annotations/properties.
    annotationIdsToRemove = [];
    propertyIdsToRemove = [];
    try {
      await Promise.all(
        createdPropertyIds.map((propertyId) =>
          propertyStore.deleteProperty(propertyId),
        ),
      );
    } catch (e) {
      // Ignore cleanup errors so the original import error is re-thrown
    }
    throw error;
  } finally {
    if (annotationIdsToRemove.length > 0) {
      await store.annotationsAPI.deleteMultipleAnnotations(
        annotationIdsToRemove,
      );
    }
    for (const propertyId of propertyIdsToRemove) {
      await propertyStore.deleteProperty(propertyId);
    }

    // Refresh data
    await Promise.all([
      annotationStore.fetchAnnotations(),
      propertyStore.fetchPropertyValues(),
      propertyStore.fetchProperties(),
    ]);
  }
}

/**
 * Import annotations from a JSON file
 * @param file JSON file containing the serialized annotation data
 * @param options Import configuration options
 * @returns A promise that resolves when the import is complete
 */
export async function importAnnotationsFromFile(
  file: File,
  options: ImportOptions = defaultImportOptions,
): Promise<void> {
  try {
    const jsonText = await file.text();
    const serializedData = JSON.parse(jsonText) as ISerializedData;
    return importAnnotationsFromData(serializedData, options);
  } catch (error) {
    logError("Error importing annotations from file:", error);
    throw error;
  }
}
