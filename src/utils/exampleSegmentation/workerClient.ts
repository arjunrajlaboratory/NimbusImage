// Small typed RPC client over the example-segmentation worker
// (src/workers/exampleSegmentation.worker.ts). See
// codebaseDocumentation/EXAMPLE_SEGMENTATION_TOOL.md §4.5 for the protocol.
//
// The worker is created lazily on first use. Every request gets an
// incrementing requestId; responses are matched back to their promise via a
// Map keyed by that id, so a late/stale response for a superseded request
// can never resolve the wrong promise (it either resolves its own,
// still-pending promise, or is silently ignored if that promise was already
// settled/removed).

import {
  IPostprocessParams,
  ISegmentationResultResponse,
  IWorkerExample,
  TWorkerRequest,
  TWorkerResponse,
} from "@/utils/exampleSegmentation/types";
import { logError } from "@/utils/log";

type TPendingRequest =
  | {
      kind: "ack";
      resolve: () => void;
      reject: (error: Error) => void;
    }
  | {
      kind: "result";
      resolve: (response: ISegmentationResultResponse) => void;
      reject: (error: Error) => void;
    };

/**
 * Typed RPC client for the example-segmentation worker. One instance owns
 * one worker (and therefore one trained model / cached image), matching the
 * lifetime of a single `exampleSegmentation` tool state.
 */
export class ExampleSegmentationWorkerClient {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, TPendingRequest>();

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const worker = new Worker(
      new URL("@/workers/exampleSegmentation.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (event: MessageEvent<TWorkerResponse>) =>
      this.handleMessage(event.data);
    worker.onerror = (event: ErrorEvent) => this.handleWorkerError(event);
    this.worker = worker;
    return worker;
  }

  private handleMessage(response: TWorkerResponse) {
    const pending = this.pendingRequests.get(response.requestId);
    if (!pending) {
      // Late response for an already-settled or unknown request: ignore.
      return;
    }
    this.pendingRequests.delete(response.requestId);

    if (response.type === "error") {
      pending.reject(new Error(response.error));
      return;
    }
    if (
      (pending.kind === "ack" && response.type !== "ack") ||
      (pending.kind === "result" && response.type !== "result")
    ) {
      pending.reject(
        new Error(
          `Example segmentation worker returned unexpected response type "${response.type}"`,
        ),
      );
      return;
    }
    if (pending.kind === "ack") {
      pending.resolve();
    } else {
      pending.resolve(response as ISegmentationResultResponse);
    }
  }

  private handleWorkerError(event: ErrorEvent) {
    logError("Example segmentation worker error:", event.message);
    const error = new Error(
      event.message || "Example segmentation worker error",
    );
    for (const requestId of this.pendingRequests.keys()) {
      this.pendingRequests.get(requestId)?.reject(error);
    }
    this.pendingRequests.clear();
  }

  private allocateRequestId(): number {
    return this.nextRequestId++;
  }

  private sendAckRequest(
    request: TWorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingRequests.set(request.requestId, {
        kind: "ack",
        resolve,
        reject,
      });
      this.ensureWorker().postMessage(request, transfer);
    });
  }

  private sendResultRequest(
    request: TWorkerRequest,
  ): Promise<ISegmentationResultResponse> {
    return new Promise<ISegmentationResultResponse>((resolve, reject) => {
      this.pendingRequests.set(request.requestId, {
        kind: "result",
        resolve,
        reject,
      });
      this.ensureWorker().postMessage(request);
    });
  }

  /**
   * Sets the working-resolution RGBA image the worker computes features and
   * predictions from. The `rgba` buffer is transferred (not copied) to the
   * worker, so the caller must not reuse it afterwards.
   */
  setImage(rgba: ArrayBuffer, width: number, height: number): Promise<void> {
    const requestId = this.allocateRequestId();
    return this.sendAckRequest(
      { type: "setImage", requestId, rgba, width, height },
      [rgba],
    );
  }

  /**
   * Trains (when `examples` is non-empty) or re-predicts with the cached
   * model (when `examples` is empty) and returns the post-processed
   * contours for the given params.
   */
  trainPredict(
    examples: IWorkerExample[],
    params: IPostprocessParams,
  ): Promise<ISegmentationResultResponse> {
    const requestId = this.allocateRequestId();
    return this.sendResultRequest({
      type: "trainPredict",
      requestId,
      examples,
      params,
    });
  }

  /**
   * Re-runs only the cheap post-processing stage (threshold, connected
   * components, size filter, contour trace) on the cached probability map.
   */
  postprocess(
    params: IPostprocessParams,
  ): Promise<ISegmentationResultResponse> {
    const requestId = this.allocateRequestId();
    return this.sendResultRequest({ type: "postprocess", requestId, params });
  }

  /** Drops the trained model, cached examples, and probability map. */
  reset(): Promise<void> {
    const requestId = this.allocateRequestId();
    return this.sendAckRequest({ type: "reset", requestId });
  }

  /** Terminates the worker and rejects any requests still in flight. */
  terminate() {
    this.worker?.terminate();
    this.worker = null;
    const error = new Error("Example segmentation worker terminated");
    for (const requestId of this.pendingRequests.keys()) {
      this.pendingRequests.get(requestId)?.reject(error);
    }
    this.pendingRequests.clear();
  }
}
