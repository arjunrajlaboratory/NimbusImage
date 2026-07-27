export { RestClient } from "@girder/components";
import type { RestClient as RCType } from "@girder/components";
export type RestClientInstance = InstanceType<typeof RCType>;

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

export interface IGirderUser extends Omit<IGirderBase, "name"> {
  _modelType: "user";
  _id: string;
  name?: string;
  login: string;
  email?: string;
  firstName: string;
  lastName: string;
  admin?: boolean;
  meta?: {
    channelColors?: { [key: string]: string };
    [key: string]: any;
  };
}

export interface IGirderItem extends IGirderBase {
  _modelType: "item";
  description: string;
  creatorId: string;
  folderId: string;
  meta: any;
  largeImage?: any;
}

export interface IGirderFolder extends IGirderBase {
  _modelType: "folder";
  description: string;
  creatorId: string;
  meta: any;
  parentId?: string;
  public?: boolean;
  notPublic?: boolean;
  size?: number;
}

export interface IGirderFile extends IGirderBase {
  _modelType: "file";
}

// A collection without its "meta" document. This is what the
// GET /upenn_collection/list endpoint returns, so that listing thousands of
// collections doesn't drag along every layer, tool and snapshot.
export interface ICollectionSummary extends IGirderBase {
  _modelType: "upenn_collection";
  // Nullable: the listing endpoint projects fields with `document.get(field)`,
  // so a collection stored without a description comes back as JSON null rather
  // than being absent. Consumers must guard before calling string methods.
  description: string | null;
  creatorId: string;
  folderId: string;
}

export interface IUPennCollection extends ICollectionSummary {
  meta: any;
}

/**
 * A document returned by POST /resource/batch without a field projection.
 * The backend does not add the frontend-only `_modelType` discriminator.
 */
export type IGirderBatchResource<T extends { _id: string }> = Omit<
  T,
  "_modelType"
>;

/**
 * A projected POST /resource/batch document. Only `_id` is unconditional;
 * every other requested field is optional because callers choose the
 * projection at runtime and documents may omit nullable fields.
 */
export type IGirderProjectedResource<T extends { _id: string }> = Pick<
  T,
  "_id"
> &
  Partial<Omit<T, "_id" | "_modelType">>;

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
  | IGirderFile
  | IUPennCollection;

export interface IGirderApiKey {
  _accessLevel: number;
  _id: string;
  _modelType: "api_key";
  active: boolean;
  created: string;
  key: string;
  lastUse: string | null;
  name: string;
  scope: string[] | null;
  tokenDuration: number;
  userId: string;
}
