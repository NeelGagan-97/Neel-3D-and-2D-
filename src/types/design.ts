export type ScreenId = 'home' | 'studio' | 'summary';
export type UnitSystem = 'ft' | 'm';
export type ProjectType = 'Residential' | 'Commercial' | 'Custom';
export type ViewMode = '2d' | '3d';
export type CameraMode = 'orbit' | 'fps';
export type LightingMode = 'sunrise' | 'daylight' | 'sunset' | 'evening';
export type FloorView3DMode = 'all' | 'up-to-active' | 'active-only';

export type CanvasTool =
  | 'select'
  | 'draw-wall'
  | 'add-room'
  | 'add-door'
  | 'add-window'
  | 'erase'
  | 'dimension'
  | 'move'
  | 'rotate'
  | 'pan';

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
  | 'Appliances';

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
  | 'appliance';

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
  units: UnitSystem;
  floors: number;
}

export interface RoomZone {
  id: string;
  name: string;
  type: RoomType;
  /** 1-based floor level (defaults to 1 = 1st Floor / Ground Floor) */
  floor?: number;
  /** Position & dimensions in meters from top-left (0, 0) */
  x: number;
  y: number;
  width: number; // X-axis span (length) in meters
  height: number; // Y-axis span (width) in meters
  wallThickness?: number; // in meters (defaults to site wall thickness)
  rotation?: number; // 0 or 90
  floorFinish: 'wood' | 'tile' | 'stone' | 'terrazzo';
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
  circuit: CircuitId;
  unitCost: number;
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
  status: 'Active' | 'Saved' | 'BOQ Ready';
  description: string;
  /** False right after Phase 1 Project Creation until Phase 2 CREATE SITE is completed */
  siteConfigured?: boolean;
  site: SiteConfig;
  rooms: RoomZone[];
  customWalls: CustomWall[];
  openings: ArchitecturalOpening[];
  dimensions?: DimensionAnnotation[];
  furniture: FurnitureItem[];
  points: ElectricalPoint[];
  /** Live-reconciled user edits, deletions, and manual rows for Project Summary tables */
  summaryOverrides?: ProjectSummaryOverrides;
  /** Legacy fields kept optional for backward compatibility */
  customRoomBreakdown?: RoomBreakdownRow[];
  customBoqRows?: BoqRow[];
  updatedAt: string;
}

export type SelectedEntity =
  | { kind: 'room'; id: string }
  | { kind: 'wall'; id: string }
  | { kind: 'opening'; id: string }
  | { kind: 'point'; id: string }
  | { kind: 'furniture'; id: string }
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
  productName: string;
  category: string;
  quantity: number;
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
