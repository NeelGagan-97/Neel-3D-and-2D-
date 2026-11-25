import assert from 'node:assert/strict';
import * as THREE from 'three';
import readXlsxFile from 'read-excel-file/universal';
import writeXlsxFile from 'write-excel-file/universal';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { INITIAL_PROJECTS } from '../src/data/presets';
import { mapSignUpError, registerEmployee, updateUserPassword } from '../src/services/authService';
import {
  loadCatalogueProducts,
  parseCatalogueSpreadsheet,
  saveCatalogueProducts,
  SPREADSHEET_LIMITS,
  validateSpreadsheetUpload,
} from '../src/services/productCatalogueStorage';
import { projectStorage } from '../src/services/projectStorage';
import { buildArchitecturalScene } from '../src/three/architecturalBuilder';
import type { ArchitecturalTextureSet } from '../src/three/proceduralTextures';
import type { ProductCatalogueItem } from '../src/types/catalogue';
import type {
  CircuitId,
  ElectricalPoint,
  ElectricalWire,
  FloorLevelConfig,
  ProjectData,
  StaircaseItem,
} from '../src/types/design';
import { validateResetPasswordInput } from '../src/utils/authValidation';
import {
  autoRouteUnwiredCables,
  buildCircuitCableWireFields,
  computeReconciledBoq,
  createElectricalWire,
  duplicateFloorInProject,
} from '../src/utils/buildingWiring';
import { formatSafeCsvCell, formatSafeCsvRow, sanitizeCsvTextValue } from '../src/utils/csvSecurity';
import { buildExcelBoqBlob, buildExcelBoqSheets } from '../src/utils/excelBoqExporter';
import {
  applyCircuitCableConfigToProject,
  assignCatalogueCableToCircuit,
  clearFloorInProject,
  cloneProject,
  copyFloorBelowInProject,
  createHistoryState,
  deleteEntitiesFromProject,
  eraseEntityFromProject,
  getFloorBelow,
  moveAllOnFloorInProject,
  pushHistorySnapshot,
  redoHistoryState,
  undoHistoryState,
} from '../src/utils/studioEditor';
import { sanitizeSafeUrl, validateSafeUrl } from '../src/utils/urlSecurity';

interface TestCase {
  name: string;
  run: () => void | Promise<void>;
}

const tests: TestCase[] = [];
function test(name: string, run: () => void | Promise<void>) {
  tests.push({ name, run });
}

function installMockLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const mockStorage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
  return store;
}

function createSampleProject(): ProjectData {
  return cloneProject(INITIAL_PROJECTS[0]);
}

function withAutoRoutedWires(project: ProjectData): ProjectData {
  const routed = autoRouteUnwiredCables(project);
  return { ...project, wires: routed.nextWires };
}

function makeFloorConfig(
  floor: number,
  name: string,
  kind: FloorLevelConfig['kind'],
  elevationM: number
): FloorLevelConfig {
  return {
    floor,
    name,
    kind,
    elevationM,
    floorHeightM: 3.0,
    slabThicknessM: 0.22,
    visible: true,
  };
}

function makeStaircase(id: string, fromFloor: number, toFloor: number, x = 2, y = 2): StaircaseItem {
  return {
    id,
    name: `Stair ${id}`,
    type: 'straight',
    fromFloor,
    toFloor,
    x,
    y,
    rotation: 0,
    width: 1.2,
    riserHeight: 0.175,
    treadDepth: 0.25,
    steps: 16,
    landingWidth: 1.2,
    landingDepth: 1.2,
  };
}

function createSampleCableProduct(overrides: Partial<ProductCatalogueItem> = {}): ProductCatalogueItem {
  return {
    id: 'cat-cable-polycab-25',
    category: 'Cables & Wires',
    manufacturer: 'Polycab',
    brand: 'Polycab Optima Plus',
    productName: 'Polycab 2.5 sq.mm FRLSH Copper Wire',
    modelNumber: 'POL-FRLSH-2.5',
    specification: '1100V FRLSH Annealed Electrolytic Copper IS 694',
    rating: '1100V / 22A',
    wattageW: null,
    cableSizeSqMm: 2.5,
    dimensions: '90m coil',
    unit: 'm',
    unitPrice: 46.5,
    gstPercent: 18,
    datasheetUrl: 'https://polycab.com/datasheets/frlsh-25.pdf',
    manufacturerUrl: 'https://polycab.com/',
    source: 'admin-entry',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createMockTextureSet(): {
  textures: ArchitecturalTextureSet;
  getDisposeCalls: () => number;
} {
  let disposeCalls = 0;
  const makeTex = () => {
    const data = new Uint8Array([200, 180, 160, 255]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    const origDispose = tex.dispose.bind(tex);
    tex.dispose = () => {
      disposeCalls += 1;
      origDispose();
    };
    return tex as unknown as THREE.CanvasTexture;
  };
  const wood = makeTex();
  const tile = makeTex();
  const terrazzo = makeTex();
  const stone = makeTex();
  return {
    textures: {
      wood,
      tile,
      terrazzo,
      stone,
      dispose: () => {
        wood.dispose();
        tile.dispose();
        terrazzo.dispose();
        stone.dispose();
      },
    },
    getDisposeCalls: () => disposeCalls,
  };
}

// ============================================================================
// A. Electrical Point & Wire Deletion Integrity
// ============================================================================
test('A1. Deleting an electrical point removes connected wires by stable ID without affecting same-label points or unrelated wires', () => {
  const project = createSampleProject();
  const room = project.rooms[0];

  const ptA: ElectricalPoint = {
    id: 'pt-stable-a',
    floor: 1,
    roomId: room.id,
    itemType: 'led_light',
    category: 'Lighting',
    code: 'L-DUP',
    name: 'Shared Label Light',
    x: room.x + 1,
    y: room.y + 1,
    z: 2.8,
    rotation: 0,
    wattage: 18,
    voltage: 230,
    circuit: 'CKT-L1 (Lighting)',
    unitCost: 450,
  };
  const ptB: ElectricalPoint = {
    ...ptA,
    id: 'pt-stable-b',
    x: room.x + 2,
    y: room.y + 1,
  };
  const ptC: ElectricalPoint = {
    ...ptA,
    id: 'pt-stable-c',
    code: 'SW-1',
    itemType: 'switch',
    category: 'Switches',
    name: 'Wall Switch',
    x: room.x + 0.5,
    y: room.y + 0.5,
    z: 1.2,
  };

  const withPoints: ProjectData = {
    ...project,
    points: [...project.points, ptA, ptB, ptC],
  };

  const wConnectedFrom: ElectricalWire = {
    ...createElectricalWire({ project: withPoints, fromPoint: ptA, toPoint: ptC }),
    id: 'w-a-c',
    code: 'W-901',
  };
  const wConnectedTo: ElectricalWire = {
    ...createElectricalWire({ project: withPoints, fromPoint: ptC, toPoint: ptA }),
    id: 'w-c-a',
    code: 'W-902',
  };
  const wSameLabelUnrelated: ElectricalWire = {
    ...createElectricalWire({ project: withPoints, fromPoint: ptB, toPoint: ptC }),
    id: 'w-b-c',
    code: 'W-903',
  };

  const enriched: ProjectData = {
    ...withPoints,
    wires: [...(withPoints.wires ?? []), wConnectedFrom, wConnectedTo, wSameLabelUnrelated],
  };

  const { project: afterErase, removedWireCount } = eraseEntityFromProject(enriched, {
    kind: 'point',
    id: 'pt-stable-a',
  });

  assert.equal(removedWireCount, 2);
  assert.equal(afterErase.points.some((p) => p.id === 'pt-stable-a'), false);
  // Same-label sibling ptB and its wire w-b-c MUST remain untouched
  assert.equal(afterErase.points.some((p) => p.id === 'pt-stable-b'), true);
  assert.equal((afterErase.wires ?? []).some((w) => w.id === 'w-a-c'), false);
  assert.equal((afterErase.wires ?? []).some((w) => w.id === 'w-c-a'), false);
  assert.equal((afterErase.wires ?? []).some((w) => w.id === 'w-b-c'), true);

  // Also test batch deleteEntitiesFromProject
  const batch = deleteEntitiesFromProject(enriched, [{ kind: 'point', id: 'pt-stable-a' }]);
  assert.equal(batch.project.points.some((p) => p.id === 'pt-stable-a'), false);
  assert.equal((batch.project.wires ?? []).some((w) => w.id === 'w-a-c'), false);
  assert.equal((batch.project.wires ?? []).some((w) => w.id === 'w-b-c'), true);
});

test('A2. Deleting a wire removes only the wire and preserves both connected electrical points', () => {
  const project = createSampleProject();
  const [p1, p2] = project.points;
  assert.ok(p1 && p2);
  const wire: ElectricalWire = {
    ...createElectricalWire({ project, fromPoint: p1, toPoint: p2 }),
    id: 'w-only-del',
    code: 'W-950',
  };
  const withWire: ProjectData = { ...project, wires: [...(project.wires ?? []), wire] };

  const { project: next, removedWireCount } = eraseEntityFromProject(withWire, {
    kind: 'wire',
    id: 'w-only-del',
  });
  assert.equal(removedWireCount, 1);
  assert.equal((next.wires ?? []).some((w) => w.id === 'w-only-del'), false);
  assert.equal(next.points.some((p) => p.id === p1.id), true);
  assert.equal(next.points.some((p) => p.id === p2.id), true);
});

// ============================================================================
// B. Floor Clearing Integrity
// ============================================================================
test('B. Clear Floor clears all floor entities (including staircases, dimensions, wires) while preserving floor metadata and other floors', () => {
  let project = createSampleProject();
  project = {
    ...project,
    floorConfigs: [
      makeFloorConfig(1, 'Ground Floor', 'ground', 0),
      makeFloorConfig(2, 'First Floor', 'upper', 3.22),
    ],
  };

  const f1Room = project.rooms[0];
  const f2Room = { ...f1Room, id: 'rm-f2-keep', floor: 2, name: 'First Floor Room' };
  const f2Pt1: ElectricalPoint = { ...project.points[0], id: 'pt-f2-1', floor: 2, roomId: f2Room.id };
  const f2Pt2: ElectricalPoint = { ...project.points[1], id: 'pt-f2-2', floor: 2, roomId: f2Room.id };
  const f1Pt1 = project.points[0];
  const f1Pt2 = project.points[1];

  const withPoints: ProjectData = {
    ...project,
    rooms: [...project.rooms, f2Room],
    points: [...project.points, f2Pt1, f2Pt2],
  };

  const wireF1: ElectricalWire = {
    ...createElectricalWire({ project: withPoints, fromPoint: f1Pt1, toPoint: f1Pt2 }),
    id: 'w-f1-only',
    code: 'W-101',
  };
  const wireF2: ElectricalWire = {
    ...createElectricalWire({ project: withPoints, fromPoint: f2Pt1, toPoint: f2Pt2 }),
    id: 'w-f2-keep',
    code: 'W-201',
  };
  const wireInter: ElectricalWire = {
    ...createElectricalWire({ project: withPoints, fromPoint: f1Pt1, toPoint: f2Pt1 }),
    id: 'w-inter-12',
    code: 'W-301',
  };

  const populated: ProjectData = {
    ...withPoints,
    dimensions: [
      { id: 'dim-f1', floor: 1, x1: 0, y1: 0, x2: 3, y2: 0 },
      { id: 'dim-f2', floor: 2, x1: 0, y1: 0, x2: 3, y2: 0 },
    ],
    staircases: [makeStaircase('st-f1', 1, 2)],
    wires: [wireF1, wireF2, wireInter],
  };

  const cleared = clearFloorInProject(populated, 1);

  // Floor 1 completely cleared
  assert.equal(cleared.rooms.filter((r) => (r.floor ?? 1) === 1).length, 0);
  assert.equal(cleared.customWalls.filter((w) => (w.floor ?? 1) === 1).length, 0);
  assert.equal(cleared.openings.filter((o) => (o.floor ?? 1) === 1).length, 0);
  assert.equal(cleared.furniture.filter((f) => (f.floor ?? 1) === 1).length, 0);
  assert.equal(cleared.points.filter((p) => (p.floor ?? 1) === 1).length, 0);
  assert.equal((cleared.dimensions ?? []).filter((d) => (d.floor ?? 1) === 1).length, 0);
  assert.equal((cleared.staircases ?? []).filter((s) => s.fromFloor === 1).length, 0);
  assert.equal((cleared.wires ?? []).some((w) => w.id === 'w-f1-only'), false);
  assert.equal((cleared.wires ?? []).some((w) => w.id === 'w-inter-12'), false);

  // Floor 2 and floor metadata preserved
  assert.equal(cleared.floorConfigs?.length, 2);
  assert.equal(cleared.floorConfigs?.[0].name, 'Ground Floor');
  assert.equal(cleared.rooms.some((r) => r.id === 'rm-f2-keep'), true);
  assert.equal(cleared.points.filter((p) => p.floor === 2).length, 2);
  assert.equal((cleared.dimensions ?? []).some((d) => d.id === 'dim-f2'), true);
  assert.equal((cleared.wires ?? []).some((w) => w.id === 'w-f2-keep'), true);
  assert.equal(cleared.id, populated.id);
  assert.equal(cleared.name, populated.name);
});

// ============================================================================
// C. Move All Integrity
// ============================================================================
test('C. Move All shifts rooms, walls, openings, dimensions, furniture, points, staircases, and wire waypoints identically while leaving other floors untouched', () => {
  const base = createSampleProject();
  const f1Pt1 = base.points[0];
  const f1Pt2 = base.points[1];
  const f2Room = { ...base.rooms[0], id: 'rm-f2-static', floor: 2, x: 5, y: 5 };
  const stair = makeStaircase('st-move-1', 1, 2, 2.0, 3.0);
  const wire: ElectricalWire = {
    ...createElectricalWire({ project: base, fromPoint: f1Pt1, toPoint: f1Pt2 }),
    id: 'w-move-1',
    code: 'W-11',
    waypoints: [
      { x: 1.5, y: 2.5 },
      { x: 3.5, y: 2.5 },
    ],
  };
  const project: ProjectData = {
    ...base,
    rooms: [...base.rooms, f2Room],
    dimensions: [{ id: 'dim-m1', floor: 1, x1: 1, y1: 1, x2: 4, y2: 1 }],
    staircases: [stair],
    wires: [wire],
  };

  const dx = 1.25;
  const dy = -0.75;
  const moved = moveAllOnFloorInProject(project, 1, dx, dy);

  const origRoom = project.rooms[0];
  const shiftedRoom = moved.rooms.find((r) => r.id === origRoom.id)!;
  assert.equal(shiftedRoom.x, Number((origRoom.x + dx).toFixed(3)));
  assert.equal(shiftedRoom.y, Number((origRoom.y + dy).toFixed(3)));

  const shiftedPt = moved.points.find((p) => p.id === f1Pt1.id)!;
  assert.equal(shiftedPt.x, Number((f1Pt1.x + dx).toFixed(3)));
  assert.equal(shiftedPt.y, Number((f1Pt1.y + dy).toFixed(3)));

  const shiftedStair = (moved.staircases ?? []).find((s) => s.id === 'st-move-1')!;
  assert.equal(shiftedStair.x, 3.25);
  assert.equal(shiftedStair.y, 2.25);

  const shiftedWire = (moved.wires ?? []).find((w) => w.id === 'w-move-1')!;
  assert.deepEqual(shiftedWire.waypoints, [
    { x: 2.75, y: 1.75 },
    { x: 4.75, y: 1.75 },
  ]);
  assert.equal(shiftedWire.fromPointId, f1Pt1.id);
  assert.equal(shiftedWire.toPointId, f1Pt2.id);

  // Unrelated floor untouched
  const untouchedF2 = moved.rooms.find((r) => r.id === 'rm-f2-static')!;
  assert.equal(untouchedF2.x, 5);
  assert.equal(untouchedF2.y, 5);
});

// ============================================================================
// D. Copy Floor Below Integrity
// ============================================================================
test('D. Copy Floor Below resolves sorted floorConfigs (Basement -> Ground), refuses populated target, skips DB/EP, reconnects wires with pricing/GST, and clones staircases safely', () => {
  const base = createSampleProject();
  const cableProduct = createSampleCableProduct();
  const circuit: CircuitId = 'CKT-L1 (Lighting)';

  // Configure non-contiguous floor numbers: Basement (-1), Ground (1), First (2)
  const basementRooms = base.rooms.map((r) => ({ ...r, floor: -1 }));
  const basementPoints = base.points.map((p) => ({ ...p, floor: -1 }));
  const dbPt = basementPoints.find((p) => p.itemType === 'distribution_board');
  const branchPts = basementPoints.filter(
    (p) => p.itemType !== 'distribution_board' && p.itemType !== 'earthing_point'
  );
  assert.ok(branchPts.length >= 2, 'Need at least two branch points for wire cloning test');

  const baseWithFloors: ProjectData = {
    ...base,
    floorConfigs: [
      makeFloorConfig(-1, 'Basement', 'basement', -3.22),
      makeFloorConfig(1, 'Ground Floor', 'ground', 0),
      makeFloorConfig(2, 'First Floor', 'upper', 3.22),
    ],
    rooms: basementRooms,
    customWalls: base.customWalls.map((w) => ({ ...w, floor: -1 })),
    openings: base.openings.map((o) => ({ ...o, floor: -1 })),
    furniture: base.furniture.map((f) => ({ ...f, floor: -1 })),
    points: basementPoints,
    staircases: [makeStaircase('st-b-g', -1, 1, 1, 1)],
    wires: [],
  };

  // Assign verified cable product to CKT-L1 and create a branch-to-branch wire on Basement (-1)
  const withCfg = assignCatalogueCableToCircuit(baseWithFloors, cableProduct, circuit);
  const cableFields = buildCircuitCableWireFields(withCfg.circuitCableConfigs?.[circuit]);
  const branchWire: ElectricalWire = {
    ...createElectricalWire({
      project: withCfg,
      fromPoint: branchPts[0],
      toPoint: branchPts[1],
      circuit,
      cableSizeSqMm: cableProduct.cableSizeSqMm,
    }),
    id: 'w-basement-branch',
    code: 'W-01',
    ...cableFields,
  };
  const projectReady: ProjectData = {
    ...withCfg,
    wires: [branchWire],
  };

  // 1. Verify getFloorBelow resolves Basement (-1) below Ground (1) (NOT 1 - 1 = 0!)
  const belowGround = getFloorBelow(projectReady, 1);
  assert.ok(belowGround);
  assert.equal(belowGround.floor, -1);
  assert.equal(getFloorBelow(projectReady, -1), null);

  // 2. Copy Basement (-1) -> Ground (1)
  const sourceSnapshotBefore = JSON.stringify(projectReady.points.filter((p) => p.floor === -1));
  const copyRes = copyFloorBelowInProject(projectReady, 1);
  assert.equal(copyRes.ok, true);
  assert.equal(copyRes.sourceFloor, -1);
  assert.equal(copyRes.clonedRoomCount, basementRooms.length);
  assert.equal(copyRes.clonedWireCount, 1);
  assert.equal(copyRes.clonedStaircaseCount, 1);
  if (dbPt) {
    assert.ok(copyRes.skippedDistributionCount >= 1);
    assert.equal(
      copyRes.project.points.some((p) => p.floor === 1 && p.itemType === 'distribution_board'),
      false
    );
  }

  // Cloned wire preserves cable product metadata, pricing & GST, has unique ID/code, and connects cloned points
  const clonedWire = (copyRes.project.wires ?? []).find((w) => w.floor === 1)!;
  assert.ok(clonedWire);
  assert.notEqual(clonedWire.id, branchWire.id);
  assert.notEqual(clonedWire.code, branchWire.code);
  assert.equal(clonedWire.productId, cableProduct.id);
  assert.equal(clonedWire.unitPricePerM, 46.5);
  assert.equal(clonedWire.gstPercent, 18);
  assert.equal(clonedWire.manufacturer, 'Polycab');
  assert.equal(clonedWire.circuit, circuit);
  const groundPointIds = new Set(copyRes.project.points.filter((p) => p.floor === 1).map((p) => p.id));
  assert.equal(groundPointIds.has(clonedWire.fromPointId), true);
  assert.equal(groundPointIds.has(clonedWire.toPointId), true);

  // Cloned staircase connects Ground (1) -> First (2)
  const clonedStair = (copyRes.project.staircases ?? []).find((s) => s.fromFloor === 1)!;
  assert.ok(clonedStair);
  assert.equal(clonedStair.toFloor, 2);

  // Source floor unchanged
  assert.equal(
    JSON.stringify(copyRes.project.points.filter((p) => p.floor === -1)),
    sourceSnapshotBefore
  );

  // 3. Refuses to overwrite populated target floor
  const overwriteAttempt = copyFloorBelowInProject(copyRes.project, 1);
  assert.equal(overwriteAttempt.ok, false);
  assert.match(overwriteAttempt.reason ?? '', /already contains existing layout items/i);

  // 4. Copying onto top floor (2) does NOT create a dangling staircase above the top floor
  const topCopy = copyFloorBelowInProject(copyRes.project, 2);
  assert.equal(topCopy.ok, true);
  assert.equal(topCopy.clonedStaircaseCount, 0);
});

// ============================================================================
// E. Undo / Redo Integration for Delete Point, Clear Floor, Move All, Copy Floor Below
// ============================================================================
test('E. Undo/Redo cleanly reverses and reapplies Delete Point, Move All, Clear Floor, and Copy Floor Below', () => {
  const initial = createSampleProject();
  const projectWithTwoFloors: ProjectData = {
    ...initial,
    floorConfigs: [
      makeFloorConfig(1, 'Ground Floor', 'ground', 0),
      makeFloorConfig(2, 'First Floor', 'upper', 3.22),
    ],
  };
  let history = createHistoryState(projectWithTwoFloors);

  // 1. Copy Floor Below (1 -> 2)
  const afterCopy = copyFloorBelowInProject(history.present, 2);
  assert.equal(afterCopy.ok, true);
  history = pushHistorySnapshot(history, afterCopy.project);
  const f2CountAfterCopy = history.present.rooms.filter((r) => r.floor === 2).length;
  assert.ok(f2CountAfterCopy > 0);

  // 2. Move All on Floor 2
  const afterMove = moveAllOnFloorInProject(history.present, 2, 2.0, 1.0);
  history = pushHistorySnapshot(history, afterMove);

  // 3. Delete Point on Floor 2
  const f2Point = history.present.points.find((p) => p.floor === 2)!;
  assert.ok(f2Point);
  const afterDel = eraseEntityFromProject(history.present, { kind: 'point', id: f2Point.id });
  history = pushHistorySnapshot(history, afterDel.project);

  // 4. Clear Floor 2
  const afterClear = clearFloorInProject(history.present, 2);
  history = pushHistorySnapshot(history, afterClear);
  assert.equal(history.present.rooms.filter((r) => r.floor === 2).length, 0);

  // Undo all 4 steps -> back to initial state
  history = undoHistoryState(history); // undo Clear
  assert.equal(history.present.rooms.filter((r) => r.floor === 2).length, f2CountAfterCopy);
  history = undoHistoryState(history); // undo Delete Point
  assert.equal(history.present.points.some((p) => p.id === f2Point.id), true);
  history = undoHistoryState(history); // undo Move All
  history = undoHistoryState(history); // undo Copy Floor Below
  assert.equal(history.present.rooms.filter((r) => r.floor === 2).length, 0);

  // Redo all 4 steps
  history = redoHistoryState(history);
  history = redoHistoryState(history);
  history = redoHistoryState(history);
  history = redoHistoryState(history);
  assert.equal(history.present.rooms.filter((r) => r.floor === 2).length, 0);
});

// ============================================================================
// F & G. Cable Catalogue Pricing & GST Preservation (Zero Fabricated Prices)
// ============================================================================
test('F & G. Cable pricing, GST, and product metadata propagate across circuit config, auto-route, duplicate floor, save/reload, BOQ, and Excel — never inventing missing prices', () => {
  installMockLocalStorage();
  const base = createSampleProject();
  const pricedCable = createSampleCableProduct({ unitPrice: 52.25, gstPercent: 18 });
  const unpricedCable = createSampleCableProduct({
    id: 'cat-cable-unpriced',
    productName: 'Finolex 4.0 sq.mm Unpriced Cable',
    manufacturer: 'Finolex',
    modelNumber: 'FIN-4.0',
    cableSizeSqMm: 4.0,
    unitPrice: null,
    gstPercent: null,
  });

  // Assign priced cable to CKT-L1 (Lighting) and unpriced cable to CKT-P1 (Kitchen)
  let project = assignCatalogueCableToCircuit(base, pricedCable, 'CKT-L1 (Lighting)');
  project = assignCatalogueCableToCircuit(project, unpricedCable, 'CKT-P1 (Kitchen)');
  project = withAutoRoutedWires(project);

  const l1Wires = (project.wires ?? []).filter((w) => w.circuit === 'CKT-L1 (Lighting)');
  assert.ok(l1Wires.length > 0, 'Auto-route should create CKT-L1 (Lighting) wires');
  for (const w of l1Wires) {
    assert.equal(w.productId, pricedCable.id);
    assert.equal(w.unitPricePerM, 52.25);
    assert.equal(w.gstPercent, 18);
    assert.equal(w.manufacturer, 'Polycab');
    assert.equal(w.modelNumber, 'POL-FRLSH-2.5');
    assert.equal(w.datasheetUrl, 'https://polycab.com/datasheets/frlsh-25.pdf');
  }

  const p1Wires = (project.wires ?? []).filter((w) => w.circuit === 'CKT-P1 (Kitchen)');
  for (const w of p1Wires) {
    assert.equal(w.unitPricePerM, null);
    assert.equal(w.gstPercent, null);
  }

  // Update pricing via applyCircuitCableConfigToProject
  project = applyCircuitCableConfigToProject(project, 'CKT-L1 (Lighting)', {
    unitPricePerM: 60,
    gstPercent: 12,
  });
  assert.equal((project.wires ?? []).find((w) => w.circuit === 'CKT-L1 (Lighting)')?.unitPricePerM, 60);
  assert.equal((project.wires ?? []).find((w) => w.circuit === 'CKT-L1 (Lighting)')?.gstPercent, 12);

  // Duplicate floor preserves cable pricing & GST
  const dup = duplicateFloorInProject(project, 1);
  const dupL1Wire = (dup.project.wires ?? []).find(
    (w) => w.floor === dup.newFloor && w.circuit === 'CKT-L1 (Lighting)'
  );
  if (dupL1Wire) {
    assert.equal(dupL1Wire.unitPricePerM, 60);
    assert.equal(dupL1Wire.gstPercent, 12);
    assert.equal(dupL1Wire.productId, pricedCable.id);
  }

  // Save & reload preserves cable fields
  projectStorage.saveAll([project]);
  const reloaded = projectStorage.loadAll()[0];
  assert.equal(reloaded.circuitCableConfigs?.['CKT-L1 (Lighting)']?.unitPricePerM, 60);
  assert.equal(reloaded.circuitCableConfigs?.['CKT-L1 (Lighting)']?.gstPercent, 12);

  // BOQ computation preserves priced cable totals & GST and keeps unpriced cable as null (never fabricated!)
  const boq = computeReconciledBoq(reloaded);
  const pricedBoqRow = boq.rows.find(
    (r) => r.productCategory === 'Cables & Wires' && r.model === 'POL-FRLSH-2.5'
  );
  assert.ok(pricedBoqRow, 'BOQ must include priced Polycab cable row');
  assert.equal(pricedBoqRow.unitPrice, 60);
  assert.equal(pricedBoqRow.gstPercent, 12);
  assert.equal(pricedBoqRow.priceSource, 'catalogue');
  assert.ok(pricedBoqRow.gstAmount !== null && pricedBoqRow.gstAmount > 0);
  assert.ok(pricedBoqRow.total !== null && pricedBoqRow.total > 0);

  const unpricedBoqRow = boq.rows.find(
    (r) => r.productCategory === 'Cables & Wires' && r.model === 'FIN-4.0'
  );
  if (unpricedBoqRow) {
    assert.equal(unpricedBoqRow.unitPrice, null);
    assert.equal(unpricedBoqRow.gstPercent, null);
    assert.equal(unpricedBoqRow.total, null);
    assert.equal(unpricedBoqRow.priceSource, 'missing');
  }
});

// ============================================================================
// H. Product Catalogue URL Security
// ============================================================================
test('H. URL validation accepts safe https/http URLs and rejects dangerous schemes, protocol-relative URLs, embedded credentials, and control characters', () => {
  installMockLocalStorage();

  // Accepted
  assert.equal(validateSafeUrl('', 'Image URL').valid, true);
  assert.equal(validateSafeUrl('https://polycab.com/products/wire.pdf', 'Datasheet URL').valid, true);
  assert.equal(validateSafeUrl('http://example.com/spec.html', 'Manufacturer URL').valid, true);
  assert.equal(
    sanitizeSafeUrl('  https://havells.com/catalog?id=42#specs  '),
    'https://havells.com/catalog?id=42#specs'
  );

  // Rejected
  const dangerous = [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(document.cookie)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'blob:https://example.com/uuid',
    '//evil.example.com/payload.js',
    'https://user:pass@example.com/secret',
    'https://example.com/\nnewline',
    'not-a-valid-url',
  ];
  for (const bad of dangerous) {
    const res = validateSafeUrl(bad, 'Test URL');
    assert.equal(res.valid, false, `Expected "${bad}" to be rejected`);
    assert.equal(sanitizeSafeUrl(bad), undefined, `Expected sanitizeSafeUrl("${bad}") -> undefined`);
  }

  // Verify storage strips unsafe URLs while preserving safe URLs on load/save
  const rawStored: ProductCatalogueItem[] = [
    createSampleCableProduct({
      id: 'stored-mixed',
      imageUrl: 'javascript:alert(1)',
      datasheetUrl: 'https://polycab.com/safe.pdf',
      manufacturerUrl: 'data:text/html,bad',
    }),
  ];
  localStorage.setItem('blue_space_product_catalogue_v1', JSON.stringify(rawStored));
  const loaded = loadCatalogueProducts();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].imageUrl, undefined);
  assert.equal(loaded[0].datasheetUrl, 'https://polycab.com/safe.pdf');
  assert.equal(loaded[0].manufacturerUrl, undefined);

  saveCatalogueProducts(rawStored);
  const reloaded = loadCatalogueProducts();
  assert.equal(reloaded[0].imageUrl, undefined);
  assert.equal(reloaded[0].datasheetUrl, 'https://polycab.com/safe.pdf');
});

// ============================================================================
// I. Spreadsheet Security, Validation & 6-Sheet BOQ Round-Trip
// ============================================================================
test('I1. Excel BOQ exports all 6 reconciled sheets using write-excel-file, neutralizes formulas, and reads back cleanly via read-excel-file', async () => {
  const base = createSampleProject();
  const cable = createSampleCableProduct({ unitPrice: 48, gstPercent: 18 });
  const dangerousProject: ProjectData = withAutoRoutedWires(
    assignCatalogueCableToCircuit(
      {
        ...base,
        name: '=HYPERLINK("https://evil.test","Click")',
      },
      cable,
      'CKT-L1 (Lighting)'
    )
  );

  const defs = buildExcelBoqSheets(dangerousProject);
  assert.deepEqual(
    defs.map((d) => d.name),
    [
      'Consolidated BOQ',
      'Category Subtotals',
      'Floor-Wise BOQ',
      'Cable & Wiring Schedule',
      'Circuit & DB Schedule',
      'Diagnostics',
    ]
  );

  const blob = await buildExcelBoqBlob(dangerousProject);
  assert.ok(blob.size > 0);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const parsedSheets = await readXlsxFile(bytes);

  assert.equal(parsedSheets.length, 6);
  assert.deepEqual(
    parsedSheets.map((s) => s.sheet),
    [
      'Consolidated BOQ',
      'Category Subtotals',
      'Floor-Wise BOQ',
      'Cable & Wiring Schedule',
      'Circuit & DB Schedule',
      'Diagnostics',
    ]
  );

  // Verify formula neutralization in Sheet 1 metadata cell
  const projectMetaCell = String(parsedSheets[0].data[1][0] ?? '');
  assert.ok(!projectMetaCell.startsWith('='), 'Sheet cell must never begin with active formula character');

  // Verify Cable & Wiring Schedule includes Rate / m (INR) and GST % values
  const cableSheet = parsedSheets[3].data;
  const cableHeader = cableSheet[1].map((v) => String(v ?? ''));
  assert.ok(cableHeader.includes('Rate / m (INR)'));
  assert.ok(cableHeader.includes('GST %'));
  const hasPricedRow = cableSheet.slice(2).some((row) => row.includes(48) && row.includes(18));
  assert.equal(hasPricedRow, true, 'Cable schedule must include configured rate (48) and GST % (18)');
});

test('I2. Product catalogue spreadsheet importer accepts valid .xlsx and .csv, neutralizes formulas, strips unsafe URLs, and rejects malicious/oversized/malformed files', async () => {
  // 1. Valid .xlsx created with write-excel-file
  const validXlsxBlob = await writeXlsxFile([
    {
      sheet: 'Catalogue',
      data: [
        [
          { value: 'Category', type: String },
          { value: 'Manufacturer', type: String },
          { value: 'Product Name', type: String },
          { value: 'Model Number', type: String },
          { value: 'Cable Size (sq.mm)', type: String },
          { value: 'Unit Price', type: String },
          { value: 'GST %', type: String },
          { value: 'Datasheet URL', type: String },
        ],
        [
          { value: 'Cables & Wires', type: String },
          { value: 'Polycab', type: String },
          { value: 'Polycab 1.5 sq.mm Wire', type: String },
          { value: 'POL-1.5', type: String },
          { value: 1.5, type: Number },
          { value: 28.5, type: Number },
          { value: 18, type: Number },
          { value: 'https://polycab.com/15.pdf', type: String },
        ],
        [
          { value: 'Switches', type: String },
          { value: 'Legrand', type: String },
          { value: '=CMD("evil")', type: String },
          { value: 'LEG-01', type: String },
          null,
          { value: 190, type: Number },
          { value: 18, type: Number },
          { value: 'javascript:alert(1)', type: String },
        ],
      ],
    },
  ]).toBlob();

  const validXlsxBytes = new Uint8Array(await validXlsxBlob.arrayBuffer());
  const xlsxImport = await parseCatalogueSpreadsheet(validXlsxBytes, {
    name: 'catalogue.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: validXlsxBytes.byteLength,
  });
  assert.equal(xlsxImport.items.length, 2);
  assert.equal(xlsxImport.items[0].unitPrice, 28.5);
  assert.equal(xlsxImport.items[0].gstPercent, 18);
  assert.equal(xlsxImport.items[0].datasheetUrl, 'https://polycab.com/15.pdf');
  assert.ok(xlsxImport.items[1].productName.startsWith("'=CMD"));
  assert.equal(xlsxImport.items[1].datasheetUrl, undefined);
  assert.ok(xlsxImport.errors.some((e) => /Datasheet URL/i.test(e)));

  // 2. Valid .csv import
  const csvText =
    'Category,Manufacturer,Product Name,Model Number,Unit Price,GST %,Image URL\n' +
    'Fans,Crompton,"Crompton Energion 1200mm, White",CROM-1200,3499,18,https://www.crompton.co.in/fan.png\n';
  const csvBytes = new TextEncoder().encode(csvText);
  const csvImport = await parseCatalogueSpreadsheet(csvBytes, {
    name: 'products.csv',
    type: 'text/csv',
    size: csvBytes.byteLength,
  });
  assert.equal(csvImport.items.length, 1);
  assert.equal(csvImport.items[0].productName, 'Crompton Energion 1200mm, White');
  assert.equal(csvImport.items[0].unitPrice, 3499);
  assert.equal(csvImport.items[0].gstPercent, 18);
  assert.equal(csvImport.errors.length, 0);

  // 3. Reject legacy .xls extension & OLE magic bytes
  const oleBytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  assert.equal(validateSpreadsheetUpload(oleBytes, { name: 'legacy.xls' }).ok, false);
  assert.equal(validateSpreadsheetUpload(oleBytes, { name: 'disguised.xlsx' }).ok, false);

  // 4. Reject macro .xlsm and unsupported .txt
  assert.equal(validateSpreadsheetUpload(validXlsxBytes, { name: 'macro.xlsm' }).ok, false);
  assert.equal(validateSpreadsheetUpload(csvBytes, { name: 'notes.txt' }).ok, false);

  // 5. Reject malformed binary masquerading as .xlsx
  const badXlsx = await parseCatalogueSpreadsheet(new Uint8Array([0x01, 0x02, 0x03, 0x04]), {
    name: 'corrupt.xlsx',
  });
  assert.equal(badXlsx.items.length, 0);
  assert.ok(badXlsx.errors.length > 0);

  // 6. Reject oversized file (> 5 MB)
  const oversizedCheck = validateSpreadsheetUpload(csvBytes, {
    name: 'huge.csv',
    size: SPREADSHEET_LIMITS.maxFileSizeBytes + 1,
  });
  assert.equal(oversizedCheck.ok, false);

  // 7. Reject > 5,000 rows
  const manyRowsCsv = ['Product Name', ...Array.from({ length: 5002 }, (_, i) => `Item ${i}`)].join('\n');
  const tooManyRows = await parseCatalogueSpreadsheet(new TextEncoder().encode(manyRowsCsv), {
    name: 'many.csv',
  });
  assert.equal(tooManyRows.items.length, 0);
  assert.ok(tooManyRows.errors.some((e) => /maximum allowed row count/i.test(e)));

  // 8. Reject > 50 columns
  const wideHeader = Array.from({ length: 52 }, (_, i) => `Col${i}`).join(',') + '\n' + 'v,'.repeat(51) + 'v';
  const tooWide = await parseCatalogueSpreadsheet(new TextEncoder().encode(wideHeader), {
    name: 'wide.csv',
  });
  assert.equal(tooWide.items.length, 0);
  assert.ok(tooWide.errors.some((e) => /maximum allowed column count/i.test(e)));

  // 9. Reject prototype-pollution headers
  const protoCsv = new TextEncoder().encode('__proto__,Product Name\npolluted,Valid Product\n');
  const protoRes = await parseCatalogueSpreadsheet(protoCsv, { name: 'proto.csv' });
  assert.equal(protoRes.items.length, 0);
  assert.ok(protoRes.errors.some((e) => /prohibited column header/i.test(e)));

  // 10. Reject missing expected headers
  const badHeadersCsv = new TextEncoder().encode('Foo,Bar\n1,2\n');
  const badHeadersRes = await parseCatalogueSpreadsheet(badHeadersCsv, { name: 'bad.csv' });
  assert.equal(badHeadersRes.items.length, 0);
  assert.ok(badHeadersRes.errors.length > 0);

  // 11. Reject negative price and out-of-range GST
  const badNumsCsv = new TextEncoder().encode(
    'Product Name,Unit Price,GST %\nNeg Price,-100,18\nBad GST,100,150\n'
  );
  const badNumsRes = await parseCatalogueSpreadsheet(badNumsCsv, { name: 'badnums.csv' });
  assert.equal(badNumsRes.items.length, 0);
  assert.equal(badNumsRes.errors.length, 2);
});

// ============================================================================
// J. Employee Registration Conflict Handling
// ============================================================================
test('J. Registration conflict handling maps duplicate email, username, employee ID, and Postgres 23505 clearly and never returns ok: true on failure', async () => {
  // Direct error mapping tests
  const emailDup = mapSignUpError('User already registered', 'user_already_exists');
  assert.match(emailDup.error, /email address already exists/i);
  assert.ok(emailDup.fieldErrors.email);

  const usernameDup = mapSignUpError(
    'duplicate key value violates unique constraint "employee_profiles_username_key"',
    '23505'
  );
  assert.match(usernameDup.error, /username is already taken/i);
  assert.ok(usernameDup.fieldErrors.username);

  const empIdDup = mapSignUpError(
    'duplicate key value violates unique constraint "employee_profiles_employee_id_key"',
    '23505'
  );
  assert.match(empIdDup.error, /employee id is already registered/i);
  assert.ok(empIdDup.fieldErrors.employeeId);

  const genericTriggerFail = mapSignUpError('Database error saving new user');
  assert.match(genericTriggerFail.error, /email address, username, or employee id/i);

  // Mocked Supabase client returning duplicate email via empty identities array (Supabase anti-enumeration behavior)
  const fakeDupIdentitiesClient = {
    rpc: async () => ({ data: null, error: { code: '42883', message: 'function not found' } }),
    auth: {
      signUp: async () => ({
        data: { user: { id: 'u-1', email: 'dup@company.com', identities: [] }, session: null },
        error: null,
      }),
    },
  } as unknown as SupabaseClient;

  const regInput = {
    fullName: 'Test Engineer',
    username: 'test_eng',
    employeeId: 'EMP-9001',
    email: 'dup@company.com',
    mobile: '+91 9876543210',
    password: 'StrongPassword1',
    confirmPassword: 'StrongPassword1',
  };

  const dupEmailRes = await registerEmployee(regInput, fakeDupIdentitiesClient);
  assert.equal(dupEmailRes.ok, false);
  assert.ok(dupEmailRes.fieldErrors?.email);

  // Mocked Supabase client failing with database trigger unique constraint error
  const fakeTriggerErrorClient = {
    rpc: async () => ({ data: null, error: { code: '42883', message: 'function not found' } }),
    auth: {
      signUp: async () => ({
        data: { user: null, session: null },
        error: {
          message: 'duplicate key value violates unique constraint "employee_profiles_username_key"',
          code: '23505',
        },
      }),
    },
  } as unknown as SupabaseClient;

  const dupUserRes = await registerEmployee(regInput, fakeTriggerErrorClient);
  assert.equal(dupUserRes.ok, false);
  assert.ok(dupUserRes.fieldErrors?.username);
});

// ============================================================================
// K. Password Recovery Strength Validation & Recovery Session Verification
// ============================================================================
test('K. Password reset enforces full password strength rules and requires a valid recovery session', async () => {
  // Weak passwords rejected
  const noUpper = validateResetPasswordInput('lowercase1', 'lowercase1');
  assert.equal(noUpper.valid, false);
  assert.ok(noUpper.fieldErrors.password);

  const noLower = validateResetPasswordInput('UPPERCASE1', 'UPPERCASE1');
  assert.equal(noLower.valid, false);
  assert.ok(noLower.fieldErrors.password);

  const noDigit = validateResetPasswordInput('NoNumbersHere', 'NoNumbersHere');
  assert.equal(noDigit.valid, false);
  assert.ok(noDigit.fieldErrors.password);

  const tooShort = validateResetPasswordInput('Ab1', 'Ab1');
  assert.equal(tooShort.valid, false);
  assert.ok(tooShort.fieldErrors.password);

  // Mismatch rejected
  const mismatch = validateResetPasswordInput('StrongPass1', 'StrongPass2');
  assert.equal(mismatch.valid, false);
  assert.ok(mismatch.fieldErrors.confirmPassword);

  // Strong matching password accepted
  const strong = validateResetPasswordInput('StrongPass1', 'StrongPass1');
  assert.equal(strong.valid, true);
  assert.deepEqual(strong.fieldErrors, {});

  // Missing/expired session rejected by updateUserPassword
  const noSessionClient = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      updateUser: async () => ({ data: { user: null }, error: null }),
    },
  } as unknown as SupabaseClient;

  const noSessRes = await updateUserPassword('StrongPass1', 'StrongPass1', noSessionClient);
  assert.equal(noSessRes.ok, false);
  assert.match(noSessRes.error ?? '', /missing or expired/i);
});

// ============================================================================
// L. CSV Formula Injection Protection
// ============================================================================
test('L. CSV security neutralizes formula prefixes (even after whitespace/control chars) while keeping real numbers and normal text intact', () => {
  assert.equal(
    sanitizeCsvTextValue('=HYPERLINK("http://evil.test","click")'),
    '\'=HYPERLINK("http://evil.test","click")'
  );
  assert.equal(sanitizeCsvTextValue('+SUM(A1:A5)'), "'+SUM(A1:A5)");
  assert.equal(sanitizeCsvTextValue('-1+1'), "'-1+1");
  assert.equal(sanitizeCsvTextValue('@SUM(1+1)'), "'@SUM(1+1)");
  assert.equal(sanitizeCsvTextValue('  =1+1'), "'  =1+1");
  assert.equal(sanitizeCsvTextValue('\t=1+1'), "'\t=1+1");
  assert.equal(sanitizeCsvTextValue('\r=1+1'), "'\r=1+1");
  assert.equal(sanitizeCsvTextValue('Polycab 2.5 sq.mm'), 'Polycab 2.5 sq.mm');

  // Real numeric values remain numeric (unprefixed)
  assert.equal(formatSafeCsvCell(42), '42');
  assert.equal(formatSafeCsvCell(-12.5), '-12.5');
  assert.equal(formatSafeCsvCell(0), '0');

  // Quotes and commas properly escaped
  const row = formatSafeCsvRow(['=1+1', 'Living, "Main" Room', -5.5, 'Normal']);
  assert.equal(row, `"'=1+1","Living, ""Main"" Room",-5.5,"Normal"`);
});

// ============================================================================
// M. Three.js Resource Cleanup & Shared Texture Preservation
// ============================================================================
test('M. buildArchitecturalScene tracks and disposes all geometries and materials across repeated rebuild cycles without disposing caller-owned shared textures', () => {
  const project = withAutoRoutedWires(createSampleProject());
  const { textures, getDisposeCalls } = createMockTextureSet();

  for (let i = 0; i < 6; i += 1) {
    const built = buildArchitecturalScene(
      project,
      textures,
      null,
      i % 2 === 0 ? 'daylight' : 'evening',
      i % 2 === 1,
      false,
      1,
      'all',
      undefined
    );

    assert.ok(built.resourceStats.trackedGeometries > 0, 'Must track created geometries');
    assert.ok(built.resourceStats.trackedMaterials > 0, 'Must track created materials');
    assert.equal(built.resourceStats.disposed, false);

    built.dispose();

    assert.equal(built.resourceStats.disposed, true);
    assert.equal(built.resourceStats.disposedGeometries, built.resourceStats.trackedGeometries);
    assert.equal(built.resourceStats.disposedMaterials, built.resourceStats.trackedMaterials);

    // Idempotent second dispose call does not throw
    built.dispose();
  }

  // Caller-owned shared textures must NOT have been disposed by scene rebuilds
  assert.equal(getDisposeCalls(), 0, 'Scene dispose must never dispose caller-owned shared textures');
  textures.dispose();
  assert.equal(getDisposeCalls(), 4);
});

// ============================================================================
// N. Top-Level React ErrorBoundary Behavior
// ============================================================================
test('N. ErrorBoundary captures uncaught render errors via getDerivedStateFromError', () => {
  const err = new Error('Simulated fatal render error');
  const nextState = ErrorBoundary.getDerivedStateFromError(err);
  assert.equal(nextState.hasError, true);
  assert.equal(nextState.errorMessage, 'Simulated fatal render error');
});

// ============================================================================
// O. Native .bluespace & JSON Round-Trip Backward Compatibility
// ============================================================================
test('O. Existing project save/reload and .bluespace / JSON export-import round-trip preserve all fields including cable pricing and GST', () => {
  installMockLocalStorage();
  const base = createSampleProject();
  const cable = createSampleCableProduct({ unitPrice: 55.5, gstPercent: 18 });
  const enriched = withAutoRoutedWires(
    assignCatalogueCableToCircuit(base, cable, 'CKT-L1 (Lighting)')
  );

  const nativeJson = projectStorage.exportNativeBluespace(enriched);
  const preview = projectStorage.parseNativeProjectFile(nativeJson);
  assert.ok(preview);
  assert.match(preview.formatLabel, /\.bluespace/i);

  const parsed = projectStorage.parseImportedJson(nativeJson);
  assert.ok(parsed);
  assert.equal(parsed.rooms.length, enriched.rooms.length);
  assert.equal(parsed.points.length, enriched.points.length);
  assert.equal(parsed.circuitCableConfigs?.['CKT-L1 (Lighting)']?.unitPricePerM, 55.5);
  assert.equal(parsed.circuitCableConfigs?.['CKT-L1 (Lighting)']?.gstPercent, 18);
  const wireL1 = (parsed.wires ?? []).find((w) => w.circuit === 'CKT-L1 (Lighting)');
  assert.ok(wireL1);
  assert.equal(wireL1.unitPricePerM, 55.5);
  assert.equal(wireL1.gstPercent, 18);

  // Also test standard JSON export/import round-trip
  const exportedJson = projectStorage.exportProjectJson(enriched);
  const parsedJson = projectStorage.parseImportedJson(exportedJson);
  assert.ok(parsedJson);
  assert.equal(parsedJson.circuitCableConfigs?.['CKT-L1 (Lighting)']?.unitPricePerM, 55.5);
  assert.equal(parsedJson.circuitCableConfigs?.['CKT-L1 (Lighting)']?.gstPercent, 18);
});

// ============================================================================
// Async Test Runner
// ============================================================================
async function main() {
  let passed = 0;
  let failed = 0;

  for (const tc of tests) {
    try {
      await tc.run();
      passed += 1;
      console.log(`PASS  ${tc.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL  ${tc.name}`);
      console.error(err);
    }
  }

  console.log(`\nPhase 1 Remediation Tests: ${passed}/${tests.length} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

void main();
