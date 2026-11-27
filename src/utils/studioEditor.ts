import {
  CATALOG_MAP,
  ELECTRICAL_CATALOG,
  findRoomAtPoint,
  ROOM_LIBRARY,
  siteToMeters,
} from '../data/presets';
import { ProductCatalogueItem } from '../types/catalogue';
import {
  ArchitecturalOpening,
  CableMaterial,
  CircuitCableConfig,
  CircuitId,
  CustomWall,
  ElectricalItemType,
  ElectricalPoint,
  ElectricalWire,
  FloorLevelConfig,
  FurnitureItem,
  ProjectData,
  RoomType,
  RoomZone,
  StaircaseItem,
  StudioEntityRef,
} from '../types/design';
import {
  buildCircuitCableWireFields,
  getFloorLabel,
  getNextWireSequence,
  getProjectFloors,
} from './buildingWiring';
import { formatFloorLabel, getItemFloor, sliceProjectForFloor } from './geometry';
import { sanitizeSafeUrl } from './urlSecurity';

export const MAX_HISTORY_ENTRIES = 100;

export interface EditorHistoryState {
  past: ProjectData[];
  present: ProjectData;
  future: ProjectData[];
}

export interface FurnitureCatalogItem {
  kind: FurnitureItem['kind'];
  label: string;
  defaultWidth: number;
  defaultDepth: number;
  icon: string;
}

export const FURNITURE_CATALOG: FurnitureCatalogItem[] = [
  { kind: 'sofa', label: 'Sofa & Coffee Table', defaultWidth: 2.2, defaultDepth: 1.5, icon: 'weekend' },
  { kind: 'bed', label: 'Queen / King Bed', defaultWidth: 2.0, defaultDepth: 2.1, icon: 'bed' },
  { kind: 'dining-table', label: 'Dining Table Set', defaultWidth: 1.6, defaultDepth: 1.2, icon: 'table_restaurant' },
  { kind: 'kitchen-counter', label: 'Kitchen Counter', defaultWidth: 0.85, defaultDepth: 3.0, icon: 'countertops' },
  { kind: 'vanity', label: 'Bathroom Vanity', defaultWidth: 1.2, defaultDepth: 0.6, icon: 'bathroom' },
  { kind: 'tv-unit', label: 'TV Console Unit', defaultWidth: 0.5, defaultDepth: 2.0, icon: 'tv' },
  { kind: 'desk', label: 'Study / Office Desk', defaultWidth: 1.4, defaultDepth: 0.7, icon: 'desk' },
];

export const FURNITURE_MAP: Record<FurnitureItem['kind'], FurnitureCatalogItem> =
  FURNITURE_CATALOG.reduce((acc, item) => {
    acc[item.kind] = item;
    return acc;
  }, {} as Record<FurnitureItem['kind'], FurnitureCatalogItem>);

export type FindCategoryFilter =
  | 'all'
  | 'electrical'
  | 'lighting'
  | 'fans'
  | 'switches'
  | 'sockets'
  | 'appliances'
  | 'furniture'
  | 'rooms';

export interface StudioSearchResult {
  key: string;
  source: 'placed' | 'library';
  entity?: StudioEntityRef;
  libraryKind?: 'electrical' | 'room' | 'furniture';
  electricalType?: ElectricalItemType;
  roomType?: RoomType;
  furnitureKind?: FurnitureItem['kind'];
  title: string;
  subtitle: string;
  badge: string;
  category: string;
  icon: string;
  floor?: number;
  x?: number;
  y?: number;
  z?: number;
}

export interface StudioClipboard {
  points: ElectricalPoint[];
  rooms: RoomZone[];
  customWalls: CustomWall[];
  openings: ArchitecturalOpening[];
  furniture: FurnitureItem[];
  staircases?: StaircaseItem[];
  sourceFloor: number;
}

export type StudioShortcutAction =
  | 'find'
  | 'undo'
  | 'redo'
  | 'copy'
  | 'paste'
  | 'duplicate'
  | 'delete'
  | 'select-all'
  | 'save'
  | 'escape';

// --- Deep Clone & Deterministic History Stack ---

export function cloneProject(project: ProjectData): ProjectData {
  return JSON.parse(JSON.stringify(project)) as ProjectData;
}

export function createHistoryState(initial: ProjectData): EditorHistoryState {
  return {
    past: [],
    present: cloneProject(initial),
    future: [],
  };
}

export function pushHistorySnapshot(
  history: EditorHistoryState,
  nextProject: ProjectData,
  maxEntries = MAX_HISTORY_ENTRIES
): EditorHistoryState {
  const nextPast = [...history.past, cloneProject(history.present)].slice(-maxEntries);
  return {
    past: nextPast,
    present: cloneProject(nextProject),
    future: [],
  };
}

export function undoHistoryState(history: EditorHistoryState): EditorHistoryState {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present: cloneProject(previous),
    future: [...history.future, cloneProject(history.present)],
  };
}

export function redoHistoryState(history: EditorHistoryState): EditorHistoryState {
  if (history.future.length === 0) return history;
  const next = history.future[history.future.length - 1];
  return {
    past: [...history.past, cloneProject(history.present)].slice(-MAX_HISTORY_ENTRIES),
    present: cloneProject(next),
    future: history.future.slice(0, -1),
  };
}

// --- Selection Helpers ---

export function isSameEntity(a: StudioEntityRef | null | undefined, b: StudioEntityRef | null | undefined): boolean {
  if (!a || !b) return false;
  return a.kind === b.kind && a.id === b.id;
}

export function toggleEntityInSelection(
  current: StudioEntityRef[],
  target: StudioEntityRef,
  additive: boolean
): StudioEntityRef[] {
  if (!additive) {
    return [target];
  }
  const exists = current.some((item) => isSameEntity(item, target));
  if (exists) {
    return current.filter((item) => !isSameEntity(item, target));
  }
  return [...current, target];
}

export function selectAllEntitiesOnFloor(project: ProjectData, activeFloor: number): StudioEntityRef[] {
  const list: StudioEntityRef[] = [];
  project.rooms.forEach((r) => {
    if (getItemFloor(r) === activeFloor) list.push({ kind: 'room', id: r.id });
  });
  project.customWalls.forEach((w) => {
    if (getItemFloor(w) === activeFloor) list.push({ kind: 'wall', id: w.id });
  });
  project.openings.forEach((o) => {
    if (getItemFloor(o) === activeFloor) list.push({ kind: 'opening', id: o.id });
  });
  project.furniture.forEach((f) => {
    if (getItemFloor(f) === activeFloor) list.push({ kind: 'furniture', id: f.id });
  });
  project.points.forEach((p) => {
    if (getItemFloor(p) === activeFloor) list.push({ kind: 'point', id: p.id });
  });
  (project.staircases ?? []).forEach((s) => {
    if (s.fromFloor === activeFloor) list.push({ kind: 'staircase', id: s.id });
  });
  (project.wires ?? []).forEach((w) => {
    if (w.floor === activeFloor) list.push({ kind: 'wire', id: w.id });
  });
  return list;
}

export function pruneSelectionToProject(
  selection: StudioEntityRef[],
  project: ProjectData
): StudioEntityRef[] {
  const roomIds = new Set(project.rooms.map((r) => r.id));
  const wallIds = new Set(project.customWalls.map((w) => w.id));
  const openingIds = new Set(project.openings.map((o) => o.id));
  const furnitureIds = new Set(project.furniture.map((f) => f.id));
  const pointIds = new Set(project.points.map((p) => p.id));
  const staircaseIds = new Set((project.staircases ?? []).map((s) => s.id));
  const wireIds = new Set((project.wires ?? []).map((w) => w.id));

  return selection.filter((ent) => {
    if (ent.kind === 'room') return roomIds.has(ent.id);
    if (ent.kind === 'wall') return wallIds.has(ent.id);
    if (ent.kind === 'opening') return openingIds.has(ent.id);
    if (ent.kind === 'furniture') return furnitureIds.has(ent.id);
    if (ent.kind === 'point') return pointIds.has(ent.id);
    if (ent.kind === 'staircase') return staircaseIds.has(ent.id);
    if (ent.kind === 'wire') return wireIds.has(ent.id);
    return false;
  });
}

export function getEntityFocusPoint(
  project: ProjectData,
  entity: StudioEntityRef
): { x: number; y: number; z?: number; floor: number } | null {
  if (entity.kind === 'point') {
    const pt = project.points.find((p) => p.id === entity.id);
    return pt ? { x: pt.x, y: pt.y, z: pt.z, floor: getItemFloor(pt) } : null;
  }
  if (entity.kind === 'room') {
    const rm = project.rooms.find((r) => r.id === entity.id);
    return rm
      ? { x: rm.x + rm.width / 2, y: rm.y + rm.height / 2, z: 0.8, floor: getItemFloor(rm) }
      : null;
  }
  if (entity.kind === 'furniture') {
    const fn = project.furniture.find((f) => f.id === entity.id);
    return fn ? { x: fn.x, y: fn.y, z: 0.6, floor: getItemFloor(fn) } : null;
  }
  if (entity.kind === 'opening') {
    const op = project.openings.find((o) => o.id === entity.id);
    return op ? { x: op.x, y: op.y, z: 1.2, floor: getItemFloor(op) } : null;
  }
  if (entity.kind === 'wall') {
    const w = project.customWalls.find((cw) => cw.id === entity.id);
    return w
      ? { x: (w.x1 + w.x2) / 2, y: (w.y1 + w.y2) / 2, z: 1.4, floor: getItemFloor(w) }
      : null;
  }
  if (entity.kind === 'staircase') {
    const st = (project.staircases ?? []).find((s) => s.id === entity.id);
    return st ? { x: st.x + st.width / 2, y: st.y + st.width / 2, z: 1.2, floor: st.fromFloor } : null;
  }
  if (entity.kind === 'wire') {
    const wire = (project.wires ?? []).find((w) => w.id === entity.id);
    if (!wire) return null;
    const fromPt = project.points.find((p) => p.id === wire.fromPointId);
    const toPt = project.points.find((p) => p.id === wire.toPointId);
    if (fromPt && toPt) {
      return {
        x: (fromPt.x + toPt.x) / 2,
        y: (fromPt.y + toPt.y) / 2,
        z: Math.max(fromPt.z, toPt.z),
        floor: wire.floor,
      };
    }
    if (fromPt) return { x: fromPt.x, y: fromPt.y, z: fromPt.z, floor: wire.floor };
    if (toPt) return { x: toPt.x, y: toPt.y, z: toPt.z, floor: wire.floor };
    return null;
  }
  return null;
}

// --- Unique ID & Code Generation ---

let uidCounter = 1;

export function generateUniqueEntityId(prefix: string, existingIds: Set<string>): string {
  let candidate = '';
  do {
    uidCounter += 1;
    const rand = Math.random().toString(36).slice(2, 6);
    candidate = `${prefix}-${Date.now().toString(36)}-${uidCounter}-${rand}`;
  } while (existingIds.has(candidate));
  existingIds.add(candidate);
  return candidate;
}

function generateNextPointCode(
  itemType: ElectricalItemType,
  usedCodes: Set<string>
): string {
  const shortCode = CATALOG_MAP[itemType]?.shortCode ?? 'PT';
  let seq = 1;
  while (seq < 10000) {
    const candidate = `${shortCode}-${String(seq).padStart(2, '0')}`;
    if (!usedCodes.has(candidate)) {
      usedCodes.add(candidate);
      return candidate;
    }
    seq += 1;
  }
  const fallback = `${shortCode}-${Date.now().toString().slice(-4)}`;
  usedCodes.add(fallback);
  return fallback;
}

// --- Clipboard: Copy / Paste / Duplicate / Delete / Rotate / Move ---

export function copyEntitiesToClipboard(
  project: ProjectData,
  selection: StudioEntityRef[],
  activeFloor = 1
): StudioClipboard | null {
  if (selection.length === 0) return null;

  const pointIds = new Set(selection.filter((s) => s.kind === 'point').map((s) => s.id));
  const roomIds = new Set(selection.filter((s) => s.kind === 'room').map((s) => s.id));
  const wallIds = new Set(selection.filter((s) => s.kind === 'wall').map((s) => s.id));
  const openingIds = new Set(selection.filter((s) => s.kind === 'opening').map((s) => s.id));
  const furnitureIds = new Set(selection.filter((s) => s.kind === 'furniture').map((s) => s.id));

  const points = project.points
    .filter((p) => pointIds.has(p.id))
    .map((p) => JSON.parse(JSON.stringify(p)) as ElectricalPoint);
  const rooms = project.rooms
    .filter((r) => roomIds.has(r.id))
    .map((r) => JSON.parse(JSON.stringify(r)) as RoomZone);
  const customWalls = project.customWalls
    .filter((w) => wallIds.has(w.id))
    .map((w) => JSON.parse(JSON.stringify(w)) as CustomWall);
  const openings = project.openings
    .filter((o) => openingIds.has(o.id))
    .map((o) => JSON.parse(JSON.stringify(o)) as ArchitecturalOpening);
  const furniture = project.furniture
    .filter((f) => furnitureIds.has(f.id))
    .map((f) => JSON.parse(JSON.stringify(f)) as FurnitureItem);

  const total =
    points.length + rooms.length + customWalls.length + openings.length + furniture.length;
  if (total === 0) return null;

  return {
    points,
    rooms,
    customWalls,
    openings,
    furniture,
    sourceFloor: activeFloor,
  };
}

export function pasteClipboardIntoProject(
  project: ProjectData,
  clipboard: StudioClipboard,
  activeFloor: number,
  pasteStep = 1
): { project: ProjectData; pastedEntities: StudioEntityRef[] } {
  const { lengthM, widthM } = siteToMeters(project.site);
  const step = Math.max(1, pasteStep);
  const offsetX = Number((0.6 * step).toFixed(2));
  const offsetY = Number((0.45 * step).toFixed(2));

  const existingIds = new Set<string>([
    ...project.points.map((p) => p.id),
    ...project.rooms.map((r) => r.id),
    ...project.customWalls.map((w) => w.id),
    ...project.openings.map((o) => o.id),
    ...project.furniture.map((f) => f.id),
  ]);
  const usedCodes = new Set<string>(project.points.map((p) => p.code));

  const pastedEntities: StudioEntityRef[] = [];
  const roomIdMap = new Map<string, string>();

  const nextRooms: RoomZone[] = [...project.rooms];
  const floorRoomCounts = new Map<string, number>();
  project.rooms
    .filter((r) => getItemFloor(r) === activeFloor)
    .forEach((r) => {
      floorRoomCounts.set(r.type, (floorRoomCounts.get(r.type) ?? 0) + 1);
    });

  clipboard.rooms.forEach((src) => {
    const newId = generateUniqueEntityId('rm', existingIds);
    roomIdMap.set(src.id, newId);
    const nextCount = (floorRoomCounts.get(src.type) ?? 0) + 1;
    floorRoomCounts.set(src.type, nextCount);
    const baseName = src.name.replace(/\s+\d+$/, '');
    const copy: RoomZone = {
      ...JSON.parse(JSON.stringify(src)),
      id: newId,
      floor: activeFloor,
      name: `${baseName} ${nextCount}`,
      x: Number((src.x + offsetX).toFixed(3)),
      y: Number((src.y + offsetY).toFixed(3)),
    };
    nextRooms.push(copy);
    pastedEntities.push({ kind: 'room', id: newId });
  });

  const activeFloorRooms = nextRooms.filter((r) => getItemFloor(r) === activeFloor);

  const nextWalls: CustomWall[] = [...project.customWalls];
  clipboard.customWalls.forEach((src) => {
    const newId = generateUniqueEntityId('cw', existingIds);
    const copy: CustomWall = {
      ...JSON.parse(JSON.stringify(src)),
      id: newId,
      floor: activeFloor,
      x1: Number((src.x1 + offsetX).toFixed(3)),
      y1: Number((src.y1 + offsetY).toFixed(3)),
      x2: Number((src.x2 + offsetX).toFixed(3)),
      y2: Number((src.y2 + offsetY).toFixed(3)),
    };
    nextWalls.push(copy);
    pastedEntities.push({ kind: 'wall', id: newId });
  });

  const nextOpenings: ArchitecturalOpening[] = [...project.openings];
  clipboard.openings.forEach((src) => {
    const newId = generateUniqueEntityId('op', existingIds);
    const copy: ArchitecturalOpening = {
      ...JSON.parse(JSON.stringify(src)),
      id: newId,
      floor: activeFloor,
      x: Number(Math.min(lengthM, Math.max(0, src.x + offsetX)).toFixed(3)),
      y: Number(Math.min(widthM, Math.max(0, src.y + offsetY)).toFixed(3)),
    };
    nextOpenings.push(copy);
    pastedEntities.push({ kind: 'opening', id: newId });
  });

  const nextFurniture: FurnitureItem[] = [...project.furniture];
  clipboard.furniture.forEach((src) => {
    const newId = generateUniqueEntityId('fn', existingIds);
    const nx = Number(Math.min(lengthM - 0.3, Math.max(0.3, src.x + offsetX)).toFixed(3));
    const ny = Number(Math.min(widthM - 0.3, Math.max(0.3, src.y + offsetY)).toFixed(3));
    const matchedRoom =
      (roomIdMap.get(src.roomId) ? activeFloorRooms.find((r) => r.id === roomIdMap.get(src.roomId)) : undefined) ??
      findRoomAtPoint(activeFloorRooms, nx, ny) ??
      activeFloorRooms.find((r) => r.id === src.roomId) ??
      activeFloorRooms[0];

    const copy: FurnitureItem = {
      ...JSON.parse(JSON.stringify(src)),
      id: newId,
      floor: activeFloor,
      roomId: matchedRoom?.id ?? src.roomId,
      x: nx,
      y: ny,
    };
    nextFurniture.push(copy);
    pastedEntities.push({ kind: 'furniture', id: newId });
  });

  const nextPoints: ElectricalPoint[] = [...project.points];
  const restoredBoqTypes = new Set<ElectricalItemType>();
  clipboard.points.forEach((src) => {
    const newId = generateUniqueEntityId('pt', existingIds);
    const nextCode = generateNextPointCode(src.itemType, usedCodes);
    const nx = Number(Math.min(lengthM - 0.2, Math.max(0.2, src.x + offsetX)).toFixed(2));
    const ny = Number(Math.min(widthM - 0.2, Math.max(0.2, src.y + offsetY)).toFixed(2));
    const matchedRoom =
      (roomIdMap.get(src.roomId) ? activeFloorRooms.find((r) => r.id === roomIdMap.get(src.roomId)) : undefined) ??
      findRoomAtPoint(activeFloorRooms, nx, ny) ??
      activeFloorRooms.find((r) => r.id === src.roomId) ??
      activeFloorRooms[0];

    const copy: ElectricalPoint = {
      ...JSON.parse(JSON.stringify(src)),
      id: newId,
      floor: activeFloor,
      code: nextCode,
      roomId: matchedRoom?.id ?? src.roomId,
      x: nx,
      y: ny,
    };
    nextPoints.push(copy);
    restoredBoqTypes.add(src.itemType);
    pastedEntities.push({ kind: 'point', id: newId });
  });

  const nextSummaryOverrides =
    project.summaryOverrides?.deletedBoqKeys && restoredBoqTypes.size > 0
      ? {
          ...project.summaryOverrides,
          deletedBoqKeys: project.summaryOverrides.deletedBoqKeys.filter(
            (k) => !restoredBoqTypes.has(k as ElectricalItemType)
          ),
        }
      : project.summaryOverrides;

  return {
    project: {
      ...project,
      rooms: nextRooms,
      customWalls: nextWalls,
      openings: nextOpenings,
      furniture: nextFurniture,
      points: nextPoints,
      ...(nextSummaryOverrides !== undefined ? { summaryOverrides: nextSummaryOverrides } : {}),
    },
    pastedEntities,
  };
}

export function duplicateEntitiesInProject(
  project: ProjectData,
  selection: StudioEntityRef[],
  activeFloor: number
): { project: ProjectData; duplicatedEntities: StudioEntityRef[] } {
  const clip = copyEntitiesToClipboard(project, selection, activeFloor);
  if (!clip) return { project, duplicatedEntities: [] };
  const { project: nextProject, pastedEntities } = pasteClipboardIntoProject(
    project,
    clip,
    activeFloor,
    1
  );
  return { project: nextProject, duplicatedEntities: pastedEntities };
}

export function deleteEntitiesFromProject(
  project: ProjectData,
  selection: StudioEntityRef[]
): { project: ProjectData; deletedCount: number } {
  if (selection.length === 0) return { project, deletedCount: 0 };

  const roomIds = new Set(selection.filter((s) => s.kind === 'room').map((s) => s.id));
  const wallIds = new Set(selection.filter((s) => s.kind === 'wall').map((s) => s.id));
  const openingIds = new Set(selection.filter((s) => s.kind === 'opening').map((s) => s.id));
  const furnitureIds = new Set(selection.filter((s) => s.kind === 'furniture').map((s) => s.id));
  const pointIds = new Set(selection.filter((s) => s.kind === 'point').map((s) => s.id));
  const staircaseIds = new Set(selection.filter((s) => s.kind === 'staircase').map((s) => s.id));
  const wireIds = new Set(selection.filter((s) => s.kind === 'wire').map((s) => s.id));

  const nextRooms = project.rooms.filter((r) => !roomIds.has(r.id));
  const nextWalls = project.customWalls.filter((w) => !wallIds.has(w.id));
  const nextOpenings = project.openings.filter((o) => !openingIds.has(o.id));
  const nextFurniture = project.furniture.filter((f) => !furnitureIds.has(f.id));
  // Deleting a wire NEVER deletes its connected electrical components
  const nextPoints = project.points.filter((p) => !pointIds.has(p.id));
  const prevStairs = project.staircases ?? [];
  const nextStairs = prevStairs.filter((s) => !staircaseIds.has(s.id));
  const prevWires = project.wires ?? [];
  // Remove explicitly selected wires (and clean up wires whose endpoint point was explicitly deleted)
  const nextWires = prevWires.filter(
    (w) => !wireIds.has(w.id) && !pointIds.has(w.fromPointId) && !pointIds.has(w.toPointId)
  );

  const deletedCount =
    (project.rooms.length - nextRooms.length) +
    (project.customWalls.length - nextWalls.length) +
    (project.openings.length - nextOpenings.length) +
    (project.furniture.length - nextFurniture.length) +
    (project.points.length - nextPoints.length) +
    (prevStairs.length - nextStairs.length) +
    (prevWires.length - nextWires.length);

  if (deletedCount === 0) return { project, deletedCount: 0 };

  return {
    project: {
      ...project,
      rooms: nextRooms,
      customWalls: nextWalls,
      openings: nextOpenings,
      furniture: nextFurniture,
      points: nextPoints,
      staircases: nextStairs,
      wires: nextWires,
    },
    deletedCount,
  };
}

export function rotateEntitiesInProject(
  project: ProjectData,
  selection: StudioEntityRef[],
  angleDeltaDeg = 90
): { project: ProjectData; rotatedCount: number } {
  if (selection.length === 0) return { project, rotatedCount: 0 };

  const roomIds = new Set(selection.filter((s) => s.kind === 'room').map((s) => s.id));
  const openingIds = new Set(selection.filter((s) => s.kind === 'opening').map((s) => s.id));
  const furnitureIds = new Set(selection.filter((s) => s.kind === 'furniture').map((s) => s.id));
  const pointIds = new Set(selection.filter((s) => s.kind === 'point').map((s) => s.id));
  const staircaseIds = new Set(selection.filter((s) => s.kind === 'staircase').map((s) => s.id));

  let rotatedCount = 0;

  const nextRooms = project.rooms.map((r) => {
    if (!roomIds.has(r.id)) return r;
    rotatedCount += 1;
    return {
      ...r,
      width: r.height,
      height: r.width,
      rotation: ((r.rotation ?? 0) + angleDeltaDeg) % 360,
    };
  });

  const nextOpenings = project.openings.map((o) => {
    if (!openingIds.has(o.id)) return o;
    rotatedCount += 1;
    return {
      ...o,
      rotation: (o.rotation + angleDeltaDeg) % 360,
    };
  });

  const nextFurniture = project.furniture.map((f) => {
    if (!furnitureIds.has(f.id)) return f;
    rotatedCount += 1;
    return {
      ...f,
      rotation: (f.rotation + angleDeltaDeg) % 360,
    };
  });

  const nextPoints = project.points.map((p) => {
    if (!pointIds.has(p.id)) return p;
    rotatedCount += 1;
    return {
      ...p,
      rotation: (p.rotation + angleDeltaDeg) % 360,
    };
  });

  const nextStaircases = (project.staircases ?? []).map((st) => {
    if (!staircaseIds.has(st.id)) return st;
    rotatedCount += 1;
    return {
      ...st,
      rotation: (st.rotation + angleDeltaDeg) % 360,
    };
  });

  if (rotatedCount === 0) return { project, rotatedCount: 0 };

  return {
    project: {
      ...project,
      rooms: nextRooms,
      openings: nextOpenings,
      furniture: nextFurniture,
      points: nextPoints,
      staircases: nextStaircases,
    },
    rotatedCount,
  };
}

export function moveEntitiesInProject(
  project: ProjectData,
  selection: StudioEntityRef[],
  dxM: number,
  dyM: number
): ProjectData {
  if (selection.length === 0 || (Math.abs(dxM) < 0.0001 && Math.abs(dyM) < 0.0001)) {
    return project;
  }

  const shift = (v: number, delta: number) => Number((v + delta).toFixed(3));
  const roomIds = new Set(selection.filter((s) => s.kind === 'room').map((s) => s.id));
  const wallIds = new Set(selection.filter((s) => s.kind === 'wall').map((s) => s.id));
  const openingIds = new Set(selection.filter((s) => s.kind === 'opening').map((s) => s.id));
  const furnitureIds = new Set(selection.filter((s) => s.kind === 'furniture').map((s) => s.id));
  const pointIds = new Set(selection.filter((s) => s.kind === 'point').map((s) => s.id));
  const staircaseIds = new Set(selection.filter((s) => s.kind === 'staircase').map((s) => s.id));
  const wireIds = new Set(selection.filter((s) => s.kind === 'wire').map((s) => s.id));

  const nextRooms = project.rooms.map((r) =>
    roomIds.has(r.id) ? { ...r, x: shift(r.x, dxM), y: shift(r.y, dyM) } : r
  );

  return {
    ...project,
    rooms: nextRooms,
    customWalls: project.customWalls.map((w) =>
      wallIds.has(w.id)
        ? {
            ...w,
            x1: shift(w.x1, dxM),
            y1: shift(w.y1, dyM),
            x2: shift(w.x2, dxM),
            y2: shift(w.y2, dyM),
          }
        : w
    ),
    openings: project.openings.map((o) =>
      openingIds.has(o.id) ? { ...o, x: shift(o.x, dxM), y: shift(o.y, dyM) } : o
    ),
    furniture: project.furniture.map((f) => {
      if (!furnitureIds.has(f.id) && !roomIds.has(f.roomId)) return f;
      const nx = shift(f.x, dxM);
      const ny = shift(f.y, dyM);
      const fl = getItemFloor(f);
      const room = findRoomAtPoint(
        nextRooms.filter((r) => getItemFloor(r) === fl),
        nx,
        ny
      );
      return { ...f, x: nx, y: ny, roomId: room?.id ?? f.roomId };
    }),
    points: project.points.map((p) => {
      if (!pointIds.has(p.id) && !roomIds.has(p.roomId)) return p;
      const nx = shift(p.x, dxM);
      const ny = shift(p.y, dyM);
      const fl = getItemFloor(p);
      const room = findRoomAtPoint(
        nextRooms.filter((r) => getItemFloor(r) === fl),
        nx,
        ny
      );
      return { ...p, x: nx, y: ny, roomId: room?.id ?? p.roomId };
    }),
    staircases: (project.staircases ?? []).map((st) =>
      staircaseIds.has(st.id) ? { ...st, x: shift(st.x, dxM), y: shift(st.y, dyM) } : st
    ),
    wires: (project.wires ?? []).map((w) =>
      wireIds.has(w.id)
        ? {
            ...w,
            waypoints: w.waypoints.map((wp) => ({
              x: shift(wp.x, dxM),
              y: shift(wp.y, dyM),
            })),
          }
        : w
    ),
  };
}

// --- Global Component Search (Canvas + Component Library) ---

function matchesCategoryFilter(
  filter: FindCategoryFilter,
  itemGroup: 'electrical' | 'furniture' | 'rooms',
  electricalCategory?: string
): boolean {
  if (filter === 'all') return true;
  if (filter === 'electrical') return itemGroup === 'electrical';
  if (filter === 'furniture') return itemGroup === 'furniture';
  if (filter === 'rooms') return itemGroup === 'rooms';
  if (itemGroup !== 'electrical') return false;
  const cat = (electricalCategory ?? '').toLowerCase();
  return cat === filter;
}

function matchesQueryTokens(haystack: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const lower = haystack.toLowerCase();
  return tokens.every((tok) => lower.includes(tok));
}

export function searchStudioComponents(
  project: ProjectData,
  query: string,
  categoryFilter: FindCategoryFilter = 'all'
): StudioSearchResult[] {
  const normalized = query.trim().toLowerCase();
  const tokens = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
  const roomNameById = new Map(project.rooms.map((r) => [r.id, r.name]));

  const placedResults: StudioSearchResult[] = [];
  const libraryResults: StudioSearchResult[] = [];

  // 1. Placed Electrical Points
  project.points.forEach((pt) => {
    if (!matchesCategoryFilter(categoryFilter, 'electrical', pt.category)) return;
    const cat = CATALOG_MAP[pt.itemType];
    const roomName = roomNameById.get(pt.roomId) ?? 'Open Site';
    const haystack = [
      pt.id,
      pt.code,
      pt.name,
      pt.itemType,
      pt.itemType.replace(/_/g, ' '),
      pt.category,
      pt.circuit,
      roomName,
      cat?.label ?? '',
      cat?.productName ?? '',
      'electrical',
    ].join(' ');
    if (!matchesQueryTokens(haystack, tokens)) return;

    const fl = getItemFloor(pt);
    placedResults.push({
      key: `placed-point-${pt.id}`,
      source: 'placed',
      entity: { kind: 'point', id: pt.id },
      title: pt.name,
      subtitle: `${pt.code} · ${roomName} · ${pt.wattage}W · ${formatFloorLabel(fl)}`,
      badge: pt.code,
      category: pt.category,
      icon: cat?.icon ?? 'bolt',
      floor: fl,
      x: pt.x,
      y: pt.y,
      z: pt.z,
    });
  });

  // 2. Placed Furniture
  project.furniture.forEach((f) => {
    if (!matchesCategoryFilter(categoryFilter, 'furniture')) return;
    const meta = FURNITURE_MAP[f.kind];
    const roomName = roomNameById.get(f.roomId) ?? 'Floor Plan';
    const haystack = [
      f.id,
      f.kind,
      f.kind.replace(/-/g, ' '),
      meta?.label ?? f.kind,
      roomName,
      'furniture',
    ].join(' ');
    if (!matchesQueryTokens(haystack, tokens)) return;

    const fl = getItemFloor(f);
    placedResults.push({
      key: `placed-furniture-${f.id}`,
      source: 'placed',
      entity: { kind: 'furniture', id: f.id },
      title: meta?.label ?? f.kind,
      subtitle: `${f.id} · ${roomName} · ${formatFloorLabel(fl)}`,
      badge: 'FURN',
      category: 'Furniture',
      icon: meta?.icon ?? 'chair',
      floor: fl,
      x: f.x,
      y: f.y,
      z: 0.6,
    });
  });

  // 3. Placed Rooms
  project.rooms.forEach((r) => {
    if (!matchesCategoryFilter(categoryFilter, 'rooms')) return;
    const tpl = ROOM_LIBRARY.find((t) => t.type === r.type);
    const haystack = [r.id, r.name, r.type, r.type.replace(/-/g, ' '), r.floorFinish, 'room', 'space'].join(' ');
    if (!matchesQueryTokens(haystack, tokens)) return;

    const fl = getItemFloor(r);
    placedResults.push({
      key: `placed-room-${r.id}`,
      source: 'placed',
      entity: { kind: 'room', id: r.id },
      title: r.name,
      subtitle: `${r.id} · ${r.width.toFixed(1)}m × ${r.height.toFixed(1)}m · ${formatFloorLabel(fl)}`,
      badge: 'ROOM',
      category: 'Rooms',
      icon: tpl?.icon ?? 'meeting_room',
      floor: fl,
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      z: 0.8,
    });
  });

  // 4. Placed Doors & Windows
  project.openings.forEach((o) => {
    if (!matchesCategoryFilter(categoryFilter, 'rooms')) return;
    const label = o.kind === 'door' ? 'Door' : 'Window';
    const haystack = [o.id, o.kind, label, 'opening', 'structure', 'room'].join(' ');
    if (!matchesQueryTokens(haystack, tokens)) return;

    const fl = getItemFloor(o);
    placedResults.push({
      key: `placed-opening-${o.id}`,
      source: 'placed',
      entity: { kind: 'opening', id: o.id },
      title: `${label} (${o.id})`,
      subtitle: `${o.width.toFixed(2)}m wide · ${o.rotation}° · ${formatFloorLabel(fl)}`,
      badge: o.kind === 'door' ? 'DOOR' : 'WIN',
      category: 'Openings',
      icon: o.kind === 'door' ? 'door_front' : 'window',
      floor: fl,
      x: o.x,
      y: o.y,
      z: 1.2,
    });
  });

  // 5. Placed Custom Walls
  project.customWalls.forEach((w) => {
    if (!matchesCategoryFilter(categoryFilter, 'rooms')) return;
    const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
    const haystack = [w.id, 'wall', 'custom wall', w.wallKind ?? 'internal', 'structure', 'room'].join(' ');
    if (!matchesQueryTokens(haystack, tokens)) return;

    const fl = getItemFloor(w);
    placedResults.push({
      key: `placed-wall-${w.id}`,
      source: 'placed',
      entity: { kind: 'wall', id: w.id },
      title: `${w.wallKind === 'external' ? 'External' : 'Internal'} Wall (${w.id})`,
      subtitle: `${len.toFixed(2)}m length · ${formatFloorLabel(fl)}`,
      badge: 'WALL',
      category: 'Walls',
      icon: 'horizontal_rule',
      floor: fl,
      x: (w.x1 + w.x2) / 2,
      y: (w.y1 + w.y2) / 2,
      z: 1.4,
    });
  });

  // 5b. Placed Staircases
  (project.staircases ?? []).forEach((st) => {
    if (!matchesCategoryFilter(categoryFilter, 'rooms')) return;
    const haystack = [st.id, st.name, st.type, 'staircase', 'stairs', 'room'].join(' ');
    if (!matchesQueryTokens(haystack, tokens)) return;

    placedResults.push({
      key: `placed-stair-${st.id}`,
      source: 'placed',
      entity: { kind: 'staircase', id: st.id },
      title: st.name,
      subtitle: `${st.type} · ${st.steps} steps · ${formatFloorLabel(st.fromFloor)} → ${formatFloorLabel(st.toFloor)}`,
      badge: 'STAIR',
      category: 'Staircases',
      icon: 'stairs',
      floor: st.fromFloor,
      x: st.x,
      y: st.y,
      z: 1.2,
    });
  });

  // 5c. Placed Electrical Wires
  (project.wires ?? []).forEach((wire) => {
    if (!matchesCategoryFilter(categoryFilter, 'electrical')) return;
    const fromPt = project.points.find((p) => p.id === wire.fromPointId);
    const toPt = project.points.find((p) => p.id === wire.toPointId);
    const haystack = [
      wire.id,
      wire.code,
      wire.category,
      wire.circuit,
      wire.wireType,
      wire.cableMaterial,
      wire.phaseDesignation,
      fromPt?.code ?? '',
      toPt?.code ?? '',
      'wire',
      'cable',
      'electrical',
    ].join(' ');
    if (!matchesQueryTokens(haystack, tokens)) return;

    placedResults.push({
      key: `placed-wire-${wire.id}`,
      source: 'placed',
      entity: { kind: 'wire', id: wire.id },
      title: `Wire ${wire.code} (${fromPt?.code ?? '?'} → ${toPt?.code ?? '?'})`,
      subtitle: `${wire.category.toUpperCase()} · ${wire.circuit || 'Unassigned'} · ${formatFloorLabel(wire.floor)}`,
      badge: wire.code,
      category: 'Wiring',
      icon: 'cable',
      floor: wire.floor,
      x: fromPt && toPt ? (fromPt.x + toPt.x) / 2 : fromPt?.x ?? 0,
      y: fromPt && toPt ? (fromPt.y + toPt.y) / 2 : fromPt?.y ?? 0,
      z: 2.2,
    });
  });

  // 6. Component Library — Electrical Catalog
  ELECTRICAL_CATALOG.forEach((item) => {
    if (!matchesCategoryFilter(categoryFilter, 'electrical', item.category)) return;
    const haystack = [
      item.itemType,
      item.itemType.replace(/_/g, ' '),
      item.label,
      item.shortCode,
      item.productName,
      item.category,
      item.boqCategory,
      'electrical',
      'library',
    ].join(' ');
    if (!matchesQueryTokens(haystack, tokens)) return;

    libraryResults.push({
      key: `lib-electrical-${item.itemType}`,
      source: 'library',
      libraryKind: 'electrical',
      electricalType: item.itemType,
      title: item.label,
      subtitle: `${item.productName} · ${item.defaultWattage}W · Place on canvas`,
      badge: item.shortCode,
      category: item.category,
      icon: item.icon,
    });
  });

  // 7. Component Library — Furniture Catalog
  FURNITURE_CATALOG.forEach((item) => {
    if (!matchesCategoryFilter(categoryFilter, 'furniture')) return;
    const haystack = [item.kind, item.kind.replace(/-/g, ' '), item.label, 'furniture', 'library'].join(' ');
    if (!matchesQueryTokens(haystack, tokens)) return;

    libraryResults.push({
      key: `lib-furniture-${item.kind}`,
      source: 'library',
      libraryKind: 'furniture',
      furnitureKind: item.kind,
      title: item.label,
      subtitle: `${item.defaultWidth.toFixed(1)}m × ${item.defaultDepth.toFixed(1)}m · Place on canvas`,
      badge: 'ADD',
      category: 'Furniture',
      icon: item.icon,
    });
  });

  // 8. Component Library — Room Library
  ROOM_LIBRARY.forEach((rm) => {
    if (!matchesCategoryFilter(categoryFilter, 'rooms')) return;
    const haystack = [rm.type, rm.type.replace(/-/g, ' '), rm.label, rm.finish, 'room', 'library'].join(' ');
    if (!matchesQueryTokens(haystack, tokens)) return;

    libraryResults.push({
      key: `lib-room-${rm.type}`,
      source: 'library',
      libraryKind: 'room',
      roomType: rm.type,
      title: rm.label,
      subtitle: `${rm.defaultLengthFt}×${rm.defaultWidthFt} ft · Create room`,
      badge: 'ROOM',
      category: 'Rooms',
      icon: rm.icon,
    });
  });

  return [...placedResults, ...libraryResults];
}

// --- Keyboard Event Safety & Shortcut Resolution ---

export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (name: string) => string | null;
  };
  const tag = (el.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  if (typeof el.getAttribute === 'function' && el.getAttribute('role') === 'textbox') {
    return true;
  }
  return false;
}

export interface ShortcutKeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function resolveStudioShortcut(
  event: ShortcutKeyLike,
  options: { isEditable: boolean; modalBlocking?: boolean }
): StudioShortcutAction | null {
  if (options.modalBlocking) return null;

  // Never intercept typing inside input fields, textareas, search boxes, or editable text
  if (options.isEditable) {
    return null;
  }

  if (event.altKey) return null;

  const mod = event.ctrlKey || event.metaKey;
  const keyLower = event.key.toLowerCase();

  if (event.key === 'Escape') {
    return 'escape';
  }

  if (mod) {
    if (keyLower === 'f') return 'find';
    if (keyLower === 'z') return event.shiftKey ? 'redo' : 'undo';
    if (keyLower === 'y') return 'redo';
    if (keyLower === 'c') return 'copy';
    if (keyLower === 'v') return 'paste';
    if (keyLower === 'd') return 'duplicate';
    if (keyLower === 'a') return 'select-all';
    if (keyLower === 's') return 'save';
    return null;
  }

  if (event.key === 'Delete' || event.key === 'Backspace') {
    return 'delete';
  }

  return null;
}

export type WalkDirection = 'forward' | 'backward' | 'left' | 'right';

/**
 * 3D Preview entry/exit command:
 * Accepts both uppercase 'E' and lowercase 'e' while in 3D view and outside editable inputs.
 */
export function resolve3DWalkCommand(
  event: ShortcutKeyLike,
  options: { isEditable: boolean; modalBlocking?: boolean; viewMode: '2d' | '3d' }
): 'toggle-3d-walk' | null {
  if (options.viewMode !== '3d' || options.modalBlocking || options.isEditable) {
    return null;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return null;
  }
  if (event.key.toLowerCase() === 'e') {
    return 'toggle-3d-walk';
  }
  return null;
}

/**
 * 3D Walk navigation:
 * Accepts both uppercase and lowercase W/A/S/D (plus Arrow keys) without Ctrl/Meta/Alt modifiers.
 */
export function resolve3DWalkDirection(
  event: Pick<ShortcutKeyLike, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'> & { code?: string }
): WalkDirection | null {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (key === 'w' || event.key === 'ArrowUp') return 'forward';
  if (key === 's' || event.key === 'ArrowDown') return 'backward';
  if (key === 'a' || event.key === 'ArrowLeft') return 'left';
  if (key === 'd' || event.key === 'ArrowRight') return 'right';
  return null;
}

/**
 * Maps physical key code to walk direction for reliable keyup release
 * even if Shift or CapsLock changes while a movement key is held.
 */
export function resolve3DWalkDirectionFromCode(code: string): WalkDirection | null {
  if (code === 'KeyW' || code === 'ArrowUp') return 'forward';
  if (code === 'KeyS' || code === 'ArrowDown') return 'backward';
  if (code === 'KeyA' || code === 'ArrowLeft') return 'left';
  if (code === 'KeyD' || code === 'ArrowRight') return 'right';
  return null;
}

export type ErasableStudioEntity =
  | StudioEntityRef
  | { kind: 'dimension'; id: string };

/**
 * Deletes a single entity by its stable ID.
 * When deleting an electrical point, removes all wires connected to that point by stable
 * fromPointId / toPointId (never by display label) while preserving unrelated components.
 * When deleting a wire, preserves both connected electrical components.
 */
export function eraseEntityFromProject(
  project: ProjectData,
  entity: ErasableStudioEntity
): { project: ProjectData; deleted: boolean; removedWireCount: number } {
  if (entity.kind === 'room') {
    const nextRooms = project.rooms.filter((r) => r.id !== entity.id);
    return {
      project: {
        ...project,
        rooms: nextRooms,
      },
      deleted: nextRooms.length !== project.rooms.length,
      removedWireCount: 0,
    };
  }
  if (entity.kind === 'wall') {
    const nextWalls = project.customWalls.filter((w) => w.id !== entity.id);
    return {
      project: {
        ...project,
        customWalls: nextWalls,
      },
      deleted: nextWalls.length !== project.customWalls.length,
      removedWireCount: 0,
    };
  }
  if (entity.kind === 'opening') {
    const nextOpenings = project.openings.filter((o) => o.id !== entity.id);
    return {
      project: {
        ...project,
        openings: nextOpenings,
      },
      deleted: nextOpenings.length !== project.openings.length,
      removedWireCount: 0,
    };
  }
  if (entity.kind === 'point') {
    const nextPoints = project.points.filter((p) => p.id !== entity.id);
    const prevWires = project.wires ?? [];
    const nextWires = prevWires.filter(
      (w) => w.fromPointId !== entity.id && w.toPointId !== entity.id
    );
    return {
      project: {
        ...project,
        points: nextPoints,
        wires: nextWires,
      },
      deleted: nextPoints.length !== project.points.length,
      removedWireCount: prevWires.length - nextWires.length,
    };
  }
  if (entity.kind === 'furniture') {
    const nextFurniture = project.furniture.filter((f) => f.id !== entity.id);
    return {
      project: {
        ...project,
        furniture: nextFurniture,
      },
      deleted: nextFurniture.length !== project.furniture.length,
      removedWireCount: 0,
    };
  }
  if (entity.kind === 'staircase') {
    const prevStairs = project.staircases ?? [];
    const nextStairs = prevStairs.filter((s) => s.id !== entity.id);
    return {
      project: {
        ...project,
        staircases: nextStairs,
      },
      deleted: nextStairs.length !== prevStairs.length,
      removedWireCount: 0,
    };
  }
  if (entity.kind === 'wire') {
    const prevWires = project.wires ?? [];
    const nextWires = prevWires.filter((w) => w.id !== entity.id);
    return {
      project: {
        ...project,
        wires: nextWires,
      },
      deleted: nextWires.length !== prevWires.length,
      removedWireCount: prevWires.length - nextWires.length,
    };
  }
  const prevDims = project.dimensions ?? [];
  const nextDims = prevDims.filter((d) => d.id !== entity.id);
  return {
    project: {
      ...project,
      dimensions: nextDims,
    },
    deleted: nextDims.length !== prevDims.length,
    removedWireCount: 0,
  };
}

/**
 * Clears all floor-specific architectural and electrical entities on `floor` in one atomic
 * state update while preserving floorConfigs (floor ID, name, dimensions, elevation),
 * unrelated floors, and project metadata.
 */
export function clearFloorInProject(
  project: ProjectData,
  floor: number
): ProjectData {
  const removedPointIds = new Set(
    project.points.filter((p) => getItemFloor(p) === floor).map((p) => p.id)
  );
  const nextWires = (project.wires ?? []).filter(
    (w) =>
      !removedPointIds.has(w.fromPointId) &&
      !removedPointIds.has(w.toPointId) &&
      !(w.fromFloor === floor && w.toFloor === floor) &&
      !(w.floor === floor && !w.isInterFloor)
  );

  return {
    ...project,
    rooms: project.rooms.filter((r) => getItemFloor(r) !== floor),
    customWalls: project.customWalls.filter((w) => getItemFloor(w) !== floor),
    openings: project.openings.filter((o) => getItemFloor(o) !== floor),
    dimensions: (project.dimensions ?? []).filter((d) => getItemFloor(d) !== floor),
    furniture: project.furniture.filter((f) => getItemFloor(f) !== floor),
    points: project.points.filter((p) => getItemFloor(p) !== floor),
    staircases: (project.staircases ?? []).filter((s) => s.fromFloor !== floor),
    wires: nextWires,
  };
}

/**
 * Translates all objects on `floor` (rooms, walls, openings, dimensions, furniture,
 * electrical points, staircases originating on `floor`, and wire waypoints on `floor`)
 * by the exact same (dxM, dyM) offset without altering unrelated floors or wire topology.
 */
export function moveAllOnFloorInProject(
  project: ProjectData,
  floor: number,
  dxM: number,
  dyM: number
): ProjectData {
  const shift = (v: number, delta: number) => Number((v + delta).toFixed(3));
  const floorPointIds = new Set(
    project.points.filter((p) => getItemFloor(p) === floor).map((p) => p.id)
  );

  return {
    ...project,
    rooms: project.rooms.map((r) =>
      getItemFloor(r) === floor ? { ...r, x: shift(r.x, dxM), y: shift(r.y, dyM) } : r
    ),
    customWalls: project.customWalls.map((w) =>
      getItemFloor(w) === floor
        ? {
            ...w,
            x1: shift(w.x1, dxM),
            y1: shift(w.y1, dyM),
            x2: shift(w.x2, dxM),
            y2: shift(w.y2, dyM),
          }
        : w
    ),
    openings: project.openings.map((op) =>
      getItemFloor(op) === floor ? { ...op, x: shift(op.x, dxM), y: shift(op.y, dyM) } : op
    ),
    dimensions: (project.dimensions ?? []).map((d) =>
      getItemFloor(d) === floor
        ? {
            ...d,
            x1: shift(d.x1, dxM),
            y1: shift(d.y1, dyM),
            x2: shift(d.x2, dxM),
            y2: shift(d.y2, dyM),
          }
        : d
    ),
    furniture: project.furniture.map((f) =>
      getItemFloor(f) === floor ? { ...f, x: shift(f.x, dxM), y: shift(f.y, dyM) } : f
    ),
    points: project.points.map((p) =>
      getItemFloor(p) === floor ? { ...p, x: shift(p.x, dxM), y: shift(p.y, dyM) } : p
    ),
    staircases: (project.staircases ?? []).map((s) =>
      s.fromFloor === floor ? { ...s, x: shift(s.x, dxM), y: shift(s.y, dyM) } : s
    ),
    wires: (project.wires ?? []).map((w) => {
      const sameFloorOnTarget =
        (w.fromFloor === floor && w.toFloor === floor) ||
        (!w.isInterFloor && w.floor === floor) ||
        (floorPointIds.has(w.fromPointId) && floorPointIds.has(w.toPointId));
      if (sameFloorOnTarget) {
        return {
          ...w,
          waypoints: w.waypoints.map((wp) => ({
            x: shift(wp.x, dxM),
            y: shift(wp.y, dyM),
          })),
        };
      }
      // For inter-floor risers starting on this floor, shift the riser anchor waypoint on this floor
      if (w.isInterFloor && w.fromFloor === floor && w.waypoints.length > 0) {
        return {
          ...w,
          waypoints: w.waypoints.map((wp, idx) =>
            idx === 0 ? { x: shift(wp.x, dxM), y: shift(wp.y, dyM) } : wp
          ),
        };
      }
      return w;
    }),
  };
}

/**
 * Resolves the floor immediately below `targetFloor` using the authoritative sorted
 * floorConfigs order rather than assuming floor numbers equal array indexes.
 */
export function getFloorBelow(
  project: ProjectData,
  targetFloor: number
): FloorLevelConfig | null {
  const floors = getProjectFloors(project);
  const idx = floors.findIndex((f) => f.floor === targetFloor);
  if (idx <= 0) return null;
  return floors[idx - 1] ?? null;
}

export interface CopyFloorBelowResult {
  ok: boolean;
  project: ProjectData;
  sourceFloor?: number;
  clonedRoomCount: number;
  clonedPointCount: number;
  clonedWireCount: number;
  clonedStaircaseCount: number;
  skippedDistributionCount: number;
  reason?: string;
}

/**
 * Copies layout, branch electrical points (excluding DB/EP to prevent duplicates),
 * reconnected same-floor wires (preserving cable specs, pricing, GST & circuit),
 * and valid staircases from the floor immediately below `targetFloor`.
 * Never overwrites a target floor that already contains layout elements and never
 * modifies the source floor.
 */
export function copyFloorBelowInProject(
  project: ProjectData,
  targetFloor: number
): CopyFloorBelowResult {
  const floors = getProjectFloors(project);
  const targetIdx = floors.findIndex((f) => f.floor === targetFloor);
  if (targetIdx <= 0) {
    return {
      ok: false,
      project,
      clonedRoomCount: 0,
      clonedPointCount: 0,
      clonedWireCount: 0,
      clonedStaircaseCount: 0,
      skippedDistributionCount: 0,
      reason: 'No floor exists below the active floor to copy from.',
    };
  }

  const sourceCfg = floors[targetIdx - 1];
  const sourceFloor = sourceCfg.floor;
  const targetLabel = getFloorLabel(project, targetFloor);
  const sourceLabel = getFloorLabel(project, sourceFloor);

  // Guard against overwriting an existing populated floor
  const targetSlice = sliceProjectForFloor(project, targetFloor);
  const targetStaircases = (project.staircases ?? []).filter((s) => s.fromFloor === targetFloor);
  const targetHasExistingContent =
    targetSlice.rooms.length > 0 ||
    targetSlice.customWalls.length > 0 ||
    targetSlice.openings.length > 0 ||
    targetSlice.furniture.length > 0 ||
    targetSlice.points.length > 0 ||
    (targetSlice.dimensions ?? []).length > 0 ||
    targetStaircases.length > 0;

  if (targetHasExistingContent) {
    return {
      ok: false,
      project,
      sourceFloor,
      clonedRoomCount: 0,
      clonedPointCount: 0,
      clonedWireCount: 0,
      clonedStaircaseCount: 0,
      skippedDistributionCount: 0,
      reason: `${targetLabel} already contains existing layout items. Clear ${targetLabel} first before copying from ${sourceLabel}.`,
    };
  }

  const sourceSlice = sliceProjectForFloor(project, sourceFloor);
  const sourceStairs = (project.staircases ?? []).filter((s) => s.fromFloor === sourceFloor);
  if (
    sourceSlice.rooms.length === 0 &&
    sourceSlice.customWalls.length === 0 &&
    sourceSlice.openings.length === 0 &&
    sourceSlice.points.length === 0
  ) {
    return {
      ok: false,
      project,
      sourceFloor,
      clonedRoomCount: 0,
      clonedPointCount: 0,
      clonedWireCount: 0,
      clonedStaircaseCount: 0,
      skippedDistributionCount: 0,
      reason: `${sourceLabel} has no rooms, walls, or electrical points to copy yet.`,
    };
  }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
  const roomIdMap = new Map<string, string>();
  const pointIdMap = new Map<string, string>();

  const clonedRooms = sourceSlice.rooms.map((r, idx) => {
    const nextId = `rm-f${targetFloor}-${stamp}-${idx}`;
    roomIdMap.set(r.id, nextId);
    return { ...r, id: nextId, floor: targetFloor };
  });
  const clonedWalls = sourceSlice.customWalls.map((w, idx) => ({
    ...w,
    id: `cw-f${targetFloor}-${stamp}-${idx}`,
    floor: targetFloor,
  }));
  const clonedOpenings = sourceSlice.openings.map((o, idx) => ({
    ...o,
    id: `op-f${targetFloor}-${stamp}-${idx}`,
    floor: targetFloor,
  }));
  const clonedDimensions = (sourceSlice.dimensions ?? []).map((d, idx) => ({
    ...d,
    id: `dim-f${targetFloor}-${stamp}-${idx}`,
    floor: targetFloor,
  }));
  const clonedFurniture = sourceSlice.furniture.map((f, idx) => ({
    ...f,
    id: `fn-f${targetFloor}-${stamp}-${idx}`,
    roomId: roomIdMap.get(f.roomId) ?? f.roomId,
    floor: targetFloor,
  }));

  let skippedDistributionCount = 0;
  const clonedPoints: ElectricalPoint[] = [];
  sourceSlice.points.forEach((p, idx) => {
    if (p.itemType === 'distribution_board' || p.itemType === 'earthing_point') {
      skippedDistributionCount += 1;
      return;
    }
    const nextId = `pt-f${targetFloor}-${stamp}-${idx}`;
    pointIdMap.set(p.id, nextId);
    clonedPoints.push({
      ...p,
      id: nextId,
      code: `F${targetFloor}-${p.code}`,
      roomId: roomIdMap.get(p.roomId) ?? p.roomId,
      floor: targetFloor,
    });
  });

  // Reconnect same-floor wires between cloned branch points preserving cable specs, pricing & GST
  let nextWireSeq = getNextWireSequence(project.wires ?? []);
  const clonedWires: ElectricalWire[] = [];
  (project.wires ?? []).forEach((w, idx) => {
    if (w.fromFloor !== sourceFloor || w.toFloor !== sourceFloor || w.isInterFloor) return;
    const mappedFrom = pointIdMap.get(w.fromPointId);
    const mappedTo = pointIdMap.get(w.toPointId);
    if (!mappedFrom || !mappedTo) return;
    const seq = nextWireSeq;
    nextWireSeq += 1;
    clonedWires.push({
      ...w,
      id: `wire-f${targetFloor}-${stamp}-${idx}`,
      code: `W-${String(seq).padStart(2, '0')}`,
      floor: targetFloor,
      fromFloor: targetFloor,
      toFloor: targetFloor,
      isInterFloor: false,
      fromPointId: mappedFrom,
      toPointId: mappedTo,
      waypoints: w.waypoints.map((wp) => ({ ...wp })),
    });
  });

  // Clone staircases only if there is an actual next floor above targetFloor to connect to
  const nextFloorAbove = floors[targetIdx + 1] ?? null;
  const clonedStaircases: StaircaseItem[] = nextFloorAbove
    ? sourceStairs.map((s, idx) => ({
        ...s,
        id: `st-f${targetFloor}-${stamp}-${idx}`,
        fromFloor: targetFloor,
        toFloor: nextFloorAbove.floor,
      }))
    : [];

  return {
    ok: true,
    sourceFloor,
    clonedRoomCount: clonedRooms.length,
    clonedPointCount: clonedPoints.length,
    clonedWireCount: clonedWires.length,
    clonedStaircaseCount: clonedStaircases.length,
    skippedDistributionCount,
    project: {
      ...project,
      rooms: [...project.rooms, ...clonedRooms],
      customWalls: [...project.customWalls, ...clonedWalls],
      openings: [...project.openings, ...clonedOpenings],
      dimensions: [...(project.dimensions ?? []), ...clonedDimensions],
      furniture: [...project.furniture, ...clonedFurniture],
      points: [...project.points, ...clonedPoints],
      staircases: [...(project.staircases ?? []), ...clonedStaircases],
      wires: [...(project.wires ?? []), ...clonedWires],
    },
  };
}

/**
 * Updates a circuit's cable configuration and propagates all product metadata,
 * pricing, and GST values to existing wires on that circuit without inventing missing prices.
 */
export function applyCircuitCableConfigToProject(
  project: ProjectData,
  circuit: CircuitId,
  patch: Partial<CircuitCableConfig>,
  applyToCircuitWires = true
): ProjectData {
  const existing: CircuitCableConfig = project.circuitCableConfigs?.[circuit] ?? {
    circuit,
    cableSizeSqMm: null,
    cableMaterial: 'Copper' as CableMaterial,
  };
  const updated: CircuitCableConfig = { ...existing, ...patch, circuit };
  const nextConfigs = {
    ...(project.circuitCableConfigs ?? {}),
    [circuit]: updated,
  };
  const linkedWireFields = buildCircuitCableWireFields(updated);
  const nextWires = applyToCircuitWires
    ? (project.wires ?? []).map((w) =>
        w.circuit === circuit
          ? {
              ...w,
              cableSizeSqMm: updated.cableSizeSqMm,
              cableMaterial: updated.cableMaterial,
              ...linkedWireFields,
            }
          : w
      )
    : project.wires;

  return {
    ...project,
    circuitCableConfigs: nextConfigs,
    ...(nextWires ? { wires: nextWires } : {}),
  };
}

/**
 * Maps a verified ProductCatalogueItem cable product onto a target circuit and all
 * wires assigned to that circuit, preserving productId, manufacturer, brand, productName,
 * modelNumber, category, specification, cableSizeSqMm, unit, unitPrice, gstPercent, and datasheetUrl.
 */
export function assignCatalogueCableToCircuit(
  project: ProjectData,
  product: ProductCatalogueItem,
  circuit: CircuitId
): ProjectData {
  const existing = project.circuitCableConfigs?.[circuit];
  return applyCircuitCableConfigToProject(
    project,
    circuit,
    {
      cableSizeSqMm: product.cableSizeSqMm ?? existing?.cableSizeSqMm ?? null,
      productId: product.id,
      manufacturer: product.manufacturer,
      brand: product.brand || product.manufacturer,
      productName: product.productName,
      productCategory: product.category,
      modelNumber: product.modelNumber,
      specification: product.specification,
      unit: product.unit || 'm',
      unitPricePerM: product.unitPrice,
      gstPercent: product.gstPercent,
      datasheetUrl: sanitizeSafeUrl(product.datasheetUrl),
    },
    true
  );
}


