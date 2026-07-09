/**
 * Shared "accept putative proposals" helper for the example-based
 * segmentation tool menus (ExampleSegmentationToolMenu and
 * SamSimilarityToolMenu). See
 * codebaseDocumentation/EXAMPLE_SEGMENTATION_TOOL.md §5.5 / §11.5.
 */
import store from "@/store";
import annotationStore from "@/store/annotation";
import {
  IAnnotationBase,
  IGeoJSPosition,
  IToolConfiguration,
} from "@/store/model";

/**
 * Commits putative proposal polygons as real annotations in a single batch,
 * using the tool's configured tags/shape/color and its current
 * location/channel. Returns false when there is nothing to commit (no
 * proposals or no current dataset).
 */
export async function acceptProposalsFromTool(
  toolConfiguration: IToolConfiguration,
  proposals: IGeoJSPosition[][],
): Promise<boolean> {
  const datasetId = store.dataset?.id;
  if (proposals.length === 0 || !datasetId) {
    return false;
  }
  const { location, channel } =
    await annotationStore.getAnnotationLocationFromTool(toolConfiguration);
  const { tags, shape, color } = toolConfiguration.values.annotation;
  const annotationBases: IAnnotationBase[] = proposals.map((coordinates) => ({
    tags,
    shape,
    channel,
    location,
    coordinates,
    datasetId,
    color: color ?? null,
  }));
  await annotationStore.createMultipleAnnotations(annotationBases);
  return true;
}
