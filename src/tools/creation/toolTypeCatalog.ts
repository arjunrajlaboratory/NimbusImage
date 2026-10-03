import {
  AnnotationShape,
  IToolTemplate,
  IWorkerImageList,
} from "@/store/model";
import { getTourAnchorId } from "@/utils/strings";
import { IAnnotationSetup } from "./templates/AnnotationConfiguration.vue";

// The "Add new tool" catalog as cards: every creatable tool, built from the
// tool templates (public/config/templates.json) and the registered worker
// images. Shared by the tool-type dialog (ToolTypeSelection.vue) and the
// command palette, so a card and its "Add … tool" command can never disagree.

export interface IToolTypeItem {
  text: string;
  description?: string;
  value: any;
  key: string;
  [key: string]: any;
}

export interface IToolTypeSubmenu {
  template: any;
  submenuInterface: any;
  submenuInterfaceIdx: any;
  items: IToolTypeItem[];
  displayName?: string;
  isWorker?: boolean;
}

export interface IAugmentedToolTypeItem extends IToolTypeItem {
  submenu: IToolTypeSubmenu;
}

/** What selecting a card hands to ToolCreation (`initialSelectedTool`). */
export interface TReturnType {
  template: IToolTemplate | null;
  defaultValues: any;
  selectedItem: IAugmentedToolTypeItem | null;
}

// Templates and items the catalog never offers.
export const HIDDEN_TOOL_TEXTS = new Set<string>([
  '"Snap to" manual annotation tools',
  "Annotation edit tools",
]);

export function categoryName(submenu: IToolTypeSubmenu): string {
  return submenu.displayName ?? submenu.template.name;
}

export function categoryAnchorId(submenu: IToolTypeSubmenu): string {
  return "tool-category-" + getTourAnchorId(categoryName(submenu));
}

function createDockerImageSubmenus(
  template: any,
  submenuInterface: any,
  submenuInterfaceIdx: number,
  workerImageList: IWorkerImageList,
): IToolTypeSubmenu[] {
  const itemsByCategory: {
    [category: string]: Omit<IToolTypeItem, "key">[];
  } = {};
  const annotationInterface = template.interface.find(
    (elem: any) => elem.type === "annotation",
  );

  for (const image in workerImageList) {
    const labels = workerImageList[image];
    if (labels.isAnnotationWorker !== undefined) {
      const category = labels.interfaceCategory || "Other Automated Tools";
      if (!itemsByCategory[category]) {
        itemsByCategory[category] = [];
      }
      const annotationSetupDefault: Partial<IAnnotationSetup> = {
        shape: labels.annotationShape ?? AnnotationShape.Point,
      };
      itemsByCategory[category].push({
        text: labels.interfaceName || image,
        description: labels.description || "",
        image,
        value: {
          [submenuInterface.id]: { image },
          [annotationInterface.id]: annotationSetupDefault,
        },
      });
    }
  }

  const categories = Object.keys(itemsByCategory).sort();
  return categories.map((category) => {
    const items = itemsByCategory[category];
    const keydItems: IToolTypeItem[] = items
      .filter((item) => !HIDDEN_TOOL_TEXTS.has(item.text))
      .map(
        (item, itemIdx) =>
          ({
            key: `${template.type}-${category}#${itemIdx}`,
            ...item,
          }) as IToolTypeItem,
      );

    return {
      template,
      submenuInterface,
      submenuInterfaceIdx,
      items: keydItems,
      displayName: category,
      isWorker: true,
    };
  });
}

/** Every category of creatable tool, with its cards. */
export function buildToolTypeSubmenus(
  templates: IToolTemplate[],
  workerImageList: IWorkerImageList,
  availableToolShapes: { text: string; value: string }[],
): IToolTypeSubmenu[] {
  return templates
    .filter((template) => !HIDDEN_TOOL_TEXTS.has(template.name))
    .flatMap((template) => {
      const submenuInterfaceIdx = template.interface.findIndex(
        (elem: any) => elem.isSubmenu,
      );
      const submenuInterface: any =
        template.interface[submenuInterfaceIdx] || {};
      let items: Omit<IToolTypeItem, "key">[] = [];

      if (submenuInterface.type === "dockerImage") {
        return createDockerImageSubmenus(
          template,
          submenuInterface,
          submenuInterfaceIdx,
          workerImageList,
        );
      }

      switch (submenuInterface.type) {
        case "annotation":
          items = availableToolShapes;
          break;
        case "select":
          items = submenuInterface.meta.items.map((item: any) => ({
            ...item,
            value: { [submenuInterface.id]: item },
          }));
          break;
        default:
          items.push({
            text: template.name || "No Submenu",
            value: { [submenuInterface.id]: "defaultSubmenu" },
          });
          break;
      }

      const keydItems: IToolTypeItem[] = items
        .filter((item) => !HIDDEN_TOOL_TEXTS.has(item.text))
        .map(
          (item, itemIdx) =>
            ({
              key: template.type + "#" + itemIdx,
              ...item,
            }) as IToolTypeItem,
        );

      return {
        template,
        submenuInterface,
        submenuInterfaceIdx,
        items: keydItems,
      };
    });
}

/**
 * What selecting `item` hands to ToolCreation: the template with the submenu
 * element consumed, plus the values that element implied.
 */
export function buildToolTypeSelection(
  item: IAugmentedToolTypeItem,
): TReturnType {
  const { template, submenuInterface, submenuInterfaceIdx } = item.submenu;

  let computedTemplate = template;
  let defaultValues: any = {};

  switch (submenuInterface.type) {
    case "select":
    case "dockerImage":
      computedTemplate = {
        ...template,
        interface: [
          ...template.interface.slice(0, submenuInterfaceIdx),
          ...template.interface.slice(submenuInterfaceIdx + 1),
        ],
      };
      defaultValues = item.value;
      break;
    case "annotation": {
      computedTemplate = {
        ...template,
        interface: template.interface.slice(),
      };
      // Copy `meta` too: writing into the template's own meta object would
      // leak this card's shape into the shared template list.
      const annotationInterface = template.interface[submenuInterfaceIdx];
      computedTemplate.interface[submenuInterfaceIdx] = {
        ...annotationInterface,
        meta: {
          ...(annotationInterface.meta ?? {}),
          hideShape: true,
          defaultShape: item.value,
        },
      };
      break;
    }
    default:
      break;
  }

  return {
    template: computedTemplate,
    defaultValues,
    selectedItem: item,
  };
}
