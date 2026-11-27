import { WireCategory } from '../types/design';

/**
 * Calibrated 2D floor-plan canvas ratio & isotropic coordinate utilities.
 *
 * Enforces an exact 1:4 (width : height) calibrated CAD drawing sheet while
 * maintaining strict isotropic scaling (scaleX === scaleY) so real-world room
 * dimensions and proportions never distort during zoom, pan, or container resize.
 */
export const CANVAS_ASPECT_RATIO_W_TO_H = 0.25; // 1:4 (width : height)
export const CANVAS_ASPECT_LABEL = '1:4';

export interface Calibrated2DCanvasMetrics {
  /** Exact calibrated pixel-per-meter scale (identical on X and Y axes). */
  scalePxPerMeter: number;
  /** Real-world building footprint in meters. */
  lengthM: number;
  widthM: number;
  /** Building footprint in calibrated SVG sheet units. */
  planW: number;
  planH: number;
  /** Minimum margin around the building footprint in SVG units. */
  pad: number;
  /** Calibrated drawing sheet dimensions (exact 1:4 ratio when !previewOnly). */
  sheetW: number;
  sheetH: number;
  /** Verified sheet aspect ratio (sheetW / sheetH === 0.25 for full 2D CAD canvas). */
  sheetAspectRatio: number;
  /** Building plan top-left origin inside the 1:4 calibrated sheet. */
  originX: number;
  originY: number;
  /** Building plan center inside the calibrated sheet. */
  planCenterX: number;
  planCenterY: number;
  /** Isotropic SVG viewBox matched to the container aspect ratio to prevent distortion. */
  viewX: number;
  viewY: number;
  vbW: number;
  vbH: number;
  /** Zoom percentage (15–100) that displays the full 1:4 drawing sheet inside the viewport. */
  fitSheetZoomPct: number;
}

export interface CanvasViewportSize {
  width: number;
  height: number;
}

export interface CanvasClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Computes calibrated 1:4 CAD sheet and viewport-matched isotropic viewBox metrics.
 * Guarantees scaleX === scaleY across all site dimensions and viewport aspect ratios.
 */
export function computeCalibrated2DCanvasMetrics(
  lengthM: number,
  widthM: number,
  options?: {
    previewOnly?: boolean;
    viewport?: CanvasViewportSize | null;
  }
): Calibrated2DCanvasMetrics {
  const previewOnly = !!options?.previewOnly;
  const safeLengthM = Math.max(1, Number.isFinite(lengthM) ? lengthM : 6);
  const safeWidthM = Math.max(1, Number.isFinite(widthM) ? widthM : 4);

  // Calibrated isotropic scale so both compact rooms (e.g. 20ft x 13ft Hall) and large plots remain crisp
  const maxDim = Math.max(safeLengthM, safeWidthM, 4);
  const scalePxPerMeter = Math.max(18, Math.min(52, 540 / maxDim));

  const pad = previewOnly ? 22 : 64;
  const planW = safeLengthM * scalePxPerMeter;
  const planH = safeWidthM * scalePxPerMeter;

  // Calibrated drawing sheet: strict 1:4 (width : height) in interactive 2D CAD mode
  let sheetW: number;
  let sheetH: number;
  if (previewOnly) {
    sheetW = planW + pad * 2;
    sheetH = planH + pad * 2;
  } else {
    const minSheetWForPlan = planW + pad * 2;
    const minSheetWForHeight = (planH + pad * 2) * CANVAS_ASPECT_RATIO_W_TO_H;
    sheetW = Math.max(minSheetWForPlan, minSheetWForHeight);
    sheetH = sheetW / CANVAS_ASPECT_RATIO_W_TO_H; // Exact sheetW * 4
  }

  const originX = (sheetW - planW) / 2;
  const originY = (sheetH - planH) / 2;
  const planCenterX = originX + planW / 2;
  const planCenterY = originY + planH / 2;

  // Base isotropic framing around the active building plan
  const baseFrameW = planW + pad * 2;
  const baseFrameH = planH + pad * 2;
  let vbW = baseFrameW;
  let vbH = baseFrameH;

  const vpW = options?.viewport?.width ?? 0;
  const vpH = options?.viewport?.height ?? 0;
  if (!previewOnly && vpW > 0 && vpH > 0) {
    const vpAspect = vpW / vpH;
    const baseAspect = baseFrameW / baseFrameH;
    if (vpAspect >= baseAspect) {
      vbH = baseFrameH;
      vbW = baseFrameH * vpAspect;
    } else {
      vbW = baseFrameW;
      vbH = baseFrameW / vpAspect;
    }
  }

  const viewX = planCenterX - vbW / 2;
  const viewY = planCenterY - vbH / 2;

  const fitSheetZoomPct = previewOnly
    ? 100
    : Math.max(
        15,
        Math.min(
          100,
          Math.floor(Math.min(vbW / (sheetW + 32), vbH / (sheetH + 40)) * 100)
        )
      );

  return {
    scalePxPerMeter,
    lengthM: safeLengthM,
    widthM: safeWidthM,
    planW,
    planH,
    pad,
    sheetW,
    sheetH,
    sheetAspectRatio: sheetW / sheetH,
    originX,
    originY,
    planCenterX,
    planCenterY,
    viewX,
    viewY,
    vbW,
    vbH,
    fitSheetZoomPct,
  };
}

/** Converts real-world calibrated coordinates (meters) to 2D sheet SVG coordinates. */
export function metersToSheetCoords(
  xM: number,
  yM: number,
  metrics: Calibrated2DCanvasMetrics
): { x: number; y: number } {
  return {
    x: metrics.originX + xM * metrics.scalePxPerMeter,
    y: metrics.originY + yM * metrics.scalePxPerMeter,
  };
}

/**
 * Forward projection from calibrated real-world meters to rendered screen pixels,
 * accounting for preserveAspectRatio="xMidYMid meet", uniform zoom, and pan.
 */
export function metersToScreenCoords(
  xM: number,
  yM: number,
  rect: CanvasClientRect,
  metrics: Calibrated2DCanvasMetrics,
  zoom: number,
  panOffset: { x: number; y: number }
): { x: number; y: number } {
  const fitScale = Math.min(rect.width / metrics.vbW, rect.height / metrics.vbH);
  const renderedW = metrics.vbW * fitScale;
  const renderedH = metrics.vbH * fitScale;
  const offsetX = rect.left + (rect.width - renderedW) / 2;
  const offsetY = rect.top + (rect.height - renderedH) / 2;

  const sheet = metersToSheetCoords(xM, yM, metrics);
  const zoomFactor = zoom / 100;
  const cx = metrics.planCenterX;
  const cy = metrics.planCenterY;

  const transformedSvgX = (sheet.x - cx) * zoomFactor + cx + panOffset.x;
  const transformedSvgY = (sheet.y - cy) * zoomFactor + cy + panOffset.y;

  return {
    x: offsetX + (transformedSvgX - metrics.viewX) * fitScale,
    y: offsetY + (transformedSvgY - metrics.viewY) * fitScale,
  };
}

/**
 * Exact inverse projection from screen/client pointer coordinates to calibrated real-world meters.
 * Guarantees distortion-free round-trip accuracy across any zoom level, pan offset, or resize.
 */
export function screenToCalibratedMeters(
  clientX: number,
  clientY: number,
  rect: CanvasClientRect,
  metrics: Calibrated2DCanvasMetrics,
  zoom: number,
  panOffset: { x: number; y: number }
): { x: number; y: number; inside: boolean } {
  if (rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0, inside: false };
  }

  const fitScale = Math.min(rect.width / metrics.vbW, rect.height / metrics.vbH);
  const renderedW = metrics.vbW * fitScale;
  const renderedH = metrics.vbH * fitScale;
  const offsetX = rect.left + (rect.width - renderedW) / 2;
  const offsetY = rect.top + (rect.height - renderedH) / 2;

  const svgX = metrics.viewX + (clientX - offsetX) / fitScale;
  const svgY = metrics.viewY + (clientY - offsetY) / fitScale;

  const zoomFactor = zoom / 100;
  const cx = metrics.planCenterX;
  const cy = metrics.planCenterY;
  const unscaledX = (svgX - cx - panOffset.x) / zoomFactor + cx;
  const unscaledY = (svgY - cy - panOffset.y) / zoomFactor + cy;

  const mx = (unscaledX - metrics.originX) / metrics.scalePxPerMeter;
  const my = (unscaledY - metrics.originY) / metrics.scalePxPerMeter;
  const inside = mx >= 0 && mx <= metrics.lengthM && my >= 0 && my <= metrics.widthM;

  return { x: mx, y: my, inside };
}

/**
 * Visual perpendicular lane offsets (in SVG units) so separate Phase (L), Neutral (N),
 * and Earth (E) conductors sharing the same conduit corridor render cleanly side-by-side
 * without altering their calibrated real-world coordinates or length calculations.
 */
export const CONDUCTOR_VISUAL_LANE_OFFSET_PX: Record<WireCategory, number> = {
  phase: -2.8,
  neutral: 0,
  earth: 2.8,
  control: -5.2,
  communication: 5.2,
};

/**
 * Offsets an SVG-space polyline perpendicularly by `offsetPx` with clean corner miters.
 * Used purely for 2D visual separation of parallel L / N / E conductors.
 */
export function offsetPolylinePerpendicular(
  pts: { x: number; y: number }[],
  offsetPx: number
): { x: number; y: number }[] {
  if (Math.abs(offsetPx) < 0.01 || pts.length < 2) {
    return pts;
  }

  // Deduplicate consecutive identical points
  const clean: { x: number; y: number }[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = clean[clean.length - 1];
    if (Math.hypot(pts[i].x - prev.x, pts[i].y - prev.y) > 0.05) {
      clean.push(pts[i]);
    }
  }
  if (clean.length < 2) return pts;

  const segNormals: { nx: number; ny: number }[] = [];
  for (let i = 0; i < clean.length - 1; i++) {
    const dx = clean[i + 1].x - clean[i].x;
    const dy = clean[i + 1].y - clean[i].y;
    const len = Math.hypot(dx, dy) || 1;
    segNormals.push({ nx: -dy / len, ny: dx / len });
  }

  return clean.map((pt, idx) => {
    if (idx === 0) {
      return {
        x: pt.x + segNormals[0].nx * offsetPx,
        y: pt.y + segNormals[0].ny * offsetPx,
      };
    }
    if (idx === clean.length - 1) {
      const last = segNormals[segNormals.length - 1];
      return {
        x: pt.x + last.nx * offsetPx,
        y: pt.y + last.ny * offsetPx,
      };
    }
    const n1 = segNormals[idx - 1];
    const n2 = segNormals[idx];
    const bx = n1.nx + n2.nx;
    const by = n1.ny + n2.ny;
    const bLen = Math.hypot(bx, by);
    if (bLen < 0.05) {
      return {
        x: pt.x + n1.nx * offsetPx,
        y: pt.y + n1.ny * offsetPx,
      };
    }
    const ux = bx / bLen;
    const uy = by / bLen;
    const dot = Math.max(0.45, ux * n1.nx + uy * n1.ny);
    const miterScale = Math.min(1.8, 1 / dot);
    return {
      x: pt.x + ux * offsetPx * miterScale,
      y: pt.y + uy * offsetPx * miterScale,
    };
  });
}
