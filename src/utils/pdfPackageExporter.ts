import {
  formatINR,
  siteToMeters,
} from '../data/presets';
import {
  ElectricalCategory,
  FloorLevelConfig,
  ProjectData,
  WireCategory,
} from '../types/design';
import {
  BUILDING_TYPE_LABELS,
  computeActualGeometryBounds,
  computeReconciledBoq,
  computeReconciledElectricalSchedule,
  computeStaircaseFootprint,
  computeWireConsumptionSummary,
  computeWireLengthMeters,
  DEFAULT_INSTALLATION_ALLOWANCE_PCT,
  getFloorBoundaryMeters,
  getFloorLabel,
  getProjectFloors,
  getWiringConfig,
  inferBuildingType,
  ReconciledElectricalSchedule,
  WIRE_CATEGORY_LABELS,
  WIRE_STANDARD_COLORS,
} from './buildingWiring';
import {
  extractMergedWalls,
  formatArea,
  formatLength,
  getItemFloor,
  sliceProjectForFloor,
} from './geometry';

export type PdfPageSize = 'a4' | 'a3' | 'a2';
export type PdfOrientation = 'landscape' | 'portrait';
export type PdfScaleOption = 'auto' | '1:50' | '1:100' | '1:200';

export interface PdfPackageOptions {
  pageSize: PdfPageSize;
  orientation: PdfOrientation;
  scale: PdfScaleOption;
  includeCover: boolean;
  includeFloorPlans: boolean;
  includeElectricalLayouts: boolean;
  includeWiringLayouts: boolean;
  include3DViews: boolean;
  includeElevations: boolean;
  includeDbAndEarthing: boolean;
  includeSummaryAndBoq: boolean;
  includeAnnotations: boolean;
  selectedFloors?: number[];
  /** Separate procurement allowance % shown in Wire Consumption Summary (default 10%). */
  wireProcurementAllowancePct?: number;
}

export const DEFAULT_PDF_PACKAGE_OPTIONS: PdfPackageOptions = {
  pageSize: 'a3',
  orientation: 'landscape',
  scale: 'auto',
  includeCover: true,
  includeFloorPlans: true,
  includeElectricalLayouts: true,
  includeWiringLayouts: true,
  include3DViews: true,
  includeElevations: true,
  includeDbAndEarthing: true,
  includeSummaryAndBoq: true,
  includeAnnotations: true,
};

const CATEGORY_SYMBOL_COLORS: Record<ElectricalCategory, string> = {
  Fans: '#0284C7',
  Lighting: '#D97706',
  Switches: '#4F46E5',
  Sockets: '#059669',
  Appliances: '#DC2626',
  Distribution: '#B45309',
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloorPlanFitMetrics {
  worldMinX: number;
  worldMinY: number;
  worldMaxX: number;
  worldMaxY: number;
  siteLengthM: number;
  siteWidthM: number;
  hasBoundaryOverflow: boolean;
  pxPerM: number;
  ox: number;
  oy: number;
  effectiveScaleDenominator: number;
  scaleLabel: string;
  drawBox: Rect;
}

export interface IsometricFitMetrics {
  scale: number;
  offsetX: number;
  offsetY: number;
  modelBox: Rect;
  labelBox: Rect;
  projectedMinX: number;
  projectedMaxX: number;
  projectedMinY: number;
  projectedMaxY: number;
}

export interface ElevationFitMetrics {
  scale: number;
  baseX: number;
  baseY: number;
  drawW: number;
  drawH: number;
  wallWidthM: number;
  totalHeightM: number;
  minElevM: number;
  maxElevM: number;
}

// Page dimensions in mm (ISO 216)
const PAGE_MM: Record<PdfPageSize, { w: number; h: number }> = {
  a4: { w: 210, h: 297 },
  a3: { w: 297, h: 420 },
  a2: { w: 420, h: 594 },
};

const RENDER_DPI = 150;
const PX_PER_MM = RENDER_DPI / 25.4;

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/^_+|_+$/g, '') || 'Blue_Space_Project';
}

export function getPageDimensionsPx(size: PdfPageSize, orientation: PdfOrientation) {
  const normalized = (typeof size === 'string' ? size.toLowerCase() : 'a3') as PdfPageSize;
  const base = PAGE_MM[normalized] ?? PAGE_MM.a3;
  const widthMm = orientation === 'landscape' ? Math.max(base.w, base.h) : Math.min(base.w, base.h);
  const heightMm = orientation === 'landscape' ? Math.min(base.w, base.h) : Math.max(base.w, base.h);
  return {
    widthMm,
    heightMm,
    widthPx: Math.round(widthMm * PX_PER_MM),
    heightPx: Math.round(heightMm * PX_PER_MM),
  };
}

/**
 * Computes a proportional UI typography & spacing scale factor for A4 / A3 / A2 canvases
 * so schedules, KPI cards, titles, and labels remain large, crisp, and print-readable
 * without leaving excessive whitespace on A3/A2 sheets.
 */
function getUiScale(widthPx: number, heightPx: number): number {
  return Math.max(1.0, Math.min(1.65, Math.min(widthPx, heightPx) / 1180));
}

function createOffscreenPage(widthPx: number, heightPx: number) {
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to initialize 2D canvas context for PDF rendering.');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, widthPx, heightPx);
  return { canvas, ctx };
}

function withClip(ctx: CanvasRenderingContext2D, rect: Rect, fn: () => void) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  try {
    fn();
  } finally {
    ctx.restore();
  }
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 8) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo > 0 ? text.slice(0, lo) + ellipsis : ellipsis;
}

function wrapTextLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (maxWidth <= 20) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      if (ctx.measureText(word).width > maxWidth) {
        lines.push(truncateText(ctx, word, maxWidth));
        current = '';
      } else {
        current = word;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

interface TableColumn {
  label: string;
  /** Fractional width (sum of fractions = 1.0) */
  widthFrac: number;
  align?: 'left' | 'right' | 'center';
}

interface TableRowStyle {
  fill?: string;
  textColor?: string;
  bold?: boolean;
}

function drawAlignedTable(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  columns: TableColumn[],
  rows: Array<{ cells: string[]; style?: TableRowStyle }>,
  options?: {
    headerFill?: string;
    headerText?: string;
    rowHeight?: number;
    headerHeight?: number;
    fontSize?: number;
  }
): number {
  const headerH = options?.headerHeight ?? 28;
  const rowH = options?.rowHeight ?? 24;
  const fontSize = options?.fontSize ?? 12;
  const headerFill = options?.headerFill ?? '#0F172A';
  const headerText = options?.headerText ?? '#FFFFFF';

  const colXs: number[] = [];
  const colWs: number[] = [];
  let cursorX = rect.x;
  const totalFrac = columns.reduce((s, c) => s + c.widthFrac, 0) || 1;
  columns.forEach((col, i) => {
    const w =
      i === columns.length - 1
        ? rect.x + rect.w - cursorX
        : Math.round((col.widthFrac / totalFrac) * rect.w);
    colXs.push(cursorX);
    colWs.push(w);
    cursorX += w;
  });

  let y = rect.y;
  withClip(ctx, rect, () => {
    // Header row
    ctx.fillStyle = headerFill;
    ctx.fillRect(rect.x, y, rect.w, headerH);
    ctx.font = `700 ${fontSize}px sans-serif`;
    ctx.fillStyle = headerText;
    ctx.textBaseline = 'middle';
    columns.forEach((col, i) => {
      const pad = 8;
      const maxW = Math.max(12, colWs[i] - pad * 2);
      const txt = truncateText(ctx, col.label, maxW);
      if (col.align === 'right') {
        ctx.textAlign = 'right';
        ctx.fillText(txt, colXs[i] + colWs[i] - pad, y + headerH / 2);
      } else if (col.align === 'center') {
        ctx.textAlign = 'center';
        ctx.fillText(txt, colXs[i] + colWs[i] / 2, y + headerH / 2);
      } else {
        ctx.textAlign = 'left';
        ctx.fillText(txt, colXs[i] + pad, y + headerH / 2);
      }
    });
    y += headerH;

    // Data rows
    rows.forEach((row, rIdx) => {
      if (y + rowH > rect.y + rect.h + 1) return;
      ctx.fillStyle = row.style?.fill ?? (rIdx % 2 === 0 ? '#FFFFFF' : '#F8FAFC');
      ctx.fillRect(rect.x, y, rect.w, rowH);
      ctx.strokeStyle = '#E2E8F0';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rect.x, y + rowH);
      ctx.lineTo(rect.x + rect.w, y + rowH);
      ctx.stroke();

      ctx.font = `${row.style?.bold ? '700' : '500'} ${fontSize}px sans-serif`;
      ctx.fillStyle = row.style?.textColor ?? '#1E293B';
      ctx.textBaseline = 'middle';

      columns.forEach((col, i) => {
        const pad = 8;
        const maxW = Math.max(12, colWs[i] - pad * 2);
        const val = truncateText(ctx, row.cells[i] ?? '', maxW);
        if (col.align === 'right') {
          ctx.textAlign = 'right';
          ctx.fillText(val, colXs[i] + colWs[i] - pad, y + rowH / 2);
        } else if (col.align === 'center') {
          ctx.textAlign = 'center';
          ctx.fillText(val, colXs[i] + colWs[i] / 2, y + rowH / 2);
        } else {
          ctx.textAlign = 'left';
          ctx.fillText(val, colXs[i] + pad, y + rowH / 2);
        }
      });
      y += rowH;
    });

    // Outer table border
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(rect.x, rect.y, rect.w, Math.min(rect.h, y - rect.y));
  });

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  return y;
}

/**
 * Draws the professional architectural border and title block at the bottom of every sheet.
 * Returns the exact drawable viewport Rect inside the border above the title block.
 */
export function drawTitleBlockAndFrame(
  ctx: CanvasRenderingContext2D,
  widthPx: number,
  heightPx: number,
  meta: {
    projectName: string;
    refCode: string;
    sheetNo: string;
    sheetTitle: string;
    floorLabel?: string;
    scaleLabel: string;
    units: string;
    pageIndex: number;
    pageTotal: number;
    buildingTypeLabel: string;
    dateStr: string;
  }
): Rect {
  const ui = getUiScale(widthPx, heightPx);
  const margin = Math.max(32, Math.round(Math.min(widthPx, heightPx) * 0.022));
  const tbHeight = Math.max(Math.round(98 * ui), Math.round(heightPx * 0.072));

  // Outer & inner CAD frame
  ctx.strokeStyle = '#0F172A';
  ctx.lineWidth = Math.max(2.5, 2.4 * ui);
  ctx.strokeRect(margin, margin, widthPx - margin * 2, heightPx - margin * 2);

  ctx.strokeStyle = '#64748B';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(margin + 6, margin + 6, widthPx - (margin + 6) * 2, heightPx - (margin + 6) * 2);

  const tbY = heightPx - margin - tbHeight;
  const tbX = margin + 6;
  const tbW = widthPx - (margin + 6) * 2;
  const tbInnerH = tbHeight - 6;

  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(tbX, tbY, tbW, tbInnerH);
  ctx.strokeStyle = '#0F172A';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(tbX, tbY);
  ctx.lineTo(tbX + tbW, tbY);
  ctx.stroke();

  // Proportional columns so title block works identically on Portrait & Landscape A4/A3/A2
  const col1W = Math.round(tbW * 0.25);
  const col2W = Math.round(tbW * 0.37);
  const col3W = Math.round(tbW * 0.24);
  const col4W = tbW - col1W - col2W - col3W;
  const x1 = tbX;
  const x2 = x1 + col1W;
  const x3 = x2 + col2W;
  const x4 = x3 + col3W;

  ctx.strokeStyle = '#94A3B8';
  ctx.lineWidth = 1.2;
  [x2, x3, x4].forEach((vx) => {
    ctx.beginPath();
    ctx.moveTo(vx, tbY);
    ctx.lineTo(vx, tbY + tbInnerH);
    ctx.stroke();
  });

  const padX = Math.round(14 * ui);
  const fTiny = Math.round(10 * ui);
  const fSmall = Math.round(11.5 * ui);
  const fMed = Math.round(14 * ui);
  const fLarge = Math.round(17.5 * ui);
  const fSheet = Math.round(25 * ui);

  // Col 1: Brand + Ref
  ctx.fillStyle = '#0F172A';
  ctx.font = `bold ${fLarge}px sans-serif`;
  ctx.fillText(truncateText(ctx, 'BLUE SPACE CAD', col1W - padX * 2), x1 + padX, tbY + Math.round(tbInnerH * 0.28));
  ctx.fillStyle = '#0284C7';
  ctx.font = `bold ${fSmall}px sans-serif`;
  ctx.fillText(truncateText(ctx, 'ARCHITECTURAL & ELECTRICAL SUITE', col1W - padX * 2), x1 + padX, tbY + Math.round(tbInnerH * 0.5));
  ctx.fillStyle = '#475569';
  ctx.font = `${fSmall}px monospace`;
  ctx.fillText(truncateText(ctx, `REF: ${meta.refCode}`, col1W - padX * 2), x1 + padX, tbY + Math.round(tbInnerH * 0.72));
  ctx.fillText(truncateText(ctx, `TYPE: ${meta.buildingTypeLabel}`, col1W - padX * 2), x1 + padX, tbY + Math.round(tbInnerH * 0.9));

  // Col 2: Project + Sheet Title
  ctx.fillStyle = '#475569';
  ctx.font = `bold ${fTiny}px sans-serif`;
  ctx.fillText('PROJECT NAME', x2 + padX, tbY + Math.round(tbInnerH * 0.2));
  ctx.fillStyle = '#0F172A';
  ctx.font = `bold ${fLarge}px sans-serif`;
  ctx.fillText(truncateText(ctx, meta.projectName, col2W - padX * 2), x2 + padX, tbY + Math.round(tbInnerH * 0.44));
  ctx.fillStyle = '#475569';
  ctx.font = `bold ${fTiny}px sans-serif`;
  ctx.fillText('DRAWING TITLE', x2 + padX, tbY + Math.round(tbInnerH * 0.64));
  ctx.fillStyle = '#0369A1';
  ctx.font = `bold ${fMed}px sans-serif`;
  const titleLine = `${meta.sheetTitle}${meta.floorLabel ? ` — ${meta.floorLabel}` : ''}`;
  ctx.fillText(truncateText(ctx, titleLine, col2W - padX * 2), x2 + padX, tbY + Math.round(tbInnerH * 0.86));

  // Col 3: Scale / Units / Date
  ctx.fillStyle = '#475569';
  ctx.font = `bold ${fTiny}px sans-serif`;
  ctx.fillText('SCALE / UNITS', x3 + padX, tbY + Math.round(tbInnerH * 0.2));
  ctx.fillStyle = '#0F172A';
  ctx.font = `bold ${fMed}px monospace`;
  ctx.fillText(truncateText(ctx, `${meta.scaleLabel} | ${meta.units}`, col3W - padX * 2), x3 + padX, tbY + Math.round(tbInnerH * 0.44));
  ctx.fillStyle = '#475569';
  ctx.font = `bold ${fTiny}px sans-serif`;
  ctx.fillText('ISSUE DATE', x3 + padX, tbY + Math.round(tbInnerH * 0.64));
  ctx.fillStyle = '#0F172A';
  ctx.font = `${fSmall}px monospace`;
  ctx.fillText(truncateText(ctx, meta.dateStr, col3W - padX * 2), x3 + padX, tbY + Math.round(tbInnerH * 0.86));

  // Col 4: Sheet No & Page
  ctx.fillStyle = '#475569';
  ctx.font = `bold ${fTiny}px sans-serif`;
  ctx.fillText('SHEET NO.', x4 + padX, tbY + Math.round(tbInnerH * 0.2));
  ctx.fillStyle = '#0F172A';
  ctx.font = `bold ${fSheet}px monospace`;
  ctx.fillText(truncateText(ctx, meta.sheetNo, col4W - padX * 1.6), x4 + padX, tbY + Math.round(tbInnerH * 0.56));
  ctx.fillStyle = '#475569';
  ctx.font = `bold ${fSmall}px monospace`;
  ctx.fillText(
    truncateText(ctx, `PAGE ${meta.pageIndex} / ${meta.pageTotal}`, col4W - padX * 1.6),
    x4 + padX,
    tbY + Math.round(tbInnerH * 0.86)
  );

  return {
    x: margin + 18,
    y: margin + 18,
    w: widthPx - (margin + 18) * 2,
    h: tbY - margin - 28,
  };
}

function drawNorthArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = '#0F172A';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#0F172A';
  ctx.beginPath();
  ctx.moveTo(0, -radius + 3);
  ctx.lineTo(radius * 0.34, radius * 0.34);
  ctx.lineTo(0, 0);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = '#0F172A';
  ctx.beginPath();
  ctx.moveTo(0, -radius + 3);
  ctx.lineTo(-radius * 0.34, radius * 0.34);
  ctx.lineTo(0, 0);
  ctx.closePath();
  ctx.stroke();

  ctx.fillStyle = '#0F172A';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', 0, -radius - 5);
  ctx.restore();
}

function drawGraphicScaleBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  pxPerM: number,
  units: 'ft' | 'm',
  maxBarPx: number
) {
  const candidatesM = units === 'ft' ? [0.6096, 1.524, 3.048, 6.096, 9.144] : [1, 2, 5, 10, 15];
  let chosenM = candidatesM[0];
  for (const c of candidatesM) {
    if (c * pxPerM <= maxBarPx) chosenM = c;
  }
  const barPx = Math.max(40, Math.min(maxBarPx, chosenM * pxPerM));
  const halfPx = barPx / 2;

  ctx.save();
  ctx.fillStyle = '#0F172A';
  ctx.fillRect(x, y, halfPx, 6);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(x + halfPx, y, halfPx, 6);
  ctx.strokeStyle = '#0F172A';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(x, y, barPx, 6);

  ctx.fillStyle = '#334155';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('0', x, y - 4);
  ctx.textAlign = 'center';
  ctx.fillText(formatLength(chosenM / 2, units, 1), x + halfPx, y - 4);
  ctx.textAlign = 'right';
  ctx.fillText(formatLength(chosenM, units, 1), x + barPx, y - 4);
  ctx.restore();
}

/**
 * Pure mathematical layout solver for any floor plan.
 * Computes the EXACT union bounding box of the site boundary AND all floor geometry
 * (rooms, custom walls, openings, staircases, electrical points, wire waypoints)
 * so ZERO geometry can ever clip off left/right/top/bottom — even if rooms overflow the site!
 */
export function computeFloorPlanFit(
  project: ProjectData,
  floor: number,
  rect: Rect,
  scaleOpt: PdfScaleOption
): FloorPlanFitMetrics {
  const slice = sliceProjectForFloor(project, floor);
  const { lengthM: siteLengthM, widthM: siteWidthM } = siteToMeters(slice.site);
  const flBounds = getFloorBoundaryMeters(project, floor);
  const lengthM = flBounds.lengthM;
  const widthM = flBounds.widthM;

  let minX = 0;
  let minY = 0;
  let maxX = Math.max(0.5, siteLengthM, lengthM);
  let maxY = Math.max(0.5, siteWidthM, widthM);
  let hasBoundaryOverflow = flBounds.exceedsSite && !project.site.allowFloorExceedSite;
  const OVERFLOW_EPS = 0.05;

  slice.rooms.forEach((r) => {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
    if (
      r.x < -OVERFLOW_EPS ||
      r.y < -OVERFLOW_EPS ||
      r.x + r.width > lengthM + OVERFLOW_EPS ||
      r.y + r.height > widthM + OVERFLOW_EPS
    ) {
      hasBoundaryOverflow = true;
    }
  });

  slice.customWalls.forEach((w) => {
    minX = Math.min(minX, w.x1, w.x2);
    minY = Math.min(minY, w.y1, w.y2);
    maxX = Math.max(maxX, w.x1, w.x2);
    maxY = Math.max(maxY, w.y1, w.y2);
  });

  slice.points.forEach((pt) => {
    minX = Math.min(minX, pt.x - 0.35);
    minY = Math.min(minY, pt.y - 0.35);
    maxX = Math.max(maxX, pt.x + 0.35);
    maxY = Math.max(maxY, pt.y + 0.35);
    if (
      pt.x < -OVERFLOW_EPS ||
      pt.y < -OVERFLOW_EPS ||
      pt.x > lengthM + OVERFLOW_EPS ||
      pt.y > widthM + OVERFLOW_EPS
    ) {
      hasBoundaryOverflow = true;
    }
  });

  (slice.staircases ?? []).forEach((st) => {
    const fp = computeStaircaseFootprint(st);
    minX = Math.min(minX, st.x);
    minY = Math.min(minY, st.y);
    maxX = Math.max(maxX, st.x + fp.footprintW);
    maxY = Math.max(maxY, st.y + fp.footprintD);
  });

  (slice.wires ?? []).forEach((w) => {
    (w.waypoints ?? []).forEach((wp) => {
      if (!Number.isFinite(wp.x) || !Number.isFinite(wp.y)) return;
      minX = Math.min(minX, wp.x);
      minY = Math.min(minY, wp.y);
      maxX = Math.max(maxX, wp.x);
      maxY = Math.max(maxY, wp.y);
    });
  });

  const spanX = Math.max(0.5, maxX - minX);
  const spanY = Math.max(0.5, maxY - minY);

  // Reserved margins for outer dimension chains, header banner, north arrow, and scale bar
  const padLeft = Math.min(92, Math.max(52, Math.round(rect.w * 0.06)));
  const padRight = Math.min(84, Math.max(46, Math.round(rect.w * 0.05)));
  const padTop = Math.min(98, Math.max(60, Math.round(rect.h * 0.085)));
  const padBottom = Math.min(86, Math.max(54, Math.round(rect.h * 0.08)));

  const drawBox: Rect = {
    x: rect.x + padLeft,
    y: rect.y + padTop,
    w: Math.max(40, rect.w - padLeft - padRight),
    h: Math.max(40, rect.h - padTop - padBottom),
  };

  const fitPxPerM = Math.min(drawBox.w / spanX, drawBox.h / spanY);
  let pxPerM = fitPxPerM;
  let requestedDenom: number | null = null;
  if (scaleOpt === '1:50') requestedDenom = 50;
  else if (scaleOpt === '1:100') requestedDenom = 100;
  else if (scaleOpt === '1:200') requestedDenom = 200;

  let usedExactRequested = false;
  if (requestedDenom !== null) {
    const requestedPxPerM = (1000 / requestedDenom) * PX_PER_MM;
    if (requestedPxPerM <= fitPxPerM * 1.001) {
      pxPerM = requestedPxPerM;
      usedExactRequested = true;
    }
  }

  const effectiveDenom = Math.max(1, Math.round((1000 * PX_PER_MM) / Math.max(1, pxPerM)));
  const scaleLabel = usedExactRequested
    ? `1:${requestedDenom}`
    : scaleOpt === 'auto'
      ? `AUTO (1:${effectiveDenom})`
      : `FIT (1:${effectiveDenom})`;

  const drawnW = spanX * pxPerM;
  const drawnH = spanY * pxPerM;
  const ox = drawBox.x + (drawBox.w - drawnW) / 2 - minX * pxPerM;
  const oy = drawBox.y + (drawBox.h - drawnH) / 2 - minY * pxPerM;

  return {
    worldMinX: minX,
    worldMinY: minY,
    worldMaxX: maxX,
    worldMaxY: maxY,
    siteLengthM: lengthM,
    siteWidthM: widthM,
    hasBoundaryOverflow,
    pxPerM,
    ox,
    oy,
    effectiveScaleDenominator: effectiveDenom,
    scaleLabel,
    drawBox,
  };
}

/**
 * Draws an architectural / electrical / wiring 2D floor plan strictly inside `rect` with clipping.
 */
export function drawPlanOnContext(
  ctx: CanvasRenderingContext2D,
  project: ProjectData,
  floor: number,
  rect: Rect,
  mode: 'architectural' | 'electrical' | 'wiring' | 'combined',
  scaleOpt: PdfScaleOption,
  includeAnnotations: boolean = true
): FloorPlanFitMetrics {
  const slice = sliceProjectForFloor(project, floor);
  const { lengthM: siteLengthM, widthM: siteWidthM } = siteToMeters(slice.site);
  const flBounds = getFloorBoundaryMeters(project, floor);
  const lengthM = flBounds.lengthM;
  const widthM = flBounds.widthM;
  const units = slice.site.units;
  const fit = computeFloorPlanFit(project, floor, rect, scaleOpt);
  const { ox, oy, pxPerM } = fit;
  const tx = (x: number) => ox + x * pxPerM;
  const ty = (y: number) => oy + y * pxPerM;
  const pScale = Math.max(1.0, Math.min(1.45, Math.min(rect.w, rect.h) / 950));

  withClip(ctx, rect, () => {
    // Subtle clean drawing panel frame
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

    // Top-left banner if boundary overflow exists
    let topBannerBottom = rect.y + 8;
    if (fit.hasBoundaryOverflow) {
      const bannerH = Math.round(26 * pScale);
      const bannerW = Math.min(rect.w - 92, Math.round(640 * pScale));
      ctx.fillStyle = '#FEF2F2';
      ctx.fillRect(rect.x + 12, rect.y + 8, bannerW, bannerH);
      ctx.strokeStyle = '#DC2626';
      ctx.lineWidth = 1.4;
      ctx.strokeRect(rect.x + 12, rect.y + 8, bannerW, bannerH);
      ctx.fillStyle = '#B91C1C';
      ctx.font = `bold ${Math.round(11 * pScale)}px sans-serif`;
      ctx.fillText(
        truncateText(
          ctx,
          `BOUNDARY OVERFLOW: Geometry exceeds ${flBounds.isCustom ? 'floor' : 'site'} boundary (${formatLength(lengthM, units, 1)} × ${formatLength(widthM, units, 1)}).`,
          bannerW - 18
        ),
        rect.x + 20,
        rect.y + 8 + Math.round(bannerH * 0.68)
      );
      topBannerBottom = rect.y + 8 + bannerH + 6;
    }

    // Subtle CAD grid inside authoritative floor boundary
    const gridStepM = units === 'ft' ? 0.6096 : 0.5;
    if (gridStepM * pxPerM >= 10) {
      ctx.strokeStyle = '#F1F5F9';
      ctx.lineWidth = 0.7;
      for (let gx = 0; gx <= lengthM + 0.001; gx += gridStepM) {
        ctx.beginPath();
        ctx.moveTo(tx(gx), ty(0));
        ctx.lineTo(tx(gx), ty(widthM));
        ctx.stroke();
      }
      for (let gy = 0; gy <= widthM + 0.001; gy += gridStepM) {
        ctx.beginPath();
        ctx.moveTo(tx(0), ty(gy));
        ctx.lineTo(tx(lengthM), ty(gy));
        ctx.stroke();
      }
    }

    // Rooms (subtle muted fills on Wiring mode so cable routes take visual priority)
    const roomFills: Record<string, string> = {
      living: '#F0F9FF',
      'master-bedroom': '#EEF2FF',
      'second-bedroom': '#F5F3FF',
      kitchen: '#FFFBEB',
      dining: '#F0FDF4',
      bathroom: '#ECFEFF',
      balcony: '#F8FAFC',
    };

    slice.rooms.forEach((rm) => {
      const rx = tx(rm.x);
      const ry = ty(rm.y);
      const rw = rm.width * pxPerM;
      const rh = rm.height * pxPerM;
      const isOutOfBounds =
        rm.x < -0.04 ||
        rm.y < -0.04 ||
        rm.x + rm.width > lengthM + 0.04 ||
        rm.y + rm.height > widthM + 0.04;

      ctx.fillStyle = isOutOfBounds
        ? '#FEF2F2'
        : mode === 'wiring'
          ? '#FAFBFD'
          : roomFills[rm.type] ?? '#F8FAFC';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = isOutOfBounds ? '#DC2626' : mode === 'wiring' ? '#CBD5E1' : '#94A3B8';
      ctx.lineWidth = isOutOfBounds ? 1.8 : 1;
      if (isOutOfBounds) ctx.setLineDash([6, 4]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);

      // Auto-sized, non-overflowing room name + actual dimensions + area
      if (rw >= 42 && rh >= 28) {
        const nameSize = Math.max(
          Math.round(9.5 * pScale),
          Math.min(Math.round(15 * pScale), Math.floor(Math.min(rw / 8.0, rh / 3.2)))
        );
        const subSize = Math.max(Math.round(8.5 * pScale), nameSize - 2);
        const maxLabelW = Math.max(24, rw - 12);
        const cx = rx + rw / 2;
        const cy = ry + rh / 2;

        ctx.textAlign = 'center';
        ctx.fillStyle = isOutOfBounds ? '#991B1B' : mode === 'wiring' ? '#64748B' : '#0F172A';
        ctx.font = `700 ${nameSize}px sans-serif`;
        const titleTxt = truncateText(ctx, rm.name.toUpperCase(), maxLabelW);

        if (rh >= 56 * pScale) {
          ctx.fillText(titleTxt, cx, cy - subSize * 0.78);
          ctx.fillStyle = mode === 'wiring' ? '#94A3B8' : '#475569';
          ctx.font = `500 ${subSize}px monospace`;
          const dimStr = `${formatLength(rm.width, units, 1)} × ${formatLength(rm.height, units, 1)}`;
          ctx.fillText(truncateText(ctx, dimStr, maxLabelW), cx, cy + subSize * 0.55);
          ctx.fillStyle = mode === 'wiring' ? '#94A3B8' : '#64748B';
          ctx.font = `500 ${Math.max(8, subSize - 1)}px monospace`;
          ctx.fillText(
            truncateText(ctx, formatArea(rm.width * rm.height, units), maxLabelW),
            cx,
            cy + subSize * 1.8
          );
        } else if (rh >= 40) {
          ctx.fillText(titleTxt, cx, cy - 2);
          ctx.fillStyle = mode === 'wiring' ? '#94A3B8' : '#475569';
          ctx.font = `500 ${subSize}px monospace`;
          const dimStr = `${formatLength(rm.width, units, 1)} × ${formatLength(rm.height, units, 1)}`;
          ctx.fillText(truncateText(ctx, dimStr, maxLabelW), cx, cy + subSize + 1);
        } else {
          ctx.fillText(titleTxt, cx, cy + nameSize * 0.35);
        }
        ctx.textAlign = 'left';
      }
    });

    // Furniture (subtle architectural outlines)
    if (mode === 'architectural' || mode === 'combined') {
      slice.furniture.forEach((fn) => {
        ctx.save();
        ctx.translate(tx(fn.x), ty(fn.y));
        ctx.rotate((fn.rotation * Math.PI) / 180);
        const fw = fn.width * pxPerM;
        const fd = fn.depth * pxPerM;
        ctx.fillStyle = 'rgba(203, 213, 225, 0.25)';
        ctx.strokeStyle = '#94A3B8';
        ctx.lineWidth = 0.9;
        ctx.fillRect(-fw / 2, -fd / 2, fw, fd);
        ctx.strokeRect(-fw / 2, -fd / 2, fw, fd);
        ctx.restore();
      });
    }

    // Staircases
    (slice.staircases ?? []).forEach((st) => {
      const fp = computeStaircaseFootprint(st);
      const sx = tx(st.x);
      const sy = ty(st.y);
      const sw = fp.footprintW * pxPerM;
      const sd = fp.footprintD * pxPerM;
      ctx.save();
      ctx.translate(sx + sw / 2, sy + sd / 2);
      ctx.rotate(((st.rotation ?? 0) * Math.PI) / 180);
      ctx.fillStyle = '#E2E8F0';
      ctx.strokeStyle = '#0F172A';
      ctx.lineWidth = 1.6;
      ctx.fillRect(-sw / 2, -sd / 2, sw, sd);
      ctx.strokeRect(-sw / 2, -sd / 2, sw, sd);
      const stepLines = Math.min(18, Math.max(4, st.steps));
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 0.9;
      for (let i = 1; i < stepLines; i++) {
        const lx = -sw / 2 + (sw * i) / stepLines;
        ctx.beginPath();
        ctx.moveTo(lx, -sd / 2);
        ctx.lineTo(lx, sd / 2);
        ctx.stroke();
      }
      ctx.fillStyle = '#0F172A';
      ctx.font = `bold ${Math.round(9.5 * pScale)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(`UP F${st.fromFloor}→F${st.toFloor}`, 0, 3);
      ctx.restore();
    });

    // Walls (merged authoritative exterior + interior walls)
    const walls = extractMergedWalls(slice);
    walls.forEach((w) => {
      ctx.strokeStyle =
        mode === 'wiring'
          ? w.isExterior
            ? '#64748B'
            : '#94A3B8'
          : w.isExterior
            ? '#0F172A'
            : '#334155';
      ctx.lineWidth = Math.max(w.isExterior ? 3.2 : 2.0, w.thickness * pxPerM);
      ctx.lineCap = 'square';
      ctx.beginPath();
      ctx.moveTo(tx(w.x1), ty(w.y1));
      ctx.lineTo(tx(w.x2), ty(w.y2));
      ctx.stroke();
    });

    // Distinct Site Boundary vs Custom Floor Boundary outline
    if (flBounds.isCustom) {
      // Site perimeter in slate dashed
      ctx.strokeStyle = '#64748B';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(tx(0), ty(0), siteLengthM * pxPerM, siteWidthM * pxPerM);
      // Authoritative floor perimeter in cyan/indigo
      ctx.strokeStyle = flBounds.exceedsSite && !project.site.allowFloorExceedSite ? '#DC2626' : '#0284C7';
      ctx.lineWidth = 2.0;
      ctx.setLineDash([10, 4]);
      ctx.strokeRect(tx(0), ty(0), lengthM * pxPerM, widthM * pxPerM);
      ctx.setLineDash([]);
    } else if (fit.hasBoundaryOverflow) {
      ctx.strokeStyle = '#DC2626';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 5]);
      ctx.strokeRect(tx(0), ty(0), lengthM * pxPerM, widthM * pxPerM);
      ctx.setLineDash([]);
    }

    // Doors & Windows
    slice.openings.forEach((op) => {
      ctx.save();
      ctx.translate(tx(op.x), ty(op.y));
      ctx.rotate((op.rotation * Math.PI) / 180);
      const ow = op.width * pxPerM;
      if (op.kind === 'door') {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(-ow / 2, -5, ow, 10);
        ctx.strokeStyle = mode === 'wiring' ? '#D97706' : '#B45309';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(-ow / 2, 0);
        ctx.lineTo(-ow / 2, -ow);
        ctx.stroke();
        ctx.strokeStyle = '#D97706';
        ctx.lineWidth = 1.0;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.arc(-ow / 2, 0, ow, -Math.PI / 2, 0);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = '#E0F2FE';
        ctx.fillRect(-ow / 2, -4, ow, 8);
        ctx.strokeStyle = '#0284C7';
        ctx.lineWidth = 1.6;
        ctx.strokeRect(-ow / 2, -4, ow, 8);
        ctx.beginPath();
        ctx.moveTo(-ow / 2, 0);
        ctx.lineTo(ow / 2, 0);
        ctx.stroke();
      }
      ctx.restore();
    });

    // Authoritative Outer Dimension Chains (strictly inside rect)
    if (includeAnnotations) {
      const dimOffset = Math.round(24 * pScale);
      const topY = Math.max(topBannerBottom + Math.round(18 * pScale), ty(0) - dimOffset);
      const leftX = Math.max(rect.x + Math.round(36 * pScale), tx(0) - dimOffset);
      const dimFont = `bold ${Math.round(11 * pScale)}px monospace`;

      ctx.strokeStyle = '#0369A1';
      ctx.fillStyle = '#0369A1';
      ctx.lineWidth = 1.3;

      const boundPrefix = flBounds.isCustom ? 'FLOOR' : 'SITE';
      // Horizontal top dimension (authoritative floor/site length)
      ctx.beginPath();
      ctx.moveTo(tx(0), topY);
      ctx.lineTo(tx(lengthM), topY);
      ctx.moveTo(tx(0), topY - 5);
      ctx.lineTo(tx(0), topY + 5);
      ctx.moveTo(tx(lengthM), topY - 5);
      ctx.lineTo(tx(lengthM), topY + 5);
      ctx.stroke();
      ctx.font = dimFont;
      ctx.textAlign = 'center';
      ctx.fillText(
        `${boundPrefix}: ${formatLength(lengthM, units, 1)}`,
        (tx(0) + tx(lengthM)) / 2,
        topY - 6
      );

      // Vertical left dimension (authoritative floor/site width)
      ctx.beginPath();
      ctx.moveTo(leftX, ty(0));
      ctx.lineTo(leftX, ty(widthM));
      ctx.moveTo(leftX - 5, ty(0));
      ctx.lineTo(leftX + 5, ty(0));
      ctx.moveTo(leftX - 5, ty(widthM));
      ctx.lineTo(leftX + 5, ty(widthM));
      ctx.stroke();
      ctx.save();
      ctx.translate(leftX - 9, (ty(0) + ty(widthM)) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`${boundPrefix}: ${formatLength(widthM, units, 1)}`, 0, 0);
      ctx.restore();

      // If rooms extend beyond floor/site boundary, show actual geometry extent along bottom
      if (fit.hasBoundaryOverflow) {
        const botY = Math.min(rect.y + rect.h - Math.round(28 * pScale), ty(fit.worldMaxY) + Math.round(24 * pScale));
        ctx.strokeStyle = '#DC2626';
        ctx.fillStyle = '#DC2626';
        ctx.beginPath();
        ctx.moveTo(tx(fit.worldMinX), botY);
        ctx.lineTo(tx(fit.worldMaxX), botY);
        ctx.stroke();
        ctx.fillText(
          `ACTUAL GEOMETRY SPAN: ${formatLength(fit.worldMaxX - fit.worldMinX, units, 1)}`,
          (tx(fit.worldMinX) + tx(fit.worldMaxX)) / 2,
          botY - 5
        );
      }
      ctx.textAlign = 'left';
    }

    // Routed Electrical Cables (Wiring / Combined modes)
    if (mode === 'wiring' || mode === 'combined') {
      const wiringCfg = getWiringConfig(project);
      const stdColors = WIRE_STANDARD_COLORS[wiringCfg.standard];
      const allPointMap = new Map(project.points.map((p) => [p.id, p]));
      const floorWires = (project.wires ?? []).filter(
        (w) => w.floor === floor || w.fromFloor === floor || w.toFloor === floor
      );
      const usedWireLabelBoxes: Rect[] = [];
      let floorTotalRoutedM = 0;

      floorWires.forEach((w) => {
        const fromPt = allPointMap.get(w.fromPointId);
        const toPt = allPointMap.get(w.toPointId);
        if (!fromPt || !toPt) return;

        const lenM = computeWireLengthMeters(w, project);
        floorTotalRoutedM += lenM;
        const pts = [
          { x: fromPt.x, y: fromPt.y },
          ...(w.waypoints ?? []),
          { x: toPt.x, y: toPt.y },
        ];
        const color = w.color || stdColors[w.category] || '#EF4444';
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2.0, Math.min(3.8, w.lineThickness * (mode === 'wiring' ? 1.2 : 1.0)));
        ctx.setLineDash(w.lineStyle === 'dashed' ? [8, 4] : []);
        ctx.beginPath();
        pts.forEach((p, idx) => {
          const px = tx(p.x);
          const py = ty(p.y);
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw crisp bend vertices on wiring sheets so obstacle-aware / manual waypoints are unmistakable
        if (mode === 'wiring' && (w.waypoints?.length ?? 0) > 0) {
          ctx.fillStyle = color;
          (w.waypoints ?? []).forEach((wp) => {
            ctx.beginPath();
            ctx.arc(tx(wp.x), ty(wp.y), 2.8, 0, Math.PI * 2);
            ctx.fill();
          });
        }

        // Mid-segment label with collision check so labels stay crisp and never pile up
        const midIdx = Math.floor((pts.length - 1) / 2);
        const mx = (tx(pts[midIdx].x) + tx(pts[midIdx + 1].x)) / 2;
        const my = (ty(pts[midIdx].y) + ty(pts[midIdx + 1].y)) / 2;
        const tag = `${w.code}${w.cableSizeSqMm ? ` ${w.cableSizeSqMm}mm²` : ''} ${lenM.toFixed(1)}m`;
        const wFontSize = Math.round(9.5 * pScale);
        ctx.font = `bold ${wFontSize}px monospace`;
        const tw = ctx.measureText(tag).width + 8;
        const th = Math.round(14 * pScale);
        const box: Rect = { x: mx - tw / 2, y: my - th / 2, w: tw, h: th };
        const collides = usedWireLabelBoxes.some(
          (b) =>
            box.x < b.x + b.w + 3 &&
            box.x + box.w + 3 > b.x &&
            box.y < b.y + b.h + 3 &&
            box.y + box.h + 3 > b.y
        );
        if (includeAnnotations && !collides && mode === 'wiring') {
          usedWireLabelBoxes.push(box);
          ctx.fillStyle = 'rgba(255,255,255,0.95)';
          ctx.fillRect(box.x, box.y, box.w, box.h);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.0;
          ctx.strokeRect(box.x, box.y, box.w, box.h);
          ctx.fillStyle = '#0F172A';
          ctx.textAlign = 'center';
          ctx.fillText(tag, mx, my + Math.round(wFontSize * 0.35));
          ctx.textAlign = 'left';
        }
      });

      // Distinct Wiring Sheet Legend / Zero-Routes Engineering Notice (so W-01 is never visually identical to E-01)
      if (mode === 'wiring') {
        const stripH = Math.round(28 * pScale);
        const stripW = Math.min(rect.w - 220, Math.round(620 * pScale));
        const stripX = rect.x + rect.w - stripW - 14;
        const stripY = rect.y + rect.h - stripH - 10;

        if (floorWires.length === 0) {
          ctx.fillStyle = '#FFFBEB';
          ctx.fillRect(stripX, stripY, stripW, stripH);
          ctx.strokeStyle = '#D97706';
          ctx.lineWidth = 1.4;
          ctx.strokeRect(stripX, stripY, stripW, stripH);
          ctx.fillStyle = '#92400E';
          ctx.font = `bold ${Math.round(10.5 * pScale)}px monospace`;
          ctx.fillText(
            truncateText(
              ctx,
              `WIRING STATUS (${wiringCfg.standard}): 0.00 m ROUTED — Use Route Cable Tool or Auto-Route DB`,
              stripW - 16
            ),
            stripX + 8,
            stripY + Math.round(stripH * 0.66)
          );
        } else {
          ctx.fillStyle = 'rgba(248, 250, 252, 0.96)';
          ctx.fillRect(stripX, stripY, stripW, stripH);
          ctx.strokeStyle = '#0284C7';
          ctx.lineWidth = 1.2;
          ctx.strokeRect(stripX, stripY, stripW, stripH);
          ctx.fillStyle = '#0F172A';
          ctx.font = `bold ${Math.round(10.5 * pScale)}px monospace`;
          ctx.fillText(
            truncateText(
              ctx,
              `ROUTING (${wiringCfg.standard}): ${floorWires.length} run(s) · ${floorTotalRoutedM.toFixed(2)} m · L=Red  N=Slate  PE=Green  CTRL=Amber`,
              stripW - 16
            ),
            stripX + 8,
            stripY + Math.round(stripH * 0.66)
          );
        }
      }
    }

    // Electrical Symbols (Electrical / Wiring / Combined modes) with label de-confliction
    if (mode === 'electrical' || mode === 'wiring' || mode === 'combined') {
      const placedLabelBoxes: Rect[] = [];

      slice.points.forEach((pt) => {
        const px = tx(pt.x);
        const py = ty(pt.y);
        const color = CATEGORY_SYMBOL_COLORS[pt.category] ?? '#0284C7';
        const r = Math.max(6 * pScale, Math.min(9.5 * pScale, pxPerM * 0.15));

        if (pt.itemType === 'distribution_board') {
          const bw = r * 2.6;
          const bh = r * 1.9;
          ctx.fillStyle = '#FEF3C7';
          ctx.fillRect(px - bw / 2, py - bh / 2, bw, bh);
          ctx.strokeStyle = '#B45309';
          ctx.lineWidth = 2.2;
          ctx.strokeRect(px - bw / 2, py - bh / 2, bw, bh);
          // Standard IEC diagonal fill half on Distribution Board
          ctx.fillStyle = '#D97706';
          ctx.beginPath();
          ctx.moveTo(px - bw / 2, py + bh / 2);
          ctx.lineTo(px + bw / 2, py - bh / 2);
          ctx.lineTo(px + bw / 2, py + bh / 2);
          ctx.closePath();
          ctx.fill();
        } else if (pt.itemType === 'earthing_point') {
          ctx.fillStyle = '#DCFCE7';
          ctx.beginPath();
          ctx.arc(px, py, r + 2, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#15803D';
          ctx.lineWidth = 2.0;
          ctx.beginPath();
          ctx.moveTo(px, py - r + 1);
          ctx.lineTo(px, py + 1);
          ctx.moveTo(px - r * 0.85, py + 1);
          ctx.lineTo(px + r * 0.85, py + 1);
          ctx.moveTo(px - r * 0.55, py + 4);
          ctx.lineTo(px + r * 0.55, py + 4);
          ctx.moveTo(px - r * 0.25, py + 7);
          ctx.lineTo(px + r * 0.25, py + 7);
          ctx.stroke();
        } else {
          ctx.fillStyle = '#FFFFFF';
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = 2.1;
          ctx.stroke();
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(px, py, r * 0.38, 0, Math.PI * 2);
          ctx.fill();
        }

        // Collision-reduced point code label
        const lblFontSize = Math.round(9.5 * pScale);
        ctx.font = `bold ${lblFontSize}px monospace`;
        const tw = ctx.measureText(pt.code).width + 6;
        const th = Math.round(13 * pScale);
        const offsets = [
          { dx: r + 3, dy: -2 },
          { dx: r + 3, dy: th },
          { dx: -r - tw - 3, dy: -2 },
          { dx: -tw / 2, dy: -r - 4 },
          { dx: -tw / 2, dy: r + th },
        ];
        let chosenBox: Rect | null = null;
        for (const off of offsets) {
          const cand: Rect = { x: px + off.dx, y: py + off.dy - th * 0.78, w: tw, h: th };
          if (
            cand.x < rect.x + 6 ||
            cand.x + cand.w > rect.x + rect.w - 6 ||
            cand.y < rect.y + 6 ||
            cand.y + cand.h > rect.y + rect.h - 6
          ) {
            continue;
          }
          const overlaps = placedLabelBoxes.some(
            (b) =>
              cand.x < b.x + b.w + 2 &&
              cand.x + cand.w + 2 > b.x &&
              cand.y < b.y + b.h + 2 &&
              cand.y + cand.h + 2 > b.y
          );
          if (!overlaps) {
            chosenBox = cand;
            break;
          }
        }
        if (chosenBox) {
          placedLabelBoxes.push(chosenBox);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
          ctx.fillRect(chosenBox.x, chosenBox.y, chosenBox.w, chosenBox.h);
          ctx.fillStyle =
            pt.itemType === 'distribution_board'
              ? '#92400E'
              : pt.itemType === 'earthing_point'
                ? '#166534'
                : '#0F172A';
          ctx.fillText(pt.code, chosenBox.x + 3, chosenBox.y + Math.round(th * 0.78));
        }
      });
    }

    // North Arrow (top-right inside panel) & Graphic Scale Bar (bottom-left inside panel)
    drawNorthArrow(ctx, rect.x + rect.w - Math.round(36 * pScale), rect.y + Math.round(42 * pScale), Math.round(18 * pScale));
    drawGraphicScaleBar(
      ctx,
      rect.x + 18,
      rect.y + rect.h - Math.round(20 * pScale),
      pxPerM,
      units,
      Math.min(200, rect.w * 0.24)
    );
  });

  return fit;
}

/**
 * Pure bounding-box solver for the 3D Isometric projection panel.
 * Pre-projects all 3D vertices so the rendered building and its right-side floor callouts
 * are mathematically guaranteed to stay strictly inside `rect` with zero clipping or overlap.
 */
export function computeIsometricFit(project: ProjectData, rect: Rect): IsometricFitMetrics {
  const floors = getProjectFloors(project);
  const { lengthM, widthM } = siteToMeters(project.site);
  const cos30 = Math.cos(Math.PI / 6);
  const sin30 = 0.5;

  const rawIso = (x: number, y: number, z: number) => ({
    u: (x - y) * cos30,
    v: -(x + y) * sin30 * 0.72 - z,
  });

  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;

  const includePt = (x: number, y: number, z: number) => {
    const p = rawIso(x, y, z);
    if (p.u < minU) minU = p.u;
    if (p.u > maxU) maxU = p.u;
    if (p.v < minV) minV = p.v;
    if (p.v > maxV) maxV = p.v;
  };

  floors.forEach((fc) => {
    const flBounds = getFloorBoundaryMeters(project, fc.floor);
    const flL = flBounds.lengthM;
    const flW = flBounds.widthM;
    const z0 = fc.elevationM;
    const z1 = fc.elevationM + (fc.kind === 'terrace' ? 1.1 : fc.floorHeightM);
    // Floor boundary corners
    includePt(0, 0, z0);
    includePt(flL, 0, z0);
    includePt(flL, flW, z0);
    includePt(0, flW, z0);
    includePt(0, 0, z1);
    includePt(flL, 0, z1);
    includePt(flL, flW, z1);
    includePt(0, flW, z1);
    // Site corners (ground reference)
    includePt(lengthM, 0, z0);
    includePt(lengthM, widthM, z0);
    includePt(0, widthM, z0);

    // Room corners (in case any room extends beyond floor/site)
    project.rooms
      .filter((r) => getItemFloor(r) === fc.floor)
      .forEach((rm) => {
        const wallH = fc.kind === 'terrace' ? 1.1 : fc.floorHeightM;
        includePt(rm.x, rm.y, z0);
        includePt(rm.x + rm.width, rm.y, z0);
        includePt(rm.x + rm.width, rm.y + rm.height, z0);
        includePt(rm.x, rm.y + rm.height, z0);
        includePt(rm.x, rm.y, z0 + wallH);
        includePt(rm.x + rm.width, rm.y, z0 + wallH);
        includePt(rm.x + rm.width, rm.y + rm.height, z0 + wallH);
        includePt(rm.x, rm.y + rm.height, z0 + wallH);
      });
  });

  if (!Number.isFinite(minU)) {
    minU = -10;
    maxU = 10;
    minV = -10;
    maxV = 10;
  }

  const headerH = 44;
  const pad = 22;
  const labelW = Math.min(156, Math.max(108, Math.round(rect.w * 0.22)));

  const modelBox: Rect = {
    x: rect.x + pad,
    y: rect.y + headerH,
    w: Math.max(60, rect.w - pad * 2 - labelW - 10),
    h: Math.max(60, rect.h - headerH - pad),
  };

  const labelBox: Rect = {
    x: modelBox.x + modelBox.w + 10,
    y: rect.y + headerH,
    w: labelW,
    h: modelBox.h,
  };

  const spanU = Math.max(1, maxU - minU);
  const spanV = Math.max(1, maxV - minV);
  const scale = Math.min(modelBox.w / spanU, modelBox.h / spanV);

  const projW = spanU * scale;
  const projH = spanV * scale;
  const offsetX = modelBox.x + (modelBox.w - projW) / 2 - minU * scale;
  const offsetY = modelBox.y + (modelBox.h - projH) / 2 - minV * scale;

  return {
    scale,
    offsetX,
    offsetY,
    modelBox,
    labelBox,
    projectedMinX: offsetX + minU * scale,
    projectedMaxX: offsetX + maxU * scale,
    projectedMinY: offsetY + minV * scale,
    projectedMaxY: offsetY + maxV * scale,
  };
}

/**
 * Draws a crisp multi-storey 3D Isometric projection strictly inside `rect` with clipping.
 */
export function drawIsometricProjection(
  ctx: CanvasRenderingContext2D,
  project: ProjectData,
  rect: Rect
): IsometricFitMetrics {
  const floors = getProjectFloors(project);
  const { lengthM, widthM } = siteToMeters(project.site);
  const cos30 = Math.cos(Math.PI / 6);
  const sin30 = 0.5;
  const fit = computeIsometricFit(project, rect);
  const wiringCfg = getWiringConfig(project);
  const stdColors = WIRE_STANDARD_COLORS[wiringCfg.standard];

  const iso = (x: number, y: number, z: number) => ({
    sx: fit.offsetX + (x - y) * cos30 * fit.scale,
    sy: fit.offsetY + (-(x + y) * sin30 * 0.72 - z) * fit.scale,
  });

  withClip(ctx, rect, () => {
    ctx.fillStyle = '#F8FAFC';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(
      truncateText(ctx, '3D ISOMETRIC BUILDING PROJECTION (MULTI-STOREY & ROUTING)', rect.w - 28),
      rect.x + 14,
      rect.y + 24
    );

    const floorCallouts: Array<{ y: number; name: string; elev: string; anchorX: number; anchorY: number }> = [];

    floors.forEach((fc, idx) => {
      const slice = sliceProjectForFloor(project, fc.floor);
      const flBounds = getFloorBoundaryMeters(project, fc.floor);
      const flL = flBounds.lengthM;
      const flW = flBounds.widthM;
      const z0 = fc.elevationM;
      const wallH = fc.kind === 'terrace' ? 1.1 : fc.floorHeightM;

      // Authoritative Per-Floor Slab polygon
      const p0 = iso(0, 0, z0);
      const p1 = iso(flL, 0, z0);
      const p2 = iso(flL, flW, z0);
      const p3 = iso(0, flW, z0);

      ctx.fillStyle = idx % 2 === 0 ? 'rgba(226, 232, 240, 0.85)' : 'rgba(241, 245, 249, 0.88)';
      ctx.strokeStyle = flBounds.isCustom ? '#0284C7' : '#334155';
      ctx.lineWidth = flBounds.isCustom ? 1.8 : 1.4;
      ctx.beginPath();
      ctx.moveTo(p0.sx, p0.sy);
      ctx.lineTo(p1.sx, p1.sy);
      ctx.lineTo(p2.sx, p2.sy);
      ctx.lineTo(p3.sx, p3.sy);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Extruded room wireframe volumes
      slice.rooms.forEach((rm) => {
        const b0 = iso(rm.x, rm.y, z0);
        const b1 = iso(rm.x + rm.width, rm.y, z0);
        const b2 = iso(rm.x + rm.width, rm.y + rm.height, z0);
        const b3 = iso(rm.x, rm.y + rm.height, z0);

        const t0 = iso(rm.x, rm.y, z0 + wallH);
        const t1 = iso(rm.x + rm.width, rm.y, z0 + wallH);
        const t2 = iso(rm.x + rm.width, rm.y + rm.height, z0 + wallH);
        const t3 = iso(rm.x, rm.y + rm.height, z0 + wallH);

        ctx.fillStyle = 'rgba(255, 255, 255, 0.52)';
        ctx.strokeStyle = '#64748B';
        ctx.lineWidth = 0.9;

        // Back walls
        ctx.beginPath();
        ctx.moveTo(b0.sx, b0.sy);
        ctx.lineTo(b1.sx, b1.sy);
        ctx.lineTo(t1.sx, t1.sy);
        ctx.lineTo(t0.sx, t0.sy);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(b1.sx, b1.sy);
        ctx.lineTo(b2.sx, b2.sy);
        ctx.lineTo(t2.sx, t2.sy);
        ctx.lineTo(t1.sx, t1.sy);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Top rim
        ctx.strokeStyle = '#0F172A';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(t0.sx, t0.sy);
        ctx.lineTo(t1.sx, t1.sy);
        ctx.lineTo(t2.sx, t2.sy);
        ctx.lineTo(t3.sx, t3.sy);
        ctx.closePath();
        ctx.stroke();
      });

      // Electrical points in 3D isometric space
      slice.points.forEach((pt) => {
        const sp = iso(pt.x, pt.y, z0 + pt.z);
        const isDb = pt.itemType === 'distribution_board';
        const isEp = pt.itemType === 'earthing_point';
        ctx.fillStyle = isDb ? '#D97706' : isEp ? '#16A34A' : '#0284C7';
        ctx.beginPath();
        ctx.arc(sp.sx, sp.sy, isDb || isEp ? 4.5 : 2.6, 0, Math.PI * 2);
        ctx.fill();
      });

      const anchor = iso(Math.max(flL, lengthM), 0, z0 + wallH * 0.45);
      floorCallouts.push({
        y: anchor.sy,
        name: fc.name,
        elev: `${fc.elevationM >= 0 ? '+' : ''}${formatLength(fc.elevationM, project.site.units, 1)}`,
        anchorX: anchor.sx,
        anchorY: anchor.sy,
      });
    });

    // Routed 3D Wires in Isometric view
    const pointById = new Map(project.points.map((p) => [p.id, p]));
    (project.wires ?? []).forEach((w) => {
      const fromPt = pointById.get(w.fromPointId);
      const toPt = pointById.get(w.toPointId);
      if (!fromPt || !toPt) return;
      const fromFc = floors.find((f) => f.floor === getItemFloor(fromPt)) ?? floors[0];
      const toFc = floors.find((f) => f.floor === getItemFloor(toPt)) ?? floors[0];
      const zStart = fromFc.elevationM + fromPt.z;
      const zEnd = toFc.elevationM + toPt.z;
      const zRoute = Math.max(zStart, zEnd, fromFc.elevationM + fromFc.floorHeightM - 0.15);

      const pts3D = [
        iso(fromPt.x, fromPt.y, zStart),
        iso(fromPt.x, fromPt.y, zRoute),
        ...(w.waypoints ?? []).map((wp) => iso(wp.x, wp.y, zRoute)),
        iso(toPt.x, toPt.y, zRoute),
        iso(toPt.x, toPt.y, zEnd),
      ];

      ctx.strokeStyle = w.color || stdColors[w.category] || '#EF4444';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      pts3D.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.sx, p.sy);
        else ctx.lineTo(p.sx, p.sy);
      });
      ctx.stroke();
    });

    // Render non-overlapping right-side Floor Elevation Callouts strictly inside fit.labelBox
    floorCallouts.sort((a, b) => a.y - b.y);
    const minSpacing = 28;
    for (let i = 1; i < floorCallouts.length; i++) {
      if (floorCallouts[i].y < floorCallouts[i - 1].y + minSpacing) {
        floorCallouts[i].y = floorCallouts[i - 1].y + minSpacing;
      }
    }

    floorCallouts.forEach((c) => {
      const clampedY = Math.max(
        fit.labelBox.y + 14,
        Math.min(fit.labelBox.y + fit.labelBox.h - 14, c.y)
      );
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(c.anchorX, c.anchorY);
      ctx.lineTo(fit.labelBox.x - 4, clampedY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#0369A1';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(truncateText(ctx, c.name, fit.labelBox.w - 6), fit.labelBox.x + 2, clampedY - 2);
      ctx.fillStyle = '#475569';
      ctx.font = '10px monospace';
      ctx.fillText(
        truncateText(ctx, `EL ${c.elev}`, fit.labelBox.w - 6),
        fit.labelBox.x + 2,
        clampedY + 11
      );
    });
  });

  return fit;
}

/**
 * Pure layout solver for Architectural Elevation panels (Front/Rear/Left/Right).
 */
export function computeElevationFit(
  project: ProjectData,
  side: 'front' | 'rear' | 'left' | 'right',
  rect: Rect
): ElevationFitMetrics {
  const floors = getProjectFloors(project);
  const { lengthM, widthM } = siteToMeters(project.site);
  const isFrontRear = side === 'front' || side === 'rear';
  const siteSpanM = isFrontRear ? lengthM : widthM;
  const geomBounds = computeActualGeometryBounds(project);

  // Authoritative horizontal building facade span = max of site, per-floor boundaries, and actual geometry
  let maxFloorSpanM = siteSpanM;
  floors.forEach((fc) => {
    const fb = getFloorBoundaryMeters(project, fc.floor);
    const flSpan = isFrontRear ? fb.lengthM : fb.widthM;
    if (flSpan > maxFloorSpanM) maxFloorSpanM = flSpan;
  });
  const geomMax = geomBounds.hasGeometry ? (isFrontRear ? geomBounds.maxX : geomBounds.maxY) : 0;
  const wallWidthM = Math.max(1, maxFloorSpanM, geomMax);

  const minElevM = Math.min(0, ...floors.map((f) => f.elevationM));
  const maxElevM = Math.max(
    3,
    ...floors.map((f) => f.elevationM + (f.kind === 'terrace' ? 1.2 : f.floorHeightM + f.slabThicknessM))
  );
  const totalHeightM = Math.max(2, maxElevM - minElevM);

  const padLeft = Math.min(82, Math.max(54, Math.round(rect.w * 0.09)));
  const padRight = Math.min(165, Math.max(108, Math.round(rect.w * 0.18)));
  const padTop = 46;
  const padBottom = 60;

  const availW = Math.max(40, rect.w - padLeft - padRight);
  const availH = Math.max(40, rect.h - padTop - padBottom);
  const scale = Math.min(availW / wallWidthM, availH / totalHeightM);
  const drawW = wallWidthM * scale;
  const drawH = totalHeightM * scale;
  const baseX = rect.x + padLeft + (availW - drawW) / 2;
  const baseY = rect.y + padTop + availH;

  return {
    scale,
    baseX,
    baseY,
    drawW,
    drawH,
    wallWidthM,
    totalHeightM,
    minElevM,
    maxElevM,
  };
}

/**
 * Draws an architectural elevation (Front / Rear / Left / Right) strictly inside `rect` with clipping,
 * per-floor horizontal footprints (supporting setbacks & overhangs), real exterior doors & windows,
 * floor datum ticks, and overall horizontal + vertical dimensions.
 */
export function drawElevationPanel(
  ctx: CanvasRenderingContext2D,
  project: ProjectData,
  side: 'front' | 'rear' | 'left' | 'right',
  rect: Rect
): ElevationFitMetrics {
  const floors = getProjectFloors(project);
  const { lengthM, widthM } = siteToMeters(project.site);
  const units = project.site.units;
  const isFrontRear = side === 'front' || side === 'rear';
  const siteSpanM = isFrontRear ? lengthM : widthM;
  const fit = computeElevationFit(project, side, rect);
  const { scale, baseX, baseY, drawW, wallWidthM, minElevM, maxElevM } = fit;
  const zy = (z: number) => baseY - (z - minElevM) * scale;
  const pScale = Math.max(1.0, Math.min(1.35, Math.min(rect.w, rect.h) / 560));

  withClip(ctx, rect, () => {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

    const sideTitles: Record<typeof side, string> = {
      front: 'FRONT ELEVATION (SOUTH)',
      rear: 'REAR ELEVATION (NORTH)',
      left: 'LEFT ELEVATION (WEST)',
      right: 'RIGHT ELEVATION (EAST)',
    };
    ctx.fillStyle = '#0F172A';
    ctx.font = `bold ${Math.round(13 * pScale)}px sans-serif`;
    ctx.fillText(truncateText(ctx, sideTitles[side], rect.w - 24), rect.x + 14, rect.y + Math.round(24 * pScale));

    // Ground grade line
    const groundY = zy(0);
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(baseX - 18, groundY);
    ctx.lineTo(baseX + drawW + 18, groundY);
    ctx.stroke();

    // Draw each floor facade band at its actual per-floor footprint + actual architectural openings
    const rightDatumX = baseX + drawW + 8;
    const datumMaxW = Math.max(44, rect.x + rect.w - rightDatumX - 6);

    floors.forEach((fc) => {
      const flBounds = getFloorBoundaryMeters(project, fc.floor);
      const slice = sliceProjectForFloor(project, fc.floor);
      const roomMinX = slice.rooms.length > 0 ? Math.min(...slice.rooms.map((r) => r.x)) : 0;
      const roomMaxX =
        slice.rooms.length > 0 ? Math.max(...slice.rooms.map((r) => r.x + r.width)) : flBounds.lengthM;
      const roomMinY = slice.rooms.length > 0 ? Math.min(...slice.rooms.map((r) => r.y)) : 0;
      const roomMaxY =
        slice.rooms.length > 0 ? Math.max(...slice.rooms.map((r) => r.y + r.height)) : flBounds.widthM;

      const floorSpanM = Math.max(
        isFrontRear ? flBounds.lengthM : flBounds.widthM,
        slice.rooms.length > 0 ? (isFrontRear ? roomMaxX : roomMaxY) : 0
      );
      const flDrawW = Math.min(drawW, Math.max(1, floorSpanM) * scale);

      const yBottom = zy(fc.elevationM);
      const storeyH = fc.kind === 'terrace' ? 1.15 : fc.floorHeightM;
      const yTop = zy(fc.elevationM + storeyH);
      const bandH = yBottom - yTop;

      // Exterior facade wall band sized to actual floor span
      ctx.fillStyle = fc.kind === 'basement' ? '#E2E8F0' : fc.kind === 'terrace' ? '#F8FAFC' : '#F1F5F9';
      ctx.fillRect(baseX, yTop, flDrawW, bandH);
      ctx.strokeStyle = '#0F172A';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(baseX, yTop, flDrawW, bandH);

      // Floor slab band
      const slabH = Math.max(3, fc.slabThicknessM * scale);
      ctx.fillStyle = '#94A3B8';
      ctx.fillRect(baseX, yBottom - 1, flDrawW, slabH);

      // Exterior openings matching either floor perimeter OR outermost room facade on this side
      slice.openings.forEach((op) => {
        const tol = 0.65;
        const matchesSide =
          (side === 'front' &&
            (Math.abs(op.y - flBounds.widthM) <= tol || Math.abs(op.y - roomMaxY) <= tol)) ||
          (side === 'rear' && (Math.abs(op.y) <= tol || Math.abs(op.y - roomMinY) <= tol)) ||
          (side === 'left' && (Math.abs(op.x) <= tol || Math.abs(op.x - roomMinX) <= tol)) ||
          (side === 'right' &&
            (Math.abs(op.x - flBounds.lengthM) <= tol || Math.abs(op.x - roomMaxX) <= tol));
        if (!matchesSide) return;

        const rawPos = isFrontRear ? op.x : op.y;
        const clampedPos = Math.max(op.width / 2, Math.min(floorSpanM - op.width / 2, rawPos));
        const ox = baseX + (clampedPos - op.width / 2) * scale;
        const ow = Math.max(6, op.width * scale);

        if (op.kind === 'door') {
          const doorH = Math.min(2.1, storeyH - 0.2) * scale;
          ctx.fillStyle = '#FEF3C7';
          ctx.fillRect(ox, yBottom - doorH, ow, doorH);
          ctx.strokeStyle = '#92400E';
          ctx.lineWidth = 1.4;
          ctx.strokeRect(ox, yBottom - doorH, ow, doorH);
          ctx.fillStyle = '#92400E';
          ctx.beginPath();
          ctx.arc(ox + ow * 0.82, yBottom - doorH * 0.48, 1.8, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const sillH = Math.min(0.9, storeyH * 0.3) * scale;
          const winH = Math.min(1.25, storeyH * 0.42) * scale;
          ctx.fillStyle = '#BAE6FD';
          ctx.fillRect(ox, yBottom - sillH - winH, ow, winH);
          ctx.strokeStyle = '#0369A1';
          ctx.lineWidth = 1.3;
          ctx.strokeRect(ox, yBottom - sillH - winH, ow, winH);
          ctx.beginPath();
          ctx.moveTo(ox + ow / 2, yBottom - sillH - winH);
          ctx.lineTo(ox + ow / 2, yBottom - sillH);
          ctx.stroke();
        }
      });

      // Right-side elevation datum callout (strictly inside rect)
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 0.9;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(baseX + flDrawW, yBottom);
      ctx.lineTo(rightDatumX + 4, yBottom);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#334155';
      ctx.font = `bold ${Math.round(10 * pScale)}px monospace`;
      const datumTxt = `${fc.name} (${fc.elevationM >= 0 ? '+' : ''}${formatLength(fc.elevationM, units, 1)})`;
      ctx.fillText(truncateText(ctx, datumTxt, datumMaxW), rightDatumX + 5, yBottom + 3);
    });

    // If building facade exceeds site limit, show explicit red dashed site-limit marker line
    if (wallWidthM > siteSpanM + 0.05) {
      const siteLimitX = baseX + siteSpanM * scale;
      ctx.strokeStyle = '#DC2626';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(siteLimitX, zy(maxElevM) - 8);
      ctx.lineTo(siteLimitX, baseY + 6);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#DC2626';
      ctx.font = `bold ${Math.round(9.5 * pScale)}px monospace`;
      ctx.fillText(`SITE (${formatLength(siteSpanM, units, 1)})`, siteLimitX + 4, zy(maxElevM) + 6);
    }

    // Roof top elevation datum
    const roofY = zy(maxElevM);
    ctx.fillStyle = '#0F172A';
    ctx.font = `bold ${Math.round(10 * pScale)}px monospace`;
    ctx.fillText(
      truncateText(ctx, `ROOF (+${formatLength(maxElevM, units, 1)})`, datumMaxW),
      rightDatumX + 5,
      roofY + 4
    );

    // Left-side overall vertical building height dimension chain
    const dimX = Math.max(rect.x + 26, baseX - 24);
    ctx.strokeStyle = '#0369A1';
    ctx.fillStyle = '#0369A1';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(dimX, zy(minElevM));
    ctx.lineTo(dimX, roofY);
    ctx.moveTo(dimX - 4, zy(minElevM));
    ctx.lineTo(dimX + 4, zy(minElevM));
    ctx.moveTo(dimX - 4, roofY);
    ctx.lineTo(dimX + 4, roofY);
    ctx.stroke();
    ctx.save();
    ctx.translate(dimX - 8, (zy(minElevM) + roofY) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.font = `bold ${Math.round(10.5 * pScale)}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(`H: ${formatLength(maxElevM - minElevM, units, 1)}`, 0, 0);
    ctx.restore();

    // Bottom overall horizontal width dimension chain
    const dimY = Math.min(rect.y + rect.h - 14, baseY + 30);
    ctx.beginPath();
    ctx.moveTo(baseX, dimY);
    ctx.lineTo(baseX + drawW, dimY);
    ctx.moveTo(baseX, dimY - 4);
    ctx.lineTo(baseX, dimY + 4);
    ctx.moveTo(baseX + drawW, dimY - 4);
    ctx.lineTo(baseX + drawW, dimY + 4);
    ctx.stroke();
    ctx.font = `bold ${Math.round(11 * pScale)}px monospace`;
    ctx.textAlign = 'center';
    const widthLbl =
      wallWidthM > siteSpanM + 0.05
        ? `FACADE: ${formatLength(wallWidthM, units, 1)} (SITE: ${formatLength(siteSpanM, units, 1)})`
        : `WIDTH: ${formatLength(wallWidthM, units, 1)}`;
    ctx.fillText(widthLbl, baseX + drawW / 2, dimY - 6);
    ctx.textAlign = 'left';
  });

  return fit;
}

function drawCoverSheet(
  ctx: CanvasRenderingContext2D,
  project: ProjectData,
  reconciled: ReconciledElectricalSchedule,
  rect: Rect,
  sheetIndex: Array<{ sheetNo: string; title: string }>
) {
  const units = project.site.units;
  const buildingTypeLabel = BUILDING_TYPE_LABELS[inferBuildingType(project)];
  const ui = getUiScale(rect.w, rect.h);

  withClip(ctx, rect, () => {
    // Banner
    const bannerH = Math.round(112 * ui);
    ctx.fillStyle = '#0F172A';
    ctx.fillRect(rect.x, rect.y, rect.w, bannerH);
    ctx.fillStyle = '#38BDF8';
    ctx.font = `bold ${Math.round(13 * ui)}px monospace`;
    ctx.fillText('ARCHITECTURAL & ELECTRICAL ENGINEERING DRAWING PACKAGE', rect.x + Math.round(22 * ui), rect.y + Math.round(30 * ui));
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold ${Math.round(29 * ui)}px sans-serif`;
    ctx.fillText(truncateText(ctx, project.name, rect.w - Math.round(44 * ui)), rect.x + Math.round(22 * ui), rect.y + Math.round(70 * ui));
    ctx.fillStyle = '#CBD5E1';
    ctx.font = `${Math.round(13 * ui)}px monospace`;
    const subBanner = `REF: ${project.refCode}  |  ${project.projectType ?? 'Residential'}  |  ${buildingTypeLabel} (${reconciled.floorRows.length} Floor${reconciled.floorRows.length === 1 ? '' : 's'})  |  Units: ${units.toUpperCase()}`;
    ctx.fillText(truncateText(ctx, subBanner, rect.w - Math.round(44 * ui)), rect.x + Math.round(22 * ui), rect.y + Math.round(96 * ui));

    // KPI Cards Row (Responsive 5 cards — 100% reconciled with schedules)
    const kpiY = rect.y + bannerH + Math.round(16 * ui);
    const kpiGap = Math.round(12 * ui);
    const kpiW = Math.floor((rect.w - kpiGap * 4) / 5);
    const kpiH = Math.round(88 * ui);
    const kpis = [
      {
        label: 'SITE AREA',
        val: `${project.site.length} ${units} × ${project.site.width} ${units}`,
        sub: `Site: ${formatArea(reconciled.siteFootprintAreaSqM, units)} · Bldg: ${formatArea(reconciled.buildingFootprintAreaSqM, units)}`,
      },
      {
        label: 'TOTAL BUILT-UP ROOM AREA',
        val: formatArea(reconciled.totalBuiltUpAreaSqM, units),
        sub: `${project.rooms.length} room(s) · Open/Void: ${formatArea(reconciled.totalExcludedOpenAreaSqM, units)}`,
      },
      {
        label: 'ELECTRICAL ITEMS',
        val: `${reconciled.totalElectricalItems} Total`,
        sub: `${reconciled.branchLoadPointsCount} Branch + ${reconciled.distributionEquipmentCount} DB/PE`,
      },
      {
        label: 'CONNECTED LOAD',
        val: `${reconciled.totalConnectedLoadKw.toFixed(2)} kW`,
        sub: `${reconciled.totalConnectedLoadWatts.toLocaleString('en-IN')} W · ${reconciled.estimatedCurrentAmps} A`,
      },
      {
        label: 'ROUTED CABLES & STATUS',
        val: `${reconciled.totalWireLengthM.toFixed(2)} m`,
        sub: `${reconciled.totalWires} run(s) · ${reconciled.errorCount} ERR / ${reconciled.warningCount} WARN`,
      },
    ];

    kpis.forEach((k, idx) => {
      const kx = rect.x + idx * (kpiW + kpiGap);
      ctx.fillStyle = '#F8FAFC';
      ctx.fillRect(kx, kpiY, kpiW, kpiH);
      ctx.strokeStyle = '#CBD5E1';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(kx, kpiY, kpiW, kpiH);
      ctx.fillStyle = '#64748B';
      ctx.font = `bold ${Math.round(10.5 * ui)}px sans-serif`;
      ctx.fillText(truncateText(ctx, k.label, kpiW - 20), kx + 12, kpiY + Math.round(22 * ui));
      ctx.fillStyle = '#0F172A';
      ctx.font = `bold ${Math.round(17.5 * ui)}px monospace`;
      ctx.fillText(truncateText(ctx, k.val, kpiW - 20), kx + 12, kpiY + Math.round(52 * ui));
      ctx.fillStyle = '#475569';
      ctx.font = `${Math.round(10.5 * ui)}px sans-serif`;
      ctx.fillText(truncateText(ctx, k.sub, kpiW - 20), kx + 12, kpiY + Math.round(74 * ui));
    });

    // Reconciled Area Taxonomy Ribbon (distinguishing Site, Building Footprint, Floor Footprints, Built-Up Room Area & Excluded/Open Area)
    const ribbonY = kpiY + kpiH + Math.round(12 * ui);
    const ribbonH = Math.round(34 * ui);
    ctx.fillStyle = '#F0F9FF';
    ctx.fillRect(rect.x, ribbonY, rect.w, ribbonH);
    ctx.strokeStyle = '#7DD3FC';
    ctx.lineWidth = 1.1;
    ctx.strokeRect(rect.x, ribbonY, rect.w, ribbonH);
    ctx.fillStyle = '#0C4A6E';
    ctx.font = `bold ${Math.round(11 * ui)}px monospace`;
    const areaSummaryLine = `AREA RECONCILIATION  |  Site Area: ${formatArea(reconciled.siteFootprintAreaSqM, units)}  |  Building Footprint: ${formatArea(reconciled.buildingFootprintAreaSqM, units)}  |  Gross Floor Footprints: ${formatArea(reconciled.totalFloorFootprintAreaSqM, units)}  |  Total Room Built-Up: ${formatArea(reconciled.totalBuiltUpAreaSqM, units)}  |  Open/Void: ${formatArea(reconciled.totalExcludedOpenAreaSqM, units)}  |  Geom Span: ${formatLength(reconciled.actualGeometrySpanXM, units, 1)} × ${formatLength(reconciled.actualGeometrySpanYM, units, 1)}`;
    ctx.fillText(truncateText(ctx, areaSummaryLine, rect.w - 24), rect.x + 12, ribbonY + Math.round(ribbonH * 0.65));

    // Two-column layout below Area Ribbon
    const contentY = ribbonY + ribbonH + Math.round(18 * ui);
    const availH = rect.y + rect.h - contentY - 12;
    const isPortrait = rect.w < rect.h * 0.92;

    const indexRect: Rect = isPortrait
      ? { x: rect.x, y: contentY, w: rect.w, h: Math.floor(availH * 0.48) }
      : { x: rect.x, y: contentY, w: Math.floor(rect.w * 0.39), h: availH };

    const floorRect: Rect = isPortrait
      ? { x: rect.x, y: contentY + indexRect.h + 16, w: rect.w, h: availH - indexRect.h - 16 }
      : {
          x: rect.x + indexRect.w + Math.round(18 * ui),
          y: contentY,
          w: rect.w - indexRect.w - Math.round(18 * ui),
          h: availH,
        };

    const hdrFont = `bold ${Math.round(13.5 * ui)}px sans-serif`;
    const tblFont = Math.round(11.5 * ui);
    const tblRowH = Math.round(26 * ui);
    const tblHdrH = Math.round(30 * ui);

    // Sheet Index Table
    ctx.fillStyle = '#0F172A';
    ctx.font = hdrFont;
    ctx.fillText('DRAWING SHEET INDEX', indexRect.x, indexRect.y + Math.round(16 * ui));
    drawAlignedTable(
      ctx,
      { x: indexRect.x, y: indexRect.y + Math.round(24 * ui), w: indexRect.w, h: indexRect.h - Math.round(24 * ui) },
      [
        { label: 'SHEET', widthFrac: 0.2 },
        { label: 'DRAWING DESCRIPTION', widthFrac: 0.8 },
      ],
      sheetIndex.map((s) => ({ cells: [s.sheetNo, s.title] })),
      { rowHeight: tblRowH, headerHeight: tblHdrH, fontSize: tblFont }
    );

    // Reconciled Floor Schedule Table (independent per-floor dimensions, footprints, room areas, open/void, items, cables & load)
    ctx.fillStyle = '#0F172A';
    ctx.font = hdrFont;
    ctx.fillText('FLOOR SCHEDULE, BOUNDARIES & AREA RECONCILIATION', floorRect.x, floorRect.y + Math.round(16 * ui));

    const allFloorRows = reconciled.orphanedFloorRow
      ? [...reconciled.floorRows, reconciled.orphanedFloorRow]
      : reconciled.floorRows;

    const floorTableRows: Array<{ cells: string[]; style?: TableRowStyle }> = allFloorRows.map(
      (fr) => ({
        cells: [
          fr.name,
          fr.isOrphaned
            ? 'N/A'
            : `${formatLength(fr.floorLengthM, units, 0)}×${formatLength(fr.floorWidthM, units, 0)}${fr.isCustomBoundary ? '*' : ''}`,
          fr.isOrphaned ? 'N/A' : formatArea(fr.floorFootprintAreaSqM, units),
          `${formatArea(fr.builtUpAreaSqM, units)} (${fr.roomCount})`,
          fr.isOrphaned ? 'N/A' : formatArea(fr.excludedOpenAreaSqM, units),
          String(fr.pointCount),
          `${fr.routedLengthM.toFixed(1)} m`,
          `${fr.loadWatts} W`,
        ],
        style: fr.isOrphaned
          ? { fill: '#FEF2F2', textColor: '#B91C1C', bold: true }
          : undefined,
      })
    );

    floorTableRows.push({
      cells: [
        'TOTAL (RECONCILED)',
        `${reconciled.floorRows.length} Lvls`,
        formatArea(reconciled.totalFloorFootprintAreaSqM, units),
        `${formatArea(reconciled.totalBuiltUpAreaSqM, units)} (${project.rooms.length})`,
        formatArea(reconciled.totalExcludedOpenAreaSqM, units),
        String(reconciled.totalElectricalItems),
        `${reconciled.totalWireLengthM.toFixed(1)} m`,
        `${reconciled.totalConnectedLoadWatts} W`,
      ],
      style: { fill: '#E0F2FE', textColor: '#0C4A6E', bold: true },
    });

    drawAlignedTable(
      ctx,
      { x: floorRect.x, y: floorRect.y + Math.round(24 * ui), w: floorRect.w, h: floorRect.h - Math.round(24 * ui) },
      [
        { label: 'FLOOR', widthFrac: 0.17 },
        { label: 'BOUNDARY', widthFrac: 0.14, align: 'right' },
        { label: 'FLOOR AREA', widthFrac: 0.13, align: 'right' },
        { label: 'ROOM BUILT-UP', widthFrac: 0.17, align: 'right' },
        { label: 'OPEN / VOID', widthFrac: 0.12, align: 'right' },
        { label: 'ITEMS', widthFrac: 0.07, align: 'right' },
        { label: 'CABLE', widthFrac: 0.1, align: 'right' },
        { label: 'LOAD', widthFrac: 0.1, align: 'right' },
      ],
      floorTableRows,
      { rowHeight: tblRowH + 2, headerHeight: tblHdrH, fontSize: Math.max(10.5, tblFont - 0.5) }
    );
  });
}

function drawDbAndScheduleSheet(
  ctx: CanvasRenderingContext2D,
  project: ProjectData,
  reconciled: ReconciledElectricalSchedule,
  rect: Rect
) {
  const wiringCfg = getWiringConfig(project);
  const stdColors = WIRE_STANDARD_COLORS[wiringCfg.standard];
  const ui = getUiScale(rect.w, rect.h);

  withClip(ctx, rect, () => {
    let cursorY = rect.y;

    // Top row: DB & Earthing Detail Cards side-by-side
    const gap = Math.round(18 * ui);
    const halfW = Math.floor((rect.w - gap) / 2);
    const cardH = Math.round(168 * ui);

    // Main Distribution Board Card
    ctx.fillStyle = '#FFFBEB';
    ctx.fillRect(rect.x, cursorY, halfW, cardH);
    ctx.strokeStyle = '#D97706';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(rect.x, cursorY, halfW, cardH);
    ctx.fillStyle = '#92400E';
    ctx.font = `bold ${Math.round(13.5 * ui)}px sans-serif`;
    ctx.fillText('DISTRIBUTION BOARD SCHEDULE (DB)', rect.x + 14, cursorY + Math.round(24 * ui));

    if (reconciled.dbPoints.length === 0) {
      ctx.fillStyle = '#B91C1C';
      ctx.font = `bold ${Math.round(12.5 * ui)}px sans-serif`;
      ctx.fillText(
        truncateText(
          ctx,
          'ERROR: No Main Distribution Board placed. Use "Add Missing DB & Earthing" in Design Studio.',
          halfW - 28
        ),
        rect.x + 14,
        cursorY + Math.round(58 * ui)
      );
    } else {
      let y = cursorY + Math.round(48 * ui);
      reconciled.dbPoints.slice(0, 2).forEach((db) => {
        const cfg = db.dbConfig;
        ctx.fillStyle = '#0F172A';
        ctx.font = `bold ${Math.round(12.5 * ui)}px monospace`;
        ctx.fillText(
          truncateText(
            ctx,
            `${db.code} — ${db.name} (${getFloorLabel(project, getItemFloor(db))})`,
            halfW - 28
          ),
          rect.x + 14,
          y
        );
        ctx.fillStyle = '#334155';
        ctx.font = `${Math.round(11.5 * ui)}px monospace`;
        ctx.fillText(
          truncateText(
            ctx,
            `Location: (${db.x.toFixed(2)}m, ${db.y.toFixed(2)}m) · Mount Z=${db.z.toFixed(2)}m`,
            halfW - 28
          ),
          rect.x + 14,
          y + Math.round(20 * ui)
        );
        ctx.fillText(
          truncateText(
            ctx,
            `Spec: ${cfg?.phaseType ?? '1Φ'} · ${cfg?.incomingRatingAmps ?? 63}A Incomer · ${cfg?.waysCount ?? 12} Ways · ${cfg?.rccbSensitivityMa ?? 30}mA RCCB`,
            halfW - 28
          ),
          rect.x + 14,
          y + Math.round(38 * ui)
        );
        y += Math.round(58 * ui);
      });
    }

    // Main Earthing Point Card
    const rightX = rect.x + halfW + gap;
    ctx.fillStyle = '#F0FDF4';
    ctx.fillRect(rightX, cursorY, halfW, cardH);
    ctx.strokeStyle = '#16A34A';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(rightX, cursorY, halfW, cardH);
    ctx.fillStyle = '#166534';
    ctx.font = `bold ${Math.round(13.5 * ui)}px sans-serif`;
    ctx.fillText('EARTHING / GROUNDING SCHEDULE (PE)', rightX + 14, cursorY + Math.round(24 * ui));

    if (reconciled.earthingPoints.length === 0) {
      ctx.fillStyle = '#B91C1C';
      ctx.font = `bold ${Math.round(12.5 * ui)}px sans-serif`;
      ctx.fillText(
        truncateText(
          ctx,
          'ERROR: No Main Earthing Point placed. Use "Add Missing DB & Earthing" in Design Studio.',
          halfW - 28
        ),
        rightX + 14,
        cursorY + Math.round(58 * ui)
      );
    } else {
      let y = cursorY + Math.round(48 * ui);
      reconciled.earthingPoints.slice(0, 2).forEach((ep) => {
        const cfg = ep.earthingConfig;
        ctx.fillStyle = '#0F172A';
        ctx.font = `bold ${Math.round(12.5 * ui)}px monospace`;
        ctx.fillText(
          truncateText(
            ctx,
            `${ep.code} — ${ep.name} (${getFloorLabel(project, getItemFloor(ep))})`,
            halfW - 28
          ),
          rightX + 14,
          y
        );
        ctx.fillStyle = '#334155';
        ctx.font = `${Math.round(11.5 * ui)}px monospace`;
        ctx.fillText(
          truncateText(
            ctx,
            `Location: (${ep.x.toFixed(2)}m, ${ep.y.toFixed(2)}m) · Type: ${cfg?.earthingType ?? 'Copper Plate'}`,
            halfW - 28
          ),
          rightX + 14,
          y + Math.round(20 * ui)
        );
        ctx.fillText(
          truncateText(
            ctx,
            `Target Resistance <= ${cfg?.targetResistanceOhm ?? 2.0} Ω · PE Conductor: ${cfg?.earthConductorSizeSqMm ?? 4.0} sq.mm Cu`,
            halfW - 28
          ),
          rightX + 14,
          y + Math.round(38 * ui)
        );
        y += Math.round(58 * ui);
      });
    }

    cursorY += cardH + Math.round(20 * ui);

    // Reconciled Circuit Schedule Table
    ctx.fillStyle = '#0F172A';
    ctx.font = `bold ${Math.round(13.5 * ui)}px sans-serif`;
    ctx.fillText(
      'RECONCILED CIRCUIT SCHEDULE, CONFIGURED CABLE SIZES & ROUTED LENGTHS',
      rect.x,
      cursorY + Math.round(15 * ui)
    );

    const circuitTableRows: Array<{ cells: string[]; style?: TableRowStyle }> =
      reconciled.circuitRows.map((c) => ({
        cells: [
          c.circuit,
          String(c.pointCount),
          `${c.loadWatts} W`,
          `${c.currentAmps.toFixed(1)} A`,
          c.cableSizeSqMm !== null ? `${c.cableSizeSqMm} sq.mm ${c.cableMaterial}` : 'Unset',
          c.rangeLabel,
          `${c.routedLengthM.toFixed(2)} m (${c.routedWireCount})`,
          c.statusNote,
        ],
        style:
          c.kind === 'distribution'
            ? { fill: '#FFFBEB', textColor: '#92400E', bold: true }
            : c.kind === 'unassigned'
              ? { fill: '#FEF2F2', textColor: '#B91C1C', bold: true }
              : undefined,
      }));

    circuitTableRows.push({
      cells: [
        'RECONCILED TOTAL (ALL ITEMS)',
        String(reconciled.totalElectricalItems),
        `${reconciled.totalConnectedLoadWatts} W (${reconciled.totalConnectedLoadKw} kW)`,
        `${reconciled.estimatedCurrentAmps.toFixed(1)} A`,
        '—',
        '—',
        `${reconciled.totalWireLengthM.toFixed(2)} m (${reconciled.totalWires})`,
        reconciled.errorCount === 0 ? 'Reconciled' : `${reconciled.errorCount} ERR`,
      ],
      style: { fill: '#E0F2FE', textColor: '#0C4A6E', bold: true },
    });

    const tableBottom = drawAlignedTable(
      ctx,
      {
        x: rect.x,
        y: cursorY + Math.round(24 * ui),
        w: rect.w,
        h: Math.max(Math.round(240 * ui), rect.y + rect.h - cursorY - Math.round(170 * ui)),
      },
      [
        { label: 'CIRCUIT / EQUIPMENT GROUP', widthFrac: 0.24 },
        { label: 'ITEMS', widthFrac: 0.07, align: 'right' },
        { label: 'LOAD', widthFrac: 0.13, align: 'right' },
        { label: 'EST. AMPS', widthFrac: 0.09, align: 'right' },
        { label: 'SELECTED CABLE', widthFrac: 0.15 },
        { label: 'DESIGN RANGE', widthFrac: 0.1 },
        { label: 'ROUTED LENGTH', widthFrac: 0.13, align: 'right' },
        { label: 'STATUS', widthFrac: 0.09, align: 'center' },
      ],
      circuitTableRows,
      { rowHeight: Math.round(30 * ui), headerHeight: Math.round(32 * ui), fontSize: Math.round(11.5 * ui) }
    );

    // Bottom: Wire Color Legend & Routed Length by Conductor Category
    const legendY = tableBottom + Math.round(22 * ui);
    if (legendY + Math.round(80 * ui) < rect.y + rect.h) {
      ctx.fillStyle = '#0F172A';
      ctx.font = `bold ${Math.round(13 * ui)}px sans-serif`;
      ctx.fillText(
        `CONDUCTOR COLOR LEGEND (${wiringCfg.standard}) & ROUTED CABLE SUMMARY`,
        rect.x,
        legendY + Math.round(14 * ui)
      );

      const categories = Object.keys(WIRE_CATEGORY_LABELS) as WireCategory[];
      const legY = legendY + Math.round(24 * ui);
      const legH = Math.round(54 * ui);
      const cellW = Math.floor(rect.w / categories.length);
      categories.forEach((cat, idx) => {
        const lx = rect.x + idx * cellW;
        ctx.fillStyle = '#F8FAFC';
        ctx.fillRect(lx, legY, cellW - 10, legH);
        ctx.strokeStyle = '#CBD5E1';
        ctx.lineWidth = 1.1;
        ctx.strokeRect(lx, legY, cellW - 10, legH);

        ctx.strokeStyle = stdColors[cat];
        ctx.lineWidth = 4.5;
        ctx.beginPath();
        ctx.moveTo(lx + 12, legY + Math.round(20 * ui));
        ctx.lineTo(lx + 40, legY + Math.round(20 * ui));
        ctx.stroke();

        ctx.fillStyle = '#0F172A';
        ctx.font = `bold ${Math.round(11 * ui)}px sans-serif`;
        ctx.fillText(truncateText(ctx, WIRE_CATEGORY_LABELS[cat], cellW - 58), lx + 46, legY + Math.round(23 * ui));
        ctx.fillStyle = '#0369A1';
        ctx.font = `bold ${Math.round(12 * ui)}px monospace`;
        ctx.fillText(
          `${reconciled.wireLengthByCategory[cat].toFixed(2)} m`,
          lx + 12,
          legY + Math.round(44 * ui)
        );
      });

      const noteY = legY + legH + Math.round(20 * ui);
      if (noteY < rect.y + rect.h - 10) {
        ctx.fillStyle = '#475569';
        ctx.font = `${Math.round(11 * ui)}px sans-serif`;
        ctx.fillText(
          truncateText(
            ctx,
            'Engineering Note: Lighting (1.5–2.5 sq.mm) and Power (2.5–4.0 sq.mm) are configurable design inputs. Verify breaker ratings, voltage drop, and IS 732 / NEC compliance prior to installation.',
            rect.w
          ),
          rect.x,
          noteY
        );
      }
    }
  });
}

function drawSummaryAndDiagnosticsSheets(
  project: ProjectData,
  reconciled: ReconciledElectricalSchedule,
  widthPx: number,
  heightPx: number,
  commonMeta: {
    projectName: string;
    refCode: string;
    units: string;
    buildingTypeLabel: string;
    dateStr: string;
  },
  wireProcurementAllowancePct: number = DEFAULT_INSTALLATION_ALLOWANCE_PCT
): Array<{ sheetNo: string; title: string; draw: (ctx: CanvasRenderingContext2D, pageIndex: number, pageTotal: number) => void }> {
  const boq = computeReconciledBoq(project);
  const wireSummary = computeWireConsumptionSummary(project, {
    procurementAllowancePct: wireProcurementAllowancePct,
  });
  const ui = getUiScale(widthPx, heightPx);
  const pages: Array<{
    sheetNo: string;
    title: string;
    draw: (ctx: CanvasRenderingContext2D, pageIndex: number, pageTotal: number) => void;
  }> = [];

  // Sort diagnostics by severity: ERROR -> WARNING -> INFO
  const severityRank: Record<'error' | 'warning' | 'info', number> = {
    error: 0,
    warning: 1,
    info: 2,
  };
  const sortedIssues = [...reconciled.issues].sort(
    (a, b) => severityRank[a.severity] - severityRank[b.severity]
  );

  // Page S-01: Reconciled Electrical BOQ (100% matching Excel BOQ) + Floor Subtotals + First Diagnostics Batch
  const s01MaxIssues = 8;
  const firstIssues = sortedIssues.slice(0, s01MaxIssues);
  const remainingIssues = sortedIssues.slice(s01MaxIssues);

  pages.push({
    sheetNo: 'S-01',
    title: 'PROJECT SUMMARY, RECONCILED BOQ & DIAGNOSTICS',
    draw: (ctx, pageIndex, pageTotal) => {
      const rect = drawTitleBlockAndFrame(ctx, widthPx, heightPx, {
        ...commonMeta,
        sheetNo: 'S-01',
        sheetTitle: 'PROJECT SUMMARY, RECONCILED BOQ & DIAGNOSTICS',
        scaleLabel: 'N.T.S.',
        pageIndex,
        pageTotal,
      });

      withClip(ctx, rect, () => {
        const isPortrait = rect.w < rect.h * 0.92;
        const gap = Math.round(18 * ui);
        const leftRect: Rect = isPortrait
          ? { x: rect.x, y: rect.y, w: rect.w, h: Math.floor(rect.h * 0.5) }
          : { x: rect.x, y: rect.y, w: Math.floor(rect.w * 0.56), h: rect.h };
        const rightRect: Rect = isPortrait
          ? {
              x: rect.x,
              y: rect.y + leftRect.h + gap,
              w: rect.w,
              h: rect.h - leftRect.h - gap,
            }
          : {
              x: rect.x + leftRect.w + gap,
              y: rect.y,
              w: rect.w - leftRect.w - gap,
              h: rect.h,
            };

        const hdrFont = `bold ${Math.round(13.5 * ui)}px sans-serif`;
        const tblFont = Math.round(10.8 * ui);
        const tblRowH = Math.round(25 * ui);
        const tblHdrH = Math.round(29 * ui);

        // Left: Reconciled Electrical BOQ Table (shared engine with Excel BOQ)
        ctx.fillStyle = '#0F172A';
        ctx.font = hdrFont;
        ctx.fillText('RECONCILED ELECTRICAL BOQ (COMPONENTS, CABLES, RATES & GST)', leftRect.x, leftRect.y + Math.round(15 * ui));

        const boqTableRows: Array<{ cells: string[]; style?: TableRowStyle }> = boq.rows.map(
          (row) => {
            const nameTag =
              row.manufacturer !== 'Not specified' && row.manufacturer !== 'Manual Entry'
                ? `${row.productName} (${row.manufacturer})`
                : row.productName;
            const rateStr =
              row.unitPrice !== null
                ? `${formatINR(row.unitPrice)}${row.priceSource === 'override' ? '*' : ''}`
                : 'Not cfg';
            const estCostStr = row.subtotal !== null ? formatINR(row.subtotal) : 'Pending';
            const totalStr = row.total !== null ? formatINR(row.total) : 'Pending';
            return {
              cells: [
                nameTag,
                row.kind === 'cable' ? row.cableSize : row.productCategory,
                `${row.quantity} ${row.unit}`,
                rateStr,
                row.totalLoadW > 0 ? `${row.totalLoadW} W` : '—',
                estCostStr,
                row.gstPercent !== null ? `${row.gstPercent}%` : '—',
                totalStr,
              ],
              style:
                row.priceSource === 'missing'
                  ? { fill: '#FFFBEB', textColor: '#92400E' }
                  : undefined,
            };
          }
        );

        boqTableRows.push({
          cells: [
            `SUBTOTAL (EXCL. GST) · ${boq.totalComponentQty} Items + ${
              wireSummary.overallInstalledLengthM !== null
                ? `${wireSummary.overallInstalledLengthM.toFixed(1)}m Wire`
                : 'Wire: Not calc.'
            }`,
            boq.unpricedRowCount > 0 ? `${boq.unpricedRowCount} Pending` : 'All Priced',
            String(boq.totalComponentQty),
            '—',
            `${boq.totalLoadWatts} W`,
            formatINR(boq.subtotalConfigured),
            '—',
            formatINR(boq.subtotalConfigured),
          ],
          style: { fill: '#F1F5F9', textColor: '#0F172A', bold: true },
        });
        boqTableRows.push({
          cells: [
            `GRAND TOTAL (INCL. CONFIGURED GST: ${formatINR(boq.totalGstConfigured)})`,
            boq.overrideRowCount > 0 ? `*${boq.overrideRowCount} Override` : 'Reconciled',
            String(reconciled.totalElectricalItems),
            '—',
            `${reconciled.totalConnectedLoadKw} kW`,
            formatINR(boq.subtotalConfigured),
            formatINR(boq.totalGstConfigured),
            formatINR(boq.grandTotalConfigured),
          ],
          style: { fill: '#E0F2FE', textColor: '#0C4A6E', bold: true },
        });

        const floorSubH = Math.min(Math.round(180 * ui), Math.round((boq.floorBoqs.length + 2) * tblRowH + tblHdrH + 28));
        const mainBoqH = Math.max(Math.round(240 * ui), leftRect.h - floorSubH - Math.round(32 * ui));

        const afterBoqY = drawAlignedTable(
          ctx,
          { x: leftRect.x, y: leftRect.y + Math.round(23 * ui), w: leftRect.w, h: mainBoqH },
          [
            { label: 'ITEM / DESCRIPTION', widthFrac: 0.27 },
            { label: 'CAT / SIZE', widthFrac: 0.11 },
            { label: 'QTY', widthFrac: 0.08, align: 'right' },
            { label: 'PRICE/UNIT (₹)', widthFrac: 0.11, align: 'right' },
            { label: 'LOAD', widthFrac: 0.09, align: 'right' },
            { label: 'EST. COST (₹)', widthFrac: 0.12, align: 'right' },
            { label: 'GST', widthFrac: 0.09, align: 'right' },
            { label: 'TOTAL', widthFrac: 0.13, align: 'right' },
          ],
          boqTableRows,
          { rowHeight: tblRowH, headerHeight: tblHdrH, fontSize: tblFont }
        );

        // Floor-Wise BOQ Subtotals directly beneath Consolidated BOQ (matches Excel Sheet 3 100%)
        const flSubY = afterBoqY + Math.round(16 * ui);
        if (flSubY + Math.round(70 * ui) < leftRect.y + leftRect.h) {
          ctx.fillStyle = '#0F172A';
          ctx.font = `bold ${Math.round(12 * ui)}px sans-serif`;
          ctx.fillText('FLOOR-WISE BOQ SUBTOTALS (RECONCILED WITH EXCEL SHEET 3)', leftRect.x, flSubY + Math.round(12 * ui));

          const flBoqList = boq.orphanedFloorBoq
            ? [...boq.floorBoqs, boq.orphanedFloorBoq]
            : boq.floorBoqs;
          const flSubRows: Array<{ cells: string[]; style?: TableRowStyle }> = flBoqList.map((fb) => ({
            cells: [
              fb.floorName,
              String(fb.componentQty),
              `${fb.cableLengthM.toFixed(1)} m`,
              `${fb.loadWatts} W`,
              formatINR(fb.subtotalConfigured),
              formatINR(fb.gstConfigured),
              formatINR(fb.grandTotalConfigured),
            ],
            style: fb.isOrphaned ? { fill: '#FEF2F2', textColor: '#B91C1C', bold: true } : undefined,
          }));

          drawAlignedTable(
            ctx,
            {
              x: leftRect.x,
              y: flSubY + Math.round(18 * ui),
              w: leftRect.w,
              h: leftRect.y + leftRect.h - (flSubY + Math.round(18 * ui)),
            },
            [
              { label: 'FLOOR', widthFrac: 0.24 },
              { label: 'ITEMS', widthFrac: 0.09, align: 'right' },
              { label: 'CABLE', widthFrac: 0.12, align: 'right' },
              { label: 'LOAD', widthFrac: 0.12, align: 'right' },
              { label: 'SUBTOTAL', widthFrac: 0.15, align: 'right' },
              { label: 'GST', widthFrac: 0.12, align: 'right' },
              { label: 'FLOOR TOTAL', widthFrac: 0.16, align: 'right' },
            ],
            flSubRows,
            { rowHeight: Math.round(23 * ui), headerHeight: Math.round(26 * ui), fontSize: Math.round(10.5 * ui) }
          );
        }

        // Right: Wire Consumption Summary (All Floors, Deduplicated) + Validation Diagnostics
        ctx.fillStyle = '#0F172A';
        ctx.font = hdrFont;
        ctx.fillText(
          'WIRE CONSUMPTION SUMMARY (ALL FLOORS, UNIQUE ROUTES)',
          rightRect.x,
          rightRect.y + Math.round(15 * ui)
        );

        const stripY = rightRect.y + Math.round(23 * ui);
        const wireTableRows: Array<{ cells: string[]; style?: TableRowStyle }> =
          wireSummary.rows.length > 0
            ? wireSummary.rows.map((wr) => ({
                cells: [
                  wr.wireType,
                  wr.cableSizeLabel,
                  wr.installedLengthM !== null ? `${wr.installedLengthM.toFixed(2)} m` : 'Not calculated',
                  wr.procurementAllowanceM !== null
                    ? `+${wr.procurementAllowanceM.toFixed(2)} m`
                    : 'Not calculated',
                ],
                style:
                  wr.installedLengthM === null
                    ? { fill: '#FFFBEB', textColor: '#92400E' }
                    : undefined,
              }))
            : [
                {
                  cells: ['No saved wiring routes', '—', 'Not calculated', 'Not calculated'],
                  style: { fill: '#FFFBEB', textColor: '#92400E' },
                },
              ];

        wireTableRows.push({
          cells: [
            `OVERALL TOTAL WIRE LENGTH (INSTALLED · ${wireSummary.uniqueRouteCount} runs)`,
            wireSummary.duplicateRoutesExcluded > 0
              ? `-${wireSummary.duplicateRoutesExcluded} dup`
              : `${wireSummary.floorsCovered.length || 0} flr`,
            wireSummary.overallInstalledLengthM !== null
              ? `${wireSummary.overallInstalledLengthM.toFixed(2)} m`
              : 'Not calculated',
            '—',
          ],
          style: { fill: '#F0FDF4', textColor: '#166534', bold: true },
        });
        wireTableRows.push({
          cells: [
            `PROCUREMENT ALLOWANCE (+${wireSummary.procurementAllowancePct}% — SEPARATE)`,
            'Separate',
            '—',
            wireSummary.overallProcurementAllowanceM !== null
              ? `+${wireSummary.overallProcurementAllowanceM.toFixed(2)} m`
              : 'Not calculated',
          ],
          style: { fill: '#F8FAFC', textColor: '#334155', bold: true },
        });

        const wireTblH = Math.min(
          Math.round(255 * ui),
          Math.round((wireTableRows.length + 1) * Math.round(23 * ui) + Math.round(28 * ui))
        );
        const afterCablesY = drawAlignedTable(
          ctx,
          { x: rightRect.x, y: stripY, w: rightRect.w, h: wireTblH },
          [
            { label: 'WIRE TYPE', widthFrac: 0.42 },
            { label: 'CABLE SIZE', widthFrac: 0.18 },
            { label: 'INSTALLED (m)', widthFrac: 0.2, align: 'right' },
            { label: `ALLOW. (${wireSummary.procurementAllowancePct}%)`, widthFrac: 0.2, align: 'right' },
          ],
          wireTableRows,
          { rowHeight: Math.round(23 * ui), headerHeight: Math.round(27 * ui), fontSize: Math.round(10.2 * ui) }
        );

        // Severity Summary Badges
        const badgeY = afterCablesY + Math.round(14 * ui);
        const badgeH = Math.round(28 * ui);
        const badgeW = Math.floor((rightRect.w - 16) / 3);
        const badges = [
          {
            label: `ERRORS: ${reconciled.errorCount}`,
            fill: reconciled.errorCount > 0 ? '#FEF2F2' : '#F0FDF4',
            stroke: reconciled.errorCount > 0 ? '#DC2626' : '#16A34A',
            text: reconciled.errorCount > 0 ? '#B91C1C' : '#166534',
          },
          {
            label: `WARNINGS: ${reconciled.warningCount}`,
            fill: reconciled.warningCount > 0 ? '#FFFBEB' : '#F8FAFC',
            stroke: reconciled.warningCount > 0 ? '#D97706' : '#94A3B8',
            text: reconciled.warningCount > 0 ? '#92400E' : '#475569',
          },
          {
            label: `INFO: ${reconciled.infoCount}`,
            fill: '#F0F9FF',
            stroke: '#0284C7',
            text: '#0369A1',
          },
        ];
        badges.forEach((b, i) => {
          const bx = rightRect.x + i * (badgeW + 8);
          ctx.fillStyle = b.fill;
          ctx.fillRect(bx, badgeY, badgeW, badgeH);
          ctx.strokeStyle = b.stroke;
          ctx.lineWidth = 1.3;
          ctx.strokeRect(bx, badgeY, badgeW, badgeH);
          ctx.fillStyle = b.text;
          ctx.font = `bold ${Math.round(11.5 * ui)}px monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(b.label, bx + badgeW / 2, badgeY + Math.round(badgeH * 0.68));
        });
        ctx.textAlign = 'left';

        // Diagnostic List with wrapped lines
        let diagY = badgeY + badgeH + Math.round(12 * ui);
        const maxDiagY = rightRect.y + rightRect.h - 10;
        const diagFontPx = Math.round(10.8 * ui);
        const lineH = Math.round(15 * ui);
        firstIssues.forEach((iss) => {
          if (diagY + lineH + 10 > maxDiagY) return;
          const badge = iss.severity.toUpperCase();
          const color =
            iss.severity === 'error'
              ? '#B91C1C'
              : iss.severity === 'warning'
                ? '#B45309'
                : '#0369A1';
          const bg =
            iss.severity === 'error'
              ? '#FEF2F2'
              : iss.severity === 'warning'
                ? '#FFFBEB'
                : '#F8FAFC';

          ctx.font = `${diagFontPx}px sans-serif`;
          const lines = wrapTextLines(ctx, `[${badge}] ${iss.message}`, rightRect.w - 20).slice(0, 2);
          const boxH = lines.length * lineH + Math.round(10 * ui);
          if (diagY + boxH > maxDiagY) return;

          ctx.fillStyle = bg;
          ctx.fillRect(rightRect.x, diagY, rightRect.w, boxH);
          ctx.strokeStyle = color;
          ctx.lineWidth = 0.9;
          ctx.strokeRect(rightRect.x, diagY, rightRect.w, boxH);

          ctx.fillStyle = color;
          lines.forEach((ln, li) => {
            ctx.fillText(ln, rightRect.x + 10, diagY + Math.round(15 * ui) + li * lineH);
          });
          diagY += boxH + Math.round(6 * ui);
        });

        if (remainingIssues.length > 0 && diagY + Math.round(18 * ui) <= maxDiagY) {
          ctx.fillStyle = '#475569';
          ctx.font = `bold ${Math.round(11 * ui)}px monospace`;
          ctx.fillText(
            `+ ${remainingIssues.length} additional diagnostic item(s) continued on Sheet S-02.`,
            rightRect.x,
            diagY + Math.round(14 * ui)
          );
        }
      });
    },
  });

  // Continuation Diagnostics Sheet S-02 (when many errors/warnings exist — never hide them!)
  if (remainingIssues.length > 0) {
    pages.push({
      sheetNo: 'S-02',
      title: 'ENGINEERING VALIDATION DIAGNOSTICS (CONTINUED)',
      draw: (ctx, pageIndex, pageTotal) => {
        const rect = drawTitleBlockAndFrame(ctx, widthPx, heightPx, {
          ...commonMeta,
          sheetNo: 'S-02',
          sheetTitle: 'ENGINEERING VALIDATION DIAGNOSTICS (CONTINUED)',
          scaleLabel: 'N.T.S.',
          pageIndex,
          pageTotal,
        });

        withClip(ctx, rect, () => {
          ctx.fillStyle = '#0F172A';
          ctx.font = `bold ${Math.round(14 * ui)}px sans-serif`;
          ctx.fillText(
            `COMPLETE DIAGNOSTICS LOG — ${reconciled.errorCount} ERROR(S), ${reconciled.warningCount} WARNING(S), ${reconciled.infoCount} INFO`,
            rect.x,
            rect.y + Math.round(18 * ui)
          );

          const availRows = Math.max(12, Math.floor((rect.h - Math.round(64 * ui)) / Math.round(26 * ui)));
          const rowH = Math.max(22, Math.min(Math.round(28 * ui), Math.floor((rect.h - Math.round(66 * ui)) / Math.max(1, Math.min(remainingIssues.length, availRows)))));
          const fSize = Math.max(10, Math.min(Math.round(11.5 * ui), Math.floor(rowH * 0.48)));

          drawAlignedTable(
            ctx,
            { x: rect.x, y: rect.y + Math.round(28 * ui), w: rect.w, h: rect.h - Math.round(28 * ui) },
            [
              { label: 'SEVERITY', widthFrac: 0.1, align: 'center' },
              { label: 'DOMAIN', widthFrac: 0.11, align: 'center' },
              { label: 'FLOOR', widthFrac: 0.14 },
              { label: 'DIAGNOSTIC MESSAGE', widthFrac: 0.65 },
            ],
            remainingIssues.map((iss) => ({
              cells: [
                iss.severity.toUpperCase(),
                iss.domain.toUpperCase(),
                iss.floor !== undefined ? getFloorLabel(project, iss.floor) : 'Project-Wide',
                iss.message,
              ],
              style:
                iss.severity === 'error'
                  ? { fill: '#FEF2F2', textColor: '#B91C1C', bold: true }
                  : iss.severity === 'warning'
                    ? { fill: '#FFFBEB', textColor: '#92400E' }
                    : { fill: '#F8FAFC', textColor: '#334155' },
            })),
            { rowHeight: rowH, headerHeight: Math.round(30 * ui), fontSize: fSize }
          );
        });
      },
    });
  }

  return pages;
}

/**
 * Self-contained zero-dependency multi-page PDF 1.4 binary generator embedding crisp JPEG page sheets.
 */
function buildMultiPagePdfBlob(
  canvases: HTMLCanvasElement[],
  widthMm: number,
  heightMm: number
): Blob {
  const pageWPt = Number(((widthMm * 72) / 25.4).toFixed(2));
  const pageHPt = Number(((heightMm * 72) / 25.4).toFixed(2));
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0];
  let byteLen = 0;

  const pushStr = (s: string) => {
    const b = encoder.encode(s);
    chunks.push(b);
    byteLen += b.length;
  };
  const pushBytes = (b: Uint8Array) => {
    chunks.push(b);
    byteLen += b.length;
  };

  pushStr('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  // Obj 1: Catalog, Obj 2: Pages
  // For each page i (0..n-1): PageObj = 3 + i*3, ImgObj = 4 + i*3, ContentObj = 5 + i*3
  const kidsRefs = canvases.map((_, i) => `${3 + i * 3} 0 R`).join(' ');

  offsets.push(byteLen);
  pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  offsets.push(byteLen);
  pushStr(`2 0 obj\n<< /Type /Pages /Kids [${kidsRefs}] /Count ${canvases.length} >>\nendobj\n`);

  canvases.forEach((canvas, i) => {
    const pageObjId = 3 + i * 3;
    const imgObjId = 4 + i * 3;
    const contentObjId = 5 + i * 3;

    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const base64 = dataUrl.split(',')[1];
    const binaryStr = atob(base64);
    const imgBytes = new Uint8Array(binaryStr.length);
    for (let k = 0; k < binaryStr.length; k++) {
      imgBytes[k] = binaryStr.charCodeAt(k);
    }

    offsets.push(byteLen);
    pushStr(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWPt} ${pageHPt}] /Resources << /XObject << /Im${i} ${imgObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`
    );

    offsets.push(byteLen);
    pushStr(
      `${imgObjId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgBytes.length} >>\nstream\n`
    );
    pushBytes(imgBytes);
    pushStr('\nendstream\nendobj\n');

    const contentStream = `q\n${pageWPt} 0 0 ${pageHPt} 0 0 cm\n/Im${i} Do\nQ\n`;
    offsets.push(byteLen);
    pushStr(
      `${contentObjId} 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream\nendobj\n`
    );
  });

  const xrefPos = byteLen;
  pushStr(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (let i = 1; i < offsets.length; i++) {
    pushStr(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  pushStr(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`);

  return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
}

function triggerPdfDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * Generates and downloads a complete multi-page Architectural & Electrical PDF Drawing Package.
 * Every drawing panel is clipped and mathematically fitted inside page/panel bounds,
 * and every schedule reconciles 100% against computeReconciledElectricalSchedule(project).
 * Returns the number of pages generated.
 */
export function downloadProjectPdfPackage(
  project: ProjectData,
  options: PdfPackageOptions = DEFAULT_PDF_PACKAGE_OPTIONS
): number {
  const { widthMm, heightMm, widthPx, heightPx } = getPageDimensionsPx(
    options.pageSize,
    options.orientation
  );

  const allFloors = getProjectFloors(project);
  const selectedFloors: FloorLevelConfig[] =
    options.selectedFloors && options.selectedFloors.length > 0
      ? allFloors.filter((f) => options.selectedFloors!.includes(f.floor))
      : allFloors;
  const activeFloors = selectedFloors.length > 0 ? selectedFloors : allFloors;

  const reconciled = computeReconciledElectricalSchedule(project);
  const buildingTypeLabel = BUILDING_TYPE_LABELS[inferBuildingType(project)];
  const dateStr = new Date().toLocaleDateString('en-IN');
  const unitsLabel = project.site.units === 'ft' ? 'IMPERIAL (FT)' : 'METRIC (M)';

  interface PlannedPage {
    sheetNo: string;
    title: string;
    draw: (ctx: CanvasRenderingContext2D, pageIndex: number, pageTotal: number) => void;
  }

  const planned: PlannedPage[] = [];
  const sheetIndex: Array<{ sheetNo: string; title: string }> = [];

  if (options.includeCover) {
    sheetIndex.push({ sheetNo: 'A-00', title: 'Cover Sheet, Sheet Index & Reconciled Floor Schedule' });
  }
  if (options.includeFloorPlans) {
    activeFloors.forEach((fc, idx) =>
      sheetIndex.push({
        sheetNo: `A-${String(idx + 1).padStart(2, '0')}`,
        title: `Architectural Floor Plan — ${fc.name}`,
      })
    );
  }
  if (options.includeElectricalLayouts) {
    activeFloors.forEach((fc, idx) =>
      sheetIndex.push({
        sheetNo: `E-${String(idx + 1).padStart(2, '0')}`,
        title: `Electrical Layout Plan — ${fc.name}`,
      })
    );
  }
  if (options.includeWiringLayouts) {
    activeFloors.forEach((fc, idx) =>
      sheetIndex.push({
        sheetNo: `W-${String(idx + 1).padStart(2, '0')}`,
        title: `Electrical Wiring & Cable Routing Plan — ${fc.name}`,
      })
    );
  }
  if (options.include3DViews) {
    sheetIndex.push({
      sheetNo: '3D-01',
      title: 'Orthographic Top View & 3D Isometric Multi-Storey Projection',
    });
  }
  if (options.includeElevations) {
    sheetIndex.push({
      sheetNo: 'EL-01',
      title: 'Architectural Elevations (Front, Rear, Left & Right)',
    });
  }
  if (options.includeDbAndEarthing) {
    sheetIndex.push({
      sheetNo: 'E-DB',
      title: 'Distribution Board, Earthing, Reconciled Circuit Schedule & Legend',
    });
  }

  const summaryPages = options.includeSummaryAndBoq
    ? drawSummaryAndDiagnosticsSheets(
        project,
        reconciled,
        widthPx,
        heightPx,
        {
          projectName: project.name,
          refCode: project.refCode,
          units: unitsLabel,
          buildingTypeLabel,
          dateStr,
        },
        options.wireProcurementAllowancePct ?? DEFAULT_INSTALLATION_ALLOWANCE_PCT
      )
    : [];

  summaryPages.forEach((sp) => sheetIndex.push({ sheetNo: sp.sheetNo, title: sp.title }));

  // 1. Cover Sheet
  if (options.includeCover) {
    planned.push({
      sheetNo: 'A-00',
      title: 'COVER SHEET & FLOOR SCHEDULE',
      draw: (ctx, pageIndex, pageTotal) => {
        const rect = drawTitleBlockAndFrame(ctx, widthPx, heightPx, {
          projectName: project.name,
          refCode: project.refCode,
          sheetNo: 'A-00',
          sheetTitle: 'COVER SHEET & SHEET INDEX',
          scaleLabel: 'N.T.S.',
          units: unitsLabel,
          pageIndex,
          pageTotal,
          buildingTypeLabel,
          dateStr,
        });
        drawCoverSheet(ctx, project, reconciled, rect, sheetIndex);
      },
    });
  }

  // 2. Architectural Floor Plans
  if (options.includeFloorPlans) {
    activeFloors.forEach((fc, idx) => {
      const sheetNo = `A-${String(idx + 1).padStart(2, '0')}`;
      planned.push({
        sheetNo,
        title: `ARCHITECTURAL FLOOR PLAN — ${fc.name}`,
        draw: (ctx, pageIndex, pageTotal) => {
          const probeRect = drawTitleBlockAndFrame(ctx, widthPx, heightPx, {
            projectName: project.name,
            refCode: project.refCode,
            sheetNo,
            sheetTitle: 'ARCHITECTURAL FLOOR PLAN',
            floorLabel: fc.name,
            scaleLabel: options.scale.toUpperCase(),
            units: unitsLabel,
            pageIndex,
            pageTotal,
            buildingTypeLabel,
            dateStr,
          });
          const fit = drawPlanOnContext(ctx, project, fc.floor, probeRect, 'architectural', options.scale, options.includeAnnotations);
          drawTitleBlockAndFrame(ctx, widthPx, heightPx, {
            projectName: project.name,
            refCode: project.refCode,
            sheetNo,
            sheetTitle: 'ARCHITECTURAL FLOOR PLAN',
            floorLabel: fc.name,
            scaleLabel: fit.scaleLabel,
            units: unitsLabel,
            pageIndex,
            pageTotal,
            buildingTypeLabel,
            dateStr,
          });
        },
      });
    });
  }

  // 3. Electrical Layouts
  if (options.includeElectricalLayouts) {
    activeFloors.forEach((fc, idx) => {
      const sheetNo = `E-${String(idx + 1).padStart(2, '0')}`;
      planned.push({
        sheetNo,
        title: `ELECTRICAL LAYOUT — ${fc.name}`,
        draw: (ctx, pageIndex, pageTotal) => {
          const probeRect = drawTitleBlockAndFrame(ctx, widthPx, heightPx, {
            projectName: project.name,
            refCode: project.refCode,
            sheetNo,
            sheetTitle: 'ELECTRICAL LAYOUT PLAN',
            floorLabel: fc.name,
            scaleLabel: options.scale.toUpperCase(),
            units: unitsLabel,
            pageIndex,
            pageTotal,
            buildingTypeLabel,
            dateStr,
          });
          const fit = drawPlanOnContext(ctx, project, fc.floor, probeRect, 'electrical', options.scale, options.includeAnnotations);
          drawTitleBlockAndFrame(ctx, widthPx, heightPx, {
            projectName: project.name,
            refCode: project.refCode,
            sheetNo,
            sheetTitle: 'ELECTRICAL LAYOUT PLAN',
            floorLabel: fc.name,
            scaleLabel: fit.scaleLabel,
            units: unitsLabel,
            pageIndex,
            pageTotal,
            buildingTypeLabel,
            dateStr,
          });
        },
      });
    });
  }

  // 4. Wiring & Cable Routing Layouts
  if (options.includeWiringLayouts) {
    activeFloors.forEach((fc, idx) => {
      const sheetNo = `W-${String(idx + 1).padStart(2, '0')}`;
      planned.push({
        sheetNo,
        title: `WIRING & CABLE ROUTING — ${fc.name}`,
        draw: (ctx, pageIndex, pageTotal) => {
          const probeRect = drawTitleBlockAndFrame(ctx, widthPx, heightPx, {
            projectName: project.name,
            refCode: project.refCode,
            sheetNo,
            sheetTitle: 'ELECTRICAL WIRING & CABLE ROUTING PLAN',
            floorLabel: fc.name,
            scaleLabel: options.scale.toUpperCase(),
            units: unitsLabel,
            pageIndex,
            pageTotal,
            buildingTypeLabel,
            dateStr,
          });
          const fit = drawPlanOnContext(ctx, project, fc.floor, probeRect, 'wiring', options.scale, options.includeAnnotations);
          drawTitleBlockAndFrame(ctx, widthPx, heightPx, {
            projectName: project.name,
            refCode: project.refCode,
            sheetNo,
            sheetTitle: 'ELECTRICAL WIRING & CABLE ROUTING PLAN',
            floorLabel: fc.name,
            scaleLabel: fit.scaleLabel,
            units: unitsLabel,
            pageIndex,
            pageTotal,
            buildingTypeLabel,
            dateStr,
          });
        },
      });
    });
  }

  // 5. 3D Orthographic Top & Multi-Storey Isometric Views (Responsive to Landscape & Portrait)
  if (options.include3DViews) {
    planned.push({
      sheetNo: '3D-01',
      title: 'ORTHOGRAPHIC TOP & 3D ISOMETRIC VIEWS',
      draw: (ctx, pageIndex, pageTotal) => {
        const rect = drawTitleBlockAndFrame(ctx, widthPx, heightPx, {
          projectName: project.name,
          refCode: project.refCode,
          sheetNo: '3D-01',
          sheetTitle: 'ORTHOGRAPHIC TOP & 3D ISOMETRIC BUILDING VIEWS',
          scaleLabel: 'AUTO-FIT',
          units: unitsLabel,
          pageIndex,
          pageTotal,
          buildingTypeLabel,
          dateStr,
        });
        const gap = 18;
        const isPortrait = rect.w < rect.h * 0.92;
        const topPlanRect: Rect = isPortrait
          ? { x: rect.x, y: rect.y, w: rect.w, h: Math.floor((rect.h - gap) / 2) }
          : { x: rect.x, y: rect.y, w: Math.floor((rect.w - gap) * 0.48), h: rect.h };
        const isoRect: Rect = isPortrait
          ? {
              x: rect.x,
              y: rect.y + topPlanRect.h + gap,
              w: rect.w,
              h: rect.h - topPlanRect.h - gap,
            }
          : {
              x: rect.x + topPlanRect.w + gap,
              y: rect.y,
              w: rect.w - topPlanRect.w - gap,
              h: rect.h,
            };

        const gf = activeFloors.find((f) => f.floor === 1)?.floor ?? activeFloors[0].floor;
        drawPlanOnContext(ctx, project, gf, topPlanRect, 'combined', 'auto');
        drawIsometricProjection(ctx, project, isoRect);
      },
    });
  }

  // 6. Architectural Elevations (2x2 grid strictly clipped)
  if (options.includeElevations) {
    planned.push({
      sheetNo: 'EL-01',
      title: 'ARCHITECTURAL ELEVATIONS (4 SIDES)',
      draw: (ctx, pageIndex, pageTotal) => {
        const rect = drawTitleBlockAndFrame(ctx, widthPx, heightPx, {
          projectName: project.name,
          refCode: project.refCode,
          sheetNo: 'EL-01',
          sheetTitle: 'BUILDING ELEVATIONS (FRONT, REAR, LEFT & RIGHT)',
          scaleLabel: 'AUTO-FIT',
          units: unitsLabel,
          pageIndex,
          pageTotal,
          buildingTypeLabel,
          dateStr,
        });
        const gap = 16;
        const cellW = Math.floor((rect.w - gap) / 2);
        const cellH = Math.floor((rect.h - gap) / 2);
        drawElevationPanel(ctx, project, 'front', { x: rect.x, y: rect.y, w: cellW, h: cellH });
        drawElevationPanel(ctx, project, 'rear', {
          x: rect.x + cellW + gap,
          y: rect.y,
          w: rect.w - cellW - gap,
          h: cellH,
        });
        drawElevationPanel(ctx, project, 'left', {
          x: rect.x,
          y: rect.y + cellH + gap,
          w: cellW,
          h: rect.h - cellH - gap,
        });
        drawElevationPanel(ctx, project, 'right', {
          x: rect.x + cellW + gap,
          y: rect.y + cellH + gap,
          w: rect.w - cellW - gap,
          h: rect.h - cellH - gap,
        });
      },
    });
  }

  // 7. DB, Earthing, Reconciled Circuit Schedule & Legend
  if (options.includeDbAndEarthing) {
    planned.push({
      sheetNo: 'E-DB',
      title: 'DB, EARTHING & CIRCUIT SCHEDULE',
      draw: (ctx, pageIndex, pageTotal) => {
        const rect = drawTitleBlockAndFrame(ctx, widthPx, heightPx, {
          projectName: project.name,
          refCode: project.refCode,
          sheetNo: 'E-DB',
          sheetTitle: 'DISTRIBUTION BOARD, EARTHING & CIRCUIT SCHEDULE',
          scaleLabel: 'N.T.S.',
          units: unitsLabel,
          pageIndex,
          pageTotal,
          buildingTypeLabel,
          dateStr,
        });
        drawDbAndScheduleSheet(ctx, project, reconciled, rect);
      },
    });
  }

  // 8. Project Summary, Reconciled BOQ & Diagnostics (S-01 + optional S-02 continuation)
  summaryPages.forEach((sp) => planned.push(sp));

  if (planned.length === 0) {
    planned.push({
      sheetNo: 'A-01',
      title: 'FLOOR PLAN',
      draw: (ctx, pageIndex, pageTotal) => {
        const rect = drawTitleBlockAndFrame(ctx, widthPx, heightPx, {
          projectName: project.name,
          refCode: project.refCode,
          sheetNo: 'A-01',
          sheetTitle: 'ARCHITECTURAL FLOOR PLAN',
          floorLabel: activeFloors[0].name,
          scaleLabel: 'AUTO-FIT',
          units: unitsLabel,
          pageIndex,
          pageTotal,
          buildingTypeLabel,
          dateStr,
        });
        drawPlanOnContext(ctx, project, activeFloors[0].floor, rect, 'combined', options.scale);
      },
    });
  }

  const pageTotal = planned.length;
  const canvases: HTMLCanvasElement[] = planned.map((page, idx) => {
    const { canvas, ctx } = createOffscreenPage(widthPx, heightPx);
    page.draw(ctx, idx + 1, pageTotal);
    return canvas;
  });

  const pdfBlob = buildMultiPagePdfBlob(canvases, widthMm, heightMm);
  const fileName = `${safeFileName(project.name)}_DrawingPackage_${options.pageSize.toUpperCase()}.pdf`;
  triggerPdfDownload(pdfBlob, fileName);
  return pageTotal;
}
