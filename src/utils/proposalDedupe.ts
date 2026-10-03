/**
 * Shared "putative proposal" dedupe helper for the example-based
 * auto-segmentation tools (classifier variant in
 * src/pipelines/exampleSegmentationPipeline.ts and the SAM-embedding
 * similarity variant in src/pipelines/samSimilarityPipeline.ts). See
 * codebaseDocumentation/EXAMPLE_SEGMENTATION_TOOL.md §4.4 step 7 / §10.
 */
import geojs from "geojs";
import { IGeoJSPosition, IToolConfiguration } from "@/store/model";
import { simpleCentroid } from "@/utils/annotation";

/**
 * Drops proposals whose centroid lies inside an existing annotation that (a)
 * is at the tool's current location (XY/Z/Time per the tool's location
 * config) and (b) shares at least one tag with the tool's configured tags.
 * This is what makes the roam-and-accept workflow idempotent: accepted
 * objects are not re-proposed.
 *
 * The annotation store is imported dynamically (rather than statically) to
 * avoid introducing a load-time circular dependency: this helper is called
 * from pipeline modules that are imported from src/store/index.ts, and
 * src/store/annotation.ts reads `main.annotationsAPI` eagerly at module load
 * time, so pulling it in statically here would risk `main` being undefined
 * during that cycle (the same pattern is used in src/store/jobs.ts for the
 * same reason).
 */
export async function dedupeProposalsAgainstAnnotations(
  proposals: IGeoJSPosition[][],
  toolConfiguration: IToolConfiguration,
): Promise<IGeoJSPosition[][]> {
  if (proposals.length === 0) {
    return proposals;
  }
  const { default: annotationStore } = await import("@/store/annotation");
  const { location } =
    await annotationStore.getAnnotationLocationFromTool(toolConfiguration);
  const toolTags: string[] = toolConfiguration.values.annotation?.tags ?? [];
  const overlappingAnnotations = annotationStore.annotations.filter(
    (existing) =>
      existing.location.XY === location.XY &&
      existing.location.Z === location.Z &&
      existing.location.Time === location.Time &&
      existing.tags.some((tag) => toolTags.includes(tag)),
  );
  if (overlappingAnnotations.length === 0) {
    return proposals;
  }
  return proposals.filter((proposal) => {
    const centroid = simpleCentroid(proposal);
    return !overlappingAnnotations.some((existing) =>
      geojs.util.pointInPolygon(centroid, existing.coordinates),
    );
  });
}
