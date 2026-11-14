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
      'timelapse-palette-open':
        isDatasetView && !embedMode && timelapsePaletteShown,
      // The montage covers the canvas; the selection action panel lifts
      // above it (see AnnotationActionPanel).
      'montage-open': isDatasetView && isMontageOpen,
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
    <!-- The embed route (a share link in an iframe) shows only the canvas. -->
    <command-palette v-if="!embedMode" v-model="commandPaletteOpen" />
    <v-app-bar v-if="!embedMode">
      <v-tooltip text="NimbusImage home" :open-delay="500">
        <template v-slot:activator="{ props: activatorProps }">
          <v-toolbar-title
            v-bind="activatorProps"
            data-command-id="nav.home"
            @click="goHome"
            class="logo"
          >
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
          <v-tooltip text="3D volume view (toggle 2D / 3D)">
            <template v-slot:activator="{ props: activatorProps }">
              <button
                v-bind="activatorProps"
                type="button"
                class="palette-ibtn"
                :class="{ active: is3DView }"
                aria-label="3D view"
                data-command-id="view.toggle3d"
                @click.stop="toggle3DView"
              >
                <v-icon size="18">mdi-cube-scan</v-icon>
              </button>
            </template>
          </v-tooltip>
          <v-tooltip text="Montage of the Object Browser's current page">
            <template v-slot:activator="{ props: activatorProps }">
              <button
                v-bind="activatorProps"
                type="button"
                class="palette-ibtn"
                :class="{ active: isMontageOpen }"
                :disabled="is3DView"
                aria-label="Montage view"
                data-command-id="view.toggleMontage"
                @click.stop="toggleMontage"
              >
                <v-icon size="18">mdi-view-grid-outline</v-icon>
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
            data-command-id="data.upload"
            @click="goToNewDataset"
          >
            Upload Data
          </v-btn>
        </template>
      </v-tooltip>
      <v-divider class="ml-1" vertical />
      <template v-if="store.dataset && routeName === 'datasetview'">
        <undo-redo-buttons class="mr-1" />
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
              data-command-id="analysis.measure"
              @click="analyzeDialogOpen = true"
            >
              <v-icon>mdi-ruler-square</v-icon>
            </v-btn>
          </template>
        </v-tooltip>
        <v-tooltip text="Color objects by a property value">
          <template v-slot:activator="{ props: activatorProps }">
            <v-btn
              v-bind="activatorProps"
              variant="text"
              icon
              size="small"
              class="ml-1"
              aria-label="Color objects by property"
              data-command-id="properties.colorBy"
              @click="colorByPropertyDialogOpen = true"
            >
              <v-icon>mdi-palette</v-icon>
            </v-btn>
          </template>
        </v-tooltip>
        <data-io-menu class="ml-1" />
      </template>
      <div class="mx-4 d-flex align-center">
        <!-- A compact pill (magnifier + hotkey hint) so the palette is
             discoverable without crowding the viewer's app bar; the palette
             itself opens centered, so the trigger needn't look like a field.
             Below the `lg` breakpoint it collapses to the icon. -->
        <v-tooltip :text="`Search commands (${commandPaletteHotkey})`">
          <template v-slot:activator="{ props: activatorProps }">
            <v-btn
              v-bind="activatorProps"
              :data-tour="TOUR_ANCHORS.commandPaletteButton"
              class="palette-search"
              variant="text"
              size="small"
              aria-label="Search commands"
              @click="commandPaletteOpen = true"
            >
              <v-icon>mdi-magnify</v-icon>
              <kbd class="palette-search-kbd">{{ commandPaletteHotkey }}</kbd>
            </v-btn>
          </template>
        </v-tooltip>
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
              <v-list-item
                data-command-id="help.hud"
                @click="toggleHelpDialogUsingHotkey"
              >
                <template #prepend>
                  <v-icon>mdi-view-dashboard-outline</v-icon>
                </template>
                <v-list-item-title
                  >Show heads up display (tab)</v-list-item-title
                >
              </v-list-item>

              <v-divider></v-divider>

              <!-- Documentation Link -->
              <v-list-item
                :href="DOCUMENTATION_URL"
                target="_blank"
                data-command-id="help.docs"
              >
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
              aria-label="Nimbus AI panel"
              data-command-id="ai.togglePanel"
              @click="toggleAiPanel"
            >
              <v-icon>mdi-robot-outline</v-icon>
            </v-btn>
          </template>
        </v-tooltip>
      </div>
    </v-app-bar>

    <!-- v-show, not v-if, for "hide all panels": the panel keeps its state
         and comes back as it was. -->
    <ai-panel
      v-if="aiPanelOpen && canUseAiPanel"
      v-show="!panelsHidden"
      @close="aiPanelOpen = false"
    />

    <v-main>
      <router-view />
    </v-main>

    <v-navigation-drawer
      :model-value="analyzePanel && !panelsHidden"
      @update:model-value="analyzePanel = $event"
      location="right"
      :scrim="false"
      :width="RIGHT_PALETTE_WIDTHS.analyze"
      :mobile="false"
    >
      <analyze-annotations :visible="analyzePanel && !panelsHidden" />
    </v-navigation-drawer>

    <!-- Each closed panel is a labeled chip in a row at the top of its zone,
         next to where it opens; the zone's palettes start below the row.
         Under "hide all panels" the left row holds only the chip that undoes
         it, so a hidden interface always shows the way back. -->
    <div
      v-for="zone in PANEL_ZONES"
      v-show="chipRowOccupied[zone]"
      :key="zone"
      :ref="observeChipRow"
      :data-zone="zone"
      class="palette-chips"
      :class="`zone-${zone}`"
      :style="chipRowStyles[zone]"
    >
      <button
        v-if="zone === 'left' && panelsHidden"
        type="button"
        class="palette-chip"
        aria-label="Show all panels"
        @click.stop="panelLayout.toggleChromeHidden()"
      >
        <v-icon size="14">mdi-eye-outline</v-icon>
        <span>Show panels</span>
      </button>
      <v-tooltip
        v-for="chip in panelChips[zone]"
        :key="chip.id"
        :text="chip.tooltip"
        location="bottom"
        :open-delay="500"
      >
        <template v-slot:activator="{ props: activatorProps }">
          <button
            v-bind="activatorProps"
            v-tour-trigger="chip.tourTrigger"
            type="button"
            class="palette-chip"
            :class="{ relevant: chip.relevant }"
            :aria-label="chip.label"
            :data-command-id="`panel.toggle.${chip.id}`"
            :data-tour="chip.tourAnchor"
            @click.stop="openPalette(chip.id)"
          >
            <v-icon size="14">{{ chip.icon }}</v-icon>
            <span>{{ chip.title }}</span>
            <span v-if="chip.badge" class="palette-chip-badge">
              {{ chip.badge }}
            </span>
          </button>
        </template>
      </v-tooltip>
    </div>

    <floating-palette
      v-model="settingsPanel"
      v-bind="paletteChrome.settingsPanel"
      :resize-range="zoneResizeRange.right"
      :title="PANEL_BY_ID.settingsPanel.title"
      :width="rightPaletteWidth(RIGHT_PALETTE_WIDTHS.settings)"
      :top="rightColumnTop"
      :max-height="rightColumnMaxHeight"
    >
      <annotations-settings />
    </floating-palette>

    <floating-palette
      v-model="snapshotPanel"
      v-bind="paletteChrome.snapshotPanel"
      :resize-range="zoneResizeRange.right"
      :title="PANEL_BY_ID.snapshotPanel.title"
      :width="rightPaletteWidth(RIGHT_PALETTE_WIDTHS.snapshots)"
      :top="rightColumnTop"
      :max-height="rightColumnMaxHeight"
    >
      <snapshots :snapshotVisible="snapshotPanel" />
    </floating-palette>

    <floating-palette
      v-model="annotationPanel"
      v-bind="paletteChrome.annotationPanel"
      :resize-range="zoneResizeRange.right"
      :title="PANEL_BY_ID.annotationPanel.title"
      :width="rightPaletteWidth(RIGHT_PALETTE_WIDTHS.objectBrowser)"
      :top="stackedHostTop"
      :max-height="stackedHostMaxHeight"
    >
      <annotation-browser :visible="annotationPanel"></annotation-browser>
    </floating-palette>

    <floating-palette
      ref="filtersPaletteRef"
      v-model="filtersPanel"
      v-bind="paletteChrome.filtersPanel"
      :resize-range="zoneResizeRange.right"
      :title="PANEL_BY_ID.filtersPanel.title"
      :width="rightPaletteWidth(RIGHT_PALETTE_WIDTHS.filters)"
      :top="rightColumnTop"
      :max-height="filtersMaxHeight"
    >
      <filters-panel :visible="filtersPanel" />
    </floating-palette>

    <floating-palette
      v-model="analysisPanel"
      v-bind="paletteChrome.analysisPanel"
      :resize-range="zoneResizeRange.right"
      :title="PANEL_BY_ID.analysisPanel.title"
      :width="rightPaletteWidth(RIGHT_PALETTE_WIDTHS.analysis)"
      :top="stackedHostTop"
      :max-height="stackedHostMaxHeight"
    >
      <!-- FloatingPalette keeps its content mounted and hides it with
           display:none, so the panel needs the open state explicitly: without
           it, its property-value fetch would run on every dataset open even for
           users who never open the palette. -->
      <analysis-panel :visible="analysisPanel" />
    </floating-palette>

    <floating-palette
      v-model="transcriptsPanel"
      v-bind="paletteChrome.transcriptsPanel"
      :resize-range="zoneResizeRange.right"
      :title="PANEL_BY_ID.transcriptsPanel.title"
      :width="rightPaletteWidth(RIGHT_PALETTE_WIDTHS.transcripts)"
      :top="rightColumnTop"
      :max-height="rightColumnMaxHeight"
    >
      <transcripts-panel :visible="transcriptsPanel" />
    </floating-palette>

    <template v-if="leftPalettesMounted">
      <floating-palette
        ref="navigatorPaletteRef"
        v-model="navigatorPanel"
        v-bind="paletteChrome.navigatorPanel"
        :resize-range="zoneResizeRange.left"
        :stack-position="leftStackPositions.navigatorPanel"
        :title="PANEL_BY_ID.navigatorPanel.title"
        :left="PALETTE_INSET"
        :width="leftPaletteWidth(LEFT_COLUMN_PALETTE_WIDTHS.navigator)"
        :top="leftStack.navigatorPanel.top"
        :max-height="leftStack.navigatorPanel.maxHeight"
      >
        <navigator-panel />
      </floating-palette>

      <!-- Sits immediately right of the Navigator rather than in the left
           stack, so turning the mode on doesn't push Layers and Tools down.
           Visibility IS the mode: closing the palette turns timelapse off, so
           only the chrome-less embed hides the panel while retaining mode. -->
      <floating-palette
        ref="timelapsePaletteRef"
        v-model="timelapsePaletteShown"
        title="Time Lapse"
        :left="rightOfLeftColumn(leftColumn)"
        :top="belowChipRows"
        :max-height="maxHeightBelow(belowChipRows)"
        :width="TIMELAPSE_PALETTE_WIDTH"
      >
        <timelapse-panel />
      </floating-palette>

      <floating-palette
        ref="layersPaletteRef"
        v-model="layersPanel"
        v-bind="paletteChrome.layersPanel"
        :resize-range="zoneResizeRange.left"
        :stack-position="leftStackPositions.layersPanel"
        :title="PANEL_BY_ID.layersPanel.title"
        :left="PALETTE_INSET"
        :width="leftPaletteWidth(LEFT_COLUMN_PALETTE_WIDTHS.layers)"
        :top="leftStack.layersPanel.top"
        :max-height="leftStack.layersPanel.maxHeight"
      >
        <layers-panel :visible="layersPanel" />
      </floating-palette>

      <floating-palette
        ref="toolsPaletteRef"
        v-model="toolsPanel"
        v-bind="paletteChrome.toolsPanel"
        :resize-range="zoneResizeRange.left"
        :stack-position="leftStackPositions.toolsPanel"
        :title="PANEL_BY_ID.toolsPanel.title"
        :left="PALETTE_INSET"
        :width="leftPaletteWidth(LEFT_COLUMN_PALETTE_WIDTHS.tools)"
        :top="leftStack.toolsPanel.top"
        :max-height="leftStack.toolsPanel.maxHeight"
      >
        <toolset />
      </floating-palette>
    </template>

    <analyze-dialog v-model="analyzeDialogOpen" @show-in-list="onShowInList" />
    <!-- The app's one genes dialog, opened by every "Add genes" button
         (utils/genesDialog.ts); mounted here so a job keeps polling after
         the dialog or tab that opened it closes. -->
    <materialize-genes-dialog
      v-model:open="genesDialogOpen"
      :show-activator="false"
    />
    <pipeline-dialog v-model="pipelineDialogOpen" />
    <color-by-property-dialog v-model:show="colorByPropertyDialogOpen" />
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
import TranscriptsPanel from "@/components/TranscriptsPanel.vue";
import transcriptsStore from "@/store/transcripts";
import AnalyzeDialog from "@/components/AnalyzeDialog.vue";
import MaterializeGenesDialog from "@/components/AnnotationBrowser/MaterializeGenesDialog.vue";
import { genesDialogOpen } from "@/utils/genesDialog";
import PipelineDialog from "@/components/PipelineDialog.vue";
import ColorByPropertyDialog from "@/components/AnnotationBrowser/ColorByPropertyDialog.vue";
import UndoRedoButtons from "@/components/UndoRedoButtons.vue";
import NavigatorPanel from "@/components/NavigatorPanel.vue";
import TimelapsePanel from "@/components/TimelapsePanel.vue";
import LayersPanel from "@/components/LayersPanel.vue";
import Toolset from "@/tools/toolsets/Toolset.vue";
import HelpPanel from "./components/HelpPanel.vue";
import CommandPalette from "./components/CommandPalette.vue";
import BreadCrumbs from "./layout/BreadCrumbs.vue";
import store from "@/store";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";
import volumeViewStore from "@/store/volumeView";
import montageStore from "@/store/montage";
import aiPanelStore from "@/store/aiPanel";
import timelapseStore from "@/store/timelapse";
import { logError } from "@/utils/log";
import { IHotkey } from "@/utils/v-mousetrap";
import {
  ACTION_PANEL_TOP,
  AI_PANEL_WIDTH,
  LEFT_COLUMN_PALETTE_WIDTHS,
  PALETTE_CHIP_HEIGHT,
  PALETTE_GAP,
  PALETTE_INSET,
  RIGHT_EDGE_OVERLAY_INSETS,
  RIGHT_PALETTE_WIDTHS,
  STACKED_ACTION_PANEL_OFFSET,
  TIMELAPSE_PALETTE_WIDTH,
  TPaletteZone,
  ZONE_MIN_WIDTH,
  actionPanelClearsTimelapsePalette,
  clampZoneWidth,
  leftColumnWidth,
  leftPaletteClearX,
  paletteWidth,
  rightEdgeClearX,
  rightOfLeftColumn,
} from "@/utils/paletteGeometry";
import AiPanel from "@/components/AiPanel.vue";
import FloatingPalette from "@/components/FloatingPalette.vue";
import { TOUR_REVEAL_PANEL_EVENT, tourBus } from "@/plugins/tourBus";
import { usePanelLayout } from "@/utils/usePanelLayout";
import { registerPanelLayoutController } from "@/utils/panelLayoutController";
import { setUiStateScope } from "@/utils/uiState";
import { IGirderFolder } from "@/girder";
import { ITourMetadata } from "./store/model";
import { useTour } from "@/utils/useTour";
import { TOUR_ANCHORS, TOUR_TRIGGERS } from "@/tours/anchors";
import {
  IPanelContext,
  PANELS,
  PANEL_BY_ID,
  PANEL_IDS,
  PanelId,
  isPanelAvailable as panelIsAvailable,
  isPanelId,
  isPanelRelevant,
  panelBadge,
} from "@/utils/panelRegistry";
import {
  layoutWithOpenSet,
  leftOrderAfterDrop,
  leftOrderAfterStep,
} from "@/utils/panelLayout";
import { useCommand, useCommandProvider } from "@/commands/registry";
import {
  layoutCommands,
  panelCommands,
  tourCommands,
} from "@/commands/providers";
import { aiPromptRequest } from "@/commands/requests";
import { isTourAvailableOnRoute, useViewerContext } from "@/commands/context";
import { boundHotkey, formatHotkey } from "@/commands/hotkeys";

// Suppress unused import warnings for template-only components
void UserMenu;
void ServerStatus;
void AnalyzeAnnotations;
void AnnotationsSettings;
void Snapshots;
void AnnotationBrowser;
void FiltersPanel;
void AnalysisPanel;
void TranscriptsPanel;
void AnalyzeDialog;
void PipelineDialog;
void ColorByPropertyDialog;
void UndoRedoButtons;
void NavigatorPanel;
void TimelapsePanel;
void LayersPanel;
void Toolset;
void HelpPanel;
void CommandPalette;
void BreadCrumbs;
void AiPanel;

const route = useRoute();
const router = useRouter();
const { startTour, loadAllTours: loadAllToursFromManager } = useTour();

const tourSearch = ref("");
const availableTours = ref<Record<string, ITourMetadata>>({});

const routeName = computed(() =>
  route.name === "shared" || route.name === "embed"
    ? "datasetview"
    : route.name,
);
const embedMode = computed(
  () => route.name === "embed" || route.query.embed === "1",
);

const isDatasetView = computed(() => routeName.value === "datasetview");

// --- Palette layout ---------------------------------------------------------
//
// Which palettes exist, which edge each lives on and how they evict each other
// are defined in `@/utils/panelRegistry`. Which are open or hidden,
// and remembering that between visits, is `usePanelLayout`. App.vue binds the
// template and the stacking observers to the refs it returns.

// Remembered UI state is kept per user. Sync and before `usePanelLayout`,
// which reads that state as it is created.
watch(
  () => store.girderUser?._id ?? null,
  (userId) => setUiStateScope(userId),
  { immediate: true, flush: "sync" },
);

// What the registry's per-panel `badge` and `available` rules are asked
// about. One place gathers it, so a chip, its command and its palette
// cannot disagree.
const panelContext = computed<IPanelContext>(() => ({
  activeFilterCount: filterStore.activeFilterCount,
  activeAnalysisGateCount: filterStore.activeAnalysisGateCount,
  transcriptsReachable:
    transcriptsStore.hasTranscripts ||
    !!transcriptsStore.error ||
    transcriptsStore.loading,
  hasUnseenJobResults: store.annotationPanelBadge,
}));

function isPanelAvailable(id: PanelId): boolean {
  return panelIsAvailable(id, panelContext.value);
}

// The panels that hold something new and are not on screen: their chip
// carries an accent (the registry's `relevant` rules).
const panelAccents = computed(
  () =>
    Object.fromEntries(
      PANEL_IDS.map((id) => [
        id,
        isPanelRelevant(id, panelContext.value) &&
          !panelLayout.isVisible(id) &&
          isPanelAvailable(id),
      ]),
    ) as Record<PanelId, boolean>,
);

const panelBadges = computed(
  () =>
    Object.fromEntries(
      PANEL_IDS.map((id) => [id, panelBadge(id, panelContext.value)]),
    ) as Record<PanelId, string | null>,
);

// The collection of the dataset view on screen, or null until it has loaded.
// Not simply `store.configuration`: that keeps the previous collection while
// the next one loads (and while the user is on another page), so reading it
// alone would restore and save the layout of a collection that is no longer
// the one being opened. The route names the view first, the store then loads
// the view, and the view names its collection.
const viewedConfiguration = computed(() => {
  const view = store.datasetView;
  const configuration = store.configuration;
  const routeViewId = route.params?.datasetViewId;
  if (
    !view ||
    !configuration ||
    view.configurationId !== configuration.id ||
    // Routes that carry no view id (a share link) have only the store's.
    (typeof routeViewId === "string" && routeViewId !== view.id)
  ) {
    return null;
  }
  return configuration;
});

const panelLayout = usePanelLayout({
  // The embed route (a share link in an iframe) shows only the canvas.
  inViewer: () => isDatasetView.value && !embedMode.value,
  configurationId: () => viewedConfiguration.value?.id ?? null,
  collectionDefault: () => viewedConfiguration.value?.defaultPanelLayout,
  isAvailable: isPanelAvailable,
});
// True while the palette is on screen; see `usePanelLayout`'s `visible`.
const {
  snapshotPanel,
  annotationPanel,
  settingsPanel,
  filtersPanel,
  analysisPanel,
  transcriptsPanel,
  navigatorPanel,
  toolsPanel,
  layersPanel,
} = panelLayout.visible;
const openPalette = panelLayout.open;
const togglePalette = panelLayout.toggle;

// "Unseen job results" ends when the Object Browser is shown, and does not
// follow the user to another dataset. (jobs.ts raises it.) The flag itself
// is watched too: raised while the browser is showing, it is not unseen.
// jobs.ts asks the store's mirror of the browser's visibility, and this does
// not rely on that mirror being right at that moment.
watch(
  [
    () => panelLayout.isVisible("annotationPanel"),
    () => store.dataset?.id,
    () => store.annotationPanelBadge,
  ],
  ([browserShown, datasetId, raised], [, previousDatasetId]) => {
    if (raised && (browserShown || datasetId !== previousDatasetId)) {
      store.setAnnotationPanelBadge(false);
    }
  },
);

// The AI agent's tools reach the layout through this (they run outside any
// component). Same functions as the buttons, so the same rules and saving.
const unregisterPanelLayoutController = registerPanelLayoutController({
  inViewer: () => isDatasetView.value && !embedMode.value,
  openPanels: () => [...panelLayout.layout.value.open],
  allHidden: () => panelLayout.chromeHidden.value,
  isAvailable: isPanelAvailable,
  open: panelLayout.open,
  close: panelLayout.close,
  applyOpenSet: panelLayout.applyOpenSet,
  // With whether everything was hidden: a turn made under "hide all panels"
  // that opened something ended it, and putting the layout back without
  // that would leave the panels showing.
  layoutSnapshot: () => ({
    layout: panelLayout.layout.value,
    allHidden: panelLayout.chromeHidden.value,
  }),
  restoreLayout: (snapshot) => {
    const saved = snapshot as { layout?: unknown; allHidden?: unknown } | null;
    panelLayout.applyLayout(saved?.layout);
    if (
      typeof saved?.allHidden === "boolean" &&
      saved.allHidden !== panelLayout.chromeHidden.value
    ) {
      panelLayout.toggleChromeHidden();
    }
  },
});
// "Hide all panels" is on. It covers every panel that floats over or beside
// the canvas, not only the registry's: the Timelapse palette, the AI panel
// and the Analyze drawer are masked by it too (below), each keeping its own
// open state for when the panels come back.
const panelsHidden = panelLayout.chromeHidden;

/** End "hide all panels", if it is on. */
function showPanels() {
  if (panelsHidden.value) {
    panelLayout.toggleChromeHidden();
  }
}

const snapshotPanelFull = ref(false);
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
// Opening any of the panels "hide all panels" masks ends it, as opening a
// registry palette does: something the user just asked for must not stay
// invisible. (These three are not in the panel registry; see `panelsHidden`.)
watch(
  [aiPanelOpen, timelapsePanel, analyzePanel],
  (open, wasOpen) => {
    if (open.some((isOpen, index) => isOpen && !wasOpen[index])) {
      showPanels();
    }
  },
  { flush: "sync" },
);

// What the palette's v-model and the geometry read: the mode, unless "hide all
// panels" is masking it. Closing the palette still turns the mode off.
const timelapsePaletteShown = computed({
  get: () => timelapsePanel.value && !panelsHidden.value,
  set: (value: boolean) => {
    timelapsePanel.value = value;
  },
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
    {
      open: annotationPanel.value,
      width: rightPaletteWidth(RIGHT_PALETTE_WIDTHS.objectBrowser),
    },
    {
      open: filtersPanel.value,
      width: rightPaletteWidth(RIGHT_PALETTE_WIDTHS.filters),
    },
    {
      open: analysisPanel.value,
      width: rightPaletteWidth(RIGHT_PALETTE_WIDTHS.analysis),
    },
    {
      open: transcriptsPanel.value,
      width: rightPaletteWidth(RIGHT_PALETTE_WIDTHS.transcripts),
    },
    {
      open: settingsPanel.value,
      width: rightPaletteWidth(RIGHT_PALETTE_WIDTHS.settings),
    },
    {
      open: snapshotPanel.value,
      width: rightPaletteWidth(RIGHT_PALETTE_WIDTHS.snapshots),
    },
    {
      open: aiPanelOpen.value && canUseAiPanel.value && !panelsHidden.value,
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
  if (!timelapsePaletteShown.value || !isDatasetView.value || embedMode.value) {
    return belowChipRows.value;
  }
  if (
    actionPanelClearsTimelapsePalette(
      windowWidth.value,
      rightEdgeClearance.value,
      rightOfLeftColumn(leftColumn.value) + TIMELAPSE_PALETTE_WIDTH,
    )
  ) {
    return belowChipRows.value;
  }
  return (
    belowChipRows.value +
    (timelapsePaletteHeight.value
      ? timelapsePaletteHeight.value + STACK_GAP
      : 0)
  );
});

const paletteGeometryVars = computed(() => ({
  "--nimbus-left-palette-clear-x": `${leftPaletteClearX(leftColumn.value)}px`,
  // The band at the top of the canvas that the rows of panel chips occupy
  // ends here. Surfaces that start at the top of the canvas (the selection
  // panels, the montage, the Timelapse palette) start below it, and the AI
  // panel stops short of it, so no chip is ever under one of them.
  "--nimbus-below-chip-rows": `${belowChipRows.value}px`,
  "--nimbus-right-edge-clear-x": `${rightEdgeClearance.value}px`,
  "--nimbus-action-panel-top": `${actionPanelTop.value}px`,
  // The connection panel stacks a fixed distance below the object panel, so it
  // has to follow whenever that one moves.
  "--nimbus-stacked-action-panel-top": `${
    actionPanelTop.value + STACKED_ACTION_PANEL_OFFSET
  }px`,
  // The image overview's default corner is the top right, under the right
  // chip row; it starts below the row as the right column's palettes do.
  "--nimbus-overview-top": `${rightColumnTop.value}px`,
}));

function toggleAiPanel() {
  if (!canUseAiPanel.value) {
    return;
  }
  // Under "hide all panels" an open AI panel is masked, so the button's job
  // is to show it, not to close what cannot be seen.
  if (aiPanelOpen.value && panelsHidden.value) {
    showPanels();
    return;
  }
  aiPanelOpen.value = !aiPanelOpen.value;
}

// Clear the AI-panel conversation whenever the authenticated user changes.
// Login is client-side (no page reload; the Logout button reloads, but a
// session can also end without it), so the module-level wire history would
// otherwise carry one user's prompts and results into the next user's
// session. See codebaseDocumentation/AI_PANEL_REVIEW.md finding #4.
watch(
  () => store.girderUser?._id ?? null,
  (userId) => aiPanelStore.handleAuthenticatedUserChange(userId),
  { immediate: true },
);

// "Ask Nimbus AI: …" from the command palette: open the panel; AiPanel.vue
// puts the text in its input and clears the request.
watch(aiPromptRequest, (prompt) => {
  if (prompt == null) {
    return;
  }
  if (canUseAiPanel.value) {
    aiPanelOpen.value = true;
    // The panel may already be open but masked; the watcher below only sees
    // it opening.
    showPanels();
  } else {
    // Drop it rather than leave it for the next time the panel mounts.
    aiPromptRequest.value = null;
  }
});

// Close the panel if the gate closes under it (e.g. the user logs out).
watch(canUseAiPanel, (usable) => {
  if (!usable) {
    aiPanelOpen.value = false;
  }
});

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

// Same arrangement as the Measure dialog above: mounted once here, opened from
// the app-bar palette button, the Object Browser toolbar and its More Actions
// menu. A second mount would give the app two independent dialogs (and two
// colormap-option fetches), so the open state lives in the store.
const colorByPropertyDialogOpen = computed({
  get: () => store.isColorByPropertyDialogOpen,
  set: (value: boolean) => store.setIsColorByPropertyDialogOpen(value),
});

const isUploadLoading = ref(false);
const helpPanelIsOpen = ref(false);
const commandPaletteOpen = ref(false);

const DOCUMENTATION_URL = "https://docs.nimbusimage.com";
const COMMAND_PALETTE_BINDING = "mod+k";
const HIDE_PANELS_BINDING = "mod+.";
const HIDE_PANELS_DESCRIPTION = "Hide or show all panels";
const commandPaletteHotkey = formatHotkey(COMMAND_PALETTE_BINDING);

// The Transcripts button and the viewer's overlay only appear for a dataset
// with a registered transcript store, so the registration is looked up as
// soon as the dataset is known rather than when the palette first opens.
watch(
  () => store.dataset?.id,
  (datasetId) => {
    if (datasetId) {
      transcriptsStore.ensureSchema();
    }
  },
  { immediate: true },
);

const is3DView = computed(() => volumeViewStore.viewMode === "3d");
function toggle3DView() {
  volumeViewStore.setViewMode(is3DView.value ? "2d" : "3d");
}

const isMontageOpen = computed(() => montageStore.isOpen);
function toggleMontage() {
  montageStore.setIsOpen(!montageStore.isOpen);
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
  setHeight: (height: number) => void,
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
    setHeight(el.offsetHeight);
  });
  observer.observe(el);
  return observer;
}

// Right zone: Filters stacks above whichever primary is hosting it. Both the
// Object Browser and the Analysis panel host it (see `PANELS`), and the two
// are mutually exclusive primaries, so at most one host is open at a time and
// one shared offset covers both. Keyed on the host set rather than the Object
// Browser alone: making Filters a companion of Analysis without this left the
// two palettes at the same top/right, with the wider Analysis panel drawn over
// Filters — so the Analysis panel's "narrow the filters" guidance was still
// unusable without closing it first.
const filtersPaletteRef = ref<PaletteRefEl>();
const filtersHeight = ref(0);
let filtersResizeObserver: ResizeObserver | null = null;

const filtersStacked = computed(
  () => filtersPanel.value && (annotationPanel.value || analysisPanel.value),
);

// Top edge of whichever primary Filters is currently stacked above.
const stackedHostTop = computed(() =>
  filtersStacked.value
    ? rightColumnTop.value + filtersHeight.value + STACK_GAP
    : rightColumnTop.value,
);

const stackedHostMaxHeight = computed(
  () => `calc(100vh - ${stackedHostTop.value + COLUMN_BOTTOM_INSET}px)`,
);

// When stacked, cap Filters so its host always keeps a minimum height.
const filtersMaxHeight = computed(() =>
  filtersStacked.value
    ? `calc(100vh - ${
        rightColumnTop.value +
        COLUMN_BOTTOM_INSET +
        MIN_BROWSER_HEIGHT +
        STACK_GAP
      }px)`
    : rightColumnMaxHeight.value,
);

// Left zone: Navigator, Layers and Tools stack in the user's order
// (`arrangement.leftOrder`), each flowing beneath the shown palettes above it.
const LEFT_PANEL_IDS = PANELS.filter((panel) => panel.zone === "left").map(
  (panel) => panel.id,
);
const navigatorPaletteRef = ref<PaletteRefEl>();
const layersPaletteRef = ref<PaletteRefEl>();
const toolsPaletteRef = ref<PaletteRefEl>();
const leftPaletteRefs: Partial<Record<PanelId, Ref<PaletteRefEl | undefined>>> =
  {
    navigatorPanel: navigatorPaletteRef,
    layersPanel: layersPaletteRef,
    toolsPanel: toolsPaletteRef,
  };
// Rendered height of each left palette, 0 until measured.
const leftPaletteHeights = ref<Partial<Record<PanelId, number>>>({});
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
let leftResizeObservers: ResizeObserver[] = [];
let timelapseResizeObserver: ResizeObserver | null = null;

// --- Panel chips -------------------------------------------------------------
//
// A panel's one control is a labeled chip, shown while the panel is closed,
// in a row at the top of its zone: next to where the panel opens, which the
// app-bar icons it replaced were not. The rows wrap, and the zone's palettes
// start below the row's measured height.
const PANEL_ZONES: readonly TPaletteZone[] = ["left", "right"];

// The chips the tours point at. A tour step that says "click here to open
// it" is already done when the panel is open and the chip is gone, so the
// palette carries the same name as `data-tour-done` (plugins/tour.ts).
const PANEL_TOUR_HOOKS: Partial<
  Record<PanelId, { anchor: string; trigger: string }>
> = {
  annotationPanel: {
    anchor: TOUR_ANCHORS.objectListButton,
    trigger: TOUR_TRIGGERS.objectListButton,
  },
  filtersPanel: {
    anchor: TOUR_ANCHORS.filtersButton,
    trigger: TOUR_TRIGGERS.filtersButton,
  },
  snapshotPanel: {
    anchor: TOUR_ANCHORS.snapshotsButton,
    trigger: TOUR_TRIGGERS.snapshotsButton,
  },
  settingsPanel: {
    anchor: TOUR_ANCHORS.settingsButton,
    trigger: TOUR_TRIGGERS.settingsButton,
  },
};

interface IPanelChip {
  id: PanelId;
  title: string;
  icon: string;
  // Replaces the chip's text for assistive tech, so it carries the badge's
  // meaning and the accent too, or they are there only for people who see.
  label: string;
  tooltip: string;
  badge: string | null;
  relevant: boolean;
  tourAnchor?: string;
  tourTrigger?: string;
}

function panelChip(id: PanelId): IPanelChip {
  const panel = PANEL_BY_ID[id];
  // Filters and Analysis say what their count means.
  const label =
    id === "filtersPanel"
      ? filtersAriaLabel.value
      : id === "analysisPanel"
        ? analysisAriaLabel.value
        : panel.title;
  return {
    id,
    title: panel.title,
    icon: panel.icon,
    label: panelAccents.value[id] ? `${label} (new results)` : label,
    tooltip:
      id === "filtersPanel"
        ? filtersTooltip.value
        : id === "analysisPanel"
          ? analysisTooltip.value
          : panel.description,
    badge: panelBadges.value[id],
    relevant: panelAccents.value[id],
    tourAnchor: PANEL_TOUR_HOOKS[id]?.anchor,
    tourTrigger: PANEL_TOUR_HOOKS[id]?.trigger,
  };
}

// Every available panel that is not on screen, left in the user's stack
// order and right in registry order. None outside the viewer, and none
// under "hide all panels", whose own chip stands for all of them.
const panelChips = computed<Record<TPaletteZone, IPanelChip[]>>(() => {
  if (!leftPalettesMounted.value || panelsHidden.value) {
    return { left: [], right: [] };
  }
  const closed = (id: PanelId) =>
    !panelLayout.isVisible(id) &&
    isPanelAvailable(id) &&
    (id !== "transcriptsPanel" || transcriptsChipOffered.value);
  return {
    left: panelLayout.arrangement.value.leftOrder.filter(closed).map(panelChip),
    right: PANELS.filter((panel) => panel.zone === "right")
      .map((panel) => panel.id)
      .filter(closed)
      .map(panelChip),
  };
});

// Whether the Transcripts chip is offered. Not during a dataset's first
// lookup: most datasets have no transcripts, and a chip that came and went
// on every dataset load would shift the others in its row. Once the lookup
// has answered with a store or an error it stays through a retry, so the
// panel can be reopened while one is running.
const transcriptsChipOffered = ref(false);
watch(
  [
    () => store.dataset?.id,
    () => transcriptsStore.hasTranscripts || !!transcriptsStore.error,
    () => transcriptsStore.loading,
  ],
  ([datasetId, answered, loading], [previousDatasetId]) => {
    if (answered) {
      transcriptsChipOffered.value = true;
    } else if (!loading || datasetId !== previousDatasetId) {
      transcriptsChipOffered.value = false;
    }
  },
  { immediate: true },
);

// Wide enough for the right zone's six chips with their badges on one line,
// so a count appearing (or the Transcripts chip) does not wrap the row and
// move the column.
const RIGHT_CHIP_ROW_MAX_WIDTH = 640;

const chipRowOccupied = computed<Record<TPaletteZone, boolean>>(() => ({
  left: panelChips.value.left.length > 0 || panelsHidden.value,
  right: panelChips.value.right.length > 0,
}));

// Rendered height of each row: how many lines it wraps to is not known ahead
// of time.
const chipRowHeights = ref<Record<TPaletteZone, number>>({ left: 0, right: 0 });
const chipRowObserver =
  typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver((entries) => {
        const heights = { ...chipRowHeights.value };
        for (const entry of entries) {
          const row = entry.target as HTMLElement;
          heights[row.dataset.zone as TPaletteZone] = row.offsetHeight;
        }
        chipRowHeights.value = heights;
      });
// A template ref function: called with each row's element (observing one
// twice is a no-op) and with null when it goes away.
function observeChipRow(row: unknown) {
  if (row instanceof HTMLElement) {
    chipRowObserver?.observe(row);
  }
}

// The height kept for a zone's row. A row with no chips keeps one line's
// worth, so opening or closing a panel never moves the others and the two
// columns start at the same height; so does a row not yet measured (or one
// nothing can measure).
function chipRowHeight(zone: TPaletteZone): number {
  return (
    (chipRowOccupied.value[zone] && chipRowHeights.value[zone]) ||
    PALETTE_CHIP_HEIGHT
  );
}

// Wrapped, not run across the canvas: the left row as wide as the column it
// sits over, the right as wide as the space beside the left column allows,
// up to a width that holds all its chips on one line.
const chipRowStyles = computed(() => ({
  left: {
    top: `${PALETTE_TOP}px`,
    left: `${PALETTE_INSET}px`,
    maxWidth: `${leftColumn.value}px`,
  },
  right: {
    top: `${PALETTE_TOP}px`,
    right: `${PALETTE_INSET}px`,
    maxWidth: `${Math.max(
      ZONE_MIN_WIDTH.right,
      Math.min(
        RIGHT_CHIP_ROW_MAX_WIDTH,
        windowWidth.value - rightOfLeftColumn(leftColumn.value) - PALETTE_INSET,
      ),
    )}px`,
  },
}));

// Where a zone's palettes start: below its row of chips, whether or not the
// row has any just now.
function columnTop(zone: TPaletteZone): number {
  return PALETTE_TOP + chipRowHeight(zone) + STACK_GAP;
}

// Where the band the chip rows occupy ends: below whichever row is taller.
// Everything that starts at the top of the canvas between or under the rows
// (the Timelapse palette, the selection panels, the montage) starts here,
// because on a narrow window either row can reach over it.
const belowChipRows = computed(() =>
  Math.max(columnTop("left"), columnTop("right")),
);

function maxHeightBelow(top: number): string {
  return `calc(100vh - ${top + COLUMN_BOTTOM_INSET}px)`;
}

const rightColumnTop = computed(() => columnTop("right"));
const rightColumnMaxHeight = computed(() =>
  maxHeightBelow(rightColumnTop.value),
);

// Where each left palette sits: below the chip row and the shown palettes
// that come before it in the user's order.
const leftStack = computed(() => {
  const stack = {} as Record<PanelId, { top: number; maxHeight: string }>;
  let top = columnTop("left");
  for (const id of panelLayout.arrangement.value.leftOrder) {
    stack[id] = { top, maxHeight: maxHeightBelow(top) };
    const height = leftPaletteHeights.value[id];
    if (panelLayout.isVisible(id) && height) {
      top += height + STACK_GAP;
    }
  }
  return stack;
});

// Dropping a dragged left palette: it takes the place its center was carried
// to among the palettes that are showing.
function onLeftPaletteDrop(draggedId: PanelId, offsetY: number) {
  const center = (id: PanelId) =>
    leftStack.value[id].top + (leftPaletteHeights.value[id] ?? 0) / 2;
  panelLayout.setLeftOrder(
    leftOrderAfterDrop(
      panelLayout.arrangement.value.leftOrder,
      draggedId,
      center(draggedId) + offsetY,
      LEFT_PANEL_IDS.filter((id) => panelLayout.isVisible(id)).map((id) => ({
        id,
        center: center(id),
      })),
    ),
  );
}

// --- Zone widths -------------------------------------------------------------
//
// Dragging a zone's inner edge resizes every palette in it. The width in the
// arrangement is the remembered one; `draggedZoneWidths` is the drag in
// progress, shown but not stored until the drop, so cancelling leaves no
// trace. Both are clamped to the viewport where they are used.
const draggedZoneWidths = ref<Partial<Record<TPaletteZone, number>>>({});

function zoneWidth(zone: TPaletteZone): number | undefined {
  return (
    draggedZoneWidths.value[zone] ?? panelLayout.arrangement.value.widths[zone]
  );
}

function leftPaletteWidth(defaultWidth: number): number {
  return paletteWidth(
    "left",
    defaultWidth,
    zoneWidth("left"),
    windowWidth.value,
  );
}

function rightPaletteWidth(defaultWidth: number): number {
  return paletteWidth(
    "right",
    defaultWidth,
    zoneWidth("right"),
    windowWidth.value,
  );
}

const leftColumn = computed(() =>
  leftColumnWidth(zoneWidth("left"), windowWidth.value),
);

// Each registry palette's default width, for the width of an unresized zone.
const PALETTE_DEFAULT_WIDTHS: Record<PanelId, number> = {
  navigatorPanel: LEFT_COLUMN_PALETTE_WIDTHS.navigator,
  layersPanel: LEFT_COLUMN_PALETTE_WIDTHS.layers,
  toolsPanel: LEFT_COLUMN_PALETTE_WIDTHS.tools,
  annotationPanel: RIGHT_PALETTE_WIDTHS.objectBrowser,
  filtersPanel: RIGHT_PALETTE_WIDTHS.filters,
  analysisPanel: RIGHT_PALETTE_WIDTHS.analysis,
  transcriptsPanel: RIGHT_PALETTE_WIDTHS.transcripts,
  snapshotPanel: RIGHT_PALETTE_WIDTHS.snapshots,
  settingsPanel: RIGHT_PALETTE_WIDTHS.settings,
};

// What a resize of each zone starts from and may reach. The start is the
// zone's width: its remembered one, or while it is unresized the widest
// palette showing in it, so the first step toward "wider" never makes a
// wider palette narrower.
const zoneResizeRange = computed(() => {
  const range = (zone: TPaletteZone) => {
    const min = ZONE_MIN_WIDTH[zone];
    const max = clampZoneWidth(zone, Infinity, windowWidth.value);
    const stored = panelLayout.arrangement.value.widths[zone];
    const showing = PANELS.filter(
      (panel) => panel.zone === zone && panelLayout.isVisible(panel.id),
    ).map((panel) => PALETTE_DEFAULT_WIDTHS[panel.id]);
    return {
      base:
        stored === undefined
          ? Math.max(min, ...showing)
          : clampZoneWidth(zone, stored, windowWidth.value),
      min,
      max,
    };
  };
  return { left: range("left"), right: range("right") };
});

// Each left palette's place among those showing, for its grip.
const leftStackPositions = computed(() => {
  const showing = panelLayout.arrangement.value.leftOrder.filter((id) =>
    panelLayout.isVisible(id),
  );
  return Object.fromEntries(
    LEFT_PANEL_IDS.map((id) => [
      id,
      { position: showing.indexOf(id) + 1, count: showing.length },
    ]),
  ) as Record<PanelId, { position: number; count: number }>;
});

function endZoneDrag(zone: TPaletteZone) {
  const widths = { ...draggedZoneWidths.value };
  delete widths[zone];
  draggedZoneWidths.value = widths;
}

// The props and listeners every registry palette takes for
// resizing its zone and (on the left) reordering. Built once: an object made
// in the template would be new on every render and re-render each palette.
function paletteChromeFor(id: PanelId) {
  const zone = PANEL_BY_ID[id].zone;
  // The edge facing the canvas.
  const resizeEdge: "left" | "right" = zone === "left" ? "right" : "left";
  return {
    panelId: id,
    tourDoneAnchor: PANEL_TOUR_HOOKS[id]?.anchor,
    resizeEdge,
    reorderable: zone === "left",
    onResize: (width: number) => {
      draggedZoneWidths.value = {
        ...draggedZoneWidths.value,
        [zone]: clampZoneWidth(zone, width, windowWidth.value),
      };
    },
    onResizeEnd: (width: number) => {
      panelLayout.setZoneWidth(
        zone,
        clampZoneWidth(zone, width, windowWidth.value),
      );
      endZoneDrag(zone);
    },
    onResizeCancel: () => endZoneDrag(zone),
    onResizeReset: () => panelLayout.setZoneWidth(zone, null),
    onReorderEnd: (offsetY: number) => onLeftPaletteDrop(id, offsetY),
    onReorderStep: (direction: -1 | 1) =>
      panelLayout.setLeftOrder(
        leftOrderAfterStep(
          panelLayout.arrangement.value.leftOrder,
          id,
          direction,
          LEFT_PANEL_IDS.filter((other) => panelLayout.isVisible(other)),
        ),
      ),
  };
}
const paletteChrome = {} as Record<
  PanelId,
  ReturnType<typeof paletteChromeFor>
>;
for (const id of PANEL_IDS) {
  paletteChrome[id] = paletteChromeFor(id);
}

// The left palettes live inside a v-if, so attach their observers once they
// mount (and tear down when leaving the dataset view).
const leftPalettesMounted = computed(
  () =>
    !!store.dataset && routeName.value === "datasetview" && !embedMode.value,
);

function setLeftPaletteHeight(id: PanelId, height: number) {
  leftPaletteHeights.value = { ...leftPaletteHeights.value, [id]: height };
}

function disconnectLeftPaletteObservers() {
  for (const observer of leftResizeObservers) {
    observer.disconnect();
  }
  leftResizeObservers = [];
  timelapseResizeObserver?.disconnect();
  timelapseResizeObserver = null;
}

function setupLeftPaletteObservers() {
  disconnectLeftPaletteObservers();
  for (const id of LEFT_PANEL_IDS) {
    const observer = observePaletteHeight(leftPaletteRefs[id]!, (height) =>
      setLeftPaletteHeight(id, height),
    );
    if (observer) {
      leftResizeObservers.push(observer);
    }
  }
  timelapseResizeObserver = observePaletteHeight(
    timelapsePaletteRef,
    (height) => {
      timelapsePaletteHeight.value = height;
    },
  );
}

function teardownLeftPaletteObservers() {
  disconnectLeftPaletteObservers();
  timelapsePaletteHeight.value = 0;
  leftPaletteHeights.value = {};
}

function toggleHelpDialogUsingHotkey() {
  helpPanelIsOpen.value = !helpPanelIsOpen.value;
}

const appHotkeys: IHotkey[] = [
  {
    bind: "tab",
    handler: toggleHelpDialogUsingHotkey,
    data: {
      section: "Global",
      description: "Toggle help dialog",
    },
  },
  {
    bind: COMMAND_PALETTE_BINDING,
    // Works from inside any text field too: Ctrl+K is the browser's own
    // search-bar shortcut on Windows/Linux, so it must be claimed everywhere.
    // (The palette's own field handles the key itself and stops it.)
    allowInInputs: true,
    // v-mousetrap calls handlers as (element, event).
    handler: (_el: HTMLElement, event?: KeyboardEvent) => {
      event?.preventDefault();
      commandPaletteOpen.value = !commandPaletteOpen.value;
    },
    data: {
      section: "Global",
      description: "Command palette: search every command",
    },
  },
  {
    bind: HIDE_PANELS_BINDING,
    handler: (_el: HTMLElement, event?: KeyboardEvent) => {
      event?.preventDefault();
      panelLayout.toggleChromeHidden();
    },
    data: {
      section: "Global",
      description: HIDE_PANELS_DESCRIPTION,
    },
  },
];

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

const activeFilterCount = computed(() => filterStore.activeFilterCount);

const filtersTooltip = computed(() => {
  const base = PANEL_BY_ID.filtersPanel.description;
  const count = activeFilterCount.value;
  if (count === 0) {
    return base;
  }
  return `${base} (${count} active filter${count === 1 ? "" : "s"})`;
});

// The chip's accessible label starts with its visible title, like the other
// chips', and leaves the descriptive sentence to the tooltip. It carries the
// count because aria-label overrides the chip's content, which would
// otherwise hide the badge from assistive tech.
const filtersAriaLabel = computed(() =>
  activeFilterCount.value === 0
    ? "Filters"
    : `Filters (${activeFilterCount.value} active)`,
);

// Gates are counted separately from activeFilterCount: each badge counts what
// its own panel shows, so the Filters chip never claims a filter its panel
// cannot display (and vice versa).
const activeAnalysisGateCount = computed(
  () => filterStore.activeAnalysisGateCount,
);

const analysisTooltip = computed(() => {
  const base = PANEL_BY_ID.analysisPanel.description;
  const count = activeAnalysisGateCount.value;
  if (count === 0) {
    return base;
  }
  return `${base} (${count} gate${count === 1 ? "" : "s"} active)`;
});

// As for Filters: the visible title, then what the count means.
const analysisAriaLabel = computed(() =>
  activeAnalysisGateCount.value === 0
    ? "Analysis"
    : `Analysis (${activeAnalysisGateCount.value} gate${
        activeAnalysisGateCount.value === 1 ? "" : "s"
      } active)`,
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

      return matchesSearch && isTourAvailableOnRoute(tour, routeName.value);
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
  // A tour points at panels and their chips; under "hide all panels" there
  // is neither to point at.
  showPanels();
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

// --- Command palette --------------------------------------------------------
//
// App.vue owns the palette refs and the app-bar actions, so it registers their
// commands. Every app-bar control carries a `data-command-id` naming its
// command; App.commands.test.ts fails if one names nothing registered.
const viewerContext = useViewerContext(() => routeName.value);
const { inViewer } = viewerContext;

useCommandProvider(
  panelCommands(viewerContext, {
    isOpen: panelLayout.isVisible,
    toggle: togglePalette,
    isAvailable: isPanelAvailable,
  }),
);

useCommandProvider(
  layoutCommands(viewerContext, {
    applyOpenSet: panelLayout.applyOpenSet,
    reset: panelLayout.reset,
    resetArrangement: panelLayout.resetArrangement,
    hasCollectionDefault: () => !!viewedConfiguration.value?.defaultPanelLayout,
    // The store action writes to `store.configuration`, so only once that is
    // the collection on screen.
    canSaveCollectionDefault: () =>
      store.isLoggedIn && !!viewedConfiguration.value,
    // Only which panels are open: widths and order are each person's own.
    // Read from the layout, not from what is on screen, so "hide all panels"
    // does not save an empty default.
    saveCollectionDefault: () =>
      store.saveDefaultPanelLayout(
        layoutWithOpenSet(panelLayout.layout.value.open),
      ),
    clearCollectionDefault: () => store.saveDefaultPanelLayout(null),
  }),
);

useCommandProvider(
  tourCommands(
    () => availableTours.value,
    (tour) => isTourAvailableOnRoute(tour, routeName.value),
    handleTourStart,
  ),
);

useCommand(() => [
  {
    id: "nav.home",
    title: "Go to home",
    group: "Actions",
    keywords: ["datasets", "start"],
    icon: "mdi-home",
    run: goHome,
  },
  {
    id: "view.toggle3d",
    title: is3DView.value ? "Switch to 2D view" : "Switch to 3D view",
    group: "Actions",
    // Only the mode it switches to: "3d" must not find "Switch to 2D view".
    keywords: is3DView.value ? ["2d", "flat"] : ["volume", "3d", "render"],
    icon: "mdi-cube-scan",
    enabled: inViewer,
    run: toggle3DView,
  },
  {
    id: "view.toggleMontage",
    title: isMontageOpen.value ? "Close montage view" : "Open montage view",
    group: "Actions",
    keywords: ["grid", "gallery", "crops", "objects", "thumbnails"],
    icon: "mdi-view-grid-outline",
    enabled: () => inViewer() && !is3DView.value,
    run: toggleMontage,
  },
  {
    id: "data.upload",
    title: "Upload a new dataset…",
    group: "Actions",
    keywords: ["import", "new", "dataset", "file"],
    icon: "mdi-upload",
    enabled: () => store.isLoggedIn && !!store.girderUser,
    run: goToNewDataset,
  },
  {
    id: "analysis.measure",
    title: "Measure objects…",
    group: "Actions",
    description: "Configure and run property computations",
    keywords: ["compute", "property", "area", "intensity"],
    aliases: ["measure", "measurements", "compute properties"],
    icon: "mdi-ruler-square",
    enabled: inViewer,
    run: () => {
      analyzeDialogOpen.value = true;
    },
  },
  {
    id: "properties.colorBy",
    title: "Color objects by property…",
    group: "Actions",
    keywords: ["colormap", "colour", "heatmap"],
    icon: "mdi-palette",
    enabled: inViewer,
    run: () => {
      colorByPropertyDialogOpen.value = true;
    },
  },
  {
    id: "help.hud",
    title: "Show heads-up display",
    group: "Help",
    description: "Hotkeys and feature overview",
    keywords: ["hotkeys", "shortcuts", "keyboard"],
    icon: "mdi-view-dashboard-outline",
    hotkey: boundHotkey("tab", "Toggle help dialog"),
    run: () => {
      helpPanelIsOpen.value = true;
    },
  },
  {
    id: "help.docs",
    title: "Open documentation",
    group: "Help",
    keywords: ["docs", "manual", "help"],
    icon: "mdi-book-open-variant",
    run: () => {
      window.open(DOCUMENTATION_URL, "_blank", "noopener");
    },
  },
  {
    id: "panel.toggleAll",
    title: panelLayout.chromeHidden.value
      ? "Show all panels"
      : "Hide all panels",
    group: "Panels",
    // The verb of what running it will do, as for a single panel.
    keywords: [
      "palettes",
      "chrome",
      "canvas",
      "full image",
      panelLayout.chromeHidden.value ? "show" : "hide",
    ],
    icon: panelLayout.chromeHidden.value
      ? "mdi-eye-outline"
      : "mdi-eye-off-outline",
    hotkey: boundHotkey(HIDE_PANELS_BINDING, HIDE_PANELS_DESCRIPTION),
    enabled: inViewer,
    run: panelLayout.toggleChromeHidden,
  },
  {
    id: "ai.togglePanel",
    title: aiPanelOpen.value ? "Close Nimbus AI panel" : "Open Nimbus AI panel",
    group: "Actions",
    keywords: ["assistant", "claude", "chat", "agent"],
    icon: "mdi-robot-outline",
    enabled: () => canUseAiPanel.value,
    run: toggleAiPanel,
  },
]);

function annotationPanelChanged() {
  store.setIsAnnotationPanelOpen(annotationPanel.value);
}

// Immediate: a layout restored with the browser open is already open when
// this watcher is created, and the store would otherwise keep saying closed
// until the first toggle.
watch(annotationPanel, () => annotationPanelChanged(), { immediate: true });

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
      // Refused (embed mode): put the store back, or it stays "open" over a
      // closed palette and the next request is no change, so never opens it
      if (!annotationPanel.value) {
        annotationPanelChanged();
      }
    } else {
      annotationPanel.value = false;
    }
  },
);

// Same escape hatch, generalized: a component with no access to the palette
// registry (the render-coverage HUD, deep inside ImageViewer) asks for a
// palette by id and this opens it. Cleared immediately so the next request for
// the same palette is still seen as a change.
watch(
  () => store.paletteOpenRequests,
  (requests) => {
    if (requests.length === 0) {
      return;
    }
    for (const id of requests) {
      openPalette(id);
    }
    store.setPaletteOpenRequests([]);
  },
);

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
    for (const id of LEFT_PANEL_IDS) {
      const el = leftPaletteRefs[id]?.value?.rootEl;
      if (el) {
        setLeftPaletteHeight(id, el.offsetHeight);
      }
    }
  },
);

// A tour step anchored inside a palette that is closed or hidden
// asks for it (plugins/tour.ts). Before layouts were remembered every visit
// opened the left stack, so tours could assume their anchors were showing.
function revealPanelForTour(panelId: unknown) {
  if (isPanelId(panelId)) {
    openPalette(panelId);
  } else if (panelsHidden.value) {
    // Not one of the registry's palettes: all that can be hiding it from
    // here is "hide all panels".
    panelLayout.toggleChromeHidden();
  }
}

onMounted(() => {
  tourBus.on(TOUR_REVEAL_PANEL_EVENT, revealPanelForTour);
  fetchConfig();
  loadAllTours();
  window.addEventListener("resize", updateWindowWidth);
  updateWindowWidth();

  // The Filters palette is always mounted, so observe it directly.
  filtersResizeObserver = observePaletteHeight(filtersPaletteRef, (height) => {
    filtersHeight.value = height;
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", updateWindowWidth);
  tourBus.off(TOUR_REVEAL_PANEL_EVENT, revealPanelForTour);
  unregisterPanelLayoutController();
  chipRowObserver?.disconnect();
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
  commandPaletteOpen,
  appHotkeys,
  routeName,
  activeFilterCount,
  activeAnalysisGateCount,
  analysisTooltip,
  analysisAriaLabel,
  filtersTooltip,
  filtersAriaLabel,
  hasUncomputedProperties,
  filteredToursByCategory,
  filtersStacked,
  stackedHostTop,
  fetchConfig,
  loadAllTours,
  goHome,
  togglePalette,
  openPalette,
  panelChips,
  belowChipRows,
  rightEdgeClearance,
  timelapsePaletteShown,
  leftStack,
  rightColumnTop,
  leftColumn,
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

/* Base tone of the palette cluster, deliberately theme-independent. */
$palette-cluster-tone: #0f1217;

/* Cluster of view-toggle icon buttons (3D, montage) in the app bar.
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

/* Compact pill that opens the command palette: the magnifier and the hotkey
   hint. Below `lg` only the icon shows (a 36px circle), since the viewer's
   app bar is already full at those widths. */
.palette-search.v-btn {
  min-width: 0;
  padding: 0 6px 0 8px;
  border-radius: 100px;
  text-transform: none;
  letter-spacing: normal;
  font-weight: 400;
  color: rgba(var(--v-theme-on-surface), 0.6);
  background: rgba(var(--v-theme-on-surface), 0.06);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);

  &:hover {
    background: rgba(var(--v-theme-on-surface), 0.1);
    color: rgba(var(--v-theme-on-surface), 0.8);
  }
}

.palette-search.v-btn :deep(.v-btn__content) {
  gap: 6px;
}

.palette-search-kbd {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.2);
  background: rgba(var(--v-theme-on-surface), 0.05);
  color: rgba(var(--v-theme-on-surface), 0.7);
  font-family: inherit;
  font-size: 0.7rem;
  line-height: 1.4;
}

@media (max-width: 1279px) {
  .palette-search.v-btn {
    width: 36px;
    height: 36px;
    padding: 0;
    border-color: transparent;
    background: transparent;
  }

  .palette-search-kbd {
    display: none;
  }
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

// Closed panels: a row of chips at the top of a zone, where the zone's first
// palette would be. The row wraps within its max-width (set inline).
.palette-chips {
  position: fixed;
  z-index: 1006; // with the palettes, above the app bar
  display: flex;
  flex-wrap: wrap;
  gap: 6px;

  // Right-aligned lines, still read left to right in registry order.
  &.zone-right {
    justify-content: flex-end;
  }
}

.palette-chip {
  height: 28px; // PALETTE_CHIP_HEIGHT in paletteGeometry.ts
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.08));
  border-radius: 14px;
  background: var(--nimbus-glass-bg);
  backdrop-filter: var(--nimbus-glass-filter);
  -webkit-backdrop-filter: var(--nimbus-glass-filter);
  color: var(--nimbus-text-secondary, #d0d6e0);
  font-family: var(--nimbus-font);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;

  &:hover {
    background: rgba(var(--v-theme-primary), 0.18);
    color: rgb(var(--v-theme-primary));
  }
}

// The accent for a panel that holds something new: a dot, not motion, so it
// can sit there until the user looks without pulling at the eye.
.palette-chip.relevant::before {
  content: "";
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgb(var(--v-theme-warning));
  box-shadow: 0 0 0 2px rgba(var(--v-theme-warning), 0.25);
}

// What a closed panel is doing (Filters and Analysis: how many filters or
// gates narrow the object set), so it stays visible with the panel closed.
.palette-chip-badge {
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 8px;
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
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
