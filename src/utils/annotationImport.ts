import store from "@/store";
import annotationStore from "@/store/annotation";
import propertyStore from "@/store/properties";
import {
  IAnnotation,
  IAnnotationBase,
  IAnnotationConnection,
  IAnnotationConnectionBase,
  IAnnotationProperty,
  IAnnotationPropertyValues,
  ISerializedData,
  TPropertyValue,
} from "@/store/model";
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
 * Import annotations, connections, properties and values from serialized data
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

  // Prepare annotation IDs to remove (if overwriting)
  let annotationIdsToRemove: string[] = [];
  if (overwriteAnnotations) {
    for (const { id } of annotationStore.annotations) {
      annotationIdsToRemove.push(id);
    }
  }

  // Prepare property IDs to remove (if overwriting)
  let propertyIdsToRemove: string[] = [];
  if (overwriteProperties) {
    for (const { id } of propertyStore.properties) {
      propertyIdsToRemove.push(id);
    }
  }

  // Import annotations
  // promise of: old annotation id -> new annotation
  let allAnnotationsPromise: Promise<Map<string, IAnnotation>> =
    Promise.resolve(new Map());
  if (importAnnotations) {
    const annotationBaseList: IAnnotationBase[] = [];
    for (
      let arrayIdx = 0;
      arrayIdx < serializedData.annotations.length;
      arrayIdx++
    ) {
      const oldAnnotation = serializedData.annotations[arrayIdx];
      const newAnnotation: IAnnotationBase = {
        tags: oldAnnotation.tags,
        shape: oldAnnotation.shape,
        channel: oldAnnotation.channel,
        location: oldAnnotation.location,
        coordinates: oldAnnotation.coordinates,
        color: oldAnnotation.color ?? null,
        datasetId: store.dataset.id,
      };

      // Check if the 'color' property exists in the old annotation and add it to the new annotation
      if (oldAnnotation.color) {
        newAnnotation.color = oldAnnotation.color;
      }

      annotationBaseList.push(newAnnotation);
    }
    allAnnotationsPromise = store.annotationsAPI
      .createMultipleAnnotations(annotationBaseList)
      .then((newAnnotations) => {
        const oldIdToNewAnnotation: Map<string, IAnnotation> = new Map();
        if (newAnnotations === null) {
          return oldIdToNewAnnotation;
        }
        for (
          let arrayIdx = 0;
          arrayIdx < serializedData.annotations.length;
          arrayIdx++
        ) {
          const oldAnnotation = serializedData.annotations[arrayIdx];
          const newAnnotation = newAnnotations[arrayIdx];
          oldIdToNewAnnotation.set(oldAnnotation.id, newAnnotation);
        }
        return oldIdToNewAnnotation;
      });
  }

  // Import annotation connections
  let allConnectionsPromise: Promise<IAnnotationConnection[] | null> =
    Promise.resolve(null);
  if (importAnnotations && importConnections) {
    // Need all annotations to be sent before sending connections
    allConnectionsPromise = allAnnotationsPromise.then(
      (oldIdToNewAnnotation) => {
        const annotationConnectionBaseList: IAnnotationConnectionBase[] = [];
        for (const connection of serializedData.annotationConnections) {
          const parent = oldIdToNewAnnotation.get(connection.parentId);
          const child = oldIdToNewAnnotation.get(connection.childId);
          if (parent && child) {
            annotationConnectionBaseList.push({
              parentId: parent.id,
              childId: child.id,
              label: connection.label,
              tags: connection.tags,
              datasetId: store.dataset!.id,
            });
          } else {
            throw "Can't find the parent or the child of the connection to create";
          }
        }
        return store.annotationsAPI.createMultipleConnections(
          annotationConnectionBaseList,
        );
      },
    );
  }

  // Import properties
  const propertyPromises: Promise<IAnnotationProperty>[] = [];
  const propertyOldIdToIdx: { [oldId: string]: number } = {};
  if (importProperties) {
    for (const oldProperty of serializedData.annotationProperties) {
      // Use this function to make sure that the property is added to the configuration
      const newPropertyPromise = propertyStore.createProperty(oldProperty);
      const idx = propertyPromises.push(newPropertyPromise) - 1;
      propertyOldIdToIdx[oldProperty.id] = idx;
    }
  }
  const allPropertiesPromise = Promise.all(propertyPromises);

  // Import annotation values for properties
  const newValueDonePromises: Promise<any>[] = [];
  if (importValues && importProperties && importAnnotations) {
    // Need annotations and properties to be sent before sending values
    const valuesPromise = Promise.all([
      allAnnotationsPromise,
      allPropertiesPromise,
    ]).then(([oldIdToNewAnnotation, newProperties]) => {
      const aggregatedPropertyValues: {
        datasetId: string;
        annotationId: string;
        values: { [propertyId: string]: TPropertyValue };
      }[] = [];
      for (const oldAnnotationId in serializedData.annotationPropertyValues) {
        const newAnnotation = oldIdToNewAnnotation.get(oldAnnotationId);
        if (!newAnnotation) {
          throw "Can't find the annotation having the values";
        }
        const oldAnnotationValues =
          serializedData.annotationPropertyValues[oldAnnotationId];
        const newValues: IAnnotationPropertyValues[string] = {};
        for (const oldPropertyId in oldAnnotationValues) {
          const newProperty = newProperties[propertyOldIdToIdx[oldPropertyId]];
          const value = oldAnnotationValues[oldPropertyId];
          newValues[newProperty.id] = value;
        }
        aggregatedPropertyValues.push({
          datasetId: newAnnotation.datasetId,
          annotationId: newAnnotation.id,
          values: newValues,
        });
      }
      return store.propertiesAPI.addAggregatedPropertyValues(
        aggregatedPropertyValues,
      );
    });
    newValueDonePromises.push(valuesPromise);
  }
  const allValuesDonePromise = Promise.all(newValueDonePromises);

  try {
    // Wait for all imports to complete
    await Promise.all([
      allAnnotationsPromise,
      allPropertiesPromise,
      allConnectionsPromise,
      allValuesDonePromise,
    ]);
  } catch (error) {
    // Error recovery - don't remove existing annotations and properties
    annotationIdsToRemove = [];
    propertyIdsToRemove = [];

    // Remove imported annotations if possible
    try {
      const oldIdToNewAnnotation = await allAnnotationsPromise;
      for (const { id } of oldIdToNewAnnotation.values()) {
        annotationIdsToRemove.push(id);
      }
    } catch (e) {
      // Ignore errors during cleanup
    }

    // Remove imported properties if possible
    try {
      await Promise.all(
        propertyPromises.map(async (propertyPromise) => {
          try {
            const { id } = await propertyPromise;
            propertyIdsToRemove.push(id);
          } catch (e) {
            // Ignore errors during cleanup
          }
        }),
      );
    } catch (e) {
      // Ignore errors during cleanup
    }

    // Re-throw the original error
    throw error;
  } finally {
    // Remove annotations and properties if needed
    const finalCleanupPromises: Promise<any>[] = [];
    if (annotationIdsToRemove.length > 0) {
      finalCleanupPromises.push(
        store.annotationsAPI.deleteMultipleAnnotations(annotationIdsToRemove),
      );
    }
    if (propertyIdsToRemove.length > 0) {
      for (const id of propertyIdsToRemove) {
        finalCleanupPromises.push(propertyStore.deleteProperty(id));
      }
    }

    await Promise.all(finalCleanupPromises);

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
