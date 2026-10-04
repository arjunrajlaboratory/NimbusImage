import {
  AnnotationShape,
  IGeoJSPosition,
  TAnnotationOrStub,
  isHydratedAnnotation,
} from "@/store/model";

// A rectangle in image pixel coordinates.
export interface IImageRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface IMontageOutline {
  shape: AnnotationShape;
  coordinates: IGeoJSPosition[];
}

// Everything one montage panel draws. Shared by the on-screen panels and the
// PNG export so the two can never render differently.
export interface IMontagePanelContent {
  // The crop, covering `imageRect` (null while loading or on failure).
  image: CanvasImageSource | null;
  // The square image-pixel window the panel shows. May extend past the image
  // edge; that part is drawn as background.
  window: IImageRect;
  // The part of `window` that lies inside the image: the region requested.
  imageRect: IImageRect | null;
  outline: IMontageOutline | null;
  color: string;
  indexLabel: string | null;
  textLines: string[];
}

// A built crop: the region URL and the image rect it renders.
export interface IMontageCrop {
  url: URL;
  imageRect: IImageRect;
}

// An expected reason a crop can't be built (object outside the image, no
// plane for a visible layer at the object's frame): shown on the panel, not
// logged as a failure.
export class MontageCropError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MontageCropError";
  }
}

// A crop request for inputs that have since changed.
export class StaleCropError extends Error {
  constructor() {
    super("Montage crop superseded");
    this.name = "StaleCropError";
  }
}

// Object bounding box. Stubs carry no coordinates, so until they are hydrated
// they fall back to centroid ± estimated radius.
export function annotationImageBounds(
  annotation: TAnnotationOrStub,
): IImageRect {
  if (isHydratedAnnotation(annotation) && annotation.coordinates.length) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const { x, y } of annotation.coordinates) {
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
    return { left, top, right, bottom };
  }
  const center = isHydratedAnnotation(annotation)
    ? { x: 0, y: 0 }
    : annotation.centroid;
  const radius = isHydratedAnnotation(annotation)
    ? 0
    : annotation.estimatedRadius ?? 0;
  return {
    left: center.x - radius,
    top: center.y - radius,
    right: center.x + radius,
    bottom: center.y + radius,
  };
}

// One square window per object, centered on its bounding box and padded by
// `padding` image pixels on every side. In "uniform" mode every window takes
// the largest side on the page so all panels share one scale.
export function montageWindows(
  bounds: IImageRect[],
  padding: number,
  scaleMode: "uniform" | "fit",
): IImageRect[] {
  const pad = Math.max(0, padding);
  const sides = bounds.map((b) =>
    Math.max(1, Math.max(b.right - b.left, b.bottom - b.top) + 2 * pad),
  );
  const uniformSide = Math.max(1, ...sides);
  return bounds.map((b, i) => {
    const side = scaleMode === "uniform" ? uniformSide : sides[i];
    const cx = (b.left + b.right) / 2;
    const cy = (b.top + b.bottom) / 2;
    return {
      left: cx - side / 2,
      top: cy - side / 2,
      right: cx + side / 2,
      bottom: cy + side / 2,
    };
  });
}

// The part of `window` inside a width × height image, snapped outward to whole
// pixels (the region endpoint takes integer bounds); null when they don't
// overlap.
export function clipToImage(
  window: IImageRect,
  width: number,
  height: number,
): IImageRect | null {
  const left = Math.max(0, Math.floor(window.left));
  const top = Math.max(0, Math.floor(window.top));
  const right = Math.min(width, Math.ceil(window.right));
  const bottom = Math.min(height, Math.ceil(window.bottom));
  if (right <= left || bottom <= top) {
    return null;
  }
  return { left, top, right, bottom };
}

// Output size to request for a region drawn at `scale` device pixels per image
// pixel: never more than the native resolution (the canvas upsamples instead).
export function regionOutputSize(
  imageRect: IImageRect,
  scale: number,
): { width: number; height: number } {
  const width = imageRect.right - imageRect.left;
  const height = imageRect.bottom - imageRect.top;
  const factor = Math.min(1, scale);
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

export interface IMontageGrid {
  columns: number;
  rows: number;
  width: number;
  height: number;
}

export function montageGrid(
  count: number,
  columns: number,
  panelSize: number,
  gap: number,
): IMontageGrid {
  const cols = Math.max(1, Math.min(columns, count));
  const rows = Math.max(1, Math.ceil(count / cols));
  return {
    columns: cols,
    rows,
    width: cols * panelSize + (cols - 1) * gap,
    height: rows * panelSize + (rows - 1) * gap,
  };
}

// Columns for the exported image: the on-screen count, but at least √count so
// the image stays roughly square. A narrow montage (palettes open) at a large
// panel size would otherwise stack a 200-object page past the browser's canvas
// height limit (~32K px) and fail to encode.
export function montageExportColumns(
  gridWidth: number,
  panelSize: number,
  gap: number,
  count: number,
): number {
  const onScreen = Math.max(
    1,
    Math.floor((gridWidth + gap) / (panelSize + gap)),
  );
  return Math.max(onScreen, Math.ceil(Math.sqrt(count)));
}

const BACKGROUND = "#000000";
const LABEL_BACKGROUND = "rgba(0, 0, 0, 0.6)";
const LABEL_COLOR = "#ffffff";

// Draw one panel into the square (x, y, size) of `ctx`, all in device pixels.
// `pixelRatio` scales strokes and text so they read the same at any density.
export function drawMontagePanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  content: IMontagePanelContent,
  pixelRatio: number,
) {
  const { window, imageRect, image, outline } = content;
  const scale = size / (window.right - window.left);
  const toPanel = (p: IGeoJSPosition) => ({
    x: x + (p.x - window.left) * scale,
    y: y + (p.y - window.top) * scale,
  });

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.clip();
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(x, y, size, size);

  if (image && imageRect) {
    const topLeft = toPanel({ x: imageRect.left, y: imageRect.top });
    const drawWidth = (imageRect.right - imageRect.left) * scale;
    const drawHeight = (imageRect.bottom - imageRect.top) * scale;
    // Upsampled crops show real pixels rather than a blur.
    const naturalWidth = (image as { width?: number }).width ?? drawWidth;
    ctx.imageSmoothingEnabled = drawWidth <= naturalWidth;
    ctx.drawImage(image, topLeft.x, topLeft.y, drawWidth, drawHeight);
  }

  if (outline && outline.coordinates.length) {
    ctx.strokeStyle = content.color;
    ctx.lineWidth = 1.5 * pixelRatio;
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (
      outline.shape === AnnotationShape.Point ||
      outline.coordinates.length === 1
    ) {
      const center = toPanel(outline.coordinates[0]);
      ctx.arc(center.x, center.y, 6 * pixelRatio, 0, 2 * Math.PI);
    } else {
      outline.coordinates.forEach((p, i) => {
        const q = toPanel(p);
        if (i === 0) {
          ctx.moveTo(q.x, q.y);
        } else {
          ctx.lineTo(q.x, q.y);
        }
      });
      if (outline.shape !== AnnotationShape.Line) {
        ctx.closePath();
      }
    }
    ctx.stroke();
  }

  const fontSize = 11 * pixelRatio;
  const padX = 3 * pixelRatio;
  const lineHeight = fontSize + 3 * pixelRatio;
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textBaseline = "middle";
  const drawLabel = (text: string, top: number) => {
    const width = ctx.measureText(text).width + 2 * padX;
    ctx.fillStyle = LABEL_BACKGROUND;
    ctx.fillRect(x, top, width, lineHeight);
    ctx.fillStyle = LABEL_COLOR;
    ctx.fillText(text, x + padX, top + lineHeight / 2);
  };
  if (content.indexLabel !== null) {
    drawLabel(content.indexLabel, y);
  }
  content.textLines.forEach((line, i) => {
    const fromBottom = content.textLines.length - i;
    drawLabel(line, y + size - fromBottom * lineHeight);
  });

  ctx.restore();
}
