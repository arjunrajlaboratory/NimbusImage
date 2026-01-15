<template>
  <div class="tool-selection-dialog">
    <div class="dialog-header">
      <h1 class="dialog-title">Select Tool Type</h1>
    </div>

    <div class="dialog-content">
      <!-- Featured section at top -->
      <div v-if="featuredItems.length > 0" class="category category-featured">
        <div class="category-header">
          <div class="category-indicator"></div>
          <span class="category-name">Featured</span>
          <span class="category-count"
            >{{ featuredItems.length }}
            {{ featuredItems.length === 1 ? "tool" : "tools" }}</span
          >
        </div>

        <div class="tools-grid">
          <div
            v-for="item in featuredItems"
            :key="'featured-' + item.key"
            :id="getTourStepId(item.text)"
            v-tour-trigger="getTourTriggerId(item.text)"
            class="tool-card"
            @click="selectItem(item)"
          >
            <div class="tool-card-name">{{ item.text }}</div>
            <div v-if="item.description" class="tool-card-description">
              {{ item.description }}
            </div>
          </div>
        </div>
      </div>

      <!-- Regular category sections -->
      <div
        v-for="submenu in submenus"
        :key="submenu.displayName ?? submenu.template.name"
        class="category"
        :class="getCategoryClass(submenu.displayName ?? submenu.template.name)"
      >
        <div class="category-header">
          <div class="category-indicator"></div>
          <span class="category-name">{{
            submenu.displayName ?? submenu.template.name
          }}</span>
          <span class="category-count"
            >{{ submenu.items.length }}
            {{ submenu.items.length === 1 ? "tool" : "tools" }}</span
          >
        </div>

        <div class="tools-grid">
          <div
            v-for="item in submenu.items"
            :key="item.key"
            :id="getTourStepId(item.text)"
            v-tour-trigger="getTourTriggerId(item.text)"
            class="tool-card"
            @click="selectItem({ ...item, submenu })"
          >
            <div class="tool-card-name">{{ item.text }}</div>
            <div v-if="item.description" class="tool-card-description">
              {{ item.description }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
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
  displayName?: string;
}

interface AugmentedItem extends Item {
  submenu: Submenu;
}

export interface TReturnType {
  template: IToolTemplate | null;
  defaultValues: any;
  selectedItem: AugmentedItem | null;
}

interface FeaturedToolsConfig {
  featuredTools: string[];
}

// Category to CSS class mapping
const categoryClassMap: { [key: string]: string } = {
  "Manual object tool": "category-manual",
  "Selection tools": "category-selection",
  "AI analysis": "category-ai",
  Connections: "category-connections",
  "Annotation Connections": "category-connections",
  Conversion: "category-conversion",
  "Image Processing": "category-processing",
  "Tagging tools": "category-tagging",
  "Annotation Edits": "category-edits",
};

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
  featuredToolNames: string[] = [];

  getTourStepId = getTourStepId;
  getTourTriggerId = getTourTriggerId;

  getCategoryClass(categoryName: string): string {
    return categoryClassMap[categoryName] || "category-other";
  }

  /**
   * Collects featured tools from all submenus into a single list
   */
  get featuredItems(): AugmentedItem[] {
    if (this.featuredToolNames.length === 0) return [];

    const featuredSet = new Set(this.featuredToolNames);
    const items: AugmentedItem[] = [];

    for (const submenu of this.submenus) {
      for (const item of submenu.items) {
        if (featuredSet.has(item.text)) {
          items.push({ ...item, submenu });
        }
      }
    }

    // Sort to match the order in featuredToolNames
    items.sort((a, b) => {
      const aIndex = this.featuredToolNames.indexOf(a.text);
      const bIndex = this.featuredToolNames.indexOf(b.text);
      return aIndex - bIndex;
    });

    return items;
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

  createDockerImageSubmenus(
    template: any,
    submenuInterface: any,
    submenuInterfaceIdx: number,
  ): Submenu[] {
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

  async mounted() {
    this.refreshWorkers();
    await this.loadFeaturedTools();
  }

  async loadFeaturedTools() {
    try {
      const response = await fetch("/config/featuredTools.json");
      if (response.ok) {
        const config: FeaturedToolsConfig = await response.json();
        this.featuredToolNames = config.featuredTools || [];
      }
    } catch {
      // If config doesn't exist or fails to load, use empty array
      this.featuredToolNames = [];
    }
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
// Category colors
$color-manual: #60a5fa;
$color-selection: #22d3ee;
$color-ai: #a78bfa;
$color-connections: #4ade80;
$color-conversion: #fb923c;
$color-processing: #f472b6;
$color-tagging: #fbbf24;
$color-edits: #f87171;
$color-other: #94a3b8;
$color-featured: #fbbf24; // Gold for featured

// Base colors
$bg-dialog: #1a1a1e;
$bg-card: #252529;
$bg-card-hover: #2a2a2f;
$text-primary: #f5f5f5;
$text-secondary: rgba(255, 255, 255, 0.6);
$text-muted: rgba(255, 255, 255, 0.4);
$border-subtle: rgba(255, 255, 255, 0.08);

.tool-selection-dialog {
  background: $bg-dialog;
  border-radius: 16px;
  width: 100%;
  max-width: 1000px;
  margin: 0 auto;
  box-shadow:
    0 25px 50px -12px rgba(0, 0, 0, 0.5),
    0 0 0 1px $border-subtle;
  overflow: hidden;
  font-family:
    "DM Sans",
    -apple-system,
    BlinkMacSystemFont,
    sans-serif;
}

.dialog-header {
  padding: 24px 28px 20px;
  border-bottom: 1px solid $border-subtle;
}

.dialog-title {
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: $text-primary;
  margin: 0;
}

.dialog-content {
  padding: 8px 20px 28px;
  max-height: 70vh;
  overflow-y: auto;

  &::-webkit-scrollbar {
    width: 8px;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.15);
    border-radius: 4px;
  }

  &::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.25);
  }
}

.category {
  padding: 20px 0 12px;

  &:not(:first-child) {
    border-top: 1px solid $border-subtle;
    margin-top: 8px;
  }
}

.category-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  padding-left: 8px;
}

.category-indicator {
  width: 4px;
  height: 20px;
  border-radius: 2px;
  flex-shrink: 0;
}

.category-name {
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.category-count {
  font-size: 0.75rem;
  color: $text-muted;
  background: rgba(255, 255, 255, 0.05);
  padding: 2px 8px;
  border-radius: 10px;
}

.tools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}

.tool-card {
  background: $bg-card;
  border-radius: 10px;
  padding: 14px 16px;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: all 0.2s ease;
  border: 1px solid transparent;
  min-height: 80px;
  display: flex;
  flex-direction: column;

  &::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    border-radius: 10px 0 0 10px;
  }

  &:hover {
    transform: translateY(-2px);
    background: $bg-card-hover;
  }
}

.tool-card-name {
  font-size: 0.9rem;
  font-weight: 600;
  margin-bottom: 6px;
  line-height: 1.3;
  color: $text-primary;
}

.tool-card-description {
  font-size: 0.78rem;
  color: $text-secondary;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

// Category-specific colors
@mixin category-colors($color) {
  .category-indicator {
    background: $color;
  }
  .category-name {
    color: $color;
  }
  .tool-card::before {
    background: $color;
  }
  .tool-card:hover {
    box-shadow: 0 8px 24px -8px rgba($color, 0.3);
    border-color: rgba($color, 0.2);
  }
}

.category-featured {
  @include category-colors($color-featured);
}
.category-manual {
  @include category-colors($color-manual);
}
.category-selection {
  @include category-colors($color-selection);
}
.category-ai {
  @include category-colors($color-ai);
}
.category-connections {
  @include category-colors($color-connections);
}
.category-conversion {
  @include category-colors($color-conversion);
}
.category-processing {
  @include category-colors($color-processing);
}
.category-tagging {
  @include category-colors($color-tagging);
}
.category-edits {
  @include category-colors($color-edits);
}
.category-other {
  @include category-colors($color-other);
}

// Responsive adjustments
@media (max-width: 500px) {
  .tools-grid {
    grid-template-columns: 1fr;
  }
}
</style>
