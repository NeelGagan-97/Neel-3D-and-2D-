import * as THREE from 'three';
import { siteToMeters } from '../data/presets';
import {
  ElectricalPoint,
  FurnitureItem,
  LightingMode,
  ProjectData,
} from '../types/design';
import { ArchitecturalTextureSet } from './proceduralTextures';
import { extractMergedWalls } from '../utils/geometry';

export interface BuiltSceneHandles {
  root: THREE.Group;
  clickables: THREE.Object3D[];
  fanRotors: THREE.Object3D[];
  pointAnchors: Map<string, THREE.Vector3>;
  dispose: () => void;
}

/**
 * Helper to create a composite furniture group pivoted cleanly at y = 0 (floor level)
 */
function buildFurnitureGroup(item: FurnitureItem): THREE.Group {
  const g = new THREE.Group();
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x5c3d28, roughness: 0.65, metalness: 0.05 });
  const fabricMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.88, metalness: 0.0 });
  const cushionMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.85, metalness: 0.0 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.78, metalness: 0.0 });
  const marbleMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.25, metalness: 0.1 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.35, metalness: 0.75 });
  const linenMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.9, metalness: 0.0 });

  const w = item.width;
  const d = item.depth;

  if (item.kind === 'sofa') {
    // Base frame
    const base = new THREE.Mesh(new THREE.BoxGeometry(w, 0.28, d * 0.65), fabricMat);
    base.position.set(0, 0.22, -d * 0.15);
    base.castShadow = true;
    base.receiveShadow = true;
    g.add(base);

    // Backrest
    const back = new THREE.Mesh(new THREE.BoxGeometry(w, 0.52, 0.22), fabricMat);
    back.position.set(0, 0.56, -d * 0.42);
    back.castShadow = true;
    g.add(back);

    // Armrests
    const armL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.42, d * 0.65), fabricMat);
    armL.position.set(-w / 2 + 0.09, 0.44, -d * 0.15);
    const armR = armL.clone();
    armR.position.x = w / 2 - 0.09;
    g.add(armL, armR);

    // Seat cushions (3)
    const cW = (w - 0.42) / 3;
    for (let i = 0; i < 3; i++) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(cW - 0.03, 0.14, d * 0.52), cushionMat);
      c.position.set(-w / 2 + 0.21 + cW * (i + 0.5), 0.42, -d * 0.1);
      g.add(c);
    }

    // Accent throw pillow
    const pillow = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.28, 0.12), accentMat);
    pillow.position.set(-w / 2 + 0.38, 0.58, -d * 0.26);
    pillow.rotation.z = 0.18;
    g.add(pillow);

    // Coffee table in front
    const tableTop = new THREE.Mesh(new THREE.BoxGeometry(w * 0.52, 0.06, 0.55), marbleMat);
    tableTop.position.set(0, 0.38, d * 0.42);
    tableTop.castShadow = true;
    const tableBase = new THREE.Mesh(new THREE.BoxGeometry(w * 0.42, 0.34, 0.42), darkMetal);
    tableBase.position.set(0, 0.17, d * 0.42);
    g.add(tableTop, tableBase);
  } else if (item.kind === 'bed') {
    // Platform bed frame
    const frame = new THREE.Mesh(new THREE.BoxGeometry(w, 0.26, d), woodMat);
    frame.position.set(0, 0.15, 0);
    frame.castShadow = true;
    frame.receiveShadow = true;
    g.add(frame);

    // Upholstered headboard
    const head = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, 0.95, 0.14), fabricMat);
    head.position.set(0, 0.52, -d / 2 + 0.07);
    head.castShadow = true;
    g.add(head);

    // Mattress + Duvet
    const mattress = new THREE.Mesh(new THREE.BoxGeometry(w - 0.08, 0.22, d - 0.16), linenMat);
    mattress.position.set(0, 0.38, 0.04);
    g.add(mattress);

    const duvet = new THREE.Mesh(new THREE.BoxGeometry(w - 0.04, 0.08, d * 0.58), cushionMat);
    duvet.position.set(0, 0.5, d * 0.18);
    g.add(duvet);

    // Two pillows
    const p1 = new THREE.Mesh(new THREE.BoxGeometry(w * 0.36, 0.12, 0.36), accentMat);
    p1.position.set(-w * 0.23, 0.54, -d / 2 + 0.36);
    const p2 = p1.clone();
    p2.position.x = w * 0.23;
    g.add(p1, p2);
  } else if (item.kind === 'dining-table') {
    const top = new THREE.Mesh(new THREE.BoxGeometry(w, 0.07, d), woodMat);
    top.position.set(0, 0.76, 0);
    top.castShadow = true;
    g.add(top);
    const legOffsets = [
      [-w / 2 + 0.1, -d / 2 + 0.1],
      [w / 2 - 0.1, -d / 2 + 0.1],
      [-w / 2 + 0.1, d / 2 - 0.1],
      [w / 2 - 0.1, d / 2 - 0.1],
    ];
    legOffsets.forEach(([lx, lz]) => {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.74, 8), darkMetal);
      leg.position.set(lx, 0.37, lz);
      g.add(leg);
    });
    // 4 dining chairs
    [-0.4, 0.4].forEach((cx) => {
      [-d / 2 - 0.26, d / 2 + 0.26].forEach((cz) => {
        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.06, 0.42), cushionMat);
        seat.position.set(cx, 0.46, cz);
        const back = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.05), woodMat);
        back.position.set(cx, 0.68, cz + (cz > 0 ? 0.18 : -0.18));
        g.add(seat, back);
      });
    });
  } else if (item.kind === 'kitchen-counter') {
    const cabinet = new THREE.Mesh(new THREE.BoxGeometry(w, 0.84, d), fabricMat);
    cabinet.position.set(0, 0.42, 0);
    cabinet.castShadow = true;
    cabinet.receiveShadow = true;
    const countertop = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, 0.06, d + 0.04), marbleMat);
    countertop.position.set(0, 0.87, 0);
    // Hob cooktop + sink basin
    const hob = new THREE.Mesh(new THREE.BoxGeometry(w * 0.65, 0.02, 0.68), darkMetal);
    hob.position.set(0, 0.91, -d * 0.22);
    const sink = new THREE.Mesh(new THREE.BoxGeometry(w * 0.62, 0.03, 0.56), new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.2, metalness: 0.85 }));
    sink.position.set(0, 0.905, d * 0.24);
    g.add(cabinet, countertop, hob, sink);
  } else if (item.kind === 'tv-unit') {
    const consoleBox = new THREE.Mesh(new THREE.BoxGeometry(w, 0.45, d), woodMat);
    consoleBox.position.set(0, 0.24, 0);
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.72, d * 0.68), darkMetal);
    screen.position.set(-w * 0.1, 1.08, 0);
    g.add(consoleBox, screen);
  } else {
    // Vanity / Desk
    const cab = new THREE.Mesh(new THREE.BoxGeometry(w, 0.78, d), woodMat);
    cab.position.set(0, 0.39, 0);
    const top = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, 0.05, d + 0.04), marbleMat);
    top.position.set(0, 0.81, 0);
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(w * 0.75, 0.72, 0.03), new THREE.MeshStandardMaterial({ color: 0x93c5fd, roughness: 0.08, metalness: 0.92 }));
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
  fanRotors: THREE.Object3D[]
): THREE.Group {
  const group = new THREE.Group();
  const isEvening = lightingMode === 'evening';

  const metalBody = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    roughness: 0.28,
    metalness: 0.68,
  });
  const darkMetal = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.35,
    metalness: 0.75,
  });
  const electricBlueMat = new THREE.MeshStandardMaterial({
    color: 0x00a8ff,
    emissive: new THREE.Color(0x00a8ff),
    emissiveIntensity: isSelected ? 1.1 : 0.35,
    roughness: 0.25,
    metalness: 0.4,
  });
  const amberMat = new THREE.MeshStandardMaterial({
    color: 0xff9d00,
    emissive: new THREE.Color(0xff9d00),
    emissiveIntensity: isEvening ? 1.35 : 0.45,
    roughness: 0.22,
    metalness: 0.2,
  });
  const warmGlowMat = new THREE.MeshStandardMaterial({
    color: 0xfff7ed,
    emissive: new THREE.Color(isEvening ? 0xffb347 : 0xfef3c7),
    emissiveIntensity: isEvening ? 2.1 : 0.65,
    roughness: 0.15,
    metalness: 0.05,
  });

  if (pt.itemType === 'ceiling_fan') {
    // Canopy + downrod
    const canopy = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 0.06, 12), darkMetal);
    canopy.position.y = 0.26;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.28, 8), darkMetal);
    rod.position.y = 0.12;
    group.add(canopy, rod);

    // Rotor assembly (hub + 3 angled blades)
    const rotor = new THREE.Group();
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.14, 0.07, 16), metalBody);
    const hubTrim = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.08, 12), electricBlueMat);
    rotor.add(hub, hubTrim);

    for (let i = 0; i < 3; i++) {
      const bladeWrap = new THREE.Group();
      bladeWrap.rotation.y = (i * Math.PI * 2) / 3;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.014, 0.11), metalBody);
      blade.position.set(0.34, 0, 0);
      blade.rotation.x = 0.12;
      bladeWrap.add(blade);
      rotor.add(bladeWrap);
    }
    group.add(rotor);
    fanRotors.push(rotor);
  } else if (pt.itemType === 'exhaust_fan') {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.08), darkMetal);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.018, 8, 18), metalBody);
    ring.position.z = 0.04;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.06, 12), amberMat);
    hub.rotation.x = Math.PI / 2;
    hub.position.z = 0.03;
    group.add(frame, ring, hub);
  } else if (pt.itemType === 'panel_light' || pt.itemType === 'led_light') {
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.03, 0.34), metalBody);
    const diffuser = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.036, 0.28), warmGlowMat);
    diffuser.position.y = -0.005;
    group.add(bezel, diffuser);
    if (isEvening && !isSoftwareGl) {
      const light = new THREE.PointLight(0xffd28a, 1.35, 4.8, 1.8);
      light.position.y = -0.18;
      group.add(light);
    }
  } else if (pt.itemType === 'spotlight') {
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.09, 14), darkMetal);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.02, 14), warmGlowMat);
    lens.position.y = -0.045;
    group.add(housing, lens);
  } else if (pt.itemType === 'strip_light') {
    const channel = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.04, 0.07), darkMetal);
    const ledBar = new THREE.Mesh(new THREE.BoxGeometry(1.46, 0.035, 0.05), amberMat);
    ledBar.position.y = -0.01;
    group.add(channel, ledBar);
  } else if (pt.itemType === 'chandelier') {
    const brass = new THREE.MeshStandardMaterial({ color: 0xd9a05b, roughness: 0.22, metalness: 0.88 });
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.42, 8), brass);
    stem.position.y = 0.2;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.022, 10, 24), brass);
    ring.rotation.x = Math.PI / 2;
    group.add(stem, ring);
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI * 2) / 6;
      const globe = new THREE.Mesh(new THREE.SphereGeometry(0.065, 12, 12), warmGlowMat);
      globe.position.set(Math.cos(a) * 0.34, -0.03, Math.sin(a) * 0.34);
      group.add(globe);
    }
    if (isEvening && !isSoftwareGl) {
      const light = new THREE.PointLight(0xffcb7d, 2.2, 6.5, 1.6);
      light.position.y = -0.15;
      group.add(light);
    }
  } else if (pt.itemType === 'split_ac') {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.28, 0.22), metalBody);
    const louver = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.05, 0.04), darkMetal);
    louver.position.set(0, -0.09, 0.11);
    const indicator = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.025, 0.02), electricBlueMat);
    indicator.position.set(0.3, 0.04, 0.115);
    group.add(body, louver, indicator);
  } else if (pt.itemType === 'geyser') {
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.56, 16), metalBody);
    const capTop = new THREE.Mesh(new THREE.CylinderGeometry(0.185, 0.185, 0.06, 16), darkMetal);
    capTop.position.y = 0.28;
    const capBot = capTop.clone();
    capBot.position.y = -0.28;
    const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.03, 12), amberMat);
    dial.rotation.x = Math.PI / 2;
    dial.position.set(0, -0.12, 0.18);
    group.add(tank, capTop, capBot, dial);
  } else if (pt.itemType === 'switchboard' || pt.itemType === 'switch') {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.03), darkMetal);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.035), electricBlueMat);
    const rocker1 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, 0.045), metalBody);
    rocker1.position.x = -0.05;
    const rocker2 = rocker1.clone();
    rocker2.position.x = 0.05;
    group.add(plate, trim, rocker1, rocker2);
  } else {
    // Sockets, USB Outlets, Appliances
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.16, 0.05), darkMetal);
    const accent = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.1, 0.056),
      pt.itemType === 'socket_16a' || pt.itemType === 'appliance' ? amberMat : electricBlueMat
    );
    group.add(box, accent);
  }

  // Selection highlight ring + vertical pointer stem
  if (isSelected) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.26, 0.34, 24),
      new THREE.MeshBasicMaterial({
        color: 0x00a8ff,
        side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.06;
    group.add(ring);
  }

  // Invisible generous raycast proxy box so clicking small switches/sockets is effortless
  const hitBox = new THREE.Mesh(
    new THREE.BoxGeometry(0.65, 0.55, 0.65),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hitBox.userData.pointId = pt.id;
  group.add(hitBox);

  group.traverse((child) => {
    child.userData.pointId = pt.id;
  });

  return group;
}

export function buildArchitecturalScene(
  project: ProjectData,
  textures: ArchitecturalTextureSet,
  selectedPointId: string | null,
  lightingMode: LightingMode,
  cutawayWalls: boolean,
  isSoftwareGl: boolean
): BuiltSceneHandles {
  const root = new THREE.Group();
  const clickables: THREE.Object3D[] = [];
  const fanRotors: THREE.Object3D[] = [];
  const pointAnchors = new Map<string, THREE.Vector3>();

  const { lengthM, widthM, ceilingM, wallThickM } = siteToMeters(project.site);
  const halfL = lengthM / 2;
  const halfW = widthM / 2;
  const wallH = cutawayWalls ? Math.min(2.55, ceilingM * 0.85) : ceilingM;

  // Offset helper converting project (x, y) meters -> centered Three.js (x, z)
  const toWorldX = (x: number) => x - halfL;
  const toWorldZ = (y: number) => y - halfW;

  // 1. Structural Concrete Slab Base (grounded cleanly)
  const slabMat = new THREE.MeshStandardMaterial({
    color: 0x162238,
    roughness: 0.78,
    metalness: 0.15,
  });
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(lengthM + 0.5, 0.24, widthM + 0.5),
    slabMat
  );
  slab.position.set(0, -0.12, 0);
  slab.receiveShadow = true;
  root.add(slab);

  // Subtle Electric Blue structural perimeter plinth trim
  const trimGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(lengthM + 0.52, 0.24, widthM + 0.52));
  const trimLines = new THREE.LineSegments(
    trimGeo,
    new THREE.LineBasicMaterial({ color: 0x00a8ff, transparent: true, opacity: 0.55 })
  );
  trimLines.position.set(0, -0.12, 0);
  root.add(trimLines);

  // 2. Room Floor Finishes (offset slightly above slab at y = 0.02 to prevent Z-fighting)
  const floorMaterials: Record<string, THREE.MeshStandardMaterial> = {
    wood: new THREE.MeshStandardMaterial({ map: textures.wood, roughness: 0.62, metalness: 0.06 }),
    tile: new THREE.MeshStandardMaterial({ map: textures.tile, roughness: 0.35, metalness: 0.12 }),
    terrazzo: new THREE.MeshStandardMaterial({ map: textures.terrazzo, roughness: 0.42, metalness: 0.08 }),
    stone: new THREE.MeshStandardMaterial({ map: textures.stone, roughness: 0.72, metalness: 0.05 }),
  };

  project.rooms.forEach((room) => {
    const mat = floorMaterials[room.floorFinish] ?? floorMaterials.wood;
    const floorMesh = new THREE.Mesh(new THREE.BoxGeometry(room.width - 0.04, 0.03, room.height - 0.04), mat);
    floorMesh.position.set(
      toWorldX(room.x + room.width / 2),
      0.015,
      toWorldZ(room.y + room.height / 2)
    );
    floorMesh.receiveShadow = true;
    root.add(floorMesh);
  });

  // 3. Structural Exterior Walls & Interior Partition Walls
  const extWallMat = new THREE.MeshStandardMaterial({
    color: 0xdbe2ec,
    roughness: 0.78,
    metalness: 0.04,
  });
  const wallTopCapMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.45,
    metalness: 0.35,
  });
  const intWallMat = new THREE.MeshStandardMaterial({
    color: 0xe6ecf2,
    roughness: 0.82,
    metalness: 0.02,
  });

  const addWallSegment = (
    cx: number,
    cz: number,
    len: number,
    thick: number,
    rotY: number,
    isExterior: boolean
  ) => {
    const h = isExterior ? wallH : wallH * 0.92;
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(len, h, thick),
      [extWallMat, extWallMat, wallTopCapMat, extWallMat, isExterior ? extWallMat : intWallMat, isExterior ? extWallMat : intWallMat]
    );
    wall.position.set(cx, h / 2, cz);
    wall.rotation.y = rotY;
    wall.castShadow = true;
    wall.receiveShadow = true;
    root.add(wall);
  };

  // Perimeter walls (front wall slightly lower in cutaway Orbit view so interior stays readable!)
  const frontWallH = cutawayWalls ? 0.85 : wallH;
  const mergedWalls = extractMergedWalls(project);

  mergedWalls.forEach((seg) => {
    const dx = seg.x2 - seg.x1;
    const dy = seg.y2 - seg.y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.08) return;

    const cx = toWorldX((seg.x1 + seg.x2) / 2);
    const cz = toWorldZ((seg.y1 + seg.y2) / 2);
    const angle = -Math.atan2(dy, dx);

    // South perimeter cutaway lip in Orbit mode so user can inspect rooms & walls clearly
    if (seg.id === 'ext-s') {
      const frontWall = new THREE.Mesh(
        new THREE.BoxGeometry(len + seg.thickness, frontWallH, seg.thickness),
        [extWallMat, extWallMat, wallTopCapMat, extWallMat, extWallMat, extWallMat]
      );
      frontWall.position.set(cx, frontWallH / 2, cz);
      frontWall.castShadow = true;
      frontWall.receiveShadow = true;
      root.add(frontWall);
      return;
    }

    const extraLen = seg.id === 'ext-n' ? seg.thickness : 0;
    addWallSegment(cx, cz, len + extraLen, seg.thickness, angle, seg.isExterior);
  });

  // 4. Doors & Windows
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.35, metalness: 0.7 });
  const doorWoodMat = new THREE.MeshStandardMaterial({ color: 0x7c4a2d, roughness: 0.55, metalness: 0.08 });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x93c5fd,
    roughness: 0.08,
    metalness: 0.1,
    transparent: true,
    opacity: isSoftwareGl ? 0.38 : 0.45,
    clearcoat: 1.0,
    depthWrite: false,
  });

  project.openings.forEach((op) => {
    const g = new THREE.Group();
    if (op.kind === 'window') {
      const winH = 1.25;
      const frame = new THREE.Mesh(new THREE.BoxGeometry(op.width, winH, wallThickM + 0.06), frameMat);
      const pane = new THREE.Mesh(new THREE.BoxGeometry(op.width - 0.12, winH - 0.12, 0.03), glassMat);
      g.add(frame, pane);
      g.position.set(toWorldX(op.x), Math.min(1.45, wallH * 0.62), toWorldZ(op.y));
    } else {
      const doorH = Math.min(2.1, wallH - 0.08);
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(op.width, doorH, wallThickM + 0.04), doorWoodMat);
      const handle = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), new THREE.MeshStandardMaterial({ color: 0xfbbf24, metalness: 0.85, roughness: 0.2 }));
      handle.position.set(op.width * 0.35, -0.08, (wallThickM + 0.08) / 2);
      g.add(leaf, handle);
      g.position.set(toWorldX(op.x), doorH / 2, toWorldZ(op.y));
    }
    g.rotation.y = -(op.rotation * Math.PI) / 180;
    root.add(g);
  });

  // 5. Composite 3D Furniture
  project.furniture.forEach((f) => {
    const fg = buildFurnitureGroup(f);
    fg.position.set(toWorldX(f.x), 0.03, toWorldZ(f.y));
    fg.rotation.y = -(f.rotation * Math.PI) / 180;
    root.add(fg);
  });

  // 6. Composite 3D Electrical Fixtures + Circuit Conduit Lines
  project.points.forEach((pt) => {
    const isSelected = pt.id === selectedPointId;
    const fx = buildElectricalFixture(pt, isSelected, lightingMode, isSoftwareGl, fanRotors);
    // Clamp fixture height visually into cutaway ceiling plane when in Orbit mode
    const visualY = cutawayWalls ? Math.min(pt.z, wallH - 0.06) : Math.min(pt.z, ceilingM - 0.05);
    const wx = toWorldX(pt.x);
    const wz = toWorldZ(pt.y);
    fx.position.set(wx, Math.max(0.35, visualY), wz);
    fx.rotation.y = -(pt.rotation * Math.PI) / 180;
    root.add(fx);
    clickables.push(fx);
    pointAnchors.set(pt.id, new THREE.Vector3(wx, Math.max(0.45, visualY + 0.22), wz));
  });

  // Clean disposal helper
  const dispose = () => {
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
        obj.geometry?.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else if (obj.material) {
          obj.material.dispose();
        }
      }
    });
  };

  return { root, clickables, fanRotors, pointAnchors, dispose };
}
