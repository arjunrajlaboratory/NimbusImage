<template>
  <v-container class="pa-2">
    <v-card class="tool-type-menu">
      <v-card-title class="text-h6 py-2"> Select Tool Type </v-card-title>

      <v-card-text class="pa-2">
        <v-row dense>
          <template v-for="(item, itemIndex) in submenuItems">
            <!-- Headers become section titles -->
            <v-col
              v-if="'header' in item"
              :key="item.header"
              cols="12"
              class="pt-2 pb-1"
            >
              <div class="text-subtitle-1 font-weight-medium">
                {{ item.header }}
              </div>
            </v-col>

            <!-- Dividers span full width -->
            <v-col
              v-else-if="'divider' in item"
              :key="`divider-${itemIndex}`"
              cols="12"
              class="py-0"
            >
              <v-divider />
            </v-col>

            <!-- Tool type options become cards -->
            <v-col
              v-else-if="'key' in item"
              :key="item.key"
              cols="6"
              sm="4"
              md="3"
              lg="2"
              class="pa-1"
            >
              <v-card
                outlined
                :id="getTourStepId(item.text)"
                v-tour-trigger="getTourTriggerId(item.text)"
                @click="selectItem(item)"
                class="tool-type-card"
                hover
              >
                <v-card-title class="text-body-2 pa-2">
                  {{ item.text }}
                </v-card-title>
                <v-card-text
                  v-if="item.description"
                  class="text-caption pa-2 pt-0 description"
                >
                  {{ item.description }}
                </v-card-text>
              </v-card>
            </v-col>
          </template>
        </v-row>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script lang="ts">
import { Vue, Component } from "vue-property-decorator";
import propertiesStore from "@/store/properties";
import store from "@/store";
import { AnnotationShape, IToolTemplate } from "@/store/model";
import { getTourStepId, getTourTriggerId } from "@/utils/strings";
import { IAnnotationSetup } from "./templates/AnnotationConfiguration.vue";

interface Item {
  text: string;
  description?: string;
  value: any;
  key: string;
  [key: string]: any;
}

interface Submenu {
  template: any;
  submenuInterface: any;
  submenuInterfaceIdx: any;
  items: Item[];
  displayName?: string; // Override template.name for display (used for dynamic categories)
}

interface AugmentedItem extends Item {
  submenu: Submenu;
}

export interface TReturnType {
  template: IToolTemplate | null;
  defaultValues: any;
  selectedItem: AugmentedItem | null;
}

// This functionality is here to keep some tool types hidden from the user,
// but available for later implementation.
const hiddenToolTexts = new Set<string>([
  '"Snap to" manual annotation tools',
  "Annotation edit tools",
]);

@Component
export default class ToolTypeSelection extends Vue {
  readonly propertyStore = propertiesStore;
  readonly store = store;

  selectedItem: AugmentedItem | null = null;
  computedTemplate: IToolTemplate | null = null;
  defaultToolValues: any = {};

  getTourStepId = getTourStepId;
  getTourTriggerId = getTourTriggerId;

  get submenuItems() {
    return this.submenus.reduce(
      (items, submenu) => [
        ...items,
        { divider: true },
        { header: submenu.displayName ?? submenu.template.name },
        ...submenu.items.map((item) => ({ ...item, submenu }) as AugmentedItem),
      ],
      [] as (AugmentedItem | { divider: boolean } | { header: string })[],
    );
  }

  get submenus(): Submenu[] {
    return this.templates
      .filter((template) => !hiddenToolTexts.has(template.name))
      .flatMap((template) => {
        const submenuInterfaceIdx = template.interface.findIndex(
          (elem: any) => elem.isSubmenu,
        );
        const submenuInterface = template.interface[submenuInterfaceIdx] || {};
        let items: Omit<Item, "key">[] = [];

        // For dockerImage type, we create multiple submenus (one per category)
        if (submenuInterface.type === "dockerImage") {
          return this.createDockerImageSubmenus(
            template,
            submenuInterface,
            submenuInterfaceIdx,
          );
        }

        switch (submenuInterface.type) {
          case "annotation":
            items = this.store.availableToolShapes;
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
        const keydItems: Item[] = items
          .filter((item) => !hiddenToolTexts.has(item.text))
          .map(
            (item, itemIdx) =>
              ({
                key: template.type + "#" + itemIdx,
                ...item,
              }) as Item,
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
   * Creates multiple submenus for docker workers, grouped by interfaceCategory.
   * Each category becomes its own section in the tool type selection UI.
   */
  createDockerImageSubmenus(
    template: any,
    submenuInterface: any,
    submenuInterfaceIdx: number,
  ): Submenu[] {
    // Group workers by interfaceCategory
    const itemsByCategory: { [category: string]: Omit<Item, "key">[] } = {};
    const annotationInterface = template.interface.find(
      (elem: any) => elem.type === "annotation",
    );

    for (const image in this.propertyStore.workerImageList) {
      const labels = this.propertyStore.workerImageList[image];
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
          value: {
            [submenuInterface.id]: { image },
            [annotationInterface.id]: annotationSetupDefault,
          },
        });
      }
    }

    // Create a submenu for each category
    const categories = Object.keys(itemsByCategory).sort();
    return categories.map((category) => {
      const items = itemsByCategory[category];
      const keydItems: Item[] = items
        .filter((item) => !hiddenToolTexts.has(item.text))
        .map(
          (item, itemIdx) =>
            ({
              key: `${template.type}-${category}#${itemIdx}`,
              ...item,
            }) as Item,
        );
      return {
        template,
        submenuInterface,
        submenuInterfaceIdx,
        items: keydItems,
        displayName: category,
      };
    });
  }

  selectItem(item: AugmentedItem) {
    this.selectedItem = item;
    const submenu = item.submenu;
    const { template, submenuInterface, submenuInterfaceIdx } = submenu;

    let computedTemplate = template;
    let defaultToolValues: any = {};

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
        defaultToolValues = item.value;
        break;
      case "annotation":
        computedTemplate = {
          ...template,
          interface: template.interface.slice(),
        };
        const computedAnnotationInterface = {
          ...template.interface[submenuInterfaceIdx],
        };
        if (!computedAnnotationInterface.meta) {
          computedAnnotationInterface.meta = {};
        }
        computedAnnotationInterface.meta.hideShape = true;
        computedAnnotationInterface.meta.defaultShape = item.value;
        computedTemplate.interface[submenuInterfaceIdx] =
          computedAnnotationInterface;
        break;
      default:
        break;
    }

    this.computedTemplate = computedTemplate;
    this.defaultToolValues = defaultToolValues;

    const returnValue: TReturnType = {
      template: this.computedTemplate,
      defaultValues: this.defaultToolValues,
      selectedItem: item,
    };

    this.$emit("selected", returnValue);
  }

  get templates() {
    return this.store.toolTemplateList;
  }

  mounted() {
    this.refreshWorkers();
  }

  refreshWorkers() {
    this.propertyStore.fetchWorkerImageList();
  }

  reset() {
    this.selectedItem = null;
    this.computedTemplate = null;
    this.defaultToolValues = {};
    this.refreshWorkers();
  }
}
</script>

<style lang="scss" scoped>
.tool-type-menu {
  max-height: 90vh;
  overflow-y: auto;
}

.tool-type-card {
  height: 100%;
  cursor: pointer;
  transition: all 0.2s ease;
  min-height: 0;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  .v-card__title {
    word-break: break-word;
    line-height: 1.2;
    min-height: 0;
  }

  .description {
    color: rgba(255, 255, 255, 0.7);
    line-height: 1.2;
  }
}
</style>

<style lang="scss">
.v-list .v-subheader {
  font-size: medium;
}
</style>
