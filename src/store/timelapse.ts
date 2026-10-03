import {
  getModule,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import store from "./root";

import { TTimelapseTrackColoring } from "./model";

/**
 * View state for timelapse mode: whether it is on, and everything it configures.
 *
 * Extracted from `src/store/index.ts`, where these six fields had accumulated
 * against the guideline that a distinct feature area gets its own module. Purely
 * client-side and per-session — none of it is synced to the configuration or the
 * dataset view, which is why the extraction is mechanical: there are no
 * persistence paths to re-point.
 *
 * Holds no track data. Tracks are derived from `annotationConnections` by
 * `connectionList.trackAnalysis` and are not lifecycle-managed state; putting a
 * cache of them here would give two owners for one derivation.
 */
@Module({ dynamic: true, store, name: "timelapse" })
export class Timelapse extends VuexModule {
  showMode: boolean = false;
  modeWindow: number = 10;
  tags: string[] = [];
  showLabels: boolean = true;
  trackColoring: TTimelapseTrackColoring = "track";
  // Rotates every track hue. Bumped by "Shuffle colors" when two neighbouring
  // tracks happen to land on similar hues.
  colorSeed: number = 0;

  @Mutation
  public setShowMode(value: boolean) {
    this.showMode = value;
  }

  @Mutation
  public setModeWindow(value: number) {
    this.modeWindow = value;
  }

  @Mutation
  public setTags(value: string[]) {
    this.tags = value;
  }

  @Mutation
  public setShowLabels(value: boolean) {
    this.showLabels = value;
  }

  @Mutation
  public setTrackColoring(value: TTimelapseTrackColoring) {
    this.trackColoring = value;
  }

  @Mutation
  public setColorSeed(value: number) {
    this.colorSeed = value;
  }

  /**
   * Re-roll the track hue assignment. Steps rather than randomises so a second
   * shuffle can't land back on the palette the user just rejected.
   */
  @Mutation
  public shuffleColors() {
    this.colorSeed += 1;
  }
}

export default getModule(Timelapse);

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}
