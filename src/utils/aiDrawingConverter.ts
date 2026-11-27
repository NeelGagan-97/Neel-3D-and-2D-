import { ELECTRICAL_CATALOG, FT_TO_M, M_TO_FT, siteToMeters } from '../data/presets';
import {
  AiDrawingAnalyzeResponse,
  AiDrawingImportMeta,
  AiDrawingType,
  CalibrationConfig,
  DetectedColumn,
  DetectedDimension,
  DetectedFurniture,
  DetectedFurnitureKind,
  DetectedLegendEntry,
  DetectedOpening,
  DetectedRoom,
  DetectedStaircase,
  DetectedSymbolInstance,
  DetectedTextLabel,
  DetectedWall,
  DetectedWiringPath,
  DetectionStatus,
  DrawingLayerState,
  DrawingMeasurementUnit,
  DrawingProjectMetadata,
  ImportedColumn2D,
  ImportedTextAnnotation2D,
  IntermediateDrawingModel,
  NormalizedPoint,
  PdfVectorExtractionResult,
  ReconstructionQualityReport,
  ReferenceOverlayConfig,
  SymbolMappingDefinition,
  SymbolTargetDomain,
  UploadedDrawingSource,
} from '../types/aiDrawing';
import {
  ArchitecturalOpening,
  CustomWall,
  DimensionAnnotation,
  ElectricalPoint,
  ElectricalWire,
  FurnitureItem,
  ProjectData,
  RoomType,
  RoomZone,
  StaircaseItem,
} from '../types/design';
import { buildDefaultFloorConfigs, DEFAULT_SLAB_THICKNESS_M } from './buildingWiring';
import { createDefaultDrawingLayers } from '../services/symbolMappingStorage';
import { parseDimensionTextToMeters } from './pdfVectorExtractor';

export const AUTO_APPROVE_CONFIDENCE_THRESHOLD = 0.72;
const DEFAULT_UNSCALED_SPAN_METERS = 15; // Clearly marked uncalibrated & estimated — never silently presented as true scale

const VALID_ROOM_TYPES: Set<RoomType> = new Set([
  'living',
  'hall',
  'kitchen',
  'master-bedroom',
  'bedroom',
  'second-bedroom',
  'guest-bedroom',
  'bathroom',
  'common-bathroom',
  'dining',
  'pooja',
  'balcony',
  'utility',
  'store',
  'study',
  'custom',
]);

const VALID_DOMAINS: Set<SymbolTargetDomain> = new Set([
  'lighting',
  'fan',
  'switch',
  'socket',
  'appliance',
  'distribution',
  'architectural',
  'custom',
]);

export function clamp01(value: unknown, fallback = 0.5): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(1, n));
}

export function round2(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * Converts a linear architectural measurement from mm, cm, m, in, or ft into meters.
 */
export function convertUnitToMeters(value: number, unit: DrawingMeasurementUnit): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  switch (unit) {
    case 'mm':
      return value / 1000;
    case 'cm':
      return value / 100;
    case 'm':
      return value;
    case 'in':
      return value * 0.0254;
    case 'ft':
      return value * FT_TO_M;
    default:
      return value;
  }
}

/**
 * Creates an explicit uncalibrated configuration when scale has NOT been verified by the user.
 * Never fabricates building dimensions from PDF paper page size.
 */
export function createUncalibratedConfig(
  imageWidthPx: number,
  imageHeightPx: number,
  unit: DrawingMeasurementUnit
): CalibrationConfig {
  const safeW = Math.max(1, imageWidthPx);
  const safeH = Math.max(1, imageHeightPx);
  const aspect = safeH / safeW;
  const widthM = DEFAULT_UNSCALED_SPAN_METERS;
  const heightM = round2(Math.max(4, Math.min(40, widthM * aspect)));

  return {
    calibrated: false,
    method: 'uncalibrated-estimated',
    unit,
    drawingWidthMeters: widthM,
    drawingHeightMeters: heightM,
    pixelsPerMeter: null,
    note: 'Scale is NOT calibrated. Dimensions are uncalibrated proportional estimates until you complete 2-point scale calibration.',
  };
}

/**
 * Computes real-world drawing scale from two user-picked reference points and a known real distance.
 */
export function computeTwoPointCalibration(params: {
  pointA: NormalizedPoint;
  pointB: NormalizedPoint;
  knownDistanceValue: number;
  unit: DrawingMeasurementUnit;
  imageWidthPx: number;
  imageHeightPx: number;
}): { ok: true; calibration: CalibrationConfig } | { ok: false; error: string } {
  const safeW = Math.max(1, params.imageWidthPx);
  const safeH = Math.max(1, params.imageHeightPx);

  if (!Number.isFinite(params.knownDistanceValue) || params.knownDistanceValue <= 0) {
    return { ok: false, error: 'Known distance must be a positive number.' };
  }

  const knownDistanceMeters = convertUnitToMeters(params.knownDistanceValue, params.unit);
  if (knownDistanceMeters < 0.05 || knownDistanceMeters > 500) {
    return {
      ok: false,
      error: 'Known calibration distance must be between 0.05 m and 500 m.',
    };
  }

  const dxPx = (clamp01(params.pointB.x) - clamp01(params.pointA.x)) * safeW;
  const dyPx = (clamp01(params.pointB.y) - clamp01(params.pointA.y)) * safeH;
  const pixelDist = Math.hypot(dxPx, dyPx);

  if (pixelDist < 8) {
    return {
      ok: false,
      error: 'Calibration points are too close together. Select two well-separated points along a known wall or dimension line.',
    };
  }

  const pixelsPerMeter = pixelDist / knownDistanceMeters;
  const drawingWidthMeters = round2(safeW / pixelsPerMeter);
  const drawingHeightMeters = round2(safeH / pixelsPerMeter);

  if (drawingWidthMeters > 500 || drawingHeightMeters > 500) {
    return {
      ok: false,
      error: 'Derived drawing span exceeds 500 m. Please check your selected unit and reference distance.',
    };
  }

  return {
    ok: true,
    calibration: {
      calibrated: true,
      method: 'two-point',
      unit: params.unit,
      pointA: { x: clamp01(params.pointA.x), y: clamp01(params.pointA.y) },
      pointB: { x: clamp01(params.pointB.x), y: clamp01(params.pointB.y) },
      knownDistanceValue: params.knownDistanceValue,
      knownDistanceMeters: round2(knownDistanceMeters),
      drawingWidthMeters,
      drawingHeightMeters,
      pixelsPerMeter: round2(pixelsPerMeter),
      note: `Calibrated via 2-point reference (${params.knownDistanceValue} ${params.unit} = ${round2(knownDistanceMeters)} m). Full canvas span: ${drawingWidthMeters} m × ${drawingHeightMeters} m.`,
    },
  };
}

export function createEmptyIntermediateModel(pageNumber = 1): IntermediateDrawingModel {
  return {
    version: 1,
    analyzedAt: new Date().toISOString(),
    providerModel: 'manual-workspace',
    sourcePage: pageNumber,
    walls: [],
    rooms: [],
    openings: [],
    columns: [],
    staircases: [],
    furniture: [],
    symbols: [],
    wiringPaths: [],
    dimensions: [],
    textLabels: [],
    legendEntries: [],
    titleBlock: {},
    warnings: [],
    summary: 'Manual review canvas ready. Extract vector PDF geometry, run Hybrid Vision AI, or trace/place 2D objects directly on the drawing.',
  };
}

function normalizeRoomType(raw: unknown): RoomType {
  if (typeof raw !== 'string') return 'custom';
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, '-') as RoomType;
  if (VALID_ROOM_TYPES.has(cleaned)) return cleaned;
  if (cleaned.includes('bed')) return 'bedroom';
  if (cleaned.includes('bath') || cleaned.includes('toilet') || cleaned.includes('wc')) return 'bathroom';
  if (cleaned.includes('kitchen')) return 'kitchen';
  if (cleaned.includes('living') || cleaned.includes('lounge')) return 'living';
  if (cleaned.includes('dining')) return 'dining';
  if (cleaned.includes('balcony') || cleaned.includes('terrace')) return 'balcony';
  if (cleaned.includes('study') || cleaned.includes('office')) return 'study';
  if (cleaned.includes('store')) return 'store';
  if (cleaned.includes('utility')) return 'utility';
  if (cleaned.includes('pooja') || cleaned.includes('prayer')) return 'pooja';
  if (cleaned.includes('hall') || cleaned.includes('foyer')) return 'hall';
  return 'custom';
}

function resolveUserSymbolMapping(
  raw: { symbolMappingId?: string; symbolName?: string; symbolCode?: string },
  symbolLibrary: SymbolMappingDefinition[]
): SymbolMappingDefinition | undefined {
  const enabled = symbolLibrary.filter((s) => s.enabled);
  if (raw.symbolMappingId) {
    const byId = enabled.find((s) => s.id === raw.symbolMappingId);
    if (byId) return byId;
  }
  const code = (raw.symbolCode ?? '').trim().toLowerCase();
  if (code) {
    const byCode = enabled.find((s) => s.code.trim().toLowerCase() === code);
    if (byCode) return byCode;
  }
  const name = (raw.symbolName ?? '').trim().toLowerCase();
  if (name) {
    const byName = enabled.find((s) => s.name.trim().toLowerCase() === name);
    if (byName) return byName;
  }
  return undefined;
}

function statusFromConfidence(confidence: number, forceUncertain = false): DetectionStatus {
  if (forceUncertain) return 'uncertain';
  return confidence >= AUTO_APPROVE_CONFIDENCE_THRESHOLD ? 'approved' : 'uncertain';
}

/**
 * Normalizes raw vision AI response into a safe, strongly-typed IntermediateDrawingModel.
 * - Uses user's symbol definitions as the primary reference.
 * - Marks low-confidence (< 0.72) or unmapped symbols as 'uncertain' (never silently auto-approved).
 * - Flags near-duplicate overlapping walls and symbols so users can review/deduplicate.
 */
export function normalizeAiAnalysisResponse(
  rawAnalysis: AiDrawingAnalyzeResponse['rawAnalysis'],
  symbolLibrary: SymbolMappingDefinition[],
  pageNumber: number,
  providerModel: string,
  analyzedAt = new Date().toISOString()
): IntermediateDrawingModel {
  const warnings: string[] = Array.isArray(rawAnalysis.warnings)
    ? rawAnalysis.warnings.filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
    : [];

  // Walls (preserving angled & curved segments cleanly)
  const walls: DetectedWall[] = (Array.isArray(rawAnalysis.walls) ? rawAnalysis.walls : [])
    .map((w, idx): DetectedWall | null => {
      const x1 = clamp01(w.x1, -1);
      const y1 = clamp01(w.y1, -1);
      const x2 = clamp01(w.x2, -1);
      const y2 = clamp01(w.y2, -1);
      const isCurved = Boolean(w.isCurvedSegment);
      if (Math.hypot(x2 - x1, y2 - y1) < (isCurved ? 0.003 : 0.006)) return null;
      const confidence = clamp01(w.confidence, 0.6);
      return {
        id: `ai-wall-${idx + 1}`,
        x1,
        y1,
        x2,
        y2,
        wallKind: w.wallKind === 'external' ? 'external' : 'internal',
        isCurvedSegment: isCurved || undefined,
        confidence,
        status: statusFromConfidence(confidence),
        source: 'ai',
        origin: 'vision-ai',
        note: typeof w.note === 'string' ? w.note.trim() : undefined,
      };
    })
    .filter((item): item is DetectedWall => item !== null);

  // Flag near-duplicate overlapping walls (skipping tight curved chords)
  for (let i = 0; i < walls.length; i += 1) {
    for (let j = i + 1; j < walls.length; j += 1) {
      const a = walls[i];
      const b = walls[j];
      const tol = a.isCurvedSegment || b.isCurvedSegment ? 0.004 : 0.014;
      const sameDir =
        Math.hypot(a.x1 - b.x1, a.y1 - b.y1) < tol &&
        Math.hypot(a.x2 - b.x2, a.y2 - b.y2) < tol;
      const revDir =
        Math.hypot(a.x1 - b.x2, a.y1 - b.y2) < tol &&
        Math.hypot(a.x2 - b.x1, a.y2 - b.y1) < tol;
      if (sameDir || revDir) {
        b.isDuplicateCandidate = true;
        b.status = 'uncertain';
        b.note = [b.note, 'Near-duplicate overlapping wall'].filter(Boolean).join(' — ');
      }
    }
  }

  // Rooms (preserving exact normalized polygon vertices for irregular/angled/curved spaces)
  const rooms: DetectedRoom[] = (Array.isArray(rawAnalysis.rooms) ? rawAnalysis.rooms : [])
    .map((r, idx): DetectedRoom | null => {
      const rawPolygon = Array.isArray(r.polygon)
        ? r.polygon
            .filter((p): p is NormalizedPoint => Boolean(p && typeof p.x === 'number' && typeof p.y === 'number'))
            .map((p) => ({ x: clamp01(p.x, 0), y: clamp01(p.y, 0) }))
        : undefined;
      const validPolygon = rawPolygon && rawPolygon.length >= 3 ? rawPolygon : undefined;

      let x = clamp01(r.x, 0);
      let y = clamp01(r.y, 0);
      let width = Math.min(1 - x, clamp01(r.width, 0));
      let height = Math.min(1 - y, clamp01(r.height, 0));

      if (validPolygon) {
        const xs = validPolygon.map((p) => p.x);
        const ys = validPolygon.map((p) => p.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        if (maxX - minX >= 0.02 && maxY - minY >= 0.02) {
          x = minX;
          y = minY;
          width = maxX - minX;
          height = maxY - minY;
        }
      }

      if (width < 0.015 || height < 0.015) return null;
      const confidence = clamp01(r.confidence, 0.6);
      return {
        id: `ai-room-${idx + 1}`,
        name: String(r.name || `Room ${idx + 1}`).trim().slice(0, 60),
        roomType: normalizeRoomType(r.roomType),
        x,
        y,
        width,
        height,
        polygon: validPolygon,
        confidence,
        status: statusFromConfidence(confidence),
        source: 'ai',
        origin: 'vision-ai',
        note: typeof r.note === 'string' ? r.note.trim() : undefined,
      };
    })
    .filter((item): item is DetectedRoom => item !== null);

  // Openings
  const openings: DetectedOpening[] = (Array.isArray(rawAnalysis.openings) ? rawAnalysis.openings : [])
    .map((o, idx): DetectedOpening => {
      const confidence = clamp01(o.confidence, 0.6);
      return {
        id: `ai-open-${idx + 1}`,
        kind: o.kind === 'window' ? 'window' : 'door',
        x: clamp01(o.x, 0.5),
        y: clamp01(o.y, 0.5),
        widthNorm: Math.max(0.015, Math.min(0.3, clamp01(o.widthNorm, 0.05))),
        rotationDeg: Number.isFinite(o.rotationDeg) ? Math.round(o.rotationDeg) % 360 : 0,
        confidence,
        status: statusFromConfidence(confidence),
        source: 'ai',
        note: typeof o.note === 'string' ? o.note.trim() : undefined,
      };
    });

  // Columns
  const columns: DetectedColumn[] = (Array.isArray(rawAnalysis.columns) ? rawAnalysis.columns : [])
    .map((c, idx): DetectedColumn => {
      const confidence = clamp01(c.confidence, 0.6);
      return {
        id: `ai-col-${idx + 1}`,
        label: String(c.label || `C${idx + 1}`).trim().slice(0, 24),
        x: clamp01(c.x, 0.5),
        y: clamp01(c.y, 0.5),
        widthNorm: Math.max(0.008, Math.min(0.1, clamp01(c.widthNorm, 0.02))),
        heightNorm: Math.max(0.008, Math.min(0.1, clamp01(c.heightNorm, 0.02))),
        confidence,
        status: statusFromConfidence(confidence),
        source: 'ai',
      };
    });

  // Staircases
  const staircases: DetectedStaircase[] = (
    Array.isArray(rawAnalysis.staircases) ? rawAnalysis.staircases : []
  ).map((s, idx): DetectedStaircase => {
    const confidence = clamp01(s.confidence, 0.6);
    return {
      id: `ai-stair-${idx + 1}`,
      label: String(s.label || `Staircase ${idx + 1}`).trim().slice(0, 40),
      x: clamp01(s.x, 0.1),
      y: clamp01(s.y, 0.1),
      widthNorm: Math.max(0.03, Math.min(0.4, clamp01(s.widthNorm, 0.12))),
      heightNorm: Math.max(0.03, Math.min(0.4, clamp01(s.heightNorm, 0.16))),
      rotationDeg: Number.isFinite(s.rotationDeg) ? Math.round(s.rotationDeg) % 360 : 0,
      steps: typeof s.steps === 'number' && s.steps >= 4 && s.steps <= 40 ? Math.round(s.steps) : 14,
      confidence,
      status: statusFromConfidence(confidence),
      source: 'ai',
    };
  });

  // Furniture
  const validFurnitureKinds = new Set<DetectedFurnitureKind>([
    'sofa',
    'bed',
    'dining-table',
    'kitchen-counter',
    'vanity',
    'tv-unit',
    'desk',
  ]);
  const furniture: DetectedFurniture[] = (
    Array.isArray(rawAnalysis.furniture) ? rawAnalysis.furniture : []
  ).map((f, idx): DetectedFurniture => {
    const confidence = clamp01(f.confidence, 0.62);
    const kind = validFurnitureKinds.has(f.kind as DetectedFurnitureKind)
      ? (f.kind as DetectedFurnitureKind)
      : 'desk';
    return {
      id: `ai-furn-${idx + 1}`,
      kind,
      label: String(f.label || kind).trim().slice(0, 48),
      x: clamp01(f.x, 0.5),
      y: clamp01(f.y, 0.5),
      widthNorm: Math.max(0.015, Math.min(0.35, clamp01(f.widthNorm, 0.06))),
      heightNorm: Math.max(0.015, Math.min(0.35, clamp01(f.heightNorm, 0.04))),
      rotationDeg: Number.isFinite(f.rotationDeg) ? Math.round(f.rotationDeg) % 360 : 0,
      confidence,
      status: statusFromConfidence(confidence),
      source: 'ai',
      origin: 'vision-ai',
      note: typeof f.note === 'string' ? f.note.trim() : undefined,
    };
  });

  // Symbols — matched against user's SymbolMappingDefinition[] as primary truth
  const symbols: DetectedSymbolInstance[] = (
    Array.isArray(rawAnalysis.symbols) ? rawAnalysis.symbols : []
  ).map((s, idx): DetectedSymbolInstance => {
    const matched = resolveUserSymbolMapping(s, symbolLibrary);
    const confidence = clamp01(s.confidence, 0.5);
    const domain: SymbolTargetDomain = matched
      ? matched.domain
      : VALID_DOMAINS.has(s.domain)
      ? s.domain
      : 'custom';

    // CRITICAL: Unmapped symbols are ALWAYS marked 'uncertain' so user must map or approve explicitly
    const forceUncertain = !matched;
    return {
      id: `ai-sym-${idx + 1}`,
      symbolMappingId: matched?.id ?? null,
      symbolName: matched?.name ?? String(s.symbolName || 'Unmapped Symbol').trim().slice(0, 80),
      symbolCode: matched?.code ?? String(s.symbolCode || 'UNK').trim().toUpperCase().slice(0, 24),
      domain,
      electricalItemType: matched?.electricalItemType,
      electricalCategory: matched?.electricalCategory,
      x: clamp01(s.x, 0.5),
      y: clamp01(s.y, 0.5),
      rotationDeg: Number.isFinite(s.rotationDeg) ? Math.round(s.rotationDeg) % 360 : 0,
      confidence,
      status: statusFromConfidence(confidence, forceUncertain),
      source: 'ai',
      origin: 'vision-ai',
      matchedByUserLegend: Boolean(matched),
      note: matched
        ? typeof s.note === 'string'
          ? s.note.trim()
          : undefined
        : [typeof s.note === 'string' ? s.note.trim() : '', 'Not matched to a user-defined symbol; assign mapping before approval']
            .filter(Boolean)
            .join(' — '),
    };
  });

  // Flag near-duplicate overlapping symbols
  for (let i = 0; i < symbols.length; i += 1) {
    for (let j = i + 1; j < symbols.length; j += 1) {
      const a = symbols[i];
      const b = symbols[j];
      if (
        a.symbolCode === b.symbolCode &&
        Math.hypot(a.x - b.x, a.y - b.y) < 0.012
      ) {
        b.isDuplicateCandidate = true;
        b.status = 'uncertain';
        b.note = [b.note, 'Near-duplicate symbol location'].filter(Boolean).join(' — ');
      }
    }
  }

  // Wiring paths
  const wiringPaths: DetectedWiringPath[] = (
    Array.isArray(rawAnalysis.wiringPaths) ? rawAnalysis.wiringPaths : []
  )
    .map((wp, idx): DetectedWiringPath | null => {
      const pts = Array.isArray(wp.points)
        ? wp.points.map((p) => ({ x: clamp01(p.x, 0.5), y: clamp01(p.y, 0.5) }))
        : [];
      if (pts.length < 2) return null;
      const confidence = clamp01(wp.confidence, 0.55);
      return {
        id: `ai-wire-${idx + 1}`,
        label: String(wp.label || `Wire Run ${idx + 1}`).trim().slice(0, 40),
        points: pts,
        circuitHint: typeof wp.circuitHint === 'string' ? wp.circuitHint.trim() : undefined,
        confidence,
        status: statusFromConfidence(confidence),
        source: 'ai',
      };
    })
    .filter((item): item is DetectedWiringPath => item !== null);

  // Dimensions
  const dimensions: DetectedDimension[] = (
    Array.isArray(rawAnalysis.dimensions) ? rawAnalysis.dimensions : []
  )
    .map((d, idx): DetectedDimension | null => {
      const x1 = clamp01(d.x1, 0);
      const y1 = clamp01(d.y1, 0);
      const x2 = clamp01(d.x2, 0);
      const y2 = clamp01(d.y2, 0);
      if (Math.hypot(x2 - x1, y2 - y1) < 0.01) return null;
      const confidence = clamp01(d.confidence, 0.6);
      const labelText = String(d.labelText || '').trim().slice(0, 40);
      const parsedMeters = labelText ? parseDimensionTextToMeters(labelText)?.meters : undefined;
      return {
        id: `ai-dim-${idx + 1}`,
        x1,
        y1,
        x2,
        y2,
        labelText,
        confidence,
        status: statusFromConfidence(confidence),
        source: 'ai',
        origin: 'vision-ai',
        parsedMeters,
        measurementKind: parsedMeters && confidence >= 0.72 ? 'exact' : 'estimated',
      };
    })
    .filter((item): item is DetectedDimension => item !== null);

  // Text labels
  const textLabels: DetectedTextLabel[] = (
    Array.isArray(rawAnalysis.textLabels) ? rawAnalysis.textLabels : []
  )
    .map((t, idx): DetectedTextLabel | null => {
      const text = String(t.text || '').trim().slice(0, 120);
      if (!text) return null;
      const confidence = clamp01(t.confidence, 0.7);
      const kind =
        t.kind === 'room-label' ||
        t.kind === 'annotation' ||
        t.kind === 'title-block' ||
        t.kind === 'legend-text'
          ? t.kind
          : 'annotation';
      return {
        id: `ai-txt-${idx + 1}`,
        text,
        x: clamp01(t.x, 0.5),
        y: clamp01(t.y, 0.5),
        kind,
        confidence,
        status: statusFromConfidence(confidence),
        source: 'ai',
      };
    })
    .filter((item): item is DetectedTextLabel => item !== null);

  const legendEntries: DetectedLegendEntry[] = (
    Array.isArray(rawAnalysis.legendEntries) ? rawAnalysis.legendEntries : []
  ).map((le, idx) => ({
    id: `ai-leg-${idx + 1}`,
    code: String(le.code || `L${idx + 1}`).trim().slice(0, 24),
    label: String(le.label || 'Legend Entry').trim().slice(0, 80),
    description: String(le.description || '').trim().slice(0, 200),
    confidence: clamp01(le.confidence, 0.65),
  }));

  const unmappedCount = symbols.filter((s) => !s.matchedByUserLegend).length;
  if (unmappedCount > 0) {
    warnings.push(
      `${unmappedCount} detected symbol(s) did not match your defined symbol library and are marked Uncertain for manual review.`
    );
  }

  return {
    version: 1,
    analyzedAt,
    providerModel,
    sourcePage: pageNumber,
    walls,
    rooms,
    openings,
    columns,
    staircases,
    furniture,
    symbols,
    wiringPaths,
    dimensions,
    textLabels,
    legendEntries,
    titleBlock: rawAnalysis.titleBlock ?? {},
    warnings,
    summary:
      typeof rawAnalysis.summary === 'string' && rawAnalysis.summary.trim()
        ? rawAnalysis.summary.trim()
        : 'AI drawing analysis completed. Review uncertain items and verify scale calibration before generating the 2D model.',
  };
}

/**
 * Builds an editable IntermediateDrawingModel directly from native PDF vector geometry & text extraction,
 * preserving every straight, angled, and tessellated curved wall without bounding-box simplification.
 */
export function buildVectorSeedModel(
  extraction: PdfVectorExtractionResult,
  symbolLibrary: SymbolMappingDefinition[],
  analyzedAt = new Date().toISOString()
): IntermediateDrawingModel {
  const isRasterCv = extraction.sourceKind !== 'vector-pdf';
  const walls: DetectedWall[] = extraction.wallSegments.map((seg, idx) => ({
    id: `${isRasterCv ? 'cv' : 'vec'}-wall-${idx + 1}`,
    x1: seg.x1,
    y1: seg.y1,
    x2: seg.x2,
    y2: seg.y2,
    wallKind: seg.wallKind,
    isCurvedSegment: seg.isCurvedSegment || undefined,
    curveGroupId: seg.curveGroupId,
    confidence: isRasterCv ? 0.68 : 0.96,
    status: isRasterCv ? 'uncertain' : 'approved',
    source: 'ai',
    origin: isRasterCv ? 'raster-cv' : 'pdf-vector',
    note: isRasterCv
      ? seg.isAngled
        ? 'Raster CV angled wall candidate — review against source image'
        : 'Raster CV wall candidate — review against source image'
      : seg.isCurvedSegment
        ? 'Direct PDF curved vector chord'
        : seg.isAngled
          ? 'Direct PDF angled vector wall'
          : 'Direct PDF vector wall',
  }));

  const columns: DetectedColumn[] = (extraction.columns ?? []).map((col, idx) => ({
    id: `vec-col-${idx + 1}`,
    label: col.label || `C${idx + 1}`,
    x: col.x,
    y: col.y,
    widthNorm: col.widthNorm,
    heightNorm: col.heightNorm,
    confidence: 0.92,
    status: 'approved',
    source: 'ai',
  }));

  const textLabels: DetectedTextLabel[] = extraction.textItems
    .filter((t) => t.kind !== 'dimension')
    .map((t, idx) => ({
      id: `vec-txt-${idx + 1}`,
      text: t.text,
      x: t.x,
      y: t.y,
      kind:
        t.kind === 'room-label' || t.kind === 'title-block' || t.kind === 'legend-text'
          ? t.kind
          : 'annotation',
      confidence: 0.95,
      status: t.kind === 'legend-text' || t.kind === 'title-block' ? 'rejected' : 'approved',
      source: 'ai',
    }));

  const legendEntries: DetectedLegendEntry[] = extraction.legendEntries.map((le, idx) => ({
    id: `vec-leg-${idx + 1}`,
    code: le.code,
    label: le.label,
    description: le.description,
    confidence: 0.94,
  }));

  // Detect symbol callout tags placed on the drawing (e.g. "DL-1", "LP-1", "DB-1") matching user legend or PDF legend
  const symbols: DetectedSymbolInstance[] = [];
  const legendCodeSet = new Set(extraction.legendEntries.map((l) => l.code.toUpperCase()));
  for (const item of extraction.textItems) {
    if (item.kind === 'legend-text' || item.kind === 'title-block' || item.kind === 'dimension') {
      continue;
    }
    const token = item.text.trim().toUpperCase();
    if (!/^[A-Z]{1,4}[-/]?\d{1,3}[A-Z]?$/.test(token)) continue;

    const matched = resolveUserSymbolMapping(
      { symbolCode: token, symbolName: token },
      symbolLibrary
    );
    const inPdfLegend = legendCodeSet.has(token);
    if (!matched && !inPdfLegend) continue;

    const legendMeta = extraction.legendEntries.find((l) => l.code.toUpperCase() === token);
    symbols.push({
      id: `vec-sym-${symbols.length + 1}`,
      symbolMappingId: matched?.id ?? null,
      symbolName: matched?.name ?? legendMeta?.label ?? token,
      symbolCode: matched?.code ?? token,
      domain: matched?.domain ?? 'lighting',
      electricalItemType: matched?.electricalItemType,
      electricalCategory: matched?.electricalCategory,
      x: item.x,
      y: item.y,
      rotationDeg: 0,
      confidence: matched ? 0.9 : 0.62,
      status: matched ? 'approved' : 'uncertain',
      source: 'ai',
      origin: 'pdf-vector',
      matchedByUserLegend: Boolean(matched),
      note: matched
        ? `Matched PDF symbol tag "${token}" directly from vector text layer`
        : `PDF legend tag "${token}" detected — assign a user symbol mapping to auto-place in 2D CAD`,
    });
  }

  return {
    version: 1,
    analyzedAt,
    providerModel: isRasterCv ? 'raster-cv-extractor' : 'pdf-vector-extractor',
    sourcePage: extraction.pageNumber,
    sourceKind: extraction.sourceKind,
    walls,
    rooms: [],
    openings: [],
    columns,
    staircases: [],
    furniture: [],
    symbols,
    wiringPaths: [],
    dimensions: [],
    textLabels,
    legendEntries,
    titleBlock: extraction.titleBlock,
    warnings: [...extraction.warnings],
    summary: isRasterCv
      ? `Computer-vision line pass traced ${walls.length} candidate wall segment(s) (${extraction.angledSegmentCount} angled) from the raster drawing. Review or run Vision AI + OCR for rooms, openings, and symbols.`
      : `Extracted ${walls.length} direct PDF vector wall segment(s) (${extraction.angledSegmentCount} angled, ${extraction.curvedSegmentCount} curved chords), ${columns.length} structural column(s), ${textLabels.filter((t) => t.status === 'approved').length} clean plan label(s), ${extraction.dimensions.length} exact dimension value(s), and ${symbols.length} tagged symbol(s).`,
  };
}

/**
 * Hybrid Vector + Vision AI Fusion:
 * Keeps exact native PDF vector wall geometry (including angled & curved walls) as primary geometry,
 * appends non-overlapping AI-discovered walls, keeps all Vision AI semantic detections (rooms with polygons,
 * openings, columns, staircases, furniture, electrical symbols, wiring paths), and fuses exact PDF text/legend/titleBlock.
 */
export function mergeVectorAndAiModels(
  extraction: PdfVectorExtractionResult | null,
  aiModel: IntermediateDrawingModel,
  symbolLibrary: SymbolMappingDefinition[]
): IntermediateDrawingModel {
  if (!extraction || extraction.sourceKind !== 'vector-pdf' || extraction.wallSegments.length < 4) {
    return {
      ...aiModel,
      sourceKind: extraction?.sourceKind ?? 'raster-image',
      furniture: aiModel.furniture ?? [],
    };
  }

  const vectorSeed = buildVectorSeedModel(extraction, symbolLibrary, aiModel.analyzedAt);

  // Start with exact PDF vector walls, then add any Vision AI walls that don't overlap a vector wall
  const fusedWalls: DetectedWall[] = [...vectorSeed.walls];
  for (const aiWall of aiModel.walls) {
    const overlapsVector = vectorSeed.walls.some((vw) => {
      const midX = (aiWall.x1 + aiWall.x2) / 2;
      const midY = (aiWall.y1 + aiWall.y2) / 2;
      const vMidX = (vw.x1 + vw.x2) / 2;
      const vMidY = (vw.y1 + vw.y2) / 2;
      if (Math.hypot(midX - vMidX, midY - vMidY) < 0.025) return true;
      const same =
        Math.hypot(vw.x1 - aiWall.x1, vw.y1 - aiWall.y1) < 0.022 &&
        Math.hypot(vw.x2 - aiWall.x2, vw.y2 - aiWall.y2) < 0.022;
      const rev =
        Math.hypot(vw.x1 - aiWall.x2, vw.y1 - aiWall.y2) < 0.022 &&
        Math.hypot(vw.x2 - aiWall.x1, vw.y2 - aiWall.y1) < 0.022;
      return same || rev;
    });
    if (!overlapsVector) {
      fusedWalls.push({
        ...aiWall,
        origin: 'vision-ai',
      });
    }
  }

  // Merge symbols: keep all Vision AI symbols + any PDF vector-tagged symbols not already near an AI symbol
  const fusedSymbols: DetectedSymbolInstance[] = [...aiModel.symbols];
  for (const vs of vectorSeed.symbols) {
    const alreadyDetected = fusedSymbols.some(
      (as) => Math.hypot(as.x - vs.x, as.y - vs.y) < 0.025
    );
    if (!alreadyDetected) {
      fusedSymbols.push(vs);
    }
  }

  // Merge text labels: prefer exact PDF text coordinates, append unique Vision AI labels
  const fusedTextLabels: DetectedTextLabel[] = [...vectorSeed.textLabels];
  for (const at of aiModel.textLabels) {
    const dup = fusedTextLabels.some(
      (vt) =>
        vt.text.toLowerCase() === at.text.toLowerCase() &&
        Math.hypot(vt.x - at.x, vt.y - at.y) < 0.06
    );
    if (!dup) fusedTextLabels.push(at);
  }

  // Merge structural columns (vector columns + non-overlapping AI columns)
  const fusedColumns: DetectedColumn[] = [...vectorSeed.columns];
  for (const ac of aiModel.columns) {
    const dup = fusedColumns.some((vc) => Math.hypot(vc.x - ac.x, vc.y - ac.y) < 0.03);
    if (!dup) fusedColumns.push(ac);
  }

  // Tag AI dimensions as 'exact' when backed by an exact extracted PDF dimension string
  const fusedDimensions: DetectedDimension[] = aiModel.dimensions.map((d) => {
    const midX = (d.x1 + d.x2) / 2;
    const midY = (d.y1 + d.y2) / 2;
    const matchedPdfDim = extraction.dimensions.find(
      (pd) =>
        Math.hypot(pd.x - midX, pd.y - midY) < 0.1 ||
        pd.labelText.replace(/\s+/g, '').toLowerCase() ===
          d.labelText.replace(/\s+/g, '').toLowerCase()
    );
    return matchedPdfDim
      ? {
          ...d,
          measurementKind: 'exact' as const,
          parsedMeters: matchedPdfDim.parsedMeters,
          origin: 'pdf-vector' as const,
        }
      : {
          ...d,
          measurementKind: d.measurementKind ?? 'estimated',
        };
  });

  // Merge legend entries
  const fusedLegend: DetectedLegendEntry[] = [...vectorSeed.legendEntries];
  for (const al of aiModel.legendEntries) {
    if (!fusedLegend.some((vl) => vl.code.toLowerCase() === al.code.toLowerCase())) {
      fusedLegend.push(al);
    }
  }

  const mergedWarnings = Array.from(new Set([...extraction.warnings, ...aiModel.warnings]));

  return {
    ...aiModel,
    sourceKind: 'vector-pdf',
    providerModel: `hybrid-pdf-vector+${aiModel.providerModel}`,
    walls: fusedWalls,
    columns: fusedColumns,
    furniture: aiModel.furniture ?? [],
    symbols: fusedSymbols,
    dimensions: fusedDimensions,
    textLabels: fusedTextLabels,
    legendEntries: fusedLegend,
    titleBlock: {
      ...aiModel.titleBlock,
      ...extraction.titleBlock,
    },
    warnings: mergedWarnings,
    summary: `Hybrid PDF Vector + Vision AI reconstruction: ${fusedWalls.length} wall segments (${vectorSeed.walls.length} exact PDF vector, ${extraction.angledSegmentCount} angled, ${extraction.curvedSegmentCount} curved chords), ${aiModel.rooms.length} room zones, ${aiModel.openings.length} openings, ${fusedColumns.length} columns, ${(aiModel.furniture ?? []).length} furniture items, and ${fusedSymbols.length} symbols.`,
  };
}

function isSegmentAngledOrCurved(w: DetectedWall): boolean {
  if (w.isCurvedSegment) return true;
  const dx = Math.abs(w.x2 - w.x1);
  const dy = Math.abs(w.y2 - w.y1);
  if (Math.hypot(dx, dy) < 1e-5) return false;
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return angleDeg > 3 && angleDeg < 87;
}

/**
 * Evaluates whether the reconstructed model faithfully reproduces the drawing
 * and blocks generation when only a few bounding boxes or severely incomplete geometry exist.
 */
export function evaluateReconstructionCompleteness(
  model: IntermediateDrawingModel | null,
  calibration: CalibrationConfig | null,
  drawingType: AiDrawingType
): ReconstructionQualityReport {
  if (!model) {
    return {
      status: 'empty',
      score: 0,
      blockers: ['No drawing geometry has been extracted or traced yet.'],
      warnings: [],
      metrics: {
        approvedWalls: 0,
        externalWalls: 0,
        internalWalls: 0,
        angledOrCurvedWalls: 0,
        approvedRooms: 0,
        polygonRooms: 0,
        approvedOpenings: 0,
        approvedColumns: 0,
        approvedFurniture: 0,
        approvedSymbols: 0,
        mappedSymbols: 0,
        unmappedSymbols: 0,
        approvedDimensions: 0,
        approvedLabels: 0,
        uncertainCount: 0,
        wallEnvelopeCoverage: 0,
      },
    };
  }

  const approvedWalls = model.walls.filter((w) => w.status === 'approved');
  const externalWalls = approvedWalls.filter((w) => w.wallKind === 'external').length;
  const internalWalls = approvedWalls.filter((w) => w.wallKind === 'internal').length;
  const angledOrCurvedWalls = approvedWalls.filter(isSegmentAngledOrCurved).length;
  const approvedRooms = model.rooms.filter((r) => r.status === 'approved');
  const polygonRooms = approvedRooms.filter((r) => Array.isArray(r.polygon) && r.polygon.length >= 3).length;
  const approvedOpenings = model.openings.filter((o) => o.status === 'approved').length;
  const approvedColumns = model.columns.filter((c) => c.status === 'approved').length;
  const approvedFurniture = (model.furniture ?? []).filter((f) => f.status === 'approved').length;
  const approvedSymbols = model.symbols.filter((s) => s.status === 'approved');
  const mappedSymbols = approvedSymbols.filter((s) => s.matchedByUserLegend || Boolean(s.electricalItemType)).length;
  const unmappedSymbols = model.symbols.filter((s) => s.status !== 'rejected' && !s.matchedByUserLegend).length;
  const approvedDimensions = model.dimensions.filter((d) => d.status === 'approved').length;
  const approvedLabels = model.textLabels.filter((t) => t.status === 'approved').length;

  const allItems = [
    ...model.walls,
    ...model.rooms,
    ...model.openings,
    ...model.columns,
    ...model.staircases,
    ...(model.furniture ?? []),
    ...model.symbols,
    ...model.wiringPaths,
    ...model.dimensions,
    ...model.textLabels,
  ];
  const uncertainCount = allItems.filter((i) => i.status === 'uncertain').length;

  let wallEnvelopeCoverage = 0;
  if (approvedWalls.length > 0) {
    let minX = 1;
    let maxX = 0;
    let minY = 1;
    let maxY = 0;
    for (const w of approvedWalls) {
      minX = Math.min(minX, w.x1, w.x2);
      maxX = Math.max(maxX, w.x1, w.x2);
      minY = Math.min(minY, w.y1, w.y2);
      maxY = Math.max(maxY, w.y1, w.y2);
    }
    wallEnvelopeCoverage = round2(Math.max(0, (maxX - minX) * (maxY - minY)));
  }

  const blockers: string[] = [];
  const warnings: string[] = [];

  const totalApprovedCore =
    approvedWalls.length + approvedRooms.length + approvedSymbols.length + approvedOpenings;

  if (totalApprovedCore === 0) {
    blockers.push('No approved walls, rooms, or symbols exist yet. Run Vector/AI extraction or trace geometry first.');
  } else {
    // Reject bounding-box-only oversimplifications (e.g. only 1-2 rectangles and no actual wall network)
    if (approvedWalls.length === 0 && approvedRooms.length > 0 && approvedRooms.length <= 2) {
      blockers.push(
        `Incomplete detection: only ${approvedRooms.length} rectangular room box(es) detected with 0 actual wall segments. Extract vector walls or trace the real building outline and partitions before generating.`
      );
    } else if (approvedWalls.length > 0 && approvedWalls.length < 4 && approvedRooms.length <= 2) {
      blockers.push(
        `Incomplete building outline: only ${approvedWalls.length} wall segment(s) detected (minimum 4 segments required to form an enclosed layout). Complete missing exterior and internal walls before generating.`
      );
    }

    const isElectricalLayout =
      drawingType === 'Electrical Layout' ||
      drawingType === 'Lighting Layout' ||
      drawingType === 'Combined Architectural & Electrical';
    if (isElectricalLayout && approvedSymbols.length === 0 && model.symbols.length === 0) {
      warnings.push(
        `No electrical/lighting symbols detected yet for this ${drawingType}. Map legend symbols or place fixtures before finalizing.`
      );
    }
    if (approvedWalls.length >= 4 && internalWalls === 0 && approvedRooms.length <= 1) {
      warnings.push(
        'Only exterior outline walls detected with no internal partitions. Verify whether interior walls are missing.'
      );
    }
    if (approvedWalls.length >= 4 && wallEnvelopeCoverage < 0.04) {
      warnings.push(
        'Detected wall geometry covers less than 4% of the sheet area. Check crop region or missing wings.'
      );
    }
  }

  if (calibration && !calibration.calibrated) {
    warnings.push('Scale is not yet calibrated. Use 2-point calibration or a detected PDF dimension for exact metric accuracy.');
  }
  if (uncertainCount > 0) {
    warnings.push(`${uncertainCount} uncertain detection(s) require review or approval before export.`);
  }
  if (unmappedSymbols > 0) {
    warnings.push(`${unmappedSymbols} detected symbol(s) are not mapped to your symbol library.`);
  }

  let score = 0;
  if (approvedWalls.length >= 4) score += 35;
  else score += approvedWalls.length * 6;
  if (internalWalls > 0) score += 15;
  if (approvedRooms.length > 0) score += 15;
  if (approvedOpenings > 0 || approvedColumns > 0 || approvedFurniture > 0) score += 10;
  if (approvedSymbols.length > 0) score += 15;
  if (calibration?.calibrated) score += 10;
  score = Math.max(0, Math.min(100, score));

  const status: ReconstructionQualityReport['status'] =
    totalApprovedCore === 0 ? 'empty' : blockers.length > 0 ? 'incomplete' : 'ready';

  return {
    status,
    score,
    blockers,
    warnings,
    metrics: {
      approvedWalls: approvedWalls.length,
      externalWalls,
      internalWalls,
      angledOrCurvedWalls,
      approvedRooms: approvedRooms.length,
      polygonRooms,
      approvedOpenings,
      approvedColumns,
      approvedFurniture,
      approvedSymbols: approvedSymbols.length,
      mappedSymbols,
      unmappedSymbols,
      approvedDimensions,
      approvedLabels,
      uncertainCount,
      wallEnvelopeCoverage,
    },
  };
}

export interface ConvertTo2DParams {
  model: IntermediateDrawingModel;
  calibration: CalibrationConfig;
  metadata: DrawingProjectMetadata;
  source: Pick<
    UploadedDrawingSource,
    'originalFileName' | 'mimeType' | 'selectedPage'
  >;
  symbolMappings: SymbolMappingDefinition[];
  layers?: DrawingLayerState[];
  existingProject?: ProjectData;
  /** Optional aligned reference image underlay preserved for comparison inside Blue Space 2D editor */
  referenceOverlay?: ReferenceOverlayConfig;
}

export interface ConvertTo2DResult {
  project: ProjectData;
  isNewProject: boolean;
  summary: AiDrawingImportMeta['countsSummary'];
}

function pointInPolygon(x: number, y: number, poly: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function findContainingRoomId(x: number, y: number, rooms: RoomZone[]): string {
  const polyMatch = rooms.find(
    (r) => Array.isArray(r.polygon) && r.polygon.length >= 3 && pointInPolygon(x, y, r.polygon)
  );
  if (polyMatch) return polyMatch.id;
  const match = rooms.find(
    (r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height
  );
  return match?.id ?? rooms[0]?.id ?? 'room-unassigned';
}

function findNearestPointId(
  x: number,
  y: number,
  points: ElectricalPoint[],
  maxDistMeters = 1.5
): ElectricalPoint | undefined {
  let best: ElectricalPoint | undefined;
  let bestDist = maxDistMeters;
  for (const pt of points) {
    const d = Math.hypot(pt.x - x, pt.y - y);
    if (d < bestDist) {
      bestDist = d;
      best = pt;
    }
  }
  return best;
}

/**
 * Converts ONLY status === 'approved' detections in the IntermediateDrawingModel into genuine
 * native editable Blue Space 2D CAD objects (CustomWall, RoomZone, ArchitecturalOpening,
 * StaircaseItem, ElectricalPoint, ElectricalWire, DimensionAnnotation) plus optional
 * columns/text annotations in project.aiDrawingImport.
 *
 * Strict integrity guarantees:
 * - Never includes 'uncertain' or 'rejected' objects in CAD geometry or electrical quantities.
 * - Never invents product prices (unitCost = 0 until user links catalogue / sets price).
 * - Preserves full compatibility with existing .bluespace and JSON project formats.
 */
export function generateEditable2DProjectFromModel(params: ConvertTo2DParams): ConvertTo2DResult {
  const { model, calibration, metadata, source, symbolMappings, existingProject } = params;
  const isMerge = metadata.importTarget === 'merge-active-floor' && Boolean(existingProject);
  const targetFloor = isMerge ? Math.floor(metadata.targetFloor || 1) : 1;

  const spanW = Math.max(2, calibration.drawingWidthMeters);
  const spanH = Math.max(2, calibration.drawingHeightMeters);

  // Count how many items were excluded because they remained uncertain or rejected
  const allDetections = [
    ...model.walls,
    ...model.rooms,
    ...model.openings,
    ...model.columns,
    ...model.staircases,
    ...(model.furniture ?? []),
    ...model.symbols,
    ...model.wiringPaths,
    ...model.dimensions,
    ...model.textLabels,
  ];
  const excludedUncertainOrRejected = allDetections.filter((d) => d.status !== 'approved').length;

  const idPrefix = `aid-${Date.now().toString(36)}`;
  const defaultWallThickM = Math.max(0.1, Math.min(0.5, metadata.defaultWallThicknessM || 0.15));
  const defaultCeilingM = Math.max(2.4, Math.min(6, metadata.defaultCeilingHeightM || 3.0));

  // If merging into an existing project, apply UNIFORM isotropic scaling so aspect ratio & angles are NEVER distorted
  const targetDims = isMerge && existingProject ? siteToMeters(existingProject.site) : null;
  const uniformFit = targetDims
    ? Math.min(1, targetDims.lengthM / spanW, targetDims.widthM / spanH)
    : 1;
  const mapW = round2(spanW * uniformFit);
  const mapH = round2(spanH * uniformFit);

  const toXM = (nx: number) => round2(clamp01(nx) * mapW);
  const toYM = (ny: number) => round2(clamp01(ny) * mapH);

  // 1. Walls (approved only — preserve short chords >= 0.05m so curved walls remain smooth!)
  const newWalls: CustomWall[] = model.walls
    .filter((w) => w.status === 'approved')
    .map((w, idx): CustomWall => ({
      id: `${idPrefix}-wall-${idx + 1}`,
      floor: targetFloor,
      x1: toXM(w.x1),
      y1: toYM(w.y1),
      x2: toXM(w.x2),
      y2: toYM(w.y2),
      thickness: w.thicknessMeters ?? (w.wallKind === 'external' ? Math.max(defaultWallThickM, 0.2) : defaultWallThickM),
      wallKind: w.wallKind,
      isCurvedSegment: w.isCurvedSegment || undefined,
      curveGroupId: w.curveGroupId,
    }))
    .filter((w) => Math.hypot(w.x2 - w.x1, w.y2 - w.y1) >= (w.isCurvedSegment ? 0.05 : 0.12));

  const hasExplicitWallNetwork = newWalls.length >= 4;

  // 2. Rooms (approved only — preserve exact polygons and disable synthetic rectangular walls when explicit walls exist)
  const newRooms: RoomZone[] = model.rooms
    .filter((r) => r.status === 'approved')
    .map((r, idx): RoomZone => {
      const metricPoly =
        Array.isArray(r.polygon) && r.polygon.length >= 3
          ? r.polygon.map((p) => ({ x: toXM(p.x), y: toYM(p.y) }))
          : undefined;
      return {
        id: `${idPrefix}-room-${idx + 1}`,
        name: r.name || `Room ${idx + 1}`,
        type: r.roomType,
        floor: targetFloor,
        x: toXM(r.x),
        y: toYM(r.y),
        width: Math.max(0.5, round2(r.width * mapW)),
        height: Math.max(0.5, round2(r.height * mapH)),
        wallThickness: defaultWallThickM,
        floorFinish: r.roomType.includes('bath') || r.roomType === 'kitchen' ? 'tile' : 'wood',
        noAutoWalls: hasExplicitWallNetwork || Boolean(metricPoly),
        polygon: metricPoly,
      };
    });

  // 3. Openings (approved only)
  const newOpenings: ArchitecturalOpening[] = model.openings
    .filter((o) => o.status === 'approved')
    .map((o, idx): ArchitecturalOpening => ({
      id: `${idPrefix}-open-${idx + 1}`,
      floor: targetFloor,
      kind: o.kind,
      x: toXM(o.x),
      y: toYM(o.y),
      width: Math.max(0.5, Math.min(4.0, round2(o.widthNorm * mapW))),
      rotation: o.rotationDeg,
    }));

  // 4. Staircases (approved only)
  const newStaircases: StaircaseItem[] = model.staircases
    .filter((s) => s.status === 'approved')
    .map((s, idx): StaircaseItem => ({
      id: `${idPrefix}-stair-${idx + 1}`,
      name: s.label || `Staircase ${idx + 1}`,
      type: 'straight',
      fromFloor: targetFloor,
      toFloor: targetFloor + 1,
      x: toXM(s.x),
      y: toYM(s.y),
      rotation: s.rotationDeg,
      width: Math.max(0.9, Math.min(3.0, round2(s.widthNorm * mapW))),
      riserHeight: 0.17,
      treadDepth: 0.25,
      steps: s.steps ?? 14,
      landingWidth: 1.0,
      landingDepth: 1.0,
    }));

  // 5. Dimensions (approved only)
  const newDimensions: DimensionAnnotation[] = model.dimensions
    .filter((d) => d.status === 'approved')
    .map((d, idx): DimensionAnnotation => ({
      id: `${idPrefix}-dim-${idx + 1}`,
      floor: targetFloor,
      x1: toXM(d.x1),
      y1: toYM(d.y1),
      x2: toXM(d.x2),
      y2: toYM(d.y2),
    }))
    .filter((d) => Math.hypot(d.x2 - d.x1, d.y2 - d.y1) >= 0.1);

  // 6. Furniture (approved only)
  const combinedRooms = isMerge && existingProject
    ? [...existingProject.rooms.filter((r) => (r.floor ?? 1) === targetFloor), ...newRooms]
    : newRooms;

  const newFurniture: FurnitureItem[] = (model.furniture ?? [])
    .filter((f) => f.status === 'approved')
    .map((f, idx): FurnitureItem => {
      const fx = toXM(f.x);
      const fy = toYM(f.y);
      return {
        id: `${idPrefix}-furn-${idx + 1}`,
        floor: targetFloor,
        kind: f.kind,
        roomId: findContainingRoomId(fx, fy, combinedRooms),
        x: fx,
        y: fy,
        width: Math.max(0.4, Math.min(6, round2(f.widthNorm * mapW))),
        depth: Math.max(0.4, Math.min(4, round2(f.heightNorm * mapH))),
        rotation: f.rotationDeg,
      };
    });

  // 7. Electrical Points from approved symbols that map to an electrical item type
  const codeCounters = new Map<string, number>();
  const newPoints: ElectricalPoint[] = [];
  const extraSymbolTextLabels: ImportedTextAnnotation2D[] = [];

  for (const sym of model.symbols) {
    if (sym.status !== 'approved') continue;
    const x = toXM(sym.x);
    const y = toYM(sym.y);

    if (sym.electricalItemType) {
      const catalog = ELECTRICAL_CATALOG.find((c) => c.itemType === sym.electricalItemType);
      const baseCode = sym.symbolCode || catalog?.shortCode || 'PT';
      const nextNum = (codeCounters.get(baseCode) ?? 0) + 1;
      codeCounters.set(baseCode, nextNum);

      newPoints.push({
        id: `${idPrefix}-pt-${newPoints.length + 1}`,
        floor: targetFloor,
        code: `${baseCode}-${nextNum}`,
        name: sym.symbolName || catalog?.label || 'Imported Symbol',
        itemType: sym.electricalItemType,
        category: sym.electricalCategory ?? catalog?.category ?? 'Lighting',
        roomId: findContainingRoomId(x, y, combinedRooms),
        x,
        y,
        z: catalog?.defaultMountHeight ?? 2.4,
        rotation: sym.rotationDeg,
        wattage: catalog?.defaultWattage ?? 0,
        voltage: 230,
        circuit: catalog?.defaultCircuit ?? '',
        // Never invent missing prices — leave unitCost = 0 until linked to Product Catalogue or priced by user
        unitCost: 0,
        specification: `Imported from ${source.originalFileName} (Page ${source.selectedPage})`,
      });
    } else {
      // Architectural or non-electrical custom symbol preserved as editable text annotation
      extraSymbolTextLabels.push({
        id: `${idPrefix}-symtxt-${extraSymbolTextLabels.length + 1}`,
        floor: targetFloor,
        text: `[${sym.symbolCode}] ${sym.symbolName}`,
        x,
        y,
        kind: 'annotation',
      });
    }
  }

  // 8. Electrical Wires from approved wiring paths (only when endpoints connect to valid points)
  const availablePoints =
    isMerge && existingProject
      ? [...existingProject.points.filter((p) => (p.floor ?? 1) === targetFloor), ...newPoints]
      : newPoints;

  const newWires: ElectricalWire[] = [];
  for (const wp of model.wiringPaths) {
    if (wp.status !== 'approved' || wp.points.length < 2) continue;
    const first = wp.points[0];
    const last = wp.points[wp.points.length - 1];
    const fromPt = findNearestPointId(toXM(first.x), toYM(first.y), availablePoints);
    const toPt = findNearestPointId(toXM(last.x), toYM(last.y), availablePoints);
    if (!fromPt || !toPt || fromPt.id === toPt.id) continue;

    const middleWaypoints = wp.points.slice(1, -1).map((p) => ({
      x: toXM(p.x),
      y: toYM(p.y),
    }));

    newWires.push({
      id: `${idPrefix}-wire-${newWires.length + 1}`,
      code: `W-AI-${newWires.length + 1}`,
      floor: targetFloor,
      fromPointId: fromPt.id,
      toPointId: toPt.id,
      fromFloor: targetFloor,
      toFloor: targetFloor,
      waypoints: middleWaypoints,
      circuit: fromPt.circuit || toPt.circuit || '',
      category: 'phase',
      wireType: 'Imported 2D Circuit Run',
      cableMaterial: 'Unspecified',
      cableSizeSqMm: null, // Never silently invent cable size
      cores: 3,
      phaseDesignation: 'L1 (R)',
      color: '#ef4444',
      lineThickness: 2,
      lineStyle: 'solid',
      status: 'draft',
      assumptionNote: `Imported from ${source.originalFileName}; verify circuit & cable sizing.`,
    });
  }

  // 9. Columns & Text annotations (approved only)
  const newColumns: ImportedColumn2D[] = model.columns
    .filter((c) => c.status === 'approved')
    .map((c, idx) => ({
      id: `${idPrefix}-col-${idx + 1}`,
      floor: targetFloor,
      label: c.label,
      x: toXM(c.x),
      y: toYM(c.y),
      width: Math.max(0.2, round2(c.widthNorm * mapW)),
      height: Math.max(0.2, round2(c.heightNorm * mapH)),
    }));

  // Exclude legend-text, title-block, and duplicate room labels already rendered by RoomZone so text never overlaps
  const newTextAnnotations: ImportedTextAnnotation2D[] = [
    ...model.textLabels
      .filter((t) => {
        if (t.status !== 'approved') return false;
        if (t.kind === 'legend-text' || t.kind === 'title-block') return false;
        const tx = toXM(t.x);
        const ty = toYM(t.y);
        if (t.kind === 'room-label') {
          const dupRoom = combinedRooms.some((r) => {
            const nameMatch =
              r.name.trim().toLowerCase() === t.text.trim().toLowerCase() ||
              r.name.trim().toLowerCase().includes(t.text.trim().toLowerCase());
            const nearCenter =
              Math.hypot(tx - (r.x + r.width / 2), ty - (r.y + r.height / 2)) <
              Math.max(1.5, Math.min(r.width, r.height) * 0.6);
            return nameMatch && nearCenter;
          });
          if (dupRoom) return false;
        }
        return true;
      })
      .map((t, idx) => ({
        id: `${idPrefix}-txt-${idx + 1}`,
        floor: targetFloor,
        text: t.text,
        x: toXM(t.x),
        y: toYM(t.y),
        kind: t.kind,
      })),
    ...extraSymbolTextLabels,
  ];

  const countsSummary: AiDrawingImportMeta['countsSummary'] = {
    walls: newWalls.length,
    rooms: newRooms.length,
    openings: newOpenings.length,
    columns: newColumns.length,
    staircases: newStaircases.length,
    furniture: newFurniture.length,
    electricalPoints: newPoints.length,
    wires: newWires.length,
    dimensions: newDimensions.length,
    textAnnotations: newTextAnnotations.length,
    excludedUncertainOrRejected,
  };

  const importMeta: AiDrawingImportMeta = {
    importedAt: new Date().toISOString(),
    sourceFileName: source.originalFileName,
    sourceMimeType: source.mimeType,
    sourcePage: source.selectedPage,
    sourceKind: model.sourceKind,
    drawingType: metadata.drawingType,
    measurementUnit: metadata.measurementUnit,
    scaleLabel: metadata.scaleLabel || (calibration.calibrated ? 'Calibrated (2-Point)' : 'Uncalibrated'),
    calibrated: calibration.calibrated,
    calibrationNote: calibration.note,
    drawingWidthMeters: mapW,
    drawingHeightMeters: mapH,
    providerModel: model.providerModel,
    suppressAutoSitePerimeter: hasExplicitWallNetwork,
    approvedFor3D: false,
    referenceOverlay: params.referenceOverlay,
    symbolMappingsUsed: symbolMappings
      .filter((s) => s.enabled)
      .map((s) => ({
        id: s.id,
        name: s.name,
        code: s.code,
        domain: s.domain,
        electricalItemType: s.electricalItemType,
      })),
    columns: newColumns,
    textAnnotations: newTextAnnotations,
    layers: params.layers ?? createDefaultDrawingLayers(),
    warnings: [
      ...model.warnings,
      ...(calibration.calibrated ? [] : [calibration.note]),
    ],
    countsSummary,
  };

  if (isMerge && existingProject) {
    const existingFloorWalls = existingProject.customWalls.filter((w) => (w.floor ?? 1) === targetFloor);
    const dedupedWalls = newWalls.filter(
      (nw) =>
        !existingFloorWalls.some(
          (ew) =>
            (Math.hypot(ew.x1 - nw.x1, ew.y1 - nw.y1) < 0.08 &&
              Math.hypot(ew.x2 - nw.x2, ew.y2 - nw.y2) < 0.08) ||
            (Math.hypot(ew.x1 - nw.x2, ew.y1 - nw.y2) < 0.08 &&
              Math.hypot(ew.x2 - nw.x1, ew.y2 - nw.y1) < 0.08)
        )
    );

    const existingFloorPoints = existingProject.points.filter((p) => (p.floor ?? 1) === targetFloor);
    const dedupedPoints = newPoints.filter(
      (np) =>
        !existingFloorPoints.some(
          (ep) => ep.itemType === np.itemType && Math.hypot(ep.x - np.x, ep.y - np.y) < 0.12
        )
    );

    const prevCols = existingProject.aiDrawingImport?.columns ?? [];
    const prevTexts = existingProject.aiDrawingImport?.textAnnotations ?? [];

    const mergedProject: ProjectData = {
      ...existingProject,
      siteConfigured: true,
      rooms: [...existingProject.rooms, ...newRooms],
      customWalls: [...existingProject.customWalls, ...dedupedWalls],
      openings: [...existingProject.openings, ...newOpenings],
      dimensions: [...(existingProject.dimensions ?? []), ...newDimensions],
      furniture: [...(existingProject.furniture ?? []), ...newFurniture],
      staircases: [...(existingProject.staircases ?? []), ...newStaircases],
      points: [...existingProject.points, ...dedupedPoints],
      wires: [...(existingProject.wires ?? []), ...newWires],
      aiDrawingImport: {
        ...importMeta,
        suppressAutoSitePerimeter:
          existingProject.aiDrawingImport?.suppressAutoSitePerimeter ?? false,
        columns: [...prevCols, ...newColumns],
        textAnnotations: [...prevTexts, ...newTextAnnotations],
        countsSummary: {
          ...countsSummary,
          walls: dedupedWalls.length,
          electricalPoints: dedupedPoints.length,
        },
      },
      updatedAt: new Date().toISOString(),
    };

    return {
      project: mergedProject,
      isNewProject: false,
      summary: mergedProject.aiDrawingImport!.countsSummary,
    };
  }

  // Create a clean new Blue Space project in native units ('ft' if user chose ft/in, else 'm')
  const siteUnits: 'm' | 'ft' =
    metadata.measurementUnit === 'ft' || metadata.measurementUnit === 'in' ? 'ft' : 'm';
  const lengthInSiteUnits =
    siteUnits === 'ft' ? round2(mapW * M_TO_FT) : round2(mapW);
  const widthInSiteUnits =
    siteUnits === 'ft' ? round2(mapH * M_TO_FT) : round2(mapH);
  const ceilingInSiteUnits =
    siteUnits === 'ft' ? round2(defaultCeilingM * M_TO_FT) : round2(defaultCeilingM);
  const wallThickInSiteUnits =
    siteUnits === 'ft' ? round2(defaultWallThickM * M_TO_FT) : round2(defaultWallThickM);

  const site = {
    length: Math.max(siteUnits === 'ft' ? 10 : 3, lengthInSiteUnits),
    width: Math.max(siteUnits === 'ft' ? 10 : 3, widthInSiteUnits),
    ceilingHeight: ceilingInSiteUnits,
    wallThickness: wallThickInSiteUnits,
    units: siteUnits,
    floors: 1,
  };

  const newProject: ProjectData = {
    id: `proj-aid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    refCode: `BS-AI-${String(Date.now()).slice(-4)}`,
    name: metadata.projectName.trim() || `Imported Drawing (${source.originalFileName})`,
    projectType: 'Custom',
    buildingType: 'single',
    status: 'Active',
    description:
      metadata.notes.trim() ||
      `2D editable model imported from ${source.originalFileName} (Page ${source.selectedPage}, ${metadata.drawingType}).`,
    siteConfigured: true,
    site,
    floorConfigs: buildDefaultFloorConfigs({
      buildingType: 'single',
      ceilingHeightM: defaultCeilingM,
      slabThicknessM: DEFAULT_SLAB_THICKNESS_M,
    }),
    rooms: newRooms,
    customWalls: newWalls,
    openings: newOpenings,
    dimensions: newDimensions,
    furniture: newFurniture,
    staircases: newStaircases,
    points: newPoints,
    wires: newWires,
    aiDrawingImport: importMeta,
    updatedAt: new Date().toISOString(),
  };

  return {
    project: newProject,
    isNewProject: true,
    summary: countsSummary,
  };
}
