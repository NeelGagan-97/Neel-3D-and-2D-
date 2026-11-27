import type { PdfVectorExtractionResult, PdfVectorSegment } from '../types/aiDrawing';

export interface RasterBufferInput {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA 4 bytes per pixel
}

interface RawRasterRun {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thicknessPx: number;
  isAngled: boolean;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Computes an adaptive Otsu-inspired dark-ink luminance threshold for scanned drawings
 * (handles off-white scans, blueprint backgrounds, and faded architectural linework).
 */
function computeAdaptiveDarkThreshold(gray: Uint8Array): { threshold: number; invert: boolean } {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 1) {
    hist[gray[i]] += 1;
  }

  let sum = 0;
  for (let t = 0; t < 256; t += 1) sum += t * hist[t];
  const total = gray.length || 1;
  const meanLum = sum / total;

  // Classic blueprint (dark background with bright white lines) vs normal paper (white background with dark lines)
  const invert = meanLum < 110;

  // Otsu variance maximization
  let wB = 0;
  let sumB = 0;
  let maxVar = -1;
  let bestT = 160;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      bestT = t;
    }
  }

  // Bias slightly toward crisp dark ink to avoid paper-grain noise
  const threshold = invert
    ? Math.max(110, Math.min(220, bestT))
    : Math.max(70, Math.min(210, Math.round(bestT * 0.92)));
  return { threshold, invert };
}

/**
 * Pure TypeScript computer-vision line & wall extractor for scanned PDFs and raster PNG/JPG drawings.
 *
 * Pipeline:
 * 1. Downscale/normalize luminance buffer & adaptive Otsu binarization (auto-detects blueprints vs white paper).
 * 2. Directional run-length extraction along Horizontal (0°), Vertical (90°), and Diagonal (+45° / -45°) axes
 *    with small gap bridging for broken scans or door ticks.
 * 3. Thick-band consolidation: adjacent parallel pixel runs belonging to the same wall thickness collapse
 *    into a single wall centerline segment with measured stroke thickness.
 * 4. Sheet-frame filtering & external/internal classification.
 *
 * Never fabricates geometry: only emits segments backed by contiguous dark ink pixels in the source image.
 */
export function detectRasterWallsFromBuffer(
  input: RasterBufferInput,
  sourceKind: 'scanned-pdf' | 'raster-image' = 'raster-image',
  pageNumber = 1
): PdfVectorExtractionResult {
  const { width, height, data } = input;
  if (width < 32 || height < 32 || data.length < width * height * 4) {
    return {
      sourceKind,
      pageNumber,
      pageWidthPt: Math.max(1, width),
      pageHeightPt: Math.max(1, height),
      rawSegmentCount: 0,
      wallSegments: [],
      curvedSegmentCount: 0,
      angledSegmentCount: 0,
      textItems: [],
      dimensions: [],
      legendEntries: [],
      titleBlock: {},
      warnings: ['Raster image dimensions are too small for automated wall tracing.'],
    };
  }

  // Work on a crisp analysis grid up to 720px on the longest side for fast, deterministic CV processing
  const maxWorkDim = 720;
  const scale = Math.min(1, maxWorkDim / Math.max(width, height));
  const w = Math.max(32, Math.round(width * scale));
  const h = Math.max(32, Math.round(height * scale));

  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const idx = (sy * width + sx) * 4;
      gray[y * w + x] = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
    }
  }

  const { threshold, invert } = computeAdaptiveDarkThreshold(gray);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i += 1) {
    mask[i] = invert ? (gray[i] >= threshold ? 1 : 0) : gray[i] <= threshold ? 1 : 0;
  }

  const minRunPx = Math.max(14, Math.round(Math.min(w, h) * 0.045));
  const maxGapPx = 2;

  // 1. Extract Horizontal runs & consolidate adjacent rows into wall centerlines
  const hRuns: Array<{ y: number; x1: number; x2: number }> = [];
  for (let y = 1; y < h - 1; y += 1) {
    let x = 0;
    while (x < w) {
      if (!mask[y * w + x]) {
        x += 1;
        continue;
      }
      const start = x;
      let lastOn = x;
      let gap = 0;
      while (x < w && gap <= maxGapPx) {
        if (mask[y * w + x]) {
          lastOn = x;
          gap = 0;
        } else {
          gap += 1;
        }
        x += 1;
      }
      if (lastOn - start + 1 >= minRunPx) {
        hRuns.push({ y, x1: start, x2: lastOn });
      }
    }
  }

  // Group horizontally overlapping runs across adjacent rows (thickness <= 14px)
  const hUsed = new Uint8Array(hRuns.length);
  const rawSegments: RawRasterRun[] = [];
  for (let i = 0; i < hRuns.length; i += 1) {
    if (hUsed[i]) continue;
    hUsed[i] = 1;
    let minY = hRuns[i].y;
    let maxY = hRuns[i].y;
    let minX = hRuns[i].x1;
    let maxX = hRuns[i].x2;
    let sumY = hRuns[i].y;
    let count = 1;

    for (let j = i + 1; j < hRuns.length; j += 1) {
      if (hUsed[j]) continue;
      const cand = hRuns[j];
      if (cand.y - maxY > 3) break;
      const overlap = Math.min(maxX, cand.x2) - Math.max(minX, cand.x1);
      const minLen = Math.min(maxX - minX, cand.x2 - cand.x1);
      if (overlap >= Math.max(8, minLen * 0.65) && cand.y - minY <= 14) {
        hUsed[j] = 1;
        maxY = Math.max(maxY, cand.y);
        minX = Math.min(minX, cand.x1);
        maxX = Math.max(maxX, cand.x2);
        sumY += cand.y;
        count += 1;
      }
    }

    const thickness = maxY - minY + 1;
    // Skip huge solid filled blocks (> 14px thick)
    if (thickness <= 14 && maxX - minX >= minRunPx) {
      const cy = sumY / count;
      rawSegments.push({ x1: minX, y1: cy, x2: maxX, y2: cy, thicknessPx: thickness, isAngled: false });
    }
  }

  // 2. Extract Vertical runs & consolidate adjacent columns into wall centerlines
  const vRuns: Array<{ x: number; y1: number; y2: number }> = [];
  for (let x = 1; x < w - 1; x += 1) {
    let y = 0;
    while (y < h) {
      if (!mask[y * w + x]) {
        y += 1;
        continue;
      }
      const start = y;
      let lastOn = y;
      let gap = 0;
      while (y < h && gap <= maxGapPx) {
        if (mask[y * w + x]) {
          lastOn = y;
          gap = 0;
        } else {
          gap += 1;
        }
        y += 1;
      }
      if (lastOn - start + 1 >= minRunPx) {
        vRuns.push({ x, y1: start, y2: lastOn });
      }
    }
  }

  const vUsed = new Uint8Array(vRuns.length);
  for (let i = 0; i < vRuns.length; i += 1) {
    if (vUsed[i]) continue;
    vUsed[i] = 1;
    let minX = vRuns[i].x;
    let maxX = vRuns[i].x;
    let minY = vRuns[i].y1;
    let maxY = vRuns[i].y2;
    let sumX = vRuns[i].x;
    let count = 1;

    for (let j = i + 1; j < vRuns.length; j += 1) {
      if (vUsed[j]) continue;
      const cand = vRuns[j];
      if (cand.x - maxX > 3) break;
      const overlap = Math.min(maxY, cand.y2) - Math.max(minY, cand.y1);
      const minLen = Math.min(maxY - minY, cand.y2 - cand.y1);
      if (overlap >= Math.max(8, minLen * 0.65) && cand.x - minX <= 14) {
        vUsed[j] = 1;
        maxX = Math.max(maxX, cand.x);
        minY = Math.min(minY, cand.y1);
        maxY = Math.max(maxY, cand.y2);
        sumX += cand.x;
        count += 1;
      }
    }

    const thickness = maxX - minX + 1;
    if (thickness <= 14 && maxY - minY >= minRunPx) {
      const cx = sumX / count;
      rawSegments.push({ x1: cx, y1: minY, x2: cx, y2: maxY, thicknessPx: thickness, isAngled: false });
    }
  }

  // 3. Extract 45° / 135° Diagonal runs (chamfered corners and angled walls on scanned plans)
  const minDiagRun = Math.max(12, Math.round(minRunPx * 0.72));
  const scanDiag = (dirX: 1 | -1) => {
    const diagRuns: Array<{ dKey: number; x1: number; y1: number; x2: number; y2: number }> = [];
    const startMin = dirX === 1 ? -(h - 1) : 0;
    const startMax = dirX === 1 ? w - 1 : w + h - 2;

    for (let dKey = startMin; dKey <= startMax; dKey += 1) {
      let x = dirX === 1 ? Math.max(0, dKey) : Math.min(w - 1, dKey);
      let y = dirX === 1 ? Math.max(0, -dKey) : Math.max(0, dKey - (w - 1));
      while (x >= 0 && x < w && y >= 0 && y < h) {
        if (!mask[y * w + x]) {
          x += dirX;
          y += 1;
          continue;
        }
        const sx = x;
        const sy = y;
        let lx = x;
        let ly = y;
        let steps = 0;
        let gap = 0;
        while (x >= 0 && x < w && y >= 0 && y < h && gap <= 2) {
          if (mask[y * w + x]) {
            lx = x;
            ly = y;
            gap = 0;
          } else {
            gap += 1;
          }
          x += dirX;
          y += 1;
          steps += 1;
        }
        const runLen = Math.hypot(lx - sx, ly - sy);
        if (runLen >= minDiagRun && steps >= minDiagRun * 0.65) {
          // Verify pixel isn't just crossing a horizontal or vertical solid bar
          const midX = Math.round((sx + lx) / 2);
          const midY = Math.round((sy + ly) / 2);
          const isH = midX > 2 && midX < w - 3 && mask[midY * w + (midX - 3)] && mask[midY * w + (midX + 3)];
          const isV = midY > 2 && midY < h - 3 && mask[(midY - 3) * w + midX] && mask[(midY + 3) * w + midX];
          if (!(isH && isV)) {
            diagRuns.push({ dKey, x1: sx, y1: sy, x2: lx, y2: ly });
          }
        }
      }
    }

    const usedD = new Uint8Array(diagRuns.length);
    for (let i = 0; i < diagRuns.length; i += 1) {
      if (usedD[i]) continue;
      usedD[i] = 1;
      let sumX1 = diagRuns[i].x1;
      let sumY1 = diagRuns[i].y1;
      let sumX2 = diagRuns[i].x2;
      let sumY2 = diagRuns[i].y2;
      let maxKey = diagRuns[i].dKey;
      const minKey = diagRuns[i].dKey;
      let count = 1;

      for (let j = i + 1; j < diagRuns.length; j += 1) {
        if (usedD[j]) continue;
        const c = diagRuns[j];
        if (c.dKey - maxKey > 3) break;
        if (Math.abs(c.y1 - diagRuns[i].y1) < 12 && Math.abs(c.y2 - diagRuns[i].y2) < 12 && c.dKey - minKey <= 10) {
          usedD[j] = 1;
          sumX1 += c.x1;
          sumY1 += c.y1;
          sumX2 += c.x2;
          sumY2 += c.y2;
          maxKey = c.dKey;
          count += 1;
        }
      }
      rawSegments.push({
        x1: sumX1 / count,
        y1: sumY1 / count,
        x2: sumX2 / count,
        y2: sumY2 / count,
        thicknessPx: Math.max(1, maxKey - minKey + 1),
        isAngled: true,
      });
    }
  };
  scanDiag(1);
  scanDiag(-1);

  // Convert pixel runs to normalized [0, 1] CAD segments, filtering outer border frames
  const normalized: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    strokeWidthPt: number;
    isAngled: boolean;
  }> = [];
  for (const r of rawSegments) {
    const x1 = round4(clamp01(r.x1 / w));
    const y1 = round4(clamp01(r.y1 / h));
    const x2 = round4(clamp01(r.x2 / w));
    const y2 = round4(clamp01(r.y2 / h));
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 0.03) continue;
    const isOuterBorder =
      len > 0.88 &&
      ((y1 < 0.025 && y2 < 0.025) ||
        (y1 > 0.975 && y2 > 0.975) ||
        (x1 < 0.025 && x2 < 0.025) ||
        (x1 > 0.975 && x2 > 0.975));
    if (isOuterBorder) continue;
    normalized.push({
      x1,
      y1,
      x2,
      y2,
      strokeWidthPt: Math.round(r.thicknessPx * 10) / 10,
      isAngled: r.isAngled,
    });
  }

  // Classify external vs internal using envelope + stroke thickness
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const s of normalized) {
    minX = Math.min(minX, s.x1, s.x2);
    maxX = Math.max(maxX, s.x1, s.x2);
    minY = Math.min(minY, s.y1, s.y2);
    maxY = Math.max(maxY, s.y1, s.y2);
  }
  const spanX = Math.max(0.05, maxX - minX);
  const spanY = Math.max(0.05, maxY - minY);
  const tolX = spanX * 0.045;
  const tolY = spanY * 0.045;

  const wallSegments: PdfVectorSegment[] = normalized.slice(0, 180).map((s) => {
    const onEnvelope =
      (Math.abs(s.x1 - minX) < tolX && Math.abs(s.x2 - minX) < tolX) ||
      (Math.abs(s.x1 - maxX) < tolX && Math.abs(s.x2 - maxX) < tolX) ||
      (Math.abs(s.y1 - minY) < tolY && Math.abs(s.y2 - minY) < tolY) ||
      (Math.abs(s.y1 - maxY) < tolY && Math.abs(s.y2 - maxY) < tolY);
    return {
      x1: s.x1,
      y1: s.y1,
      x2: s.x2,
      y2: s.y2,
      strokeWidthPt: s.strokeWidthPt,
      wallKind: onEnvelope ? 'external' : 'internal',
      isCurvedSegment: false,
      isAngled: s.isAngled,
    };
  });

  const angledSegmentCount = wallSegments.filter((s) => s.isAngled).length;

  return {
    sourceKind,
    pageNumber,
    pageWidthPt: width,
    pageHeightPt: height,
    rawSegmentCount: rawSegments.length,
    wallSegments,
    curvedSegmentCount: 0,
    angledSegmentCount,
    textItems: [],
    dimensions: [],
    legendEntries: [],
    titleBlock: {},
    warnings:
      wallSegments.length > 0
        ? [
            `Computer-vision line pass traced ${wallSegments.length} candidate wall segment(s) from the raster image. Run Hybrid Vision AI + OCR for room polygons, openings, text labels, and symbol recognition.`,
          ]
        : [
            'No clear high-contrast wall lines found in the raster image. Adjust brightness/contrast or run Vision AI analysis.',
          ],
  };
}

/**
 * Browser helper: loads a prepared PNG/JPEG data URL into an offscreen HTMLCanvasElement
 * and runs detectRasterWallsFromBuffer().
 */
export async function detectRasterWallsFromDataUrl(
  imageDataUrl: string,
  sourceKind: 'scanned-pdf' | 'raster-image' = 'raster-image',
  pageNumber = 1
): Promise<PdfVectorExtractionResult> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    throw new Error('detectRasterWallsFromDataUrl requires a browser DOM canvas context.');
  }

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Could not decode drawing image for CV line analysis.'));
    el.src = imageDataUrl;
  });

  const maxDim = 960;
  const ratio = Math.min(1, maxDim / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const w = Math.max(32, Math.round((img.naturalWidth || 1) * ratio));
  const h = Math.max(32, Math.round((img.naturalHeight || 1) * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not acquire 2D canvas context for raster CV wall detection.');
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);

  return detectRasterWallsFromBuffer(
    { width: w, height: h, data: imageData.data },
    sourceKind,
    pageNumber
  );
}
