import { Colors, DxfWriter, LWPolylineFlags, point2d, point3d, Units } from '@tarikjabiri/dxf';
import DxfParser from 'dxf-parser';
import { M_TO_FT, siteToMeters } from '../data/presets';
import type { CadExportValidationResult } from '../types/aiDrawing';
import type { ProjectData } from '../types/design';
import { extractMergedWalls, formatFloorLabel, formatLength, sliceProjectForFloor } from './geometry';

export const CAD_DXF_LAYERS = {
  WALL_EXT: 'A-WALL-EXT',
  WALL_INT: 'A-WALL-INT',
  WALL_CURV: 'A-WALL-CURV',
  ROOMS: 'A-ROOM',
  DOORS: 'A-DOOR',
  WINDOWS: 'A-WIND',
  COLUMNS: 'S-COLS',
  SYMBOLS: 'E-SYMB',
  WIRING: 'E-WIRE',
  DIMENSIONS: 'A-DIMS',
  TEXT: 'A-TEXT',
  FURNITURE: 'A-FURN',
} as const;

export interface GeneratedDxfBundle {
  dxfContent: string;
  fileName: string;
  validation: CadExportValidationResult;
  entitySummary: {
    walls: number;
    rooms: number;
    openings: number;
    columns: number;
    symbols: number;
    wires: number;
    dimensions: number;
    annotations: number;
    furniture: number;
  };
}

function sanitizeDxfText(raw: string, maxLen = 80): string {
  return String(raw || '')
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function safeCadFileBase(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9-_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64) || 'Blue_Space_CAD_Plan'
  );
}

function isFiniteCoord(v: number): boolean {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6;
}

/**
 * Generates a genuine, AutoCAD/LibreCAD/QCAD-compatible DXF document for the active floor
 * using @tarikjabiri/dxf, preserving exact metric or imperial coordinates, CAD layers,
 * closed room LWPOLYLINEs (including irregular polygons), angled/curved walls, doors with
 * swing arcs, windows, structural columns, electrical symbols, wiring runs, and dimensions.
 *
 * Strictly validates the generated DXF via round-trip DxfParser verification before returning.
 */
export function generateValidatedProjectDxf(
  fullProject: ProjectData,
  activeFloor = 1
): GeneratedDxfBundle {
  const project = sliceProjectForFloor(fullProject, activeFloor);
  const { widthM } = siteToMeters(project.site);
  const useFeet = project.site.units === 'ft';
  const unitScale = useFeet ? M_TO_FT : 1;
  const maxY = Math.max(widthM, fullProject.aiDrawingImport?.drawingHeightMeters ?? widthM);

  // Convert Blue Space top-down (x right, y down) meters -> standard CAD right-handed (+X right, +Y up)
  const toCadX = (xM: number) => Number((xM * unitScale).toFixed(4));
  const toCadY = (yM: number) => Number(((maxY - yM) * unitScale).toFixed(4));
  const toCadLen = (lenM: number) => Number((lenM * unitScale).toFixed(4));

  const dxf = new DxfWriter();
  dxf.setUnits(useFeet ? Units.Feet : Units.Meters);

  // Register standard AIA/ISO-style architectural & electrical CAD layers
  dxf.addLayer(CAD_DXF_LAYERS.WALL_EXT, Colors.White, 'Continuous');
  dxf.addLayer(CAD_DXF_LAYERS.WALL_INT, Colors.Cyan, 'Continuous');
  dxf.addLayer(CAD_DXF_LAYERS.WALL_CURV, Colors.Cyan, 'Continuous');
  dxf.addLayer(CAD_DXF_LAYERS.ROOMS, Colors.Green, 'Continuous');
  dxf.addLayer(CAD_DXF_LAYERS.DOORS, Colors.Yellow, 'Continuous');
  dxf.addLayer(CAD_DXF_LAYERS.WINDOWS, Colors.Blue, 'Continuous');
  dxf.addLayer(CAD_DXF_LAYERS.COLUMNS, Colors.Magenta, 'Continuous');
  dxf.addLayer(CAD_DXF_LAYERS.SYMBOLS, Colors.Red, 'Continuous');
  dxf.addLayer(CAD_DXF_LAYERS.WIRING, Colors.Red, 'Continuous');
  dxf.addLayer(CAD_DXF_LAYERS.DIMENSIONS, Colors.Yellow, 'Continuous');
  dxf.addLayer(CAD_DXF_LAYERS.TEXT, Colors.White, 'Continuous');
  dxf.addLayer(CAD_DXF_LAYERS.FURNITURE, Colors.Magenta, 'Continuous');

  const summary = {
    walls: 0,
    rooms: 0,
    openings: 0,
    columns: 0,
    symbols: 0,
    wires: 0,
    dimensions: 0,
    annotations: 0,
    furniture: 0,
  };

  // 1. Walls & Building Boundaries (exact straight, angled, and tessellated curved walls)
  const customWallMap = new Map(project.customWalls.map((cw) => [cw.id, cw]));
  const walls = extractMergedWalls(project);
  for (const w of walls) {
    if (!isFiniteCoord(w.x1) || !isFiniteCoord(w.y1) || !isFiniteCoord(w.x2) || !isFiniteCoord(w.y2)) continue;
    if (Math.hypot(w.x2 - w.x1, w.y2 - w.y1) < 0.02) continue;
    const cw = w.customWallId ? customWallMap.get(w.customWallId) : undefined;
    const layerName = cw?.isCurvedSegment
      ? CAD_DXF_LAYERS.WALL_CURV
      : w.isExterior
        ? CAD_DXF_LAYERS.WALL_EXT
        : CAD_DXF_LAYERS.WALL_INT;
    dxf.addLine(
      point3d(toCadX(w.x1), toCadY(w.y1), 0),
      point3d(toCadX(w.x2), toCadY(w.y2), 0),
      { layerName }
    );
    summary.walls += 1;
  }

  // 2. Rooms & Spaces (exact closed LWPOLYLINE polygons + centered room label)
  const textH = toCadLen(0.28);
  for (const room of project.rooms) {
    const polyPts =
      Array.isArray(room.polygon) && room.polygon.length >= 3
        ? room.polygon.map((p) => ({ point: point2d(toCadX(p.x), toCadY(p.y)) }))
        : [
            { point: point2d(toCadX(room.x), toCadY(room.y)) },
            { point: point2d(toCadX(room.x + room.width), toCadY(room.y)) },
            { point: point2d(toCadX(room.x + room.width), toCadY(room.y + room.height)) },
            { point: point2d(toCadX(room.x), toCadY(room.y + room.height)) },
          ];
    dxf.addLWPolyline(polyPts, {
      flags: LWPolylineFlags.Closed,
      layerName: CAD_DXF_LAYERS.ROOMS,
    });
    const labelX = toCadX(room.x + room.width / 2);
    const labelY = toCadY(room.y + room.height / 2);
    const cleanRoomName = sanitizeDxfText(room.name, 48);
    if (cleanRoomName) {
      dxf.addText(point3d(labelX, labelY, 0), textH, cleanRoomName, {
        layerName: CAD_DXF_LAYERS.ROOMS,
      });
    }
    summary.rooms += 1;
  }

  // 3. Doors & Windows
  for (const op of project.openings) {
    if (!isFiniteCoord(op.x) || !isFiniteCoord(op.y)) continue;
    const rad = (-op.rotation * Math.PI) / 180; // Flip rotation for +Y-up CAD coordinates
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = toCadX(op.x);
    const cy = toCadY(op.y);
    const halfW = toCadLen(Math.max(0.3, op.width) / 2);

    const p1x = cx - halfW * cos;
    const p1y = cy - halfW * sin;
    const p2x = cx + halfW * cos;
    const p2y = cy + halfW * sin;

    if (op.kind === 'window') {
      const off = toCadLen(0.06);
      const nx = -sin * off;
      const ny = cos * off;
      dxf.addLine(point3d(p1x + nx, p1y + ny, 0), point3d(p2x + nx, p2y + ny, 0), {
        layerName: CAD_DXF_LAYERS.WINDOWS,
      });
      dxf.addLine(point3d(p1x - nx, p1y - ny, 0), point3d(p2x - nx, p2y - ny, 0), {
        layerName: CAD_DXF_LAYERS.WINDOWS,
      });
    } else {
      // Door leaf + 90-degree swing arc hinged at p1
      const leafLen = halfW * 2;
      const openX = p1x - sin * leafLen;
      const openY = p1y + cos * leafLen;
      dxf.addLine(point3d(p1x, p1y, 0), point3d(openX, openY, 0), {
        layerName: CAD_DXF_LAYERS.DOORS,
      });
      const startDeg = ((rad * 180) / Math.PI + 360) % 360;
      const endDeg = (startDeg + 90) % 360;
      dxf.addArc(point3d(p1x, p1y, 0), leafLen, startDeg, endDeg, {
        layerName: CAD_DXF_LAYERS.DOORS,
      });
    }
    summary.openings += 1;
  }

  // 4. Structural Columns
  const cols = (fullProject.aiDrawingImport?.columns ?? []).filter(
    (c) => (c.floor ?? 1) === activeFloor
  );
  for (const col of cols) {
    if (!isFiniteCoord(col.x) || !isFiniteCoord(col.y)) continue;
    const hw = Math.max(0.1, col.width / 2);
    const hh = Math.max(0.1, col.height / 2);
    dxf.addLWPolyline(
      [
        { point: point2d(toCadX(col.x - hw), toCadY(col.y - hh)) },
        { point: point2d(toCadX(col.x + hw), toCadY(col.y - hh)) },
        { point: point2d(toCadX(col.x + hw), toCadY(col.y + hh)) },
        { point: point2d(toCadX(col.x - hw), toCadY(col.y + hh)) },
      ],
      { flags: LWPolylineFlags.Closed, layerName: CAD_DXF_LAYERS.COLUMNS }
    );
    const colLabel = sanitizeDxfText(col.label, 24);
    if (colLabel) {
      dxf.addText(point3d(toCadX(col.x), toCadY(col.y), 0), toCadLen(0.18), colLabel, {
        layerName: CAD_DXF_LAYERS.COLUMNS,
      });
    }
    summary.columns += 1;
  }

  // 5. Furniture & Fixtures
  for (const f of project.furniture) {
    if (!isFiniteCoord(f.x) || !isFiniteCoord(f.y)) continue;
    const hw = Math.max(0.15, f.width / 2);
    const hd = Math.max(0.15, f.depth / 2);
    const rad = (-f.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = toCadX(f.x);
    const cy = toCadY(f.y);
    const corners: Array<[number, number]> = [
      [-toCadLen(hw), -toCadLen(hd)],
      [toCadLen(hw), -toCadLen(hd)],
      [toCadLen(hw), toCadLen(hd)],
      [-toCadLen(hw), toCadLen(hd)],
    ];
    dxf.addLWPolyline(
      corners.map(([lx, ly]) => ({
        point: point2d(cx + lx * cos - ly * sin, cy + lx * sin + ly * cos),
      })),
      { flags: LWPolylineFlags.Closed, layerName: CAD_DXF_LAYERS.FURNITURE }
    );
    summary.furniture += 1;
  }

  // 6. Electrical & Lighting Symbols
  const symRadius = toCadLen(0.22);
  const symTextH = toCadLen(0.2);
  for (const pt of project.points) {
    if (!isFiniteCoord(pt.x) || !isFiniteCoord(pt.y)) continue;
    const cx = toCadX(pt.x);
    const cy = toCadY(pt.y);
    if (pt.itemType === 'distribution_board') {
      const rw = symRadius * 1.4;
      const rh = symRadius * 0.9;
      dxf.addLWPolyline(
        [
          { point: point2d(cx - rw, cy - rh) },
          { point: point2d(cx + rw, cy - rh) },
          { point: point2d(cx + rw, cy + rh) },
          { point: point2d(cx - rw, cy + rh) },
        ],
        { flags: LWPolylineFlags.Closed, layerName: CAD_DXF_LAYERS.SYMBOLS }
      );
      dxf.addLine(point3d(cx - rw, cy - rh, 0), point3d(cx + rw, cy + rh, 0), {
        layerName: CAD_DXF_LAYERS.SYMBOLS,
      });
    } else {
      dxf.addCircle(point3d(cx, cy, 0), symRadius, {
        layerName: CAD_DXF_LAYERS.SYMBOLS,
      });
      // Crosshair inside lighting/fan fixtures for standard CAD readability
      dxf.addLine(point3d(cx - symRadius, cy, 0), point3d(cx + symRadius, cy, 0), {
        layerName: CAD_DXF_LAYERS.SYMBOLS,
      });
      dxf.addLine(point3d(cx, cy - symRadius, 0), point3d(cx, cy + symRadius, 0), {
        layerName: CAD_DXF_LAYERS.SYMBOLS,
      });
    }
    const symCode = sanitizeDxfText(pt.code || pt.name, 28);
    if (symCode) {
      dxf.addText(point3d(cx + symRadius * 1.25, cy + symRadius * 0.4, 0), symTextH, symCode, {
        layerName: CAD_DXF_LAYERS.SYMBOLS,
      });
    }
    summary.symbols += 1;
  }

  // 7. Electrical Wiring Runs
  const pointById = new Map(project.points.map((p) => [p.id, p]));
  for (const wire of project.wires ?? []) {
    const a = pointById.get(wire.fromPointId);
    const b = pointById.get(wire.toPointId);
    if (!a || !b) continue;
    const pathPts = [
      { point: point2d(toCadX(a.x), toCadY(a.y)) },
      ...(wire.waypoints ?? []).map((wp) => ({ point: point2d(toCadX(wp.x), toCadY(wp.y)) })),
      { point: point2d(toCadX(b.x), toCadY(b.y)) },
    ];
    dxf.addLWPolyline(pathPts, {
      flags: LWPolylineFlags.None,
      layerName: CAD_DXF_LAYERS.WIRING,
    });
    summary.wires += 1;
  }

  // 8. Dimension Lines & Measurements
  for (const dim of project.dimensions ?? []) {
    if (!isFiniteCoord(dim.x1) || !isFiniteCoord(dim.y1) || !isFiniteCoord(dim.x2) || !isFiniteCoord(dim.y2)) continue;
    const distM = Math.hypot(dim.x2 - dim.x1, dim.y2 - dim.y1);
    if (distM < 0.05) continue;
    const x1 = toCadX(dim.x1);
    const y1 = toCadY(dim.y1);
    const x2 = toCadX(dim.x2);
    const y2 = toCadY(dim.y2);
    dxf.addLine(point3d(x1, y1, 0), point3d(x2, y2, 0), {
      layerName: CAD_DXF_LAYERS.DIMENSIONS,
    });
    const label = sanitizeDxfText(formatLength(distM, project.site.units, 2), 24);
    dxf.addText(point3d((x1 + x2) / 2, (y1 + y2) / 2 + toCadLen(0.14), 0), toCadLen(0.22), label, {
      layerName: CAD_DXF_LAYERS.DIMENSIONS,
    });
    summary.dimensions += 1;
  }

  // 9. Clean Architectural Text Annotations (strictly excluding legend-text & title-block contamination)
  const cleanTexts = (fullProject.aiDrawingImport?.textAnnotations ?? []).filter(
    (t) =>
      (t.floor ?? 1) === activeFloor &&
      t.kind !== 'legend-text' &&
      t.kind !== 'title-block'
  );
  for (const txt of cleanTexts) {
    if (!isFiniteCoord(txt.x) || !isFiniteCoord(txt.y)) continue;
    const val = sanitizeDxfText(txt.text, 64);
    if (!val) continue;
    dxf.addText(point3d(toCadX(txt.x), toCadY(txt.y), 0), toCadLen(0.22), val, {
      layerName: CAD_DXF_LAYERS.TEXT,
    });
    summary.annotations += 1;
  }

  const dxfContent = dxf.stringify();
  const validation = validateDxfContent(dxfContent);

  const floorSlug = safeCadFileBase(formatFloorLabel(activeFloor));
  const fileName = `${safeCadFileBase(fullProject.name)}_${floorSlug}.dxf`;

  return {
    dxfContent,
    fileName,
    validation,
    entitySummary: summary,
  };
}

/**
 * Strictly parses and validates a DXF string using dxf-parser before offering any download.
 * Checks required sections (HEADER, TABLES, ENTITIES, EOF), zero NaN/Infinity values,
 * valid layer table definitions, and non-zero parsed CAD entities.
 */
export function validateDxfContent(dxfContent: string): CadExportValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byteLength =
    typeof TextEncoder !== 'undefined'
      ? new TextEncoder().encode(dxfContent).byteLength
      : dxfContent.length;

  const hasHeader = /\bHEADER\b/.test(dxfContent);
  const hasTables = /\bTABLES\b/.test(dxfContent);
  const hasEntities = /\bENTITIES\b/.test(dxfContent);
  const hasEof = /\bEOF\s*$/m.test(dxfContent);

  if (!hasHeader) errors.push('DXF is missing HEADER section.');
  if (!hasTables) errors.push('DXF is missing TABLES section.');
  if (!hasEntities) errors.push('DXF is missing ENTITIES section.');
  if (!hasEof) errors.push('DXF is missing terminating EOF marker.');
  if (/\b(?:NaN|Infinity|-Infinity)\b/.test(dxfContent)) {
    errors.push('DXF contains non-finite numeric coordinates (NaN or Infinity).');
  }

  let entityCount = 0;
  let layerNames: string[] = [];

  try {
    const parser = new DxfParser();
    const parsed = parser.parseSync(dxfContent);
    if (!parsed) {
      errors.push('DXF parser returned null — malformed DXF structure.');
    } else {
      entityCount = Array.isArray(parsed.entities) ? parsed.entities.length : 0;
      const layerTable = parsed.tables?.layer?.layers;
      if (layerTable && typeof layerTable === 'object') {
        layerNames = Object.keys(layerTable);
      }
      if (entityCount === 0) {
        errors.push('DXF contains 0 entities in ENTITIES section.');
      }
      if (layerNames.length === 0) {
        warnings.push('No custom CAD layers were found in the LAYER table.');
      }
    }
  } catch (err) {
    errors.push(
      `DXF round-trip parser validation failed: ${
        err instanceof Error ? err.message : 'Unknown parser error'
      }`
    );
  }

  return {
    valid: errors.length === 0,
    format: 'dxf',
    entityCount,
    layerNames,
    hasHeader,
    hasTables,
    hasEntities,
    hasEof,
    byteLength,
    errors,
    warnings,
  };
}

/**
 * Triggers a validated DXF file download in the browser.
 * Refuses to download if DXF round-trip validation fails.
 */
export function downloadValidatedProjectDxf(
  fullProject: ProjectData,
  activeFloor = 1
): { ok: true; bundle: GeneratedDxfBundle } | { ok: false; error: string } {
  const bundle = generateValidatedProjectDxf(fullProject, activeFloor);
  if (!bundle.validation.valid) {
    return {
      ok: false,
      error: `DXF validation failed: ${bundle.validation.errors.join(' ')}`,
    };
  }
  const blob = new Blob([bundle.dxfContent], { type: 'application/dxf;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = bundle.fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
  return { ok: true, bundle };
}
