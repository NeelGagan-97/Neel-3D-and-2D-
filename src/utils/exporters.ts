import { computeProjectMetrics, siteToMeters } from '../data/presets';
import { projectStorage } from '../services/projectStorage';
import { ProjectData } from '../types/design';
import { extractMergedWalls, formatArea, formatFloorLabel, formatLength, sliceProjectForFloor } from './geometry';

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/^_+|_+$/g, '') || 'Blue_Space_Floor_Plan';
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Renders a crisp, print-grade architectural floor plan canvas containing:
 * - Project Name & Reference
 * - Site Dimensions & 4-side Measurement Annotations
 * - Room Names, Dimensions, Areas
 * - Merged Structural & Internal Partition Walls
 * - Doors, Windows, Dimension Lines
 * - Total Built-Up Area & Remaining Available Area
 */
function renderArchitecturalSheetCanvas(
  fullProject: ProjectData,
  lightPaper = false,
  activeFloor = 1
): HTMLCanvasElement {
  const project = sliceProjectForFloor(fullProject, activeFloor);
  const W = 1600;
  const H = 1130; // ~A4 landscape ratio
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  const metrics = computeProjectMetrics(project);
  const { lengthM, widthM } = siteToMeters(project.site);
  const units = project.site.units;
  const walls = extractMergedWalls(project);

  // Palette (CAD dark for PNG, crisp architectural blueprint paper for PDF)
  const bg = lightPaper ? '#FFFFFF' : '#080F20';
  const panelBg = lightPaper ? '#F8FAFC' : '#111C31';
  const gridCol = lightPaper ? '#E2E8F0' : '#1D2B44';
  const borderCol = lightPaper ? '#CBD5E1' : '#2C3E5E';
  const textPrimary = lightPaper ? '#0F172A' : '#F5F7FA';
  const textMuted = lightPaper ? '#475569' : '#C5CDD8';
  const accentBlue = lightPaper ? '#0284C7' : '#00A8FF';
  const accentAmber = lightPaper ? '#D97706' : '#FF9D00';
  const wallOuter = lightPaper ? '#0F172A' : '#F5F7FA';
  const wallInner = lightPaper ? '#334155' : '#CBD5E1';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Header Title Block
  const headerH = 92;
  ctx.fillStyle = panelBg;
  ctx.fillRect(0, 0, W, headerH);
  ctx.strokeStyle = borderCol;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, headerH);
  ctx.lineTo(W, headerH);
  ctx.stroke();

  ctx.fillStyle = accentBlue;
  ctx.font = '700 13px "Red Hat Mono", monospace';
  ctx.fillText('BLUE SPACE // ARCHITECTURAL FLOOR PLAN', 40, 32);

  ctx.fillStyle = textPrimary;
  ctx.font = '700 28px "Red Hat Text", sans-serif';
  const floorSuffix = project.site.floors > 1 ? ` — ${formatFloorLabel(activeFloor)}` : '';
  ctx.fillText(`${project.name}${floorSuffix}`, 40, 68);

  ctx.textAlign = 'right';
  ctx.fillStyle = textPrimary;
  ctx.font = '600 16px "Red Hat Mono", monospace';
  ctx.fillText(`SITE: ${metrics.dimensionsDisplay} (${metrics.areaDisplay})`, W - 40, 42);
  ctx.fillStyle = textMuted;
  ctx.font = '500 13px "Red Hat Mono", monospace';
  ctx.fillText(
    `REF: ${project.refCode} · BUILT-UP: ${formatArea(metrics.builtUpAreaSqM, units)} · AVAILABLE: ${formatArea(metrics.remainingAreaSqM, units)}`,
    W - 40,
    68
  );
  ctx.textAlign = 'left';

  // Floor Plan Drawing Viewport Area
  const drawAreaX = 95;
  const drawAreaY = headerH + 85;
  const drawAreaW = W - 190;
  const drawAreaH = H - headerH - 255;

  const scale = Math.min(drawAreaW / Math.max(1, lengthM), drawAreaH / Math.max(1, widthM));
  const planW = lengthM * scale;
  const planH = widthM * scale;
  const ox = drawAreaX + (drawAreaW - planW) / 2;
  const oy = drawAreaY + (drawAreaH - planH) / 2;

  // Grid inside site
  const stepM = units === 'ft' ? 0.3048 * 2 : 1; // 2ft or 1m grid lines
  ctx.strokeStyle = gridCol;
  ctx.lineWidth = 1;
  for (let gx = 0; gx <= lengthM + 0.01; gx += stepM) {
    const px = ox + gx * scale;
    ctx.beginPath();
    ctx.moveTo(px, oy);
    ctx.lineTo(px, oy + planH);
    ctx.stroke();
  }
  for (let gy = 0; gy <= widthM + 0.01; gy += stepM) {
    const py = oy + gy * scale;
    ctx.beginPath();
    ctx.moveTo(ox, py);
    ctx.lineTo(ox + planW, py);
    ctx.stroke();
  }

  // Rooms
  project.rooms.forEach((room) => {
    const rx = ox + room.x * scale;
    const ry = oy + room.y * scale;
    const rw = room.width * scale;
    const rh = room.height * scale;

    ctx.fillStyle = lightPaper ? 'rgba(2, 132, 199, 0.06)' : 'rgba(0, 168, 255, 0.08)';
    ctx.fillRect(rx, ry, rw, rh);

    ctx.textAlign = 'center';
    ctx.fillStyle = textPrimary;
    ctx.font = '700 15px "Red Hat Text", sans-serif';
    ctx.fillText(room.name.toUpperCase(), rx + rw / 2, ry + rh / 2 - 8);

    ctx.fillStyle = accentBlue;
    ctx.font = '600 13px "Red Hat Mono", monospace';
    ctx.fillText(
      `${formatLength(room.width, units)} × ${formatLength(room.height, units)}`,
      rx + rw / 2,
      ry + rh / 2 + 12
    );

    ctx.fillStyle = textMuted;
    ctx.font = '500 11px "Red Hat Mono", monospace';
    ctx.fillText(formatArea(room.width * room.height, units), rx + rw / 2, ry + rh / 2 + 29);
    ctx.textAlign = 'left';
  });

  // Merged Structural & Internal Walls
  walls.forEach((w) => {
    ctx.strokeStyle = w.isExterior ? wallOuter : wallInner;
    ctx.lineWidth = Math.max(3, w.thickness * scale);
    ctx.lineCap = 'square';
    ctx.beginPath();
    ctx.moveTo(ox + w.x1 * scale, oy + w.y1 * scale);
    ctx.lineTo(ox + w.x2 * scale, oy + w.y2 * scale);
    ctx.stroke();
  });

  // Doors & Windows
  project.openings.forEach((op) => {
    ctx.save();
    ctx.translate(ox + op.x * scale, oy + op.y * scale);
    ctx.rotate((op.rotation * Math.PI) / 180);
    const ow = op.width * scale;

    // Wall cutout
    ctx.strokeStyle = bg;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(-ow / 2, 0);
    ctx.lineTo(ow / 2, 0);
    ctx.stroke();

    if (op.kind === 'window') {
      ctx.strokeStyle = accentBlue;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-ow / 2, -3);
      ctx.lineTo(ow / 2, -3);
      ctx.moveTo(-ow / 2, 3);
      ctx.lineTo(ow / 2, 3);
      ctx.stroke();
    } else {
      ctx.strokeStyle = accentAmber;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(-ow / 2, 0);
      ctx.lineTo(-ow / 2, ow * 0.85);
      ctx.stroke();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(-ow / 2, 0, ow * 0.85, 0, Math.PI / 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  });

  // Custom Dimension Annotations
  (project.dimensions ?? []).forEach((dim) => {
    const x1 = ox + dim.x1 * scale;
    const y1 = oy + dim.y1 * scale;
    const x2 = ox + dim.x2 * scale;
    const y2 = oy + dim.y2 * scale;
    const distM = Math.hypot(dim.x2 - dim.x1, dim.y2 - dim.y1);
    ctx.strokeStyle = accentAmber;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = accentAmber;
    ctx.font = '600 12px "Red Hat Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(formatLength(distM, units), (x1 + x2) / 2, (y1 + y2) / 2 - 6);
    ctx.textAlign = 'left';
  });

  // Four-Side Outer Site Measurement Annotations
  const drawDimLine = (x1: number, y1: number, x2: number, y2: number, label: string, vertical = false) => {
    ctx.strokeStyle = accentBlue;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // Ticks
    const tick = 7;
    ctx.beginPath();
    if (!vertical) {
      ctx.moveTo(x1, y1 - tick);
      ctx.lineTo(x1, y1 + tick);
      ctx.moveTo(x2, y2 - tick);
      ctx.lineTo(x2, y2 + tick);
    } else {
      ctx.moveTo(x1 - tick, y1);
      ctx.lineTo(x1 + tick, y1);
      ctx.moveTo(x2 - tick, y2);
      ctx.lineTo(x2 + tick, y2);
    }
    ctx.stroke();

    ctx.save();
    ctx.translate((x1 + x2) / 2, (y1 + y2) / 2);
    if (vertical) ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = panelBg;
    ctx.fillRect(-46, -12, 92, 24);
    ctx.strokeStyle = borderCol;
    ctx.strokeRect(-46, -12, 92, 24);
    ctx.fillStyle = textPrimary;
    ctx.font = '600 13px "Red Hat Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, 0, 5);
    ctx.restore();
  };

  const lenLabel = formatLength(lengthM, units);
  const widLabel = formatLength(widthM, units);
  drawDimLine(ox, oy - 34, ox + planW, oy - 34, lenLabel, false); // Top
  drawDimLine(ox, oy + planH + 34, ox + planW, oy + planH + 34, lenLabel, false); // Bottom
  drawDimLine(ox - 34, oy, ox - 34, oy + planH, widLabel, true); // Left
  drawDimLine(ox + planW + 34, oy, ox + planW + 34, oy + planH, widLabel, true); // Right

  // Footer Room Schedule Strip
  const footerY = H - 108;
  ctx.fillStyle = panelBg;
  ctx.fillRect(0, footerY, W, 108);
  ctx.strokeStyle = borderCol;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, footerY);
  ctx.lineTo(W, footerY);
  ctx.stroke();

  ctx.fillStyle = textMuted;
  ctx.font = '600 12px "Red Hat Mono", monospace';
  ctx.fillText(
    `ROOMS (${project.rooms.length}): ${
      project.rooms.length > 0
        ? project.rooms
            .map((r) => `${r.name} [${formatLength(r.width, units)}×${formatLength(r.height, units)}]`)
            .join('  ·  ')
            .slice(0, 145)
        : 'Blank Site Boundary'
    }`,
    40,
    footerY + 34
  );

  ctx.fillStyle = textPrimary;
  ctx.font = '600 13px "Red Hat Mono", monospace';
  ctx.fillText(
    `TOTAL SITE AREA: ${formatArea(metrics.siteAreaSqM, units)}   |   BUILT-UP AREA: ${formatArea(metrics.builtUpAreaSqM, units)}   |   REMAINING: ${formatArea(metrics.remainingAreaSqM, units)}   |   ELECTRICAL POINTS: ${metrics.totalPoints} (${metrics.totalKw.toFixed(2)} kW)`,
    40,
    footerY + 66
  );

  ctx.fillStyle = textMuted;
  ctx.font = '500 11px "Red Hat Mono", monospace';
  ctx.fillText(
    `GENERATED BY BLUE SPACE · ${new Date().toLocaleDateString('en-IN')}`,
    40,
    footerY + 90
  );

  return canvas;
}

export function downloadProjectJson(project: ProjectData) {
  const json = projectStorage.exportProjectJson(project);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  triggerDownload(blob, `${safeFileName(project.name)}.json`);
}

export function downloadNativeBluespace(project: ProjectData) {
  const payload = projectStorage.exportNativeBluespace(project);
  const blob = new Blob([payload], { type: 'application/octet-stream' });
  triggerDownload(blob, `${safeFileName(project.name)}.bluespace`);
}

export function downloadFloorPlanPng(project: ProjectData, activeFloor = 1) {
  const canvas = renderArchitecturalSheetCanvas(project, false, activeFloor);
  const suffix = project.site.floors > 1 ? `_Floor${activeFloor}` : '';
  canvas.toBlob((blob) => {
    if (blob) {
      triggerDownload(blob, `${safeFileName(project.name)}${suffix}_FloorPlan.png`);
    }
  }, 'image/png');
}

/**
 * Generates a self-contained single-page landscape A4 binary PDF embedding the high-res floor plan image.
 */
export function downloadFloorPlanPdf(project: ProjectData, activeFloor = 1) {
  const canvas = renderArchitecturalSheetCanvas(project, true, activeFloor);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const base64 = dataUrl.split(',')[1];
  const binaryStr = atob(base64);
  const imgBytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    imgBytes[i] = binaryStr.charCodeAt(i);
  }

  // A4 Landscape in PDF points: 842 x 595
  const pageW = 842;
  const pageH = 595;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0];
  let byteLen = 0;

  const pushStr = (s: string) => {
    const bytes = encoder.encode(s);
    chunks.push(bytes);
    byteLen += bytes.length;
  };
  const pushBytes = (b: Uint8Array) => {
    chunks.push(b);
    byteLen += b.length;
  };

  pushStr('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  // Obj 1: Catalog
  offsets.push(byteLen);
  pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // Obj 2: Pages
  offsets.push(byteLen);
  pushStr('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  // Obj 3: Page
  offsets.push(byteLen);
  pushStr(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`
  );

  // Obj 4: Embedded JPEG Image XObject
  offsets.push(byteLen);
  pushStr(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgBytes.length} >>\nstream\n`
  );
  pushBytes(imgBytes);
  pushStr('\nendstream\nendobj\n');

  // Obj 5: Page Content Stream
  const contentStream = `q\n${pageW} 0 0 ${pageH} 0 0 cm\n/Im0 Do\nQ\n`;
  offsets.push(byteLen);
  pushStr(
    `5 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream\nendobj\n`
  );

  // Xref table
  const xrefPos = byteLen;
  pushStr(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (let i = 1; i < offsets.length; i++) {
    pushStr(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }

  pushStr(
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`
  );

  const pdfBlob = new Blob(chunks as BlobPart[], { type: 'application/pdf' });
  triggerDownload(pdfBlob, `${safeFileName(project.name)}_FloorPlan.pdf`);
}
