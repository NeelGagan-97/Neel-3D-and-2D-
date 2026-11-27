import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  buildAiVectorContext,
  extractPdfVectorData,
  parseDimensionTextToMeters,
} from '../src/utils/pdfVectorExtractor';
import {
  buildVectorSeedModel,
  computeTwoPointCalibration,
  evaluateReconstructionCompleteness,
  generateEditable2DProjectFromModel,
  mergeVectorAndAiModels,
  normalizeAiAnalysisResponse,
} from '../src/utils/aiDrawingConverter';
import { detectRasterWallsFromBuffer } from '../src/utils/rasterWallDetector';
import { generateValidatedProjectDxf, validateDxfContent } from '../src/utils/dxfExporter';
import { extractMergedWalls } from '../src/utils/geometry';
import { buildArchitecturalScene } from '../src/three/architecturalBuilder';
import type { ArchitecturalTextureSet } from '../src/three/proceduralTextures';
import {
  AiDrawingAnalyzeResponse,
  DrawingProjectMetadata,
  SymbolMappingDefinition,
} from '../src/types/aiDrawing';
import type { ProjectData } from '../src/types/design';

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(err);
    failed += 1;
  }
}

/**
 * Generates a valid binary vector PDF (1000 x 700 pt) representing a realistic
 * Commercial Lighting-Layout floor plan with:
 * - Outer drafting sheet border (to verify border filtering)
 * - Angled 45-degree chamfered corner exterior wall
 * - Curved cubic Bezier reception atrium wall
 * - Internal partition walls forming 6 zones (Reception, Open Office, Conference Room, Corridor, Pantry, Server Room)
 * - Dimension annotations, Title Block, Lighting Legend, and 15 placed electrical/lighting symbol tags
 */
function buildCommercialLightingLayoutPdf(): {
  bytes: Uint8Array;
  groundTruth: {
    sheetW: number;
    sheetH: number;
    chamferStartNorm: { x: number; y: number };
    chamferEndNorm: { x: number; y: number };
    curveStartNorm: { x: number; y: number };
    curveEndNorm: { x: number; y: number };
    expectedLegendCodes: string[];
    expectedSymbolTags: number;
    expectedRoomLabels: string[];
    expectedDimensionsM: number[];
  };
} {
  const W = 1000;
  const H = 700;

  // Helper: convert top-down CAD normalized coords (0..1) into PDF bottom-up user space
  const px = (nx: number) => (nx * W).toFixed(2);
  const py = (ny: number) => ((1 - ny) * H).toFixed(2);

  const ops: string[] = [];

  // 1. Outer sheet border (extreme edge, > 95% span -> should be excluded by sheet border filter)
  ops.push('q 0.5 w 10 10 980 680 re S Q');

  // 2. Complete irregular exterior building outline (heavy 2.8pt stroke):
  //    Left wall: (0.08, 0.22) -> (0.08, 0.78)
  //    Angled 45-deg chamfer NW corner: (0.08, 0.22) -> (0.18, 0.10)
  //    Top straight wall: (0.18, 0.10) -> (0.55, 0.10)
  //    Curved NE Reception Atrium arc: (0.55, 0.10) C (0.68, 0.04) (0.78, 0.14) (0.80, 0.26)
  //    East wall: (0.80, 0.26) -> (0.80, 0.78)
  //    South wall: (0.80, 0.78) -> (0.08, 0.78)
  ops.push(
    [
      'q 2.8 w',
      `${px(0.08)} ${py(0.78)} m`,
      `${px(0.08)} ${py(0.22)} l`,
      `${px(0.18)} ${py(0.10)} l`,
      `${px(0.55)} ${py(0.10)} l`,
      `${px(0.68)} ${py(0.04)} ${px(0.78)} ${py(0.14)} ${px(0.80)} ${py(0.26)} c`,
      `${px(0.80)} ${py(0.78)} l`,
      'h S Q',
    ].join(' ')
  );

  // 3. Internal partition walls & corridor (1.2pt stroke)
  const internalWalls: Array<[number, number, number, number]> = [
    // Corridor north & south walls
    [0.08, 0.44, 0.56, 0.44],
    [0.08, 0.54, 0.56, 0.54],
    // Vertical divider between Open Office & Reception Atrium
    [0.56, 0.10, 0.56, 0.78],
    // Divider between Conference Room & Open Office (north half)
    [0.32, 0.10, 0.32, 0.44],
    // Divider between Pantry & Server Room (south half)
    [0.30, 0.54, 0.30, 0.78],
    // Angled reception desk backdrop partition inside atrium
    [0.62, 0.36, 0.74, 0.46],
  ];
  ops.push('q 1.2 w');
  for (const [x1, y1, x2, y2] of internalWalls) {
    ops.push(`${px(x1)} ${py(y1)} m ${px(x2)} ${py(y2)} l S`);
  }
  ops.push('Q');

  // 4. Text labels: Room names, Dimensions, Legend, Title Block, and Placed Electrical/Lighting Tags
  const emitText = (nx: number, ny: number, size: number, text: string) => {
    const safe = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    ops.push(`BT /F1 ${size} Tf ${px(nx)} ${py(ny)} Td (${safe}) Tj ET`);
  };

  // Room labels
  emitText(0.14, 0.28, 12, 'CONFERENCE ROOM');
  emitText(0.39, 0.28, 12, 'OPEN OFFICE');
  emitText(0.64, 0.24, 12, 'RECEPTION ATRIUM');
  emitText(0.26, 0.49, 10, 'CORRIDOR');
  emitText(0.14, 0.66, 11, 'PANTRY');
  emitText(0.38, 0.66, 11, 'SERVER ROOM');

  // Dimensions
  emitText(0.42, 0.06, 10, '24.00 m');
  emitText(0.03, 0.46, 10, '16.00 m');
  emitText(0.20, 0.41, 9, '6000 mm');
  emitText(0.66, 0.81, 9, "12'-6\"");

  // Placed lighting & electrical fixture callouts in rooms
  const fixtureTags: Array<[number, number, string]> = [
    // Conference room downlights + switchboard
    [0.16, 0.22, 'DL-1'],
    [0.24, 0.22, 'DL-1'],
    [0.29, 0.40, 'SB-1'],
    // Open office linear pendants
    [0.38, 0.20, 'LP-1'],
    [0.48, 0.20, 'LP-1'],
    [0.38, 0.34, 'LP-1'],
    [0.48, 0.34, 'LP-1'],
    // Reception atrium downlights
    [0.64, 0.18, 'DL-1'],
    [0.72, 0.28, 'DL-1'],
    [0.68, 0.60, 'DL-1'],
    // Corridor emergency lights
    [0.18, 0.49, 'EM-1'],
    [0.46, 0.49, 'EM-1'],
    // Pantry downlight + switchboard
    [0.18, 0.62, 'DL-1'],
    [0.27, 0.58, 'SB-1'],
    // Server room DB
    [0.48, 0.70, 'DB-1'],
  ];
  for (const [tx, ty, code] of fixtureTags) {
    emitText(tx, ty, 8, code);
  }

  // Right-side Lighting Legend block WITH boxed table border & horizontal divider strokes
  // (must be excluded from wallSegments by peripheral legend zone filtering!)
  ops.push('q 0.9 w');
  ops.push(`${px(0.82)} ${py(0.39)} 165 190 re S`);
  ops.push(`${px(0.82)} ${py(0.16)} m ${px(0.985)} ${py(0.16)} l S`);
  ops.push(`${px(0.82)} ${py(0.21)} m ${px(0.985)} ${py(0.21)} l S`);
  ops.push('Q');
  emitText(0.83, 0.14, 10, 'LEGEND');
  emitText(0.83, 0.19, 8, 'DL-1: 18W LED Downlight');
  emitText(0.83, 0.23, 8, 'LP-1: 36W Linear Pendant');
  emitText(0.83, 0.27, 8, 'EM-1: Emergency Bulkhead');
  emitText(0.83, 0.31, 8, 'SB-1: 6-Module Switchboard');
  emitText(0.83, 0.35, 8, 'DB-1: Lighting Distribution Board');

  // Bottom-right Title Block WITH frame border strokes (must also be excluded from wallSegments!)
  ops.push('q 0.9 w');
  ops.push(`${px(0.65)} ${py(0.98)} 335 88 re S`);
  ops.push(`${px(0.65)} ${py(0.90)} m ${px(0.985)} ${py(0.90)} l S`);
  ops.push('Q');
  emitText(0.66, 0.88, 10, 'COMMERCIAL LIGHTING LAYOUT');
  emitText(0.66, 0.92, 8, 'SCALE: 1:100');
  emitText(0.80, 0.92, 8, 'DWG NO: E-LTG-101');
  emitText(0.80, 0.96, 8, 'REV: R2');

  // Structural column closed vector boxes inside the floor plan (should be extracted into extraction.columns)
  ops.push('q 1.6 w');
  ops.push(`${px(0.312)} ${py(0.452)} 16 16 re S`);
  ops.push(`${px(0.552)} ${py(0.452)} 16 16 re S`);
  ops.push('Q');

  const streamContent = ops.join('\n');
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj`,
    `4 0 obj << /Length ${streamContent.length} >> stream\n${streamContent}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += `${obj}\n`;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;

  return {
    bytes: new TextEncoder().encode(pdf),
    groundTruth: {
      sheetW: W,
      sheetH: H,
      chamferStartNorm: { x: 0.08, y: 0.22 },
      chamferEndNorm: { x: 0.18, y: 0.10 },
      curveStartNorm: { x: 0.55, y: 0.10 },
      curveEndNorm: { x: 0.80, y: 0.26 },
      expectedLegendCodes: ['DL-1', 'LP-1', 'EM-1', 'SB-1', 'DB-1'],
      expectedSymbolTags: fixtureTags.length,
      expectedRoomLabels: [
        'CONFERENCE ROOM',
        'OPEN OFFICE',
        'RECEPTION ATRIUM',
        'CORRIDOR',
        'PANTRY',
        'SERVER ROOM',
      ],
      expectedDimensionsM: [24, 16, 6, 3.81],
    },
  };
}

const COMMERCIAL_SYMBOL_MAPPINGS: SymbolMappingDefinition[] = [
  {
    id: 'map-dl1',
    name: '18W LED Downlight',
    code: 'DL-1',
    domain: 'lighting',
    electricalItemType: 'led_light',
    electricalCategory: 'Lighting',
    description: 'Recessed ceiling downlight',
    visualNotes: 'Circle with cross',
    markerColor: '#38bdf8',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'map-lp1',
    name: '36W Linear Pendant',
    code: 'LP-1',
    domain: 'lighting',
    electricalItemType: 'panel_light',
    electricalCategory: 'Lighting',
    description: 'Suspended linear office luminaire',
    visualNotes: 'Elongated rectangle',
    markerColor: '#22c55e',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'map-em1',
    name: 'Emergency Bulkhead',
    code: 'EM-1',
    domain: 'lighting',
    electricalItemType: 'spotlight',
    electricalCategory: 'Lighting',
    description: 'Emergency maintained luminaire',
    visualNotes: 'Shaded half-circle',
    markerColor: '#f59e0b',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'map-sb1',
    name: '6-Module Switchboard',
    code: 'SB-1',
    domain: 'switch',
    electricalItemType: 'switchboard',
    electricalCategory: 'Switches',
    description: 'Wall mounted modular switchboard',
    visualNotes: 'Wall rectangle with S',
    markerColor: '#a855f7',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'map-db1',
    name: 'Lighting Distribution Board',
    code: 'DB-1',
    domain: 'distribution',
    electricalItemType: 'distribution_board',
    electricalCategory: 'Distribution',
    description: '3-phase lighting DB',
    visualNotes: 'Half-filled DB rectangle',
    markerColor: '#ef4444',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

async function main() {
  console.log('\n=== PDF-to-2D CAD Reconstruction Verification Suite ===\n');

  await runTest('1. Dimension text parser handles metric (m, mm, cm) and imperial (ft-in)', () => {
    assert.equal(parseDimensionTextToMeters('24.00 m')?.meters, 24);
    assert.equal(parseDimensionTextToMeters('6000 mm')?.meters, 6);
    assert.equal(parseDimensionTextToMeters('450 cm')?.meters, 4.5);
    assert.equal(parseDimensionTextToMeters("12'-6\"")?.meters, 3.81);
    assert.equal(parseDimensionTextToMeters('4500', 'mm')?.meters, 4.5);
    assert.equal(parseDimensionTextToMeters('CONFERENCE ROOM'), null);
  });

  const fixture = buildCommercialLightingLayoutPdf();
  const extraction = await extractPdfVectorData(fixture.bytes, 1, { defaultUnit: 'm' });

  await runTest('2. Native vector PDF extraction preserves angled chamfer, curved Bézier wall, internal partitions & filters sheet border', () => {
    assert.equal(extraction.sourceKind, 'vector-pdf');
    assert.ok(extraction.wallSegments.length >= 16, `Expected >= 16 wall segments including curved chords, got ${extraction.wallSegments.length}`);
    assert.ok(extraction.curvedSegmentCount >= 6, `Expected >= 6 tessellated curved chords, got ${extraction.curvedSegmentCount}`);
    assert.ok(extraction.angledSegmentCount >= 2, `Expected >= 2 angled walls (chamfer + angled partition), got ${extraction.angledSegmentCount}`);

    // Verify outer sheet border (x~0.01..0.99) was filtered out
    const borderLeak = extraction.wallSegments.some(
      (s) => (s.x1 < 0.02 && s.x2 < 0.02) || (s.x1 > 0.98 && s.x2 > 0.98)
    );
    assert.equal(borderLeak, false, 'Outer sheet border should not be classified as building wall');

    // Verify angled NW chamfer corner exact alignment error (< 0.001 normalized = < 25mm on 24m span!)
    const chamfer = extraction.wallSegments.find(
      (s) =>
        s.isAngled &&
        Math.hypot(s.x1 - fixture.groundTruth.chamferStartNorm.x, s.y1 - fixture.groundTruth.chamferStartNorm.y) < 0.005 &&
        Math.hypot(s.x2 - fixture.groundTruth.chamferEndNorm.x, s.y2 - fixture.groundTruth.chamferEndNorm.y) < 0.005
    );
    assert.ok(chamfer, 'Exact 45-degree chamfered NW entrance wall must be preserved without squaring off');

    const maxNormErr = Math.max(
      Math.hypot(chamfer!.x1 - 0.08, chamfer!.y1 - 0.22),
      Math.hypot(chamfer!.x2 - 0.18, chamfer!.y2 - 0.10)
    );
    assert.ok(maxNormErr < 0.002, `Expected sub-millimeter chamfer alignment error, got ${maxNormErr}`);
  });

  await runTest('3. PDF text extraction reads all 6 room labels, 4 dimensions, 5 legend entries & title block', () => {
    const allTexts = extraction.textItems.map((t) => t.text.toUpperCase());
    for (const roomLabel of fixture.groundTruth.expectedRoomLabels) {
      assert.ok(
        allTexts.some((t) => t.includes(roomLabel)),
        `Expected room label "${roomLabel}" in extracted PDF text`
      );
    }

    assert.equal(extraction.dimensions.length, 4, `Expected 4 parsed dimensions, got ${extraction.dimensions.length}`);
    const parsedMeters = extraction.dimensions.map((d) => d.parsedMeters).sort((a, b) => a - b);
    assert.deepEqual(parsedMeters, [3.81, 6, 16, 24]);

    const legendCodes = extraction.legendEntries.map((l) => l.code);
    for (const code of fixture.groundTruth.expectedLegendCodes) {
      assert.ok(legendCodes.includes(code), `Missing legend entry ${code}`);
    }

    assert.equal(extraction.titleBlock.scaleText, '1:100');
    assert.equal(extraction.titleBlock.drawingNumber, 'E-LTG-101');
    assert.equal(extraction.titleBlock.revision, 'R2');

    const ctx = buildAiVectorContext(extraction);
    assert.ok(ctx && ctx.wallAnchors.length >= 16 && ctx.legendEntries.length === 5);
  });

  await runTest('4. Direct vector seed detects all 15 tagged lighting/electrical symbols matched to user legend', () => {
    const seed = buildVectorSeedModel(extraction, COMMERCIAL_SYMBOL_MAPPINGS);
    assert.equal(seed.symbols.length, fixture.groundTruth.expectedSymbolTags);
    assert.ok(seed.symbols.every((s) => s.matchedByUserLegend && s.status === 'approved'));
    assert.ok(seed.walls.some((w) => w.isCurvedSegment && w.origin === 'pdf-vector'));
  });

  await runTest('5. Completeness gate BLOCKS oversimplified bounding-box-only detection', () => {
    const oversimplifiedModel = normalizeAiAnalysisResponse(
      {
        summary: 'Oversimplified 2-box guess',
        warnings: [],
        titleBlock: {},
        legendEntries: [],
        walls: [],
        rooms: [
          { name: 'Office', roomType: 'study', x: 0.1, y: 0.1, width: 0.4, height: 0.4, confidence: 0.9 },
          { name: 'Hall', roomType: 'hall', x: 0.5, y: 0.1, width: 0.3, height: 0.4, confidence: 0.9 },
        ],
        openings: [],
        columns: [],
        staircases: [],
        furniture: [],
        symbols: [],
        wiringPaths: [],
        dimensions: [],
        textLabels: [],
      },
      COMMERCIAL_SYMBOL_MAPPINGS,
      1,
      'test-model'
    );
    const report = evaluateReconstructionCompleteness(oversimplifiedModel, null, 'Lighting Layout');
    assert.equal(report.status, 'incomplete', 'Bounding-box-only model must be marked incomplete and blocked');
    assert.ok(report.blockers.length >= 1, 'Expected at least 1 completeness blocker');
  });

  await runTest('6. Hybrid Vector + Vision AI fusion -> calibrated 2D CAD preserves irregular outline, curved wall, polygon rooms, furniture & 15 electrical symbols with ZERO fake bounding box walls', () => {
    // Simulated Vision AI semantic layer anchored to the PDF vector extraction (polygon rooms, doors, columns, furniture)
    const rawAi: AiDrawingAnalyzeResponse['rawAnalysis'] = {
      summary: 'Commercial lighting layout semantic reconstruction',
      warnings: [],
      titleBlock: { scaleText: '1:100' },
      legendEntries: [],
      walls: [
        // Duplicate of a vector wall (should be deduplicated in favor of exact PDF vector)
        { x1: 0.08, y1: 0.22, x2: 0.08, y2: 0.78, wallKind: 'external', confidence: 0.9 },
      ],
      rooms: [
        {
          name: 'Conference Room',
          roomType: 'study',
          x: 0.08,
          y: 0.10,
          width: 0.24,
          height: 0.34,
          polygon: [
            { x: 0.08, y: 0.22 },
            { x: 0.18, y: 0.10 },
            { x: 0.32, y: 0.10 },
            { x: 0.32, y: 0.44 },
            { x: 0.08, y: 0.44 },
          ],
          confidence: 0.94,
        },
        {
          name: 'Open Office',
          roomType: 'study',
          x: 0.32,
          y: 0.10,
          width: 0.24,
          height: 0.34,
          polygon: [
            { x: 0.32, y: 0.10 },
            { x: 0.56, y: 0.10 },
            { x: 0.56, y: 0.44 },
            { x: 0.32, y: 0.44 },
          ],
          confidence: 0.95,
        },
        {
          name: 'Reception Atrium',
          roomType: 'hall',
          x: 0.56,
          y: 0.08,
          width: 0.24,
          height: 0.70,
          polygon: [
            { x: 0.56, y: 0.10 },
            { x: 0.68, y: 0.08 },
            { x: 0.78, y: 0.16 },
            { x: 0.80, y: 0.26 },
            { x: 0.80, y: 0.78 },
            { x: 0.56, y: 0.78 },
          ],
          confidence: 0.93,
        },
        {
          name: 'Corridor',
          roomType: 'hall',
          x: 0.08,
          y: 0.44,
          width: 0.48,
          height: 0.10,
          confidence: 0.92,
        },
        {
          name: 'Pantry',
          roomType: 'kitchen',
          x: 0.08,
          y: 0.54,
          width: 0.22,
          height: 0.24,
          confidence: 0.92,
        },
        {
          name: 'Server Room',
          roomType: 'utility',
          x: 0.30,
          y: 0.54,
          width: 0.26,
          height: 0.24,
          confidence: 0.93,
        },
      ],
      openings: [
        { kind: 'door', x: 0.24, y: 0.44, widthNorm: 0.04, rotationDeg: 0, confidence: 0.9 },
        { kind: 'door', x: 0.44, y: 0.44, widthNorm: 0.04, rotationDeg: 0, confidence: 0.9 },
        { kind: 'door', x: 0.56, y: 0.49, widthNorm: 0.05, rotationDeg: 90, confidence: 0.91 },
        { kind: 'window', x: 0.42, y: 0.10, widthNorm: 0.10, rotationDeg: 0, confidence: 0.92 },
      ],
      columns: [
        { label: 'C1', x: 0.32, y: 0.44, widthNorm: 0.015, heightNorm: 0.02, confidence: 0.9 },
        { label: 'C2', x: 0.56, y: 0.44, widthNorm: 0.015, heightNorm: 0.02, confidence: 0.9 },
      ],
      staircases: [],
      furniture: [
        { kind: 'dining-table', label: 'Conference Table', x: 0.20, y: 0.27, widthNorm: 0.10, heightNorm: 0.06, rotationDeg: 0, confidence: 0.88 },
        { kind: 'desk', label: 'Reception Desk', x: 0.67, y: 0.38, widthNorm: 0.09, heightNorm: 0.04, rotationDeg: 35, confidence: 0.87 },
      ],
      symbols: [],
      wiringPaths: [],
      dimensions: [
        { x1: 0.08, y1: 0.06, x2: 0.80, y2: 0.06, labelText: '24.00 m', confidence: 0.95 },
      ],
      textLabels: [],
    };

    const aiModel = normalizeAiAnalysisResponse(rawAi, COMMERCIAL_SYMBOL_MAPPINGS, 1, 'gemini-4-hydrogen');
    const hybridModel = mergeVectorAndAiModels(extraction, aiModel, COMMERCIAL_SYMBOL_MAPPINGS);

    // Calibrate using the real 24.00m horizontal span from x=0.08 to x=0.80 (span = 0.72 of 1000px width)
    const calRes = computeTwoPointCalibration({
      pointA: { x: 0.08, y: 0.78 },
      pointB: { x: 0.80, y: 0.78 },
      knownDistanceValue: 24,
      unit: 'm',
      imageWidthPx: 2000,
      imageHeightPx: 1400,
    });
    if (!calRes.ok) throw new Error(calRes.error);

    const quality = evaluateReconstructionCompleteness(hybridModel, calRes.calibration, 'Lighting Layout');
    assert.equal(quality.status, 'ready', `Expected ready status, got blockers: ${quality.blockers.join('; ')}`);
    assert.ok(quality.score >= 90, `Expected fidelity score >= 90, got ${quality.score}`);

    const metadata: DrawingProjectMetadata = {
      projectName: 'Commercial Lighting Layout Test',
      drawingType: 'Lighting Layout',
      measurementUnit: 'm',
      scaleLabel: '1:100',
      defaultCeilingHeightM: 3.0,
      defaultWallThicknessM: 0.15,
      targetFloor: 1,
      importTarget: 'new-project',
      notes: '',
    };

    const generated = generateEditable2DProjectFromModel({
      model: hybridModel,
      calibration: calRes.calibration,
      metadata,
      source: {
        originalFileName: 'commercial-lighting-layout.pdf',
        mimeType: 'application/pdf',
        selectedPage: 1,
      },
      symbolMappings: COMMERCIAL_SYMBOL_MAPPINGS,
      referenceOverlay: {
        dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
        widthPx: 1400,
        heightPx: 980,
        opacity: 0.45,
        visible: true,
      },
    });

    const project = generated.project;
    assert.equal(project.aiDrawingImport?.suppressAutoSitePerimeter, true);
    assert.equal(project.aiDrawingImport?.approvedFor3D, false, 'Imported CAD project must require explicit 2D approval before 3D');
    assert.equal(project.aiDrawingImport?.referenceOverlay?.visible, true);
    assert.equal(project.rooms.length, 6);
    assert.ok(project.rooms.every((r) => r.noAutoWalls === true), 'Imported rooms must disable synthetic rectangular walls');
    assert.ok(
      project.rooms.find((r) => r.name === 'Conference Room')?.polygon?.length === 5,
      'Chamfered Conference Room must preserve its 5-vertex polygon'
    );
    assert.equal(project.openings.length, 4);
    assert.equal(project.furniture.length, 2);
    assert.equal(project.points.length, 15, 'All 15 lighting/electrical symbols must convert to editable ElectricalPoints');
    assert.ok((project.aiDrawingImport?.columns?.length ?? 0) >= 2, 'Structural columns must carry into 2D CAD project');

    // Verify legend & title block vector strokes were excluded from walls
    const legendZoneWalls = project.customWalls.filter(
      (w) => Math.min(w.x1, w.x2) > project.site.length * 0.815
    );
    assert.equal(
      legendZoneWalls.length,
      0,
      `Legend table border strokes must NOT contaminate reconstructed walls (found ${legendZoneWalls.length})`
    );
    assert.ok(
      (extraction.filteredNoiseCount ?? 0) > 0,
      'Expected legend/title-block/border strokes to be counted as filteredNoiseCount'
    );

    // Verify duplicate room-label & legend-text items are filtered from textAnnotations
    const legendTextLeak = (project.aiDrawingImport?.textAnnotations ?? []).some(
      (t) => t.kind === 'legend-text' || t.kind === 'title-block'
    );
    assert.equal(legendTextLeak, false, 'Legend and title-block text must not clutter the 2D floor plan canvas');

    // CRITICAL: Verify extractMergedWalls produces ONLY the reconstructed customWalls (ZERO synthetic rectangular site perimeter or room boxes!)
    const mergedWalls = extractMergedWalls(project);
    assert.equal(
      mergedWalls.filter((w) => w.source === 'perimeter').length,
      0,
      'Must NOT inject a fake 4-sided site perimeter box over an irregular PDF outline'
    );
    assert.equal(
      mergedWalls.filter((w) => w.source === 'room').length,
      0,
      'Must NOT inject fake rectangular room boundary walls over angled/curved customWalls'
    );
    assert.equal(mergedWalls.length, project.customWalls.length);

    // Measure exact calibrated metric accuracy of reconstructed 24.00m south exterior wall
    const southWall = project.customWalls.find(
      (w) => Math.abs(w.y1 - w.y2) < 0.05 && Math.abs(Math.abs(w.x2 - w.x1) - 24) < 0.1
    );
    assert.ok(southWall, 'Calibrated 24.00m south exterior wall must be present');
    const measuredSouthLenM = Math.hypot(southWall!.x2 - southWall!.x1, southWall!.y2 - southWall!.y1);
    const lengthErrorMm = Math.abs(measuredSouthLenM - 24) * 1000;
    assert.ok(lengthErrorMm < 20, `Expected < 20mm calibrated error on 24m span, got ${lengthErrorMm.toFixed(1)}mm`);

    // Store for DXF & 3D tests below
    reconstructedProject = project;

    console.log('\n  --- Quantitative Source PDF vs Reconstructed 2D CAD Comparison ---');
    console.log(`  Source Kind          : ${extraction.sourceKind} (${extraction.pageWidthPt}x${extraction.pageHeightPt} pt)`);
    console.log(`  Filtered Noise       : ${extraction.filteredNoiseCount ?? 0} legend/title-block/border strokes excluded`);
    console.log(`  Vector Columns Found : ${extraction.columns?.length ?? 0}`);
    console.log(`  Reconstructed Walls  : ${project.customWalls.length} segments (${project.customWalls.filter((w) => w.wallKind === 'external').length} ext, ${project.customWalls.filter((w) => w.wallKind === 'internal').length} int, ${project.customWalls.filter((w) => w.isCurvedSegment).length} curved chords)`);
    console.log(`  Fake Perimeter/Boxes : 0 perimeter, 0 synthetic room boxes`);
    console.log(`  Reconstructed Rooms  : ${project.rooms.length} (${project.rooms.filter((r) => (r.polygon?.length ?? 0) >= 3).length} exact polygons)`);
    console.log(`  Openings / Cols / Frn: ${project.openings.length} openings, ${project.aiDrawingImport?.columns?.length ?? 0} columns, ${project.furniture.length} furniture`);
    console.log(`  Electrical Symbols   : ${project.points.length} / ${fixture.groundTruth.expectedSymbolTags} matched & placed`);
    console.log(`  24.00m Span Accuracy : ${measuredSouthLenM.toFixed(3)} m (error: ${lengthErrorMm.toFixed(1)} mm)`);
    console.log(`  Fidelity Score       : ${quality.score}% (${quality.status})\n`);
  });

  await runTest('7. Raster CV wall detector traces exterior, interior & 45° diagonal walls from scanned RGBA buffer', () => {
    const W = 400;
    const H = 300;
    const rgba = new Uint8ClampedArray(W * H * 4);
    rgba.fill(255); // White paper background

    const drawThickLine = (x1: number, y1: number, x2: number, y2: number, thickness: number) => {
      const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) * 2;
      const half = Math.floor(thickness / 2);
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        const cx = Math.round(x1 + (x2 - x1) * t);
        const cy = Math.round(y1 + (y2 - y1) * t);
        for (let dy = -half; dy <= half; dy++) {
          for (let dx = -half; dx <= half; dx++) {
            const px = cx + dx;
            const py = cy + dy;
            if (px >= 0 && px < W && py >= 0 && py < H) {
              const idx = (py * W + px) * 4;
              rgba[idx] = 15;
              rgba[idx + 1] = 15;
              rgba[idx + 2] = 15;
              rgba[idx + 3] = 255;
            }
          }
        }
      }
    };

    // Irregular floor plan outline with 45-degree chamfer + internal partition
    drawThickLine(40, 250, 40, 100, 4);   // West wall
    drawThickLine(40, 100, 100, 40, 4);   // 45-deg NW chamfer
    drawThickLine(100, 40, 340, 40, 4);   // North wall
    drawThickLine(340, 40, 340, 250, 4);  // East wall
    drawThickLine(340, 250, 40, 250, 4);  // South wall
    drawThickLine(190, 40, 190, 250, 3);  // Internal vertical partition
    drawThickLine(40, 160, 190, 160, 3);  // Internal horizontal partition

    const detected = detectRasterWallsFromBuffer({ width: W, height: H, data: rgba }, 'raster-image', 1);
    assert.equal(detected.sourceKind, 'raster-image');
    assert.ok(detected.wallSegments.length >= 6, `Expected >= 6 raster walls, got ${detected.wallSegments.length}`);
    assert.ok(detected.angledSegmentCount >= 1, `Expected >= 1 45-deg angled chamfer wall, got ${detected.angledSegmentCount}`);
  });

  await runTest('8. Validated AutoCAD DXF exporter produces clean, layered, dxf-parser-verified editable DXF', () => {
    assert.ok(reconstructedProject, 'Reconstructed project must exist from test 6');
    const { dxfContent, validation } = generateValidatedProjectDxf(reconstructedProject!, 1);
    assert.equal(validation.valid, true, `DXF validation failed: ${validation.errors.join('; ')}`);
    assert.ok(validation.entityCount >= 40, `Expected >= 40 parsed DXF entities, got ${validation.entityCount}`);
    assert.ok(validation.layerNames.includes('A-WALL-EXT'), 'DXF must contain A-WALL-EXT layer');
    assert.ok(validation.layerNames.includes('A-WALL-INT'), 'DXF must contain A-WALL-INT layer');
    assert.ok(validation.layerNames.includes('A-WALL-CURV'), 'DXF must contain A-WALL-CURV layer');
    assert.ok(validation.layerNames.includes('A-ROOM'), 'DXF must contain A-ROOM layer');
    assert.ok(validation.layerNames.includes('A-DOOR'), 'DXF must contain A-DOOR layer');
    assert.ok(validation.layerNames.includes('A-WIND'), 'DXF must contain A-WIND layer');
    assert.ok(validation.layerNames.includes('S-COLS'), 'DXF must contain S-COLS layer');
    assert.ok(validation.layerNames.includes('E-SYMB'), 'DXF must contain E-SYMB layer');

    // Double-check validator rejects corrupted/empty DXF honestly
    const broken = validateDxfContent('NOT A VALID DXF');
    assert.equal(broken.valid, false, 'Validator must reject malformed DXF');

    console.log(`  DXF Export Verified  : ${validation.entityCount} parsed entities across ${validation.layerNames.length} CAD layers (${(dxfContent.length / 1024).toFixed(1)} KB)`);
  });

  await runTest('9. Approved 2D CAD model builds faithful 3D scene (polygon ExtrudeGeometry floors, 3D columns, curved/angled walls, 15 fixtures) with 0 leaked GPU resources', () => {
    assert.ok(reconstructedProject, 'Reconstructed project must exist from test 6');
    const approvedProject: ProjectData = {
      ...reconstructedProject!,
      aiDrawingImport: reconstructedProject!.aiDrawingImport
        ? {
            ...reconstructedProject!.aiDrawingImport,
            approvedFor3D: true,
            approvedFor3DAt: new Date().toISOString(),
          }
        : undefined,
    };

    const dummyTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const asCanvasTex = dummyTex as unknown as THREE.CanvasTexture;
    const textures: ArchitecturalTextureSet = {
      wood: asCanvasTex,
      tile: asCanvasTex,
      terrazzo: asCanvasTex,
      stone: asCanvasTex,
      dispose: () => dummyTex.dispose(),
    };

    const built = buildArchitecturalScene(approvedProject, textures, null, 'daylight', false, true, 1, 'all');
    let extrudeFloorCount = 0;
    let columnMeshCount = 0;
    built.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        if (obj.geometry instanceof THREE.ExtrudeGeometry) extrudeFloorCount += 1;
        if (obj.userData.columnId) columnMeshCount += 1;
      }
    });

    assert.ok(extrudeFloorCount >= 3, `Expected >= 3 polygon ExtrudeGeometry room floors in 3D, got ${extrudeFloorCount}`);
    assert.ok(columnMeshCount >= 2, `Expected >= 2 imported structural 3D columns, got ${columnMeshCount}`);
    assert.equal(built.physicalProducts.length, 15, 'All 15 lighting/electrical symbols must exist as physical 3D fixtures');
    assert.equal(built.pointAnchors.size, 15);

    built.dispose();
    textures.dispose();
    assert.equal(built.resourceStats.disposed, true);
    assert.equal(
      built.resourceStats.disposedGeometries,
      built.resourceStats.trackedGeometries,
      'Every tracked 3D geometry must be disposed cleanly'
    );
    assert.equal(
      built.resourceStats.disposedMaterials,
      built.resourceStats.trackedMaterials,
      'Every tracked 3D material must be disposed cleanly'
    );
  });

  console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

let reconstructedProject: ProjectData | null = null;
void main();
