import type { AiDrawingImportMeta } from './aiDrawing';

export type ScreenId = 'home' | 'studio' | 'summary';
export type UnitSystem = 'ft' | 'm';
export type ProjectType = 'Residential' | 'Commercial' | 'Custom';
export type BuildingType = 'single' | 'duplex' | 'triplex' | 'custom';
export type FloorKind = 'basement' | 'ground' | 'upper' | 'terrace';
export type ViewMode = '2d' | '3d';
export type CameraMode = 'orbit' | 'fps';
export type CameraPreset =
  | 'perspective'
  | 'top'
  | 'front'
  | 'rear'
  | 'left'
  | 'right'
  | 'isometric'
  | 'custom';

export interface SavedCameraView {
  id: string;
  name: string;
  preset: CameraPreset;
  position: [number, number, number];
  target: [number, number, number];
  zoom?: number;
  createdAt: string;
}

export type LightingMode = 'sunrise' | 'daylight' | 'sunset' | 'evening';
export type FloorView3DMode = 'all' | 'exploded' | 'up-to-active' | 'active-only';

export type CanvasTool =
  | 'select'
  | 'draw-wall'
  | 'hide-wall'
  | 'add-room'
  | 'add-door'
  | 'add-window'
  | 'add-staircase'
  | 'add-wire'
  | 'erase'
  | 'dimension'
  | 'move'
  | 'rotate'
  | 'pan';

export type StaircaseType = 'straight' | 'l-shaped' | 'u-shaped' | 'spiral';

export type WireCategory = 'phase' | 'neutral' | 'earth' | 'control' | 'communication';
export type WireStandard = 'IS-732' | 'IEC-60446' | 'NEC';
export type CableMaterial = 'Copper' | 'Aluminium' | 'Unspecified';
export type PhaseDesignation = 'L1 (R)' | 'L2 (Y)' | 'L3 (B)' | 'N' | 'PE' | 'CTRL' | 'DATA';
export type WireLineStyle = 'solid' | 'dashed';
export type WireConnectionStatus = 'connected' | 'draft' | 'warning';

export interface FloorLevelConfig {
  /** Signed level index: 0 = Basement, 1 = Ground Floor, 2 = First Floor, 3 = Second Floor, etc. */
  floor: number;
  name: string;
  kind: FloorKind;
  /** Structural finished floor elevation in meters relative to Ground Floor (0.0m) */
  elevationM: number;
  /** Clear floor-to-ceiling height in meters */
  floorHeightM: number;
  /** Structural slab thickness in meters */
  slabThicknessM: number;
  /** Visibility in Complete Building and Exploded 3D views */
  visible: boolean;
  /** Optional independent floor footprint length along X-axis in meters (defaults to site length) */
  lengthM?: number;
  /** Optional independent floor footprint width along Y-axis in meters (defaults to site width) */
  widthM?: number;
}

export interface StaircaseItem {
  id: string;
  name: string;
  type: StaircaseType;
  fromFloor: number;
  toFloor: number;
  /** Plan anchor position (top-left of footprint in meters) */
  x: number;
  y: number;
  /** Rotation in degrees (0, 90, 180, 270) */
  rotation: number;
  /** Flight width in meters */
  width: number;
  /** Riser height in meters */
  riserHeight: number;
  /** Tread depth in meters */
  treadDepth: number;
  /** Total step count */
  steps: number;
  /** Landing width in meters (for L-shaped & U-shaped) */
  landingWidth: number;
  /** Landing depth in meters (for L-shaped & U-shaped) */
  landingDepth: number;
}

export type WireRoutingMode = 'orthogonal' | 'freeform' | 'curved';

export interface WireWaypoint {
  x: number;
  y: number;
  /** Optional floor-relative elevation in meters for 3D height-axis routing */
  z?: number;
}

export interface ElectricalWire {
  id: string;
  code: string;
  /** Primary floor association */
  floor: number;
  fromPointId: string;
  toPointId: string;
  fromFloor: number;
  toFloor: number;
  isInterFloor?: boolean;
  /** Intermediate routing points in floor-plan meters (with optional floor-relative Z height) */
  waypoints: WireWaypoint[];
  /** Cable path geometry style: orthogonal (90°), freeform (diagonal/arbitrary), or curved (smooth spline) */
  routingMode?: WireRoutingMode;
  /** Circuit assignment (empty string allowed to surface validation warnings) */
  circuit: CircuitId | '';
  category: WireCategory;
  wireType: string;
  cableMaterial: CableMaterial;
  /** Cross-section in sq.mm; null means user input still required (never silently invented) */
  cableSizeSqMm: number | null;
  cores: number;
  phaseDesignation: PhaseDesignation;
  color: string;
  lineThickness: number;
  lineStyle: WireLineStyle;
  status: WireConnectionStatus;
  assumptionNote?: string;
  /** Optional linked product catalogue record for cable/wire */
  productId?: string;
  manufacturer?: string;
  brand?: string;
  productName?: string;
  productCategory?: string;
  modelNumber?: string;
  specification?: string;
  unit?: string;
  mrpPerM?: number | null;
  unitPricePerM?: number | null;
  discountPercent?: number | null;
  gstPercent?: number | null;
  variantSku?: string;
  variantLabel?: string;
  priceCapturedAt?: string;
  datasheetUrl?: string;
}

export interface CircuitCableConfig {
  circuit: CircuitId;
  cableSizeSqMm: number | null;
  cableMaterial: CableMaterial;
  productId?: string;
  manufacturer?: string;
  brand?: string;
  productName?: string;
  productCategory?: string;
  modelNumber?: string;
  specification?: string;
  unit?: string;
  mrpPerM?: number | null;
  unitPricePerM?: number | null;
  discountPercent?: number | null;
  gstPercent?: number | null;
  variantSku?: string;
  variantLabel?: string;
  priceCapturedAt?: string;
  datasheetUrl?: string;
  note?: string;
}

export interface WiringDisplayConfig {
  standard: WireStandard;
  showWires: boolean;
  showWireLabels: boolean;
  showEndpointMarkers: boolean;
  show3DWires: boolean;
  showAutoCircuitBus: boolean;
  showAllFloorsElectrical: boolean;
  visibleCategories: Record<WireCategory, boolean>;
}

export type RoomType =
  | 'living'
  | 'hall'
  | 'kitchen'
  | 'master-bedroom'
  | 'bedroom'
  | 'second-bedroom'
  | 'guest-bedroom'
  | 'bathroom'
  | 'common-bathroom'
  | 'dining'
  | 'pooja'
  | 'balcony'
  | 'utility'
  | 'store'
  | 'study'
  | 'custom';

export type ElectricalCategory =
  | 'Fans'
  | 'Lighting'
  | 'Switches'
  | 'Sockets'
  | 'Appliances'
  | 'Distribution';

export type ElectricalItemType =
  | 'ceiling_fan'
  | 'exhaust_fan'
  | 'led_light'
  | 'spotlight'
  | 'panel_light'
  | 'strip_light'
  | 'chandelier'
  | 'switch'
  | 'switchboard'
  | 'socket_5a'
  | 'socket_16a'
  | 'usb_outlet'
  | 'split_ac'
  | 'geyser'
  | 'refrigerator'
  | 'appliance'
  | 'distribution_board'
  | 'earthing_point';

export type CircuitId =
  | 'CKT-L1 (Lighting)'
  | 'CKT-L2 (Bedrooms)'
  | 'CKT-P1 (Kitchen)'
  | 'CKT-P2 (Power 16A)';

export interface SiteConfig {
  length: number; // in site.units ('ft' or 'm')
  width: number; // in site.units ('ft' or 'm')
  ceilingHeight: number; // in site.units ('ft' or 'm')
  /** Wall thickness in site.units (e.g., 0.5 ft = 6 inches, or 0.15 m) */
  wallThickness: number;
  /** Optional structural slab thickness in meters (defaults to 0.22m) */
  slabThicknessM?: number;
  units: UnitSystem;
  floors: number;
  /** Explicit user opt-in allowing floor footprints (e.g. cantilevers/overhangs) to exceed site dimensions */
  allowFloorExceedSite?: boolean;
}

export interface RoomZone {
  id: string;
  name: string;
  type: RoomType;
  /** Floor level index (0 = Basement, 1 = Ground Floor, 2 = First Floor, etc.) */
  floor?: number;
  /** Position & dimensions in meters from top-left (0, 0) */
  x: number;
  y: number;
  width: number; // X-axis span (length) in meters
  height: number; // Y-axis span (width) in meters
  wallThickness?: number; // in meters (defaults to site wall thickness)
  rotation?: number; // 0 or 90
  floorFinish: 'wood' | 'tile' | 'stone' | 'terrazzo';
  /** When true, room boundaries are defined by explicit customWalls rather than auto-generated bounding rectangles */
  noAutoWalls?: boolean;
  /** Optional exact polygonal room outline in floor-plan meters for non-rectangular / angled / curved rooms */
  polygon?: Array<{ x: number; y: number }>;
}

export interface CustomWall {
  id: string;
  floor?: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness?: number; // meters
  wallKind?: 'internal' | 'external';
  /** True when this segment is part of a tessellated curved wall reconstructed from a CAD/PDF arc or Bézier */
  isCurvedSegment?: boolean;
  curveGroupId?: string;
  /** Temporarily hidden for cutaway / cross-section views without deleting rooms or electrical data */
  hidden?: boolean;
}

export interface ArchitecturalOpening {
  id: string;
  floor?: number;
  kind: 'door' | 'window';
  x: number;
  y: number;
  width: number; // meters
  rotation: number; // degrees
}

export interface DimensionAnnotation {
  id: string;
  floor?: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface FurnitureItem {
  id: string;
  floor?: number;
  kind: 'sofa' | 'bed' | 'dining-table' | 'kitchen-counter' | 'vanity' | 'tv-unit' | 'desk';
  roomId: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  rotation: number;
}

export interface DistributionBoardConfig {
  incomingRatingAmps: number;
  waysCount: number;
  phaseType: 'Single Phase (1Φ)' | 'Three Phase (3Φ)';
  rccbSensitivityMa: number;
  associatedCircuits: CircuitId[];
  enclosureType?: string;
}

export interface EarthingPointConfig {
  earthingType: 'Copper Plate' | 'GI Pipe' | 'Chemical Maintenance-Free' | 'Copper Rod';
  targetResistanceOhm: number;
  earthConductorSizeSqMm: number;
  connectedDbId?: string;
  notes?: string;
}

export interface ElectricalPoint {
  id: string;
  floor?: number;
  code: string;
  name: string;
  itemType: ElectricalItemType;
  category: ElectricalCategory;
  roomId: string;
  x: number;
  y: number;
  z: number;
  rotation: number;
  wattage: number;
  voltage: number;
  circuit: CircuitId | '';
  unitCost: number;
  /** Optional linked product catalogue record */
  productId?: string;
  manufacturer?: string;
  brand?: string;
  modelNumber?: string;
  specification?: string;
  unit?: string;
  mrp?: number | null;
  discountPercent?: number | null;
  gstPercent?: number | null;
  variantSku?: string;
  variantLabel?: string;
  priceCapturedAt?: string;
  manualPriceOverride?: number | null;
  /** Optional distribution board / earthing metadata */
  dbConfig?: DistributionBoardConfig;
  earthingConfig?: EarthingPointConfig;
}

export interface RoomRowOverride {
  roomName?: string;
  fansDelta?: number;
  lightsDelta?: number;
  switchesDelta?: number;
  socketsDelta?: number;
  appliancesDelta?: number;
  loadWattsDelta?: number;
}

export interface BoqRowOverride {
  productName?: string;
  category?: string;
  quantityDelta?: number;
  unitPrice?: number;
  wattageDelta?: number;
  costDelta?: number;
}

export interface ProjectSummaryOverrides {
  roomEdits?: Record<string, RoomRowOverride>;
  deletedRoomIds?: string[];
  addedRooms?: RoomBreakdownRow[];
  boqEdits?: Record<string, BoqRowOverride>;
  deletedBoqKeys?: string[];
  addedBoqRows?: BoqRow[];
}

export interface ProjectData {
  id: string;
  refCode: string;
  name: string;
  projectType?: ProjectType;
  /** Building typology: single floor, duplex, triplex, or custom multi-storey */
  buildingType?: BuildingType;
  status: 'Active' | 'Saved' | 'BOQ Ready';
  description: string;
  /** False right after Phase 1 Project Creation until Phase 2 CREATE SITE is completed */
  siteConfigured?: boolean;
  site: SiteConfig;
  /** Explicit per-floor metadata (elevations, names, slab thickness, visibility) */
  floorConfigs?: FloorLevelConfig[];
  rooms: RoomZone[];
  customWalls: CustomWall[];
  /** Floor-scoped hidden wall keys (e.g. "f1:ext-s", "f1:rm-h-0", "f1:cw-1") for cutaway / cross-section views */
  hiddenWallIds?: string[];
  openings: ArchitecturalOpening[];
  dimensions?: DimensionAnnotation[];
  furniture: FurnitureItem[];
  /** Parametric staircases connecting floor levels */
  staircases?: StaircaseItem[];
  points: ElectricalPoint[];
  /** Independent editable electrical wire connections */
  wires?: ElectricalWire[];
  /** Configurable electrical wiring visualization & standard settings */
  wiringConfig?: WiringDisplayConfig;
  /** Configurable circuit-level cable sizes & product links */
  circuitCableConfigs?: Partial<Record<CircuitId, CircuitCableConfig>>;
  /** User-saved 3D camera angles */
  savedCameraViews?: SavedCameraView[];
  /** Live-reconciled user edits, deletions, and manual rows for Project Summary tables */
  summaryOverrides?: ProjectSummaryOverrides;
  /** Optional provenance & 2D reference layers from AI Drawing to 2D importer */
  aiDrawingImport?: AiDrawingImportMeta;
  /** Legacy fields kept optional for backward compatibility */
  customRoomBreakdown?: RoomBreakdownRow[];
  customBoqRows?: BoqRow[];
  updatedAt: string;
  /** Optional cloud storage metadata (populated when synced with Supabase) */
  cloudId?: string;
  ownerUserId?: string;
  cloudVersion?: number;
  deletedAt?: string | null;
  lastSyncedAt?: string | null;
  syncStatus?: ProjectSyncStatus;
  attachments?: ProjectAttachmentRecord[];
}

export type ProjectSyncStatus =
  | 'synced'
  | 'pending'
  | 'syncing'
  | 'conflict'
  | 'offline'
  | 'error'
  | 'local-only';

export type ProjectAttachmentKind =
  | 'drawing'
  | 'image'
  | 'pdf'
  | 'boq'
  | 'dxf'
  | 'backup'
  | 'attachment';

export interface ProjectAttachmentRecord {
  id: string;
  projectId: string;
  ownerUserId: string;
  kind: ProjectAttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageBucket: string;
  storagePath: string;
  sha256?: string | null;
  deletedAt?: string | null;
  createdAt: string;
}

export interface ProjectVersionRecord {
  id: string;
  projectId: string;
  ownerUserId: string;
  versionNumber: number;
  changeSummary: string;
  metadata: Record<string, unknown>;
  createdBy?: string | null;
  createdAt: string;
  projectData?: ProjectData;
}

export interface ProjectConflictInfo {
  clientProjectId: string;
  cloudId: string;
  projectName: string;
  localVersion: number;
  remoteVersion: number;
  localUpdatedAt: string;
  remoteUpdatedAt: string;
  localProject: ProjectData;
  remoteProject: ProjectData;
}

export interface LocalMigrationReport {
  attempted: boolean;
  migratedCount: number;
  skippedCount: number;
  failedCount: number;
  cleanedLegacyLocalStorage: boolean;
  errors: string[];
}

export type SelectedEntity =
  | { kind: 'room'; id: string }
  | { kind: 'wall'; id: string }
  | { kind: 'opening'; id: string }
  | { kind: 'point'; id: string }
  | { kind: 'furniture'; id: string }
  | { kind: 'staircase'; id: string }
  | { kind: 'wire'; id: string }
  | null;

export type StudioEntityRef = NonNullable<SelectedEntity>;

export interface StudioFocusTarget {
  x: number;
  y: number;
  z?: number;
  floor: number;
  nonce: number;
}

export interface ElectricalCatalogItem {
  itemType: ElectricalItemType;
  label: string;
  shortCode: string;
  productName: string;
  category: ElectricalCategory;
  boqCategory: string;
  defaultWattage: number;
  defaultMountHeight: number;
  defaultCircuit: CircuitId;
  unitCost: number;
  icon: string;
}

export interface RoomBreakdownRow {
  roomId: string;
  roomName: string;
  fans: number;
  lights: number;
  switches: number;
  sockets: number;
  appliances: number;
  loadWatts: number;
}

export interface BoqRow {
  id?: string;
  itemType: ElectricalItemType | 'custom';
  productId?: string;
  manufacturer?: string;
  brand?: string;
  modelNumber?: string;
  specification?: string;
  unit?: string;
  mrp?: number | null;
  discountPercent?: number | null;
  gstPercent?: number | null;
  variantSku?: string;
  variantLabel?: string;
  priceCapturedAt?: string;
  productName: string;
  category: string;
  quantity: number;
  unitPrice?: number;
  totalWattage: number;
  estimatedCost: number;
}

export interface ProjectMetrics {
  totalPoints: number;
  totalWatts: number;
  totalKw: number;
  estimatedAmps: number;
  totalCost: number;
  areaDisplay: string;
  dimensionsDisplay: string;
  builtUpAreaSqM: number;
  siteAreaSqM: number;
  remainingAreaSqM: number;
  categoryCounts: Record<ElectricalCategory, number>;
  roomBreakdown: RoomBreakdownRow[];
  boqRows: BoqRow[];
}
