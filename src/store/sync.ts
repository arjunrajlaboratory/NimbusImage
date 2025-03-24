import {
  getModule,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import store from "./root";

@Module({ dynamic: true, store, name: "sync" })
export class ServerSync extends VuexModule {
  loading = false;
  saving = false;
  datasetLoading = false;
  lastError: Error | null = null;

  @Mutation
  setSaving(status: boolean | Error) {
    this.saving = status === true;
    if (typeof status !== "boolean") {
      this.lastError = status;
    }
  }

  @Mutation
  setLoading(status: boolean | Error) {
    this.loading = status === true;
    if (typeof status !== "boolean") {
      this.lastError = status;
    }
  }

  @Mutation
  setDatasetLoading(status: boolean) {
    this.datasetLoading = status;
  }
}

export default getModule(ServerSync);
