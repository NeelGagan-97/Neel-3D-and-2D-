import * as THREE from 'three';
import { siteToMeters } from '../data/presets';
import {
  ElectricalItemType,
  ElectricalPoint,
  FloorLevelConfig,
  FloorView3DMode,
  FurnitureItem,
  LightingMode,
  ProjectData,
  StaircaseItem,
} from '../types/design';
import {
  DEFAULT_SLAB_THICKNESS_M,
  getFloorBoundaryMeters,
  getFloorElevationM,
  getProjectFloors,
  getWiringConfig,
} from '../utils/buildingWiring';
import { ArchitecturalTextureSet } from './proceduralTextures';
import { extractMergedWalls, getItemFloor, sliceProjectForFloor } from '../utils/geometry';

export const STORY_SLAB_THICKNESS = DEFAULT_SLAB_THICKNESS_M;
export const EXPLODED_FLOOR_GAP_M = 2.6;

export interface ElectricalVisibilityState {
  all: boolean;
  fans: boolean;
  acs: boolean;
  switchboards: boolean;
  panels: boolean;
  sockets: boolean;
  geysers: boolean;
  other: boolean;
  wiring: boolean;
}

export type ElectricalSymbolGroupKey =
  | 'fans'
  | 'acs'
  | 'switchboards'
  | 'panels'
  | 'sockets'
  | 'geysers'
  | 'other';

export type ElectricalVisibilityToggleGroup = ElectricalSymbolGroupKey | 'wiring';

export const DEFAULT_ELECTRICAL_VISIBILITY: ElectricalVisibilityState = {
  all: true,
  fans: true,
  acs: true,
  switchboards: true,
  panels: true,
  sockets: true,
  geysers: true,
  other: true,
  wiring: true,
};

/**
 * Dedicated Three.js overlay layer strictly for electrical annotations, symbol highlight overlays,
 * and wiring visualization lines. Physical 3D products (fans, ACs, switchboards, sockets, panels,
 * geysers, lights, DBs, and building geometry) are NEVER placed inside these groups.
 */
export interface ElectricalAnnotationHandles {
  root: THREE.Group;
  symbols: Record<ElectricalSymbolGroupKey, THREE.Group>;
  wiring: THREE.Group;
}

export function classifyElectricalSymbolGroup(
  itemType: ElectricalItemType
): ElectricalSymbolGroupKey {
  if (itemType === 'ceiling_fan' || itemType === 'exhaust_fan') return 'fans';
  if (itemType === 'split_ac') return 'acs';
  if (itemType === 'switchboard' || itemType === 'switch') return 'switchboards';
  if (itemType === 'panel_light' || itemType === 'distribution_board') return 'panels';
  if (itemType === 'socket_5a' || itemType === 'socket_16a' || itemType === 'usb_outlet') {
    return 'sockets';
  }
  if (itemType === 'geyser') return 'geysers';
  return 'other';
}

export function isElectricalPointVisible(
  itemType: ElectricalItemType,
  visibility: ElectricalVisibilityState
): boolean {
  if (!visibility.all) return false;
  const group = classifyElectricalSymbolGroup(itemType);
  return visibility[group];
}

/**
 * Master toggle hides/shows all electrical symbols, floating labels, and wiring overlays
 * while strictly preserving every individual group's ON/OFF state.
 */
export function toggleMasterElectricalVisibility(
  prev: ElectricalVisibilityState,
  enabled?: boolean
): ElectricalVisibilityState {
  const nextAll = enabled ?? !prev.all;
  return {
    ...prev,
    all: nextAll,
  };
}

/**
 * Toggles a single electrical symbol/wiring overlay group without affecting physical 3D products
 * or other groups' visibility states.
 */
export function toggleElectricalVisibilityGroup(
  prev: ElectricalVisibilityState,
  group: ElectricalVisibilityToggleGroup,
  enabled?: boolean
): ElectricalVisibilityState {
  const nextValue = enabled ?? !prev[group];
  return {
    ...prev,
    [group]: nextValue,
  };
}

/**
 * Applies group-based electrical visibility instantaneously to the dedicated electrical annotation
 * and wiring overlay groups ONLY — never modifying physical 3D appliance or building meshes.
 */
export function applyElectricalVisibilityToScene(
  built: BuiltSceneHandles | null | undefined,
  visibility: ElectricalVisibilityState
): void {
  if (!built?.electricalAnnotations) return;
  const { root, symbols, wiring } = built.electricalAnnotations;
  root.visible = visibility.all;
  symbols.fans.visible = visibility.fans;
  symbols.acs.visible = visibility.acs;
  symbols.switchboards.visible = visibility.switchboards;
  symbols.panels.visible = visibility.panels;
  symbols.sockets.visible = visibility.sockets;
  symbols.geysers.visible = visibility.geysers;
  symbols.other.visible = visibility.other;
  wiring.visible = visibility.wiring;
}

export interface SceneResourceStats {
  trackedGeometries: number;
  trackedMaterials: number;
  disposedGeometries: number;
  disposedMaterials: number;
  disposed: boolean;
}

export interface BuiltSceneHandles {
  root: THREE.Group;
  clickables: THREE.Object3D[];
  fanRotors: THREE.Object3D[];
  pointAnchors: Map<string, THREE.Vector3>;
  /** Physical 3D electrical product meshes (always visible regardless of annotation toggles) */
  physicalProducts: THREE.Object3D[];
  /** Dedicated electrical annotation & wiring overlay groups (controlled by visibility toggles) */
  electricalAnnotations: ElectricalAnnotationHandles;
  dispose: () => void;
  resourceStats: SceneResourceStats;
}

interface SceneResourceTracker {
  trackGeo: <T extends THREE.BufferGeometry>(geo: T) => T;
  trackMat: <T extends THREE.Material>(mat: T) => T;
  disposeAll: (root: THREE.Object3D) => void;
  stats: SceneResourceStats;
}

function createSceneResourceTracker(): SceneResourceTracker {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const stats: SceneResourceStats = {
    trackedGeometries: 0,
    trackedMaterials: 0,
    disposedGeometries: 0,
    disposedMaterials: 0,
    disposed: false,
  };

  const trackGeo = <T extends THREE.BufferGeometry>(geo: T): T => {
    if (!geometries.has(geo)) {
      geometries.add(geo);
      stats.trackedGeometries = geometries.size;
    }
    return geo;
  };

  const trackMat = <T extends THREE.Material>(mat: T): T => {
    if (!materials.has(mat)) {
      materials.add(mat);
      stats.trackedMaterials = materials.size;
    }
    return mat;
  };

  const disposeAll = (root: THREE.Object3D) => {
    if (stats.disposed) return;
    stats.disposed = true;

    const disposedGeos = new Set<THREE.BufferGeometry>();
    const disposedMats = new Set<THREE.Material>();

    const disposeGeo = (geo: THREE.BufferGeometry | null | undefined) => {
      if (!geo || disposedGeos.has(geo)) return;
      disposedGeos.add(geo);
      geo.dispose();
    };

    const disposeMat = (mat: THREE.Material | null | undefined) => {
      if (!mat || disposedMats.has(mat)) return;
      disposedMats.add(mat);
      // Do NOT dispose caller-owned shared textures (wood/tile/terrazzo/stone);
      // Viewport3D owns and disposes ArchitecturalTextureSet on teardown.
      mat.dispose();
    };

    // 1. Traverse scene graph to catch any geometry/material attached to meshes or line segments
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments || obj instanceof THREE.Line) {
        disposeGeo(obj.geometry);
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => disposeMat(m));
        } else {
          disposeMat(obj.material);
        }
      }
    });

    // 2. Dispose ALL tracked geometries & materials — including unused pool materials or detached items
    geometries.forEach((geo) => disposeGeo(geo));
    materials.forEach((mat) => disposeMat(mat));

    stats.disposedGeometries = disposedGeos.size;
    stats.disposedMaterials = disposedMats.size;
    geometries.clear();
    materials.clear();
  };

  return { trackGeo, trackMat, disposeAll, stats };
}

/**
 * Helper to create a composite furniture group pivoted cleanly at y = 0 (floor level)
 */
function buildFurnitureGroup(item: FurnitureItem, tracker: SceneResourceTracker): THREE.Group {
  const g = new THREE.Group();
  const { trackGeo, trackMat } = tracker;

  const w = item.width;
  const d = item.depth;

  if (item.kind === 'sofa') {
    const fabricMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.88, metalness: 0.0 }));
    const cushionMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.85, metalness: 0.0 }));
    const accentMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.78, metalness: 0.0 }));
    const marbleMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.25, metalness: 0.1 }));
    const darkMetal = trackMat(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.35, metalness: 0.75 }));

    // Base frame
    const base = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, 0.28, d * 0.65)), fabricMat);
    base.position.set(0, 0.22, -d * 0.15);
    base.castShadow = true;
    base.receiveShadow = true;
    g.add(base);

    // Backrest
    const back = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, 0.52, 0.22)), fabricMat);
    back.position.set(0, 0.56, -d * 0.42);
    back.castShadow = true;
    g.add(back);

    // Armrests (share single tracked geometry)
    const armGeo = trackGeo(new THREE.BoxGeometry(0.18, 0.42, d * 0.65));
    const armL = new THREE.Mesh(armGeo, fabricMat);
    armL.position.set(-w / 2 + 0.09, 0.44, -d * 0.15);
    const armR = new THREE.Mesh(armGeo, fabricMat);
    armR.position.set(w / 2 - 0.09, 0.44, -d * 0.15);
    g.add(armL, armR);

    // Seat cushions (3)
    const cW = (w - 0.42) / 3;
    const cushionGeo = trackGeo(new THREE.BoxGeometry(cW - 0.03, 0.14, d * 0.52));
    for (let i = 0; i < 3; i++) {
      const c = new THREE.Mesh(cushionGeo, cushionMat);
      c.position.set(-w / 2 + 0.21 + cW * (i + 0.5), 0.42, -d * 0.1);
      g.add(c);
    }

    // Accent throw pillow
    const pillow = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.32, 0.28, 0.12)), accentMat);
    pillow.position.set(-w / 2 + 0.38, 0.58, -d * 0.26);
    pillow.rotation.z = 0.18;
    g.add(pillow);

    // Coffee table in front
    const tableTop = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w * 0.52, 0.06, 0.55)), marbleMat);
    tableTop.position.set(0, 0.38, d * 0.42);
    tableTop.castShadow = true;
    const tableBase = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w * 0.42, 0.34, 0.42)), darkMetal);
    tableBase.position.set(0, 0.17, d * 0.42);
    g.add(tableTop, tableBase);
  } else if (item.kind === 'bed') {
    const woodMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x5c3d28, roughness: 0.65, metalness: 0.05 }));
    const fabricMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.88, metalness: 0.0 }));
    const cushionMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.85, metalness: 0.0 }));
    const accentMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.78, metalness: 0.0 }));
    const linenMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.9, metalness: 0.0 }));

    // Platform bed frame
    const frame = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, 0.26, d)), woodMat);
    frame.position.set(0, 0.15, 0);
    frame.castShadow = true;
    frame.receiveShadow = true;
    g.add(frame);

    // Upholstered headboard
    const head = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w + 0.12, 0.95, 0.14)), fabricMat);
    head.position.set(0, 0.52, -d / 2 + 0.07);
    head.castShadow = true;
    g.add(head);

    // Mattress + Duvet
    const mattress = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w - 0.08, 0.22, d - 0.16)), linenMat);
    mattress.position.set(0, 0.38, 0.04);
    g.add(mattress);

    const duvet = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w - 0.04, 0.08, d * 0.58)), cushionMat);
    duvet.position.set(0, 0.5, d * 0.18);
    g.add(duvet);

    // Two pillows
    const pillowGeo = trackGeo(new THREE.BoxGeometry(w * 0.36, 0.12, 0.36));
    const p1 = new THREE.Mesh(pillowGeo, accentMat);
    p1.position.set(-w * 0.23, 0.54, -d / 2 + 0.36);
    const p2 = new THREE.Mesh(pillowGeo, accentMat);
    p2.position.set(w * 0.23, 0.54, -d / 2 + 0.36);
    g.add(p1, p2);
  } else if (item.kind === 'dining-table') {
    const woodMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x5c3d28, roughness: 0.65, metalness: 0.05 }));
    const cushionMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.85, metalness: 0.0 }));
    const darkMetal = trackMat(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.35, metalness: 0.75 }));

    const top = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, 0.07, d)), woodMat);
    top.position.set(0, 0.76, 0);
    top.castShadow = true;
    g.add(top);
    const legGeo = trackGeo(new THREE.CylinderGeometry(0.035, 0.03, 0.74, 8));
    const legOffsets = [
      [-w / 2 + 0.1, -d / 2 + 0.1],
      [w / 2 - 0.1, -d / 2 + 0.1],
      [-w / 2 + 0.1, d / 2 - 0.1],
      [w / 2 - 0.1, d / 2 - 0.1],
    ];
    legOffsets.forEach(([lx, lz]) => {
      const leg = new THREE.Mesh(legGeo, darkMetal);
      leg.position.set(lx, 0.37, lz);
      g.add(leg);
    });
    // 4 dining chairs
    const seatGeo = trackGeo(new THREE.BoxGeometry(0.42, 0.06, 0.42));
    const backGeo = trackGeo(new THREE.BoxGeometry(0.42, 0.42, 0.05));
    [-0.4, 0.4].forEach((cx) => {
      [-d / 2 - 0.26, d / 2 + 0.26].forEach((cz) => {
        const seat = new THREE.Mesh(seatGeo, cushionMat);
        seat.position.set(cx, 0.46, cz);
        const back = new THREE.Mesh(backGeo, woodMat);
        back.position.set(cx, 0.68, cz + (cz > 0 ? 0.18 : -0.18));
        g.add(seat, back);
      });
    });
  } else if (item.kind === 'kitchen-counter') {
    const fabricMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.88, metalness: 0.0 }));
    const marbleMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.25, metalness: 0.1 }));
    const darkMetal = trackMat(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.35, metalness: 0.75 }));
    const sinkMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.2, metalness: 0.85 }));

    const cabinet = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, 0.84, d)), fabricMat);
    cabinet.position.set(0, 0.42, 0);
    cabinet.castShadow = true;
    cabinet.receiveShadow = true;
    const countertop = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w + 0.04, 0.06, d + 0.04)), marbleMat);
    countertop.position.set(0, 0.87, 0);
    // Hob cooktop + sink basin
    const hob = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w * 0.65, 0.02, 0.68)), darkMetal);
    hob.position.set(0, 0.91, -d * 0.22);
    const sink = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w * 0.62, 0.03, 0.56)), sinkMat);
    sink.position.set(0, 0.905, d * 0.24);
    g.add(cabinet, countertop, hob, sink);
  } else if (item.kind === 'tv-unit') {
    const woodMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x5c3d28, roughness: 0.65, metalness: 0.05 }));
    const darkMetal = trackMat(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.35, metalness: 0.75 }));

    const consoleBox = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, 0.45, d)), woodMat);
    consoleBox.position.set(0, 0.24, 0);
    const screen = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.06, 0.72, d * 0.68)), darkMetal);
    screen.position.set(-w * 0.1, 1.08, 0);
    g.add(consoleBox, screen);
  } else {
    // Vanity / Desk
    const woodMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x5c3d28, roughness: 0.65, metalness: 0.05 }));
    const marbleMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.25, metalness: 0.1 }));
    const mirrorMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x93c5fd, roughness: 0.08, metalness: 0.92 }));

    const cab = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, 0.78, d)), woodMat);
    cab.position.set(0, 0.39, 0);
    const top = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w + 0.04, 0.05, d + 0.04)), marbleMat);
    top.position.set(0, 0.81, 0);
    const mirror = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w * 0.75, 0.72, 0.03)), mirrorMat);
    mirror.position.set(0, 1.48, -d * 0.42);
    g.add(cab, top, mirror);
  }

  return g;
}

/**
 * Composite 3–8 part procedural electrical fixture model
 */
function buildElectricalFixture(
  pt: ElectricalPoint,
  isSelected: boolean,
  lightingMode: LightingMode,
  isSoftwareGl: boolean,
  fanRotors: THREE.Object3D[],
  tracker: SceneResourceTracker
): THREE.Group {
  const group = new THREE.Group();
  const { trackGeo, trackMat } = tracker;
  const isEvening = lightingMode === 'evening' || lightingMode === 'sunset';

  const metalBody = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      roughness: 0.28,
      metalness: 0.68,
    })
  );
  const darkMetal = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.35,
      metalness: 0.75,
    })
  );
  const electricBlueMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x00a8ff,
      emissive: new THREE.Color(0x00a8ff),
      emissiveIntensity: isSelected ? 1.1 : 0.35,
      roughness: 0.25,
      metalness: 0.4,
    })
  );
  const amberMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xff9d00,
      emissive: new THREE.Color(0xff9d00),
      emissiveIntensity: isEvening ? 1.35 : 0.45,
      roughness: 0.22,
      metalness: 0.2,
    })
  );
  const warmGlowMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xfff7ed,
      emissive: new THREE.Color(isEvening ? 0xffb347 : 0xfef3c7),
      emissiveIntensity: isEvening ? 2.1 : 0.65,
      roughness: 0.15,
      metalness: 0.05,
    })
  );

  if (pt.itemType === 'ceiling_fan') {
    // Canopy + downrod
    const canopy = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.08, 0.11, 0.06, 12)), darkMetal);
    canopy.position.y = 0.26;
    const rod = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.018, 0.018, 0.28, 8)), darkMetal);
    rod.position.y = 0.12;
    group.add(canopy, rod);

    // Rotor assembly (hub + 3 angled blades)
    const rotor = new THREE.Group();
    const hub = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.13, 0.14, 0.07, 16)), metalBody);
    const hubTrim = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.07, 0.07, 0.08, 12)), electricBlueMat);
    rotor.add(hub, hubTrim);

    const bladeGeo = trackGeo(new THREE.BoxGeometry(0.54, 0.014, 0.11));
    for (let i = 0; i < 3; i++) {
      const bladeWrap = new THREE.Group();
      bladeWrap.rotation.y = (i * Math.PI * 2) / 3;
      const blade = new THREE.Mesh(bladeGeo, metalBody);
      blade.position.set(0.34, 0, 0);
      blade.rotation.x = 0.12;
      bladeWrap.add(blade);
      rotor.add(bladeWrap);
    }
    group.add(rotor);
    fanRotors.push(rotor);
  } else if (pt.itemType === 'exhaust_fan') {
    const frame = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.32, 0.32, 0.08)), darkMetal);
    const ring = new THREE.Mesh(trackGeo(new THREE.TorusGeometry(0.11, 0.018, 8, 18)), metalBody);
    ring.position.z = 0.04;
    const hub = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.04, 0.04, 0.06, 12)), amberMat);
    hub.rotation.x = Math.PI / 2;
    hub.position.z = 0.03;
    group.add(frame, ring, hub);
  } else if (pt.itemType === 'panel_light' || pt.itemType === 'led_light') {
    const bezel = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.34, 0.03, 0.34)), metalBody);
    const diffuser = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.28, 0.036, 0.28)), warmGlowMat);
    diffuser.position.y = -0.005;
    group.add(bezel, diffuser);
    if (isEvening && !isSoftwareGl) {
      const light = new THREE.PointLight(0xffd28a, 1.35, 4.8, 1.8);
      light.position.y = -0.18;
      group.add(light);
    }
  } else if (pt.itemType === 'spotlight') {
    const housing = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.075, 0.085, 0.09, 14)), darkMetal);
    const lens = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.058, 0.058, 0.02, 14)), warmGlowMat);
    lens.position.y = -0.045;
    group.add(housing, lens);
  } else if (pt.itemType === 'strip_light') {
    const channel = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.5, 0.04, 0.07)), darkMetal);
    const ledBar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.46, 0.035, 0.05)), amberMat);
    ledBar.position.y = -0.01;
    group.add(channel, ledBar);
  } else if (pt.itemType === 'chandelier') {
    const brass = trackMat(new THREE.MeshStandardMaterial({ color: 0xd9a05b, roughness: 0.22, metalness: 0.88 }));
    const stem = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.02, 0.02, 0.42, 8)), brass);
    stem.position.y = 0.2;
    const ring = new THREE.Mesh(trackGeo(new THREE.TorusGeometry(0.34, 0.022, 10, 24)), brass);
    ring.rotation.x = Math.PI / 2;
    group.add(stem, ring);
    const globeGeo = trackGeo(new THREE.SphereGeometry(0.065, 12, 12));
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI * 2) / 6;
      const globe = new THREE.Mesh(globeGeo, warmGlowMat);
      globe.position.set(Math.cos(a) * 0.34, -0.03, Math.sin(a) * 0.34);
      group.add(globe);
    }
    if (isEvening && !isSoftwareGl) {
      const light = new THREE.PointLight(0xffcb7d, 2.2, 6.5, 1.6);
      light.position.y = -0.15;
      group.add(light);
    }
  } else if (pt.itemType === 'split_ac') {
    const body = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.92, 0.28, 0.22)), metalBody);
    const louver = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.84, 0.05, 0.04)), darkMetal);
    louver.position.set(0, -0.09, 0.11);
    const indicator = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.12, 0.025, 0.02)), electricBlueMat);
    indicator.position.set(0.3, 0.04, 0.115);
    group.add(body, louver, indicator);
  } else if (pt.itemType === 'geyser') {
    const tank = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.18, 0.18, 0.56, 16)), metalBody);
    const capGeo = trackGeo(new THREE.CylinderGeometry(0.185, 0.185, 0.06, 16));
    const capTop = new THREE.Mesh(capGeo, darkMetal);
    capTop.position.y = 0.28;
    const capBot = new THREE.Mesh(capGeo, darkMetal);
    capBot.position.y = -0.28;
    const dial = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.04, 0.04, 0.03, 12)), amberMat);
    dial.rotation.x = Math.PI / 2;
    dial.position.set(0, -0.12, 0.18);
    group.add(tank, capTop, capBot, dial);
  } else if (pt.itemType === 'switchboard' || pt.itemType === 'switch') {
    const plate = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.24, 0.14, 0.03)), darkMetal);
    const trim = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.22, 0.12, 0.035)), electricBlueMat);
    const rockerGeo = trackGeo(new THREE.BoxGeometry(0.04, 0.06, 0.045));
    const rocker1 = new THREE.Mesh(rockerGeo, metalBody);
    rocker1.position.x = -0.05;
    const rocker2 = new THREE.Mesh(rockerGeo, metalBody);
    rocker2.position.x = 0.05;
    group.add(plate, trim, rocker1, rocker2);
  } else if (pt.itemType === 'distribution_board') {
    // Composite Distribution Board: metallic cabinet, recessed door bezel, MCB rail window, status LEDs, conduit collars
    const cabinet = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.42, 0.52, 0.14)), metalBody);
    const doorBezel = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.38, 0.46, 0.025)), darkMetal);
    doorBezel.position.z = 0.072;
    const mcbRail = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.3, 0.09, 0.02)), electricBlueMat);
    mcbRail.position.set(0, 0.06, 0.086);
    const rccbBar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.3, 0.07, 0.02)), amberMat);
    rccbBar.position.set(0, -0.07, 0.086);
    const statusLedMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x22c55e,
        emissive: new THREE.Color(0x22c55e),
        emissiveIntensity: 1.1,
      })
    );
    const statusLed = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.018, 10, 10)), statusLedMat);
    statusLed.position.set(0.13, 0.17, 0.09);
    const conduitGeo = trackGeo(new THREE.CylinderGeometry(0.024, 0.024, 0.14, 10));
    const topConduit = new THREE.Mesh(conduitGeo, darkMetal);
    topConduit.position.set(-0.08, 0.31, 0);
    const topConduit2 = new THREE.Mesh(conduitGeo, darkMetal);
    topConduit2.position.set(0.08, 0.31, 0);
    group.add(cabinet, doorBezel, mcbRail, rccbBar, statusLed, topConduit, topConduit2);
  } else if (pt.itemType === 'earthing_point') {
    // Composite Earthing Point: chamber cover, copper electrode collar, green/yellow PE bus clamp
    const earthGreenMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x22c55e,
        emissive: new THREE.Color(0x16a34a),
        emissiveIntensity: isSelected ? 1.1 : 0.45,
        roughness: 0.3,
        metalness: 0.25,
      })
    );
    const copperMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xd97706,
        roughness: 0.28,
        metalness: 0.85,
      })
    );
    const pitBase = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.34, 0.08, 0.34)), darkMetal);
    const pitLid = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.13, 0.14, 0.04, 18)), earthGreenMat);
    pitLid.position.y = 0.05;
    const copperRod = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.026, 0.026, 0.24, 12)), copperMat);
    copperRod.position.y = 0.14;
    const busClamp = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.16, 0.04, 0.06)), copperMat);
    busClamp.position.y = 0.2;
    group.add(pitBase, pitLid, copperRod, busClamp);
  } else {
    // Sockets, USB Outlets, Appliances
    const box = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.18, 0.16, 0.05)), darkMetal);
    const accent = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.12, 0.1, 0.056)),
      pt.itemType === 'socket_16a' || pt.itemType === 'appliance' ? amberMat : electricBlueMat
    );
    group.add(box, accent);
  }

  // Invisible generous raycast proxy box so clicking small switches/sockets is effortless
  const hitBox = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(0.65, 0.55, 0.65)),
    trackMat(new THREE.MeshBasicMaterial({ visible: false }))
  );
  hitBox.userData.pointId = pt.id;
  group.add(hitBox);

  group.traverse((child) => {
    child.userData.pointId = pt.id;
  });

  return group;
}

export interface SceneVisualOverlays {
  selectedIds?: Set<string>;
  highlightedIds?: Set<string>;
  activeHighlightId?: string | null;
}

/**
 * Composite multi-part 3D parametric staircase builder (Straight, L-shaped, U-shaped, Spiral).
 * Anchored at bottom-start (y = 0 on fromFloor) and mathematically scaled to totalRiseM so steps
 * land flush with the upper slab without floating or clipping.
 */
function buildStaircaseGroup(
  stair: StaircaseItem,
  totalRiseM: number,
  isSelected: boolean,
  tracker: SceneResourceTracker
): THREE.Group {
  const g = new THREE.Group();
  const { trackGeo, trackMat } = tracker;
  const rise = Math.max(1.8, totalRiseM);
  const steps = Math.max(4, Math.round(stair.steps));
  const stepRise = rise / steps;
  const treadD = Math.max(0.18, stair.treadDepth);
  const flightW = Math.max(0.75, stair.width);

  const treadMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: isSelected ? 0x0ea5e9 : 0x8b5a2b,
      roughness: 0.52,
      metalness: 0.08,
    })
  );
  const riserMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      roughness: 0.72,
      metalness: 0.05,
    })
  );
  const stringerMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.36,
      metalness: 0.72,
    })
  );
  const railMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: isSelected ? 0x38bdf8 : 0x94a3b8,
      roughness: 0.25,
      metalness: 0.85,
    })
  );

  const addStraightFlight = (
    count: number,
    startX: number,
    startY: number,
    startZ: number,
    dirX: number,
    dirZ: number
  ) => {
    const rotY = Math.atan2(-dirZ, dirX);
    const flightGrp = new THREE.Group();
    flightGrp.position.set(startX, startY, startZ);
    flightGrp.rotation.y = rotY;

    const runLen = count * treadD;
    const flightRise = count * stepRise;
    const treadGeo = trackGeo(new THREE.BoxGeometry(treadD + 0.025, 0.045, flightW));
    const riserGeo = trackGeo(new THREE.BoxGeometry(0.03, stepRise, flightW - 0.04));

    for (let i = 0; i < count; i++) {
      const yTop = (i + 1) * stepRise;
      const xCenter = (i + 0.5) * treadD;

      const tread = new THREE.Mesh(treadGeo, treadMat);
      tread.position.set(xCenter, yTop - 0.0225, 0);
      tread.castShadow = true;
      tread.receiveShadow = true;
      flightGrp.add(tread);

      const riser = new THREE.Mesh(riserGeo, riserMat);
      riser.position.set(i * treadD + 0.015, yTop - stepRise / 2, 0);
      riser.castShadow = true;
      flightGrp.add(riser);
    }

    // Inclined steel stringer beams on both sides
    const diagLen = Math.hypot(runLen, flightRise);
    const slopeAngle = Math.atan2(flightRise, runLen);
    const stringerGeo = trackGeo(new THREE.BoxGeometry(diagLen, 0.16, 0.055));
    const railGeo = trackGeo(new THREE.CylinderGeometry(0.022, 0.022, diagLen, 8));
    const postGeo = trackGeo(new THREE.CylinderGeometry(0.014, 0.014, 0.92, 6));

    [-flightW / 2 + 0.03, flightW / 2 - 0.03].forEach((zOff) => {
      const stringer = new THREE.Mesh(stringerGeo, stringerMat);
      stringer.position.set(runLen / 2, flightRise / 2 - 0.06, zOff);
      stringer.rotation.z = slopeAngle;
      stringer.castShadow = true;
      flightGrp.add(stringer);

      const rail = new THREE.Mesh(railGeo, railMat);
      rail.rotation.z = Math.PI / 2 - slopeAngle;
      rail.position.set(runLen / 2, flightRise / 2 + 0.92, zOff);
      flightGrp.add(rail);

      const postCount = Math.max(2, Math.min(7, Math.ceil(count / 2) + 1));
      for (let p = 0; p < postCount; p++) {
        const t = postCount === 1 ? 0 : p / (postCount - 1);
        const px = t * runLen;
        const py = t * flightRise;
        const post = new THREE.Mesh(postGeo, railMat);
        post.position.set(px, py + 0.46, zOff);
        flightGrp.add(post);
      }
    });

    g.add(flightGrp);
  };

  if (stair.type === 'straight') {
    addStraightFlight(steps, 0, 0, flightW / 2, 1, 0);
  } else if (stair.type === 'l-shaped') {
    const firstSteps = Math.floor(steps / 2);
    const secondSteps = Math.max(1, steps - firstSteps);
    const lw = Math.max(flightW, stair.landingWidth);
    const ld = Math.max(flightW, stair.landingDepth);
    const firstRun = firstSteps * treadD;
    const midY = firstSteps * stepRise;

    addStraightFlight(firstSteps, 0, 0, flightW / 2, 1, 0);

    const landing = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(lw, 0.14, ld)), treadMat);
    landing.position.set(firstRun + lw / 2, midY - 0.07, ld / 2);
    landing.castShadow = true;
    landing.receiveShadow = true;
    g.add(landing);

    const support = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.05, 0.05, Math.max(0.2, midY - 0.14), 10)),
      stringerMat
    );
    support.position.set(firstRun + lw - 0.12, (midY - 0.14) / 2, 0.12);
    g.add(support);

    addStraightFlight(secondSteps, firstRun + lw - flightW / 2, midY, ld, 0, 1);
  } else if (stair.type === 'u-shaped') {
    const firstSteps = Math.ceil(steps / 2);
    const secondSteps = Math.max(1, steps - firstSteps);
    const ld = Math.max(flightW, stair.landingDepth);
    const wellGap = 0.16;
    const firstRun = firstSteps * treadD;
    const midY = firstSteps * stepRise;
    const totalW = flightW * 2 + wellGap;

    addStraightFlight(firstSteps, 0, 0, flightW / 2, 1, 0);

    const landing = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(ld, 0.14, totalW)), treadMat);
    landing.position.set(firstRun + ld / 2, midY - 0.07, totalW / 2);
    landing.castShadow = true;
    landing.receiveShadow = true;
    g.add(landing);

    const colGeo = trackGeo(new THREE.CylinderGeometry(0.045, 0.045, Math.max(0.2, midY - 0.14), 8));
    [0.12, totalW - 0.12].forEach((cz) => {
      const col = new THREE.Mesh(colGeo, stringerMat);
      col.position.set(firstRun + ld - 0.12, (midY - 0.14) / 2, cz);
      g.add(col);
    });

    addStraightFlight(secondSteps, firstRun, midY, flightW + wellGap + flightW / 2, -1, 0);
  } else {
    // Spiral staircase: central column + radial steps + outer balusters & handrail
    const radius = Math.max(0.7, flightW + 0.12);
    const cx = radius;
    const cz = radius;

    const column = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.09, 0.11, rise + 0.95, 16)),
      stringerMat
    );
    column.position.set(cx, (rise + 0.95) / 2, cz);
    column.castShadow = true;
    g.add(column);

    const railPts: THREE.Vector3[] = [];
    const totalAngle = Math.PI * 1.85;
    const spiralTreadGeo = trackGeo(
      new THREE.BoxGeometry(
        radius - 0.08,
        0.05,
        Math.max(0.22, (radius * totalAngle) / steps + 0.04)
      )
    );
    const spiralPostGeo = trackGeo(new THREE.CylinderGeometry(0.014, 0.014, 0.92, 6));

    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * totalAngle;
      const yTop = (i + 1) * stepRise;
      const stepGrp = new THREE.Group();
      stepGrp.position.set(cx, yTop - 0.025, cz);
      stepGrp.rotation.y = -a;

      const tread = new THREE.Mesh(spiralTreadGeo, treadMat);
      tread.position.set((radius + 0.08) / 2, 0, 0);
      tread.castShadow = true;
      tread.receiveShadow = true;
      stepGrp.add(tread);

      const post = new THREE.Mesh(spiralPostGeo, railMat);
      post.position.set(radius - 0.04, 0.46, 0);
      stepGrp.add(post);

      g.add(stepGrp);
      railPts.push(
        new THREE.Vector3(
          cx + Math.cos(a) * (radius - 0.04),
          yTop + 0.92,
          cz + Math.sin(a) * (radius - 0.04)
        )
      );
    }

    if (railPts.length >= 2) {
      const curve = new THREE.CatmullRomCurve3(railPts);
      const railTube = new THREE.Mesh(
        trackGeo(new THREE.TubeGeometry(curve, steps * 4, 0.024, 8, false)),
        railMat
      );
      g.add(railTube);
    }
  }

  g.traverse((child) => {
    child.userData.staircaseId = stair.id;
  });

  return g;
}

export function buildArchitecturalScene(
  project: ProjectData,
  textures: ArchitecturalTextureSet,
  selectedPointId: string | null,
  lightingMode: LightingMode,
  cutawayWalls: boolean,
  isSoftwareGl: boolean,
  activeFloor = 1,
  floorViewMode: FloorView3DMode = 'all',
  visualOverlays?: SceneVisualOverlays
): BuiltSceneHandles {
  const root = new THREE.Group();
  const clickables: THREE.Object3D[] = [];
  const fanRotors: THREE.Object3D[] = [];
  const pointAnchors = new Map<string, THREE.Vector3>();
  const physicalProducts: THREE.Object3D[] = [];

  // Dedicated electrical annotation & wiring overlay layer (completely separate from physical 3D products)
  const annotationsRoot = new THREE.Group();
  annotationsRoot.name = 'electrical-annotations-root';
  const makeOverlayGroup = (name: string) => {
    const g = new THREE.Group();
    g.name = name;
    annotationsRoot.add(g);
    return g;
  };
  const electricalAnnotations: ElectricalAnnotationHandles = {
    root: annotationsRoot,
    symbols: {
      fans: makeOverlayGroup('electrical-symbols-fans'),
      acs: makeOverlayGroup('electrical-symbols-acs'),
      switchboards: makeOverlayGroup('electrical-symbols-switchboards'),
      panels: makeOverlayGroup('electrical-symbols-panels'),
      sockets: makeOverlayGroup('electrical-symbols-sockets'),
      geysers: makeOverlayGroup('electrical-symbols-geysers'),
      other: makeOverlayGroup('electrical-symbols-other'),
    },
    wiring: makeOverlayGroup('electrical-wiring-overlay'),
  };
  root.add(annotationsRoot);

  const tracker = createSceneResourceTracker();
  const { trackGeo, trackMat } = tracker;

  const dispose = () => {
    tracker.disposeAll(root);
  };

  try {
    const selectedIds = visualOverlays?.selectedIds;
    const highlightedIds = visualOverlays?.highlightedIds;
    const activeHighlightId = visualOverlays?.activeHighlightId ?? null;

    const { lengthM, widthM, ceilingM, wallThickM } = siteToMeters(project.site);
    const halfL = lengthM / 2;
    const halfW = widthM / 2;
    const allFloors: FloorLevelConfig[] = getProjectFloors(project);
    const totalFloors = allFloors.length;
    const activeFloorCfg =
      allFloors.find((f) => f.floor === activeFloor) ?? allFloors[0];
    const activeFloorIdx = Math.max(0, allFloors.findIndex((f) => f.floor === activeFloorCfg.floor));

    let visibleFloorConfigs: FloorLevelConfig[];
    if (floorViewMode === 'active-only') {
      visibleFloorConfigs = [activeFloorCfg];
    } else if (floorViewMode === 'up-to-active') {
      visibleFloorConfigs = allFloors.filter(
        (_, idx) => idx <= activeFloorIdx && allFloors[idx].visible !== false
      );
      if (!visibleFloorConfigs.some((f) => f.floor === activeFloorCfg.floor)) {
        visibleFloorConfigs.push(activeFloorCfg);
      }
    } else {
      visibleFloorConfigs = allFloors.filter((f) => f.visible !== false);
      if (visibleFloorConfigs.length === 0) {
        visibleFloorConfigs = [activeFloorCfg];
      }
    }

    const visibleFloorSet = new Set(visibleFloorConfigs.map((f) => f.floor));
    const isExploded = floorViewMode === 'exploded';

    const renderedFloorY = new Map<number, number>();
    visibleFloorConfigs.forEach((fc, idx) => {
      const explodedOffset = isExploded ? idx * EXPLODED_FLOOR_GAP_M : 0;
      renderedFloorY.set(fc.floor, fc.elevationM + explodedOffset);
    });

    const toWorldX = (x: number) => x - halfL;
    const toWorldZ = (y: number) => y - halfW;

    // Shared materials across floors — ALL tracked so unused materials are also disposed cleanly
    const slabMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x162238,
        roughness: 0.78,
        metalness: 0.15,
      })
    );
    const basementSlabMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x0f172a,
        roughness: 0.85,
        metalness: 0.1,
      })
    );
    const upperSlabMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x1c2b45,
        roughness: 0.72,
        metalness: 0.18,
      })
    );
    const emptyDeckMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x1a2942,
        roughness: 0.78,
        metalness: 0.1,
      })
    );
    const columnMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x94a3b8,
        roughness: 0.55,
        metalness: 0.25,
      })
    );
    const floorMaterials: Record<string, THREE.MeshStandardMaterial> = {
      wood: trackMat(
        new THREE.MeshStandardMaterial({ map: textures.wood, roughness: 0.62, metalness: 0.06 })
      ),
      tile: trackMat(
        new THREE.MeshStandardMaterial({ map: textures.tile, roughness: 0.35, metalness: 0.12 })
      ),
      terrazzo: trackMat(
        new THREE.MeshStandardMaterial({ map: textures.terrazzo, roughness: 0.42, metalness: 0.08 })
      ),
      stone: trackMat(
        new THREE.MeshStandardMaterial({ map: textures.stone, roughness: 0.72, metalness: 0.05 })
      ),
    };
    const extWallMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xdbe2ec,
        roughness: 0.78,
        metalness: 0.04,
      })
    );
    const basementWallMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x64748b,
        roughness: 0.86,
        metalness: 0.08,
      })
    );
    const wallTopCapMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        roughness: 0.45,
        metalness: 0.35,
      })
    );
    const intWallMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xe6ecf2,
        roughness: 0.82,
        metalness: 0.02,
      })
    );
    const frameMat = trackMat(
      new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.35, metalness: 0.7 })
    );
    const doorWoodMat = trackMat(
      new THREE.MeshStandardMaterial({ color: 0x7c4a2d, roughness: 0.55, metalness: 0.08 })
    );
    const handleGoldMat = trackMat(
      new THREE.MeshStandardMaterial({ color: 0xfbbf24, metalness: 0.85, roughness: 0.2 })
    );
    const glassMat = trackMat(
      new THREE.MeshPhysicalMaterial({
        color: 0x93c5fd,
        roughness: 0.08,
        metalness: 0.1,
        transparent: true,
        opacity: isSoftwareGl ? 0.38 : 0.45,
        clearcoat: 1.0,
        depthWrite: false,
      })
    );

    visibleFloorConfigs.forEach((fc, idxInVisible) => {
      const floorNum = fc.floor;
      const floorGroup = new THREE.Group();
      const baseY = renderedFloorY.get(floorNum) ?? fc.elevationM;
      floorGroup.position.y = baseY;
      root.add(floorGroup);

      const floorSlice = sliceProjectForFloor(project, floorNum);
      const hasFloorAbove = !isExploded && idxInVisible < visibleFloorConfigs.length - 1;
      const isActiveFloor = floorNum === activeFloorCfg.floor;
      const clearH =
        fc.kind === 'terrace'
          ? Math.max(0.95, Math.min(1.5, fc.floorHeightM || 1.2))
          : Math.max(2.1, fc.floorHeightM || ceilingM);

      const wallH =
        fc.kind === 'terrace'
          ? clearH
          : hasFloorAbove
            ? clearH
            : cutawayWalls
              ? Math.min(2.55, clearH * 0.85)
              : clearH;
      const frontWallH = fc.kind === 'terrace' ? clearH : cutawayWalls ? 0.85 : wallH;

      // 1. Structural Concrete Slab
      const flBounds = getFloorBoundaryMeters(project, floorNum);
      const flL = flBounds.lengthM;
      const flW = flBounds.widthM;
      const slabCenterX = toWorldX(flL / 2);
      const slabCenterZ = toWorldZ(flW / 2);
      const slabH = Math.max(0.12, fc.slabThicknessM || STORY_SLAB_THICKNESS);
      const slab = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(flL + 0.5, slabH, flW + 0.5)),
        fc.kind === 'basement' ? basementSlabMat : floorNum === 1 ? slabMat : upperSlabMat
      );
      slab.position.set(slabCenterX, -slabH / 2, slabCenterZ);
      slab.castShadow = floorNum > 1 || isExploded;
      slab.receiveShadow = true;
      floorGroup.add(slab);

      // Architectural perimeter fascia trim (immediately dispose temporary BoxGeometry source!)
      const trimColor =
        totalFloors > 1 && isActiveFloor
          ? 0x00a8ff
          : fc.kind === 'terrace'
            ? 0xf59e0b
            : fc.kind === 'basement'
              ? 0x64748b
              : 0x38bdf8;
      const trimOpacity = totalFloors > 1 && isActiveFloor ? 0.94 : 0.56;
      const trimSourceBox = new THREE.BoxGeometry(flL + 0.52, slabH, flW + 0.52);
      const trimGeo = trackGeo(new THREE.EdgesGeometry(trimSourceBox));
      trimSourceBox.dispose();
      const trimLines = new THREE.LineSegments(
        trimGeo,
        trackMat(
          new THREE.LineBasicMaterial({ color: trimColor, transparent: true, opacity: trimOpacity })
        )
      );
      trimLines.position.set(slabCenterX, -slabH / 2, slabCenterZ);
      floorGroup.add(trimLines);

      // Structural perimeter columns
      if (totalFloors > 1 && fc.kind !== 'terrace' && (hasFloorAbove || floorNum !== 1)) {
        const colH = hasFloorAbove ? clearH : wallH;
        const colSize = Math.max(0.24, wallThickM + 0.08);
        const minX = toWorldX(0);
        const maxX = toWorldX(flL);
        const minZ = toWorldZ(0);
        const maxZ = toWorldZ(flW);
        const colCoords: [number, number][] = [
          [minX, minZ],
          [maxX, minZ],
          [minX, maxZ],
          [maxX, maxZ],
        ];
        if (flL >= 9) {
          colCoords.push([slabCenterX, minZ], [slabCenterX, maxZ]);
        }
        if (flW >= 8) {
          colCoords.push([minX, slabCenterZ], [maxX, slabCenterZ]);
        }
        const colGeo = trackGeo(new THREE.BoxGeometry(colSize, colH, colSize));
        colCoords.forEach(([cx, cz]) => {
          const col = new THREE.Mesh(colGeo, columnMat);
          col.position.set(cx, colH / 2, cz);
          col.castShadow = true;
          col.receiveShadow = true;
          floorGroup.add(col);
        });
      }

      // 2. Room Floor Finishes (exact polygon ExtrudeGeometry for irregular/angled CAD rooms; BoxGeometry for rectangular rooms)
      if (floorSlice.rooms.length > 0) {
        floorSlice.rooms.forEach((room) => {
          const mat = floorMaterials[room.floorFinish] ?? floorMaterials.wood;
          const poly = room.polygon;
          if (Array.isArray(poly) && poly.length >= 3) {
            const shape = new THREE.Shape();
            // Shape lives in XY plane; after rotateX(-PI/2), shape (x, y) maps to world (x, 0, -y),
            // so pass (toWorldX(pt.x), -toWorldZ(pt.y)) to align exactly with 2D CAD floor plan coordinates.
            shape.moveTo(toWorldX(poly[0].x), -toWorldZ(poly[0].y));
            for (let i = 1; i < poly.length; i++) {
              shape.lineTo(toWorldX(poly[i].x), -toWorldZ(poly[i].y));
            }
            shape.closePath();
            const extrudeGeo = new THREE.ExtrudeGeometry(shape, {
              depth: 0.03,
              bevelEnabled: false,
            });
            // Normalize planar UV scaling so tile/wood/terrazzo textures tile naturally in meters
            const uvAttr = extrudeGeo.attributes.uv;
            if (uvAttr) {
              for (let i = 0; i < uvAttr.count; i++) {
                uvAttr.setXY(i, uvAttr.getX(i) * 0.45, uvAttr.getY(i) * 0.45);
              }
              uvAttr.needsUpdate = true;
            }
            extrudeGeo.rotateX(-Math.PI / 2);
            const floorMesh = new THREE.Mesh(trackGeo(extrudeGeo), mat);
            floorMesh.position.y = 0.002;
            floorMesh.receiveShadow = true;
            floorGroup.add(floorMesh);
          } else {
            const floorMesh = new THREE.Mesh(
              trackGeo(
                new THREE.BoxGeometry(
                  Math.max(0.1, room.width - 0.04),
                  0.03,
                  Math.max(0.1, room.height - 0.04)
                )
              ),
              mat
            );
            floorMesh.position.set(
              toWorldX(room.x + room.width / 2),
              0.015,
              toWorldZ(room.y + room.height / 2)
            );
            floorMesh.receiveShadow = true;
            floorGroup.add(floorMesh);
          }
        });
      } else if (floorNum !== 1 || fc.kind === 'terrace') {
        const deckMesh = new THREE.Mesh(
          trackGeo(
            new THREE.BoxGeometry(
              Math.max(0.5, lengthM - wallThickM),
              0.02,
              Math.max(0.5, widthM - wallThickM)
            )
          ),
          fc.kind === 'terrace' ? floorMaterials.stone : emptyDeckMat
        );
        deckMesh.position.set(0, 0.01, 0);
        deckMesh.receiveShadow = true;
        floorGroup.add(deckMesh);
      }

      // 2b. Imported Structural Columns from CAD/PDF Reconstruction (on this floor)
      const importedCols = (project.aiDrawingImport?.columns ?? []).filter(
        (col) => (col.floor ?? 1) === floorNum
      );
      if (importedCols.length > 0) {
        const colH = hasFloorAbove ? clearH : wallH;
        importedCols.forEach((col) => {
          const cw = Math.max(0.18, Math.min(2.5, col.width || 0.3));
          const cd = Math.max(0.18, Math.min(2.5, col.height || 0.3));
          const colMesh = new THREE.Mesh(
            trackGeo(new THREE.BoxGeometry(cw, colH, cd)),
            columnMat
          );
          colMesh.position.set(toWorldX(col.x), colH / 2, toWorldZ(col.y));
          colMesh.castShadow = true;
          colMesh.receiveShadow = true;
          colMesh.userData.columnId = col.id;
          floorGroup.add(colMesh);

          const plinth = new THREE.Mesh(
            trackGeo(new THREE.BoxGeometry(cw + 0.06, 0.08, cd + 0.06)),
            wallTopCapMat
          );
          plinth.position.set(toWorldX(col.x), 0.04, toWorldZ(col.y));
          plinth.receiveShadow = true;
          floorGroup.add(plinth);
        });
      }

      // 3. Structural Exterior Walls & Interior Partition Walls
      const primaryExtMat = fc.kind === 'basement' ? basementWallMat : extWallMat;
      const addWallSegment = (
        cx: number,
        cz: number,
        len: number,
        thick: number,
        rotY: number,
        isExterior: boolean
      ) => {
        const h = isExterior ? wallH : hasFloorAbove ? wallH * 0.96 : wallH * 0.92;
        const wall = new THREE.Mesh(
          trackGeo(new THREE.BoxGeometry(len, h, thick)),
          [
            primaryExtMat,
            primaryExtMat,
            wallTopCapMat,
            primaryExtMat,
            isExterior ? primaryExtMat : intWallMat,
            isExterior ? primaryExtMat : intWallMat,
          ]
        );
        wall.position.set(cx, h / 2, cz);
        wall.rotation.y = rotY;
        wall.castShadow = true;
        wall.receiveShadow = true;
        floorGroup.add(wall);
      };

      const mergedWalls = extractMergedWalls(floorSlice);

      mergedWalls.forEach((seg) => {
        const dx = seg.x2 - seg.x1;
        const dy = seg.y2 - seg.y1;
        const len = Math.hypot(dx, dy);
        // Preserve short curved-wall chords & chamfer segments down to 4 cm
        if (len < 0.04) return;

        const cx = toWorldX((seg.x1 + seg.x2) / 2);
        const cz = toWorldZ((seg.y1 + seg.y2) / 2);
        const angle = -Math.atan2(dy, dx);

        if (seg.id === 'ext-s') {
          const frontWall = new THREE.Mesh(
            trackGeo(new THREE.BoxGeometry(len + seg.thickness, frontWallH, seg.thickness)),
            [primaryExtMat, primaryExtMat, wallTopCapMat, primaryExtMat, primaryExtMat, primaryExtMat]
          );
          frontWall.position.set(cx, frontWallH / 2, cz);
          frontWall.castShadow = true;
          frontWall.receiveShadow = true;
          floorGroup.add(frontWall);
          return;
        }

        const isAngledOrCurved = Math.abs(dx) > 0.01 && Math.abs(dy) > 0.01;
        const extraLen =
          seg.id === 'ext-n'
            ? seg.thickness
            : isAngledOrCurved
              ? seg.thickness * 0.24
              : seg.thickness * 0.08;
        addWallSegment(cx, cz, len + extraLen, seg.thickness, angle, seg.isExterior);
      });

      // 4. Doors & Windows on this floor
      floorSlice.openings.forEach((op) => {
        const g = new THREE.Group();
        if (op.kind === 'window') {
          const winH = Math.min(1.25, wallH * 0.65);
          const frame = new THREE.Mesh(
            trackGeo(new THREE.BoxGeometry(op.width, winH, wallThickM + 0.06)),
            frameMat
          );
          const pane = new THREE.Mesh(
            trackGeo(new THREE.BoxGeometry(op.width - 0.12, winH - 0.12, 0.03)),
            glassMat
          );
          g.add(frame, pane);
          g.position.set(toWorldX(op.x), Math.min(1.45, wallH * 0.62), toWorldZ(op.y));
        } else {
          const doorH = Math.min(2.1, wallH - 0.08);
          const leaf = new THREE.Mesh(
            trackGeo(new THREE.BoxGeometry(op.width, doorH, wallThickM + 0.04)),
            doorWoodMat
          );
          const handle = new THREE.Mesh(
            trackGeo(new THREE.SphereGeometry(0.035, 8, 8)),
            handleGoldMat
          );
          handle.position.set(op.width * 0.35, -0.08, (wallThickM + 0.08) / 2);
          g.add(leaf, handle);
          g.position.set(toWorldX(op.x), doorH / 2, toWorldZ(op.y));
        }
        g.rotation.y = -(op.rotation * Math.PI) / 180;
        floorGroup.add(g);
      });

      // 5. Composite 3D Staircases starting from this floor
      (project.staircases ?? [])
        .filter((st) => st.fromFloor === floorNum)
        .forEach((st) => {
          const fromElev = getFloorElevationM(project, st.fromFloor);
          const toElev = getFloorElevationM(project, st.toFloor);
          const actualRise = Math.max(1.8, Math.abs(toElev - fromElev) || clearH + slabH);
          const isSelStair = !!selectedIds?.has(st.id) || activeHighlightId === st.id;
          const stGrp = buildStaircaseGroup(st, actualRise, isSelStair, tracker);
          stGrp.position.set(toWorldX(st.x), 0.02, toWorldZ(st.y));
          stGrp.rotation.y = -(st.rotation * Math.PI) / 180;
          floorGroup.add(stGrp);
          clickables.push(stGrp);
        });

      // 6. Composite 3D Furniture on this floor
      floorSlice.furniture.forEach((f) => {
        const fg = buildFurnitureGroup(f, tracker);
        fg.position.set(toWorldX(f.x), 0.03, toWorldZ(f.y));
        fg.rotation.y = -(f.rotation * Math.PI) / 180;

        const isSelectedFurn = !!selectedIds?.has(f.id);
        const isActiveFindFurn = activeHighlightId === f.id;
        const isFindMatchFurn = !!highlightedIds?.has(f.id);
        if (isSelectedFurn || isActiveFindFurn || isFindMatchFurn) {
          const ringColor = isActiveFindFurn ? 0xff9d00 : isSelectedFurn ? 0x00a8ff : 0xfbbf24;
          const radius = Math.max(f.width, f.depth) * 0.62 + 0.14;
          const ring = new THREE.Mesh(
            trackGeo(new THREE.RingGeometry(radius - 0.07, radius, 32)),
            trackMat(
              new THREE.MeshBasicMaterial({
                color: ringColor,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: isActiveFindFurn ? 0.95 : 0.78,
              })
            )
          );
          ring.rotation.x = -Math.PI / 2;
          ring.position.y = 0.04;
          fg.add(ring);
        }

        fg.traverse((child) => {
          child.userData.furnitureId = f.id;
        });
        floorGroup.add(fg);
        clickables.push(fg);
      });

      // 7. Composite 3D Electrical Fixtures on this floor
      floorSlice.points.forEach((pt) => {
        const isSelected = pt.id === selectedPointId || !!selectedIds?.has(pt.id);
        const isActiveFind = activeHighlightId === pt.id;
        const isFindMatch = !!highlightedIds?.has(pt.id);
        const fx = buildElectricalFixture(
          pt,
          isSelected || isActiveFind,
          lightingMode,
          isSoftwareGl,
          fanRotors,
          tracker
        );
        const visualY =
          cutawayWalls && !hasFloorAbove
            ? Math.min(pt.z, wallH - 0.06)
            : Math.min(pt.z, clearH - 0.05);
        const wx = toWorldX(pt.x);
        const wz = toWorldZ(pt.y);
        const localY = Math.max(0.35, visualY);
        fx.position.set(wx, localY, wz);
        fx.rotation.y = -(pt.rotation * Math.PI) / 180;

        // Physical 3D electrical product stays permanently under floorGroup (never hidden by symbol toggles)
        floorGroup.add(fx);
        physicalProducts.push(fx);
        clickables.push(fx);

        // Electrical selection/highlight annotation overlays live strictly in the separate annotation layer
        if (isSelected || isActiveFind || isFindMatch) {
          const symGroup = electricalAnnotations.symbols[classifyElectricalSymbolGroup(pt.itemType)];
          const overlayWrap = new THREE.Group();
          overlayWrap.position.set(wx, baseY + localY, wz);
          overlayWrap.rotation.y = -(pt.rotation * Math.PI) / 180;

          if (isSelected || isActiveFind) {
            const ring = new THREE.Mesh(
              trackGeo(new THREE.RingGeometry(0.26, 0.34, 24)),
              trackMat(
                new THREE.MeshBasicMaterial({
                  color: 0x00a8ff,
                  side: THREE.DoubleSide,
                })
              )
            );
            ring.rotation.x = -Math.PI / 2;
            ring.position.y = -0.06;
            ring.userData.pointId = pt.id;
            overlayWrap.add(ring);
          }

          const haloColor = isActiveFind ? 0xff9d00 : isSelected ? 0x00a8ff : 0xfbbf24;
          const halo = new THREE.Mesh(
            trackGeo(new THREE.RingGeometry(0.34, 0.44, 28)),
            trackMat(
              new THREE.MeshBasicMaterial({
                color: haloColor,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: isActiveFind ? 0.96 : 0.82,
              })
            )
          );
          halo.rotation.x = -Math.PI / 2;
          halo.position.y = 0.02;
          halo.userData.pointId = pt.id;
          overlayWrap.add(halo);
          symGroup.add(overlayWrap);
        }

        pointAnchors.set(pt.id, new THREE.Vector3(wx, baseY + Math.max(0.45, localY + 0.22), wz));
      });
    });

    // 8. 3D Electrical Wire Conduits (same-floor routing + inter-floor vertical risers)
    const wiringCfg = getWiringConfig(project);
    if (wiringCfg.showWires && wiringCfg.show3DWires && (project.wires ?? []).length > 0) {
      const pointById = new Map(project.points.map((p) => [p.id, p]));
      (project.wires ?? []).forEach((wire) => {
        if (!wiringCfg.visibleCategories[wire.category]) return;
        const fromPt = pointById.get(wire.fromPointId);
        const toPt = pointById.get(wire.toPointId);
        if (!fromPt || !toPt) return;

        const fromFl = getItemFloor(fromPt);
        const toFl = getItemFloor(toPt);
        if (!visibleFloorSet.has(fromFl) || !visibleFloorSet.has(toFl)) return;

        const fromBaseY = renderedFloorY.get(fromFl) ?? getFloorElevationM(project, fromFl);
        const toBaseY = renderedFloorY.get(toFl) ?? getFloorElevationM(project, toFl);
        const fromCfg = allFloors.find((f) => f.floor === fromFl);
        const toCfg = allFloors.find((f) => f.floor === toFl);

        const fromY =
          fromBaseY + Math.max(0.35, Math.min(fromPt.z, (fromCfg?.floorHeightM ?? ceilingM) - 0.12));
        const toY =
          toBaseY + Math.max(0.35, Math.min(toPt.z, (toCfg?.floorHeightM ?? ceilingM) - 0.12));
        const routePlaneY =
          fromFl === toFl
            ? Math.max(
                fromY,
                toY,
                fromBaseY + Math.min(2.35, (fromCfg?.floorHeightM ?? ceilingM) * 0.78)
              )
            : fromY;

        const pathPts: THREE.Vector3[] = [];
        const sx = toWorldX(fromPt.x);
        const sz = toWorldZ(fromPt.y);
        const ex = toWorldX(toPt.x);
        const ez = toWorldZ(toPt.y);

        pathPts.push(new THREE.Vector3(sx, fromY, sz));
        if (fromFl === toFl) {
          if (Math.abs(routePlaneY - fromY) > 0.08) {
            pathPts.push(new THREE.Vector3(sx, routePlaneY, sz));
          }
          (wire.waypoints ?? []).forEach((wp) => {
            pathPts.push(new THREE.Vector3(toWorldX(wp.x), routePlaneY, toWorldZ(wp.y)));
          });
          if (Math.abs(routePlaneY - toY) > 0.08) {
            pathPts.push(new THREE.Vector3(ex, routePlaneY, ez));
          }
          pathPts.push(new THREE.Vector3(ex, toY, ez));
        } else {
          const riserX = wire.waypoints?.[0] ? toWorldX(wire.waypoints[0].x) : sx;
          const riserZ = wire.waypoints?.[0] ? toWorldZ(wire.waypoints[0].y) : sz;
          pathPts.push(new THREE.Vector3(riserX, fromY, riserZ));
          pathPts.push(new THREE.Vector3(riserX, toY, riserZ));
          (wire.waypoints ?? []).slice(1).forEach((wp) => {
            pathPts.push(new THREE.Vector3(toWorldX(wp.x), toY, toWorldZ(wp.y)));
          });
          pathPts.push(new THREE.Vector3(ex, toY, ez));
        }

        const isSelWire = !!selectedIds?.has(wire.id) || activeHighlightId === wire.id;
        const wireColor = new THREE.Color(wire.color || '#00A8FF');
        const conduitMat = trackMat(
          new THREE.MeshStandardMaterial({
            color: wireColor,
            emissive: wireColor,
            emissiveIntensity: isSelWire ? 0.95 : 0.3,
            roughness: 0.35,
            metalness: 0.25,
          })
        );

        const wireGroup = new THREE.Group();
        const radius = isSelWire ? 0.036 : Math.max(0.018, wire.lineThickness * 0.01);
        for (let i = 0; i < pathPts.length - 1; i++) {
          const a = pathPts[i];
          const b = pathPts[i + 1];
          const segLen = a.distanceTo(b);
          if (segLen < 0.02) continue;
          const curve = new THREE.LineCurve3(a, b);
          const tube = new THREE.Mesh(
            trackGeo(new THREE.TubeGeometry(curve, 2, radius, 6, false)),
            conduitMat
          );
          tube.userData.wireId = wire.id;
          wireGroup.add(tube);
        }
        wireGroup.userData.wireId = wire.id;
        electricalAnnotations.wiring.add(wireGroup);
        clickables.push(wireGroup);
      });
    }

    return {
      root,
      clickables,
      fanRotors,
      pointAnchors,
      physicalProducts,
      electricalAnnotations,
      dispose,
      resourceStats: tracker.stats,
    };
  } catch (err) {
    // Guarantee zero leaked geometries/materials if scene construction fails partway
    dispose();
    throw err;
  }
}
