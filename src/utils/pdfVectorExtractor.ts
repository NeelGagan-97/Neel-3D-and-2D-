import type {
  AiDrawingVectorContext,
  DrawingMeasurementUnit,
  DrawingTitleBlockInfo,
  NormalizedPoint,
  NormalizedRect,
  PdfExcludedZone,
  PdfExtractedColumn,
  PdfExtractedDimension,
  PdfExtractedTextItem,
  PdfVectorExtractionResult,
  PdfVectorSegment,
} from '../types/aiDrawing';

type Matrix2D = [number, number, number, number, number, number];

export interface PdfVectorTransformOptions {
  rotationDeg?: 0 | 90 | 180 | 270;
  cropRect?: NormalizedRect | null;
  defaultUnit?: DrawingMeasurementUnit;
}

const IDENTITY_MATRIX: Matrix2D = [1, 0, 0, 1, 0, 0];

function multiplyMatrix(m1: Matrix2D, m2: Matrix2D): Matrix2D {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function applyMatrix(m: Matrix2D, x: number, y: number): { x: number; y: number } {
  return {
    x: m[0] * x + m[2] * y + m[4],
    y: m[1] * x + m[3] * y + m[5],
  };
}

function matrixScale(m: Matrix2D): number {
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  return (sx + sy) / 2 || 1;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Applies the same rotation + optional crop transform that pdfImageRenderer applies to the raster image,
 * guaranteeing 1:1 normalized coordinate alignment between vector geometry, PDF text, and image underlay.
 */
export function transformNormalizedPoint(
  pt: NormalizedPoint,
  rotationDeg: 0 | 90 | 180 | 270 = 0,
  cropRect: NormalizedRect | null = null
): NormalizedPoint {
  let rx = pt.x;
  let ry = pt.y;
  if (rotationDeg === 90) {
    rx = 1 - pt.y;
    ry = pt.x;
  } else if (rotationDeg === 180) {
    rx = 1 - pt.x;
    ry = 1 - pt.y;
  } else if (rotationDeg === 270) {
    rx = pt.y;
    ry = 1 - pt.x;
  }
  if (cropRect && cropRect.width > 0.02 && cropRect.height > 0.02) {
    rx = (rx - cropRect.x) / cropRect.width;
    ry = (ry - cropRect.y) / cropRect.height;
  }
  return { x: rx, y: ry };
}

/**
 * Clips a segment against the unit square [0, 1] x [0, 1] using Liang-Barsky so cropped views
 * preserve exact wall intersections with the crop boundary.
 */
function clipSegmentToUnitSquare(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): { x1: number; y1: number; x2: number; y2: number } | null {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const checks: Array<[number, number]> = [
    [-dx, x1],
    [dx, 1 - x1],
    [-dy, y1],
    [dy, 1 - y1],
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-10) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  if (t1 <= t0) return null;
  return {
    x1: clamp01(x1 + t0 * dx),
    y1: clamp01(y1 + t0 * dy),
    x2: clamp01(x1 + t1 * dx),
    y2: clamp01(y1 + t1 * dy),
  };
}

/**
 * Parses architectural / CAD dimension strings into meters.
 * Supports:
 * - Imperial feet-inches: 12'-6", 20'-0", 14' 6", 20 ft, 13'
 * - Metric meters: 4.50 m, 3.6m, 12.40M
 * - Metric millimeters: 4500 mm, 6000mm, or bare 4-digit CAD integers like 4500 when unit is mm
 * - Metric centimeters: 450 cm
 */
export function parseDimensionTextToMeters(
  rawText: string,
  defaultUnit: DrawingMeasurementUnit = 'm'
): { meters: number; unit: DrawingMeasurementUnit } | null {
  const text = rawText.trim().replace(/,/g, '').replace(/[“”″]/g, '"').replace(/[‘’′]/g, "'");
  if (!text || text.length > 32) return null;

  // 1. Feet + inches (e.g. 12'-6", 20' 6.5", 14'-0")
  const ftInMatch = text.match(/^(\d+(?:\.\d+)?)\s*'\s*[- ]?\s*(\d+(?:\.\d+)?)\s*"?$/);
  if (ftInMatch) {
    const ft = Number(ftInMatch[1]);
    const inches = Number(ftInMatch[2]);
    if (Number.isFinite(ft) && Number.isFinite(inches) && inches < 12.5) {
      const meters = (ft + inches / 12) * 0.3048;
      if (meters >= 0.15 && meters <= 250) return { meters: round4(meters), unit: 'ft' };
    }
  }

  // 2. Feet only (e.g. 20', 13.5 ft, 20 FT)
  const ftOnly = text.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft\.?|feet)$/i);
  if (ftOnly) {
    const ft = Number(ftOnly[1]);
    if (Number.isFinite(ft) && ft >= 0.5 && ft <= 800) {
      return { meters: round4(ft * 0.3048), unit: 'ft' };
    }
  }

  // 3. Explicit millimeters (e.g. 4500 mm, 1200mm)
  const mmMatch = text.match(/^(\d+(?:\.\d+)?)\s*mm$/i);
  if (mmMatch) {
    const mm = Number(mmMatch[1]);
    if (Number.isFinite(mm) && mm >= 150 && mm <= 250000) {
      return { meters: round4(mm / 1000), unit: 'mm' };
    }
  }

  // 4. Explicit centimeters (e.g. 450 cm)
  const cmMatch = text.match(/^(\d+(?:\.\d+)?)\s*cm$/i);
  if (cmMatch) {
    const cm = Number(cmMatch[1]);
    if (Number.isFinite(cm) && cm >= 15 && cm <= 25000) {
      return { meters: round4(cm / 100), unit: 'cm' };
    }
  }

  // 5. Explicit meters (e.g. 4.50 m, 12.0m)
  const mMatch = text.match(/^(\d+(?:\.\d+)?)\s*m(?:tr|eters?)?$/i);
  if (mMatch) {
    const m = Number(mMatch[1]);
    if (Number.isFinite(m) && m >= 0.2 && m <= 250) {
      return { meters: round4(m), unit: 'm' };
    }
  }

  // 6. Explicit inches (e.g. 36", 48 in)
  const inMatch = text.match(/^(\d+(?:\.\d+)?)\s*(?:"|in\.?|inch(?:es)?)$/i);
  if (inMatch) {
    const inches = Number(inMatch[1]);
    if (Number.isFinite(inches) && inches >= 6 && inches <= 5000) {
      return { meters: round4(inches * 0.0254), unit: 'in' };
    }
  }

  // 7. Bare CAD numeric dimension (common on architectural PDFs in mm like "4500", "12600", or meters "4.50")
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const val = Number(text);
    if (!Number.isFinite(val)) return null;
    if (defaultUnit === 'mm' && val >= 300 && val <= 150000 && Number.isInteger(val)) {
      return { meters: round4(val / 1000), unit: 'mm' };
    }
    if (defaultUnit === 'cm' && val >= 30 && val <= 15000) {
      return { meters: round4(val / 100), unit: 'cm' };
    }
    if (defaultUnit === 'm' && text.includes('.') && val >= 0.4 && val <= 120) {
      return { meters: round4(val), unit: 'm' };
    }
    if (defaultUnit === 'ft' && val >= 2 && val <= 400 && text.includes('.')) {
      return { meters: round4(val * 0.3048), unit: 'ft' };
    }
    // Even if default unit is m, a 4-5 digit architectural integer like 4500 or 12000 (not a year 1990..2035) is almost always mm
    if (Number.isInteger(val) && val >= 600 && val <= 80000 && (val < 1980 || val > 2040) && val % 50 === 0) {
      return { meters: round4(val / 1000), unit: 'mm' };
    }
  }

  return null;
}

const ROOM_NAME_REGEX =
  /\b(office|conference|meeting|board\s*room|reception|lobby|foyer|corridor|hallway|passage|hall|living|dining|kitchen|pantry|break\s*room|server|it\s*room|electrical\s*room|db\s*room|panel\s*room|store|storage|utility|toilet|restroom|washroom|wc|bath|bedroom|master|guest|study|cabin|director|manager|workstation|open\s*plan|atrium|balcony|terrace|stair|lift|elevator|shaft|lab|clinic|classroom|showroom|warehouse|retail|shop|studio|zone|bay)\b/i;

const TITLE_BLOCK_REGEX =
  /\b(scale|dwg\s*no|drawing\s*no|rev(?:ision)?|sheet|drawn\s*by|checked\s*by|approved|project\s*:|client\s*:|date\s*:|north|issued\s*for|lighting\s*layout|electrical\s*layout|floor\s*plan)\b/i;

const LEGEND_ENTRY_REGEX = /^([A-Z]{1,4}[-/]?\d{0,3}[A-Z]?)\s*[:–—-]\s*(.{3,80})$/;

interface RawSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeWidthPt: number;
  isCurvedSegment: boolean;
  curveGroupId?: string;
}

/**
 * Tessellates a cubic Bézier curve into chords so curved walls & arcs remain geometrically faithful.
 */
function tessellateCubicBezier(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  curveGroupId: string,
  strokeWidthPt: number
): RawSegment[] {
  const controlPolyLen =
    Math.hypot(x1 - x0, y1 - y0) +
    Math.hypot(x2 - x1, y2 - y1) +
    Math.hypot(x3 - x2, y3 - y2);
  const chordLen = Math.hypot(x3 - x0, y3 - y0);
  const curvature = Math.max(0, controlPolyLen - chordLen);
  if (controlPolyLen < 1e-4) return [];

  // Straight-looking cubic Bézier -> single straight segment
  if (curvature < Math.max(0.0004, chordLen * 0.008)) {
    return [
      {
        x1: x0,
        y1: y0,
        x2: x3,
        y2: y3,
        strokeWidthPt,
        isCurvedSegment: false,
      },
    ];
  }

  const steps = Math.max(6, Math.min(18, Math.ceil(controlPolyLen * 90)));
  const out: RawSegment[] = [];
  let px = x0;
  let py = y0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const nx =
      mt * mt * mt * x0 +
      3 * mt * mt * t * x1 +
      3 * mt * t * t * x2 +
      t * t * t * x3;
    const ny =
      mt * mt * mt * y0 +
      3 * mt * mt * t * y1 +
      3 * mt * t * t * y2 +
      t * t * t * y3;
    out.push({
      x1: px,
      y1: py,
      x2: nx,
      y2: ny,
      strokeWidthPt,
      isCurvedSegment: true,
      curveGroupId,
    });
    px = nx;
    py = ny;
  }
  return out;
}

function tessellateQuadraticBezier(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x2: number,
  y2: number,
  curveGroupId: string,
  strokeWidthPt: number
): RawSegment[] {
  // Elevate quadratic to cubic exact representation
  const cp1x = x0 + (2 / 3) * (cx - x0);
  const cp1y = y0 + (2 / 3) * (cy - y0);
  const cp2x = x2 + (2 / 3) * (cx - x2);
  const cp2y = y2 + (2 / 3) * (cy - y2);
  return tessellateCubicBezier(x0, y0, cp1x, cp1y, cp2x, cp2y, x2, y2, curveGroupId, strokeWidthPt);
}

function isSegmentAngled(x1: number, y1: number, x2: number, y2: number): boolean {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  if (Math.hypot(dx, dy) < 1e-5) return false;
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  // Not within 3° of horizontal (0°) or vertical (90°)
  return angleDeg > 3 && angleDeg < 87;
}

/**
 * Checks whether a segment is purely an outer drafting sheet frame / border rectangle
 * sitting along the extreme edge of the page.
 */
function isSheetBorderSegment(seg: RawSegment): boolean {
  const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
  if (len < 0.85) return false;
  const nearTop = seg.y1 < 0.025 && seg.y2 < 0.025;
  const nearBottom = seg.y1 > 0.975 && seg.y2 > 0.975;
  const nearLeft = seg.x1 < 0.025 && seg.x2 < 0.025;
  const nearRight = seg.x1 > 0.975 && seg.x2 > 0.975;
  return nearTop || nearBottom || nearLeft || nearRight;
}

function pointInRect(x: number, y: number, r: NormalizedRect): boolean {
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

/**
 * Automatically detects peripheral Legend / Symbol Schedule and Title-Block boxes from
 * clustered PDF text items so legend table borders and symbol icons NEVER contaminate architectural walls.
 */
function detectExclusionZones(textItems: PdfExtractedTextItem[]): PdfExcludedZone[] {
  const zones: PdfExcludedZone[] = [];

  const buildPeripheralZone = (
    items: PdfExtractedTextItem[],
    kind: 'legend' | 'title-block',
    padLeft: number,
    padOther: number,
    maxArea: number
  ) => {
    if (items.length < 2) return;
    let minX = 1;
    let maxX = 0;
    let minY = 1;
    let maxY = 0;
    for (const t of items) {
      minX = Math.min(minX, t.x - t.widthNorm / 2);
      maxX = Math.max(maxX, t.x + t.widthNorm / 2);
      minY = Math.min(minY, t.y - t.heightNorm / 2);
      maxY = Math.max(maxY, t.y + t.heightNorm / 2);
    }
    const isRight = minX >= 0.68;
    const isLeft = maxX <= 0.28;
    const isBottom = minY >= 0.74;
    const isTop = maxY <= 0.22;
    if (!isRight && !isLeft && !isBottom && !isTop) return;

    const rx = isLeft ? 0 : clamp01(minX - padLeft);
    const rx2 = isRight || (isBottom && minX >= 0.55) ? 1 : clamp01(maxX + padOther);
    const ry = isTop ? 0 : clamp01(minY - padOther);
    const ry2 = isBottom ? 1 : clamp01(maxY + padOther);
    const w = rx2 - rx;
    const h = ry2 - ry;
    if (w > 0.02 && h > 0.02 && w * h <= maxArea) {
      zones.push({ kind, rect: { x: round4(rx), y: round4(ry), width: round4(w), height: round4(h) } });
    }
  };

  const legendItems = textItems.filter(
    (t) =>
      t.kind === 'legend-text' ||
      /^(?:lighting\s+)?(?:electrical\s+)?legend|symbol\s+schedule|fixture\s+schedule$/i.test(t.text)
  );
  buildPeripheralZone(legendItems, 'legend', 0.022, 0.048, 0.36);

  const titleItems = textItems.filter((t) => t.kind === 'title-block');
  buildPeripheralZone(titleItems, 'title-block', 0.025, 0.045, 0.28);

  return zones;
}

/**
 * Extracts small closed axis-aligned rectangular structural columns (e.g. 300x300mm - 800x800mm)
 * directly from vector strokes so columns are modeled as structural columns instead of tiny walls.
 */
function extractVectorColumnsFromSegments(segments: RawSegment[]): {
  columns: PdfExtractedColumn[];
  remainingSegments: RawSegment[];
} {
  const shortHoriz: Array<{ idx: number; s: RawSegment; len: number }> = [];
  const shortVert: Array<{ idx: number; s: RawSegment; len: number }> = [];

  segments.forEach((s, idx) => {
    if (s.isCurvedSegment) return;
    const dx = Math.abs(s.x2 - s.x1);
    const dy = Math.abs(s.y2 - s.y1);
    const len = Math.hypot(dx, dy);
    if (len < 0.008 || len > 0.042) return;
    if (dy <= 0.0025 && dx >= 0.008) shortHoriz.push({ idx, s, len });
    else if (dx <= 0.0025 && dy >= 0.008) shortVert.push({ idx, s, len });
  });

  const consumed = new Set<number>();
  const columns: PdfExtractedColumn[] = [];
  const tol = 0.004;

  for (let i = 0; i < shortHoriz.length; i += 1) {
    const top = shortHoriz[i];
    if (consumed.has(top.idx)) continue;
    const xMin = Math.min(top.s.x1, top.s.x2);
    const xMax = Math.max(top.s.x1, top.s.x2);
    const yTop = (top.s.y1 + top.s.y2) / 2;

    const bot = shortHoriz.find((h) => {
      if (h.idx === top.idx || consumed.has(h.idx)) return false;
      const hxMin = Math.min(h.s.x1, h.s.x2);
      const hxMax = Math.max(h.s.x1, h.s.x2);
      const hy = (h.s.y1 + h.s.y2) / 2;
      const dh = hy - yTop;
      return (
        dh >= 0.008 &&
        dh <= 0.042 &&
        Math.abs(hxMin - xMin) <= tol &&
        Math.abs(hxMax - xMax) <= tol
      );
    });
    if (!bot) continue;
    const yBot = (bot.s.y1 + bot.s.y2) / 2;

    const left = shortVert.find((v) => {
      if (consumed.has(v.idx)) return false;
      const vx = (v.s.x1 + v.s.x2) / 2;
      const vyMin = Math.min(v.s.y1, v.s.y2);
      const vyMax = Math.max(v.s.y1, v.s.y2);
      return (
        Math.abs(vx - xMin) <= tol &&
        Math.abs(vyMin - yTop) <= tol &&
        Math.abs(vyMax - yBot) <= tol
      );
    });
    const right = shortVert.find((v) => {
      if (consumed.has(v.idx)) return false;
      const vx = (v.s.x1 + v.s.x2) / 2;
      const vyMin = Math.min(v.s.y1, v.s.y2);
      const vyMax = Math.max(v.s.y1, v.s.y2);
      return (
        Math.abs(vx - xMax) <= tol &&
        Math.abs(vyMin - yTop) <= tol &&
        Math.abs(vyMax - yBot) <= tol
      );
    });

    if (left && right) {
      const w = xMax - xMin;
      const h = yBot - yTop;
      const aspect = Math.max(w, h) / Math.max(1e-4, Math.min(w, h));
      if (aspect <= 2.4) {
        consumed.add(top.idx);
        consumed.add(bot.idx);
        consumed.add(left.idx);
        consumed.add(right.idx);
        columns.push({
          label: `C${columns.length + 1}`,
          x: round4((xMin + xMax) / 2),
          y: round4((yTop + yBot) / 2),
          widthNorm: round4(w),
          heightNorm: round4(h),
        });
      }
    }
  }

  return {
    columns,
    remainingSegments: segments.filter((_, idx) => !consumed.has(idx)),
  };
}

/**
 * Deduplicates exact/near-duplicate strokes (e.g., double-pass CAD exports), strips legend/title-block
 * contamination and vector column loops, and merges collinear touching straight segments without
 * altering angled or curved geometry.
 */
function cleanAndMergeVectorSegments(
  raw: RawSegment[],
  excludedZones: PdfExcludedZone[] = []
): { wallSegments: PdfVectorSegment[]; columns: PdfExtractedColumn[]; filteredNoiseCount: number } {
  let filteredNoiseCount = 0;

  // 1. Filter microscopic ticks, extreme outer sheet borders, and legend/title-block table/icon strokes
  const filtered = raw.filter((s) => {
    const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    if (s.isCurvedSegment) {
      if (len < 0.0018) {
        filteredNoiseCount += 1;
        return false;
      }
    } else {
      if (len < 0.004) {
        filteredNoiseCount += 1;
        return false;
      }
      if (isSheetBorderSegment(s)) {
        filteredNoiseCount += 1;
        return false;
      }
    }

    if (excludedZones.length > 0) {
      const mx = (s.x1 + s.x2) / 2;
      const my = (s.y1 + s.y2) / 2;
      const insideExcluded = excludedZones.some(
        (z) =>
          (pointInRect(s.x1, s.y1, z.rect) && pointInRect(s.x2, s.y2, z.rect)) ||
          (pointInRect(mx, my, z.rect) && len < 0.42)
      );
      if (insideExcluded) {
        filteredNoiseCount += 1;
        return false;
      }
    }
    return true;
  });

  // 2. Canonicalize direction and deduplicate overlapping identical segments
  const deduped: RawSegment[] = [];
  const seenKeys = new Set<string>();
  for (const s of filtered) {
    let { x1, y1, x2, y2 } = s;
    if (x2 < x1 - 1e-5 || (Math.abs(x2 - x1) <= 1e-5 && y2 < y1)) {
      [x1, y1, x2, y2] = [x2, y2, x1, y1];
    }
    const key = `${Math.round(x1 * 400)}:${Math.round(y1 * 400)}:${Math.round(x2 * 400)}:${Math.round(y2 * 400)}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push({ ...s, x1, y1, x2, y2 });
  }

  // 2b. Extract small closed rectangular structural columns before wall merging
  const { columns, remainingSegments } = extractVectorColumnsFromSegments(deduped);

  // 3. Separate curved segments (keep intact!) from straight segments (merge touching collinear runs)
  const curved = remainingSegments.filter((s) => s.isCurvedSegment);
  const straight = remainingSegments.filter((s) => !s.isCurvedSegment);

  const mergedStraight: RawSegment[] = [];
  const used = new Array<boolean>(straight.length).fill(false);

  for (let i = 0; i < straight.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let cur = { ...straight[i] };
    let changed = true;
    while (changed) {
      changed = false;
      const cdx = cur.x2 - cur.x1;
      const cdy = cur.y2 - cur.y1;
      const clen = Math.hypot(cdx, cdy);
      if (clen < 1e-6) break;
      const ux = cdx / clen;
      const uy = cdy / clen;

      for (let j = i + 1; j < straight.length; j++) {
        if (used[j]) continue;
        const cand = straight[j];
        const ddx = cand.x2 - cand.x1;
        const ddy = cand.y2 - cand.y1;
        const dlen = Math.hypot(ddx, ddy);
        if (dlen < 1e-6) continue;
        const dot = Math.abs((ux * ddx + uy * ddy) / dlen);
        if (dot < 0.9994) continue; // > ~2 degrees apart -> do NOT merge

        // Perpendicular distance of cand endpoints to cur line
        const perp1 = Math.abs((cand.x1 - cur.x1) * uy - (cand.y1 - cur.y1) * ux);
        const perp2 = Math.abs((cand.x2 - cur.x1) * uy - (cand.y2 - cur.y1) * ux);
        if (perp1 > 0.0022 || perp2 > 0.0022) continue;

        // Check overlap / touching along line axis
        const p1 = (cand.x1 - cur.x1) * ux + (cand.y1 - cur.y1) * uy;
        const p2 = (cand.x2 - cur.x1) * ux + (cand.y2 - cur.y1) * uy;
        const cMin = Math.min(p1, p2);
        const cMax = Math.max(p1, p2);
        if (cMax < -0.003 || cMin > clen + 0.003) continue;

        const newMin = Math.min(0, cMin);
        const newMax = Math.max(clen, cMax);
        const nx1 = cur.x1 + newMin * ux;
        const ny1 = cur.y1 + newMin * uy;
        const nx2 = cur.x1 + newMax * ux;
        const ny2 = cur.y1 + newMax * uy;
        cur = {
          ...cur,
          x1: nx1,
          y1: ny1,
          x2: nx2,
          y2: ny2,
          strokeWidthPt: Math.max(cur.strokeWidthPt, cand.strokeWidthPt),
        };
        used[j] = true;
        changed = true;
      }
    }
    mergedStraight.push(cur);
  }

  const combined = [...mergedStraight, ...curved];
  if (combined.length === 0) return { wallSegments: [], columns, filteredNoiseCount };

  // 4. Compute median stroke width and building envelope to classify external vs internal walls
  const strokeWidths = combined.map((s) => s.strokeWidthPt).sort((a, b) => a - b);
  const medianStroke = strokeWidths[Math.floor(strokeWidths.length / 2)] || 1;
  const maxStroke = strokeWidths[strokeWidths.length - 1] || 1;

  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const s of combined) {
    minX = Math.min(minX, s.x1, s.x2);
    maxX = Math.max(maxX, s.x1, s.x2);
    minY = Math.min(minY, s.y1, s.y2);
    maxY = Math.max(maxY, s.y1, s.y2);
  }
  const spanX = Math.max(0.05, maxX - minX);
  const spanY = Math.max(0.05, maxY - minY);
  const edgeTolX = spanX * 0.04;
  const edgeTolY = spanY * 0.04;

  const wallSegments: PdfVectorSegment[] = combined.map((s) => {
    const thickStroke = maxStroke > medianStroke * 1.28 && s.strokeWidthPt >= medianStroke * 1.25;
    const onEnvelopeEdge =
      (Math.abs(s.x1 - minX) < edgeTolX && Math.abs(s.x2 - minX) < edgeTolX) ||
      (Math.abs(s.x1 - maxX) < edgeTolX && Math.abs(s.x2 - maxX) < edgeTolX) ||
      (Math.abs(s.y1 - minY) < edgeTolY && Math.abs(s.y2 - minY) < edgeTolY) ||
      (Math.abs(s.y1 - maxY) < edgeTolY && Math.abs(s.y2 - maxY) < edgeTolY);

    const wallKind: 'external' | 'internal' =
      thickStroke || onEnvelopeEdge ? 'external' : 'internal';

    return {
      x1: round4(clamp01(s.x1)),
      y1: round4(clamp01(s.y1)),
      x2: round4(clamp01(s.x2)),
      y2: round4(clamp01(s.y2)),
      strokeWidthPt: Math.round(s.strokeWidthPt * 100) / 100,
      wallKind,
      isCurvedSegment: s.isCurvedSegment,
      curveGroupId: s.curveGroupId,
      isAngled: !s.isCurvedSegment && isSegmentAngled(s.x1, s.y1, s.x2, s.y2),
    };
  });

  return { wallSegments, columns, filteredNoiseCount };
}

/**
 * Merges horizontally adjacent PDF text runs sitting on the same baseline (common in CAD exports)
 * and classifies each resulting text label into room label, dimension, legend entry, title block, or annotation.
 */
function processExtractedTextItems(
  rawItems: Array<{
    str: string;
    x: number;
    y: number;
    widthNorm: number;
    heightNorm: number;
    fontSizePt: number;
  }>,
  defaultUnit: DrawingMeasurementUnit
): {
  textItems: PdfExtractedTextItem[];
  dimensions: PdfExtractedDimension[];
  legendEntries: Array<{ code: string; label: string; description: string }>;
  titleBlock: DrawingTitleBlockInfo;
} {
  const nonEmpty = rawItems
    .map((item) => ({ ...item, str: item.str.replace(/\s+/g, ' ').trim() }))
    .filter((item) => item.str.length > 0 && item.x >= -0.02 && item.x <= 1.02 && item.y >= -0.02 && item.y <= 1.02);

  // Sort by Y band then X to stitch split CAD words
  nonEmpty.sort((a, b) => (Math.abs(a.y - b.y) < 0.008 ? a.x - b.x : a.y - b.y));

  const stitched: typeof nonEmpty = [];
  for (const item of nonEmpty) {
    const prev = stitched[stitched.length - 1];
    if (
      prev &&
      Math.abs(prev.y - item.y) < Math.max(0.008, prev.heightNorm * 0.65) &&
      item.x >= prev.x &&
      item.x - (prev.x + prev.widthNorm) < Math.max(0.018, prev.heightNorm * 1.4) &&
      Math.abs(prev.fontSizePt - item.fontSizePt) < Math.max(2.5, prev.fontSizePt * 0.35)
    ) {
      const gap = item.x - (prev.x + prev.widthNorm);
      prev.str = gap > 0.003 ? `${prev.str} ${item.str}` : `${prev.str}${item.str}`;
      prev.widthNorm = Math.max(prev.widthNorm, item.x + item.widthNorm - prev.x);
      prev.heightNorm = Math.max(prev.heightNorm, item.heightNorm);
    } else {
      stitched.push({ ...item });
    }
  }

  const textItems: PdfExtractedTextItem[] = [];
  const dimensions: PdfExtractedDimension[] = [];
  const legendEntries: Array<{ code: string; label: string; description: string }> = [];
  const seenLegend = new Set<string>();
  const titleBlock: DrawingTitleBlockInfo = {};

  for (const item of stitched) {
    const text = item.str.trim();
    if (!text) continue;
    const cx = round4(clamp01(item.x + item.widthNorm / 2));
    const cy = round4(clamp01(item.y));

    const parsedDim = parseDimensionTextToMeters(text, defaultUnit);
    const legendMatch = text.match(LEGEND_ENTRY_REGEX);

    let kind: PdfExtractedTextItem['kind'] = 'annotation';
    if (parsedDim) {
      kind = 'dimension';
      dimensions.push({
        labelText: text,
        x: cx,
        y: cy,
        parsedMeters: parsedDim.meters,
        unitDetected: parsedDim.unit,
      });
    } else if (TITLE_BLOCK_REGEX.test(text) || (cy > 0.86 && cx > 0.55 && !legendMatch)) {
      kind = 'title-block';
      const scaleMatch = text.match(/scale\s*[:=]?\s*(1\s*:\s*\d+|[^,;]{3,20})/i);
      if (scaleMatch && !titleBlock.scaleText) titleBlock.scaleText = scaleMatch[1].trim();
      const dwgMatch = text.match(/(?:dwg|drawing)\s*(?:no\.?|#)\s*[:=]?\s*([A-Z0-9._/-]{2,24})/i);
      if (dwgMatch && !titleBlock.drawingNumber) titleBlock.drawingNumber = dwgMatch[1].trim();
      const revMatch = text.match(/rev(?:ision)?\s*[:=]?\s*([A-Z0-9.-]{1,10})/i);
      if (revMatch && !titleBlock.revision) titleBlock.revision = revMatch[1].trim();
      const projMatch = text.match(/project\s*[:=]\s*(.{3,60})/i);
      if (projMatch && !titleBlock.projectTitle) titleBlock.projectTitle = projMatch[1].trim();
      if (!titleBlock.drawingTitle && /(lighting|electrical|floor\s*plan|layout)/i.test(text)) {
        titleBlock.drawingTitle = text.slice(0, 80);
      }
    } else if (legendMatch && legendMatch[1].length <= 8) {
      kind = 'legend-text';
      const code = legendMatch[1].trim().toUpperCase();
      const desc = legendMatch[2].trim();
      if (!seenLegend.has(code)) {
        seenLegend.add(code);
        legendEntries.push({
          code,
          label: desc.split(/[,(]/)[0].trim().slice(0, 48) || code,
          description: desc.slice(0, 120),
        });
      }
    } else if (ROOM_NAME_REGEX.test(text) && text.length <= 42) {
      kind = 'room-label';
    }

    // Deduplicate double-struck bold CAD text at the exact same location
    const isDuplicateText = textItems.some(
      (existing) =>
        existing.text.toLowerCase() === text.slice(0, 120).toLowerCase() &&
        Math.hypot(existing.x - cx, existing.y - cy) < 0.012
    );
    if (isDuplicateText) continue;

    textItems.push({
      text: text.slice(0, 120),
      x: cx,
      y: cy,
      widthNorm: round4(clamp01(item.widthNorm)),
      heightNorm: round4(clamp01(item.heightNorm)),
      fontSizePt: Math.round(item.fontSizePt * 10) / 10,
      kind,
      parsedMeters: parsedDim?.meters ?? null,
    });
  }

  return { textItems, dimensions, legendEntries, titleBlock };
}

async function loadPdfJsModule(): Promise<typeof import('pdfjs-dist')> {
  if (typeof window === 'undefined') {
    // Node.js test & SSR runtime
    const legacy = await import('pdfjs-dist/legacy/build/pdf.mjs');
    return legacy as unknown as typeof import('pdfjs-dist');
  }
  const [pdfjsLib, workerUrlMod] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrlMod.default;
  }
  return pdfjsLib;
}

/**
 * Directly extracts vector path geometry (straight, angled, and tessellated curved walls)
 * and exact PDF text annotations from a PDF page via pdfjs-dist operator lists & text content.
 */
export async function extractPdfVectorData(
  source: File | ArrayBuffer | Uint8Array,
  pageNumber = 1,
  options: PdfVectorTransformOptions = {}
): Promise<PdfVectorExtractionResult> {
  const rotationDeg = options.rotationDeg ?? 0;
  const cropRect = options.cropRect ?? null;
  const defaultUnit = options.defaultUnit ?? 'm';

  const bytes =
    source instanceof Uint8Array
      ? source
      : source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(await source.arrayBuffer());

  const pdfjsLib = await loadPdfJsModule();
  const OPS = pdfjsLib.OPS;

  const loadingTask = pdfjsLib.getDocument({
    data: bytes.slice(),
    verbosity: 0,
  });
  const pdf = await loadingTask.promise;

  try {
    const safePage = Math.max(1, Math.min(pdf.numPages, pageNumber));
    const page = await pdf.getPage(safePage);
    const viewport = page.getViewport({ scale: 1 });
    const pageWidthPt = Math.max(1, viewport.width);
    const pageHeightPt = Math.max(1, viewport.height);
    const baseViewportMatrix: Matrix2D = [
      viewport.transform[0],
      viewport.transform[1],
      viewport.transform[2],
      viewport.transform[3],
      viewport.transform[4],
      viewport.transform[5],
    ];

    const opList = await page.getOperatorList();
    const rawSegments: RawSegment[] = [];

    // Graphics state stack
    let ctm: Matrix2D = [...baseViewportMatrix];
    let lineWidthPt = 1;
    const stateStack: Array<{ ctm: Matrix2D; lineWidthPt: number }> = [];
    let curveCounter = 0;

    // Normalize a PDF-user-space point through CTM -> viewport -> [0,1] -> user rotation & crop
    const toNorm = (px: number, py: number): NormalizedPoint => {
      const vp = applyMatrix(ctm, px, py);
      return transformNormalizedPoint(
        { x: vp.x / pageWidthPt, y: vp.y / pageHeightPt },
        rotationDeg,
        cropRect
      );
    };

    const emitLine = (
      ax: number,
      ay: number,
      bx: number,
      by: number,
      strokePt: number,
      isCurved = false,
      curveGroupId?: string
    ) => {
      const clipped = clipSegmentToUnitSquare(ax, ay, bx, by);
      if (!clipped) return;
      rawSegments.push({
        x1: clipped.x1,
        y1: clipped.y1,
        x2: clipped.x2,
        y2: clipped.y2,
        strokeWidthPt: strokePt,
        isCurvedSegment: isCurved,
        curveGroupId,
      });
    };

    // Pending path state for non-constructPath direct drawing ops
    let curX = 0;
    let curY = 0;
    let startX = 0;
    let startY = 0;
    let pendingPath: RawSegment[] = [];

    const STROKE_OR_FILL_OPS = new Set<number>([
      OPS.stroke,
      OPS.closeStroke,
      OPS.fill,
      OPS.eoFill,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke,
    ]);

    const handleConstructPath = (args: unknown[]) => {
      if (!Array.isArray(args) || args.length < 2) return;
      const effStroke = Math.max(0.25, lineWidthPt * (matrixScale(ctm) / matrixScale(baseViewportMatrix)));

      // pdfjs-dist v5/v6 format: [paintOp: number, [Float32Array | number[]], minMax]
      if (typeof args[0] === 'number' && Array.isArray(args[1])) {
        const paintOp = args[0];
        if (paintOp === OPS.endPath || paintOp === OPS.clip || paintOp === OPS.eoClip) return;
        const buf = args[1][0] as ArrayLike<number> | undefined;
        if (!buf || typeof buf.length !== 'number') return;

        let idx = 0;
        let pCurX = 0;
        let pCurY = 0;
        let pStartX = 0;
        let pStartY = 0;
        let hasStart = false;

        while (idx < buf.length) {
          const op = buf[idx++];
          if (op === 0) {
            // moveTo(x, y)
            const pt = toNorm(buf[idx++], buf[idx++]);
            pCurX = pt.x;
            pCurY = pt.y;
            pStartX = pt.x;
            pStartY = pt.y;
            hasStart = true;
          } else if (op === 1) {
            // lineTo(x, y)
            const pt = toNorm(buf[idx++], buf[idx++]);
            if (hasStart) {
              emitLine(pCurX, pCurY, pt.x, pt.y, effStroke);
            }
            pCurX = pt.x;
            pCurY = pt.y;
          } else if (op === 2) {
            // curveTo(cp1x, cp1y, cp2x, cp2y, x, y)
            const cp1 = toNorm(buf[idx++], buf[idx++]);
            const cp2 = toNorm(buf[idx++], buf[idx++]);
            const end = toNorm(buf[idx++], buf[idx++]);
            if (hasStart) {
              curveCounter += 1;
              const segs = tessellateCubicBezier(
                pCurX,
                pCurY,
                cp1.x,
                cp1.y,
                cp2.x,
                cp2.y,
                end.x,
                end.y,
                `curve-${curveCounter}`,
                effStroke
              );
              for (const seg of segs) {
                emitLine(seg.x1, seg.y1, seg.x2, seg.y2, seg.strokeWidthPt, seg.isCurvedSegment, seg.curveGroupId);
              }
            }
            pCurX = end.x;
            pCurY = end.y;
          } else if (op === 3) {
            // quadraticCurveTo(cpx, cpy, x, y)
            const cp = toNorm(buf[idx++], buf[idx++]);
            const end = toNorm(buf[idx++], buf[idx++]);
            if (hasStart) {
              curveCounter += 1;
              const segs = tessellateQuadraticBezier(
                pCurX,
                pCurY,
                cp.x,
                cp.y,
                end.x,
                end.y,
                `curve-${curveCounter}`,
                effStroke
              );
              for (const seg of segs) {
                emitLine(seg.x1, seg.y1, seg.x2, seg.y2, seg.strokeWidthPt, seg.isCurvedSegment, seg.curveGroupId);
              }
            }
            pCurX = end.x;
            pCurY = end.y;
          } else if (op === 4) {
            // closePath
            if (hasStart && Math.hypot(pCurX - pStartX, pCurY - pStartY) > 1e-5) {
              emitLine(pCurX, pCurY, pStartX, pStartY, effStroke);
            }
            pCurX = pStartX;
            pCurY = pStartY;
          } else {
            break;
          }
        }
        return;
      }

      // Legacy pdfjs-dist v3/v4 format: [ops: number[], coords: number[]]
      if (Array.isArray(args[0]) && Array.isArray(args[1])) {
        const subOps = args[0] as number[];
        const coords = args[1] as number[];
        let cIdx = 0;
        let pCurX = 0;
        let pCurY = 0;
        let pStartX = 0;
        let pStartY = 0;
        let hasStart = false;

        for (const subOp of subOps) {
          if (subOp === OPS.moveTo) {
            const pt = toNorm(coords[cIdx++], coords[cIdx++]);
            pCurX = pt.x;
            pCurY = pt.y;
            pStartX = pt.x;
            pStartY = pt.y;
            hasStart = true;
          } else if (subOp === OPS.lineTo) {
            const pt = toNorm(coords[cIdx++], coords[cIdx++]);
            if (hasStart) emitLine(pCurX, pCurY, pt.x, pt.y, effStroke);
            pCurX = pt.x;
            pCurY = pt.y;
          } else if (subOp === OPS.curveTo) {
            const cp1 = toNorm(coords[cIdx++], coords[cIdx++]);
            const cp2 = toNorm(coords[cIdx++], coords[cIdx++]);
            const end = toNorm(coords[cIdx++], coords[cIdx++]);
            if (hasStart) {
              curveCounter += 1;
              const segs = tessellateCubicBezier(
                pCurX,
                pCurY,
                cp1.x,
                cp1.y,
                cp2.x,
                cp2.y,
                end.x,
                end.y,
                `curve-${curveCounter}`,
                effStroke
              );
              for (const seg of segs) {
                emitLine(seg.x1, seg.y1, seg.x2, seg.y2, seg.strokeWidthPt, seg.isCurvedSegment, seg.curveGroupId);
              }
            }
            pCurX = end.x;
            pCurY = end.y;
          } else if (subOp === OPS.rectangle) {
            const rx = coords[cIdx++];
            const ry = coords[cIdx++];
            const rw = coords[cIdx++];
            const rh = coords[cIdx++];
            const p0 = toNorm(rx, ry);
            const p1 = toNorm(rx + rw, ry);
            const p2 = toNorm(rx + rw, ry + rh);
            const p3 = toNorm(rx, ry + rh);
            emitLine(p0.x, p0.y, p1.x, p1.y, effStroke);
            emitLine(p1.x, p1.y, p2.x, p2.y, effStroke);
            emitLine(p2.x, p2.y, p3.x, p3.y, effStroke);
            emitLine(p3.x, p3.y, p0.x, p0.y, effStroke);
          } else if (subOp === OPS.closePath) {
            if (hasStart && Math.hypot(pCurX - pStartX, pCurY - pStartY) > 1e-5) {
              emitLine(pCurX, pCurY, pStartX, pStartY, effStroke);
            }
            pCurX = pStartX;
            pCurY = pStartY;
          }
        }
      }
    };

    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i];

      if (fn === OPS.save) {
        stateStack.push({ ctm: [...ctm], lineWidthPt });
      } else if (fn === OPS.restore) {
        const prev = stateStack.pop();
        if (prev) {
          ctm = prev.ctm;
          lineWidthPt = prev.lineWidthPt;
        }
      } else if (fn === OPS.transform && Array.isArray(args) && args.length >= 6) {
        ctm = multiplyMatrix(ctm, [args[0], args[1], args[2], args[3], args[4], args[5]]);
      } else if (fn === OPS.setLineWidth && Array.isArray(args) && typeof args[0] === 'number') {
        lineWidthPt = Math.max(0.1, args[0]);
      } else if (fn === OPS.constructPath) {
        handleConstructPath(args as unknown[]);
      } else if (fn === OPS.moveTo && Array.isArray(args)) {
        const pt = toNorm(args[0], args[1]);
        curX = pt.x;
        curY = pt.y;
        startX = pt.x;
        startY = pt.y;
      } else if (fn === OPS.lineTo && Array.isArray(args)) {
        const pt = toNorm(args[0], args[1]);
        pendingPath.push({
          x1: curX,
          y1: curY,
          x2: pt.x,
          y2: pt.y,
          strokeWidthPt: lineWidthPt,
          isCurvedSegment: false,
        });
        curX = pt.x;
        curY = pt.y;
      } else if (fn === OPS.closePath) {
        if (Math.hypot(curX - startX, curY - startY) > 1e-5) {
          pendingPath.push({
            x1: curX,
            y1: curY,
            x2: startX,
            y2: startY,
            strokeWidthPt: lineWidthPt,
            isCurvedSegment: false,
          });
        }
        curX = startX;
        curY = startY;
      } else if (STROKE_OR_FILL_OPS.has(fn) && pendingPath.length > 0) {
        for (const s of pendingPath) {
          emitLine(s.x1, s.y1, s.x2, s.y2, s.strokeWidthPt, s.isCurvedSegment, s.curveGroupId);
        }
        pendingPath = [];
      } else if (fn === OPS.endPath || fn === OPS.clip || fn === OPS.eoClip) {
        pendingPath = [];
      }
    }

    // Extract PDF text runs with exact normalized page coordinates
    const textContent = await page.getTextContent();
    const rawTextItems: Array<{
      str: string;
      x: number;
      y: number;
      widthNorm: number;
      heightNorm: number;
      fontSizePt: number;
    }> = [];

    for (const item of textContent.items) {
      if (!('str' in item) || typeof item.str !== 'string' || !item.str.trim()) continue;
      const tr = Array.isArray(item.transform) && item.transform.length >= 6 ? item.transform : IDENTITY_MATRIX;
      const combined = multiplyMatrix(baseViewportMatrix, [
        tr[0],
        tr[1],
        tr[2],
        tr[3],
        tr[4],
        tr[5],
      ]);
      const rawPt = transformNormalizedPoint(
        { x: combined[4] / pageWidthPt, y: combined[5] / pageHeightPt },
        rotationDeg,
        cropRect
      );
      if (rawPt.x < -0.02 || rawPt.x > 1.02 || rawPt.y < -0.02 || rawPt.y > 1.02) continue;

      const fontSizePt = Math.max(4, Math.hypot(tr[0], tr[1]) || Math.hypot(tr[2], tr[3]) || 10);
      const widthNorm = (typeof item.width === 'number' ? item.width : item.str.length * fontSizePt * 0.55) / pageWidthPt;
      const heightNorm = (typeof item.height === 'number' && item.height > 0 ? item.height : fontSizePt) / pageHeightPt;

      rawTextItems.push({
        str: item.str,
        x: rawPt.x,
        y: rawPt.y,
        widthNorm: Math.max(0.005, widthNorm / (cropRect?.width ?? 1)),
        heightNorm: Math.max(0.005, heightNorm / (cropRect?.height ?? 1)),
        fontSizePt,
      });
    }

    // Process PDF text first so Legend & Title-Block exclusion zones are known before wall cleaning
    const { textItems, dimensions, legendEntries, titleBlock } = processExtractedTextItems(
      rawTextItems,
      defaultUnit
    );
    const excludedZones = detectExclusionZones(textItems);
    const { wallSegments, columns, filteredNoiseCount } = cleanAndMergeVectorSegments(
      rawSegments,
      excludedZones
    );
    const curvedSegmentCount = wallSegments.filter((s) => s.isCurvedSegment).length;
    const angledSegmentCount = wallSegments.filter((s) => s.isAngled).length;

    const isVectorPdf = wallSegments.length >= 4 || (rawSegments.length >= 10 && textItems.length >= 2);
    const warnings: string[] = [];
    if (!isVectorPdf) {
      warnings.push(
        'PDF page appears to be scanned/rasterized (minimal native vector paths found). Computer-vision line tracing + High-resolution Vision AI will be used.'
      );
    } else if (dimensions.length === 0) {
      warnings.push(
        'Vector paths extracted, but no explicit dimension strings were parsed from PDF text. Use 2-point calibration for exact metric scaling.'
      );
    }
    if (excludedZones.length > 0 && filteredNoiseCount > 0) {
      warnings.push(
        `Filtered ${filteredNoiseCount} non-architectural vector stroke(s) from ${excludedZones.map((z) => z.kind).join(' & ')} zone(s) to prevent legend/title-block contamination.`
      );
    }

    return {
      sourceKind: isVectorPdf ? 'vector-pdf' : 'scanned-pdf',
      pageNumber: safePage,
      pageWidthPt,
      pageHeightPt,
      rawSegmentCount: rawSegments.length,
      filteredNoiseCount,
      excludedZones,
      wallSegments,
      columns,
      curvedSegmentCount,
      angledSegmentCount,
      textItems,
      dimensions,
      legendEntries,
      titleBlock,
      warnings,
    };
  } finally {
    const disposablePdf = pdf as unknown as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> };
    const disposableTask = loadingTask as unknown as { destroy?: () => Promise<void> };
    if (typeof disposablePdf.destroy === 'function') {
      await disposablePdf.destroy();
    } else if (typeof disposableTask.destroy === 'function') {
      await disposableTask.destroy();
    } else if (typeof disposablePdf.cleanup === 'function') {
      await disposablePdf.cleanup();
    }
  }
}

/**
 * Packages extracted PDF vector walls & text into a compact, high-signal JSON context
 * sent alongside the high-resolution image to /api/ai-drawing/analyze.
 */
export function buildAiVectorContext(
  extraction: PdfVectorExtractionResult | null
): AiDrawingVectorContext | undefined {
  if (!extraction) return undefined;

  // Prioritize curved walls, angled walls, external walls, then longest internal walls
  const prioritized = [...extraction.wallSegments].sort((a, b) => {
    const score = (s: PdfVectorSegment) => {
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      return (
        (s.isCurvedSegment ? 3 : 0) +
        (s.isAngled ? 2 : 0) +
        (s.wallKind === 'external' ? 1.5 : 0) +
        len * 4
      );
    };
    return score(b) - score(a);
  });

  return {
    sourceKind: extraction.sourceKind,
    totalVectorSegments: extraction.wallSegments.length,
    curvedSegmentCount: extraction.curvedSegmentCount,
    angledSegmentCount: extraction.angledSegmentCount,
    wallAnchors: prioritized.slice(0, 220).map((s) => ({
      x1: s.x1,
      y1: s.y1,
      x2: s.x2,
      y2: s.y2,
      wallKind: s.wallKind,
      isCurved: s.isCurvedSegment || undefined,
    })),
    textLabels: extraction.textItems.slice(0, 160).map((t) => ({
      text: t.text,
      x: t.x,
      y: t.y,
      kind: t.kind,
    })),
    dimensions: extraction.dimensions.slice(0, 60).map((d) => ({
      text: d.labelText,
      x: d.x,
      y: d.y,
      meters: d.parsedMeters,
    })),
    legendEntries: extraction.legendEntries.slice(0, 40),
    titleBlock: extraction.titleBlock,
  };
}
