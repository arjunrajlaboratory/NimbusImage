import { IToolConfiguration } from "@/store/model";

// Pure helpers for the Tools palette's pinned/annotation/analysis sections.
// The configuration stores ONE ordered tools array; each section shows its
// tools in that array's order, and reordering a section refills only the
// array slots that section's tools occupy, so the other sections keep their
// relative order.

// Worker tools (type "segmentation") open a configuration dialog; everything
// else is used directly on the canvas.
export const WORKER_TOOL_TYPE = "segmentation";

export type TToolGroupKey = "pinned" | "annotation" | "analysis";

export interface IToolGroup {
  key: TToolGroupKey;
  label: string;
  tools: IToolConfiguration[];
}

export function groupTools(
  tools: readonly (IToolConfiguration | null | undefined)[],
): IToolGroup[] {
  const pinned: IToolConfiguration[] = [];
  const annotation: IToolConfiguration[] = [];
  const analysis: IToolConfiguration[] = [];
  for (const tool of tools) {
    if (!tool) {
      continue;
    }
    if (tool.pinned) {
      pinned.push(tool);
    } else if (tool.type === WORKER_TOOL_TYPE) {
      analysis.push(tool);
    } else {
      annotation.push(tool);
    }
  }
  const groups: IToolGroup[] = [
    { key: "pinned", label: "Pinned", tools: pinned },
    { key: "annotation", label: "Annotation tools", tools: annotation },
    { key: "analysis", label: "Analysis tools", tools: analysis },
  ];
  return groups.filter((group) => group.tools.length > 0);
}

// Returns the full tool id order after one section was reordered to
// `reorderedSectionIds`, or null when the section no longer matches `toolIds`
// (a tool was added or removed while the drag was in flight). Slots held by
// tools outside the section are left untouched.
export function reorderSection(
  toolIds: readonly string[],
  reorderedSectionIds: readonly string[],
): string[] | null {
  const sectionIds = new Set(reorderedSectionIds);
  if (sectionIds.size !== reorderedSectionIds.length) {
    return null;
  }
  const slots: number[] = [];
  toolIds.forEach((id, index) => {
    if (sectionIds.has(id)) {
      slots.push(index);
    }
  });
  if (slots.length !== sectionIds.size) {
    return null;
  }
  const result = [...toolIds];
  slots.forEach((slot, i) => {
    result[slot] = reorderedSectionIds[i];
  });
  return result;
}
