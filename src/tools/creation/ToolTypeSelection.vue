<template>
  <v-container>
    <v-menu offset-x right>
      <template v-slot:activator="{ on, attrs }">
        <v-btn
          v-bind="attrs"
          v-on="on"
          class="big-subheaders"
          id="select-tool-type-tourstep"
          v-tour-trigger="'select-tool-type-tourtrigger'"
        >
          {{ selectedItem ? selectedItem.text : "Select Tool Type" }}
        </v-btn>
      </template>
      <v-list class="floating-list" id="select-tool-list-tourstep">
        <template v-for="(item, itemIndex) in submenuItems">
          <v-subheader
            v-if="'header' in item"
            :key="item.header"
            class="custom-subheader"
          >
            {{ item.header }}
          </v-subheader>
          <v-divider
            v-else-if="'divider' in item"
            :key="`divider-${itemIndex}`"
          />
          <v-list-item
            v-else-if="'key' in item"
            :key="item.key"
            :id="getTourStepId(item.text)"
            v-tour-trigger="getTourTriggerId(item.text)"
            @click="selectedItem = item"
            dense
          >
            <v-list-item-content>
              <v-list-item-title>{{ item.text }}</v-list-item-title>
              <v-list-item-subtitle v-if="item.description">
                {{ item.description }}
              </v-list-item-subtitle>
            </v-list-item-content>
          </v-list-item>
        </template>
      </v-list>
    </v-menu>
  </v-container>
</template>
<script lang="ts">
import { Vue, Component, Watch, Prop } from "vue-property-decorator";
import propertiesStore from "@/store/properties";
import store from "@/store";
import ToolConfiguration from "@/tools/creation/ToolConfiguration.vue";
import { AnnotationShape, IToolTemplate } from "@/store/model";
import { IAnnotationSetup } from "./templates/AnnotationConfiguration.vue";
import { toKebabCase } from "@/utils/strings";

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
}

interface AugmentedItem extends Item {
  submenu: Submenu;
}

export interface TReturnType {
  template: IToolTemplate | null;
  defaultValues: any;
  selectedItem: AugmentedItem | null;
}

const hiddenToolTexts = new Set<string>([
  '"Snap to" manual annotation tools',
  "Annotation edit tools",
]);

@Component({
  components: {
    ToolConfiguration,
  },
})
export default class ToolTypeSelection extends Vue {
  readonly propertyStore = propertiesStore;
  readonly store = store;

  @Prop()
  private value: any;

  getTourStepId(id: string): string {
    return `${toKebabCase(id)}-tourstep`;
  }

  getTourTriggerId(id: string): string {
    return `${toKebabCase(id)}-tourtrigger`;
  }

  computedTemplate: IToolTemplate | null = null;
  defaultToolValues: any = {};

  selectedItem: AugmentedItem | null = null;

  get submenuItems() {
    return this.submenus.reduce(
      (items, submenu) => [
        ...items,
        { divider: true },
        { header: submenu.template.name },
        ...submenu.items.map((item) => ({ ...item, submenu }) as AugmentedItem),
      ],
      [] as (AugmentedItem | { divider: boolean } | { header: string })[],
    );
  }

  get submenus(): Submenu[] {
    return this.templates
      .filter((template) => !hiddenToolTexts.has(template.name))
      .map((template) => {
        const submenuInterfaceIdx = template.interface.findIndex(
          (elem: any) => elem.isSubmenu,
        );
        const submenuInterface = template.interface[submenuInterfaceIdx] || {};
        let items: Omit<Item, "key">[] = [];
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
          case "dockerImage":
            for (const image in this.propertyStore.workerImageList) {
              const labels = this.propertyStore.workerImageList[image];
              if (labels.isAnnotationWorker !== undefined) {
                const annotationInterface = template.interface.find(
                  (elem: any) => elem.type === "annotation",
                );
                const annotationSetupDefault: Partial<IAnnotationSetup> = {
                  shape: labels.annotationShape ?? AnnotationShape.Point,
                };
                items.push({
                  text: labels.interfaceName || image,
                  description: labels.description || "",
                  value: {
                    [submenuInterface.id]: { image },
                    [annotationInterface.id]: annotationSetupDefault,
                  },
                });
              }
            }
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

  @Watch("selectedItem")
  selectSubmenuItem() {
    if (!this.selectedItem) {
      this.reset();
      return;
    }
    const submenu = this.selectedItem.submenu;
    const item = this.selectedItem;
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
  }

  refreshWorkers() {
    this.propertyStore.fetchWorkerImageList();
  }

  @Watch("computedTemplate")
  @Watch("defaultToolValues")
  handleChange() {
    const input: TReturnType = {
      template: this.computedTemplate,
      defaultValues: this.defaultToolValues,
      selectedItem: this.selectedItem,
    };
    this.$emit("input", input);
  }

  mounted() {
    this.initialize();
  }

  get templates() {
    return this.store.toolTemplateList;
  }

  @Watch("templates")
  @Watch("value")
  initialize() {
    if (!this.value && this.templates.length) {
      this.reset();
    }
  }

  reset() {
    this.selectedItem = null;
    this.computedTemplate = null;
    this.defaultToolValues = {};
    this.handleChange();
    this.refreshWorkers();
  }
}
</script>

<style lang="scss" scoped>
.floating-list {
  display: flex;
  flex-direction: column;
  max-height: 90vh;
  overflow-y: auto;
  padding: 0;
  margin: 0;
}

.custom-subheader {
  font-size: large;
  text-align: left;
  padding: 8px 16px;
}
</style>

<style lang="scss">
.v-list .v-subheader {
  font-size: large;
}
</style>
