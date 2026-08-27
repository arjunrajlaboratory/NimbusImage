import propertyStore from "@/store/properties";
import { IAnnotationProperty, IErrorInfoList } from "@/store/model";

/**
 * Start a property computation with a fresh errorInfo registered on the
 * property's status (the same pattern as Property.vue's Run button), so every
 * surface that reads the status — the Measure dialog rows and the
 * Measurements tab alerts — sees failures from this run.
 *
 * No-ops while the property is already running.
 */
export function computePropertyWithStatus(property: IAnnotationProperty) {
  if (propertyStore.propertyStatuses[property.id]?.running) {
    return;
  }
  const errorInfo: IErrorInfoList = { errors: [] };
  if (!propertyStore.propertyStatuses[property.id]) {
    propertyStore.propertyStatuses[property.id] = {
      running: false,
      previousRun: null,
      progressInfo: {},
      errorInfo,
    };
  }
  propertyStore.propertyStatuses[property.id].errorInfo = errorInfo;
  return propertyStore.computeProperty({ property, errorInfo });
}
