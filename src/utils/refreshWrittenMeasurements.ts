import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";

/** A server write added or replaced property values: reload the property
 * list, the discovered value paths, the values themselves and the histograms.
 * The last two are what the worker-completion path runs; without them
 * propertyValuesRevision never moves and histograms, gates and the Objects
 * columns keep showing the old values. Stops between steps once `isLive`
 * turns false (the dataset changed) and returns whether it finished. */
export async function refreshWrittenMeasurements(
  isLive: () => boolean,
): Promise<boolean> {
  for (const step of [
    () => propertyStore.fetchProperties(),
    () => propertyStore.fetchPropertyPathsSample(),
    () => propertyStore.fetchPropertyValues(),
    () => filterStore.updateHistograms(),
  ]) {
    if (!isLive()) return false;
    await step();
  }
  return isLive();
}
