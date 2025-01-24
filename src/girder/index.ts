export { vuetifyConfig } from "@girder/components/src/utils";
export {
  default as RestClient, //,
} from "@girder/components/src/rest";
import { RestClientInstance as RCInterface } from "@girder/components/src/rest";
export interface RestClientInstance extends RCInterface {}

export interface IGirderAssetstore {
  _id: string;
  name: string;
}

interface IGirderBase {
  _id: string;
  name: string;
  created?: string;
  updated?: string;
  icon?: string;
}

export interface IGirderUser extends IGirderBase {
  _modelType: "user";
  login: string;
}

export interface IGirderItem extends IGirderBase {
  _modelType: "item";
  description: string;
  folderId: string;
  meta: any;
  largeImage?: any;
}

export interface IGirderFolder extends IGirderBase {
  _modelType: "folder";
  description: string;
  meta: any;
  parentId?: string;
}

export interface IGirderFile extends IGirderBase {
  _modelType: "file";
}

// TODO: This type is essentially a wrapper around the IGirderItem type for now.
// It is defined in case we want to add more properties to the largeImage object in the future.
export interface IGirderLargeImage extends IGirderItem {
  largeImage: {
    fileId: string;
    [key: string]: any;
  };
}

// For whatever reason, the default large image source was named "multi-source2.json"
// This constant is used to identify the default large image source throughout the interface.
// See, for instance, the LargeImageDropdown.vue component, in which it is used to determine
// which large image is the "original" large image.
export const DEFAULT_LARGE_IMAGE_SOURCE = "multi-source2.json";

export type IGirderLocation =
  | IGirderUser
  | IGirderFolder
  | { type: "collections" | "root" | "users" };

export type IGirderSelectAble =
  | IGirderItem
  | IGirderUser
  | IGirderFolder
  | IGirderFile;
