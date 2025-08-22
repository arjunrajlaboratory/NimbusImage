declare module "@girder/components/src/components" {
  import { Component } from "vue";

  export const Upload: Component;
  export const Breadcrumb: Component;
  export const Search: Component;
}

declare module "@girder/components/src/components/Snippet" {
  import { Component } from "vue";

  export const FileManager: Component;
}

declare module "@girder/components/src/utils" {
  export const vuetifyConfig: any;
}
declare module "@girder/components/src/utils/upload" {
  const UploadManager: any;
  export default UploadManager;
}
declare module "@girder/components/src/rest" {
  import { AxiosInstance } from "axios";

  interface IRestClientOptions {
    apiRoot: string;
    token: string;
    useGirderAuthorizationHeader: boolean;
    setLocalCookie: true;
  }

  export interface IGirderUser {
    name: string; // TODO check
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

  const RestClient: RestClientStatic;

  export default RestClient;
}

declare module "@/girder/components" {
  // note: will also import the vuetify.min.css even tho in the lib version the SASS one will be generated directly
  export {
    Upload,
    Breadcrumb,
    Search,
  } from "@girder/components/src/components";
  export { FileManager } from "@girder/components/src/components/Snippet";
}
