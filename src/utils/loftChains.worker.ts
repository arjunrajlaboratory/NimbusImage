import {
  ILoftChainRequest,
  ILoftChainResponse,
  buildLoftChainIndices,
} from "@/utils/loftChains";

// Web worker entry: runs the pairwise-overlap chain matching off the UI
// thread. Spawned by loftChainsWorkerClient.ts.

// The project tsconfig uses the DOM lib, so type the worker scope manually.
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<ILoftChainRequest>) => void) | null;
  postMessage(message: ILoftChainResponse): void;
};

workerScope.onmessage = (event) => {
  const { requestId, inputs, minOverlapFraction } = event.data;
  workerScope.postMessage({
    requestId,
    chains: buildLoftChainIndices(inputs, minOverlapFraction),
  });
};
