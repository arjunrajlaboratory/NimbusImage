import store from "@/store";
import annotationStore from "@/store/annotation";
import propertyStore from "@/store/properties";
import pipelinesStore, { IPipelineStepLink } from "@/store/pipelines";
import progress from "@/store/progress";
import {
  IAnnotationBase,
  IPipeline,
  NotificationType,
  IAnnotationImportPayload,
  ISerializedData,
} from "@/store/model";
import { batchAnnotationBases } from "@/utils/geojson";
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

// A pipeline step that uses a property "Overwrite properties" would remove.
export interface IOverwrittenPropertyLink extends IPipelineStepLink {
  propertyId: string;
  propertyName: string;
}

/**
 * The pipeline steps that use a property an overwrite would remove (every
 * property in the configuration). Removing a property makes each of them
 * create a new pipeline-owned property on its next run, so the import dialog
 * names them before the import starts.
 */
export function pipelineStepsUsingOverwrittenProperties(): IOverwrittenPropertyLink[] {
  return propertyStore.properties.flatMap(({ id, name }) =>
    pipelinesStore
      .pipelineStepsLinkedToProperty(id)
      .map((link) => ({ ...link, propertyId: id, propertyName: name })),
  );
}

/**
 * The running pipeline (single run or batch) that computes one of
 * `propertyIds`, with the name of the first such property, or null. Removing
 * that property mid-run would split the run's results between it and a new
 * property the remaining steps or datasets create.
 */
export function runningPipelineComputingOverwrittenProperty(
  propertyIds: string[] = propertyStore.properties.map(({ id }) => id),
): { pipeline: IPipeline; propertyName: string } | null {
  for (const propertyId of propertyIds) {
    const pipeline =
      pipelinesStore.runningPipelineComputingProperty(propertyId);
    if (pipeline) {
      const propertyName =
        propertyStore.getPropertyById(propertyId)?.name ?? propertyId;
      return { pipeline, propertyName };
    }
  }
  return null;
}

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
 * "Overwrite properties" is refused while a running pipeline computes one of
 * the properties it would remove, and a property such a pipeline started
 * computing during the import is kept (with a warning notification).
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

  if (overwriteProperties) {
    const running = runningPipelineComputingOverwrittenProperty();
    if (running) {
      throw new Error(
        `The pipeline "${running.pipeline.name}" is running and computes ` +
          `the property "${running.propertyName}". Wait for it to finish, ` +
          "or cancel it, before overwriting properties.",
      );
    }
  }

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
    // Re-checked here: a pipeline may have started during the import, and
    // removing a property it computes would split that run's results.
    const removableIds = propertyIdsToRemove.filter((propertyId) => {
      const running = runningPipelineComputingOverwrittenProperty([propertyId]);
      if (running) {
        progress.createNotification({
          type: NotificationType.WARNING,
          title: "Property not overwritten",
          message:
            `"${running.propertyName}" was kept: the pipeline ` +
            `"${running.pipeline.name}" started computing it during the ` +
            "import. Remove it once the run ends if you no longer need it.",
        });
      }
      return !running;
    });
    if (removableIds.length > 0) {
      // One configuration sync for all of them.
      await propertyStore.deleteProperties(removableIds);
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

/**
 * Create annotations parsed from a GeoJSON file, in batches through the
 * batch create endpoint, then refresh the annotation store the way the JSON
 * import does.
 *
 * All or nothing: if a batch fails, the batches already created are deleted
 * (one batch delete) before the error is re-thrown, so a failed import never
 * leaves a partial region layer behind.
 *
 * @returns The number of annotations created.
 */
export async function importGeoJsonAnnotations(
  annotationBases: IAnnotationBase[],
  onProgress?: (created: number, total: number) => void,
): Promise<number> {
  const createdIds: string[] = [];
  try {
    for (const batch of batchAnnotationBases(annotationBases)) {
      const created =
        await store.annotationsAPI.createMultipleAnnotations(batch);
      if (!created) {
        throw new Error(
          `Creating annotations failed after ${createdIds.length} of ` +
            `${annotationBases.length}; nothing was imported.`,
        );
      }
      createdIds.push(...created.map(({ id }) => id));
      onProgress?.(createdIds.length, annotationBases.length);
    }
  } catch (error) {
    if (createdIds.length > 0) {
      try {
        await store.annotationsAPI.deleteMultipleAnnotations(createdIds);
      } catch (cleanupError) {
        logError("Error rolling back a failed GeoJSON import:", cleanupError);
      }
    }
    throw error;
  } finally {
    await annotationStore.fetchAnnotations();
  }
  return createdIds.length;
}
