/**
 * Utilities to create computes pipelines
 * The pipelines should not recompute unless their inputs change
 * If a pipeline computes a new result but their input changed in the meantime, don't use the result
 * Each node of the pipeline returns a promise.
 */

import { logError } from "@/utils/log";
import {
  DebounceSettings,
  DebouncedFunc,
  ThrottleSettings,
  debounce,
  throttle,
} from "lodash";

/**
 * Convert a tuple into a tuple of Nodes with the types compatible for ComputeNode.
 * Even if a node outputs a TNoOutput, it won't be given as parameter function, so accept it.
 *
 * Example:
 * convert `[number, string]`
 * into ```[
 *   ComputeNode<(...args: any) => Promise<number> | number | TNoOutput | Promise<TNoOutput>>,
 *   ComputeNode<(...args: any) => Promise<string> | string | TNoOutput | Promise<TNoOutput>>,
 * ]```
 */
type WrapInComputeNode<T extends any[]> = {
  [P in keyof T]: ComputeNode<
    any,
    (...args: any) => Promise<T[P]> | T[P] | TNoOutput | Promise<TNoOutput>
  >;
};

/**
 * Use this symbol as output of compute nodes that don't have an output
 */
export const NoOutput: unique symbol = Symbol("No Output");

export type TNoOutput = typeof NoOutput;

/**
 * Helper function that makes life easier and code clearer when creating a new ComputeNode
 * If you use the constructor directly, you will sometimes have to explicitly give the generic types
 */
export function createComputeNode<T extends any[], U extends any>(
  fun: (...args: T) => U,
  parents: WrapInComputeNode<T>,
) {
  return new ComputeNode(fun, parents);
}

/**
 * A node of the pipeline
 * Just a wrapper around a function
 */
export class ComputeNode<
  Params extends any[],
  Fun extends (...args: Params) => any,
> {
  // The wrapped function
  private fun: Fun;
  private computing: boolean;
  // Set when the parameters changes but a computation is pending
  private shouldRecompute: boolean;
  // The cached output, don't use it directly but using this.output instead
  private _output: Awaited<ReturnType<Fun>> | TNoOutput;

  private readonly parentNodes: WrapInComputeNode<Params>;
  private readonly outputUpdateCallbacks: (() => void)[] = [];

  /**
   * Create a new ComputeNode that wraps a function
   * @param fun The wrapped function
   * @param parentNodes This will subscribe to all parents output, and provide function parameters
   */
  constructor(
    fun: Fun,
    parentNodes: WrapInComputeNode<Params>,
    callbacks?: (() => void)[],
  ) {
    this.fun = fun;
    this.computing = false;
    this.shouldRecompute = false;
    this._output = NoOutput;
    this.parentNodes = parentNodes;

    // Recompute when a parent node change
    const nParents = this.parentNodes.length;
    for (let parentIndex = 0; parentIndex < nParents; ++parentIndex) {
      const parentNode = this.parentNodes[parentIndex];
      const computeCallback = this.createComputeCallback(parentNode);
      parentNode.onOutputUpdate(computeCallback);
    }

    // Add initial callbacks
    callbacks?.forEach((callback) => this.onOutputUpdate(callback));

    // Recompute on initialization
    this.compute();
  }

  /**
   * Create and return a callback function that will trigger recomputation of this node
   * @param parentNode The parent node that will trigger a recomputation
   * @returns The callback that needs to be called when the parentNode's output changes
   */
  private createComputeCallback(parentNode: ComputeNode<any, any>) {
    let previousParentOutput = parentNode.output;
    const computeCallback = () => {
      const currentParentOutput = parentNode.output;
      // Don't recompute when previousParentOutput and currentParentOutput are both NoOutput
      // We still want to recompute if they are the same but not NoOutput
      // For example, in this case we want to recompute:
      // const buffer = [0];
      // const node = new ManualInputNode(buffer);
      // buffer.push(1);
      // node.setValue(buffer);
      if (
        !(currentParentOutput === NoOutput && previousParentOutput === NoOutput)
      ) {
        this.compute();
      }
      previousParentOutput = currentParentOutput;
    };
    return computeCallback;
  }

  /**
   * Register a callback to call when the output of this node changes
   * This can be used to listen to output changes or to check if the node is computing
   * @param callback The callback to call
   */
  public onOutputUpdate(callback: () => void) {
    this.outputUpdateCallbacks.push(callback);
  }

  /**
   * Unregister a callback registered using `onOutputUpdate`
   * @param callback The callback to call
   */
  public offOutputUpdate(callback: () => void) {
    const callbackIndex = this.outputUpdateCallbacks.findLastIndex(
      (x) => x === callback,
    );
    if (callbackIndex >= 0) {
      this.outputUpdateCallbacks.splice(callbackIndex, 1);
    }
  }

  /**
   * Check that none of the parent nodes have the ComputeNode.noOutput symbol as output
   */
  public areAllParametersReady() {
    const nParents = this.parentNodes.length;
    for (let parentIndex = 0; parentIndex < nParents; ++parentIndex) {
      const parentNode = this.parentNodes[parentIndex];
      if (!parentNode.hasOutput) {
        return false;
      }
    }
    return true;
  }

  /**
   * Returns a valid parameter list of the wrapped function or null if one of the node has no output
   */
  public getAllParameters(): Params | null {
    if (!this.areAllParametersReady()) {
      return null;
    }
    const nParents = this.parentNodes.length;
    const params: Params = new Array(nParents) as Params;
    for (let parentIndex = 0; parentIndex < nParents; ++parentIndex) {
      const paramNode = this.parentNodes[parentIndex];
      params[parentIndex] = paramNode.output;
    }
    return params;
  }

  /**
   * Reset the output and recompute
   * The returned promise resolves when the output has been set
   */
  private async compute() {
    if (this.computing) {
      this.shouldRecompute = true;
      return;
    }

    // Set computing flag before calling the callbacks by setting this.output
    this.computing = true;
    // This will set all the children nodes output to "NoOutput"
    this.output = NoOutput;

    // Computation loop
    let computedOutput: typeof this.output;
    do {
      // Default to "NoOutput"
      computedOutput = NoOutput;
      const params = this.getAllParameters();
      // We took the parameters into account, don't need to recompute anymore
      this.shouldRecompute = false;
      // Do the computation
      if (params !== null) {
        try {
          computedOutput = await this.fun(...params);
        } catch (e) {
          logError(
            `Computation of pipeline node failed [${this.fun.name}]`,
          );
          if (e instanceof Error) {
            logError(e.message);
            logError(e.stack ?? "");
          } else {
            logError("Raw error value: " + JSON.stringify(e));
          }
        }
      }
      // Recompute if the parameters changed
    } while (this.shouldRecompute);

    // Set computing flag before calling the callbacks by setting this.output
    this.computing = false;
    // This triggers callbacks
    this.output = computedOutput;
  }

  public get output(): Awaited<ReturnType<Fun>> | TNoOutput {
    return this._output;
  }

  protected set output(newOutput) {
    this._output = newOutput;

    // Trigger all callbacks for the pipeline nodes that have subscribed to output changes
    const callbacks = this.outputUpdateCallbacks;
    for (let callbackIdx = 0; callbackIdx < callbacks.length; ++callbackIdx) {
      callbacks[callbackIdx]();
    }
  }

  public get hasOutput() {
    return this.output !== NoOutput;
  }

  public get isComputing() {
    return this.computing;
  }
}

export type TManualInputNodeAsyncOptions =
  | {
      type: "debounce";
      wait?: number;
      options?: DebounceSettings;
    }
  | {
      type: "throttle";
      wait?: number;
      options?: ThrottleSettings;
    };

/**
 * Use this class to interface the ComputeNodes with the rest of the code
 * The generic type T can also include the special value NoOutput
 * Use NoOutput when you don't want the children nodes to compute
 */
export class ManualInputNode<T> extends ComputeNode<[], () => T | TNoOutput> {
  private readonly asyncSetValue?: DebouncedFunc<(value: T) => Promise<void>>;
  private readonly syncSetValue: (value: T) => Promise<void>;

  constructor(
    initialValue: T | TNoOutput = NoOutput,
    asyncOptions?: TManualInputNodeAsyncOptions,
  ) {
    super(() => NoOutput, []);
    // Set the value immediately after the resolution of the value
    this.syncSetValue = async (value: T) => {
      this.output = await value;
    };
    if (asyncOptions) {
      // Set the value using the given async options
      this.asyncSetValue = (
        asyncOptions.type === "debounce" ? debounce : throttle
      )(this.syncSetValue, asyncOptions.wait, asyncOptions.options);
    }
    if (initialValue !== NoOutput) {
      this.setValue(initialValue);
    }
  }

  /**
   * Set the the output value of this node
   * If you want to be able to use NoOutput as a value, specify it explicitly in T
   */
  setValue(value: T, immediate: boolean = false) {
    if (immediate || !this.asyncSetValue) {
      return this.syncSetValue(value);
    } else {
      return this.asyncSetValue(value);
    }
  }
}

/**
 * Convenient type for a compute node for which the output type only is important
 */
export type OutputNode<T> = ComputeNode<
  any[],
  (...args: any[]) => T | Promise<T>
>;
