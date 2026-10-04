import {
  Action,
  getModule,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import store from "./root";
import Persister from "./Persister";

// One object on the Object Browser's current page, in list order. `index` is
// what the list's Index column shows for it.
export interface IMontageListItem {
  id: string;
  index: number;
}

export type TMontageScaleMode = "uniform" | "fit";

export interface IMontageSettings {
  // Rendered panel edge length, in screen (CSS) pixels.
  panelSize: number;
  // Image pixels added around each object's bounding box. Point objects have
  // an empty bounding box, so for them this alone sets the window size.
  padding: number;
  // "uniform": every panel shows the same image-pixel window (sized to fit the
  // largest object on the page), so object sizes compare directly.
  // "fit": each panel is zoomed to its own object.
  scaleMode: TMontageScaleMode;
  showOutlines: boolean;
  showIndex: boolean;
  // Property paths whose values are printed under each panel.
  labelPropertyPaths: string[][];
}

const SETTINGS_KEY = "montageSettings";

export const DEFAULT_MONTAGE_SETTINGS: IMontageSettings = {
  panelSize: 160,
  padding: 32,
  scaleMode: "uniform",
  showOutlines: true,
  showIndex: true,
  labelPropertyPaths: [],
};

function loadSettings(): IMontageSettings {
  return {
    ...DEFAULT_MONTAGE_SETTINGS,
    ...Persister.get(SETTINGS_KEY, {}),
  };
}

// The montage view: a grid of crops, one per object on the Object Browser's
// current page. The list owns filtering, sorting and paging; it publishes the
// page it shows here (listPageItems) so the montage mirrors it exactly without
// re-deriving any of that, in client and server list modes alike.
@Module({ dynamic: true, store, name: "montage" })
export class Montage extends VuexModule {
  isOpen: boolean = false;
  listPageItems: IMontageListItem[] = [];
  settings: IMontageSettings = loadSettings();

  @Mutation
  setIsOpen(value: boolean) {
    this.isOpen = value;
  }

  @Mutation
  setListPageItems(items: IMontageListItem[]) {
    this.listPageItems = items;
  }

  @Mutation
  private setSettings(settings: IMontageSettings) {
    this.settings = settings;
  }

  @Action
  updateSettings(changes: Partial<IMontageSettings>) {
    const settings = { ...this.settings, ...changes };
    this.setSettings(settings);
    Persister.set(SETTINGS_KEY, settings);
  }
}

export default getModule(Montage);
