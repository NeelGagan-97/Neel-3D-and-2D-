import { CATALOG_MAP, M_TO_FT, siteToMeters } from '../data/presets';
import {
  BuildingType,
  CableMaterial,
  CircuitId,
  ElectricalPoint,
  ElectricalWire,
  FloorKind,
  FloorLevelConfig,
  PhaseDesignation,
  ProjectData,
  StaircaseItem,
  StaircaseType,
  WireCategory,
  WireLineStyle,
  WireStandard,
  WireWaypoint,
  WiringDisplayConfig,
} from '../types/design';
import { getItemFloor } from './geometry';

export const DEFAULT_SLAB_THICKNESS_M = 0.22;

export type CircuitCategoryKind = 'lighting' | 'power';

export interface CircuitCableRangeRule {
  kind: CircuitCategoryKind;
  label: string;
  minSqMm: number;
  maxSqMm: number;
  recommendedOptionsSqMm: number[];
  disclaimer: string;
}

export const CIRCUIT_CABLE_RANGES: Record<CircuitCategoryKind, CircuitCableRangeRule> = {
  lighting: {
    kind: 'lighting',
    label: 'Lighting Circuits',
    minSqMm: 1.5,
    maxSqMm: 2.5,
    recommendedOptionsSqMm: [1.5, 2.5],
    disclaimer:
      'Configurable design range (1.5–2.5 sq.mm). Final conductor sizing must be verified against load current, voltage drop, breaker rating, and applicable local wiring standards.',
  },
  power: {
    kind: 'power',
    label: 'Heating / Power Circuits',
    minSqMm: 2.5,
    maxSqMm: 4.0,
    recommendedOptionsSqMm: [2.5, 4.0],
    disclaimer:
      'Configurable design range (2.5–4.0 sq.mm). Final conductor sizing must be verified against appliance load, ambient derating, breaker rating, and applicable local wiring standards.',
  },
};

export function getCircuitKind(circuit: CircuitId | ''): CircuitCategoryKind {
  if (circuit === 'CKT-P1 (Kitchen)' || circuit === 'CKT-P2 (Power 16A)') {
    return 'power';
  }
  return 'lighting';
}

export function getCircuitCableRange(circuit: CircuitId | ''): CircuitCableRangeRule {
  return CIRCUIT_CABLE_RANGES[getCircuitKind(circuit)];
}

export function validateCableSizeForCircuit(
  circuit: CircuitId | '',
  cableSizeSqMm: number | null | undefined
): {
  status: 'ok' | 'unset' | 'out-of-range';
  warning?: string;
  range: CircuitCableRangeRule;
} {
  const range = getCircuitCableRange(circuit);
  if (cableSizeSqMm === null || cableSizeSqMm === undefined || cableSizeSqMm <= 0) {
    return {
      status: 'unset',
      warning: `Cable size not yet configured for ${circuit || 'unassigned circuit'} (typical configurable range: ${range.minSqMm}–${range.maxSqMm} sq.mm).`,
      range,
    };
  }
  if (cableSizeSqMm < range.minSqMm || cableSizeSqMm > range.maxSqMm) {
    return {
      status: 'out-of-range',
      warning: `Configured cable size (${cableSizeSqMm} sq.mm) is outside the configurable ${range.label.toLowerCase()} range (${range.minSqMm}–${range.maxSqMm} sq.mm). Verify breaker protection and load rating.`,
      range,
    };
  }
  return { status: 'ok', range };
}

/**
 * Safely generates missing Ground Floor Main Distribution Board (DB-1) and Main Earthing Point (EP-1).
 * Never creates duplicates if a distribution_board or earthing_point already exists in the project.
 */
export function createDefaultDbAndEarthingPoints(
  project: ProjectData
): { added: ElectricalPoint[]; nextPoints: ElectricalPoint[] } {
  const existingPoints = project.points ?? [];
  const hasDb = existingPoints.some((p) => p.itemType === 'distribution_board');
  const hasEarthing = existingPoints.some((p) => p.itemType === 'earthing_point');
  if (hasDb && hasEarthing) {
    return { added: [], nextPoints: existingPoints };
  }

  const floors = getProjectFloors(project);
  const groundFloor = floors.find((f) => f.kind === 'ground' || f.floor === 1)?.floor ?? floors[0]?.floor ?? 1;
  const { lengthM, widthM } = getFloorBoundaryMeters(project, groundFloor);

  const groundRooms = project.rooms.filter(
    (r) =>
      getItemFloor(r) === groundFloor &&
      r.x >= -0.05 &&
      r.y >= -0.05 &&
      r.x + r.width <= lengthM + 0.05 &&
      r.y + r.height <= widthM + 0.05
  );

  // Prefer foyer / hallway / utility / living room near entrance wall; always strictly inside site boundary
  const preferredRoom =
    groundRooms.find((r) => /foyer|entry|hall|corridor|utility|living/i.test(r.name)) ??
    groundRooms[0];

  const safeMarginX = Math.min(0.45, Math.max(0.2, lengthM * 0.08));
  const safeMarginY = Math.min(0.45, Math.max(0.2, widthM * 0.08));
  const clampX = (v: number) =>
    Number(Math.min(Math.max(safeMarginX, v), Math.max(safeMarginX, lengthM - safeMarginX)).toFixed(2));
  const clampY = (v: number) =>
    Number(Math.min(Math.max(safeMarginY, v), Math.max(safeMarginY, widthM - safeMarginY)).toFixed(2));

  const dbX = preferredRoom
    ? clampX(preferredRoom.x + Math.min(0.45, preferredRoom.width * 0.2))
    : clampX(0.65);
  const dbY = preferredRoom
    ? clampY(preferredRoom.y + Math.min(0.45, preferredRoom.height * 0.2))
    : clampY(0.65);
  const epX = clampX(dbX);
  const epY = preferredRoom
    ? clampY(
        dbY + 0.65 <= preferredRoom.y + preferredRoom.height - 0.2
          ? dbY + 0.65
          : Math.max(preferredRoom.y + 0.25, dbY - 0.65)
      )
    : clampY(dbY + 0.75 <= widthM - safeMarginY ? dbY + 0.75 : Math.max(safeMarginY, dbY - 0.75));

  const matchingDbRoom = groundRooms.find(
    (r) => dbX >= r.x - 0.05 && dbX <= r.x + r.width + 0.05 && dbY >= r.y - 0.05 && dbY <= r.y + r.height + 0.05
  );
  const matchingEpRoom = groundRooms.find(
    (r) => epX >= r.x - 0.05 && epX <= r.x + r.width + 0.05 && epY >= r.y - 0.05 && epY <= r.y + r.height + 0.05
  );

  const added: ElectricalPoint[] = [];
  const ts = Date.now();
  const dbId = existingPoints.find((p) => p.itemType === 'distribution_board')?.id ?? `pt-db-${ts}`;

  if (!hasDb) {
    added.push({
      id: dbId,
      floor: groundFloor,
      code: 'DB-1',
      name: 'Main Distribution Board',
      itemType: 'distribution_board',
      category: 'Distribution',
      roomId: matchingDbRoom?.id ?? 'site',
      x: dbX,
      y: dbY,
      z: 1.5,
      rotation: 0,
      wattage: 0,
      voltage: 230,
      circuit: '',
      unitCost: 4850,
      dbConfig: {
        incomingRatingAmps: 63,
        waysCount: 12,
        phaseType: 'Single Phase (1Φ)',
        rccbSensitivityMa: 30,
        associatedCircuits: [
          'CKT-L1 (Lighting)',
          'CKT-L2 (Bedrooms)',
          'CKT-P1 (Kitchen)',
          'CKT-P2 (Power 16A)',
        ],
        enclosureType: 'Double Door Flush Metal DB',
      },
    });
  }

  if (!hasEarthing) {
    added.push({
      id: `pt-ep-${ts + 1}`,
      floor: groundFloor,
      code: 'EP-1',
      name: 'Main Earthing Point',
      itemType: 'earthing_point',
      category: 'Distribution',
      roomId: matchingEpRoom?.id ?? 'site',
      x: epX,
      y: epY,
      z: 0.35,
      rotation: 0,
      wattage: 0,
      voltage: 0,
      circuit: '',
      unitCost: 2600,
      earthingConfig: {
        earthingType: 'Copper Plate',
        targetResistanceOhm: 2.0,
        earthConductorSizeSqMm: 4.0,
        connectedDbId: dbId,
        notes: 'Dedicated earth pit / earthing bus connected to Main DB earth bar.',
      },
    });
  }

  return { added, nextPoints: [...existingPoints, ...added] };
}

export const BUILDING_TYPE_LABELS: Record<BuildingType, string> = {
  single: 'Single Floor',
  duplex: 'Duplex (G + 1)',
  triplex: 'Triplex (G + 2)',
  custom: 'Custom Multi-Storey',
};

export const WIRE_CATEGORY_LABELS: Record<WireCategory, string> = {
  phase: 'Phase Conductor',
  neutral: 'Neutral Conductor',
  earth: 'Earth / PE Conductor',
  control: 'Control Wiring',
  communication: 'Communication / Data',
};

export const WIRE_STANDARD_LABELS: Record<WireStandard, string> = {
  'IS-732': 'IS 732 (India)',
  'IEC-60446': 'IEC 60446 (International)',
  NEC: 'NEC (North America)',
};

export const WIRE_STANDARD_COLORS: Record<WireStandard, Record<WireCategory, string>> = {
  'IS-732': {
    phase: '#EF4444', // Red (L1)
    neutral: '#64748B', // Black / Slate visible on dark CAD
    earth: '#22C55E', // Green
    control: '#F59E0B', // Amber / Orange
    communication: '#38BDF8', // Sky Blue
  },
  'IEC-60446': {
    phase: '#B45309', // Brown
    neutral: '#3B82F6', // Blue
    earth: '#84CC16', // Green-Yellow
    control: '#A855F7', // Violet
    communication: '#22D3EE', // Cyan
  },
  NEC: {
    phase: '#F97316', // Hot (Red/Orange for CAD visibility)
    neutral: '#E2E8F0', // White
    earth: '#22C55E', // Green
    control: '#FACC15', // Yellow
    communication: '#06B6D4', // Cyan
  },
};

export const WIRE_CATEGORY_DEFAULTS: Record<
  WireCategory,
  {
    wireType: string;
    phaseDesignation: PhaseDesignation;
    cores: number;
    lineStyle: WireLineStyle;
    lineThickness: number;
  }
> = {
  phase: {
    wireType: 'PVC Insulated Copper (FRLS)',
    phaseDesignation: 'L1 (R)',
    cores: 1,
    lineStyle: 'solid',
    lineThickness: 2.4,
  },
  neutral: {
    wireType: 'PVC Insulated Copper (FRLS)',
    phaseDesignation: 'N',
    cores: 1,
    lineStyle: 'solid',
    lineThickness: 2.0,
  },
  earth: {
    wireType: 'Green Insulated / Bare Copper Earth',
    phaseDesignation: 'PE',
    cores: 1,
    lineStyle: 'dashed',
    lineThickness: 1.8,
  },
  control: {
    wireType: 'Multi-Strand Control Conductor',
    phaseDesignation: 'CTRL',
    cores: 2,
    lineStyle: 'dashed',
    lineThickness: 2.0,
  },
  communication: {
    wireType: 'Cat6 UTP / Low-Voltage Data Cable',
    phaseDesignation: 'DATA',
    cores: 4,
    lineStyle: 'dashed',
    lineThickness: 1.8,
  },
};

export function createDefaultWiringConfig(standard: WireStandard = 'IS-732'): WiringDisplayConfig {
  return {
    standard,
    showWires: true,
    showWireLabels: true,
    showEndpointMarkers: true,
    show3DWires: true,
    showAutoCircuitBus: true,
    showAllFloorsElectrical: false,
    visibleCategories: {
      phase: true,
      neutral: true,
      earth: true,
      control: true,
      communication: true,
    },
  };
}

export function getWiringConfig(project: ProjectData): WiringDisplayConfig {
  const base = createDefaultWiringConfig(project.wiringConfig?.standard ?? 'IS-732');
  if (!project.wiringConfig) return base;
  return {
    ...base,
    ...project.wiringConfig,
    visibleCategories: {
      ...base.visibleCategories,
      ...(project.wiringConfig.visibleCategories ?? {}),
    },
  };
}

export function getDefaultFloorName(floor: number, kind?: FloorKind): string {
  if (kind === 'basement' || floor === 0) return 'Basement';
  if (kind === 'terrace') return 'Terrace';
  if (floor === 1) return 'Ground Floor';
  if (floor === 2) return 'First Floor';
  if (floor === 3) return 'Second Floor';
  if (floor === 4) return 'Third Floor';
  if (floor < 0) return `Basement ${Math.abs(floor) + 1}`;
  return `Floor ${floor - 1}`;
}

export function inferBuildingType(project: ProjectData): BuildingType {
  if (project.buildingType) return project.buildingType;
  const floors = project.floorConfigs;
  if (floors && floors.length > 0) {
    const hasBasementOrTerrace = floors.some((f) => f.kind === 'basement' || f.kind === 'terrace');
    if (hasBasementOrTerrace) return 'custom';
    if (floors.length === 1) return 'single';
    if (floors.length === 2) return 'duplex';
    if (floors.length === 3) return 'triplex';
    return 'custom';
  }
  const n = Math.max(1, Math.round(project.site.floors || 1));
  if (n === 1) return 'single';
  if (n === 2) return 'duplex';
  if (n === 3) return 'triplex';
  return 'custom';
}

export function buildDefaultFloorConfigs(options: {
  buildingType: BuildingType;
  ceilingHeightM: number;
  slabThicknessM?: number;
  customStoreys?: number;
  includeBasement?: boolean;
  includeTerrace?: boolean;
}): FloorLevelConfig[] {
  const slabM = Number((options.slabThicknessM ?? DEFAULT_SLAB_THICKNESS_M).toFixed(2));
  const clearH = Number(Math.max(2.2, options.ceilingHeightM || 3.0).toFixed(2));
  const step = Number((clearH + slabM).toFixed(2));
  const configs: FloorLevelConfig[] = [];

  if (options.buildingType === 'custom' && options.includeBasement) {
    configs.push({
      floor: 0,
      name: 'Basement',
      kind: 'basement',
      elevationM: Number((-step).toFixed(2)),
      floorHeightM: clearH,
      slabThicknessM: slabM,
      visible: true,
    });
  }

  const storeyCount =
    options.buildingType === 'single'
      ? 1
      : options.buildingType === 'duplex'
        ? 2
        : options.buildingType === 'triplex'
          ? 3
          : Math.max(1, Math.min(8, Math.round(options.customStoreys ?? 2)));

  for (let i = 1; i <= storeyCount; i++) {
    configs.push({
      floor: i,
      name: getDefaultFloorName(i, i === 1 ? 'ground' : 'upper'),
      kind: i === 1 ? 'ground' : 'upper',
      elevationM: Number(((i - 1) * step).toFixed(2)),
      floorHeightM: clearH,
      slabThicknessM: slabM,
      visible: true,
    });
  }

  if (options.buildingType === 'custom' && options.includeTerrace) {
    const topFloor = storeyCount + 1;
    configs.push({
      floor: topFloor,
      name: 'Terrace',
      kind: 'terrace',
      elevationM: Number((storeyCount * step).toFixed(2)),
      floorHeightM: 1.2, // parapet height on terrace
      slabThicknessM: slabM,
      visible: true,
    });
  }

  return configs;
}

/**
 * Returns the canonical sorted list of floor configurations for any project (including legacy projects without floorConfigs).
 */
export function getProjectFloors(project: ProjectData): FloorLevelConfig[] {
  const { ceilingM } = siteToMeters(project.site);
  const slabM = project.site.slabThicknessM ?? DEFAULT_SLAB_THICKNESS_M;
  const step = Number((ceilingM + slabM).toFixed(2));

  if (Array.isArray(project.floorConfigs) && project.floorConfigs.length > 0) {
    return [...project.floorConfigs].sort((a, b) => a.elevationM - b.elevationM || a.floor - b.floor);
  }

  const count = Math.max(1, Math.min(8, Math.round(project.site.floors || 1)));
  const derived: FloorLevelConfig[] = [];
  for (let f = 1; f <= count; f++) {
    derived.push({
      floor: f,
      name: getDefaultFloorName(f, f === 1 ? 'ground' : 'upper'),
      kind: f === 1 ? 'ground' : 'upper',
      elevationM: Number(((f - 1) * step).toFixed(2)),
      floorHeightM: Number(ceilingM.toFixed(2)),
      slabThicknessM: slabM,
      visible: true,
    });
  }
  return derived;
}

export function getFloorConfig(project: ProjectData, floorNum: number): FloorLevelConfig {
  const floors = getProjectFloors(project);
  return floors.find((f) => f.floor === floorNum) ?? floors[0];
}

export function getFloorLabel(project: ProjectData, floorNum: number): string {
  const match = getProjectFloors(project).find((f) => f.floor === floorNum);
  return match ? match.name : getDefaultFloorName(floorNum);
}

export function getFloorElevationM(project: ProjectData, floorNum: number): number {
  const match = getProjectFloors(project).find((f) => f.floor === floorNum);
  if (match) return match.elevationM;
  const { ceilingM } = siteToMeters(project.site);
  const slabM = project.site.slabThicknessM ?? DEFAULT_SLAB_THICKNESS_M;
  return Number(((floorNum - 1) * (ceilingM + slabM)).toFixed(2));
}

export interface FloorBoundaryMetrics {
  lengthM: number;
  widthM: number;
  areaSqM: number;
  isCustom: boolean;
  exceedsSite: boolean;
}

/**
 * Returns the authoritative plan boundary (in meters) for a given floor level.
 * Supports independently configured per-floor lengthM / widthM (e.g., upper-floor setbacks
 * or explicit cantilevers) while seamlessly defaulting to site dimensions when omitted.
 */
export function getFloorBoundaryMeters(
  project: ProjectData,
  floorNum: number
): FloorBoundaryMetrics {
  const { lengthM: siteL, widthM: siteW } = siteToMeters(project.site);
  const match = getProjectFloors(project).find((f) => f.floor === floorNum);
  const customL =
    match && typeof match.lengthM === 'number' && Number.isFinite(match.lengthM) && match.lengthM > 0
      ? Number(match.lengthM.toFixed(3))
      : null;
  const customW =
    match && typeof match.widthM === 'number' && Number.isFinite(match.widthM) && match.widthM > 0
      ? Number(match.widthM.toFixed(3))
      : null;

  const lengthM = customL ?? siteL;
  const widthM = customW ?? siteW;
  const isCustom =
    (customL !== null && Math.abs(customL - siteL) > 0.015) ||
    (customW !== null && Math.abs(customW - siteW) > 0.015);
  const exceedsSite = lengthM > siteL + 0.02 || widthM > siteW + 0.02;

  return {
    lengthM,
    widthM,
    areaSqM: Number((lengthM * widthM).toFixed(2)),
    isCustom,
    exceedsSite,
  };
}

export interface GeometryBoundsSummary {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  spanXM: number;
  spanYM: number;
  hasGeometry: boolean;
  exceedsSite: boolean;
}

/**
 * Computes the exact bounding box (in meters) of placed architectural & electrical geometry
 * on a specific floor (or across all floors when floorNum is omitted).
 */
export function computeActualGeometryBounds(
  project: ProjectData,
  floorNum?: number
): GeometryBoundsSummary {
  const { lengthM: siteL, widthM: siteW } = siteToMeters(project.site);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const include = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  const matchFloor = (f?: number) =>
    floorNum === undefined || getItemFloor({ floor: f }) === floorNum;

  (project.rooms ?? []).forEach((r) => {
    if (!matchFloor(r.floor)) return;
    include(r.x, r.y);
    include(r.x + r.width, r.y + r.height);
  });
  (project.customWalls ?? []).forEach((w) => {
    if (!matchFloor(w.floor)) return;
    include(w.x1, w.y1);
    include(w.x2, w.y2);
  });
  (project.points ?? []).forEach((p) => {
    if (!matchFloor(p.floor)) return;
    include(p.x, p.y);
  });
  (project.staircases ?? []).forEach((st) => {
    if (floorNum !== undefined && st.fromFloor !== floorNum && st.toFloor !== floorNum) return;
    const fp = computeStaircaseFootprint(st);
    include(st.x, st.y);
    include(st.x + fp.footprintW, st.y + fp.footprintD);
  });

  if (!Number.isFinite(minX)) {
    return {
      minX: 0,
      minY: 0,
      maxX: siteL,
      maxY: siteW,
      spanXM: siteL,
      spanYM: siteW,
      hasGeometry: false,
      exceedsSite: false,
    };
  }

  const exceedsSite =
    minX < -0.04 || minY < -0.04 || maxX > siteL + 0.04 || maxY > siteW + 0.04;

  return {
    minX: Number(minX.toFixed(3)),
    minY: Number(minY.toFixed(3)),
    maxX: Number(maxX.toFixed(3)),
    maxY: Number(maxY.toFixed(3)),
    spanXM: Number(Math.max(0, maxX - minX).toFixed(3)),
    spanYM: Number(Math.max(0, maxY - minY).toFixed(3)),
    hasGeometry: true,
    exceedsSite,
  };
}

/**
 * Explicit user-triggered non-destructive site-boundary remediation.
 * Expands site.length / site.width (in site.units) so the authoritative site boundary encloses
 * all existing rooms, points, staircases, and configured floor footprints — WITHOUT moving,
 * scaling, or modifying any existing user room or electrical component!
 */
export function fitSiteToActualGeometry(project: ProjectData): {
  project: ProjectData;
  changed: boolean;
  prevLength: number;
  prevWidth: number;
  nextLength: number;
  nextWidth: number;
} {
  const { lengthM: siteL, widthM: siteW } = siteToMeters(project.site);
  const bounds = computeActualGeometryBounds(project);
  const floors = getProjectFloors(project);

  let reqMaxXM = Math.max(siteL, bounds.hasGeometry ? bounds.maxX : siteL);
  let reqMaxYM = Math.max(siteW, bounds.hasGeometry ? bounds.maxY : siteW);

  floors.forEach((fc) => {
    const fb = getFloorBoundaryMeters(project, fc.floor);
    if (fb.lengthM > reqMaxXM) reqMaxXM = fb.lengthM;
    if (fb.widthM > reqMaxYM) reqMaxYM = fb.widthM;
  });

  const units = project.site.units;
  const rawNextL = units === 'ft' ? reqMaxXM * M_TO_FT : reqMaxXM;
  const rawNextW = units === 'ft' ? reqMaxYM * M_TO_FT : reqMaxYM;

  // Round cleanly UP to nearest 0.5 ft (imperial) or 0.1 m (metric) so geometry fits strictly inside
  const step = units === 'ft' ? 0.5 : 0.1;
  const nextLength = Number((Math.ceil((rawNextL - 1e-6) / step) * step).toFixed(2));
  const nextWidth = Number((Math.ceil((rawNextW - 1e-6) / step) * step).toFixed(2));

  const finalLength = Math.max(project.site.length, nextLength);
  const finalWidth = Math.max(project.site.width, nextWidth);
  const changed =
    Math.abs(finalLength - project.site.length) > 1e-4 ||
    Math.abs(finalWidth - project.site.width) > 1e-4;

  if (!changed) {
    return {
      project,
      changed: false,
      prevLength: project.site.length,
      prevWidth: project.site.width,
      nextLength: project.site.length,
      nextWidth: project.site.width,
    };
  }

  return {
    project: {
      ...project,
      site: {
        ...project.site,
        length: finalLength,
        width: finalWidth,
      },
    },
    changed: true,
    prevLength: project.site.length,
    prevWidth: project.site.width,
    nextLength: finalLength,
    nextWidth: finalWidth,
  };
}

export function countElementsOnFloor(project: ProjectData, floorNum: number): number {
  const rooms = project.rooms.filter((r) => getItemFloor(r) === floorNum).length;
  const walls = project.customWalls.filter((w) => getItemFloor(w) === floorNum).length;
  const openings = project.openings.filter((o) => getItemFloor(o) === floorNum).length;
  const furniture = project.furniture.filter((f) => getItemFloor(f) === floorNum).length;
  const points = project.points.filter((p) => getItemFloor(p) === floorNum).length;
  const stairs = (project.staircases ?? []).filter(
    (s) => s.fromFloor === floorNum || s.toFloor === floorNum
  ).length;
  const wires = (project.wires ?? []).filter(
    (w) => w.floor === floorNum || w.fromFloor === floorNum || w.toFloor === floorNum
  ).length;
  return rooms + walls + openings + furniture + points + stairs + wires;
}

export function addFloorToProject(
  project: ProjectData,
  kind: 'upper' | 'basement' | 'terrace' = 'upper'
): { project: ProjectData; newFloor: number } {
  const existing = getProjectFloors(project);
  const { ceilingM } = siteToMeters(project.site);
  const slabM = project.site.slabThicknessM ?? DEFAULT_SLAB_THICKNESS_M;
  const step = Number((ceilingM + slabM).toFixed(2));

  let nextFloorNum: number;
  let elevationM: number;
  let name: string;
  let floorHeightM = Number(ceilingM.toFixed(2));

  if (kind === 'basement') {
    const minFloor = Math.min(...existing.map((f) => f.floor));
    const minElev = Math.min(...existing.map((f) => f.elevationM));
    nextFloorNum = minFloor > 0 ? 0 : minFloor - 1;
    elevationM = Number((minElev - step).toFixed(2));
    name = nextFloorNum === 0 ? 'Basement' : `Basement ${Math.abs(nextFloorNum) + 1}`;
  } else if (kind === 'terrace') {
    const maxFloor = Math.max(...existing.map((f) => f.floor));
    const highest = existing[existing.length - 1];
    nextFloorNum = maxFloor + 1;
    elevationM = Number(
      (highest.elevationM + (highest.kind === 'terrace' ? step : highest.floorHeightM + highest.slabThicknessM)).toFixed(2)
    );
    name = existing.some((f) => f.kind === 'terrace') ? `Terrace ${existing.filter((f) => f.kind === 'terrace').length + 1}` : 'Terrace';
    floorHeightM = 1.2;
  } else {
    // Insert above highest non-terrace floor (and shift any terrace up cleanly)
    const nonTerrace = existing.filter((f) => f.kind !== 'terrace');
    const highestNormal = nonTerrace[nonTerrace.length - 1] ?? existing[existing.length - 1];
    const maxFloor = Math.max(...existing.map((f) => f.floor));
    nextFloorNum = maxFloor + 1;
    elevationM = Number(
      (highestNormal.elevationM + highestNormal.floorHeightM + highestNormal.slabThicknessM).toFixed(2)
    );
    const upperIndex = nonTerrace.filter((f) => f.floor >= 1).length + 1;
    name = getDefaultFloorName(upperIndex, 'upper');
  }

  const created: FloorLevelConfig = {
    floor: nextFloorNum,
    name,
    kind,
    elevationM,
    floorHeightM,
    slabThicknessM: slabM,
    visible: true,
  };

  // If adding an upper floor below an existing terrace, lift the terrace elevation so it stays on top
  const updatedExisting =
    kind === 'upper'
      ? existing.map((f) =>
          f.kind === 'terrace' && f.elevationM <= elevationM + 0.05
            ? { ...f, elevationM: Number((f.elevationM + step).toFixed(2)) }
            : f
        )
      : existing;

  const nextFloors = [...updatedExisting, created].sort(
    (a, b) => a.elevationM - b.elevationM || a.floor - b.floor
  );

  return {
    newFloor: nextFloorNum,
    project: {
      ...project,
      buildingType:
        kind === 'basement' || kind === 'terrace' || nextFloors.length > 3
          ? 'custom'
          : nextFloors.length === 2
            ? 'duplex'
            : nextFloors.length === 3
              ? 'triplex'
              : project.buildingType ?? 'single',
      site: {
        ...project.site,
        floors: nextFloors.length,
      },
      floorConfigs: nextFloors,
    },
  };
}

export function duplicateFloorInProject(
  project: ProjectData,
  sourceFloor: number
): { project: ProjectData; newFloor: number } {
  const { project: withAdded, newFloor } = addFloorToProject(project, 'upper');
  const sourceCfg = getFloorConfig(project, sourceFloor);
  const ts = Date.now();

  const roomIdMap = new Map<string, string>();
  const clonedRooms = project.rooms
    .filter((r) => getItemFloor(r) === sourceFloor)
    .map((r, i) => {
      const id = `rm-f${newFloor}-${ts}-${i}`;
      roomIdMap.set(r.id, id);
      return { ...r, id, floor: newFloor };
    });

  const clonedWalls = project.customWalls
    .filter((w) => getItemFloor(w) === sourceFloor)
    .map((w, i) => ({ ...w, id: `cw-f${newFloor}-${ts}-${i}`, floor: newFloor }));

  const clonedOpenings = project.openings
    .filter((o) => getItemFloor(o) === sourceFloor)
    .map((o, i) => ({ ...o, id: `op-f${newFloor}-${ts}-${i}`, floor: newFloor }));

  const clonedDims = (project.dimensions ?? [])
    .filter((d) => getItemFloor(d) === sourceFloor)
    .map((d, i) => ({ ...d, id: `dim-f${newFloor}-${ts}-${i}`, floor: newFloor }));

  const clonedFurniture = project.furniture
    .filter((f) => getItemFloor(f) === sourceFloor)
    .map((f, i) => ({
      ...f,
      id: `fn-f${newFloor}-${ts}-${i}`,
      floor: newFloor,
      roomId: roomIdMap.get(f.roomId) ?? f.roomId,
    }));

  const pointIdMap = new Map<string, string>();
  const clonedPoints = project.points
    .filter((p) => getItemFloor(p) === sourceFloor)
    .map((p, i) => {
      const id = `pt-f${newFloor}-${ts}-${i}`;
      pointIdMap.set(p.id, id);
      return {
        ...p,
        id,
        floor: newFloor,
        roomId: roomIdMap.get(p.roomId) ?? p.roomId,
      };
    });

  // Clone same-floor electrical wires preserving source/destination point mapping
  const existingWireCount = (project.wires ?? []).length;
  const clonedWires: ElectricalWire[] = (project.wires ?? [])
    .filter((w) => w.fromFloor === sourceFloor && w.toFloor === sourceFloor && !w.isInterFloor)
    .map((w, i) => {
      const mappedFrom = pointIdMap.get(w.fromPointId);
      const mappedTo = pointIdMap.get(w.toPointId);
      if (!mappedFrom || !mappedTo) return null;
      return {
        ...w,
        id: `wire-f${newFloor}-${ts}-${i}`,
        code: `W-${String(existingWireCount + i + 1).padStart(2, '0')}`,
        floor: newFloor,
        fromFloor: newFloor,
        toFloor: newFloor,
        fromPointId: mappedFrom,
        toPointId: mappedTo,
        waypoints: w.waypoints.map((wp) => ({ ...wp })),
      };
    })
    .filter((w): w is ElectricalWire => w !== null);

  const nextFloors = (withAdded.floorConfigs ?? []).map((fc) =>
    fc.floor === newFloor
      ? {
          ...fc,
          name: `${sourceCfg.name} (Copy)`,
          floorHeightM: sourceCfg.floorHeightM,
          slabThicknessM: sourceCfg.slabThicknessM,
        }
      : fc
  );

  return {
    newFloor,
    project: {
      ...withAdded,
      floorConfigs: nextFloors,
      rooms: [...withAdded.rooms, ...clonedRooms],
      customWalls: [...withAdded.customWalls, ...clonedWalls],
      openings: [...withAdded.openings, ...clonedOpenings],
      dimensions: [...(withAdded.dimensions ?? []), ...clonedDims],
      furniture: [...withAdded.furniture, ...clonedFurniture],
      points: [...withAdded.points, ...clonedPoints],
      wires: [...(withAdded.wires ?? []), ...clonedWires],
    },
  };
}

export function removeFloorFromProject(
  project: ProjectData,
  targetFloor: number
): { project: ProjectData; fallbackFloor: number } | null {
  const existing = getProjectFloors(project);
  if (existing.length <= 1) return null;

  const remaining = existing.filter((f) => f.floor !== targetFloor);
  if (remaining.length === existing.length) return null;

  const fallbackFloor =
    remaining.find((f) => f.floor === 1)?.floor ?? remaining[0].floor;

  const removedPointIds = new Set(
    project.points.filter((p) => getItemFloor(p) === targetFloor).map((p) => p.id)
  );

  return {
    fallbackFloor,
    project: {
      ...project,
      site: {
        ...project.site,
        floors: remaining.length,
      },
      floorConfigs: remaining,
      rooms: project.rooms.filter((r) => getItemFloor(r) !== targetFloor),
      customWalls: project.customWalls.filter((w) => getItemFloor(w) !== targetFloor),
      openings: project.openings.filter((o) => getItemFloor(o) !== targetFloor),
      dimensions: (project.dimensions ?? []).filter((d) => getItemFloor(d) !== targetFloor),
      furniture: project.furniture.filter((f) => getItemFloor(f) !== targetFloor),
      points: project.points.filter((p) => getItemFloor(p) !== targetFloor),
      staircases: (project.staircases ?? []).filter(
        (s) => s.fromFloor !== targetFloor && s.toFloor !== targetFloor
      ),
      wires: (project.wires ?? []).filter(
        (w) =>
          w.floor !== targetFloor &&
          w.fromFloor !== targetFloor &&
          w.toFloor !== targetFloor &&
          !removedPointIds.has(w.fromPointId) &&
          !removedPointIds.has(w.toPointId)
      ),
    },
  };
}

export function updateFloorConfigInProject(
  project: ProjectData,
  targetFloor: number,
  patch: Partial<Omit<FloorLevelConfig, 'floor'>>
): ProjectData {
  const existing = getProjectFloors(project);
  const updated = existing
    .map((f) => (f.floor === targetFloor ? { ...f, ...patch } : f))
    .sort((a, b) => a.elevationM - b.elevationM || a.floor - b.floor);

  return {
    ...project,
    floorConfigs: updated,
    site: {
      ...project.site,
      floors: updated.length,
    },
  };
}

/**
 * Safely switches building type (Single/Duplex/Triplex/Custom) by adding any missing default floors
 * without deleting existing user floors or design elements.
 */
export function applyBuildingTypeSafely(
  project: ProjectData,
  nextType: BuildingType
): ProjectData {
  const existing = getProjectFloors(project);
  const { ceilingM } = siteToMeters(project.site);
  const slabM = project.site.slabThicknessM ?? DEFAULT_SLAB_THICKNESS_M;
  const step = Number((ceilingM + slabM).toFixed(2));

  const targetFloors =
    nextType === 'single' ? [1] : nextType === 'duplex' ? [1, 2] : nextType === 'triplex' ? [1, 2, 3] : [1, 2];

  const byNum = new Map<number, FloorLevelConfig>(existing.map((f) => [f.floor, f]));
  for (const fl of targetFloors) {
    if (!byNum.has(fl)) {
      byNum.set(fl, {
        floor: fl,
        name: getDefaultFloorName(fl, fl === 1 ? 'ground' : 'upper'),
        kind: fl === 1 ? 'ground' : 'upper',
        elevationM: Number(((fl - 1) * step).toFixed(2)),
        floorHeightM: Number(ceilingM.toFixed(2)),
        slabThicknessM: slabM,
        visible: true,
      });
    }
  }

  const nextList = Array.from(byNum.values()).sort(
    (a, b) => a.elevationM - b.elevationM || a.floor - b.floor
  );

  return {
    ...project,
    buildingType: nextType,
    floorConfigs: nextList,
    site: {
      ...project.site,
      floors: nextList.length,
    },
  };
}

/**
 * Safely adjusts the project's storey count from Site Parameters without ever orphaning
 * rooms, electrical points, walls, openings, staircases, or wires on higher floors.
 */
export function setProjectFloorCountSafely(
  project: ProjectData,
  requestedFloors: number
): { project: ProjectData; blockedReason?: string } {
  const targetCount = Math.max(1, Math.min(8, Math.round(requestedFloors || 1)));
  let working = project;
  let current = getProjectFloors(working);

  if (targetCount === current.length) {
    return {
      project: {
        ...working,
        floorConfigs: current,
        site: { ...working.site, floors: current.length },
      },
    };
  }

  if (targetCount > current.length) {
    while (current.length < targetCount) {
      const added = addFloorToProject(working, 'upper');
      working = added.project;
      current = getProjectFloors(working);
    }
    return { project: working };
  }

  // Decreasing floors: check top-most floors for existing placed elements first
  const sortedAsc = [...current].sort((a, b) => a.elevationM - b.elevationM || a.floor - b.floor);
  const floorsToRemove = sortedAsc.slice(targetCount);
  const nonEmpty = floorsToRemove.filter((fl) => countElementsOnFloor(working, fl.floor) > 0);
  if (nonEmpty.length > 0) {
    const names = nonEmpty.map((f) => `${f.name} (${countElementsOnFloor(working, f.floor)} items)`).join(', ');
    return {
      project,
      blockedReason: `Cannot reduce floors while elements exist on ${names}. Remove or relocate those floor items in Floor Manager first.`,
    };
  }

  for (let i = floorsToRemove.length - 1; i >= 0; i--) {
    const res = removeFloorFromProject(working, floorsToRemove[i].floor);
    if (res) {
      working = res.project;
    }
  }
  const finalFloors = getProjectFloors(working);
  return {
    project: {
      ...working,
      buildingType:
        finalFloors.some((f) => f.kind === 'basement' || f.kind === 'terrace') || finalFloors.length > 3
          ? 'custom'
          : finalFloors.length === 1
            ? 'single'
            : finalFloors.length === 2
              ? 'duplex'
              : 'triplex',
      floorConfigs: finalFloors,
      site: { ...working.site, floors: finalFloors.length },
    },
  };
}

/**
 * Backward-compatible non-destructive migration for older saved projects loaded from storage/import.
 * Ensures floorConfigs exists and stays synchronized with site.floors.
 * If legacy projects lacked floorConfigs (or had mismatched site.floors) while having valid placed
 * elements on higher floors, expands floorConfigs safely so zero elements are lost or orphaned.
 * Never mutates user-entered site dimensions, rooms, or electrical point coordinates.
 */
export function migrateProjectFloorSchema(project: ProjectData): ProjectData {
  const { ceilingM } = siteToMeters(project.site);
  const slabM = project.site.slabThicknessM ?? DEFAULT_SLAB_THICKNESS_M;
  const step = Number((ceilingM + slabM).toFixed(2));

  // If project already has explicit floorConfigs, preserve it and ensure site.floors matches its length
  if (Array.isArray(project.floorConfigs) && project.floorConfigs.length > 0) {
    const sorted = [...project.floorConfigs].sort(
      (a, b) => a.elevationM - b.elevationM || a.floor - b.floor
    );
    if (project.site.floors !== sorted.length) {
      return {
        ...project,
        floorConfigs: sorted,
        site: {
          ...project.site,
          floors: sorted.length,
        },
      };
    }
    return project;
  }

  // Legacy project without floorConfigs: inspect both site.floors and any referenced floors on items
  const referencedFloors = new Set<number>([1]);
  const declaredCount = Math.max(1, Math.min(8, Math.round(project.site.floors || 1)));
  for (let f = 1; f <= declaredCount; f++) referencedFloors.add(f);

  const collectFloor = (f?: number) => {
    if (typeof f === 'number' && Number.isFinite(f) && f >= -2 && f <= 10) {
      referencedFloors.add(Math.floor(f));
    }
  };
  (project.rooms ?? []).forEach((r) => collectFloor(r.floor));
  (project.customWalls ?? []).forEach((w) => collectFloor(w.floor));
  (project.openings ?? []).forEach((o) => collectFloor(o.floor));
  (project.dimensions ?? []).forEach((d) => collectFloor(d.floor));
  (project.furniture ?? []).forEach((f) => collectFloor(f.floor));
  (project.points ?? []).forEach((p) => collectFloor(p.floor));
  (project.staircases ?? []).forEach((s) => {
    collectFloor(s.fromFloor);
    collectFloor(s.toFloor);
  });
  (project.wires ?? []).forEach((w) => {
    collectFloor(w.floor);
    collectFloor(w.fromFloor);
    collectFloor(w.toFloor);
  });

  const sortedNums = Array.from(referencedFloors).sort((a, b) => a - b);
  const configs: FloorLevelConfig[] = sortedNums.map((fl) => ({
    floor: fl,
    name: getDefaultFloorName(fl, fl === 0 ? 'basement' : fl === 1 ? 'ground' : 'upper'),
    kind: fl <= 0 ? 'basement' : fl === 1 ? 'ground' : 'upper',
    elevationM: Number(((fl - 1) * step).toFixed(2)),
    floorHeightM: Number(ceilingM.toFixed(2)),
    slabThicknessM: slabM,
    visible: true,
  }));

  return {
    ...project,
    buildingType:
      project.buildingType ??
      (configs.some((f) => f.kind === 'basement' || f.kind === 'terrace') || configs.length > 3
        ? 'custom'
        : configs.length === 1
          ? 'single'
          : configs.length === 2
            ? 'duplex'
            : 'triplex'),
    floorConfigs: configs,
    site: {
      ...project.site,
      floors: configs.length,
    },
  };
}

// ============================================================
// STAIRCASE GEOMETRY & HELPERS
// ============================================================

export function computeStaircaseFootprint(stair: StaircaseItem): {
  footprintW: number;
  footprintD: number;
  flightRun: number;
} {
  const steps = Math.max(4, Math.round(stair.steps));
  const tread = Math.max(0.18, stair.treadDepth);
  const w = Math.max(0.75, stair.width);

  if (stair.type === 'straight') {
    const run = Number((steps * tread).toFixed(2));
    return { footprintW: run, footprintD: w, flightRun: run };
  }
  if (stair.type === 'l-shaped') {
    const firstSteps = Math.floor(steps / 2);
    const secondSteps = steps - firstSteps;
    const lw = Math.max(w, stair.landingWidth);
    const ld = Math.max(w, stair.landingDepth);
    return {
      footprintW: Number((firstSteps * tread + lw).toFixed(2)),
      footprintD: Number((ld + secondSteps * tread).toFixed(2)),
      flightRun: Number((firstSteps * tread).toFixed(2)),
    };
  }
  if (stair.type === 'u-shaped') {
    const halfSteps = Math.ceil(steps / 2);
    const ld = Math.max(w, stair.landingDepth);
    const wellGap = 0.16;
    return {
      footprintW: Number((halfSteps * tread + ld).toFixed(2)),
      footprintD: Number((w * 2 + wellGap).toFixed(2)),
      flightRun: Number((halfSteps * tread).toFixed(2)),
    };
  }
  // spiral
  const diameter = Number(Math.max(1.4, w * 2 + 0.25).toFixed(2));
  return { footprintW: diameter, footprintD: diameter, flightRun: diameter };
}

export function createDefaultStaircase(
  project: ProjectData,
  fromFloor: number,
  x: number,
  y: number,
  type: StaircaseType = 'straight'
): StaircaseItem {
  const floors = getProjectFloors(project);
  const fromIdx = floors.findIndex((f) => f.floor === fromFloor);
  const nextUpper = fromIdx >= 0 && fromIdx + 1 < floors.length ? floors[fromIdx + 1] : null;
  const toFloor = nextUpper ? nextUpper.floor : fromFloor + 1;

  const fromElev = getFloorElevationM(project, fromFloor);
  const toElev = nextUpper
    ? nextUpper.elevationM
    : fromElev + siteToMeters(project.site).ceilingM + DEFAULT_SLAB_THICKNESS_M;
  const totalRise = Math.max(2.0, Math.abs(toElev - fromElev));
  const targetRiser = 0.175;
  const steps = Math.max(8, Math.min(28, Math.round(totalRise / targetRiser)));
  const riserHeight = Number((totalRise / steps).toFixed(3));
  const count = (project.staircases ?? []).length + 1;

  return {
    id: `st-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: `Staircase ${count}`,
    type,
    fromFloor,
    toFloor,
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
    rotation: 0,
    width: 1.05,
    riserHeight,
    treadDepth: 0.27,
    steps,
    landingWidth: 1.1,
    landingDepth: 1.1,
  };
}

// ============================================================
// INTERACTIVE ELECTRICAL WIRING ENGINE
// ============================================================

export interface WireCompatibilityResult {
  compatible: boolean;
  warning?: string;
  reason?: string;
}

/**
 * Checks whether two electrical terminals can be connected with the chosen wire category.
 * Prevents self-loops, accidental inter-floor wiring unless permitted, and invalid terminal mismatches.
 */
export function checkTerminalCompatibility(
  fromPt: ElectricalPoint,
  toPt: ElectricalPoint,
  category: WireCategory,
  allowInterFloor = false
): WireCompatibilityResult {
  if (fromPt.id === toPt.id) {
    return {
      compatible: false,
      reason: 'Cannot connect an electrical component to itself.',
    };
  }

  const fromFloor = getItemFloor(fromPt);
  const toFloor = getItemFloor(toPt);
  if (fromFloor !== toFloor && !allowInterFloor) {
    return {
      compatible: false,
      reason: `Endpoints are on different floors (${fromFloor} vs ${toFloor}). Enable Inter-Floor Riser mode to connect across levels.`,
    };
  }

  // Communication cables should not connect directly to high-power appliances/geysers/ACs
  const highPowerTypes = new Set(['split_ac', 'geyser', 'socket_16a', 'appliance']);
  if (
    category === 'communication' &&
    (highPowerTypes.has(fromPt.itemType) || highPowerTypes.has(toPt.itemType))
  ) {
    return {
      compatible: false,
      reason: 'Incompatible terminals: Communication/Data wiring cannot terminate directly on high-power 16A/appliance terminals.',
    };
  }

  // Control wiring typically links switches/switchboards to fixtures or fans
  if (
    category === 'control' &&
    highPowerTypes.has(fromPt.itemType) &&
    highPowerTypes.has(toPt.itemType)
  ) {
    return {
      compatible: true,
      warning: 'Control wire between two heavy power loads — verify relay/contactor isolation.',
    };
  }

  return { compatible: true };
}

export function isDuplicateWireConnection(
  wires: ElectricalWire[],
  fromPointId: string,
  toPointId: string,
  category: WireCategory
): boolean {
  return wires.some(
    (w) =>
      w.category === category &&
      ((w.fromPointId === fromPointId && w.toPointId === toPointId) ||
        (w.fromPointId === toPointId && w.toPointId === fromPointId))
  );
}

export function generateAutoRouteWaypoints(
  fromPt: { x: number; y: number },
  toPt: { x: number; y: number },
  mode: 'horizontal-first' | 'vertical-first' = 'horizontal-first'
): WireWaypoint[] {
  const dx = Math.abs(toPt.x - fromPt.x);
  const dy = Math.abs(toPt.y - fromPt.y);
  if (dx < 0.12 || dy < 0.12) return [];
  if (mode === 'horizontal-first') {
    return [{ x: Number(toPt.x.toFixed(2)), y: Number(fromPt.y.toFixed(2)) }];
  }
  return [{ x: Number(fromPt.x.toFixed(2)), y: Number(toPt.y.toFixed(2)) }];
}

/**
 * Counts how many room interiors a horizontal or vertical segment strictly passes through.
 * Segments hugging wall borders (within 0.28m of a room edge) are treated as wall-aligned (0 crossings).
 */
function countRoomInteriorCrossings(
  a: { x: number; y: number },
  b: { x: number; y: number },
  rooms: Array<{ x: number; y: number; width: number; height: number }>
): number {
  let crossings = 0;
  const margin = 0.26;
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);

  for (const r of rooms) {
    if (r.width <= margin * 2.2 || r.height <= margin * 2.2) continue;
    const ix1 = r.x + margin;
    const ix2 = r.x + r.width - margin;
    const iy1 = r.y + margin;
    const iy2 = r.y + r.height - margin;

    if (Math.abs(a.y - b.y) < 0.05) {
      // Horizontal segment
      if (a.y > iy1 && a.y < iy2 && maxX > ix1 && minX < ix2) {
        crossings += 1;
      }
    } else if (Math.abs(a.x - b.x) < 0.05) {
      // Vertical segment
      if (a.x > ix1 && a.x < ix2 && maxY > iy1 && minY < iy2) {
        crossings += 1;
      }
    } else {
      // Diagonal fallback check at midpoint
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (mx > ix1 && mx < ix2 && my > iy1 && my < iy2) {
        crossings += 1;
      }
    }
  }
  return crossings;
}

/**
 * Generates an orthogonal wall-hugging, obstacle-aware route that prefers perimeter / corridor
 * and room-wall tracks instead of cutting across room interiors.
 */
export function generateWallAlignedWaypoints(
  fromPt: { x: number; y: number },
  toPt: { x: number; y: number },
  rooms: Array<{ x: number; y: number; width: number; height: number }>,
  lengthM: number,
  widthM: number
): WireWaypoint[] {
  const dx = Math.abs(toPt.x - fromPt.x);
  const dy = Math.abs(toPt.y - fromPt.y);
  if (dx < 0.15 && dy < 0.15) return [];

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const maxXBound = Math.max(0.4, lengthM - 0.22);
  const maxYBound = Math.max(0.4, widthM - 0.22);
  const candidateYSet = new Set<number>([
    Number(clamp(fromPt.y, 0.22, maxYBound).toFixed(2)),
    Number(clamp(toPt.y, 0.22, maxYBound).toFixed(2)),
    0.25,
    Number(clamp(widthM - 0.25, 0.25, maxYBound).toFixed(2)),
  ]);
  const candidateXSet = new Set<number>([
    Number(clamp(fromPt.x, 0.22, maxXBound).toFixed(2)),
    Number(clamp(toPt.x, 0.22, maxXBound).toFixed(2)),
    0.25,
    Number(clamp(lengthM - 0.25, 0.25, maxXBound).toFixed(2)),
  ]);

  rooms.forEach((r) => {
    candidateYSet.add(Number(clamp(r.y + 0.18, 0.22, maxYBound).toFixed(2)));
    candidateYSet.add(Number(clamp(r.y + r.height - 0.18, 0.22, maxYBound).toFixed(2)));
    candidateXSet.add(Number(clamp(r.x + 0.18, 0.22, maxXBound).toFixed(2)));
    candidateXSet.add(Number(clamp(r.x + r.width - 0.18, 0.22, maxXBound).toFixed(2)));
  });

  const cleanWaypoints = (wps: WireWaypoint[]): WireWaypoint[] => {
    const out: WireWaypoint[] = [];
    for (const wp of wps) {
      if (Math.hypot(wp.x - fromPt.x, wp.y - fromPt.y) <= 0.1) continue;
      if (Math.hypot(wp.x - toPt.x, wp.y - toPt.y) <= 0.1) continue;
      const prev = out[out.length - 1];
      if (prev && Math.hypot(wp.x - prev.x, wp.y - prev.y) <= 0.1) continue;
      out.push(wp);
    }
    return out;
  };

  const scorePath = (wps: WireWaypoint[]): number => {
    const pts = [fromPt, ...wps, toPt];
    let len = 0;
    let crossings = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      len += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      crossings += countRoomInteriorCrossings(pts[i], pts[i + 1], rooms);
    }
    // Strongly prefer fewer room-interior crossings, then shorter geometric path, then fewer bends
    return crossings * 8.5 + len + wps.length * 0.12;
  };

  const candidates: WireWaypoint[][] = [
    cleanWaypoints([{ x: Number(toPt.x.toFixed(2)), y: Number(fromPt.y.toFixed(2)) }]),
    cleanWaypoints([{ x: Number(fromPt.x.toFixed(2)), y: Number(toPt.y.toFixed(2)) }]),
  ];

  candidateYSet.forEach((cy) => {
    candidates.push(
      cleanWaypoints([
        { x: Number(fromPt.x.toFixed(2)), y: cy },
        { x: Number(toPt.x.toFixed(2)), y: cy },
      ])
    );
  });
  candidateXSet.forEach((cx) => {
    candidates.push(
      cleanWaypoints([
        { x: cx, y: Number(fromPt.y.toFixed(2)) },
        { x: cx, y: Number(toPt.y.toFixed(2)) },
      ])
    );
  });

  let best = candidates[0];
  let bestScore = scorePath(best);
  for (let i = 1; i < candidates.length; i++) {
    const sc = scorePath(candidates[i]);
    if (sc < bestScore) {
      bestScore = sc;
      best = candidates[i];
    }
  }
  return best;
}

export function validateWireRoutePath(
  fromPt: ElectricalPoint | undefined,
  toPt: ElectricalPoint | undefined,
  waypoints: WireWaypoint[],
  project: ProjectData
): { valid: boolean; reason?: string; lengthM: number } {
  if (!fromPt || !toPt) {
    return { valid: false, reason: 'Source or destination electrical point does not exist.', lengthM: 0 };
  }
  if (fromPt.id === toPt.id) {
    return { valid: false, reason: 'Cable source and destination cannot be the same component.', lengthM: 0 };
  }
  for (const wp of waypoints) {
    if (!Number.isFinite(wp.x) || !Number.isFinite(wp.y)) {
      return { valid: false, reason: 'Cable route contains invalid waypoint coordinates.', lengthM: 0 };
    }
  }

  const tempWire: ElectricalWire = {
    id: 'tmp',
    code: 'TMP',
    floor: getItemFloor(fromPt),
    fromPointId: fromPt.id,
    toPointId: toPt.id,
    fromFloor: getItemFloor(fromPt),
    toFloor: getItemFloor(toPt),
    isInterFloor: getItemFloor(fromPt) !== getItemFloor(toPt),
    waypoints,
    circuit: fromPt.circuit || toPt.circuit,
    category: 'phase',
    wireType: 'PVC Insulated Copper (FRLS)',
    cableMaterial: 'Copper',
    cableSizeSqMm: null,
    cores: 1,
    phaseDesignation: 'L1 (R)',
    color: '#EF4444',
    lineThickness: 2,
    lineStyle: 'solid',
    status: 'connected',
  };
  const lengthM = computeWireLengthMeters(tempWire, project);
  const planDist = Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y);
  if (lengthM <= 0.05 || (planDist < 0.02 && waypoints.length === 0 && getItemFloor(fromPt) === getItemFloor(toPt))) {
    return {
      valid: false,
      reason: 'Cable route length is zero or degenerate. Place distinct points or routing waypoints.',
      lengthM: 0,
    };
  }
  return { valid: true, lengthM };
}

export function createElectricalWire(options: {
  project: ProjectData;
  fromPoint: ElectricalPoint;
  toPoint: ElectricalPoint;
  waypoints?: WireWaypoint[];
  category?: WireCategory;
  circuit?: CircuitId | '';
  cableMaterial?: CableMaterial;
  cableSizeSqMm?: number | null;
}): ElectricalWire {
  const cfg = getWiringConfig(options.project);
  const category = options.category ?? 'phase';
  const catDefaults = WIRE_CATEGORY_DEFAULTS[category];
  const fromFloor = getItemFloor(options.fromPoint);
  const toFloor = getItemFloor(options.toPoint);
  const existing = options.project.wires ?? [];
  const nextIdx = existing.length + 1;

  return {
    id: `wire-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    code: `W-${String(nextIdx).padStart(2, '0')}`,
    floor: fromFloor,
    fromPointId: options.fromPoint.id,
    toPointId: options.toPoint.id,
    fromFloor,
    toFloor,
    isInterFloor: fromFloor !== toFloor,
    waypoints: (options.waypoints ?? []).map((wp) => ({
      x: Number(wp.x.toFixed(2)),
      y: Number(wp.y.toFixed(2)),
    })),
    circuit: options.circuit !== undefined ? options.circuit : options.fromPoint.circuit,
    category,
    wireType: catDefaults.wireType,
    cableMaterial: options.cableMaterial ?? 'Copper',
    cableSizeSqMm: options.cableSizeSqMm !== undefined ? options.cableSizeSqMm : null,
    cores: catDefaults.cores,
    phaseDesignation: catDefaults.phaseDesignation,
    color: WIRE_STANDARD_COLORS[cfg.standard][category],
    lineThickness: catDefaults.lineThickness,
    lineStyle: catDefaults.lineStyle,
    status: 'connected',
    assumptionNote:
      options.cableSizeSqMm === undefined || options.cableSizeSqMm === null
        ? 'Cable cross-section not yet specified — select sq.mm based on circuit breaker & load calculation.'
        : undefined,
  };
}

/**
 * Generates real, editable obstacle-aware orthogonal cable runs from the Main Distribution Board (DB-1)
 * to unwired branch circuit components (daisy-chained cleanly per floor & circuit along wall tracks),
 * plus protective Earth (PE) bonding from Main Earthing Point (EP-1) to DB-1 and heavy power loads.
 * Preserves all existing user-routed cables untouched and never creates duplicate connections.
 */
export function autoRouteUnwiredCables(project: ProjectData): {
  nextWires: ElectricalWire[];
  addedCount: number;
  skippedCount: number;
} {
  const { lengthM, widthM } = siteToMeters(project.site);
  const existing = [...(project.wires ?? [])];
  const dbPt = project.points.find((p) => p.itemType === 'distribution_board');
  const epPt = project.points.find((p) => p.itemType === 'earthing_point');
  if (!dbPt) {
    return { nextWires: existing, addedCount: 0, skippedCount: 0 };
  }

  let addedCount = 0;
  let skippedCount = 0;
  const workingWires = [...existing];
  const wiringCfg = getWiringConfig(project);

  const pushWire = (
    fromPt: ElectricalPoint,
    toPt: ElectricalPoint,
    category: WireCategory,
    circuit: CircuitId | '',
    sizeSqMm: number | null,
    material: CableMaterial
  ) => {
    if (fromPt.id === toPt.id) return;
    if (isDuplicateWireConnection(workingWires, fromPt.id, toPt.id, category)) {
      skippedCount += 1;
      return;
    }
    const floorRooms = project.rooms.filter((r) => getItemFloor(r) === getItemFloor(toPt));
    const flBounds = getFloorBoundaryMeters(project, getItemFloor(toPt));
    const waypoints = generateWallAlignedWaypoints(
      fromPt,
      toPt,
      floorRooms,
      flBounds.lengthM,
      flBounds.widthM
    );
    const check = validateWireRoutePath(fromPt, toPt, waypoints, project);
    if (!check.valid) {
      skippedCount += 1;
      return;
    }
    const catDefaults = WIRE_CATEGORY_DEFAULTS[category];
    const fromFloor = getItemFloor(fromPt);
    const toFloor = getItemFloor(toPt);
    const seq = workingWires.length + 1;
    const cktCfg = circuit ? project.circuitCableConfigs?.[circuit] : undefined;
    const servedFloor =
      fromPt.itemType === 'distribution_board' || fromPt.itemType === 'earthing_point'
        ? toFloor
        : fromFloor;
    workingWires.push({
      id: `wire-auto-${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 5)}`,
      code: `W-${String(seq).padStart(2, '0')}`,
      floor: servedFloor,
      fromPointId: fromPt.id,
      toPointId: toPt.id,
      fromFloor,
      toFloor,
      isInterFloor: fromFloor !== toFloor,
      waypoints,
      circuit,
      category,
      wireType: catDefaults.wireType,
      cableMaterial: material,
      cableSizeSqMm: sizeSqMm,
      cores: catDefaults.cores,
      phaseDesignation: catDefaults.phaseDesignation,
      color: WIRE_STANDARD_COLORS[wiringCfg.standard][category],
      lineThickness: catDefaults.lineThickness,
      lineStyle: catDefaults.lineStyle,
      status: 'connected',
      ...(cktCfg?.productId
        ? {
            productId: cktCfg.productId,
            manufacturer: cktCfg.manufacturer,
            modelNumber: cktCfg.modelNumber,
          }
        : {}),
    });
    addedCount += 1;
  };

  // 1. Bond EP-1 -> DB-1 with Earth conductor
  if (epPt) {
    const earthSize = epPt.earthingConfig?.earthConductorSizeSqMm ?? 4.0;
    pushWire(epPt, dbPt, 'earth', 'CKT-P2 (Power 16A)', earthSize, 'Copper');
  }

  // 2. Group branch load points by (floor, circuit) and route nearest-neighbor chain from DB-1
  const alreadyPhaseConnected = new Set<string>();
  workingWires.forEach((w) => {
    if (w.category === 'phase') {
      alreadyPhaseConnected.add(w.fromPointId);
      alreadyPhaseConnected.add(w.toPointId);
    }
  });

  const branchPoints = project.points.filter(
    (p) => p.itemType !== 'distribution_board' && p.itemType !== 'earthing_point'
  );

  const groups = new Map<string, ElectricalPoint[]>();
  branchPoints.forEach((pt) => {
    const key = `${getItemFloor(pt)}::${pt.circuit || 'UNASSIGNED'}`;
    const arr = groups.get(key) ?? [];
    arr.push(pt);
    groups.set(key, arr);
  });

  const earthRequiredTypes = new Set(['split_ac', 'geyser', 'socket_16a', 'appliance']);

  groups.forEach((pts) => {
    const unwired = pts.filter((p) => !alreadyPhaseConnected.has(p.id));
    if (unwired.length === 0) return;

    const ckt = (unwired[0].circuit || '') as CircuitId | '';
    const cktCfg = ckt ? project.circuitCableConfigs?.[ckt] : undefined;
    const defaultSize = cktCfg?.cableSizeSqMm ?? (getCircuitKind(ckt) === 'power' ? 2.5 : 1.5);
    const mat: CableMaterial = cktCfg?.cableMaterial ?? 'Copper';

    // Order by nearest-neighbor starting from DB
    const remaining = [...unwired];
    let currentAnchor: ElectricalPoint = dbPt;
    while (remaining.length > 0) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = Math.hypot(remaining[i].x - currentAnchor.x, remaining[i].y - currentAnchor.y);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      const nextPt = remaining.splice(bestIdx, 1)[0];
      pushWire(currentAnchor, nextPt, 'phase', ckt, defaultSize, mat);
      pushWire(currentAnchor, nextPt, 'neutral', ckt, defaultSize, mat);
      if (earthRequiredTypes.has(nextPt.itemType)) {
        const peSource = currentAnchor.itemType === 'distribution_board' ? dbPt : currentAnchor;
        pushWire(peSource, nextPt, 'earth', ckt, Math.min(defaultSize, 2.5), mat);
      }
      alreadyPhaseConnected.add(nextPt.id);
      currentAnchor = nextPt;
    }
  });

  return { nextWires: workingWires, addedCount, skippedCount };
}

/**
 * Computes exact polyline wire length in meters, including horizontal routing segments,
 * vertical ceiling/wall drops, and inter-floor vertical riser height if spanning storeys.
 */
export function computeWireLengthMeters(wire: ElectricalWire, project: ProjectData): number {
  const fromPt = project.points.find((p) => p.id === wire.fromPointId);
  const toPt = project.points.find((p) => p.id === wire.toPointId);
  if (!fromPt || !toPt) return 0;

  const nodes: { x: number; y: number }[] = [
    { x: fromPt.x, y: fromPt.y },
    ...(wire.waypoints ?? []),
    { x: toPt.x, y: toPt.y },
  ];

  let planLength = 0;
  for (let i = 0; i < nodes.length - 1; i++) {
    const seg = Math.hypot(nodes[i + 1].x - nodes[i].x, nodes[i + 1].y - nodes[i].y);
    if (!Number.isFinite(seg)) return 0;
    planLength += seg;
  }

  const { ceilingM } = siteToMeters(project.site);
  const defaultCeiling = Number.isFinite(ceilingM) && ceilingM > 0 ? ceilingM : 3.0;
  const fromFloorCfg = getFloorConfig(project, getItemFloor(fromPt));
  const toFloorCfg = getFloorConfig(project, getItemFloor(toPt));
  const fromElev = Number.isFinite(fromFloorCfg?.elevationM) ? fromFloorCfg.elevationM : 0;
  const toElev = Number.isFinite(toFloorCfg?.elevationM) ? toFloorCfg.elevationM : 0;
  const fromFloorH =
    Number.isFinite(fromFloorCfg?.floorHeightM) && fromFloorCfg.floorHeightM > 0
      ? fromFloorCfg.floorHeightM
      : defaultCeiling;
  const fromPtZ = Number.isFinite(fromPt.z) ? fromPt.z : 1.2;
  const toPtZ = Number.isFinite(toPt.z) ? toPt.z : 1.2;

  const fromAbsZ = fromElev + fromPtZ;
  const toAbsZ = toElev + toPtZ;

  // Include vertical conduit drops from ceiling routing plane (or inter-floor elevation delta)
  const routeZ = Math.max(fromAbsZ, toAbsZ, fromElev + fromFloorH - 0.15);
  const verticalDrops =
    getItemFloor(fromPt) === getItemFloor(toPt)
      ? Math.abs(routeZ - fromAbsZ) + Math.abs(routeZ - toAbsZ)
      : Math.abs(toAbsZ - fromAbsZ) + 0.6;

  const total = planLength + verticalDrops;
  return Number.isFinite(total) ? Number(total.toFixed(2)) : 0;
}

// ============================================================
// VALIDATION & ERROR HANDLING ENGINE (BUILDING + ELECTRICAL)
// ============================================================

export interface ValidationIssue {
  id: string;
  domain: 'building' | 'electrical';
  severity: 'error' | 'warning' | 'info';
  floor?: number;
  entityRef?: { kind: 'room' | 'staircase' | 'wire' | 'point'; id: string };
  message: string;
}

export function validateBuildingAndElectrical(project: ProjectData): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const floors = getProjectFloors(project);
  const floorNums = new Set(floors.map((f) => f.floor));
  const { lengthM, widthM, ceilingM } = siteToMeters(project.site);
  const siteFootprintArea = lengthM * widthM;
  const BOUND_EPS = 0.04; // 4cm tolerance for rounding

  // 0. Building: Authoritative Site Dimensions & Floor Count Consistency
  if (!Number.isFinite(lengthM) || lengthM <= 0 || !Number.isFinite(widthM) || widthM <= 0) {
    issues.push({
      id: 'site-dims-invalid',
      domain: 'building',
      severity: 'error',
      message: `Site dimensions (${project.site.length} × ${project.site.width} ${project.site.units}) must be positive finite numbers.`,
    });
  }
  if (!Number.isFinite(ceilingM) || ceilingM < 1.8) {
    issues.push({
      id: 'site-ceiling-invalid',
      domain: 'building',
      severity: 'error',
      message: `Ceiling height (${project.site.ceilingHeight} ${project.site.units}) is below minimum habitable clearance.`,
    });
  }
  if (Array.isArray(project.floorConfigs) && project.floorConfigs.length !== project.site.floors) {
    issues.push({
      id: 'site-floorcount-mismatch',
      domain: 'building',
      severity: 'error',
      message: `Site floor count (${project.site.floors}) does not match configured floor definitions (${project.floorConfigs.length}).`,
    });
  }

  // 1. Building: Check floor elevations & per-floor authoritative footprints
  for (let i = 0; i < floors.length; i++) {
    const f = floors[i];
    if (!Number.isFinite(f.elevationM)) {
      issues.push({
        id: `fl-elev-nan-${f.floor}`,
        domain: 'building',
        severity: 'error',
        floor: f.floor,
        message: `${f.name}: Floor elevation is invalid.`,
      });
    }
    if (f.lengthM !== undefined && (!Number.isFinite(f.lengthM) || f.lengthM <= 0)) {
      issues.push({
        id: `fl-len-invalid-${f.floor}`,
        domain: 'building',
        severity: 'error',
        floor: f.floor,
        message: `${f.name}: Custom floor length must be a positive number.`,
      });
    }
    if (f.widthM !== undefined && (!Number.isFinite(f.widthM) || f.widthM <= 0)) {
      issues.push({
        id: `fl-wid-invalid-${f.floor}`,
        domain: 'building',
        severity: 'error',
        floor: f.floor,
        message: `${f.name}: Custom floor width must be a positive number.`,
      });
    }
    const flBounds = getFloorBoundaryMeters(project, f.floor);
    if (flBounds.exceedsSite) {
      if (project.site.allowFloorExceedSite) {
        issues.push({
          id: `fl-overhang-allowed-${f.floor}`,
          domain: 'building',
          severity: 'info',
          floor: f.floor,
          message: `${f.name}: Floor footprint (${flBounds.lengthM.toFixed(2)}m × ${flBounds.widthM.toFixed(2)}m) exceeds site boundary (${lengthM.toFixed(2)}m × ${widthM.toFixed(2)}m) under explicit cantilever/overhang opt-in.`,
        });
      } else {
        issues.push({
          id: `fl-exceeds-site-${f.floor}`,
          domain: 'building',
          severity: 'error',
          floor: f.floor,
          message: `${f.name}: Floor footprint (${flBounds.lengthM.toFixed(2)}m × ${flBounds.widthM.toFixed(2)}m) exceeds site boundary (${lengthM.toFixed(2)}m × ${widthM.toFixed(2)}m). Expand site or enable overhang opt-in.`,
        });
      }
    }
    if (f.kind !== 'terrace' && f.floorHeightM < 2.0) {
      issues.push({
        id: `fl-height-low-${f.floor}`,
        domain: 'building',
        severity: 'warning',
        floor: f.floor,
        message: `${f.name}: Clear floor height (${f.floorHeightM.toFixed(2)}m) is below typical 2.4m residential minimum.`,
      });
    }
    if (i > 0) {
      const prev = floors[i - 1];
      const delta = f.elevationM - prev.elevationM;
      if (delta < 0.05) {
        issues.push({
          id: `fl-elev-overlap-${prev.floor}-${f.floor}`,
          domain: 'building',
          severity: 'error',
          floor: f.floor,
          message: `${f.name} elevation (${f.elevationM.toFixed(2)}m) collides with ${prev.name} (${prev.elevationM.toFixed(2)}m).`,
        });
      } else if (prev.kind !== 'terrace' && delta < prev.floorHeightM) {
        issues.push({
          id: `fl-elev-tight-${prev.floor}-${f.floor}`,
          domain: 'building',
          severity: 'warning',
          floor: f.floor,
          message: `Floor-to-floor spacing between ${prev.name} and ${f.name} (${delta.toFixed(2)}m) is less than ${prev.name} clear height (${prev.floorHeightM.toFixed(2)}m).`,
        });
      }
    }
  }

  // 2. Building: Missing floor associations, per-floor boundary overflows & overlapping rooms
  project.rooms.forEach((rm) => {
    const fl = getItemFloor(rm);
    const flBounds = getFloorBoundaryMeters(project, fl);
    if (!floorNums.has(fl)) {
      issues.push({
        id: `rm-missing-fl-${rm.id}`,
        domain: 'building',
        severity: 'error',
        floor: fl,
        entityRef: { kind: 'room', id: rm.id },
        message: `Room "${rm.name}" references floor level ${fl}, which is not configured in this project.`,
      });
    }
    if (
      rm.x < -BOUND_EPS ||
      rm.y < -BOUND_EPS ||
      rm.x + rm.width > flBounds.lengthM + BOUND_EPS ||
      rm.y + rm.height > flBounds.widthM + BOUND_EPS
    ) {
      const scopeLabel = flBounds.isCustom ? `${getFloorLabel(project, fl)} boundary` : 'authoritative site boundary';
      issues.push({
        id: `rm-oob-${rm.id}`,
        domain: 'building',
        severity: 'error',
        floor: fl,
        entityRef: { kind: 'room', id: rm.id },
        message: `Room "${rm.name}" (${rm.width.toFixed(2)}m × ${rm.height.toFixed(2)}m at ${rm.x.toFixed(2)},${rm.y.toFixed(2)}) exceeds the ${scopeLabel} (${flBounds.lengthM.toFixed(2)}m × ${flBounds.widthM.toFixed(2)}m).`,
      });
    }
  });

  // Check custom walls, openings, dimensions, furniture floor references & boundaries
  (project.customWalls ?? []).forEach((w) => {
    const fl = getItemFloor(w);
    const flBounds = getFloorBoundaryMeters(project, fl);
    if (!floorNums.has(fl)) {
      issues.push({
        id: `cw-missing-fl-${w.id}`,
        domain: 'building',
        severity: 'error',
        floor: fl,
        message: `Custom wall "${w.id}" references unconfigured floor level ${fl}.`,
      });
    }
    if (
      Math.min(w.x1, w.x2) < -BOUND_EPS ||
      Math.min(w.y1, w.y2) < -BOUND_EPS ||
      Math.max(w.x1, w.x2) > flBounds.lengthM + BOUND_EPS ||
      Math.max(w.y1, w.y2) > flBounds.widthM + BOUND_EPS
    ) {
      issues.push({
        id: `cw-oob-${w.id}`,
        domain: 'building',
        severity: 'error',
        floor: fl,
        message: `Custom wall "${w.id}" on ${getFloorLabel(project, fl)} extends outside floor boundary (${flBounds.lengthM.toFixed(2)}m × ${flBounds.widthM.toFixed(2)}m).`,
      });
    }
  });
  (project.openings ?? []).forEach((o) => {
    const fl = getItemFloor(o);
    if (!floorNums.has(fl)) {
      issues.push({
        id: `op-missing-fl-${o.id}`,
        domain: 'building',
        severity: 'error',
        floor: fl,
        message: `${o.kind === 'door' ? 'Door' : 'Window'} "${o.id}" references unconfigured floor level ${fl}.`,
      });
    }
  });
  (project.dimensions ?? []).forEach((d) => {
    const fl = getItemFloor(d);
    if (!floorNums.has(fl)) {
      issues.push({
        id: `dim-missing-fl-${d.id}`,
        domain: 'building',
        severity: 'error',
        floor: fl,
        message: `Dimension annotation "${d.id}" references unconfigured floor level ${fl}.`,
      });
    }
  });
  (project.furniture ?? []).forEach((f) => {
    const fl = getItemFloor(f);
    if (!floorNums.has(fl)) {
      issues.push({
        id: `fn-missing-fl-${f.id}`,
        domain: 'building',
        severity: 'error',
        floor: fl,
        message: `Furniture "${f.kind}" (${f.id}) references unconfigured floor level ${fl}.`,
      });
    }
  });

  floors.forEach((flCfg) => {
    const flBounds = getFloorBoundaryMeters(project, flCfg.floor);
    const flRooms = project.rooms.filter((r) => getItemFloor(r) === flCfg.floor);
    const flArea = flRooms.reduce((s, r) => s + r.width * r.height, 0);
    if (flBounds.areaSqM > 0 && flArea > flBounds.areaSqM + 0.35) {
      const boundName = flBounds.isCustom ? 'floor footprint' : 'site footprint';
      issues.push({
        id: `fl-area-overflow-${flCfg.floor}`,
        domain: 'building',
        severity: 'error',
        floor: flCfg.floor,
        message: `${flCfg.name}: Total room built-up area (${flArea.toFixed(1)} sq.m) exceeds ${boundName} (${flBounds.areaSqM.toFixed(1)} sq.m).`,
      });
    }
    if (!project.site.allowFloorExceedSite && siteFootprintArea > 0 && flArea > siteFootprintArea + 0.35 && flBounds.isCustom) {
      issues.push({
        id: `fl-site-area-overflow-${flCfg.floor}`,
        domain: 'building',
        severity: 'error',
        floor: flCfg.floor,
        message: `${flCfg.name}: Room area (${flArea.toFixed(1)} sq.m) exceeds site area (${siteFootprintArea.toFixed(1)} sq.m) without overhang authorization.`,
      });
    }

    for (let i = 0; i < flRooms.length; i++) {
      for (let j = i + 1; j < flRooms.length; j++) {
        const a = flRooms[i];
        const b = flRooms[j];
        const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        if (ox > 0.04 && oy > 0.04) {
          issues.push({
            id: `rm-overlap-${a.id}-${b.id}`,
            domain: 'building',
            severity: 'warning',
            floor: flCfg.floor,
            entityRef: { kind: 'room', id: a.id },
            message: `${flCfg.name}: "${a.name}" overlaps "${b.name}".`,
          });
        }
      }
    }
  });

  // 3. Building: Staircase level & geometry checks
  (project.staircases ?? []).forEach((st) => {
    if (!floorNums.has(st.fromFloor) || !floorNums.has(st.toFloor)) {
      issues.push({
        id: `st-missing-fl-${st.id}`,
        domain: 'building',
        severity: 'error',
        floor: st.fromFloor,
        entityRef: { kind: 'staircase', id: st.id },
        message: `${st.name}: Connects a floor level that does not exist in this building.`,
      });
    } else if (st.fromFloor === st.toFloor) {
      issues.push({
        id: `st-same-fl-${st.id}`,
        domain: 'building',
        severity: 'error',
        floor: st.fromFloor,
        entityRef: { kind: 'staircase', id: st.id },
        message: `${st.name}: Starting floor and destination floor cannot be identical.`,
      });
    } else {
      const rise = Math.abs(
        getFloorElevationM(project, st.toFloor) - getFloorElevationM(project, st.fromFloor)
      );
      const actualRiser = rise / Math.max(1, st.steps);
      if (actualRiser > 0.22 || actualRiser < 0.12) {
        issues.push({
          id: `st-riser-${st.id}`,
          domain: 'building',
          severity: 'warning',
          floor: st.fromFloor,
          entityRef: { kind: 'staircase', id: st.id },
          message: `${st.name}: Computed riser (${(actualRiser * 1000).toFixed(0)}mm for ${st.steps} steps over ${rise.toFixed(2)}m) is outside typical 140–195mm comfort range.`,
        });
      }
    }
  });

  // 4. Electrical: Component floor associations, per-floor boundary checks & Wire integrity
  const pointById = new Map(project.points.map((p) => [p.id, p]));
  project.points.forEach((pt) => {
    const fl = getItemFloor(pt);
    const flBounds = getFloorBoundaryMeters(project, fl);
    if (!floorNums.has(fl)) {
      issues.push({
        id: `pt-missing-fl-${pt.id}`,
        domain: 'electrical',
        severity: 'error',
        floor: fl,
        entityRef: { kind: 'point', id: pt.id },
        message: `Electrical component ${pt.code} (${pt.name}) references unconfigured floor level ${fl}.`,
      });
    }
    if (
      pt.x < -BOUND_EPS ||
      pt.y < -BOUND_EPS ||
      pt.x > flBounds.lengthM + BOUND_EPS ||
      pt.y > flBounds.widthM + BOUND_EPS
    ) {
      const scopeLabel = flBounds.isCustom ? `${getFloorLabel(project, fl)} boundary` : 'site boundary';
      issues.push({
        id: `pt-oob-${pt.id}`,
        domain: 'electrical',
        severity: 'error',
        floor: fl,
        entityRef: { kind: 'point', id: pt.id },
        message: `Electrical component ${pt.code} (${pt.x.toFixed(2)}m, ${pt.y.toFixed(2)}m) lies outside ${scopeLabel} (${flBounds.lengthM.toFixed(2)}m × ${flBounds.widthM.toFixed(2)}m).`,
      });
    }
  });

  const wires = project.wires ?? [];
  const seenPairs = new Map<string, string>();
  const earthedPointIds = new Set<string>();
  const wiredPointIds = new Set<string>();

  wires.forEach((w) => {
    const fromPt = pointById.get(w.fromPointId);
    const toPt = pointById.get(w.toPointId);

    if (!floorNums.has(w.floor) || !floorNums.has(w.fromFloor) || !floorNums.has(w.toFloor)) {
      issues.push({
        id: `wire-missing-fl-${w.id}`,
        domain: 'electrical',
        severity: 'error',
        floor: w.floor,
        entityRef: { kind: 'wire', id: w.id },
        message: `Wire ${w.code}: References an unconfigured floor level (${w.fromFloor} → ${w.toFloor}).`,
      });
    }

    if (!fromPt || !toPt) {
      issues.push({
        id: `wire-dangling-${w.id}`,
        domain: 'electrical',
        severity: 'error',
        floor: w.floor,
        entityRef: { kind: 'wire', id: w.id },
        message: `Wire ${w.code}: Disconnected endpoint — source or destination component no longer exists.`,
      });
      return;
    }

    wiredPointIds.add(fromPt.id);
    wiredPointIds.add(toPt.id);

    const lenM = computeWireLengthMeters(w, project);
    if (lenM <= 0.05) {
      issues.push({
        id: `wire-zero-len-${w.id}`,
        domain: 'electrical',
        severity: 'error',
        floor: w.floor,
        entityRef: { kind: 'wire', id: w.id },
        message: `Wire ${w.code} (${fromPt.code} → ${toPt.code}): Invalid or zero-length cable route (${lenM.toFixed(2)} m).`,
      });
    }

    if (w.category === 'earth') {
      earthedPointIds.add(fromPt.id);
      earthedPointIds.add(toPt.id);
    }

    const compat = checkTerminalCompatibility(fromPt, toPt, w.category, Boolean(w.isInterFloor));
    if (!compat.compatible) {
      issues.push({
        id: `wire-compat-${w.id}`,
        domain: 'electrical',
        severity: 'error',
        floor: w.floor,
        entityRef: { kind: 'wire', id: w.id },
        message: `Wire ${w.code}: ${compat.reason}`,
      });
    }

    const pairKey = [w.fromPointId, w.toPointId].sort().join('::') + '::' + w.category;
    if (seenPairs.has(pairKey)) {
      issues.push({
        id: `wire-dup-${w.id}`,
        domain: 'electrical',
        severity: 'warning',
        floor: w.floor,
        entityRef: { kind: 'wire', id: w.id },
        message: `Wire ${w.code}: Duplicate ${WIRE_CATEGORY_LABELS[w.category]} between ${fromPt.code} and ${toPt.code}.`,
      });
    } else {
      seenPairs.set(pairKey, w.id);
    }

    if (!w.circuit) {
      issues.push({
        id: `wire-nocircuit-${w.id}`,
        domain: 'electrical',
        severity: 'warning',
        floor: w.floor,
        entityRef: { kind: 'wire', id: w.id },
        message: `Wire ${w.code} (${fromPt.code} → ${toPt.code}): No circuit assigned.`,
      });
    }

    if (w.cableSizeSqMm === null || w.cableSizeSqMm <= 0) {
      issues.push({
        id: `wire-nosize-${w.id}`,
        domain: 'electrical',
        severity: 'warning',
        floor: w.floor,
        entityRef: { kind: 'wire', id: w.id },
        message: `Wire ${w.code}: Cable size (sq.mm) not specified — design input required.`,
      });
    } else if (w.category === 'phase' || w.category === 'neutral') {
      const check = validateCableSizeForCircuit(w.circuit, w.cableSizeSqMm);
      if (check.status === 'out-of-range' && check.warning) {
        issues.push({
          id: `wire-size-range-${w.id}`,
          domain: 'electrical',
          severity: 'warning',
          floor: w.floor,
          entityRef: { kind: 'wire', id: w.id },
          message: `Wire ${w.code}: ${check.warning}`,
        });
      }
    }
  });

  // 4b. Check configured circuit-level cable sizes against category ranges
  if (project.circuitCableConfigs) {
    Object.values(project.circuitCableConfigs).forEach((cfg) => {
      if (!cfg || cfg.cableSizeSqMm === null || cfg.cableSizeSqMm === undefined) return;
      const check = validateCableSizeForCircuit(cfg.circuit, cfg.cableSizeSqMm);
      if (check.status === 'out-of-range' && check.warning) {
        issues.push({
          id: `ckt-size-range-${cfg.circuit}`,
          domain: 'electrical',
          severity: 'warning',
          message: `${cfg.circuit}: ${check.warning}`,
        });
      }
    });
  }

  // 4c. Check Distribution Board & Earthing Point presence when electrical points exist
  const branchPoints = project.points.filter(
    (p) => p.itemType !== 'distribution_board' && p.itemType !== 'earthing_point'
  );
  if (project.points.length > 0) {
    const hasDb = project.points.some((p) => p.itemType === 'distribution_board');
    const hasEarthing = project.points.some((p) => p.itemType === 'earthing_point');
    if (!hasDb) {
      issues.push({
        id: 'proj-missing-db',
        domain: 'electrical',
        severity: 'error',
        message: 'No Main Distribution Board (DB-1) placed in this project. Use "Add Missing DB & Earthing" in Electrical Library.',
      });
    }
    if (!hasEarthing) {
      issues.push({
        id: 'proj-missing-ep',
        domain: 'electrical',
        severity: 'error',
        message: 'No Main Earthing Point (EP-1) placed in this project. Use "Add Missing DB & Earthing" in Electrical Library.',
      });
    }
  }

  // 4d. Check cable routing completeness
  if (branchPoints.length > 0 && wires.length === 0) {
    issues.push({
      id: 'proj-no-routed-cables',
      domain: 'electrical',
      severity: 'warning',
      message: `No cables have been routed yet for ${branchPoints.length} branch electrical points (total routed cable length = 0.00 m). Use Route Cable Tool or Auto-Route from DB.`,
    });
  } else if (branchPoints.length > 0 && wires.length > 0) {
    const unwiredBranch = branchPoints.filter((p) => !wiredPointIds.has(p.id));
    if (unwiredBranch.length > 0) {
      issues.push({
        id: 'proj-partial-routing',
        domain: 'electrical',
        severity: 'info',
        message: `${unwiredBranch.length} of ${branchPoints.length} branch electrical points do not yet have a routed cable connection.`,
      });
    }
  }

  // 5. Electrical: Earthing check for high-power appliances / 16A sockets when wires exist
  if (wires.length > 0) {
    const earthRequiredTypes = new Set(['split_ac', 'geyser', 'socket_16a', 'appliance']);
    project.points.forEach((pt) => {
      if (earthRequiredTypes.has(pt.itemType) && !earthedPointIds.has(pt.id)) {
        issues.push({
          id: `pt-noearth-${pt.id}`,
          domain: 'electrical',
          severity: 'warning',
          floor: getItemFloor(pt),
          entityRef: { kind: 'point', id: pt.id },
          message: `${pt.code} (${pt.name}) on ${getFloorLabel(project, getItemFloor(pt))}: No Earth (PE) conductor connected yet.`,
        });
      }
    });
  }

  // 6. Informational engineering governance notice
  issues.push({
    id: 'info-cable-sizing-disclaimer',
    domain: 'electrical',
    severity: 'info',
    message:
      'Cable sizing ranges (1.5–2.5 sq.mm lighting; 2.5–4.0 sq.mm power) are configurable design inputs. Verify final breaker coordination, voltage drop, and IS 732 / NEC compliance before site execution.',
  });

  return issues;
}

export interface FloorSummaryRow {
  floor: number;
  name: string;
  kind: FloorKind;
  elevationM: number;
  floorHeightM: number;
  slabThicknessM: number;
  floorLengthM: number;
  floorWidthM: number;
  isCustomBoundary: boolean;
  floorFootprintAreaSqM: number;
  roomCount: number;
  builtUpAreaSqM: number;
  stairVoidAreaSqM: number;
  excludedOpenAreaSqM: number;
  overflowAreaSqM: number;
  pointCount: number;
  branchPointCount: number;
  distributionCount: number;
  wireCount: number;
  routedLengthM: number;
  loadWatts: number;
  isOrphaned?: boolean;
}

export interface ReconciledCircuitRow {
  circuit: string;
  kind: 'lighting' | 'power' | 'distribution' | 'unassigned';
  pointCount: number;
  loadWatts: number;
  loadKw: number;
  currentAmps: number;
  cableSizeSqMm: number | null;
  cableMaterial: CableMaterial;
  routedWireCount: number;
  routedLengthM: number;
  rangeLabel: string;
  statusNote: string;
}

export interface ReconciledComponentRow {
  itemType: string;
  name: string;
  category: string;
  quantity: number;
  totalWattage: number;
  estimatedCost: number;
}

export interface ReconciledElectricalSchedule {
  siteLengthM: number;
  siteWidthM: number;
  siteFootprintAreaSqM: number;
  buildingFootprintAreaSqM: number;
  totalFloorFootprintAreaSqM: number;
  totalSiteGrossAreaSqM: number;
  totalBuiltUpAreaSqM: number;
  validFloorBuiltUpAreaSqM: number;
  totalExcludedOpenAreaSqM: number;
  orphanedRoomAreaSqM: number;
  actualGeometrySpanXM: number;
  actualGeometrySpanYM: number;
  totalElectricalItems: number;
  branchLoadPointsCount: number;
  distributionEquipmentCount: number;
  totalConnectedLoadWatts: number;
  totalConnectedLoadKw: number;
  estimatedCurrentAmps: number;
  floorRows: FloorSummaryRow[];
  orphanedFloorRow: FloorSummaryRow | null;
  circuitRows: ReconciledCircuitRow[];
  componentRows: ReconciledComponentRow[];
  totalWires: number;
  interFloorWireCount: number;
  totalWireLengthM: number;
  wireLengthByCategory: Record<WireCategory, number>;
  dbPoints: ElectricalPoint[];
  earthingPoints: ElectricalPoint[];
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
}

export interface BuildingElectricalSummary {
  buildingType: BuildingType;
  buildingTypeLabel: string;
  floorCount: number;
  totalBuiltUpAreaSqM: number;
  totalPoints: number;
  totalWires: number;
  interFloorWireCount: number;
  activeCircuitCount: number;
  totalWireLengthM: number;
  wireLengthByCategory: Record<WireCategory, number>;
  floorRows: FloorSummaryRow[];
  issues: ValidationIssue[];
}

const STANDARD_CIRCUITS: CircuitId[] = [
  'CKT-L1 (Lighting)',
  'CKT-L2 (Bedrooms)',
  'CKT-P1 (Kitchen)',
  'CKT-P2 (Power 16A)',
];

/**
 * Single authoritative engineering reconciliation engine used by PDF Drawing Export,
 * Excel BOQ Export, and Diagnostics so every table and cover metric reconciles 100%.
 *
 * Definitions:
 * - Total Electrical Items = Branch Load Points + Distribution Equipment (DB + Earthing)
 * - Sum of Floor Schedule pointCount (+ Orphaned Floor row if any) === Total Electrical Items
 * - Sum of Circuit Schedule pointCount (including Distribution & Unassigned rows) === Total Electrical Items
 * - Sum of Component Summary quantity === Total Electrical Items
 * - Sum of loadWatts across Floors, Circuits, and Components === Total Connected Load (W)
 */
export function computeReconciledElectricalSchedule(
  project: ProjectData
): ReconciledElectricalSchedule {
  const { lengthM, widthM } = siteToMeters(project.site);
  const floors = getProjectFloors(project);
  const floorNums = new Set(floors.map((f) => f.floor));
  const wires = project.wires ?? [];

  const wireLengthByCategory: Record<WireCategory, number> = {
    phase: 0,
    neutral: 0,
    earth: 0,
    control: 0,
    communication: 0,
  };

  const wireLengthMap = new Map<string, number>();
  let totalWireLengthM = 0;
  let interFloorWireCount = 0;

  wires.forEach((w) => {
    const len = computeWireLengthMeters(w, project);
    wireLengthMap.set(w.id, len);
    wireLengthByCategory[w.category] += len;
    totalWireLengthM += len;
    if (w.isInterFloor || w.fromFloor !== w.toFloor) interFloorWireCount += 1;
  });

  (Object.keys(wireLengthByCategory) as WireCategory[]).forEach((k) => {
    wireLengthByCategory[k] = Number(wireLengthByCategory[k].toFixed(2));
  });

  const isDistEquip = (p: ElectricalPoint) =>
    p.itemType === 'distribution_board' || p.itemType === 'earthing_point';

  const dbPoints = project.points.filter((p) => p.itemType === 'distribution_board');
  const earthingPoints = project.points.filter((p) => p.itemType === 'earthing_point');
  const branchPoints = project.points.filter((p) => !isDistEquip(p));

  const floorRows: FloorSummaryRow[] = floors.map((fc) => {
    const flBounds = getFloorBoundaryMeters(project, fc.floor);
    const flRooms = project.rooms.filter((r) => getItemFloor(r) === fc.floor);
    const flPoints = project.points.filter((p) => getItemFloor(p) === fc.floor);
    const flDist = flPoints.filter(isDistEquip).length;
    const flWires = wires.filter((w) => w.floor === fc.floor);
    const flWireLen = flWires.reduce((s, w) => s + (wireLengthMap.get(w.id) ?? 0), 0);
    const builtUpAreaSqM = Number(flRooms.reduce((s, r) => s + r.width * r.height, 0).toFixed(2));
    // Staircase slab cutouts arriving at this upper floor (excluding ground floor base)
    const stairVoidAreaSqM = Number(
      (project.staircases ?? [])
        .filter((st) => st.toFloor === fc.floor && st.fromFloor !== fc.floor)
        .reduce((s, st) => {
          const fp = computeStaircaseFootprint(st);
          return s + fp.footprintW * fp.footprintD;
        }, 0)
        .toFixed(2)
    );
    const excludedOpenAreaSqM = Number(Math.max(0, flBounds.areaSqM - builtUpAreaSqM).toFixed(2));
    const overflowAreaSqM = Number(Math.max(0, builtUpAreaSqM - flBounds.areaSqM).toFixed(2));

    return {
      floor: fc.floor,
      name: fc.name,
      kind: fc.kind,
      elevationM: fc.elevationM,
      floorHeightM: fc.floorHeightM,
      slabThicknessM: fc.slabThicknessM,
      floorLengthM: flBounds.lengthM,
      floorWidthM: flBounds.widthM,
      isCustomBoundary: flBounds.isCustom,
      floorFootprintAreaSqM: flBounds.areaSqM,
      roomCount: flRooms.length,
      builtUpAreaSqM,
      stairVoidAreaSqM,
      excludedOpenAreaSqM,
      overflowAreaSqM,
      pointCount: flPoints.length,
      branchPointCount: flPoints.length - flDist,
      distributionCount: flDist,
      wireCount: flWires.length,
      routedLengthM: Number(flWireLen.toFixed(2)),
      loadWatts: flPoints.reduce((s, p) => s + p.wattage, 0),
    };
  });

  // Explicitly capture any orphaned-floor elements so Floor Schedule NEVER silently drops them
  const orphanedRooms = project.rooms.filter((r) => !floorNums.has(getItemFloor(r)));
  const orphanedPoints = project.points.filter((p) => !floorNums.has(getItemFloor(p)));
  const orphanedWires = wires.filter((w) => !floorNums.has(w.floor));
  const orphanedRoomAreaSqM = Number(
    orphanedRooms.reduce((s, r) => s + r.width * r.height, 0).toFixed(2)
  );
  const orphanedFloorRow: FloorSummaryRow | null =
    orphanedRooms.length > 0 || orphanedPoints.length > 0 || orphanedWires.length > 0
      ? {
          floor: -999,
          name: 'Unconfigured Floor (Error)',
          kind: 'upper',
          elevationM: 0,
          floorHeightM: 0,
          slabThicknessM: 0,
          floorLengthM: 0,
          floorWidthM: 0,
          isCustomBoundary: false,
          floorFootprintAreaSqM: 0,
          roomCount: orphanedRooms.length,
          builtUpAreaSqM: orphanedRoomAreaSqM,
          stairVoidAreaSqM: 0,
          excludedOpenAreaSqM: 0,
          overflowAreaSqM: orphanedRoomAreaSqM,
          pointCount: orphanedPoints.length,
          branchPointCount: orphanedPoints.filter((p) => !isDistEquip(p)).length,
          distributionCount: orphanedPoints.filter(isDistEquip).length,
          wireCount: orphanedWires.length,
          routedLengthM: Number(
            orphanedWires.reduce((s, w) => s + (wireLengthMap.get(w.id) ?? 0), 0).toFixed(2)
          ),
          loadWatts: orphanedPoints.reduce((s, p) => s + p.wattage, 0),
          isOrphaned: true,
        }
      : null;

  // Build reconciled Circuit Schedule rows (branch circuits + unassigned + distribution equipment)
  const circuitOrder: string[] = [...STANDARD_CIRCUITS];
  branchPoints.forEach((p) => {
    if (p.circuit && !circuitOrder.includes(p.circuit)) {
      circuitOrder.push(p.circuit);
    }
  });

  const circuitRows: ReconciledCircuitRow[] = [];
  for (const ckt of circuitOrder) {
    const pts = branchPoints.filter((p) => p.circuit === ckt);
    const cktWires = wires.filter((w) => w.circuit === ckt);
    const routedLen = Number(
      cktWires.reduce((s, w) => s + (wireLengthMap.get(w.id) ?? 0), 0).toFixed(2)
    );
    const watts = pts.reduce((s, p) => s + p.wattage, 0);
    const cfg = project.circuitCableConfigs?.[ckt as CircuitId];
    const wireSampleSize = cktWires.find((w) => w.cableSizeSqMm && w.cableSizeSqMm > 0)?.cableSizeSqMm ?? null;
    const effectiveSize = cfg?.cableSizeSqMm ?? wireSampleSize;
    const range = getCircuitCableRange(ckt as CircuitId);
    const check = validateCableSizeForCircuit(ckt as CircuitId, effectiveSize);
    const statusNote =
      pts.length === 0
        ? 'Spare / No load'
        : check.status === 'out-of-range'
          ? 'Verify size'
          : check.status === 'unset'
            ? 'Size unset'
            : cktWires.length === 0
              ? 'Not routed'
              : 'OK';

    circuitRows.push({
      circuit: ckt,
      kind: getCircuitKind(ckt as CircuitId),
      pointCount: pts.length,
      loadWatts: watts,
      loadKw: Number((watts / 1000).toFixed(2)),
      currentAmps: Number((watts / 230).toFixed(1)),
      cableSizeSqMm: effectiveSize,
      cableMaterial: cfg?.cableMaterial ?? 'Copper',
      routedWireCount: cktWires.length,
      routedLengthM: routedLen,
      rangeLabel: `${range.minSqMm}–${range.maxSqMm} mm²`,
      statusNote,
    });
  }

  // Unassigned branch points (if any exist without circuit)
  const unassignedBranch = branchPoints.filter((p) => !p.circuit);
  const unassignedWires = wires.filter((w) => !w.circuit);
  if (unassignedBranch.length > 0 || unassignedWires.length > 0) {
    const watts = unassignedBranch.reduce((s, p) => s + p.wattage, 0);
    const routedLen = Number(
      unassignedWires.reduce((s, w) => s + (wireLengthMap.get(w.id) ?? 0), 0).toFixed(2)
    );
    circuitRows.push({
      circuit: 'Unassigned Circuit',
      kind: 'unassigned',
      pointCount: unassignedBranch.length,
      loadWatts: watts,
      loadKw: Number((watts / 1000).toFixed(2)),
      currentAmps: Number((watts / 230).toFixed(1)),
      cableSizeSqMm: null,
      cableMaterial: 'Copper',
      routedWireCount: unassignedWires.length,
      routedLengthM: routedLen,
      rangeLabel: 'Assign circuit',
      statusNote: 'Action req.',
    });
  }

  // Distribution & Earthing Equipment row (always reconciled explicitly so sum(circuitRows) === totalElectricalItems)
  const distPoints = [...dbPoints, ...earthingPoints];
  if (distPoints.length > 0) {
    const distWatts = distPoints.reduce((s, p) => s + p.wattage, 0);
    circuitRows.push({
      circuit: 'Distribution & Earthing (DB / EP)',
      kind: 'distribution',
      pointCount: distPoints.length,
      loadWatts: distWatts,
      loadKw: Number((distWatts / 1000).toFixed(2)),
      currentAmps: Number((distWatts / 230).toFixed(1)),
      cableSizeSqMm: earthingPoints[0]?.earthingConfig?.earthConductorSizeSqMm ?? null,
      cableMaterial: 'Copper',
      routedWireCount: 0,
      routedLengthM: 0,
      rangeLabel: 'Main / PE',
      statusNote: dbPoints.length > 0 && earthingPoints.length > 0 ? 'DB + PE Ready' : 'Incomplete',
    });
  }

  // Reconciled component summary grouped by itemType
  const compMap = new Map<string, ReconciledComponentRow>();
  project.points.forEach((pt) => {
    const existing = compMap.get(pt.itemType);
    if (existing) {
      existing.quantity += 1;
      existing.totalWattage += pt.wattage;
      existing.estimatedCost += pt.unitCost;
    } else {
      compMap.set(pt.itemType, {
        itemType: pt.itemType,
        name: pt.name.split('—')[0].trim() || pt.itemType,
        category: pt.category,
        quantity: 1,
        totalWattage: pt.wattage,
        estimatedCost: pt.unitCost,
      });
    }
  });
  const componentRows = Array.from(compMap.values());

  const totalConnectedLoadWatts = project.points.reduce((s, p) => s + p.wattage, 0);
  const validFloorBuiltUpAreaSqM = Number(
    floorRows.reduce((s, r) => s + r.builtUpAreaSqM, 0).toFixed(2)
  );
  const totalBuiltUpAreaSqM = Number((validFloorBuiltUpAreaSqM + orphanedRoomAreaSqM).toFixed(2));
  const siteFootprintAreaSqM = Number((lengthM * widthM).toFixed(2));
  const totalFloorFootprintAreaSqM = Number(
    floorRows.reduce((s, r) => s + r.floorFootprintAreaSqM, 0).toFixed(2)
  );
  const groundRow = floorRows.find((r) => r.kind === 'ground' || r.floor === 1) ?? floorRows[0];
  const buildingFootprintAreaSqM = Number(
    (groundRow?.floorFootprintAreaSqM ?? siteFootprintAreaSqM).toFixed(2)
  );
  const totalExcludedOpenAreaSqM = Number(
    floorRows.reduce((s, r) => s + r.excludedOpenAreaSqM, 0).toFixed(2)
  );
  const totalSiteGrossAreaSqM = totalFloorFootprintAreaSqM;
  const geomBounds = computeActualGeometryBounds(project);

  const issues = validateBuildingAndElectrical(project);
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const infoCount = issues.filter((i) => i.severity === 'info').length;

  return {
    siteLengthM: Number(lengthM.toFixed(3)),
    siteWidthM: Number(widthM.toFixed(3)),
    siteFootprintAreaSqM,
    buildingFootprintAreaSqM,
    totalFloorFootprintAreaSqM,
    totalSiteGrossAreaSqM,
    totalBuiltUpAreaSqM,
    validFloorBuiltUpAreaSqM,
    totalExcludedOpenAreaSqM,
    orphanedRoomAreaSqM,
    actualGeometrySpanXM: geomBounds.spanXM,
    actualGeometrySpanYM: geomBounds.spanYM,
    totalElectricalItems: project.points.length,
    branchLoadPointsCount: branchPoints.length,
    distributionEquipmentCount: distPoints.length,
    totalConnectedLoadWatts,
    totalConnectedLoadKw: Number((totalConnectedLoadWatts / 1000).toFixed(2)),
    estimatedCurrentAmps: Number((totalConnectedLoadWatts / 230).toFixed(1)),
    floorRows,
    orphanedFloorRow,
    circuitRows,
    componentRows,
    totalWires: wires.length,
    interFloorWireCount,
    totalWireLengthM: Number(totalWireLengthM.toFixed(2)),
    wireLengthByCategory,
    dbPoints,
    earthingPoints,
    issues,
    errorCount,
    warningCount,
    infoCount,
  };
}

export function computeBuildingElectricalSummary(project: ProjectData): BuildingElectricalSummary {
  const reconciled = computeReconciledElectricalSchedule(project);
  const buildingType = inferBuildingType(project);
  const activeCircuitCount = reconciled.circuitRows.filter(
    (c) => (c.kind === 'lighting' || c.kind === 'power') && (c.pointCount > 0 || c.routedWireCount > 0)
  ).length;

  return {
    buildingType,
    buildingTypeLabel: BUILDING_TYPE_LABELS[buildingType],
    floorCount: reconciled.floorRows.length,
    totalBuiltUpAreaSqM: reconciled.totalBuiltUpAreaSqM,
    totalPoints: reconciled.totalElectricalItems,
    totalWires: reconciled.totalWires,
    interFloorWireCount: reconciled.interFloorWireCount,
    activeCircuitCount,
    totalWireLengthM: reconciled.totalWireLengthM,
    wireLengthByCategory: reconciled.wireLengthByCategory,
    floorRows: reconciled.orphanedFloorRow
      ? [...reconciled.floorRows, reconciled.orphanedFloorRow]
      : reconciled.floorRows,
    issues: reconciled.issues,
  };
}

// ============================================================
// AUTHORITATIVE RECONCILED ELECTRICAL BOQ ENGINE (PDF + EXCEL)
// ============================================================

export type BoqPriceSource = 'catalogue' | 'project' | 'override' | 'missing';

export interface ReconciledBoqRow {
  kind: 'component' | 'cable' | 'manual';
  productCategory: string;
  manufacturer: string;
  brand: string;
  productName: string;
  model: string;
  specification: string;
  ratedLoadW: number;
  totalLoadW: number;
  circuits: string;
  cableSize: string;
  unit: string;
  quantity: number;
  unitPrice: number | null;
  priceSource: BoqPriceSource;
  gstPercent: number | null;
  subtotal: number | null;
  gstAmount: number | null;
  total: number | null;
  notes: string;
}

export interface ReconciledBoqCategorySubtotal {
  category: string;
  itemLines: number;
  totalQty: number;
  unit: string;
  totalLoadW: number;
  subtotal: number;
  gstAmount: number;
  total: number;
  unpricedLines: number;
}

export interface ReconciledFloorBoq {
  floor: number;
  floorName: string;
  elevationM: number;
  isOrphaned?: boolean;
  rows: ReconciledBoqRow[];
  componentQty: number;
  cableLengthM: number;
  loadWatts: number;
  subtotalConfigured: number;
  gstConfigured: number;
  grandTotalConfigured: number;
  unpricedRowCount: number;
}

export interface ReconciledBoqResult {
  allowancePercent: number;
  rows: ReconciledBoqRow[];
  categorySubtotals: ReconciledBoqCategorySubtotal[];
  floorBoqs: ReconciledFloorBoq[];
  orphanedFloorBoq: ReconciledFloorBoq | null;
  totalComponentQty: number;
  totalCableLengthM: number;
  totalLoadWatts: number;
  subtotalConfigured: number;
  totalGstConfigured: number;
  grandTotalConfigured: number;
  unpricedRowCount: number;
  overrideRowCount: number;
}

function resolveBoqPointRate(pt: ElectricalPoint): {
  price: number | null;
  source: BoqPriceSource;
  note: string;
} {
  if (typeof pt.manualPriceOverride === 'number' && Number.isFinite(pt.manualPriceOverride) && pt.manualPriceOverride >= 0) {
    return {
      price: Number(pt.manualPriceOverride.toFixed(2)),
      source: 'override',
      note: 'Manual override',
    };
  }
  if (typeof pt.unitCost === 'number' && Number.isFinite(pt.unitCost) && pt.unitCost > 0) {
    return {
      price: Number(pt.unitCost.toFixed(2)),
      source: pt.productId ? 'catalogue' : 'project',
      note: pt.productId ? 'Linked product catalogue' : 'Project rate',
    };
  }
  return {
    price: null,
    source: 'missing',
    note: 'Rate not configured — enter verified supplier rate',
  };
}

function resolveBoqPointSpec(pt: ElectricalPoint): string {
  if (pt.specification) return pt.specification;
  if (pt.itemType === 'distribution_board' && pt.dbConfig) {
    return `${pt.dbConfig.phaseType}, ${pt.dbConfig.incomingRatingAmps}A Incomer, ${pt.dbConfig.waysCount} Ways, ${pt.dbConfig.rccbSensitivityMa}mA RCCB`;
  }
  if (pt.itemType === 'earthing_point' && pt.earthingConfig) {
    return `${pt.earthingConfig.earthingType}, Target <= ${pt.earthingConfig.targetResistanceOhm} Ohm, ${pt.earthingConfig.earthConductorSizeSqMm} sq.mm Earth Conductor`;
  }
  return `${pt.wattage}W · ${pt.voltage}V · ${pt.circuit || 'Unassigned Circuit'}`;
}

function buildBoqRowsForSubset(
  points: ElectricalPoint[],
  wires: ElectricalWire[],
  project: ProjectData,
  allowancePct: number
): ReconciledBoqRow[] {
  const grouped = new Map<string, ReconciledBoqRow & { circuitSet: Set<string> }>();

  points.forEach((pt) => {
    const { price, source, note } = resolveBoqPointRate(pt);
    const catMeta = CATALOG_MAP[pt.itemType];
    const category = catMeta ? catMeta.boqCategory : pt.category;
    const manufacturer = pt.manufacturer?.trim() || 'Not specified';
    const brand = pt.brand?.trim() || (pt.manufacturer?.trim() ? pt.manufacturer.trim() : 'Not specified');
    const productName = pt.productId ? pt.name : catMeta?.productName ?? pt.name;
    const model = pt.modelNumber?.trim() || 'Not specified';
    const spec = resolveBoqPointSpec(pt);
    const gstPct =
      typeof pt.gstPercent === 'number' && Number.isFinite(pt.gstPercent) && pt.gstPercent >= 0
        ? pt.gstPercent
        : null;
    const circuitLabel =
      pt.itemType === 'distribution_board' || pt.itemType === 'earthing_point'
        ? 'Main Distribution / PE'
        : pt.circuit || 'Unassigned';

    const key = [
      category,
      manufacturer,
      model,
      productName,
      pt.wattage,
      price ?? 'NA',
      source,
      gstPct ?? 'NA',
    ].join('||');

    const existing = grouped.get(key);
    if (existing) {
      existing.quantity += 1;
      existing.totalLoadW += pt.wattage;
      existing.circuitSet.add(circuitLabel);
      existing.circuits = Array.from(existing.circuitSet).join(', ');
      if (existing.unitPrice !== null) {
        const sub = Number((existing.unitPrice * existing.quantity).toFixed(2));
        existing.subtotal = sub;
        existing.gstAmount =
          existing.gstPercent !== null ? Number(((sub * existing.gstPercent) / 100).toFixed(2)) : null;
        existing.total = Number((sub + (existing.gstAmount ?? 0)).toFixed(2));
      }
    } else {
      const sub = price !== null ? Number(price.toFixed(2)) : null;
      const gstAmt = sub !== null && gstPct !== null ? Number(((sub * gstPct) / 100).toFixed(2)) : null;
      const total = sub !== null ? Number((sub + (gstAmt ?? 0)).toFixed(2)) : null;
      const circuitSet = new Set<string>([circuitLabel]);
      grouped.set(key, {
        kind: 'component',
        productCategory: category,
        manufacturer,
        brand,
        productName,
        model,
        specification: spec,
        ratedLoadW: pt.wattage,
        totalLoadW: pt.wattage,
        circuits: circuitLabel,
        cableSize: '—',
        unit: 'Nos',
        quantity: 1,
        unitPrice: price,
        priceSource: source,
        gstPercent: gstPct,
        subtotal: sub,
        gstAmount: gstAmt,
        total,
        notes: note,
        circuitSet,
      });
    }
  });

  // Group routed cables strictly from actual computed wire lengths (> 0m only when valid routes exist)
  const wireGroups = new Map<
    string,
    {
      manufacturer: string;
      brand: string;
      productName: string;
      model: string;
      spec: string;
      cableSize: string;
      circuitSet: Set<string>;
      rawLengthM: number;
      unitPrice: number | null;
      gstPercent: number | null;
    }
  >();

  wires.forEach((w) => {
    const lenM = computeWireLengthMeters(w, project);
    if (lenM <= 0) return;
    const sizeLabel = w.cableSizeSqMm !== null && w.cableSizeSqMm > 0 ? `${w.cableSizeSqMm} sq.mm` : 'Not specified';
    const manufacturer = w.manufacturer?.trim() || 'Not specified';
    const brand = w.brand?.trim() || (w.manufacturer?.trim() ? w.manufacturer.trim() : 'Not specified');
    const productName = `${WIRE_CATEGORY_LABELS[w.category]} — ${w.wireType}`;
    const model = w.modelNumber?.trim() || 'Not specified';
    const spec = `${w.cableMaterial}, ${w.cores}C, ${w.phaseDesignation}`;
    const unitPrice =
      typeof w.unitPricePerM === 'number' && Number.isFinite(w.unitPricePerM) && w.unitPricePerM > 0
        ? Number(w.unitPricePerM.toFixed(2))
        : null;
    const gstPercent =
      typeof w.gstPercent === 'number' && Number.isFinite(w.gstPercent) && w.gstPercent >= 0
        ? w.gstPercent
        : null;
    const cktName = w.circuit || 'Unassigned';

    const key = [manufacturer, model, sizeLabel, w.category, w.cableMaterial, unitPrice ?? 'NA', gstPercent ?? 'NA'].join('||');
    const ex = wireGroups.get(key);
    if (ex) {
      ex.rawLengthM += lenM;
      ex.circuitSet.add(cktName);
    } else {
      wireGroups.set(key, {
        manufacturer,
        brand,
        productName,
        model,
        spec,
        cableSize: sizeLabel,
        circuitSet: new Set([cktName]),
        rawLengthM: lenM,
        unitPrice,
        gstPercent,
      });
    }
  });

  const rows: ReconciledBoqRow[] = Array.from(grouped.values()).map(({ circuitSet: _cs, ...rest }) => rest);

  wireGroups.forEach((wg) => {
    const rawM = Number(wg.rawLengthM.toFixed(2));
    const qtyM = Number((rawM * (1 + allowancePct / 100)).toFixed(2));
    const sub = wg.unitPrice !== null ? Number((wg.unitPrice * qtyM).toFixed(2)) : null;
    const gstAmt = sub !== null && wg.gstPercent !== null ? Number(((sub * wg.gstPercent) / 100).toFixed(2)) : null;
    const total = sub !== null ? Number((sub + (gstAmt ?? 0)).toFixed(2)) : null;
    const priceSource: BoqPriceSource = wg.unitPrice !== null ? (wg.manufacturer !== 'Not specified' ? 'catalogue' : 'project') : 'missing';

    rows.push({
      kind: 'cable',
      productCategory: 'Cables & Wires',
      manufacturer: wg.manufacturer,
      brand: wg.brand,
      productName: wg.productName,
      model: wg.model,
      specification: wg.spec,
      ratedLoadW: 0,
      totalLoadW: 0,
      circuits: Array.from(wg.circuitSet).join(', '),
      cableSize: wg.cableSize,
      unit: 'm',
      quantity: qtyM,
      unitPrice: wg.unitPrice,
      priceSource,
      gstPercent: wg.gstPercent,
      subtotal: sub,
      gstAmount: gstAmt,
      total,
      notes:
        wg.unitPrice === null
          ? `Routed ${rawM.toFixed(2)}m${allowancePct > 0 ? ` (+${allowancePct}% allowance)` : ''} · Rate not configured`
          : allowancePct > 0
            ? `Routed ${rawM.toFixed(2)}m + ${allowancePct}% procurement allowance`
            : `Calculated from routed wire geometry (${rawM.toFixed(2)}m)`,
    });
  });

  return rows;
}

/**
 * Single authoritative BOQ reconciliation engine shared by Excel BOQ Export (all sheets)
 * and PDF Summary & BOQ Sheet (S-01).
 * Guarantees 100% reconciliation of quantities, loads, cable lengths, unit rates, GST,
 * floor-wise subtotals, and consolidated grand totals — never inventing missing prices.
 */
export function computeReconciledBoq(
  project: ProjectData,
  options: { cableAllowancePercent?: number } = {}
): ReconciledBoqResult {
  const allowancePercent = Math.max(0, Math.min(30, options.cableAllowancePercent ?? 0));
  const floors = getProjectFloors(project);
  const floorNums = new Set(floors.map((f) => f.floor));
  const wires = project.wires ?? [];

  const rows = buildBoqRowsForSubset(project.points, wires, project, allowancePercent);

  // Include explicit user-added custom BOQ rows from Project Summary if present
  (project.summaryOverrides?.addedBoqRows ?? []).forEach((row) => {
    const unitRate =
      row.quantity > 0 && row.estimatedCost > 0
        ? Number((row.estimatedCost / row.quantity).toFixed(2))
        : null;
    const sub = row.estimatedCost > 0 ? Number(row.estimatedCost.toFixed(2)) : null;
    rows.push({
      kind: 'manual',
      productCategory: row.category || 'Custom',
      manufacturer: 'Manual Entry',
      brand: 'Manual Entry',
      productName: row.productName,
      model: 'Not specified',
      specification: row.totalWattage > 0 ? `${row.totalWattage}W total` : 'User-added BOQ row',
      ratedLoadW: row.quantity > 0 ? Math.round(row.totalWattage / row.quantity) : 0,
      totalLoadW: row.totalWattage,
      circuits: 'Manual',
      cableSize: '—',
      unit: 'Nos',
      quantity: row.quantity,
      unitPrice: unitRate,
      priceSource: unitRate !== null ? 'override' : 'missing',
      gstPercent: null,
      subtotal: sub,
      gstAmount: null,
      total: sub,
      notes: 'Manual override row',
    });
  });

  // Category subtotals
  const catMap = new Map<string, ReconciledBoqCategorySubtotal>();
  rows.forEach((r) => {
    const prev = catMap.get(r.productCategory) ?? {
      category: r.productCategory,
      itemLines: 0,
      totalQty: 0,
      unit: r.unit,
      totalLoadW: 0,
      subtotal: 0,
      gstAmount: 0,
      total: 0,
      unpricedLines: 0,
    };
    prev.itemLines += 1;
    prev.totalQty = Number((prev.totalQty + r.quantity).toFixed(2));
    prev.totalLoadW += r.totalLoadW;
    if (r.subtotal !== null && r.total !== null) {
      prev.subtotal = Number((prev.subtotal + r.subtotal).toFixed(2));
      prev.gstAmount = Number((prev.gstAmount + (r.gstAmount ?? 0)).toFixed(2));
      prev.total = Number((prev.total + r.total).toFixed(2));
    } else {
      prev.unpricedLines += 1;
    }
    catMap.set(r.productCategory, prev);
  });

  const summarizeSubset = (
    floor: number,
    floorName: string,
    elevationM: number,
    pts: ElectricalPoint[],
    flWires: ElectricalWire[],
    isOrphaned?: boolean
  ): ReconciledFloorBoq => {
    const flRows = buildBoqRowsForSubset(pts, flWires, project, allowancePercent);
    let sub = 0;
    let gst = 0;
    let grand = 0;
    let unpriced = 0;
    let cableM = 0;
    flRows.forEach((r) => {
      if (r.kind === 'cable') cableM += r.quantity;
      if (r.subtotal !== null && r.total !== null) {
        sub += r.subtotal;
        gst += r.gstAmount ?? 0;
        grand += r.total;
      } else {
        unpriced += 1;
      }
    });
    return {
      floor,
      floorName,
      elevationM,
      isOrphaned,
      rows: flRows,
      componentQty: pts.length,
      cableLengthM: Number(cableM.toFixed(2)),
      loadWatts: pts.reduce((s, p) => s + p.wattage, 0),
      subtotalConfigured: Number(sub.toFixed(2)),
      gstConfigured: Number(gst.toFixed(2)),
      grandTotalConfigured: Number(grand.toFixed(2)),
      unpricedRowCount: unpriced,
    };
  };

  const floorBoqs: ReconciledFloorBoq[] = floors.map((fc) =>
    summarizeSubset(
      fc.floor,
      fc.name,
      fc.elevationM,
      project.points.filter((p) => getItemFloor(p) === fc.floor),
      wires.filter((w) => w.floor === fc.floor)
    )
  );

  const orphanPts = project.points.filter((p) => !floorNums.has(getItemFloor(p)));
  const orphanWires = wires.filter((w) => !floorNums.has(w.floor));
  const orphanedFloorBoq =
    orphanPts.length > 0 || orphanWires.length > 0
      ? summarizeSubset(-999, 'Unconfigured Floor (Error)', 0, orphanPts, orphanWires, true)
      : null;

  let subtotalConfigured = 0;
  let totalGstConfigured = 0;
  let grandTotalConfigured = 0;
  let unpricedRowCount = 0;
  let overrideRowCount = 0;
  let totalComponentQty = 0;
  let totalCableLengthM = 0;
  let totalLoadWatts = 0;

  rows.forEach((r) => {
    if (r.kind === 'component') totalComponentQty += r.quantity;
    if (r.kind === 'cable') totalCableLengthM += r.quantity;
    totalLoadWatts += r.totalLoadW;
    if (r.priceSource === 'override') overrideRowCount += 1;
    if (r.subtotal !== null && r.total !== null) {
      subtotalConfigured += r.subtotal;
      totalGstConfigured += r.gstAmount ?? 0;
      grandTotalConfigured += r.total;
    } else {
      unpricedRowCount += 1;
    }
  });

  return {
    allowancePercent,
    rows,
    categorySubtotals: Array.from(catMap.values()),
    floorBoqs,
    orphanedFloorBoq,
    totalComponentQty,
    totalCableLengthM: Number(totalCableLengthM.toFixed(2)),
    totalLoadWatts,
    subtotalConfigured: Number(subtotalConfigured.toFixed(2)),
    totalGstConfigured: Number(totalGstConfigured.toFixed(2)),
    grandTotalConfigured: Number(grandTotalConfigured.toFixed(2)),
    unpricedRowCount,
    overrideRowCount,
  };
}
