import { FT_TO_M, M_TO_FT, siteToMeters } from '../data/presets';
import { ProjectData, RoomZone, UnitSystem } from '../types/design';

const EPS = 0.015; // 1.5 cm tolerance for shared walls and floating-point comparisons

export function getItemFloor(item: { floor?: number }): number {
  return item.floor && item.floor >= 1 ? Math.floor(item.floor) : 1;
}

export function formatFloorLabel(floor: number): string {
  const n = Math.max(1, Math.floor(floor));
  if (n === 1) return '1st Floor';
  if (n === 2) return '2nd Floor';
  if (n === 3) return '3rd Floor';
  return `${n}th Floor`;
}

/**
 * Returns a floor-scoped view of ProjectData containing only elements belonging to `floor` (1-based).
 * Used for per-floor 2D editing, geometric validation, wall extraction, and elevated 3D floor rendering.
 */
export function sliceProjectForFloor(project: ProjectData, floor: number): ProjectData {
  const target = Math.max(1, Math.floor(floor));
  return {
    ...project,
    rooms: project.rooms.filter((r) => getItemFloor(r) === target),
    customWalls: project.customWalls.filter((w) => getItemFloor(w) === target),
    openings: project.openings.filter((o) => getItemFloor(o) === target),
    dimensions: (project.dimensions ?? []).filter((d) => getItemFloor(d) === target),
    furniture: project.furniture.filter((f) => getItemFloor(f) === target),
    points: project.points.filter((p) => getItemFloor(p) === target),
  };
}

export function toMeters(value: number, units: UnitSystem): number {
  return units === 'ft' ? value * FT_TO_M : value;
}

export function fromMeters(meters: number, units: UnitSystem): number {
  return units === 'ft' ? meters * M_TO_FT : meters;
}

export function formatLength(meters: number, units: UnitSystem, decimals = 1): string {
  const val = fromMeters(meters, units);
  const rounded = Number(val.toFixed(decimals));
  return units === 'ft' ? `${rounded} ft` : `${rounded} m`;
}

export function formatArea(sqMeters: number, units: UnitSystem): string {
  if (units === 'ft') {
    const sqft = sqMeters * M_TO_FT * M_TO_FT;
    return `${Math.round(sqft).toLocaleString('en-IN')} sq. ft.`;
  }
  return `${sqMeters.toFixed(1)} sq. m.`;
}

export function formatWallThickness(meters: number, units: UnitSystem): string {
  if (units === 'ft') {
    const inches = Math.round(meters * M_TO_FT * 12);
    return `${inches} in`;
  }
  return `${(meters * 100).toFixed(0)} cm`;
}

export interface RoomValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Strict mathematical geometric validation for placing, moving, resizing, or rotating a room.
 * Ensures rooms stay inside site boundaries, have positive dimensions, and do not overlap interiors.
 * Touching/adjacent boundaries (shared walls) are explicitly allowed.
 */
export function validateRoomPlacement(
  candidate: { x: number; y: number; width: number; height: number },
  project: ProjectData,
  ignoreRoomId?: string
): RoomValidationResult {
  const { lengthM, widthM } = siteToMeters(project.site);
  const units = project.site.units;

  if (!Number.isFinite(candidate.width) || !Number.isFinite(candidate.height)) {
    return { valid: false, reason: 'Room dimensions must be valid numbers.' };
  }
  if (candidate.width <= 0.1 || candidate.height <= 0.1) {
    return { valid: false, reason: 'Room length and width must be greater than zero.' };
  }

  const candidateArea = candidate.width * candidate.height;
  const siteArea = lengthM * widthM;
  const usedArea = project.rooms
    .filter((r) => r.id !== ignoreRoomId)
    .reduce((sum, r) => sum + r.width * r.height, 0);
  const availableArea = Math.max(0, siteArea - usedArea);

  if (candidate.width > lengthM + EPS || candidate.height > widthM + EPS) {
    return {
      valid: false,
      reason: `Room (${formatLength(candidate.width, units)} × ${formatLength(candidate.height, units)}) exceeds site dimensions (${formatLength(lengthM, units)} × ${formatLength(widthM, units)}).`,
    };
  }

  if (candidateArea > availableArea + 0.05) {
    return {
      valid: false,
      reason: `Room area (${formatArea(candidateArea, units)}) exceeds remaining available site area (${formatArea(availableArea, units)}).`,
    };
  }

  if (
    candidate.x < -EPS ||
    candidate.y < -EPS ||
    candidate.x + candidate.width > lengthM + EPS ||
    candidate.y + candidate.height > widthM + EPS
  ) {
    return {
      valid: false,
      reason: `Room extends outside the ${formatLength(lengthM, units)} × ${formatLength(widthM, units)} site boundary. Reposition or reduce dimensions.`,
    };
  }

  // Check strict interior overlap against every other room (shared borders are permitted)
  for (const other of project.rooms) {
    if (other.id === ignoreRoomId) continue;
    const overlapX =
      Math.min(candidate.x + candidate.width, other.x + other.width) -
      Math.max(candidate.x, other.x);
    const overlapY =
      Math.min(candidate.y + candidate.height, other.y + other.height) -
      Math.max(candidate.y, other.y);

    if (overlapX > EPS && overlapY > EPS) {
      return {
        valid: false,
        reason: `Overlaps with "${other.name}". Move to an open area or align along its wall boundary.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Finds the nearest valid (x, y) inside the site boundary where a room of (width, height) fits without overlap.
 */
export function findNearestValidPosition(
  preferredX: number,
  preferredY: number,
  width: number,
  height: number,
  project: ProjectData,
  ignoreRoomId?: string
): { x: number; y: number } | null {
  const { lengthM, widthM } = siteToMeters(project.site);
  const clampedX = Math.max(0, Math.min(lengthM - width, preferredX));
  const clampedY = Math.max(0, Math.min(widthM - height, preferredY));

  if (
    validateRoomPlacement(
      { x: clampedX, y: clampedY, width, height },
      project,
      ignoreRoomId
    ).valid
  ) {
    return { x: Number(clampedX.toFixed(3)), y: Number(clampedY.toFixed(3)) };
  }

  // Search grid candidates (0.25m step) sorted by proximity to preferred location
  const step = project.site.units === 'ft' ? FT_TO_M : 0.25;
  const candidates: { x: number; y: number; dist: number }[] = [];

  // Include exact room boundary alignments for tight adjacent placement
  const xs = new Set<number>([0, Math.max(0, lengthM - width)]);
  const ys = new Set<number>([0, Math.max(0, widthM - height)]);
  project.rooms.forEach((r) => {
    if (r.id === ignoreRoomId) return;
    xs.add(r.x);
    xs.add(r.x + r.width);
    xs.add(r.x - width);
    ys.add(r.y);
    ys.add(r.y + r.height);
    ys.add(r.y - height);
  });
  for (let x = 0; x <= lengthM - width + EPS; x += step) xs.add(Number(x.toFixed(3)));
  for (let y = 0; y <= widthM - height + EPS; y += step) ys.add(Number(y.toFixed(3)));

  xs.forEach((cx) => {
    if (cx < -EPS || cx + width > lengthM + EPS) return;
    ys.forEach((cy) => {
      if (cy < -EPS || cy + height > widthM + EPS) return;
      const dist = Math.hypot(cx - preferredX, cy - preferredY);
      candidates.push({ x: Math.max(0, cx), y: Math.max(0, cy), dist });
    });
  });

  candidates.sort((a, b) => a.dist - b.dist);
  for (const c of candidates) {
    if (
      validateRoomPlacement(
        { x: c.x, y: c.y, width, height },
        project,
        ignoreRoomId
      ).valid
    ) {
      return { x: Number(c.x.toFixed(3)), y: Number(c.y.toFixed(3)) };
    }
  }
  return null;
}

export interface MergedWallSegment {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
  isExterior: boolean;
  source: 'perimeter' | 'room' | 'custom';
  customWallId?: string;
}

/**
 * Merges collinear overlapping horizontal/vertical segments so shared room walls never duplicate.
 */
function mergeCollinearSegments(
  segments: { fixed: number; start: number; end: number; thickness: number; isExterior: boolean }[]
) {
  const buckets = new Map<number, typeof segments>();
  segments.forEach((s) => {
    const key = Math.round(s.fixed * 20) / 20; // 5cm snap bucket
    const list = buckets.get(key) ?? [];
    list.push({
      ...s,
      fixed: key,
      start: Math.min(s.start, s.end),
      end: Math.max(s.start, s.end),
    });
    buckets.set(key, list);
  });

  const merged: typeof segments = [];
  buckets.forEach((list) => {
    list.sort((a, b) => a.start - b.start);
    for (const seg of list) {
      if (seg.end - seg.start < 0.05) continue;
      const prev = merged[merged.length - 1];
      if (
        prev &&
        Math.abs(prev.fixed - seg.fixed) < 0.04 &&
        prev.isExterior === seg.isExterior &&
        seg.start <= prev.end + 0.04
      ) {
        prev.end = Math.max(prev.end, seg.end);
        prev.thickness = Math.max(prev.thickness, seg.thickness);
      } else {
        merged.push({ ...seg });
      }
    }
  });
  return merged;
}

/**
 * Extracts canonical, deduplicated wall geometry from site perimeter + room boundaries + custom walls.
 * Adjacent rooms sharing a wall produce a single unified partition wall without overlapping geometry.
 */
export function extractMergedWalls(project: ProjectData): MergedWallSegment[] {
  const { lengthM, widthM, wallThickM } = siteToMeters(project.site);
  const result: MergedWallSegment[] = [];

  // 1. Exterior site perimeter walls
  result.push(
    { id: 'ext-n', x1: 0, y1: 0, x2: lengthM, y2: 0, thickness: wallThickM, isExterior: true, source: 'perimeter' },
    { id: 'ext-s', x1: 0, y1: widthM, x2: lengthM, y2: widthM, thickness: wallThickM, isExterior: true, source: 'perimeter' },
    { id: 'ext-w', x1: 0, y1: 0, x2: 0, y2: widthM, thickness: wallThickM, isExterior: true, source: 'perimeter' },
    { id: 'ext-e', x1: lengthM, y1: 0, x2: lengthM, y2: widthM, thickness: wallThickM, isExterior: true, source: 'perimeter' }
  );

  // 2. Collect interior room boundary edges (skipping edges lying directly on exterior perimeter)
  const hSegs: { fixed: number; start: number; end: number; thickness: number; isExterior: boolean }[] = [];
  const vSegs: { fixed: number; start: number; end: number; thickness: number; isExterior: boolean }[] = [];

  project.rooms.forEach((r) => {
    const thick = r.wallThickness ?? Math.max(0.11, wallThickM * 0.72);
    const x1 = r.x;
    const x2 = r.x + r.width;
    const y1 = r.y;
    const y2 = r.y + r.height;

    const withinX = x1 >= -0.08 && x2 <= lengthM + 0.08;
    const withinY = y1 >= -0.08 && y2 <= widthM + 0.08;

    const onNorthPerim = Math.abs(y1) < 0.08 && withinX;
    const onSouthPerim = Math.abs(y2 - widthM) < 0.08 && withinX;
    const onWestPerim = Math.abs(x1) < 0.08 && withinY;
    const onEastPerim = Math.abs(x2 - lengthM) < 0.08 && withinY;

    if (!onNorthPerim) {
      hSegs.push({ fixed: y1, start: x1, end: x2, thickness: thick, isExterior: false });
    }
    if (!onSouthPerim) {
      hSegs.push({ fixed: y2, start: x1, end: x2, thickness: thick, isExterior: false });
    }
    if (!onWestPerim) {
      vSegs.push({ fixed: x1, start: y1, end: y2, thickness: thick, isExterior: false });
    }
    if (!onEastPerim) {
      vSegs.push({ fixed: x2, start: y1, end: y2, thickness: thick, isExterior: false });
    }
  });

  mergeCollinearSegments(hSegs).forEach((s, idx) => {
    result.push({
      id: `rm-h-${idx}`,
      x1: s.start,
      y1: s.fixed,
      x2: s.end,
      y2: s.fixed,
      thickness: s.thickness,
      isExterior: false,
      source: 'room',
    });
  });

  mergeCollinearSegments(vSegs).forEach((s, idx) => {
    result.push({
      id: `rm-v-${idx}`,
      x1: s.fixed,
      y1: s.start,
      x2: s.fixed,
      y2: s.end,
      thickness: s.thickness,
      isExterior: false,
      source: 'room',
    });
  });

  // 3. User-drawn custom walls
  project.customWalls.forEach((cw) => {
    result.push({
      id: cw.id,
      x1: cw.x1,
      y1: cw.y1,
      x2: cw.x2,
      y2: cw.y2,
      thickness: cw.thickness ?? Math.max(0.11, wallThickM * 0.75),
      isExterior: cw.wallKind === 'external',
      source: 'custom',
      customWallId: cw.id,
    });
  });

  return result;
}

/**
 * Snaps a coordinate to room corners/edges first, then architectural grid.
 */
export function snapCoordinate(
  x: number,
  y: number,
  project: ProjectData,
  snapEnabled: boolean
): { x: number; y: number } {
  const { lengthM, widthM } = siteToMeters(project.site);
  const clampedX = Math.max(0, Math.min(lengthM, x));
  const clampedY = Math.max(0, Math.min(widthM, y));
  if (!snapEnabled) {
    return { x: Number(clampedX.toFixed(2)), y: Number(clampedY.toFixed(2)) };
  }

  // Snap step: 0.5 ft in Imperial or 0.1m in Metric
  const gridStep = project.site.units === 'ft' ? 0.5 * FT_TO_M : 0.1;
  let sx = Math.round(clampedX / gridStep) * gridStep;
  let sy = Math.round(clampedY / gridStep) * gridStep;

  // Magnetic snap to site edges and existing room boundary lines within 0.18m
  const threshold = 0.18;
  const xGuides = [0, lengthM];
  const yGuides = [0, widthM];
  project.rooms.forEach((r) => {
    xGuides.push(r.x, r.x + r.width);
    yGuides.push(r.y, r.y + r.height);
  });

  for (const gx of xGuides) {
    if (Math.abs(clampedX - gx) < threshold) {
      sx = gx;
      break;
    }
  }
  for (const gy of yGuides) {
    if (Math.abs(clampedY - gy) < threshold) {
      sy = gy;
      break;
    }
  }

  return {
    x: Number(Math.max(0, Math.min(lengthM, sx)).toFixed(3)),
    y: Number(Math.max(0, Math.min(widthM, sy)).toFixed(3)),
  };
}

/**
 * Unclamped coordinate snapping so users can freely dismantle sections and place them anywhere on the canvas.
 */
export function snapCoordinateFree(
  x: number,
  y: number,
  project: ProjectData,
  snapEnabled: boolean,
  ignoreRoomId?: string
): { x: number; y: number } {
  if (!snapEnabled) {
    return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
  }

  const { lengthM, widthM } = siteToMeters(project.site);
  const gridStep = project.site.units === 'ft' ? 0.5 * FT_TO_M : 0.1;
  let sx = Math.round(x / gridStep) * gridStep;
  let sy = Math.round(y / gridStep) * gridStep;

  const threshold = 0.16;
  const xGuides = [0, lengthM];
  const yGuides = [0, widthM];
  project.rooms.forEach((r) => {
    if (r.id === ignoreRoomId) return;
    xGuides.push(r.x, r.x + r.width);
    yGuides.push(r.y, r.y + r.height);
  });

  for (const gx of xGuides) {
    if (Math.abs(x - gx) < threshold) {
      sx = gx;
      break;
    }
  }
  for (const gy of yGuides) {
    if (Math.abs(y - gy) < threshold) {
      sy = gy;
      break;
    }
  }

  return {
    x: Number(sx.toFixed(3)),
    y: Number(sy.toFixed(3)),
  };
}

/**
 * Finds the closest point on any wall segment for snapping doors and windows onto walls.
 */
export function findNearestWallAttachment(
  px: number,
  py: number,
  walls: MergedWallSegment[],
  maxDist = 0.85
): { x: number; y: number; rotation: number; wall: MergedWallSegment } | null {
  let best: { x: number; y: number; rotation: number; wall: MergedWallSegment; dist: number } | null = null;

  for (const wall of walls) {
    const dx = wall.x2 - wall.x1;
    const dy = wall.y2 - wall.y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 0.04) continue;

    const t = Math.max(0.08, Math.min(0.92, ((px - wall.x1) * dx + (py - wall.y1) * dy) / lenSq));
    const projX = wall.x1 + t * dx;
    const projY = wall.y1 + t * dy;
    const dist = Math.hypot(px - projX, py - projY);

    if (dist <= maxDist && (!best || dist < best.dist)) {
      const rot = (Math.atan2(dy, dx) * 180) / Math.PI;
      best = {
        x: Number(projX.toFixed(3)),
        y: Number(projY.toFixed(3)),
        rotation: Math.round(rot),
        wall,
        dist,
      };
    }
  }

  return best ? { x: best.x, y: best.y, rotation: best.rotation, wall: best.wall } : null;
}

export function isPointInsideRoom(room: RoomZone, x: number, y: number): boolean {
  return x >= room.x && x <= room.x + room.width && y >= room.y && y <= room.y + room.height;
}
