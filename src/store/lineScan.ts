import {
  getModule,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import store from "./root";
import { IGeoJSPosition } from "./model";

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

  get isActive() {
    return this.points !== null;
  }

  @Mutation
  setLine({
    points,
    isComplete,
  }: {
    points: IGeoJSPosition[];
    isComplete: boolean;
  }) {
    this.points = points;
    this.isComplete = isComplete;
  }

  @Mutation
  clearLine() {
    this.points = null;
    this.isComplete = false;
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
