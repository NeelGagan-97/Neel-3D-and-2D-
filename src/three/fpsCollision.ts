import { siteToMeters } from '../data/presets';
import { ArchitecturalOpening, ProjectData } from '../types/design';
import { extractMergedWalls, sliceProjectForFloor } from '../utils/geometry';

/** Standard human eye height above finished floor level in metres */
export const FPS_EYE_HEIGHT_M = 1.65;

/** Player horizontal collision radius in floor-plan metres */
export const FPS_PLAYER_RADIUS_M = 0.28;

export interface FpsObstacleBox {
  id: string;
  kind: 'wall' | 'furniture';
  /** Center X in floor-plan metres */
  cx: number;
  /** Center Y in floor-plan metres */
  cy: number;
  /** Half-length along local X axis (metres) */
  hx: number;
  /** Half-depth along local Y axis (metres) */
  hy: number;
  /** Rotation in radians in 2D floor-plan (X, Y) coordinates */
  theta: number;
}

export interface HorizontalMoveInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
}

export interface NormalizedMoveVector {
  forward: number;
  right: number;
  moving: boolean;
}

/**
 * Normalizes WASD horizontal movement so diagonal motion (e.g. W+D) moves at the exact same
 * speed as cardinal motion (W, A, S, D).
 */
export function normalizeHorizontalMoveInput(input: HorizontalMoveInput): NormalizedMoveVector {
  let forward = (input.forward ? 1 : 0) - (input.backward ? 1 : 0);
  let right = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const len = Math.hypot(forward, right);
  if (len <= 0) {
    return { forward: 0, right: 0, moving: false };
  }
  forward /= len;
  right /= len;
  return { forward, right, moving: true };
}

/**
 * Splits a 1D wall segment [0, segLen] by subtracting any door openings that intersect the wall.
 * Returns remaining solid intervals [start, end] so players cannot clip through walls while
 * still being able to walk naturally through doorways.
 */
function subtractDoorIntervals(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  thickness: number,
  doors: ArchitecturalOpening[]
): Array<[number, number]> {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const segLen = Math.hypot(dx, dy);
  if (segLen < 0.05) return [];

  const ux = dx / segLen;
  const uy = dy / segLen;
  const gaps: Array<[number, number]> = [];
  const perpTolerance = Math.max(0.42, thickness * 1.6);

  for (const door of doors) {
    const relX = door.x - x1;
    const relY = door.y - y1;
    // Projection along wall & perpendicular distance to wall centerline
    const proj = relX * ux + relY * uy;
    const perp = Math.abs(-relX * uy + relY * ux);
    if (perp > perpTolerance) continue;

    // Require door orientation to be reasonably aligned with the wall (within ~35 deg)
    const doorRad = (door.rotation * Math.PI) / 180;
    const dux = Math.cos(doorRad);
    const duy = Math.sin(doorRad);
    const alignment = Math.abs(dux * ux + duy * uy);
    if (alignment < 0.72) continue;

    const halfW = Math.max(0.4, door.width / 2) + 0.06;
    const gStart = Math.max(0, proj - halfW);
    const gEnd = Math.min(segLen, proj + halfW);
    if (gEnd - gStart > 0.05) {
      gaps.push([gStart, gEnd]);
    }
  }

  if (gaps.length === 0) return [[0, segLen]];

  gaps.sort((a, b) => a[0] - b[0]);
  const mergedGaps: Array<[number, number]> = [];
  for (const g of gaps) {
    const last = mergedGaps[mergedGaps.length - 1];
    if (!last || g[0] > last[1]) {
      mergedGaps.push([g[0], g[1]]);
    } else {
      last[1] = Math.max(last[1], g[1]);
    }
  }

  const solids: Array<[number, number]> = [];
  let cursor = 0;
  for (const [gs, ge] of mergedGaps) {
    if (gs - cursor > 0.06) {
      solids.push([cursor, gs]);
    }
    cursor = Math.max(cursor, ge);
  }
  if (segLen - cursor > 0.06) {
    solids.push([cursor, segLen]);
  }
  return solids;
}

/**
 * Builds the list of oriented bounding box colliders for walls (with doorway openings carved out)
 * and solid furniture obstacles on the active floor.
 */
export function buildFloorCollisionObstacles(
  project: ProjectData,
  activeFloor: number
): FpsObstacleBox[] {
  const floorSlice = sliceProjectForFloor(project, activeFloor);
  const obstacles: FpsObstacleBox[] = [];
  const doors = floorSlice.openings.filter((op) => op.kind === 'door');

  // 1. Structural exterior & interior partition walls (with doorways carved out)
  const mergedWalls = extractMergedWalls(floorSlice);
  mergedWalls.forEach((seg) => {
    const dx = seg.x2 - seg.x1;
    const dy = seg.y2 - seg.y1;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 0.08) return;

    const ux = dx / segLen;
    const uy = dy / segLen;
    const theta = Math.atan2(dy, dx);
    const solidIntervals = subtractDoorIntervals(
      seg.x1,
      seg.y1,
      seg.x2,
      seg.y2,
      seg.thickness,
      doors
    );

    solidIntervals.forEach(([s, e], idx) => {
      const partLen = e - s;
      if (partLen < 0.06) return;
      const mid = (s + e) / 2;
      obstacles.push({
        id: `${seg.id}-part-${idx}`,
        kind: 'wall',
        cx: seg.x1 + ux * mid,
        cy: seg.y1 + uy * mid,
        hx: partLen / 2,
        hy: Math.max(0.06, seg.thickness / 2),
        theta,
      });
    });
  });

  // 2. Solid furniture obstacles on the active floor
  floorSlice.furniture.forEach((f) => {
    const w = Math.max(0.2, f.width);
    const d = Math.max(0.2, f.depth);
    obstacles.push({
      id: `furn-${f.id}`,
      kind: 'furniture',
      cx: f.x,
      cy: f.y,
      hx: w / 2,
      hy: d / 2,
      theta: (f.rotation * Math.PI) / 180,
    });
  });

  return obstacles;
}

/**
 * Checks whether a 2D circle (px, py, radius) overlaps any obstacle box.
 */
export function isPointCollidingWithObstacles(
  px: number,
  py: number,
  obstacles: readonly FpsObstacleBox[],
  radius = FPS_PLAYER_RADIUS_M
): boolean {
  const rSq = radius * radius;
  for (let i = 0; i < obstacles.length; i++) {
    const ob = obstacles[i];
    const cos = Math.cos(ob.theta);
    const sin = Math.sin(ob.theta);
    const dx = px - ob.cx;
    const dy = py - ob.cy;
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    const clx = Math.max(-ob.hx, Math.min(ob.hx, lx));
    const cly = Math.max(-ob.hy, Math.min(ob.hy, ly));
    const vx = lx - clx;
    const vy = ly - cly;
    if (vx * vx + vy * vy < rSq - 1e-6) {
      return true;
    }
  }
  return false;
}

/**
 * Pushes a player circle out of any overlapping OBBs in-place (supports smooth sliding along
 * orthogonal and angled walls).
 */
function resolveOverlapPushOut(
  px: number,
  py: number,
  obstacles: readonly FpsObstacleBox[],
  radius: number
): { x: number; y: number } {
  let x = px;
  let y = py;

  for (let iter = 0; iter < 4; iter++) {
    let anyPush = false;
    for (let i = 0; i < obstacles.length; i++) {
      const ob = obstacles[i];
      const cos = Math.cos(ob.theta);
      const sin = Math.sin(ob.theta);
      const dx = x - ob.cx;
      const dy = y - ob.cy;
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;

      const clx = Math.max(-ob.hx, Math.min(ob.hx, lx));
      const cly = Math.max(-ob.hy, Math.min(ob.hy, ly));
      const vx = lx - clx;
      const vy = ly - cly;
      const distSq = vx * vx + vy * vy;

      if (distSq < radius * radius) {
        let pushLx = 0;
        let pushLy = 0;
        if (distSq > 1e-8) {
          const dist = Math.sqrt(distSq);
          const overlap = radius - dist;
          pushLx = (vx / dist) * overlap;
          pushLy = (vy / dist) * overlap;
        } else {
          // Circle center is inside OBB: push out along shallowest local axis
          const penX = ob.hx - Math.abs(lx) + radius;
          const penY = ob.hy - Math.abs(ly) + radius;
          if (penX < penY) {
            pushLx = lx >= 0 ? penX : -penX;
          } else {
            pushLy = ly >= 0 ? penY : -penY;
          }
        }
        // Rotate push vector back into floor-plan world space
        x += pushLx * cos - pushLy * sin;
        y += pushLx * sin + pushLy * cos;
        anyPush = true;
      }
    }
    if (!anyPush) break;
  }

  return { x, y };
}

/**
 * Advances a player position by (deltaX, deltaY) in floor-plan metres with anti-tunneling
 * sub-stepping and smooth sliding collision response against walls and obstacles.
 */
export function resolveFpsMovementWithCollisions(
  currentX: number,
  currentY: number,
  deltaX: number,
  deltaY: number,
  obstacles: readonly FpsObstacleBox[],
  radius = FPS_PLAYER_RADIUS_M
): { x: number; y: number } {
  const dist = Math.hypot(deltaX, deltaY);
  if (dist < 1e-6) {
    return { x: currentX, y: currentY };
  }

  const maxStep = Math.max(0.08, radius * 0.45);
  const steps = Math.max(1, Math.ceil(dist / maxStep));
  const stepX = deltaX / steps;
  const stepY = deltaY / steps;

  let x = currentX;
  let y = currentY;
  for (let s = 0; s < steps; s++) {
    const resolved = resolveOverlapPushOut(x + stepX, y + stepY, obstacles, radius);
    x = resolved.x;
    y = resolved.y;
  }

  return { x, y };
}

/**
 * Computes a clean, unobstructed eye-level spawn point on the active floor looking straight ahead
 * (pitch = 0) into the interior space.
 */
export function computeInitialFpsSpawn(
  project: ProjectData,
  activeFloor: number,
  obstacles: readonly FpsObstacleBox[]
): { x: number; y: number; yaw: number; pitch: number } {
  const { lengthM, widthM } = siteToMeters(project.site);
  const safeL = Number.isFinite(lengthM) && lengthM > 1 ? lengthM : 10;
  const safeW = Number.isFinite(widthM) && widthM > 1 ? widthM : 8;
  const floorSlice = sliceProjectForFloor(project, activeFloor);

  // Prefer the largest interior room (typically living/hall) as starting location
  const sortedRooms = [...floorSlice.rooms].sort(
    (a, b) => b.width * b.height - a.width * a.height
  );
  const primaryRoom = sortedRooms[0];

  const baseX = primaryRoom ? primaryRoom.x + primaryRoom.width * 0.5 : safeL * 0.5;
  const baseY = primaryRoom ? primaryRoom.y + primaryRoom.height * 0.5 : safeW * 0.5;

  let spawnX = baseX;
  let spawnY = baseY;

  // Search spiral around preferred center to guarantee unobstructed interior spawn
  if (isPointCollidingWithObstacles(spawnX, spawnY, obstacles, FPS_PLAYER_RADIUS_M)) {
    let found = false;
    const minX = primaryRoom ? primaryRoom.x + 0.4 : 0.6;
    const maxX = primaryRoom ? primaryRoom.x + primaryRoom.width - 0.4 : safeL - 0.6;
    const minY = primaryRoom ? primaryRoom.y + 0.4 : 0.6;
    const maxY = primaryRoom ? primaryRoom.y + primaryRoom.height - 0.4 : safeW - 0.6;

    for (let ring = 1; ring <= 10 && !found; ring++) {
      const r = ring * 0.35;
      for (let a = 0; a < 12; a++) {
        const ang = (a * Math.PI * 2) / 12;
        const cx = Math.max(minX, Math.min(maxX, baseX + Math.cos(ang) * r));
        const cy = Math.max(minY, Math.min(maxY, baseY + Math.sin(ang) * r));
        if (!isPointCollidingWithObstacles(cx, cy, obstacles, FPS_PLAYER_RADIUS_M)) {
          spawnX = cx;
          spawnY = cy;
          found = true;
          break;
        }
      }
    }
    if (!found) {
      const pushed = resolveOverlapPushOut(baseX, baseY, obstacles, FPS_PLAYER_RADIUS_M);
      spawnX = pushed.x;
      spawnY = pushed.y;
    }
  }

  // Face horizontally toward the interior center of the floor plan (straight ahead, pitch = 0)
  const targetX = safeL * 0.5;
  const targetY = safeW * 0.5;
  const lookDx = targetX - spawnX;
  const lookDz = targetY - spawnY;
  // In Three.js FPS camera with rotation.order = 'YXZ', forward vector is (-sin(yaw), 0, -cos(yaw))
  const yaw =
    Math.hypot(lookDx, lookDz) > 0.35 ? Math.atan2(-lookDx, -lookDz) : 0;

  return {
    x: spawnX,
    y: spawnY,
    yaw,
    pitch: 0,
  };
}
