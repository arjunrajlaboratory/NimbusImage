<template>
  <v-expansion-panel>
    <v-expansion-panel-header
      id="properties-header-tourstep"
      v-tour-trigger="'properties-header-tourtrigger'"
    >
      Properties
      <v-spacer />
      <v-btn
        color="primary"
        dark
        small
        dense
        @click.stop="showAnalyzeDialog = true"
        id="measure-objects-button-tourstep"
        v-tour-trigger="'measure-objects-button-tourtrigger'"
      >
        Measure objects
      </v-btn>
    </v-expansion-panel-header>

    <v-dialog
      v-model="showAnalyzeDialog"
      min-width="900px"
      max-width="1000px"
      width="80%"
      @input="onDialogClose"
    >
      <v-card>
        <v-card-title>Measure objects</v-card-title>
        <v-card-text>
          <analyze-panel />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn
            @click="onDialogClose(false)"
            id="measure-objects-close-button-tourstep"
            v-tour-trigger="'measure-objects-close-button-tourtrigger'"
          >
            Close
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-expansion-panel-content id="properties-content-tourstep">
      <v-text-field
        v-model="propFilter"
        label="Search properties"
        single-line
        clearable
      />
      <v-tabs v-model="activeTabIndex" grow>
        <v-tab v-for="{ key, text } in tabs" :key="key">{{ text }}</v-tab>
      </v-tabs>
      <div class="miller-columns-container">
        <div
          :class="{
            'miller-column': true,
            dark: $vuetify.theme.dark,
          }"
          v-for="(column, colIndex) in columns"
          :key="colIndex"
        >
          <v-list dense>
            <v-list-item
              v-for="item in column"
              :key="item.path.join('.')"
              @click="selectedPath = item.path"
              :class="{ 'v-list-item--active': item.isSelected }"
            >
              <v-list-item-content>
                <v-list-item-title>
                  {{ item.name }}
                </v-list-item-title>
              </v-list-item-content>
              <v-list-item-action class="my-2">
                <v-simple-checkbox
                  v-if="item.isLeaf"
                  :value="getPropertySettings(item.path)"
                  @input="togglePropertySettings(item.path)"
                />
                <v-icon v-else>mdi-chevron-right</v-icon>
              </v-list-item-action>
            </v-list-item>
          </v-list>
        </div>
      </div>
    </v-expansion-panel-content>
  </v-expansion-panel>
</template>

<script lang="ts">
import { Vue, Component } from "vue-property-decorator";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";
import { findIndexOfPath } from "@/utils/paths";
import AnalyzePanel from "@/components/AnalyzePanel.vue";

interface PropertyItem {
  name: string;
  path: string[];
  isLeaf: boolean;
  isSelected: boolean;
}

const tabs = [
  {
    key: "display",
    text: "Show in list",
  },
  {
    key: "filter",
    text: "Use as filter",
  },
] as const satisfies { key: string; text: string }[];

type TTabKey = (typeof tabs)[number]["key"];

@Component({
  components: {
    AnalyzePanel,
  },
})
export default class AnnotationProperties extends Vue {
  readonly propertyStore = propertyStore;
  readonly filterStore = filterStore;
  readonly findIndexOfPath = findIndexOfPath;
  readonly tabs = tabs;

  propFilter: string | null = null;
  selectedPath: string[] = [];
  activeTabKey: TTabKey = "display";
  showAnalyzeDialog = false;

  get activeTabIndex(): number {
    return tabs.findIndex(({ key }) => this.activeTabKey === key);
  }

  set activeTabIndex(index: number) {
    this.activeTabKey = tabs[index].key;
  }

  togglePropertySettings(path: string[]): void {
    switch (this.activeTabKey) {
      case "display":
        this.toggleList(path);
        break;
      case "filter":
        this.toggleFilter(path);
        break;
    }
  }

  getPropertySettings(path: string[]): boolean {
    switch (this.activeTabKey) {
      case "display":
        return this.isPropertyDisplayed(path);
      case "filter":
        return this.isPropertyFiltered(path);
    }
  }

  get filteredPaths() {
    const lowerCaseFilter = this.propFilter?.toLowerCase();
    const allPaths = this.propertyStore.computedPropertyPaths;
    return lowerCaseFilter
      ? allPaths.filter(
          (path) =>
            this.propertyStore
              .getFullNameFromPath(path)
              ?.toLowerCase()
              .includes(lowerCaseFilter) ?? true,
        )
      : allPaths;
  }

  get columns(): PropertyItem[][] {
    // Add a column for each segment in the path
    let remainingPaths = this.filteredPaths;
    const columns: PropertyItem[][] = [];
    for (
      let columnIdx = 0;
      columnIdx < this.selectedPath.length + 1;
      ++columnIdx
    ) {
      // Remove paths that don't belong to this column
      const currentSelectedPath = this.selectedPath.slice(0, columnIdx);
      remainingPaths = remainingPaths.filter((path) =>
        currentSelectedPath.every(
          (pathSegment, pathSegmentIdx) => pathSegment === path[pathSegmentIdx],
        ),
      );
      // Find all unique segments for this column
      const segmentItems: Map<string, PropertyItem> = new Map();
      remainingPaths.forEach((path) => {
        const segment = path[columnIdx]; // Property ID for column 0, sub-name otherwise
        if (!segment || segmentItems.has(segment)) {
          return;
        }
        const itemName =
          columnIdx === 0
            ? this.propertyStore.getPropertyById(segment)?.name ?? segment // Handle root level
            : segment; // Handle custom sub levels

        segmentItems.set(segment, {
          name: itemName,
          path: path.slice(0, columnIdx + 1),
          isLeaf: path.length === columnIdx + 1,
          isSelected: segment === this.selectedPath[columnIdx],
        });
      });
      // Create the new column
      if (segmentItems.size <= 0) {
        break;
      }
      columns.push([...segmentItems.values()]);
    }
    return columns;
  }

  getTagsForPath(path: string[]) {
    const property = this.propertyStore.getPropertyById(path[0]);
    return property?.tags.tags || [];
  }

  isPropertyDisplayed(path: string[]): boolean {
    return (
      this.findIndexOfPath(path, this.propertyStore.displayedPropertyPaths) >= 0
    );
  }

  isPropertyFiltered(path: string[]): boolean {
    return this.findIndexOfPath(path, this.filterStore.filterPaths) >= 0;
  }

  toggleList(propertyPath: string[]) {
    this.propertyStore.togglePropertyPathVisibility(propertyPath);
  }

  toggleFilter(propertyPath: string[]) {
    this.filterStore.togglePropertyPathFiltering(propertyPath);
  }

  onDialogClose(value: boolean) {
    if (!value) {
      this.showAnalyzeDialog = false;
      this.$emit("expand");
    }
  }
}
</script>

<style lang="scss" scoped>
.miller-columns-container {
  display: flex;
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 0, 0, 0.3) transparent;
}

.miller-column {
  flex: 0 1 auto;
  min-width: 150px;
  max-width: 300px;
  padding: 0px 2px;
  border-right: 1px solid;

  border-color: rgba(0, 0, 0, 0.12);
  &.dark {
    border-color: rgba(255, 255, 255, 0.12);
  }
}
</style>
