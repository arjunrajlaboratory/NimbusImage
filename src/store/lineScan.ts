import {
  getModule,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import store from "./root";
import { IGeoJSPosition } from "./model";

let lastViewerId = 0;

// Identifies one AnnotationViewer instance to this module. Unroll mode mounts
// one viewer per layer group and they all share this state, so a viewer that
// goes away must only clear what it owns.
export function newLineScanViewerId(): number {
  return ++lastViewerId;
}

/**
 * State shared between the linescan tool (AnnotationViewer) and the
 * LineScanPanel that displays the intensity profile.
 *
 * The tool writes the current line (in image pixel coordinates) as the user
 * draws it; the panel samples pixel intensities along that line and renders
 * the graph. Clearing the points dismisses the panel and resets the tool.
 */
@Module({ dynamic: true, store, name: "lineScan" })
export class LineScan extends VuexModule {
  // Vertices of the scanned line in image pixel coordinates, or null when no
  // scan is active (panel hidden)
  points: IGeoJSPosition[] | null = null;

  // False while the line is still being drawn (live preview updates)
  isComplete: boolean = false;

  // Layer id picked in the tool configuration, or null for no preselection
  toolLayerId: string | null = null;

  // Line type of the currently selected linescan tool, or null when no
  // linescan tool is selected. The panel stays visible while a tool is
  // selected so it can display drawing instructions.
  toolLineType: "freehand" | "segment" | null = null;

  // True after the first click of a segment scan, until the second click
  segmentStartPlaced: boolean = false;

  // Viewer that published the current line (see newLineScanViewerId), or null
  // when there is no line
  ownerViewerId: number | null = null;

  // Mounted viewers sharing this state
  viewerCount: number = 0;

  get isActive() {
    return this.points !== null;
  }

  @Mutation
  setLine({
    points,
    isComplete,
    ownerViewerId = null,
  }: {
    points: IGeoJSPosition[];
    isComplete: boolean;
    ownerViewerId?: number | null;
  }) {
    this.points = points;
    this.isComplete = isComplete;
    this.ownerViewerId = ownerViewerId;
  }

  @Mutation
  clearLine() {
    this.points = null;
    this.isComplete = false;
    this.ownerViewerId = null;
  }

  @Mutation
  viewerMounted() {
    this.viewerCount++;
  }

  // A viewer going away clears the line only if it drew it (its displayed
  // line and segment start go with it), and the tool state only if it was
  // the last viewer: the others still show the selected tool.
  @Mutation
  viewerUnmounted(viewerId: number) {
    this.viewerCount = Math.max(0, this.viewerCount - 1);
    const isLast = this.viewerCount === 0;
    if (isLast || this.ownerViewerId === viewerId) {
      this.points = null;
      this.isComplete = false;
      this.ownerViewerId = null;
      this.segmentStartPlaced = false;
    }
    if (isLast) {
      this.toolLineType = null;
    }
  }

  @Mutation
  setToolLayerId(layerId: string | null) {
    this.toolLayerId = layerId;
  }

  @Mutation
  setToolLineType(lineType: "freehand" | "segment" | null) {
    this.toolLineType = lineType;
  }

  @Mutation
  setSegmentStartPlaced(segmentStartPlaced: boolean) {
    this.segmentStartPlaced = segmentStartPlaced;
  }
}

export default getModule(LineScan);
