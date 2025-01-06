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

export type IGirderLocation =
  | IGirderUser
  | IGirderFolder
  | { type: "collections" | "root" | "users" };

export type IGirderSelectAble =
  | IGirderItem
  | IGirderUser
  | IGirderFolder
  | IGirderFile;
