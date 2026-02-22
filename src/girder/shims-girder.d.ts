declare module "@girder/components" {
  import type { Component } from "vue";
  import type { AxiosInstance } from "axios";

  export const GirderUpload: Component;
  export const GirderBreadcrumb: Component;
  export const GirderSearch: Component;
  export const GirderFileManager: Component;

  export class UploadManager {
    constructor(file: File, options?: any);
  }

  interface IRestClientOptions {
    apiRoot: string;
    token: string;
    useGirderAuthorizationHeader: boolean;
    setLocalCookie: true;
  }

  export interface IGirderUser {
    name: string;
    _modelType: "user";
    _id: string;
    login: string;
  }

  export interface RestClientInstance
    extends AxiosInstance,
      IRestClientOptions {
    readonly user: Readonly<IGirderUser> | null;

    login(username: string, password: string, otp?: string): Promise<any>;
    logout(): void | Promise<void>;
    register(
      login: string,
      email: string,
      firstName: string,
      lastName: string,
      password: string,
      admin?: boolean,
    ): Promise<any>;

    fetchUser(): Promise<Readonly<IGirderUser>>;
  }

  export interface RestClientStatic extends RestClientInstance {
    new (options: Partial<IRestClientOptions>): RestClientInstance;
  }

  export const RestClient: RestClientStatic;
}

declare module "@/girder/components" {
  export {
    GirderUpload as Upload,
    GirderBreadcrumb as Breadcrumb,
    GirderSearch as Search,
    GirderFileManager as FileManager,
  } from "@girder/components";
}
