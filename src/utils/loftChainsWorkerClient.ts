import {
  ILoftChainInput,
  ILoftChainResponse,
  buildLoftChainIndices,
} from "@/utils/loftChains";
import { logWarning } from "@/utils/log";

// UI-thread client for the loft chain-matching worker. The pairwise overlap
// computation is O(neighbors × polygon complexity) and can take a while on
// dense segmentations, so it runs in a shared, lazily-created worker. When
// workers are unavailable (tests, older environments) or the worker breaks,
// requests transparently fall back to the synchronous implementation.

interface IPendingRequest {
  inputs: ILoftChainInput[];
  minOverlapFraction: number;
  resolve: (chains: number[][]) => void;
}

let worker: Worker | null = null;
let workerBroken = false;
let nextRequestId = 0;
const pendingRequests = new Map<number, IPendingRequest>();

function failover(reason: unknown) {
  logWarning("Loft chain worker failed, computing on the UI thread", reason);
  workerBroken = true;
  worker?.terminate();
  worker = null;
  for (const { inputs, minOverlapFraction, resolve } of [
    ...pendingRequests.values(),
  ]) {
    resolve(buildLoftChainIndices(inputs, minOverlapFraction));
  }
  pendingRequests.clear();
}

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === "undefined") {
    return null;
  }
  if (!worker) {
    try {
      worker = new Worker(new URL("./loftChains.worker.ts", import.meta.url), {
        type: "module",
      });
    } catch (error) {
      failover(error);
      return null;
    }
    worker.onmessage = (event: MessageEvent<ILoftChainResponse>) => {
      const pending = pendingRequests.get(event.data.requestId);
      pendingRequests.delete(event.data.requestId);
      pending?.resolve(event.data.chains);
    };
    worker.onerror = failover;
  }
  return worker;
}

export function computeLoftChains(
  inputs: ILoftChainInput[],
  minOverlapFraction: number,
): Promise<number[][]> {
  const activeWorker = getWorker();
  if (!activeWorker) {
    return Promise.resolve(buildLoftChainIndices(inputs, minOverlapFraction));
  }
  return new Promise((resolve) => {
    const requestId = nextRequestId;
    nextRequestId += 1;
    pendingRequests.set(requestId, { inputs, minOverlapFraction, resolve });
    activeWorker.postMessage({ requestId, inputs, minOverlapFraction });
  });
}
