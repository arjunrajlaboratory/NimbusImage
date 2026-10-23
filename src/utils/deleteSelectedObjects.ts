import annotationStore from "@/store/annotation";
import annotationListServer from "@/store/annotationListServer";

/**
 * Delete the selected objects, in either Object Browser list mode. Shared by
 * the list's Delete button, the mod+backspace hotkey and the palette command.
 * In server mode the client annotation set is empty, so the store action
 * would delete nothing: delete the selected ids directly, clear the
 * selection, and refresh the server page so the deleted rows drop out.
 */
export async function deleteSelectedObjects() {
  if (annotationStore.isListServerMode) {
    await annotationStore.deleteAnnotations([
      ...annotationStore.selectedAnnotationIds,
    ]);
    annotationStore.setSelected([]);
    await annotationListServer.fetchPage();
    return;
  }
  annotationStore.deleteSelectedAnnotations();
}
