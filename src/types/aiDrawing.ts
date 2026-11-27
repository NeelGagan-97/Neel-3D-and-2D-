import { ElectricalCategory, ElectricalItemType, RoomType } from './design';

export type DrawingMeasurementUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

export type AiDrawingType =
  | 'Architectural Floor Plan'
  | 'Electrical Layout'
  | 'Lighting Layout'
  | 'Combined Architectural & Electrical'
  | 'Technical Drawing';

export type DetectionStatus = 'approved' | 'uncertain' | 'rejected';

export type SymbolTargetDomain =
  | 'lighting'
  | 'fan'
  | 'switch'
  | 'socket'
  | 'appliance'
  | 'distribution'
  | 'architectural'
  | 'custom';

export interface DrawingProjectMetadata {
  projectName: string;
  drawingType: AiDrawingType;
  measurementUnit: DrawingMeasurementUnit;
  /** Optional scale string declared on the drawing, e.g. "1:100" or "1/4\" = 1'-0\"" */
  scaleLabel: string;
  /** Optional ceiling height in meters for the target floor (defaults to 3.0m) */
  defaultCeilingHeightM: number;
  /** Optional wall thickness in meters (defaults to 0.15m) */
  defaultWallThicknessM: number;
  /** Target floor index when merging into an existing project (1 = Ground Floor) */
  targetFloor: number;
  /** Whether to create a brand-new Blue Space project or merge into the currently active project */
  importTarget: 'new-project' | 'merge-active-floor';
  notes: string;
}

export interface UploadedDrawingSource {
  id: string;
  originalFileName: string;
  mimeType: 'application/pdf' | 'image/png' | 'image/jpeg';
  fileSizeBytes: number;
  pageCount: number;
  selectedPage: number;
  imageWidthPx: number;
  imageHeightPx: number;
  /** Original rendered page image before rotation/crop/contrast adjustments */
  originalPageDataUrl: string;
  /** Active prepared image sent to AI and used as reference backdrop */
  preparedImageDataUrl: string;
  rotationDeg: 0 | 90 | 180 | 270;
  brightness: number; // 50..150, default 100
  contrast: number; // 50..150, default 100
  cropRect: NormalizedRect | null;
  uploadedAt: string;
}

export interface NormalizedPoint {
  /** Normalized X coordinate in [0, 1] relative to prepared drawing image width */
  x: number;
  /** Normalized Y coordinate in [0, 1] relative to prepared drawing image height */
  y: number;
}

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SymbolMappingDefinition {
  id: string;
  name: string;
  code: string;
  domain: SymbolTargetDomain;
  /** Target Blue Space electrical item type when domain is electrical, or undefined for custom/architectural annotations */
  electricalItemType?: ElectricalItemType;
  electricalCategory?: ElectricalCategory;
  description: string;
  /** Optional visual variations / aliases seen on drawings (e.g. "DL-1, 12W Downlight, Circle with cross") */
  visualNotes: string;
  /** Optional safe raster data-URL (PNG/JPEG) cropped from PDF legend, uploaded, or drawn */
  sampleImageDataUrl?: string;
  /** Optional color marker shown in review canvas */
  markerColor: string;
  enabled: boolean;
  /** Optional source legend crop region */
  sourceCrop?: NormalizedRect;
  createdAt: string;
  updatedAt: string;
}

export interface SymbolTemplate {
  id: string;
  name: string;
  description: string;
  drawingType: AiDrawingType;
  symbols: SymbolMappingDefinition[];
  createdAt: string;
  updatedAt: string;
}

export interface CalibrationConfig {
  /** True only when user explicitly completes 2-point calibration or confirms known real dimensions */
  calibrated: boolean;
  method: 'two-point' | 'uncalibrated-estimated';
  unit: DrawingMeasurementUnit;
  /** Point A and B in normalized image coordinates [0..1] when method === 'two-point' */
  pointA?: NormalizedPoint;
  pointB?: NormalizedPoint;
  /** User-entered real-world distance between pointA and pointB in `unit` */
  knownDistanceValue?: number;
  knownDistanceMeters?: number;
  /** Derived horizontal & vertical span of the prepared image in meters */
  drawingWidthMeters: number;
  drawingHeightMeters: number;
  /** Derived pixels per meter (null if uncalibrated) */
  pixelsPerMeter: number | null;
  /** Warning banner note if uncalibrated */
  note: string;
}

export type DetectionOrigin = 'pdf-vector' | 'raster-cv' | 'vision-ai' | 'manual';

export interface DetectedWall {
  id: string;
  x1: number; // normalized 0..1
  y1: number;
  x2: number;
  y2: number;
  wallKind: 'external' | 'internal';
  thicknessMeters?: number;
  /** True when this segment came from a tessellated curved wall / arc / Bézier path */
  isCurvedSegment?: boolean;
  curveGroupId?: string;
  confidence: number;
  status: DetectionStatus;
  source: 'ai' | 'manual';
  origin?: DetectionOrigin;
  isDuplicateCandidate?: boolean;
  note?: string;
}

export interface DetectedRoom {
  id: string;
  name: string;
  roomType: RoomType;
  x: number; // normalized 0..1 top-left
  y: number;
  width: number; // normalized 0..1
  height: number;
  /** Exact normalized polygon boundary (3+ vertices) for irregular/angled/curved spaces */
  polygon?: NormalizedPoint[];
  confidence: number;
  status: DetectionStatus;
  source: 'ai' | 'manual';
  origin?: DetectionOrigin;
  note?: string;
}

export interface DetectedOpening {
  id: string;
  kind: 'door' | 'window';
  x: number; // normalized center 0..1
  y: number;
  /** Width in normalized image-width units (0..1) */
  widthNorm: number;
  rotationDeg: number;
  confidence: number;
  status: DetectionStatus;
  source: 'ai' | 'manual';
  note?: string;
}

export interface DetectedColumn {
  id: string;
  label: string;
  x: number; // normalized center 0..1
  y: number;
  widthNorm: number;
  heightNorm: number;
  confidence: number;
  status: DetectionStatus;
  source: 'ai' | 'manual';
}

export interface DetectedStaircase {
  id: string;
  label: string;
  x: number; // normalized top-left 0..1
  y: number;
  widthNorm: number;
  heightNorm: number;
  rotationDeg: number;
  steps?: number;
  confidence: number;
  status: DetectionStatus;
  source: 'ai' | 'manual';
}

export type DetectedFurnitureKind =
  | 'sofa'
  | 'bed'
  | 'dining-table'
  | 'kitchen-counter'
  | 'vanity'
  | 'tv-unit'
  | 'desk';

export interface DetectedFurniture {
  id: string;
  kind: DetectedFurnitureKind;
  label: string;
  x: number; // normalized center 0..1
  y: number;
  widthNorm: number;
  heightNorm: number;
  rotationDeg: number;
  confidence: number;
  status: DetectionStatus;
  source: 'ai' | 'manual';
  origin?: DetectionOrigin;
  note?: string;
}

export interface DetectedSymbolInstance {
  id: string;
  /** Matched SymbolMappingDefinition.id from user's symbol library, or null if unmapped */
  symbolMappingId: string | null;
  symbolName: string;
  symbolCode: string;
  domain: SymbolTargetDomain;
  electricalItemType?: ElectricalItemType;
  electricalCategory?: ElectricalCategory;
  x: number; // normalized 0..1
  y: number;
  rotationDeg: number;
  confidence: number;
  status: DetectionStatus;
  source: 'ai' | 'manual';
  origin?: DetectionOrigin;
  matchedByUserLegend: boolean;
  isDuplicateCandidate?: boolean;
  note?: string;
}

export interface DetectedWiringPath {
  id: string;
  label: string;
  points: NormalizedPoint[];
  circuitHint?: string;
  confidence: number;
  status: DetectionStatus;
  source: 'ai' | 'manual';
}

export interface DetectedDimension {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  labelText: string;
  /** Distinguishes exact PDF/calibrated dimensions from estimated measurements */
  measurementKind?: 'exact' | 'estimated';
  parsedMeters?: number | null;
  confidence: number;
  status: DetectionStatus;
  source: 'ai' | 'manual';
  origin?: DetectionOrigin;
}

export interface DetectedTextLabel {
  id: string;
  text: string;
  x: number;
  y: number;
  kind: 'room-label' | 'annotation' | 'title-block' | 'legend-text';
  confidence: number;
  status: DetectionStatus;
  source: 'ai' | 'manual';
}

export interface DetectedLegendEntry {
  id: string;
  code: string;
  label: string;
  description: string;
  confidence: number;
}

export interface DrawingTitleBlockInfo {
  drawingTitle?: string;
  drawingNumber?: string;
  scaleText?: string;
  unitText?: string;
  revision?: string;
  projectTitle?: string;
}

export type DrawingLayerId =
  | 'referenceImage'
  | 'walls'
  | 'rooms'
  | 'openings'
  | 'columns'
  | 'staircases'
  | 'furniture'
  | 'symbols'
  | 'wiring'
  | 'dimensions'
  | 'labels';

export interface DrawingLayerState {
  id: DrawingLayerId;
  label: string;
  visible: boolean;
  locked: boolean;
  color: string;
}

export interface PdfVectorSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeWidthPt: number;
  wallKind: 'external' | 'internal';
  isCurvedSegment: boolean;
  curveGroupId?: string;
  isAngled: boolean;
}

export interface PdfExtractedTextItem {
  text: string;
  x: number; // normalized 0..1
  y: number;
  widthNorm: number;
  heightNorm: number;
  fontSizePt: number;
  kind: 'room-label' | 'dimension' | 'legend-text' | 'title-block' | 'annotation';
  parsedMeters?: number | null;
}

export interface PdfExtractedDimension {
  labelText: string;
  x: number;
  y: number;
  parsedMeters: number;
  unitDetected: DrawingMeasurementUnit;
}

export interface PdfExcludedZone {
  kind: 'legend' | 'title-block';
  rect: NormalizedRect;
}

export interface PdfExtractedColumn {
  label: string;
  x: number;
  y: number;
  widthNorm: number;
  heightNorm: number;
}

export interface PdfVectorExtractionResult {
  sourceKind: 'vector-pdf' | 'scanned-pdf' | 'raster-image';
  pageNumber: number;
  pageWidthPt: number;
  pageHeightPt: number;
  rawSegmentCount: number;
  /** Count of non-architectural strokes filtered out from legend tables, title blocks, and hatch/tick noise */
  filteredNoiseCount?: number;
  excludedZones?: PdfExcludedZone[];
  wallSegments: PdfVectorSegment[];
  columns?: PdfExtractedColumn[];
  curvedSegmentCount: number;
  angledSegmentCount: number;
  textItems: PdfExtractedTextItem[];
  dimensions: PdfExtractedDimension[];
  legendEntries: Array<{ code: string; label: string; description: string }>;
  titleBlock: DrawingTitleBlockInfo;
  warnings: string[];
}

export interface AiDrawingVectorContext {
  sourceKind: 'vector-pdf' | 'scanned-pdf' | 'raster-image';
  totalVectorSegments: number;
  curvedSegmentCount: number;
  angledSegmentCount: number;
  /** Compact high-priority wall geometry anchors in normalized 0..1 coordinates */
  wallAnchors: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    wallKind: 'external' | 'internal';
    isCurved?: boolean;
  }>;
  textLabels: Array<{
    text: string;
    x: number;
    y: number;
    kind: string;
  }>;
  dimensions: Array<{
    text: string;
    x: number;
    y: number;
    meters: number;
  }>;
  legendEntries: Array<{
    code: string;
    label: string;
    description: string;
  }>;
  titleBlock?: DrawingTitleBlockInfo;
}

export interface ReconstructionQualityReport {
  status: 'ready' | 'incomplete' | 'empty';
  score: number; // 0..100
  blockers: string[];
  warnings: string[];
  metrics: {
    approvedWalls: number;
    externalWalls: number;
    internalWalls: number;
    angledOrCurvedWalls: number;
    approvedRooms: number;
    polygonRooms: number;
    approvedOpenings: number;
    approvedColumns: number;
    approvedFurniture: number;
    approvedSymbols: number;
    mappedSymbols: number;
    unmappedSymbols: number;
    approvedDimensions: number;
    approvedLabels: number;
    uncertainCount: number;
    wallEnvelopeCoverage: number; // 0..1 bounding span coverage of wall network
  };
}

export interface IntermediateDrawingModel {
  version: 1;
  analyzedAt: string;
  providerModel: string;
  sourcePage: number;
  sourceKind?: 'vector-pdf' | 'scanned-pdf' | 'raster-image';
  walls: DetectedWall[];
  rooms: DetectedRoom[];
  openings: DetectedOpening[];
  columns: DetectedColumn[];
  staircases: DetectedStaircase[];
  furniture?: DetectedFurniture[];
  symbols: DetectedSymbolInstance[];
  wiringPaths: DetectedWiringPath[];
  dimensions: DetectedDimension[];
  textLabels: DetectedTextLabel[];
  legendEntries: DetectedLegendEntry[];
  titleBlock: DrawingTitleBlockInfo;
  warnings: string[];
  summary: string;
}

export interface ImportedColumn2D {
  id: string;
  floor: number;
  label: string;
  x: number; // meters
  y: number; // meters
  width: number; // meters
  height: number; // meters
}

export interface ImportedTextAnnotation2D {
  id: string;
  floor: number;
  text: string;
  x: number; // meters
  y: number; // meters
  kind: 'room-label' | 'annotation' | 'title-block' | 'legend-text';
}

/**
 * Lightweight provenance & optional editable 2D annotations stored on ProjectData
 * when a project was created or enriched via AI Drawing to 2D.
 * Fully optional so all legacy .bluespace and JSON projects remain 100% compatible.
 */
export interface ReferenceOverlayConfig {
  dataUrl: string;
  widthPx: number;
  heightPx: number;
  opacity: number; // 0..1
  visible: boolean;
}

export interface AiDrawingImportMeta {
  importedAt: string;
  sourceFileName: string;
  sourceMimeType: 'application/pdf' | 'image/png' | 'image/jpeg';
  sourcePage: number;
  sourceKind?: 'vector-pdf' | 'scanned-pdf' | 'raster-image';
  drawingType: AiDrawingType;
  measurementUnit: DrawingMeasurementUnit;
  scaleLabel: string;
  calibrated: boolean;
  calibrationNote: string;
  drawingWidthMeters: number;
  drawingHeightMeters: number;
  providerModel: string;
  /** When true, extractMergedWalls omits the default 4-sided rectangular site perimeter because customWalls hold the true building outline */
  suppressAutoSitePerimeter?: boolean;
  /** Explicit user approval before converting reconstructed 2D CAD into 3D viewport geometry */
  approvedFor3D?: boolean;
  approvedFor3DAt?: string;
  /** Aligned source PDF/image underlay for visual verification & editing inside the 2D CAD editor */
  referenceOverlay?: ReferenceOverlayConfig;
  symbolMappingsUsed: Array<{
    id: string;
    name: string;
    code: string;
    domain: SymbolTargetDomain;
    electricalItemType?: ElectricalItemType;
  }>;
  columns?: ImportedColumn2D[];
  textAnnotations?: ImportedTextAnnotation2D[];
  layers?: DrawingLayerState[];
  warnings?: string[];
  countsSummary: {
    walls: number;
    rooms: number;
    openings: number;
    columns: number;
    staircases: number;
    furniture?: number;
    electricalPoints: number;
    wires: number;
    dimensions: number;
    textAnnotations: number;
    excludedUncertainOrRejected: number;
  };
}

export interface AiDrawingProviderStatus {
  configured: boolean;
  model: string;
  message: string;
}

export interface AiDrawingAnalyzeRequest {
  imageBase64: string;
  mimeType: 'image/png' | 'image/jpeg';
  imageWidthPx: number;
  imageHeightPx: number;
  pageNumber: number;
  metadata: {
    projectName: string;
    drawingType: AiDrawingType;
    measurementUnit: DrawingMeasurementUnit;
    scaleLabel: string;
    notes: string;
  };
  /** Optional direct PDF vector geometry & text ground truth extracted before Vision AI analysis */
  vectorContext?: AiDrawingVectorContext;
  symbolDefinitions: Array<{
    id: string;
    name: string;
    code: string;
    domain: SymbolTargetDomain;
    electricalItemType?: ElectricalItemType;
    description: string;
    visualNotes: string;
    sampleImageBase64?: string;
    sampleMimeType?: 'image/png' | 'image/jpeg';
  }>;
}

export interface AiDrawingAnalyzeResponse {
  ok: true;
  model: string;
  analyzedAt: string;
  rawAnalysis: {
    summary: string;
    warnings: string[];
    titleBlock: DrawingTitleBlockInfo;
    legendEntries: Array<{
      code: string;
      label: string;
      description: string;
      confidence: number;
    }>;
    walls: Array<{
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      wallKind: 'external' | 'internal';
      isCurvedSegment?: boolean;
      confidence: number;
      note?: string;
    }>;
    rooms: Array<{
      name: string;
      roomType: string;
      x: number;
      y: number;
      width: number;
      height: number;
      polygon?: NormalizedPoint[];
      confidence: number;
      note?: string;
    }>;
    openings: Array<{
      kind: 'door' | 'window';
      x: number;
      y: number;
      widthNorm: number;
      rotationDeg: number;
      confidence: number;
      note?: string;
    }>;
    columns: Array<{
      label: string;
      x: number;
      y: number;
      widthNorm: number;
      heightNorm: number;
      confidence: number;
    }>;
    staircases: Array<{
      label: string;
      x: number;
      y: number;
      widthNorm: number;
      heightNorm: number;
      rotationDeg: number;
      steps?: number;
      confidence: number;
    }>;
    furniture?: Array<{
      kind: DetectedFurnitureKind;
      label: string;
      x: number;
      y: number;
      widthNorm: number;
      heightNorm: number;
      rotationDeg: number;
      confidence: number;
      note?: string;
    }>;
    symbols: Array<{
      symbolMappingId?: string;
      symbolName: string;
      symbolCode: string;
      domain: SymbolTargetDomain;
      x: number;
      y: number;
      rotationDeg: number;
      confidence: number;
      note?: string;
    }>;
    wiringPaths: Array<{
      label: string;
      points: NormalizedPoint[];
      circuitHint?: string;
      confidence: number;
    }>;
    dimensions: Array<{
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      labelText: string;
      confidence: number;
    }>;
    textLabels: Array<{
      text: string;
      x: number;
      y: number;
      kind: 'room-label' | 'annotation' | 'title-block' | 'legend-text';
      confidence: number;
    }>;
  };
}

export interface CadExportValidationResult {
  valid: boolean;
  format: 'dxf' | 'dwg';
  entityCount: number;
  layerNames: string[];
  hasHeader: boolean;
  hasTables: boolean;
  hasEntities: boolean;
  hasEof: boolean;
  byteLength: number;
  errors: string[];
  warnings: string[];
}

export interface CadCapabilitiesResponse {
  dxfReady: boolean;
  dxfEngine: string;
  dwgReady: boolean;
  dwgEngine: string | null;
  dwgReason?: string;
  dwgMessage?: string;
}
