<template>
  <v-card class="tool-selection-dialog">
    <v-card-title class="dialog-header">
      <div class="header-row">
        <span class="dialog-title">Select Tool Type</span>
      </div>
      <v-text-field
        v-model="searchQuery"
        class="search-field"
        placeholder="Search tools…"
        prepend-inner-icon="mdi-magnify"
        variant="outlined"
        density="compact"
        hide-details
        clearable
        autofocus
        @keydown.enter="selectFirstMatch"
      />
    </v-card-title>

    <div v-if="!isSearching" class="chip-nav">
      <template v-for="group in visibleGroups" :key="group.key">
        <span class="chip-nav-group-label" :class="`group-${group.key}`">
          {{ group.navLabel }}
        </span>
        <v-chip
          v-for="submenu in group.submenus"
          :key="categoryAnchorId(submenu)"
          class="chip-nav-chip"
          size="small"
          variant="tonal"
          @click="scrollToCategory(categoryAnchorId(submenu))"
        >
          {{ categoryName(submenu) }}
        </v-chip>
      </template>
    </div>

    <v-card-text ref="dialogContent" class="dialog-content">
      <!-- Featured section at top (hidden while searching) -->
      <div
        v-if="featuredItems.length > 0 && !isSearching"
        class="category category-featured"
      >
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
            :data-tour="getTourAnchorId(item.text)"
            v-tour-trigger="getTourAnchorId(item.text)"
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

      <!-- Top-level groups: interactive tools vs automated analysis -->
      <template v-for="group in visibleGroups" :key="'group-' + group.key">
        <div class="group-header" :class="`group-${group.key}`">
          <span class="group-title">{{ group.title }}</span>
          <span class="group-subtitle">{{ group.subtitle }}</span>
        </div>

        <div
          v-for="submenu in group.submenus"
          :key="categoryAnchorId(submenu)"
          :id="categoryAnchorId(submenu)"
          class="category"
          :class="`group-${group.key}`"
        >
          <div class="category-header">
            <div class="category-indicator"></div>
            <span class="category-name">{{ categoryName(submenu) }}</span>
            <span class="category-count"
              >{{ submenu.items.length }}
              {{ submenu.items.length === 1 ? "tool" : "tools" }}</span
            >
          </div>

          <div class="tools-grid">
            <div
              v-for="item in submenu.items"
              :key="item.key"
              :data-tour="getTourAnchorId(item.text)"
              v-tour-trigger="getTourAnchorId(item.text)"
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
      </template>

      <div v-if="isSearching && !hasVisibleItems" class="no-results">
        No tools match "{{ searchQuery }}"
      </div>
    </v-card-text>
  </v-card>
</template>

<script lang="ts">
import { IToolTemplate } from "@/store/model";

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
  isWorker?: boolean;
}

interface AugmentedItem extends Item {
  submenu: Submenu;
}

export interface TReturnType {
  template: IToolTemplate | null;
  defaultValues: any;
  selectedItem: AugmentedItem | null;
}
</script>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from "vue";
import propertiesStore from "@/store/properties";
import store from "@/store";
import { AnnotationShape } from "@/store/model";
import { getTourAnchorId } from "@/utils/strings";
import { logWarning } from "@/utils/log";
import { IAnnotationSetup } from "./templates/AnnotationConfiguration.vue";

interface FeaturedToolsConfig {
  featuredTools: string[];
}

interface ToolGroup {
  key: "tools" | "analysis";
  title: string;
  navLabel: string;
  subtitle: string;
  submenus: Submenu[];
}

const hiddenToolTexts = new Set<string>([
  '"Snap to" manual annotation tools',
  "Annotation edit tools",
]);

const emit = defineEmits<{
  (e: "selected", value: TReturnType): void;
}>();

const selectedItem = ref<AugmentedItem | null>(null);
const computedTemplate = ref<IToolTemplate | null>(null);
const defaultToolValues = ref<any>({});
const featuredToolNames = ref<string[]>([]);
const searchQuery = ref("");
const dialogContent = ref<any>(null);

const isSearching = computed(() => !!searchQuery.value?.trim());

function categoryName(submenu: Submenu): string {
  return submenu.displayName ?? submenu.template.name;
}

function categoryAnchorId(submenu: Submenu): string {
  return "tool-category-" + getTourAnchorId(categoryName(submenu));
}

const featuredItems = computed((): AugmentedItem[] => {
  if (featuredToolNames.value.length === 0) return [];

  const featuredSet = new Set(featuredToolNames.value);
  const items: AugmentedItem[] = [];

  for (const submenu of submenus.value) {
    for (const item of submenu.items) {
      if (featuredSet.has(item.text)) {
        items.push({ ...item, submenu });
      }
    }
  }

  // Sort to match the order in featuredToolNames
  items.sort((a, b) => {
    const aIndex = featuredToolNames.value.indexOf(a.text);
    const bIndex = featuredToolNames.value.indexOf(b.text);
    return aIndex - bIndex;
  });

  return items;
});

const submenus = computed((): Submenu[] => {
  return templates.value
    .filter((template) => !hiddenToolTexts.has(template.name))
    .flatMap((template) => {
      const submenuInterfaceIdx = template.interface.findIndex(
        (elem: any) => elem.isSubmenu,
      );
      const submenuInterface = template.interface[submenuInterfaceIdx] || {};
      let items: Omit<Item, "key">[] = [];

      if (submenuInterface.type === "dockerImage") {
        return createDockerImageSubmenus(
          template,
          submenuInterface,
          submenuInterfaceIdx,
        );
      }

      switch (submenuInterface.type) {
        case "annotation":
          items = store.availableToolShapes;
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
});

// Submenus split into the two top-level groups, with the search filter
// applied to item name/description and category name.
const visibleGroups = computed((): ToolGroup[] => {
  const query = (searchQuery.value ?? "").trim().toLowerCase();

  const filterSubmenu = (submenu: Submenu): Submenu | null => {
    if (!query) {
      return submenu.items.length > 0 ? submenu : null;
    }
    if (categoryName(submenu).toLowerCase().includes(query)) {
      return submenu.items.length > 0 ? submenu : null;
    }
    const items = submenu.items.filter(
      (item) =>
        item.text.toLowerCase().includes(query) ||
        (item.description ?? "").toLowerCase().includes(query),
    );
    return items.length > 0 ? { ...submenu, items } : null;
  };

  const groups: ToolGroup[] = [
    {
      key: "tools",
      title: "Drawing & interaction tools",
      navLabel: "Tools",
      subtitle: "Annotate, select, tag, and measure directly on the image",
      submenus: [],
    },
    {
      key: "analysis",
      title: "Automated analysis",
      navLabel: "Analysis",
      subtitle: "Workers that compute segmentations and image corrections",
      submenus: [],
    },
  ];

  for (const submenu of submenus.value) {
    const filtered = filterSubmenu(submenu);
    if (filtered) {
      groups[submenu.isWorker ? 1 : 0].submenus.push(filtered);
    }
  }

  return groups.filter((group) => group.submenus.length > 0);
});

const hasVisibleItems = computed(() => visibleGroups.value.length > 0);

function selectFirstMatch() {
  if (!isSearching.value) {
    return;
  }
  const firstSubmenu = visibleGroups.value[0]?.submenus[0];
  const firstItem = firstSubmenu?.items[0];
  if (firstSubmenu && firstItem) {
    selectItem({ ...firstItem, submenu: firstSubmenu });
  }
}

function scrollToCategory(anchorId: string) {
  document
    .getElementById(anchorId)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function createDockerImageSubmenus(
  template: any,
  submenuInterface: any,
  submenuInterfaceIdx: number,
): Submenu[] {
  const itemsByCategory: { [category: string]: Omit<Item, "key">[] } = {};
  const annotationInterface = template.interface.find(
    (elem: any) => elem.type === "annotation",
  );

  for (const image in propertiesStore.workerImageList) {
    const labels = propertiesStore.workerImageList[image];
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
      isWorker: true,
    };
  });
}

function selectItem(item: AugmentedItem) {
  selectedItem.value = item;
  const submenu = item.submenu;
  const { template, submenuInterface, submenuInterfaceIdx } = submenu;

  let newComputedTemplate = template;
  let newDefaultToolValues: any = {};

  switch (submenuInterface.type) {
    case "select":
    case "dockerImage":
      newComputedTemplate = {
        ...template,
        interface: [
          ...template.interface.slice(0, submenuInterfaceIdx),
          ...template.interface.slice(submenuInterfaceIdx + 1),
        ],
      };
      newDefaultToolValues = item.value;
      break;
    case "annotation":
      newComputedTemplate = {
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
      newComputedTemplate.interface[submenuInterfaceIdx] =
        computedAnnotationInterface;
      break;
    default:
      break;
  }

  computedTemplate.value = newComputedTemplate;
  defaultToolValues.value = newDefaultToolValues;

  const returnValue: TReturnType = {
    template: computedTemplate.value,
    defaultValues: defaultToolValues.value,
    selectedItem: item,
  };

  emit("selected", returnValue);
}

const templates = computed((): IToolTemplate[] => {
  return store.toolTemplateList;
});

async function loadFeaturedTools() {
  try {
    const response = await fetch("/config/featuredTools.json");
    if (response.ok) {
      const config: FeaturedToolsConfig = await response.json();
      featuredToolNames.value = config.featuredTools || [];
      validateFeaturedTools();
    }
  } catch {
    // If config doesn't exist or fails to load, use empty array
    featuredToolNames.value = [];
  }
}

/**
 * Validates featured tools configuration and logs warnings for issues
 */
function validateFeaturedTools() {
  // Check for duplicates
  const seen = new Set<string>();
  for (const name of featuredToolNames.value) {
    if (seen.has(name)) {
      logWarning(`[ToolTypeSelection] Duplicate featured tool: "${name}"`);
    }
    seen.add(name);
  }

  // Check for non-matching names (after submenus are computed)
  nextTick(() => {
    const allToolNames = new Set(
      submenus.value.flatMap((s) => s.items.map((i) => i.text)),
    );
    for (const name of featuredToolNames.value) {
      if (!allToolNames.has(name)) {
        logWarning(`[ToolTypeSelection] Featured tool not found: "${name}"`);
      }
    }
  });
}

function refreshWorkers() {
  propertiesStore.fetchWorkerImageList();
}

function reset() {
  selectedItem.value = null;
  computedTemplate.value = null;
  defaultToolValues.value = {};
  searchQuery.value = "";
  refreshWorkers();
}

onMounted(async () => {
  refreshWorkers();
  await loadFeaturedTools();
});

defineExpose({
  selectedItem,
  computedTemplate,
  defaultToolValues,
  featuredToolNames,
  featuredItems,
  submenus,
  visibleGroups,
  searchQuery,
  templates,
  selectItem,
  reset,
  getTourAnchorId,
});
</script>

<style lang="scss" scoped>
// One accent per top-level group (plus gold for featured)
$color-tools: #60a5fa;
$color-analysis: #a78bfa;
$color-featured: #fbbf24;

.tool-selection-dialog {
  border-radius: 16px;
  width: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.dialog-header {
  padding: 20px 28px 16px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.2);
  display: block;
}

.header-row {
  margin-bottom: 12px;
}

.dialog-title {
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.search-field {
  max-width: 420px;
}

.chip-nav {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 28px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.2);
}

.chip-nav-group-label {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-right: 2px;

  &:not(:first-child) {
    margin-left: 12px;
  }

  &.group-tools {
    color: $color-tools;
  }
  &.group-analysis {
    color: $color-analysis;
  }
}

.chip-nav-chip {
  cursor: pointer;
}

.dialog-content {
  padding: 8px 20px 28px;
  max-height: 60vh;
  overflow-y: auto;
}

.group-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 24px 8px 4px;

  &:not(:first-child) {
    margin-top: 12px;
    border-top: 1px solid rgba(128, 128, 128, 0.2);
  }
}

.group-title {
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.group-subtitle {
  font-size: 0.8rem;
  opacity: 0.6;
}

.category {
  padding: 16px 0 8px;
  scroll-margin-top: 8px;
}

.category-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding-left: 8px;
}

.category-indicator {
  width: 4px;
  height: 16px;
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
  opacity: 0.6;
  padding: 2px 8px;
  border-radius: 10px;
}

.tools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}

.tool-card {
  border-radius: 10px;
  padding: 12px 14px;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: all 0.2s ease;
  border: 1px solid transparent;
  display: flex;
  flex-direction: column;

  &:hover {
    transform: translateY(-2px);
  }
}

.tool-card-name {
  font-size: 0.9rem;
  font-weight: 600;
  margin-bottom: 4px;
  line-height: 1.3;
}

.tool-card-description {
  font-size: 0.78rem;
  opacity: 0.7;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.no-results {
  padding: 32px 8px;
  text-align: center;
  opacity: 0.6;
  font-size: 0.9rem;
}

// Theme-specific styles (theme class is on the v-card itself)
.tool-selection-dialog.v-theme--dark {
  .category-count {
    background: rgba(255, 255, 255, 0.05);
  }

  .tool-card {
    background: rgba(255, 255, 255, 0.05);

    &:hover {
      background: rgba(255, 255, 255, 0.08);
    }
  }
}

.tool-selection-dialog.v-theme--light {
  .category-count {
    background: rgba(0, 0, 0, 0.05);
  }

  .tool-card {
    background: rgba(0, 0, 0, 0.03);

    &:hover {
      background: rgba(0, 0, 0, 0.06);
    }
  }
}

// Group accent colors: category header indicator + name, and card hover glow
@mixin group-colors($color) {
  .category-indicator {
    background: $color;
  }
  .category-name {
    color: $color;
  }
  .tool-card:hover {
    box-shadow: 0 8px 24px -8px rgba($color, 0.3);
    border-color: rgba($color, 0.2);
  }
}

.category-featured {
  @include group-colors($color-featured);
}
.category.group-tools {
  @include group-colors($color-tools);
}
.category.group-analysis {
  @include group-colors($color-analysis);
}

// Responsive adjustments
@media (max-width: 500px) {
  .tools-grid {
    grid-template-columns: 1fr;
  }
}
</style>
