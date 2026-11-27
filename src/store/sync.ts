import {
  getModule,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import store from "./root";

/**
 * The server-status indicator (ServerStatus.vue).
 *
 * Every request brackets itself with `setSaving(true)` / `setLoading(true)`
 * and ends with `false` (succeeded) or an Error (failed). Requests overlap,
 * so each kind is a COUNT of requests in flight, not a flag: with a flag the
 * first request to finish hid the indicator while another was still running.
 * A caller must therefore end every `true` exactly once, on every path
 * (try/finally or a catch), or the indicator stays on.
 *
 * `lastError` is the most recent failure, shown while idle; the next request
 * that succeeds clears it.
 */
@Module({ dynamic: true, store, name: "sync" })
export class ServerSync extends VuexModule {
  loading = false;
  saving = false;
  loadsInFlight = 0;
  savesInFlight = 0;
  datasetLoading = false;
  lastError: Error | null = null;

  @Mutation
  setSaving(status: boolean | Error) {
    this.savesInFlight = nextInFlightCount(this.savesInFlight, status);
    this.saving = this.savesInFlight > 0;
    this.lastError = nextLastError(this.lastError, status);
  }

  @Mutation
  setLoading(status: boolean | Error) {
    this.loadsInFlight = nextInFlightCount(this.loadsInFlight, status);
    this.loading = this.loadsInFlight > 0;
    this.lastError = nextLastError(this.lastError, status);
  }

  @Mutation
  setDatasetLoading(status: boolean) {
    this.datasetLoading = status;
  }
}

// `true` starts a request; `false` or an Error ends one. Never below zero, so
// an end with no matching start cannot hide a later request.
function nextInFlightCount(count: number, status: boolean | Error) {
  return status === true ? count + 1 : Math.max(0, count - 1);
}

function nextLastError(lastError: Error | null, status: boolean | Error) {
  if (status === true) {
    return lastError;
  }
  return status === false ? null : status;
}

export default getModule(ServerSync);

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}
