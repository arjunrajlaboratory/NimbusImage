import {
  ErrorToolStateSymbol,
  IErrorToolState,
  IGeoJSAnnotation,
  IGeoJSPosition,
  IGeoJSPolygonFeatureStyle,
  IMapEntry,
  IMouseState,
  ISamAnnotationToolState,
  IToolConfiguration,
  PromptType,
  SamAnnotationToolStateSymbol,
  TSamPrompt,
} from "@/store/model";
import {
  ComputeNode,
  ManualInputNode,
  NoOutput,
  TManualInputNodeAsyncOptions,
  TNoOutput,
  createComputeNode,
} from "./computePipeline";
import { createOnnxInferenceSession } from "./onnxModels";
import { InferenceSession, Tensor, TypedTensor } from "onnxruntime-web/webgpu";
import geojs from "geojs";
import {
  BinaryFile,
  InterfaceTypes,
  PipelineInput,
  PipelineOutput,
  TextFile,
  runPipeline,
} from "itk-wasm";
// Import Vue to set reactively the output of the state
import { Vue } from "vue-property-decorator";

type TensorF32 = TypedTensor<"float32">;

interface ISamConfiguration {
  maxWidth: number;
  maxHeight: number;
  meanPerChannel: [number, number, number];
  stdPerChannel: [number, number, number];
}

interface ISamEncoderContext {
  model: TSamModel;
  configuration: ISamConfiguration;
  canvas: HTMLCanvasElement; // Keep this canvas at the encoder input dimensions
  context: CanvasRenderingContext2D; // The corresponding context
  buffer: Float32Array;
}

interface ISamDecoderContext {
  feedConstant: {
    mask_input: TensorF32;
    has_mask_input: TensorF32;
  };
}

const samModelsConfig = {
  vit_b: {
    maxWidth: 1024,
    maxHeight: 1024,
    meanPerChannel: [123.675, 116.28, 103.53],
    stdPerChannel: [58.395, 57.12, 57.375],
  },
  sam2_hiera_base_plus: {
    maxWidth: 1024,
    maxHeight: 1024,
    meanPerChannel: [123.675, 116.28, 103.53],
    stdPerChannel: [58.395, 57.12, 57.375],
  },
  sam2_hiera_large: {
    maxWidth: 1024,
    maxHeight: 1024,
    meanPerChannel: [123.675, 116.28, 103.53],
    stdPerChannel: [58.395, 57.12, 57.375],
  },
} satisfies Record<string, ISamConfiguration>;

export type TSamModel = keyof typeof samModelsConfig;

function isSam2Model(model: TSamModel): boolean {
  return model.startsWith("sam2_");
}

function createEncoderContext(model: TSamModel): ISamEncoderContext {
  const configuration = samModelsConfig[model];
  const { maxWidth, maxHeight } = configuration;
  const canvas = document.createElement("canvas");
  canvas.width = maxWidth;
  canvas.height = maxHeight;
  const context = canvas.getContext("2d", {
    alpha: false,
    colorSpace: "srgb",
    willReadFrequently: true,
  });
  if (!context) {
    throw new Error("Can't create encoder context");
  }
  const nPixels = maxWidth * maxHeight;
  const nChannels = 3;
  const buffer = new Float32Array(nPixels * nChannels);
  return {
    model,
    configuration,
    buffer,
    canvas,
    context,
  };
}

function createEncoderSession(model: TSamModel): Promise<InferenceSession> {
  const ext = isSam2Model(model) ? "ort" : "onnx";
  const encoderPath = `/onnx-models/sam/${model}/encoder.${ext}`;
  const encoderOptions: InferenceSession.SessionOptions = {
    executionProviders: ["webgpu"],
  };
  return createOnnxInferenceSession(encoderPath, encoderOptions);
}

function createDecoderContext(): ISamDecoderContext {
  return {
    feedConstant: {
      has_mask_input: new Tensor("float32", [0]),
      mask_input: new Tensor(
        "float32",
        new Float32Array(256 * 256),
        [1, 1, 256, 256],
      ),
    },
  };
}

function createDecoderSession(model: TSamModel): Promise<InferenceSession> {
  const decoderPath = `/onnx-models/sam/${model}/decoder.onnx`;
  const decoderOptions = {};
  return createOnnxInferenceSession(decoderPath, decoderOptions);
}

async function screenshot({ map, imageLayers }: IMapEntry) {
  const layers = imageLayers.filter(
    (layer) => layer.node().css("visibility") !== "hidden",
  );
  const imageCanvas = await map.screenshot(layers, "canvas");
  return imageCanvas;
}

interface IProcessCanvasOutput {
  model: TSamModel;
  encoderFeed: Record<string, TensorF32>;
  scaledWidth: number;
  scaledHeight: number;
  srcWidth: number;
  srcHeight: number;
  maxWidth: number;
  maxHeight: number;
}

function processCanvas(
  srcCanvas: HTMLCanvasElement,
  samContext: ISamEncoderContext,
): IProcessCanvasOutput {
  // Extract all values from the samContext
  // The context comes from a canvas of size: width * height
  // The buffer is of size: width * height * 3
  const {
    configuration: { maxWidth, maxHeight, meanPerChannel, stdPerChannel },
    context,
    buffer,
  } = samContext;

  const srcWidth = srcCanvas.width;
  const srcHeight = srcCanvas.height;
  let scaledWidth: number;
  let scaledHeight: number;
  // Equivalent to (maxWidth / srcWidth < maxHeight / srcHeight): choose the smallest scale factor
  // Equivalent to (srcWidth / maxWidth > srcHeight / maxHeight): choose the biggest relative side
  if (srcWidth * maxHeight > srcHeight * maxWidth) {
    const scale = maxWidth / srcWidth; // < maxHeight / srcHeight
    scaledWidth = maxWidth; // = srcWidth * scale
    scaledHeight = Math.round(srcHeight * scale); // < maxHeight
  } else {
    const scale = maxHeight / srcHeight; // <= maxWidth / srcWidth
    scaledWidth = Math.round(srcWidth * scale); // <= maxWidth
    scaledHeight = maxHeight; // = srcHeight * scale
  }

  // Draw the input image
  context.clearRect(0, 0, maxWidth, maxHeight);
  context.drawImage(srcCanvas, 0, 0, scaledWidth, scaledHeight);

  // Convert image to normalized float32 buffer
  const imageData = context.getImageData(0, 0, maxWidth, maxHeight);
  const rgbaBuffer = imageData.data;
  const nPixels = maxWidth * maxHeight;
  for (let channel = 0; channel < 3; ++channel) {
    const channelOffset = channel * nPixels;
    const mean = meanPerChannel[channel];
    const std = stdPerChannel[channel];
    for (let iPixel = 0; iPixel < nPixels; ++iPixel) {
      buffer[channelOffset + iPixel] =
        (rgbaBuffer[iPixel * 4 + channel] - mean) / std;
    }
  }

  const { model } = samContext;
  const tensorKey = isSam2Model(model) ? "image" : "input_image";
  return {
    model,
    encoderFeed: {
      [tensorKey]: new Tensor("float32", buffer, [1, 3, maxHeight, maxWidth]),
    },
    srcWidth,
    srcHeight,
    scaledWidth,
    scaledHeight,
    maxWidth,
    maxHeight,
  };
}

type IEncoderOutput = Record<string, TensorF32>;

async function runEncoder(
  encoderSession: InferenceSession,
  input: IProcessCanvasOutput,
) {
  const encoderOutput = await encoderSession.run(input.encoderFeed);
  return encoderOutput as unknown as IEncoderOutput;
}

type IProcessPromptOutput = Record<string, TensorF32>;

function processPrompt(
  prompts: TSamPrompt[],
  canvasInfo: IProcessCanvasOutput,
  context: ISamDecoderContext,
  { map }: IMapEntry,
): IProcessPromptOutput {
  // Count the number of each prompt type
  let nForegroundPts = 0;
  let nBackgroundPts = 0;
  let nBoxes = 0;
  for (let i = 0; i < prompts.length; ++i) {
    switch (prompts[i].type) {
      case PromptType.backgroundPoint:
        nBackgroundPts++;
        break;
      case PromptType.foregroundPoint:
        nForegroundPts++;
        break;
      case PromptType.box:
        nBoxes++;
        break;
    }
  }

  // Number of gcs points (to convert) + a padding point (not to convert)
  const nPromptPoints = nForegroundPts + nBackgroundPts + (2 * nBoxes || 1);
  const pointCoords = new Float32Array(2 * nPromptPoints);
  const pointLabels = new Float32Array(nPromptPoints);

  // Create a function to add a point to the array, along with its label
  let pointIdx = 0;
  const xScale = canvasInfo.scaledWidth / canvasInfo.srcWidth;
  const yScale = canvasInfo.scaledHeight / canvasInfo.srcHeight;
  const pushPointToPrompt = (
    point: IGeoJSPosition,
    label: number,
    convertFromGcs: boolean,
  ) => {
    let promptPoint = point;
    if (convertFromGcs) {
      // Gcs coordinates -> Display / Source coordinates
      promptPoint = map.gcsToDisplay(promptPoint);
      // Display / Source coordinates -> Scaled coordinates
      promptPoint.x *= xScale;
      promptPoint.y *= yScale;
    }
    pointCoords[2 * pointIdx + 0] = promptPoint.x;
    pointCoords[2 * pointIdx + 1] = promptPoint.y;
    pointLabels[pointIdx] = label;
    pointIdx++;
  };

  // Add all the prompts to the arrays
  for (let i = 0; i < prompts.length; ++i) {
    const prompt = prompts[i];
    switch (prompt.type) {
      case PromptType.backgroundPoint:
        pushPointToPrompt(prompt.point, 0, true);
        break;
      case PromptType.foregroundPoint:
        pushPointToPrompt(prompt.point, 1, true);
        break;
      case PromptType.box:
        pushPointToPrompt(prompt.topLeft, 2, true);
        pushPointToPrompt(prompt.bottomRight, 3, true);
        break;
    }
  }

  // Padding point
  if (nBoxes === 0) {
    pushPointToPrompt({ x: 0, y: 0 }, -1, false);
  }

  const result: IProcessPromptOutput = {
    point_coords: new Tensor("float32", pointCoords, [1, nPromptPoints, 2]),
    point_labels: new Tensor("float32", pointLabels, [1, nPromptPoints]),
    ...context.feedConstant,
  };
  // SAM1 needs orig_im_size to resize the mask to the original image dimensions
  if (!isSam2Model(canvasInfo.model)) {
    result.orig_im_size = new Tensor("float32", [
      canvasInfo.srcHeight,
      canvasInfo.srcWidth,
    ]);
  }
  return result;
}

interface IDecoderOutput {
  masks: TensorF32;
  iou_predictions: TensorF32;
}

async function runDecoder(
  decoderSession: InferenceSession,
  prompt: IProcessPromptOutput,
  encoderOutput: IEncoderOutput,
): Promise<IDecoderOutput> {
  const decoderOutput = await decoderSession.run({
    ...encoderOutput,
    ...prompt,
  });
  return decoderOutput as unknown as IDecoderOutput;
}

let cachedWebWorker: Worker | null = null;
async function runItkPipeline({
  masks,
}: IDecoderOutput): Promise<IGeoJSPosition[]> {
  const array = masks.data;
  const width = masks.dims[3];
  const height = masks.dims[2];

  // Setup input image
  const imagePath = "./inimage.bin";
  const imageFile: BinaryFile = {
    data: new Uint8Array(array.buffer),
    path: imagePath,
  };
  const imageInput: PipelineInput = {
    data: imageFile,
    type: InterfaceTypes.BinaryFile,
  };

  // Setup output json
  const outPath = "./out.json";
  const jsonOutput: PipelineOutput = {
    data: { path: outPath },
    type: InterfaceTypes.TextFile,
  };

  // Run the pipeline
  const pipelineName = "MaskToBlob";
  const pipelineArgs: string[] = [
    imagePath,
    width.toString(),
    height.toString(),
    outPath,
  ];
  const pipelineInputs: PipelineInput[] = [imageInput];
  const pipelineOutputs: PipelineOutput[] = [jsonOutput];
  const { outputs, webWorker } = await runPipeline(
    pipelineName,
    pipelineArgs,
    pipelineOutputs,
    pipelineInputs,
    { webWorker: cachedWebWorker },
  );
  cachedWebWorker = webWorker ?? null;

  // Parse the output
  const textFile = outputs[0]?.data as TextFile | undefined;
  if (!textFile?.data) {
    throw new Error("Pipeline didn't return a value");
  }
  return JSON.parse(textFile.data);
}

/**
 * SAM2 decoder outputs masks at a fixed resolution (not the original image
 * size like SAM1 did via orig_im_size). This rescales polygon coordinates
 * from mask space back to display/source image space.
 */
function rescaleMaskToDisplayCoords(
  coords: IGeoJSPosition[],
  canvasInfo: IProcessCanvasOutput,
  decoderOutput: IDecoderOutput,
): IGeoJSPosition[] {
  const maskWidth = decoderOutput.masks.dims[3];
  const maskHeight = decoderOutput.masks.dims[2];
  // mask space → encoder space → display space
  const xScale =
    (canvasInfo.maxWidth / maskWidth) *
    (canvasInfo.srcWidth / canvasInfo.scaledWidth);
  const yScale =
    (canvasInfo.maxHeight / maskHeight) *
    (canvasInfo.srcHeight / canvasInfo.scaledHeight);
  return coords.map(({ x, y }) => ({ x: x * xScale, y: y * yScale }));
}

function displayToWorld(
  coords: IGeoJSPosition[],
  { map }: IMapEntry,
): IGeoJSPosition[] {
  return map.displayToGcs(coords);
}

function simplifyCoordinates(
  coords: IGeoJSPosition[],
  tolerance: number,
): IGeoJSPosition[] {
  if (tolerance < 0) {
    return coords;
  }
  return geojs.util.rdpLineSimplify(coords, tolerance, true);
}

function createSamPipelineEncoderNodes(
  modelNameNode: ManualInputNode<TSamModel>,
) {
  // The map that need to be screenshot and that we use for coordinate conversions
  // It is set by the user
  const geoJsMapInputNode = new ManualInputNode<IMapEntry | TNoOutput>(
    NoOutput,
    {
      type: "debounce",
      wait: 1000,
      options: { leading: false, trailing: true },
    },
  );

  // The context is used as a cache for canvas, 2D context, tensors...
  const contextNode = createComputeNode(createEncoderContext, [modelNameNode]);

  // The session node is an input that contains the model
  const sessionNode = createComputeNode(createEncoderSession, [modelNameNode]);

  // Take a screenshot of the map
  const screenshotNode = createComputeNode(screenshot, [geoJsMapInputNode]);

  // Preprocess the image: resize, normalize and convert to tensor
  const preprocessNode = createComputeNode(processCanvas, [
    screenshotNode,
    contextNode,
  ]);

  // Do the encoding
  const inferenceNode = createComputeNode(runEncoder, [
    sessionNode,
    preprocessNode,
  ]);

  return {
    geoJsMapInputNode,
    contextNode,
    sessionNode,
    screenshotNode,
    preprocessNode,
    inferenceNode,
  };
}

function createSamPipelineDecoderNodes(
  model: TSamModel,
  modelNameNode: ManualInputNode<TSamModel>,
  simplificationToleranceNode: ManualInputNode<number>,
  encoderNodes: ReturnType<typeof createSamPipelineEncoderNodes>,
  promptAsyncOptions?: TManualInputNodeAsyncOptions,
) {
  // Input for the prompt
  // It is set by the user
  const promptInputNode = new ManualInputNode<TSamPrompt[] | TNoOutput>(
    NoOutput,
    promptAsyncOptions,
  );

  // The context is used as a cache for canvas, 2D context, tensors...
  const contextNode = new ManualInputNode(createDecoderContext());

  // The session node is an input that contains the model
  const sessionNode = createComputeNode(createDecoderSession, [modelNameNode]);

  // Preprocess the prompt to match SAM API
  const processPromptNode = createComputeNode(processPrompt, [
    promptInputNode,
    encoderNodes.preprocessNode,
    contextNode,
    encoderNodes.geoJsMapInputNode,
  ]);

  // Run the inference
  const inferenceNode = createComputeNode(runDecoder, [
    sessionNode,
    processPromptNode,
    encoderNodes.inferenceNode,
  ]);

  // Convert the mask into a polygon
  const maskToPolygonNode = createComputeNode(runItkPipeline, [inferenceNode]);

  // SAM1 masks are already in display coordinates (via orig_im_size),
  // SAM2 masks need rescaling from fixed mask space to display space.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let simplificationNode: ComputeNode<any, any>;
  if (isSam2Model(model)) {
    const rescaleNode = createComputeNode(rescaleMaskToDisplayCoords, [
      maskToPolygonNode,
      encoderNodes.preprocessNode,
      inferenceNode,
    ]);
    simplificationNode = createComputeNode(simplifyCoordinates, [
      rescaleNode,
      simplificationToleranceNode,
    ]);
  } else {
    simplificationNode = createComputeNode(simplifyCoordinates, [
      maskToPolygonNode,
      simplificationToleranceNode,
    ]);
  }

  // Convert coordinates from display to world
  const coordinatesConversionNode = createComputeNode(displayToWorld, [
    simplificationNode,
    encoderNodes.geoJsMapInputNode,
  ]);

  return {
    promptInputNode,
    contextNode,
    sessionNode,
    processPromptNode,
    inferenceNode,
    maskToPolygonNode,
    simplificationNode,
    coordinatesConversionNode,
  };
}

function createSamPipeline(model: TSamModel) {
  if (!("gpu" in navigator)) {
    throw new Error("Can't initialize SAM tool: WebGPU not available");
  }

  // Create the pipeline
  const modelNameNode = new ManualInputNode(model);
  const simplificationToleranceNode = new ManualInputNode(0);
  const encoderNodes = createSamPipelineEncoderNodes(modelNameNode);
  const decoderNodes = createSamPipelineDecoderNodes(
    model,
    modelNameNode,
    simplificationToleranceNode,
    encoderNodes,
  );
  const previewNodes = createSamPipelineDecoderNodes(
    model,
    modelNameNode,
    simplificationToleranceNode,
    encoderNodes,
    {
      type: "debounce",
      wait: 100,
    },
  );

  return {
    allNodes: {
      modelNameNode,
      simplificationToleranceNode,
      encoderNodes,
      decoderNodes,
      previewNodes,
    },
    input: {
      model: modelNameNode,
      simplificationTolerance: simplificationToleranceNode,
      geoJSMap: encoderNodes.geoJsMapInputNode,
      mainPrompt: decoderNodes.promptInputNode,
      previewPrompt: previewNodes.promptInputNode,
    },
    output: {
      mainOuput: decoderNodes.coordinatesConversionNode,
      previewOuput: previewNodes.coordinatesConversionNode,
    },
  };
}

export type TSamNodes = ReturnType<typeof createSamPipeline>;

export function createSamToolStateFromToolConfiguration(
  configuration: IToolConfiguration<"samAnnotation">,
): ISamAnnotationToolState | IErrorToolState {
  const model: TSamModel = configuration.values.model.value;
  let nodes: TSamNodes;
  try {
    nodes = createSamPipeline(model);
  } catch (error) {
    return { type: ErrorToolStateSymbol, error: error as Error };
  }

  const state: ISamAnnotationToolState = {
    type: SamAnnotationToolStateSymbol,
    nodes,
    loadingMessages: [],
    mouseState: {
      path: [],
    },
    output: null,
    livePreview: null,
  };

  // Add a callback to update the loading message when computing
  // Do this only for nodes that take a long time to compute
  const { encoderNodes, decoderNodes, previewNodes } = nodes.allNodes;
  const computingMessageMap: [ComputeNode<any, any>, string][] = [
    [encoderNodes.sessionNode, "Creating encoder"],
    [encoderNodes.inferenceNode, "Encoding"],
    [decoderNodes.sessionNode, "Creating decoder"],
    [previewNodes.sessionNode, "Creating decoder preview"],
  ];
  const recomputeLoadingMessage = () => {
    state.loadingMessages = computingMessageMap
      .filter(([node]) => node.isComputing)
      .map(([, message]) => message);
  };
  computingMessageMap.forEach(([node]) => {
    node.onOutputUpdate(recomputeLoadingMessage);
  });

  // State is reactive
  // Main output is reactive
  const outputNode = state.nodes.output.mainOuput;
  outputNode.onOutputUpdate(() => {
    const rawNodeOutput = outputNode.output;
    const stateOutput =
      !rawNodeOutput || rawNodeOutput === NoOutput || rawNodeOutput.length <= 0
        ? null
        : rawNodeOutput;
    Vue.set(state, "output", stateOutput);
  });
  // Preview output is reactive too
  const previewNode = state.nodes.output.previewOuput;
  previewNode.onOutputUpdate(() => {
    const rawNodePreview = previewNode.output;
    const statePreview =
      !rawNodePreview ||
      rawNodePreview === NoOutput ||
      rawNodePreview.length <= 0
        ? null
        : rawNodePreview;
    Vue.set(state, "livePreview", statePreview);
  });
  return state;
}

export function mouseStateToSamPrompt(
  mouseState: IMouseState,
): TSamPrompt | null {
  const path = mouseState.path;
  if (path.length === 0) {
    return null;
  }
  const firstPoint = path[0];
  const lastPoint = path[path.length - 1];
  if (firstPoint.x === lastPoint.x && firstPoint.y === lastPoint.y) {
    // Left button pressed: foreground prompt
    // Any other button pressed: background prompt
    const isForeground = mouseState.initialMouseEvent.button === 0;
    if (isForeground) {
      return {
        type: PromptType.foregroundPoint,
        point: firstPoint,
      };
    } else {
      return {
        type: PromptType.backgroundPoint,
        point: firstPoint,
      };
    }
  } else {
    const [{ x: x1, y: y1 }, { x: x2, y: y2 }] = [firstPoint, lastPoint];
    const [minX, maxX] = x1 < x2 ? [x1, x2] : [x2, x1];
    const [minY, maxY] = y1 < y2 ? [y1, y2] : [y2, y1];
    return {
      type: PromptType.box,
      topLeft: { x: minX, y: minY },
      bottomRight: { x: maxX, y: maxY },
    };
  }
}

export function samPromptToAnnotation(
  unitPrompt: TSamPrompt,
  baseStyle: IGeoJSPolygonFeatureStyle,
): IGeoJSAnnotation {
  let strokeColor: string;
  switch (unitPrompt.type) {
    case PromptType.foregroundPoint:
    case PromptType.box:
      strokeColor = "green";
      break;
    case PromptType.backgroundPoint:
      strokeColor = "red";
      break;
  }
  const style = { ...baseStyle, strokeColor };
  if (unitPrompt.type === PromptType.box) {
    const { x: minX, y: minY } = unitPrompt.topLeft;
    const { x: maxX, y: maxY } = unitPrompt.bottomRight;
    const corners = [
      { x: minX, y: minY },
      { x: minX, y: maxY },
      { x: maxX, y: maxY },
      { x: maxX, y: minY },
    ];
    return geojs.annotation.rectangleAnnotation({
      style,
      corners,
    });
  }
  const position = unitPrompt.point;
  return geojs.annotation.pointAnnotation({
    style,
    position,
  });
}
