import {
  getModule,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import store from "./root";

import {
  TVolumeAxis,
  TVolumeBlendMode,
  TVolumeSegmentationColorMode,
  TVolumeViewMode,
} from "./model";

// User-facing view state for the 3D volume viewer. Kept out of the main store
// module (which is already large) since this is a distinct feature area.
@Module({ dynamic: true, store, name: "volumeView" })
export class VolumeView extends VuexModule {
  viewMode: TVolumeViewMode = "2d";
  axis: TVolumeAxis = "z";
  blendMode: TVolumeBlendMode = "composite";
  showVolume: boolean = true;
  showSegmentations: boolean = false;
  segmentationColorMode: TVolumeSegmentationColorMode = "tag";
  segmentationPropertyPath: string[] = [];
  // Depth spacing (µm) to use when time is the depth axis. null → auto default
  // (5× the xy pixel size), computed at build time.
  timeStepUmOverride: number | null = null;

  @Mutation
  setViewMode(value: TVolumeViewMode) {
    this.viewMode = value;
  }

  @Mutation
  setAxis(value: TVolumeAxis) {
    this.axis = value;
  }

  @Mutation
  setBlendMode(value: TVolumeBlendMode) {
    this.blendMode = value;
  }

  @Mutation
  setShowVolume(value: boolean) {
    this.showVolume = value;
  }

  @Mutation
  setShowSegmentations(value: boolean) {
    this.showSegmentations = value;
  }

  @Mutation
  setSegmentationColorMode(value: TVolumeSegmentationColorMode) {
    this.segmentationColorMode = value;
  }

  @Mutation
  setSegmentationPropertyPath(value: string[]) {
    this.segmentationPropertyPath = [...value];
  }

  @Mutation
  setTimeStepUmOverride(value: number | null) {
    this.timeStepUmOverride = value;
  }
}

export default getModule(VolumeView);

// Self-accept HMR to prevent vuex-module-decorators from re-registering the
// dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}
