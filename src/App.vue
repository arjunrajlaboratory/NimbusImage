<template>
  <v-app
    id="inspire"
    v-mousetrap="appHotkeys"
    :class="{
      'datasetview-mode': isDatasetView,
      'left-palettes-open': isDatasetView && allLeftPalettesOpen,
      'any-left-palette-open': isDatasetView && anyLeftPaletteOpen,
      // The Timelapse palette sits exactly where the selection action panels
      // slide to when a left palette is open, so they move to the top-right
      // while it is up. How far in they sit is `--nimbus-right-edge-clear-x`
      // below, not a second class.
      'timelapse-palette-open': isDatasetView && timelapsePanel,
    }"
    :style="paletteGeometryVars"
  >
    <v-dialog
      v-model="helpPanelIsOpen"
      fullscreen
      scrim="transparent"
      transition="fade-transition"
      content-class="help-dialog-overlay"
    >
      <help-panel @close="helpPanelIsOpen = false" />
    </v-dialog>
    <v-app-bar>
      <v-tooltip text="NimbusImage home" :open-delay="500">
        <template v-slot:activator="{ props: activatorProps }">
          <v-toolbar-title v-bind="activatorProps" @click="goHome" class="logo">
            <svg
              class="logo-icon"
              viewBox="0 0 652 397"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <!-- Cloud body -->
              <path d="M145 253H529V393H145V253Z" fill="#E68A82" />
              <path
                d="M517.5 132C589.573 132 648 190.427 648 262.5C648 334.573 589.573 393 517.5 393C445.427 393 387 334.573 387 262.5C387 190.427 445.427 132 517.5 132Z"
                fill="#E68A82"
                stroke="#E47F78"
                stroke-width="8"
              />
              <path
                d="M316 4C408.232 4 483 78.7684 483 171C483 263.232 408.232 338 316 338C223.768 338 149 263.232 149 171C149 78.7684 223.768 4 316 4Z"
                fill="#E68A82"
                stroke="#E2756D"
                stroke-width="8"
              />
              <path
                d="M144.5 112C222.096 112 285 174.904 285 252.5C285 281.272 276.356 308.013 261.523 330.282C236.337 368.097 193.326 393 144.5 393C66.904 393 4 330.096 4 252.5C4 174.904 66.904 112 144.5 112Z"
                fill="#E68A82"
                stroke="#DE5F58"
                stroke-width="8"
              />
              <!-- Bird 1 (upper) -->
              <path
                class="bird bird-1"
                style="--ox: 275px; --oy: 112.5px"
                d="M296.5 65C278.487 80.4216 275.786 105.031 275 112.5C261.06 101.512 237.881 100.75 228 100.5"
                stroke="black"
                stroke-width="2"
                stroke-linecap="round"
                vector-effect="non-scaling-stroke"
              />
              <!-- Bird 2 (lower) -->
              <path
                class="bird bird-2"
                style="--ox: 492.5px; --oy: 341.5px"
                d="M445.5 319C454.5 320.667 476.5 327.5 492.5 341.5C505.7 323.5 528 315.333 537.5 313.5"
                stroke="black"
                stroke-width="2"
                stroke-linecap="round"
                vector-effect="non-scaling-stroke"
              />
              <!-- Cloud outline strokes -->
              <path
                d="M316 4C408.232 4 483 78.7684 483 171C483 263.232 408.232 338 316 338C223.768 338 149 263.232 149 171C149 78.7684 223.768 4 316 4Z"
                stroke="#E37C74"
                stroke-width="8"
              />
              <path
                d="M517.5 132C589.573 132 648 190.427 648 262.5C648 334.573 589.573 393 517.5 393C445.427 393 387 334.573 387 262.5C387 190.427 445.427 132 517.5 132Z"
                stroke="#E4827A"
                stroke-width="8"
              />
              <path
                d="M144.5 112C222.096 112 285 174.904 285 252.5C285 281.272 276.356 308.013 261.523 330.282C236.337 368.097 193.326 393 144.5 393C66.904 393 4 330.096 4 252.5C4 174.904 66.904 112 144.5 112Z"
                stroke="#DE5F58"
                stroke-width="8"
              />
              <path
                d="M146.727 393C67.9011 393 4 329.609 4 251.412C4 173.215 67.9011 109.824 146.727 109.824C150.811 109.824 154.855 109.994 158.853 110.327C183.5 48.073 244.623 4 316.123 4C396.348 4 463.51 59.4864 480.739 133.885C491.714 130.973 503.25 129.421 515.15 129.421C588.521 129.421 648 188.425 648 261.21C648 333.996 588.521 393 515.15 393"
                stroke="#DE5F58"
                stroke-width="8"
              />
              <path d="M144 393H518" stroke="#DE5F58" stroke-width="8" />
            </svg>
          </v-toolbar-title>
        </template>
      </v-tooltip>
      <h1 v-if="routeName === 'root'" class="text-h4 font-weight-bold ml-4">
        NimbusImage
      </h1>
      <bread-crumbs />
      <template v-if="store.dataset && routeName === 'datasetview'">
        <div class="palette-cluster">
          <v-tooltip
            text="Navigator: XY / Z / Time and the timelapse mode toggle"
          >
            <template v-slot:activator="{ props: activatorProps }">
              <button
                v-bind="activatorProps"
                type="button"
                class="palette-ibtn"
                :class="{ active: navigatorPanel }"
                aria-label="Navigator"
                @click.stop="togglePalette('navigatorPanel')"
              >
                <v-icon size="18">mdi-axis-arrow</v-icon>
              </button>
            </template>
          </v-tooltip>
          <v-tooltip text="Layers: channels, blending and layer mode">
            <template v-slot:activator="{ props: activatorProps }">
              <button
                v-bind="activatorProps"
                type="button"
                class="palette-ibtn"
                :class="{ active: layersPanel }"
                aria-label="Layers"
                @click.stop="togglePalette('layersPanel')"
              >
                <v-icon size="18">mdi-layers</v-icon>
              </button>
            </template>
          </v-tooltip>
          <v-tooltip text="Tools: create and configure annotation tools">
            <template v-slot:activator="{ props: activatorProps }">
              <button
                v-bind="activatorProps"
                type="button"
                class="palette-ibtn"
                :class="{ active: toolsPanel }"
                aria-label="Tools"
                @click.stop="togglePalette('toolsPanel')"
              >
                <v-icon size="18">mdi-tools</v-icon>
              </button>
            </template>
          </v-tooltip>
          <v-tooltip text="3D volume view (toggle 2D / 3D)">
            <template v-slot:activator="{ props: activatorProps }">
              <button
                v-bind="activatorProps"
                type="button"
                class="palette-ibtn"
                :class="{ active: is3DView }"
                aria-label="3D view"
                @click.stop="toggle3DView"
              >
                <v-icon size="18">mdi-cube-scan</v-icon>
              </button>
            </template>
          </v-tooltip>
        </div>
      </template>
      <v-spacer />
      <v-tooltip text="Upload a new dataset">
        <template v-slot:activator="{ props: activatorProps }">
          <v-btn
            v-bind="activatorProps"
            variant="flat"
            color="primary"
            size="small"
            class="ml-4"
            :disabled="!store.isLoggedIn || !store.girderUser"
            :loading="isUploadLoading"
            @click="goToNewDataset"
          >
            Upload Data
          </v-btn>
        </template>
      </v-tooltip>
      <v-divider class="ml-1" vertical />
      <template v-if="store.dataset && routeName === 'datasetview'">
        <undo-redo-buttons class="mr-1" />
        <div class="palette-cluster">
          <v-tooltip
            text="List of all objects in the dataset, including their properties, and various actions on them"
          >
            <template v-slot:activator="{ props: activatorProps }">
              <button
                v-bind="activatorProps"
                :data-tour="TOUR_ANCHORS.objectListButton"
                v-tour-trigger="TOUR_TRIGGERS.objectListButton"
                type="button"
                class="palette-ibtn"
                :class="{ active: annotationPanel }"
                aria-label="Object list"
                @click.stop="togglePalette('annotationPanel')"
              >
                <v-icon size="18">mdi-format-list-bulleted-square</v-icon>
              </button>
            </template>
          </v-tooltip>
          <v-tooltip :text="filtersTooltip">
            <template v-slot:activator="{ props: activatorProps }">
              <button
                v-bind="activatorProps"
                :data-tour="TOUR_ANCHORS.filtersButton"
                v-tour-trigger="TOUR_TRIGGERS.filtersButton"
                type="button"
                class="palette-ibtn"
                :class="{ active: filtersPanel }"
                :aria-label="filtersAriaLabel"
                @click.stop="togglePalette('filtersPanel')"
              >
                <v-icon size="18">mdi-filter-variant</v-icon>
                <!-- Count of active filters, so the user can tell filters are
                     narrowing the object set even with the panel closed. -->
                <span v-if="activeFilterCount > 0" class="palette-ibtn-badge">
                  {{ activeFilterCount > 9 ? "9+" : activeFilterCount }}
                </span>
              </button>
            </template>
          </v-tooltip>
          <v-tooltip
            text="Analysis: plot object properties against each other and lasso-select objects to keep"
          >
            <template v-slot:activator="{ props: activatorProps }">
              <button
                v-bind="activatorProps"
                type="button"
                class="palette-ibtn"
                :class="{ active: analysisPanel }"
                aria-label="Analysis plots"
                @click.stop="togglePalette('analysisPanel')"
              >
                <v-icon size="18">mdi-chart-scatter-plot</v-icon>
              </button>
            </template>
          </v-tooltip>
          <v-tooltip
            text="Snapshots for bookmarking and downloading cropped regions in your dataset"
          >
            <template v-slot:activator="{ props: activatorProps }">
              <button
                v-bind="activatorProps"
                :data-tour="TOUR_ANCHORS.snapshotsButton"
                v-tour-trigger="TOUR_TRIGGERS.snapshotsButton"
                type="button"
                class="palette-ibtn"
                :class="{ active: snapshotPanel }"
                aria-label="Snapshots"
                @click.stop="togglePalette('snapshotPanel')"
              >
                <v-icon size="18">mdi-camera-outline</v-icon>
              </button>
            </template>
          </v-tooltip>
          <v-tooltip text="Image and object display settings">
            <template v-slot:activator="{ props: activatorProps }">
              <button
                v-bind="activatorProps"
                :data-tour="TOUR_ANCHORS.settingsButton"
                v-tour-trigger="TOUR_TRIGGERS.settingsButton"
                type="button"
                class="palette-ibtn"
                :class="{ active: settingsPanel }"
                aria-label="Settings"
                @click.stop="togglePalette('settingsPanel')"
              >
                <v-icon size="18">mdi-tune</v-icon>
              </button>
            </template>
          </v-tooltip>
        </div>
        <v-tooltip
          text="Measure objects: configure and run property computations"
        >
          <template v-slot:activator="{ props: activatorProps }">
            <v-btn
              v-bind="activatorProps"
              :data-tour="TOUR_ANCHORS.analyzeButton"
              v-tour-trigger="TOUR_TRIGGERS.analyzeButton"
              variant="text"
              icon
              size="small"
              class="ml-1"
              aria-label="Measure objects"
              @click="analyzeDialogOpen = true"
            >
              <v-icon>mdi-ruler-square</v-icon>
            </v-btn>
          </template>
        </v-tooltip>
        <data-io-menu class="ml-1" />
      </template>
      <div class="mx-4 d-flex align-center">
        <v-menu>
          <template v-slot:activator="{ props: activatorProps }">
            <v-btn
              v-bind="activatorProps"
              :data-tour="TOUR_ANCHORS.helpButton"
              v-tour-trigger="TOUR_TRIGGERS.helpButton"
              variant="text"
              icon
              size="small"
            >
              <v-icon>mdi-help-circle-outline</v-icon>
            </v-btn>
          </template>

          <v-card min-width="300">
            <v-list>
              <!-- HUD Option -->
              <v-list-item @click="toggleHelpDialogUsingHotkey">
                <template #prepend>
                  <v-icon>mdi-view-dashboard-outline</v-icon>
                </template>
                <v-list-item-title
                  >Show heads up display (tab)</v-list-item-title
                >
              </v-list-item>

              <v-divider></v-divider>

              <!-- Documentation Link -->
              <v-list-item href="https://docs.nimbusimage.com" target="_blank">
                <template #prepend>
                  <v-icon>mdi-book-open-variant</v-icon>
                </template>
                <v-list-item-title>Documentation</v-list-item-title>
              </v-list-item>

              <v-divider></v-divider>

              <!-- Search Box -->
              <v-list-item @click.stop>
                <v-text-field
                  v-model="tourSearch"
                  label="Search tours"
                  density="compact"
                  hide-details
                  prepend-inner-icon="mdi-magnify"
                  clearable
                  @click.stop
                  @click:clear.stop
                ></v-text-field>
              </v-list-item>

              <!-- Tours List -->
              <template
                v-for="(tours, category) in filteredToursByCategory"
                :key="category"
              >
                <v-list-subheader>{{ category }}</v-list-subheader>
                <v-list-item
                  v-for="(tour, tourId) in tours"
                  :key="tourId"
                  @click="handleTourStart(tourId)"
                >
                  <template #prepend v-if="tour.popular">
                    <v-icon color="yellow-darken-2">mdi-star</v-icon>
                  </template>
                  <v-list-item-title>{{ tour.name }}</v-list-item-title>
                </v-list-item>
              </template>
            </v-list>
          </v-card>
        </v-menu>
        <server-status />
        <user-menu />
        <v-tooltip
          v-if="canUseAiPanel"
          text="Open the Nimbus AI panel: an assistant that can drive the interface for you"
        >
          <template v-slot:activator="{ props: activatorProps }">
            <v-btn
              v-bind="activatorProps"
              variant="text"
              icon
              size="small"
              @click="toggleAiPanel"
            >
              <v-icon>mdi-robot-outline</v-icon>
            </v-btn>
          </template>
        </v-tooltip>
      </div>
    </v-app-bar>

    <ai-panel
      v-if="aiPanelOpen && canUseAiPanel"
      @close="aiPanelOpen = false"
    />

    <v-main>
      <router-view />
    </v-main>

    <v-navigation-drawer
      v-model="analyzePanel"
      location="right"
      :scrim="false"
      :width="RIGHT_PALETTE_WIDTHS.analyze"
      :mobile="false"
    >
      <analyze-annotations />
    </v-navigation-drawer>

    <floating-palette
      v-model="settingsPanel"
      title="Settings"
      :width="RIGHT_PALETTE_WIDTHS.settings"
    >
      <annotations-settings />
    </floating-palette>

    <floating-palette
      v-model="snapshotPanel"
      title="Snapshots"
      :width="RIGHT_PALETTE_WIDTHS.snapshots"
    >
      <snapshots :snapshotVisible="snapshotPanel" />
    </floating-palette>

    <floating-palette
      v-model="annotationPanel"
      title="Object Browser"
      :width="RIGHT_PALETTE_WIDTHS.objectBrowser"
      :top="annotationBrowserTop"
      :max-height="annotationBrowserMaxHeight"
    >
      <annotation-browser></annotation-browser>
    </floating-palette>

    <floating-palette
      ref="filtersPaletteRef"
      v-model="filtersPanel"
      title="Filters"
      :width="RIGHT_PALETTE_WIDTHS.filters"
      :max-height="filtersMaxHeight"
    >
      <filters-panel />
    </floating-palette>

    <floating-palette
      v-model="analysisPanel"
      title="Analysis"
      :width="RIGHT_PALETTE_WIDTHS.analysis"
    >
      <!-- FloatingPalette keeps its content mounted and hides it with
           display:none, so the panel needs the open state explicitly: without
           it, its property-value fetch would run on every dataset open even for
           users who never open the palette. -->
      <analysis-panel :visible="analysisPanel" />
    </floating-palette>

    <template v-if="store.dataset && routeName === 'datasetview'">
      <floating-palette
        ref="navigatorPaletteRef"
        v-model="navigatorPanel"
        title="Navigator"
        :left="PALETTE_INSET"
        :width="LEFT_COLUMN_PALETTE_WIDTHS.navigator"
      >
        <navigator-panel />
      </floating-palette>

      <!-- Sits immediately right of the Navigator rather than in the left
           stack, so turning the mode on doesn't push Layers and Tools down.
           Visibility IS the mode: closing the palette turns timelapse off, so
           there is no "mode on, panel hidden" state to reason about. -->
      <floating-palette
        ref="timelapsePaletteRef"
        v-model="timelapsePanel"
        title="Time Lapse"
        :left="RIGHT_OF_LEFT_COLUMN"
        :width="TIMELAPSE_PALETTE_WIDTH"
      >
        <timelapse-panel />
      </floating-palette>

      <floating-palette
        ref="layersPaletteRef"
        v-model="layersPanel"
        title="Layers"
        :left="PALETTE_INSET"
        :width="LEFT_COLUMN_PALETTE_WIDTHS.layers"
        :top="layersPanelTop"
        :max-height="layersPanelMaxHeight"
      >
        <layers-panel />
      </floating-palette>

      <floating-palette
        v-model="toolsPanel"
        title="Tools"
        :left="PALETTE_INSET"
        :width="LEFT_COLUMN_PALETTE_WIDTHS.tools"
        :top="toolsPanelTop"
        :max-height="toolsPanelMaxHeight"
      >
        <toolset />
      </floating-palette>
    </template>

    <analyze-dialog v-model="analyzeDialogOpen" @show-in-list="onShowInList" />
    <pipeline-dialog v-model="pipelineDialogOpen" />
  </v-app>
</template>

<script setup lang="ts">
import {
  ref,
  computed,
  watch,
  nextTick,
  onMounted,
  onBeforeUnmount,
  Ref,
  ComponentPublicInstance,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import axios from "axios";
import UserMenu from "./layout/UserMenu.vue";
import ServerStatus from "./components/ServerStatus.vue";
import AnalyzeAnnotations from "./components/AnalyzePanel.vue";
import AnnotationsSettings from "./components/SettingsPanel.vue";
import Snapshots from "./components/Snapshots.vue";
import AnnotationBrowser from "@/components/AnnotationBrowser/AnnotationBrowser.vue";
import DataIoMenu from "@/components/DataIOMenu.vue";
import FiltersPanel from "@/components/FiltersPanel.vue";
import AnalysisPanel from "@/components/AnalysisPanel.vue";
import AnalyzeDialog from "@/components/AnalyzeDialog.vue";
import PipelineDialog from "@/components/PipelineDialog.vue";
import UndoRedoButtons from "@/components/UndoRedoButtons.vue";
import NavigatorPanel from "@/components/NavigatorPanel.vue";
import TimelapsePanel from "@/components/TimelapsePanel.vue";
import LayersPanel from "@/components/LayersPanel.vue";
import Toolset from "@/tools/toolsets/Toolset.vue";
import HelpPanel from "./components/HelpPanel.vue";
import BreadCrumbs from "./layout/BreadCrumbs.vue";
import store from "@/store";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";
import volumeViewStore from "@/store/volumeView";
import aiPanelStore from "@/store/aiPanel";
import timelapseStore from "@/store/timelapse";
import { logError } from "@/utils/log";
import { IHotkey } from "@/utils/v-mousetrap";
import {
  ACTION_PANEL_TOP,
  AI_PANEL_WIDTH,
  LEFT_COLUMN_PALETTE_WIDTHS,
  LEFT_PALETTE_CLEAR_X,
  PALETTE_GAP,
  PALETTE_INSET,
  RIGHT_EDGE_OVERLAY_INSETS,
  RIGHT_OF_LEFT_COLUMN,
  RIGHT_PALETTE_WIDTHS,
  STACKED_ACTION_PANEL_OFFSET,
  TIMELAPSE_PALETTE_WIDTH,
  actionPanelClearsTimelapsePalette,
  rightEdgeClearX,
} from "@/utils/paletteGeometry";
import AiPanel from "@/components/AiPanel.vue";
import FloatingPalette from "@/components/FloatingPalette.vue";
import { IGirderFolder } from "@/girder";
import { ITourMetadata } from "./store/model";
import { useTour } from "@/utils/useTour";
import { TOUR_ANCHORS, TOUR_TRIGGERS } from "@/tours/anchors";

// Suppress unused import warnings for template-only components
void UserMenu;
void ServerStatus;
void AnalyzeAnnotations;
void AnnotationsSettings;
void Snapshots;
void AnnotationBrowser;
void FiltersPanel;
void AnalysisPanel;
void AnalyzeDialog;
void PipelineDialog;
void UndoRedoButtons;
void NavigatorPanel;
void TimelapsePanel;
void LayersPanel;
void Toolset;
void HelpPanel;
void BreadCrumbs;
void AiPanel;

const route = useRoute();
const router = useRouter();
const { startTour, loadAllTours: loadAllToursFromManager } = useTour();

const tourSearch = ref("");
const availableTours = ref<Record<string, ITourMetadata>>({});

const snapshotPanel = ref(false);
const snapshotPanelFull = ref(false);
const annotationPanel = ref(false);
const settingsPanel = ref(false);
const filtersPanel = ref(false);
const analysisPanel = ref(false);
const analyzePanel = ref(false);
const aiPanelOpen = ref(false);

// Not a plain ref and not in the palette registry: the Timelapse palette has no
// independent open state, it mirrors the mode. Registering it would also let
// the left-zone stacking treat it as part of the Navigator/Layers/Tools column,
// which is exactly what it is positioned to avoid.
const timelapsePanel = computed({
  get: () => timelapseStore.showMode,
  set: (value: boolean) => timelapseStore.setShowMode(value),
});

/**
 * Palette geometry, projected onto `<v-app>` so the stylesheets read the same
 * numbers `@/utils/paletteGeometry` computes instead of transcribing them.
 *
 * `--nimbus-right-edge-clear-x` is a single resolved offset rather than a class
 * per overlay. The class-per-overlay version only knew about the Object Browser,
 * which left the selection panels drawn underneath the AI panel (z-index 2001 vs
 * their 1000) with 6 of their 8 buttons unhittable; and each new right-edge
 * overlay would have doubled the number of CSS rules. Resolving the max here
 * makes adding one a single term in `rightEdgeClearX`.
 */
// The AI panel is gated behind a build-time flag (enabled unless explicitly
// set to "false") and requires a logged-in user: the claude_agent endpoint is
// @access.user, so anonymous users would only hit 401s. Deployments without
// the plugin/API key can disable it entirely with the flag. See
// AI_PANEL_SPEC.md §7 and AI_PANEL_REVIEW.md finding #6.
const aiPanelFeatureEnabled = import.meta.env.VITE_AI_PANEL_ENABLED !== "false";
const canUseAiPanel = computed(
  () => aiPanelFeatureEnabled && store.isLoggedIn && !!store.girderUser,
);

// EVERY right-edge overlay that OVERLAYS the canvas. All the palettes below omit
// `:left`, so FloatingPalette anchors them right at z-index 1006; the AI panel is
// fixed at 2001. The selection action panels are 1000, so any of them covers the
// panels' buttons, and none is mutually exclusive with timelapse mode.
//
// The Analyze drawer is deliberately NOT here. It is a `v-navigation-drawer
// location="right"`, which SHIFTS the layout instead of floating over it: the
// action panels are `position: absolute` inside `.image`, and the drawer narrows
// that container, so its strip is already excluded from the box `right:` is
// measured against. Adding a clearance for it double-counts and pushes the panels
// left — measured with the drawer open, container 0–1204 and the panel at
// 533–708 (= 1204 − 496 − 175), which puts them back under the Timelapse palette
// at 444–744, i.e. straight back into the bug this whole mechanism fixes.
const rightEdgeClearance = computed(() =>
  rightEdgeClearX([
    { open: annotationPanel.value, width: RIGHT_PALETTE_WIDTHS.objectBrowser },
    { open: filtersPanel.value, width: RIGHT_PALETTE_WIDTHS.filters },
    { open: analysisPanel.value, width: RIGHT_PALETTE_WIDTHS.analysis },
    { open: settingsPanel.value, width: RIGHT_PALETTE_WIDTHS.settings },
    { open: snapshotPanel.value, width: RIGHT_PALETTE_WIDTHS.snapshots },
    {
      open: aiPanelOpen.value && canUseAiPanel.value,
      width: AI_PANEL_WIDTH,
      inset: RIGHT_EDGE_OVERLAY_INSETS.aiPanel,
    },
  ]),
);

/**
 * Where the selection action panels sit vertically.
 *
 * Normally the top of the canvas. In timelapse mode they move to the right edge
 * to clear the Timelapse palette — but on a narrow viewport the right edge and
 * that palette meet in the middle, and no horizontal placement clears both. At
 * 1280px with the Object Browser open (what "Show tracks" produces) a panel
 * anchored 544px from the right lands at x 526–736, inside the palette's 444–744,
 * and loses on z-index. Below roughly 1500px they therefore drop BELOW the
 * palette, using its measured height so the offset tracks its real content.
 */
const actionPanelTop = computed(() => {
  if (!timelapsePanel.value || !isDatasetView.value) {
    return ACTION_PANEL_TOP;
  }
  if (
    actionPanelClearsTimelapsePalette(
      windowWidth.value,
      rightEdgeClearance.value,
    )
  ) {
    return ACTION_PANEL_TOP;
  }
  return (
    PALETTE_TOP +
    (timelapsePaletteHeight.value
      ? timelapsePaletteHeight.value + STACK_GAP
      : 0)
  );
});

const paletteGeometryVars = computed(() => ({
  "--nimbus-left-palette-clear-x": `${LEFT_PALETTE_CLEAR_X}px`,
  "--nimbus-right-edge-clear-x": `${rightEdgeClearance.value}px`,
  "--nimbus-action-panel-top": `${actionPanelTop.value}px`,
  // The connection panel stacks a fixed distance below the object panel, so it
  // has to follow whenever that one moves.
  "--nimbus-stacked-action-panel-top": `${
    actionPanelTop.value + STACKED_ACTION_PANEL_OFFSET
  }px`,
}));

function toggleAiPanel() {
  if (!canUseAiPanel.value) {
    return;
  }
  aiPanelOpen.value = !aiPanelOpen.value;
}

// Clear the AI-panel conversation whenever the authenticated user changes.
// Login/logout is client-side (no page reload), so the module-level wire
// history would otherwise carry one user's prompts and results into the next
// user's session. See codebaseDocumentation/AI_PANEL_REVIEW.md finding #4.
watch(
  () => store.girderUser?._id ?? null,
  (userId) => aiPanelStore.handleAuthenticatedUserChange(userId),
  { immediate: true },
);

// Close the panel if the gate closes under it (e.g. the user logs out).
watch(canUseAiPanel, (usable) => {
  if (!usable) {
    aiPanelOpen.value = false;
  }
});

// Left-zone palettes (dissolved left sidebar). Open by default.
const navigatorPanel = ref(true);
const toolsPanel = ref(true);
const layersPanel = ref(true);

// When the whole left stack is open it reaches the bottom-left corner and
// would cover the canvas's palette/lock/reset buttons; ImageViewer shifts
// them right while this is true (see `.left-palettes-open` in ImageViewer).
const allLeftPalettesOpen = computed(
  () => navigatorPanel.value && layersPanel.value && toolsPanel.value,
);

// Looser variant: any single left palette covers the left edge of the canvas
// enough to obscure floating UI rooted at a click point (e.g. the annotation
// right-click context menu). Surfaces that need to dodge ANY open left palette
// (not just the whole stack) read `.any-left-palette-open`.
const anyLeftPaletteOpen = computed(
  () => navigatorPanel.value || layersPanel.value || toolsPanel.value,
);

// The Measure dialog is mounted once here but can be opened from several
// places (app-bar ruler, Object Browser), so its open state lives in the
// store rather than a local ref.
const analyzeDialogOpen = computed({
  get: () => store.isAnalyzeDialogOpen,
  set: (value: boolean) => store.setIsAnalyzeDialogOpen(value),
});

const pipelineDialogOpen = computed({
  get: () => store.isPipelineDialogOpen,
  set: (value: boolean) => store.setIsPipelineDialogOpen(value),
});

const isUploadLoading = ref(false);
const helpPanelIsOpen = ref(false);

// --- Palette layout ---------------------------------------------------------
//
// The dataset view hosts palettes on two edges. Each declares a `zone` (which
// edge it lives on) and a `role`.
//
// Right zone behaves as a mutually-exclusive column:
//   * "primary" palettes (Object Browser / Snapshots / Settings) own the
//     column — opening one closes the others.
//   * the "companion" (Filters) may share the column, but only alongside its
//     host primary (the Object Browser); any other primary evicts it.
//
// Left zone (dissolved sidebar: Navigator / Layers / Tools) is an independent
// vertical stack — all three can be open at once and flow top-to-bottom in a
// fixed order, each positioned beneath the open palettes above it.
//
// The two zones are independent, so a left palette and a right palette can be
// open simultaneously.
type PaletteId =
  | "annotationPanel"
  | "filtersPanel"
  | "analysisPanel"
  | "snapshotPanel"
  | "settingsPanel"
  | "navigatorPanel"
  | "toolsPanel"
  | "layersPanel";

type PaletteZone = "left" | "right";

interface PaletteRole {
  role: "primary" | "companion";
  zone: PaletteZone;
  // Primaries a companion may share the column with. A companion evicts any
  // primary NOT listed here.
  hosts?: PaletteId[];
}

const paletteOpen: Record<PaletteId, Ref<boolean>> = {
  annotationPanel,
  filtersPanel,
  analysisPanel,
  snapshotPanel,
  settingsPanel,
  navigatorPanel,
  toolsPanel,
  layersPanel,
};

const paletteRoles: Record<PaletteId, PaletteRole> = {
  annotationPanel: { role: "primary", zone: "right" },
  analysisPanel: { role: "primary", zone: "right" },
  snapshotPanel: { role: "primary", zone: "right" },
  settingsPanel: { role: "primary", zone: "right" },
  // Filters hosts alongside both the Object Browser and the Analysis panel:
  // the Analysis panel's own guidance above the cap is "narrow the filters",
  // which would be self-defeating if opening Filters closed it.
  filtersPanel: {
    role: "companion",
    zone: "right",
    hosts: ["annotationPanel", "analysisPanel"],
  },
  navigatorPanel: { role: "primary", zone: "left" },
  toolsPanel: { role: "primary", zone: "left" },
  layersPanel: { role: "primary", zone: "left" },
};

const paletteIds = Object.keys(paletteRoles) as PaletteId[];

function openPalette(id: PaletteId) {
  const def = paletteRoles[id];
  // Only the right zone has mutex/companion relationships; left-zone palettes
  // stack independently and never evict each other.
  if (def.zone === "right") {
    for (const other of paletteIds) {
      if (other === id || paletteRoles[other].zone !== "right") {
        continue;
      }
      const otherDef = paletteRoles[other];
      if (def.role === "primary") {
        // A new primary clears every other primary, plus any companion that
        // doesn't host with it.
        if (
          otherDef.role === "primary" ||
          !(otherDef.hosts ?? []).includes(id)
        ) {
          paletteOpen[other].value = false;
        }
      } else if (
        otherDef.role === "primary" &&
        !(def.hosts ?? []).includes(other)
      ) {
        // A companion evicts any primary that isn't one of its hosts.
        paletteOpen[other].value = false;
      }
    }
  }
  paletteOpen[id].value = true;
}

function togglePalette(id: PaletteId) {
  if (paletteOpen[id].value) {
    paletteOpen[id].value = false;
  } else {
    openPalette(id);
  }
}

const is3DView = computed(() => volumeViewStore.viewMode === "3d");
function toggle3DView() {
  volumeViewStore.setViewMode(is3DView.value ? "2d" : "3d");
}

function closeAllPalettes() {
  for (const id of paletteIds) {
    paletteOpen[id].value = false;
  }
}

// --- Stacked positioning ----------------------------------------------------
//
// Palettes that share a column flow vertically: each measures the rendered
// height of the palette(s) above it (via ResizeObserver) so the next one sits
// flush beneath with no dead gap. Used by both the right-zone Filters/Browser
// pair and the left-zone Navigator/Layers/Tools stack.
const PALETTE_TOP = ACTION_PANEL_TOP; // clears the floating app bar
const COLUMN_BOTTOM_INSET = 16;
const STACK_GAP = PALETTE_GAP;
const MIN_BROWSER_HEIGHT = 260; // keep the Browser usable when stacked

type PaletteRefEl = ComponentPublicInstance & { rootEl?: HTMLElement };

// Observe a FloatingPalette's rendered height into `heightRef`. Guarded for
// non-DOM test environments. Returns a disconnect-able observer (or null).
function observePaletteHeight(
  paletteRef: Ref<PaletteRefEl | undefined>,
  heightRef: Ref<number>,
): ResizeObserver | null {
  if (typeof ResizeObserver === "undefined") {
    return null;
  }
  const el = paletteRef.value?.rootEl;
  if (!el) {
    return null;
  }
  const observer = new ResizeObserver(() => {
    // Don't write height (and trigger a re-layout / re-render) while a layer
    // drag is underway — that re-renders the draggable mid-drag and corrupts
    // its vnode tree. The final size is re-measured when the drag ends.
    if (store.isLayerDragging) {
      return;
    }
    heightRef.value = el.offsetHeight;
  });
  observer.observe(el);
  return observer;
}

// Right zone: Filters stacks above the Object Browser.
const filtersPaletteRef = ref<PaletteRefEl>();
const filtersHeight = ref(0);
let filtersResizeObserver: ResizeObserver | null = null;

const filtersStacked = computed(
  () => filtersPanel.value && annotationPanel.value,
);

const annotationBrowserTop = computed(() =>
  filtersStacked.value
    ? PALETTE_TOP + filtersHeight.value + STACK_GAP
    : PALETTE_TOP,
);

const annotationBrowserMaxHeight = computed(
  () => `calc(100vh - ${annotationBrowserTop.value + COLUMN_BOTTOM_INSET}px)`,
);

// When stacked, cap Filters so the Browser always keeps a minimum height.
const filtersMaxHeight = computed(() =>
  filtersStacked.value
    ? `calc(100vh - ${
        PALETTE_TOP + COLUMN_BOTTOM_INSET + MIN_BROWSER_HEIGHT + STACK_GAP
      }px)`
    : `calc(100vh - ${PALETTE_TOP + COLUMN_BOTTOM_INSET}px)`,
);

// Left zone: Navigator (top) -> Layers -> Tools stack, each flowing beneath
// the open palettes above it. Navigator uses FloatingPalette defaults.
const navigatorPaletteRef = ref<PaletteRefEl>();
const layersPaletteRef = ref<PaletteRefEl>();
const navigatorHeight = ref(0);
const layersHeight = ref(0);
// The Timelapse palette is not in the left stack, but its height is needed to
// drop the selection action panels below it on a narrow viewport.
const timelapsePaletteRef = ref<PaletteRefEl>();
const timelapsePaletteHeight = ref(0);

// Viewport width, for the one placement decision that depends on it (see
// `actionPanelTop`). Guarded for non-DOM test environments.
const windowWidth = ref(typeof window === "undefined" ? 0 : window.innerWidth);
function updateWindowWidth() {
  windowWidth.value = window.innerWidth;
}
let navigatorResizeObserver: ResizeObserver | null = null;
let layersResizeObserver: ResizeObserver | null = null;
let timelapseResizeObserver: ResizeObserver | null = null;

const layersPanelTop = computed(
  () =>
    PALETTE_TOP +
    (navigatorPanel.value && navigatorHeight.value
      ? navigatorHeight.value + STACK_GAP
      : 0),
);

const toolsPanelTop = computed(
  () =>
    layersPanelTop.value +
    (layersPanel.value && layersHeight.value
      ? layersHeight.value + STACK_GAP
      : 0),
);

const layersPanelMaxHeight = computed(
  () => `calc(100vh - ${layersPanelTop.value + COLUMN_BOTTOM_INSET}px)`,
);

const toolsPanelMaxHeight = computed(
  () => `calc(100vh - ${toolsPanelTop.value + COLUMN_BOTTOM_INSET}px)`,
);

// The left palettes live inside a v-if, so attach their observers once they
// mount (and tear down when leaving the dataset view).
const leftPalettesMounted = computed(
  () => !!store.dataset && routeName.value === "datasetview",
);

function setupLeftPaletteObservers() {
  navigatorResizeObserver?.disconnect();
  layersResizeObserver?.disconnect();
  navigatorResizeObserver = observePaletteHeight(
    navigatorPaletteRef,
    navigatorHeight,
  );
  layersResizeObserver = observePaletteHeight(layersPaletteRef, layersHeight);
  timelapseResizeObserver = observePaletteHeight(
    timelapsePaletteRef,
    timelapsePaletteHeight,
  );
}

function teardownLeftPaletteObservers() {
  navigatorResizeObserver?.disconnect();
  layersResizeObserver?.disconnect();
  timelapseResizeObserver?.disconnect();
  navigatorResizeObserver = null;
  layersResizeObserver = null;
  timelapseResizeObserver = null;
  timelapsePaletteHeight.value = 0;
  navigatorHeight.value = 0;
  layersHeight.value = 0;
}

function toggleHelpDialogUsingHotkey() {
  helpPanelIsOpen.value = !helpPanelIsOpen.value;
}

const appHotkeys: IHotkey = {
  bind: "tab",
  handler: toggleHelpDialogUsingHotkey,
  data: {
    section: "Global",
    description: "Toggle help dialog",
  },
};

function fetchConfig() {
  axios
    .get("config/templates.json")
    .then((resp) => {
      store.setToolTemplateList(resp.data);
    })
    .catch((err) => {
      logError(err);
      throw err;
    });
}

async function loadAllTours() {
  availableTours.value = await loadAllToursFromManager();
}

function goHome() {
  router.push({ name: "root" });
}

function onShowInList() {
  if (!annotationPanel.value) {
    openPalette("annotationPanel");
  }
}

const routeName = computed(() => route.name);
const isDatasetView = computed(() => routeName.value === "datasetview");

const activeFilterCount = computed(() => filterStore.activeFilterCount);

const filtersTooltip = computed(() => {
  const base = "Filter objects by tags, scope, properties, ID and region";
  const count = activeFilterCount.value;
  if (count === 0) {
    return base;
  }
  return `${base} (${count} active filter${count === 1 ? "" : "s"})`;
});

// The aria-label stays terse to match the sibling palette buttons ("Object
// list", "Snapshots", "Settings"); the descriptive sentence belongs in the
// hover tooltip. It carries the count because aria-label overrides the
// button's content, which would otherwise hide the badge from assistive tech.
const filtersAriaLabel = computed(() =>
  activeFilterCount.value === 0
    ? "Filters"
    : `Filters (${activeFilterCount.value} active)`,
);

const hasUncomputedProperties = computed(() => {
  const counts = propertyStore.uncomputedCountByProperty;
  for (const id in counts) {
    if (counts[id] > 0) {
      return true;
    }
  }
  return false;
});

const filteredToursByCategory = computed(
  (): Record<string, Record<string, ITourMetadata>> => {
    const tours = availableTours.value;
    const filtered = Object.entries(tours).filter(([, tour]) => {
      const matchesSearch = tour.name
        .toLowerCase()
        .includes(tourSearch.value.toLowerCase());

      const isDatasetTour = tour.entryPoint === "datasetview";
      const isDatasetView = routeName.value === "datasetview";
      const isAllowedOnCurrentRoute = isDatasetView || !isDatasetTour;

      return matchesSearch && isAllowedOnCurrentRoute;
    });

    return filtered.reduce(
      (acc: Record<string, Record<string, ITourMetadata>>, [id, tour]) => {
        const category = tour.category || "General";
        if (!acc[category]) {
          acc[category] = {};
        }
        acc[category][id] = tour;
        return acc;
      },
      {},
    );
  },
);

function handleTourStart(tourId: string) {
  const tour = availableTours.value[tourId];
  if (tour && tour.entryPoint !== routeName.value) {
    router.push({ name: tour.entryPoint });
  }
  startTour(tourId);
}

async function goToNewDataset() {
  if (isUploadLoading.value) return;

  isUploadLoading.value = true;

  let privateFolder: IGirderFolder | null = null;
  try {
    privateFolder = await store.api.getUserPrivateFolder();
    if (!privateFolder) {
      throw new Error("Could not access private folder");
    }
  } catch (error) {
    logError(error);
  } finally {
    store.initializeUploadWorkflow({
      quickupload: false,
      batchMode: false,
      batchName: "",
      fileGroups: [],
      datasetNames: [],
      initialUploadLocation: privateFolder,
      initialName: "",
      initialDescription: "",
    });
    router.push({ name: "newdataset" });
    isUploadLoading.value = false;
  }
}

function annotationPanelChanged() {
  store.setIsAnnotationPanelOpen(annotationPanel.value);
}

function datasetChanged() {
  if (routeName.value !== "datasetview") {
    closeAllPalettes();
  } else {
    // Left palettes (Navigator / Tools / Layers) open by default on each entry.
    navigatorPanel.value = true;
    toolsPanel.value = true;
    layersPanel.value = true;
  }
}

watch(annotationPanel, () => annotationPanelChanged());

// The reverse direction, so `store.openAnnotationBrowserTab` can reach the
// palette registry from a component that has no access to it (the Timelapse
// panel's "Show tracks"). Both watchers only ever write a value that differs
// from what they read, so the pair settles rather than ping-pongs.
watch(
  () => store.isAnnotationPanelOpen,
  (open) => {
    if (open === annotationPanel.value) {
      return;
    }
    if (open) {
      openPalette("annotationPanel");
    } else {
      annotationPanel.value = false;
    }
  },
);

watch(routeName, () => datasetChanged());

// Left palettes mount/unmount with the dataset view, so (re)attach their
// height observers whenever they appear.
watch(
  leftPalettesMounted,
  async (mounted) => {
    if (mounted) {
      await nextTick();
      setupLeftPaletteObservers();
    } else {
      teardownLeftPaletteObservers();
    }
  },
  { immediate: true },
);

// Height observers are paused during a layer drag (see observePaletteHeight),
// so re-measure once it ends to settle the stack at the final heights.
watch(
  () => store.isLayerDragging,
  async (dragging) => {
    if (dragging) {
      return;
    }
    await nextTick();
    const navEl = navigatorPaletteRef.value?.rootEl;
    const layEl = layersPaletteRef.value?.rootEl;
    if (navEl) {
      navigatorHeight.value = navEl.offsetHeight;
    }
    if (layEl) {
      layersHeight.value = layEl.offsetHeight;
    }
  },
);

onMounted(() => {
  fetchConfig();
  loadAllTours();
  window.addEventListener("resize", updateWindowWidth);
  updateWindowWidth();

  // The Filters palette is always mounted, so observe it directly.
  filtersResizeObserver = observePaletteHeight(
    filtersPaletteRef,
    filtersHeight,
  );
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", updateWindowWidth);
  filtersResizeObserver?.disconnect();
  teardownLeftPaletteObservers();
});

defineExpose({
  tourSearch,
  availableTours,
  snapshotPanel,
  snapshotPanelFull,
  annotationPanel,
  settingsPanel,
  filtersPanel,
  navigatorPanel,
  toolsPanel,
  layersPanel,
  analyzePanel,
  aiPanelOpen,
  canUseAiPanel,
  isUploadLoading,
  helpPanelIsOpen,
  appHotkeys,
  routeName,
  activeFilterCount,
  filtersTooltip,
  filtersAriaLabel,
  hasUncomputedProperties,
  filteredToursByCategory,
  filtersStacked,
  annotationBrowserTop,
  fetchConfig,
  loadAllTours,
  goHome,
  togglePalette,
  openPalette,
  closeAllPalettes,
  toggleHelpDialogUsingHotkey,
  handleTourStart,
  goToNewDataset,
});
</script>
<style lang="scss" scoped>
.logo {
  cursor: pointer;
  text-overflow: unset;
  overflow: unset;
  flex: 0 0 auto;
}

/* Base tone of the palette cluster, deliberately theme-independent. The badge
   below reuses it opaque as a separating ring, so the two must stay in sync. */
$palette-cluster-tone: #0f1217;

/* Cluster of palette-toggle icon buttons in the app bar.
   Pill-shaped group with hairline border; each button is a 32px circle. */
.palette-cluster {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  margin-left: 12px;
  border-radius: 100px;
  background: rgba($palette-cluster-tone, 0.55);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.08));
}

.palette-ibtn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: transparent;
  color: var(--nimbus-text-secondary, #d0d6e0);
  border: none;
  cursor: pointer;
  display: grid;
  place-items: center;
  position: relative;
  transition:
    background 0.15s ease,
    color 0.15s ease;

  &:hover {
    background: rgba(255, 255, 255, 0.06);
    color: var(--nimbus-text-secondary, #f3f5f7);
  }

  &.active {
    background: rgba(var(--v-theme-primary), 0.18);
    color: rgb(var(--v-theme-primary));
    box-shadow: 0 0 0 1px rgba(var(--v-theme-primary), 0.25);
  }

  &.active::after {
    content: "";
    position: absolute;
    bottom: -7px;
    left: 50%;
    transform: translateX(-50%);
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: rgb(var(--v-theme-primary));
    box-shadow: 0 0 6px rgba(var(--v-theme-primary), 0.6);
  }
}

/* Count badge pinned to the top-right of a palette-toggle button (used by
   Filters to surface the number of active filters while the panel is closed).
   The ring reuses the cluster's own tone, opaque, so the count reads as
   separate from the icon glyph it overlaps. It stays within the cluster's 4px
   padding and its 2px inter-button gap, so it never covers a neighbour. */
.palette-ibtn-badge {
  position: absolute;
  top: -1px;
  right: -1px;
  box-sizing: border-box;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  border: 1.5px solid $palette-cluster-tone;
  border-radius: 8px;
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--nimbus-font);
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  pointer-events: none;
}
</style>
<style lang="scss">
body > div {
  overflow: hidden;
}

/* Vuetify 3 defaults --v-list-prepend-gap to 32px, which is too wide for
   most lists in this app. Override globally to a tighter 8px. Individual
   components can still override via the same CSS variable if needed. */
.v-list {
  --v-list-prepend-gap: 8px;
}

.v-navigation-drawer {
  z-index: 100;
}

.logo-icon {
  height: 50px;
  margin-top: 10px;
}

.logo-icon .bird {
  transform-origin: var(--ox) var(--oy);
}

.logo:hover .bird-1 {
  animation: flap-top 1.8s ease-in-out infinite;
}

.logo:hover .bird-2 {
  animation: flap-bottom 1.8s ease-in-out infinite 0.4s;
}

@keyframes flap-top {
  0%,
  100% {
    transform: rotate(-25deg) scaleY(1) rotate(25deg);
  }
  25% {
    transform: rotate(-25deg) scaleY(0.35) rotate(25deg);
  }
  50% {
    transform: rotate(-25deg) scaleY(1.1) rotate(25deg);
  }
  75% {
    transform: rotate(-25deg) scaleY(0.65) rotate(25deg);
  }
}

@keyframes flap-bottom {
  0%,
  100% {
    transform: scaleY(1);
  }
  25% {
    transform: scaleY(0.35);
  }
  50% {
    transform: scaleY(1.1);
  }
  75% {
    transform: scaleY(0.65);
  }
}

.v-menu__content {
  z-index: 10000 !important;
}

.help-dialog-overlay {
  background: transparent;
  box-shadow: none;
  max-height: 100%;
}

/* Secondary text uses nimbus muted token */
.text-grey {
  color: var(--nimbus-text-muted);
}

/* Type-indicator chips use ghost styling */
.type-indicator.v-chip {
  background: var(--nimbus-glass) !important;
  color: var(--nimbus-text-secondary);
}
</style>
