import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  createSymbolMapping,
  deleteSymbolTemplate,
  loadSymbolMappings,
  loadSymbolTemplates,
  sanitizeSymbolSampleDataUrl,
  saveSymbolMappings,
  saveSymbolTemplate,
} from '../src/services/symbolMappingStorage';
import { projectStorage } from '../src/services/projectStorage';
import {
  computeTwoPointCalibration,
  convertUnitToMeters,
  createUncalibratedConfig,
  generateEditable2DProjectFromModel,
  normalizeAiAnalysisResponse,
} from '../src/utils/aiDrawingConverter';
import { validateDrawingUploadBytes } from '../src/utils/pdfImageRenderer';
import { createApp, runWithTransientRetry } from '../server';
import { INITIAL_PROJECTS } from '../src/data/presets';

// Minimal in-memory localStorage mock for Node test runner
const memoryStorage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => memoryStorage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memoryStorage.set(k, String(v));
    },
    removeItem: (k: string) => {
      memoryStorage.delete(k);
    },
    clear: () => memoryStorage.clear(),
  },
  configurable: true,
});

async function runTests() {
  let passed = 0;
  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      passed += 1;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      console.error(`  FAIL  ${name}`);
      throw err;
    }
  }

  console.log('\nAI Drawing to 2D Importer — Verification Suite');

  await test('1. Upload validation accepts valid PDF, PNG, and JPEG magic bytes', () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const jpgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49]);

    const r1 = validateDrawingUploadBytes(pdfBytes, { name: 'floor-plan.pdf', size: 1024 });
    const r2 = validateDrawingUploadBytes(pngBytes, { name: 'lighting.PNG', size: 2048 });
    const r3 = validateDrawingUploadBytes(jpgBytes, { name: 'layout.jpeg', size: 2048 });

    assert.equal(r1.valid, true);
    assert.equal(r1.mimeType, 'application/pdf');
    assert.equal(r2.valid, true);
    assert.equal(r2.mimeType, 'image/png');
    assert.equal(r3.valid, true);
    assert.equal(r3.mimeType, 'image/jpeg');
  });

  await test('2. Upload validation rejects unsupported formats, spoofed headers, empty & oversized files', () => {
    const fakePdf = new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x3e, 0x00, 0x00, 0x00]);
    const validPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

    assert.equal(validateDrawingUploadBytes(fakePdf, { name: 'evil.svg', size: 100 }).valid, false);
    assert.equal(validateDrawingUploadBytes(fakePdf, { name: 'spoof.pdf', size: 100 }).valid, false);
    assert.equal(validateDrawingUploadBytes(validPng, { name: 'empty.png', size: 0 }).valid, false);
    assert.equal(
      validateDrawingUploadBytes(validPng, { name: 'huge.png', size: 30 * 1024 * 1024 }).valid,
      false
    );
  });

  await test('3. Symbol mapping storage CRUD, reusable templates, and XSS/SVG sample sanitization', () => {
    memoryStorage.clear();
    assert.equal(loadSymbolMappings().length, 0);

    // Block unsafe schemes and SVG data URLs
    assert.equal(sanitizeSymbolSampleDataUrl('javascript:alert(1)'), undefined);
    assert.equal(sanitizeSymbolSampleDataUrl('data:image/svg+xml;base64,PHN2Zz4='), undefined);
    assert.equal(sanitizeSymbolSampleDataUrl('data:text/html;base64,PGgxPkE8L2gxPg=='), undefined);

    const validPngDataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    assert.equal(sanitizeSymbolSampleDataUrl(validPngDataUrl), validPngDataUrl);

    const sym1 = createSymbolMapping({
      name: '15W Recessed Downlight',
      code: 'DL-1',
      domain: 'lighting',
      electricalItemType: 'led_light',
      description: 'Main living ceiling downlight',
      visualNotes: 'Circle with cross inside',
      sampleImageDataUrl: validPngDataUrl,
    });
    const sym2 = createSymbolMapping({
      name: '16A AC Power Socket',
      code: 'AC-16A',
      domain: 'socket',
      electricalItemType: 'socket_16a',
      description: 'Split AC power outlet',
    });

    saveSymbolMappings([sym1, sym2]);
    const loaded = loadSymbolMappings();
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].code, 'DL-1');

    saveSymbolTemplate({
      name: 'Firm Standard Electrical Legend',
      description: 'Reusable consultant legend',
      drawingType: 'Electrical Layout',
      symbols: loaded,
    });
    const templates = loadSymbolTemplates();
    assert.equal(templates.length, 1);
    assert.equal(templates[0].symbols.length, 2);

    const afterDelete = deleteSymbolTemplate(templates[0].id);
    assert.equal(afterDelete.length, 0);
  });

  await test('4. Unit conversion and 2-point scale calibration vs explicit uncalibrated config', () => {
    assert.equal(convertUnitToMeters(3000, 'mm'), 3);
    assert.equal(convertUnitToMeters(250, 'cm'), 2.5);
    assert.equal(convertUnitToMeters(10, 'm'), 10);
    assert.ok(Math.abs(convertUnitToMeters(10, 'ft') - 3.048) < 0.001);
    assert.ok(Math.abs(convertUnitToMeters(100, 'in') - 2.54) < 0.001);

    const uncal = createUncalibratedConfig(2000, 1000, 'm');
    assert.equal(uncal.calibrated, false);
    assert.equal(uncal.pixelsPerMeter, null);
    assert.match(uncal.note, /NOT calibrated/i);

    // 2-point calibration across 50% of 2000px image = 1000px representing 10m -> 100 px/m -> full image 20m x 10m
    const calRes = computeTwoPointCalibration({
      pointA: { x: 0.2, y: 0.5 },
      pointB: { x: 0.7, y: 0.5 },
      knownDistanceValue: 10000,
      unit: 'mm',
      imageWidthPx: 2000,
      imageHeightPx: 1000,
    });
    assert.equal(calRes.ok, true);
    if (calRes.ok) {
      assert.equal(calRes.calibration.calibrated, true);
      assert.equal(calRes.calibration.drawingWidthMeters, 20);
      assert.equal(calRes.calibration.drawingHeightMeters, 10);
      assert.equal(calRes.calibration.pixelsPerMeter, 100);
    }

    // Reject coincident points
    const badCal = computeTwoPointCalibration({
      pointA: { x: 0.5, y: 0.5 },
      pointB: { x: 0.501, y: 0.501 },
      knownDistanceValue: 5,
      unit: 'm',
      imageWidthPx: 1000,
      imageHeightPx: 1000,
    });
    assert.equal(badCal.ok, false);
  });

  await test('5. AI analysis normalization applies user symbol definitions, flags low-confidence, unmapped, and duplicates', () => {
    const userSymbols = [
      createSymbolMapping({
        name: '15W Downlight',
        code: 'DL-1',
        domain: 'lighting',
        electricalItemType: 'led_light',
      }),
    ];

    const normalized = normalizeAiAnalysisResponse(
      {
        summary: 'Detected basic floor plan.',
        warnings: [],
        titleBlock: { scaleText: '1:100' },
        legendEntries: [{ code: 'DL-1', label: 'Downlight', description: 'LED', confidence: 0.9 }],
        walls: [
          { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.1, wallKind: 'external', confidence: 0.92 },
          // Near-duplicate of wall 1
          { x1: 0.9, y1: 0.1, x2: 0.1, y2: 0.1, wallKind: 'external', confidence: 0.88 },
          // Low-confidence wall
          { x1: 0.5, y1: 0.1, x2: 0.5, y2: 0.9, wallKind: 'internal', confidence: 0.55 },
        ],
        rooms: [
          { name: 'Living Room', roomType: 'living', x: 0.1, y: 0.1, width: 0.4, height: 0.8, confidence: 0.9 },
        ],
        openings: [
          { kind: 'door', x: 0.3, y: 0.1, widthNorm: 0.08, rotationDeg: 0, confidence: 0.85 },
        ],
        columns: [
          { label: 'C1', x: 0.1, y: 0.1, widthNorm: 0.02, heightNorm: 0.02, confidence: 0.85 },
        ],
        staircases: [],
        symbols: [
          // Matches user symbol -> approved
          { symbolMappingId: userSymbols[0].id, symbolName: '15W Downlight', symbolCode: 'DL-1', domain: 'lighting', x: 0.25, y: 0.4, rotationDeg: 0, confidence: 0.91 },
          // Duplicate of symbol 1 -> forced uncertain
          { symbolMappingId: userSymbols[0].id, symbolName: '15W Downlight', symbolCode: 'DL-1', domain: 'lighting', x: 0.252, y: 0.402, rotationDeg: 0, confidence: 0.88 },
          // Unmapped symbol even with high confidence -> forced uncertain
          { symbolName: 'Unknown Triangle', symbolCode: 'TRI', domain: 'custom', x: 0.7, y: 0.5, rotationDeg: 0, confidence: 0.95 },
        ],
        wiringPaths: [
          { label: 'L1 Run', points: [{ x: 0.25, y: 0.4 }, { x: 0.25, y: 0.6 }], confidence: 0.82 },
        ],
        dimensions: [
          { x1: 0.1, y1: 0.05, x2: 0.9, y2: 0.05, labelText: '12.0 m', confidence: 0.9 },
        ],
        textLabels: [
          { text: 'LIVING ROOM', x: 0.28, y: 0.45, kind: 'room-label', confidence: 0.92 },
        ],
      },
      userSymbols,
      1,
      'gemini-4-hydrogen'
    );

    assert.equal(normalized.walls[0].status, 'approved');
    assert.equal(normalized.walls[1].status, 'uncertain');
    assert.equal(normalized.walls[1].isDuplicateCandidate, true);
    assert.equal(normalized.walls[2].status, 'uncertain');

    assert.equal(normalized.symbols[0].status, 'approved');
    assert.equal(normalized.symbols[0].matchedByUserLegend, true);
    assert.equal(normalized.symbols[1].status, 'uncertain');
    assert.equal(normalized.symbols[1].isDuplicateCandidate, true);
    assert.equal(normalized.symbols[2].status, 'uncertain');
    assert.equal(normalized.symbols[2].matchedByUserLegend, false);
  });

  await test('6. Native 2D generation converts ONLY approved objects, never invents prices, and round-trips .bluespace & .json', () => {
    const userSymbols = [
      createSymbolMapping({
        name: '15W Downlight',
        code: 'DL-1',
        domain: 'lighting',
        electricalItemType: 'led_light',
      }),
    ];

    const normalized = normalizeAiAnalysisResponse(
      {
        summary: 'Test layout',
        warnings: [],
        titleBlock: {},
        legendEntries: [],
        walls: [
          { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.1, wallKind: 'external', confidence: 0.95 },
          { x1: 0.5, y1: 0.1, x2: 0.5, y2: 0.8, wallKind: 'internal', confidence: 0.45 }, // uncertain -> must be excluded
        ],
        rooms: [
          { name: 'Hall', roomType: 'hall', x: 0.1, y: 0.1, width: 0.8, height: 0.7, confidence: 0.9 },
        ],
        openings: [
          { kind: 'door', x: 0.5, y: 0.1, widthNorm: 0.08, rotationDeg: 0, confidence: 0.9 },
        ],
        columns: [
          { label: 'C1', x: 0.1, y: 0.1, widthNorm: 0.02, heightNorm: 0.02, confidence: 0.9 },
        ],
        staircases: [
          { label: 'Main Stair', x: 0.7, y: 0.6, widthNorm: 0.15, heightNorm: 0.2, rotationDeg: 0, steps: 14, confidence: 0.88 },
        ],
        symbols: [
          { symbolMappingId: userSymbols[0].id, symbolName: '15W Downlight', symbolCode: 'DL-1', domain: 'lighting', x: 0.3, y: 0.4, rotationDeg: 0, confidence: 0.92 },
          { symbolMappingId: userSymbols[0].id, symbolName: '15W Downlight', symbolCode: 'DL-1', domain: 'lighting', x: 0.6, y: 0.4, rotationDeg: 0, confidence: 0.91 },
          { symbolName: 'Unmapped Fixture', symbolCode: 'UNK', domain: 'custom', x: 0.75, y: 0.4, rotationDeg: 0, confidence: 0.95 }, // uncertain -> excluded
        ],
        wiringPaths: [
          { label: 'L1', points: [{ x: 0.3, y: 0.4 }, { x: 0.6, y: 0.4 }], confidence: 0.85 },
        ],
        dimensions: [
          { x1: 0.1, y1: 0.05, x2: 0.9, y2: 0.05, labelText: '16.0m', confidence: 0.9 },
        ],
        textLabels: [
          { text: 'HALL', x: 0.45, y: 0.45, kind: 'room-label', confidence: 0.9 },
        ],
      },
      userSymbols,
      1,
      'gemini-4-hydrogen'
    );

    const cal = computeTwoPointCalibration({
      pointA: { x: 0.1, y: 0.1 },
      pointB: { x: 0.9, y: 0.1 },
      knownDistanceValue: 16,
      unit: 'm',
      imageWidthPx: 2000,
      imageHeightPx: 1000,
    });
    assert.equal(cal.ok, true);
    if (!cal.ok) return;

    const generated = generateEditable2DProjectFromModel({
      model: normalized,
      calibration: cal.calibration,
      metadata: {
        projectName: 'Villa Ground Plan',
        drawingType: 'Combined Architectural & Electrical',
        measurementUnit: 'm',
        scaleLabel: '1:100',
        defaultCeilingHeightM: 3.0,
        defaultWallThicknessM: 0.15,
        targetFloor: 1,
        importTarget: 'new-project',
        notes: '',
      },
      source: {
        originalFileName: 'villa.pdf',
        mimeType: 'application/pdf',
        selectedPage: 1,
      },
      symbolMappings: userSymbols,
    });

    const p = generated.project;
    assert.equal(generated.isNewProject, true);
    assert.equal(p.customWalls.length, 1); // Only approved wall included
    assert.equal(p.rooms.length, 1);
    assert.equal(p.openings.length, 1);
    assert.equal(p.staircases?.length, 1);
    assert.equal(p.points.length, 2); // Only 2 approved matched symbols; unmapped excluded
    assert.equal(p.points[0].unitCost, 0); // Prices are NEVER invented
    assert.equal(p.wires?.length, 1);
    assert.equal(p.wires?.[0].cableSizeSqMm, null); // Cable size never invented
    assert.equal(p.dimensions?.length, 1);
    assert.equal(p.aiDrawingImport?.calibrated, true);
    assert.equal(p.aiDrawingImport?.countsSummary.excludedUncertainOrRejected, 2);

    // Round-trip via native .bluespace
    const nativeRaw = projectStorage.exportNativeBluespace(p);
    const parsedNative = projectStorage.parseNativeProjectFile(nativeRaw);
    assert.ok(parsedNative);
    assert.equal(parsedNative.project.customWalls.length, 1);
    assert.equal(parsedNative.project.points.length, 2);
    assert.equal(parsedNative.project.aiDrawingImport?.sourceFileName, 'villa.pdf');
    assert.equal(parsedNative.project.aiDrawingImport?.columns?.length, 1);

    // Round-trip via JSON export/import
    const jsonRaw = projectStorage.exportProjectJson(p);
    const parsedJson = projectStorage.parseImportedJson(jsonRaw);
    assert.ok(parsedJson);
    assert.equal(parsedJson.customWalls.length, 1);
    assert.equal(parsedJson.aiDrawingImport?.calibrated, true);

    // Merge into existing project avoids duplicate wall creation
    const merge1 = generateEditable2DProjectFromModel({
      model: normalized,
      calibration: cal.calibration,
      metadata: {
        projectName: INITIAL_PROJECTS[0].name,
        drawingType: 'Combined Architectural & Electrical',
        measurementUnit: 'm',
        scaleLabel: '1:100',
        defaultCeilingHeightM: 3.0,
        defaultWallThicknessM: 0.15,
        targetFloor: 1,
        importTarget: 'merge-active-floor',
        notes: '',
      },
      source: {
        originalFileName: 'villa.pdf',
        mimeType: 'application/pdf',
        selectedPage: 1,
      },
      symbolMappings: userSymbols,
      existingProject: p,
    });
    // Wall & points at identical coordinates must be deduplicated
    assert.equal(merge1.project.customWalls.length, p.customWalls.length);
    assert.equal(merge1.project.points.length, p.points.length);
  });

  await test('7. Express API validates payloads (400) and returns honest 503 when GEMINI_API_KEY is unset (no fake AI)', async () => {
    const prevKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    const app = createApp();
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Status check
      const statusRes = await fetch(`${baseUrl}/api/ai-drawing/status`);
      assert.equal(statusRes.status, 200);
      const statusJson = (await statusRes.json()) as { configured: boolean; model: string };
      assert.equal(statusJson.configured, false);
      assert.equal(statusJson.model, 'gemini-4-hydrogen');

      // Invalid image MIME -> 400
      const badMimeRes = await fetch(`${baseUrl}/api/ai-drawing/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mimeType: 'image/svg+xml', imageBase64: 'abc' }),
      });
      assert.equal(badMimeRes.status, 400);

      // Valid PNG payload without GEMINI_API_KEY -> 503 AI_NOT_CONFIGURED (never fake detections!)
      const validPngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const noKeyRes = await fetch(`${baseUrl}/api/ai-drawing/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mimeType: 'image/png',
          imageBase64: validPngBase64,
          metadata: { projectName: 'Test', drawingType: 'Architectural Floor Plan', measurementUnit: 'm' },
          symbolDefinitions: [],
        }),
      });
      assert.equal(noKeyRes.status, 503);
      const noKeyJson = (await noKeyRes.json()) as { ok: boolean; code: string };
      assert.equal(noKeyJson.ok, false);
      assert.equal(noKeyJson.code, 'AI_NOT_CONFIGURED');
    } finally {
      if (prevKey !== undefined) {
        process.env.GEMINI_API_KEY = prevKey;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await test('8. runWithTransientRetry recovers from 503 overload via retry & fallback without retrying 403', async () => {
    let calls = 0;
    const recovered = await runWithTransientRetry(
      [
        {
          label: 'gemini-4-hydrogen',
          run: async () => {
            calls += 1;
            const e = new Error('503 UNAVAILABLE') as Error & { status: number };
            e.status = 503;
            throw e;
          },
        },
        {
          label: 'gemini-3.1-flash-lite',
          run: async () => {
            calls += 1;
            return 'ok-from-fallback';
          },
        },
      ],
      10
    );
    assert.equal(calls, 2);
    assert.equal(recovered.result, 'ok-from-fallback');
    assert.equal(recovered.label, 'gemini-3.1-flash-lite');

    let nonRetryCalls = 0;
    await assert.rejects(
      () =>
        runWithTransientRetry(
          [
            {
              label: 'gemini-4-hydrogen',
              run: async () => {
                nonRetryCalls += 1;
                const e = new Error('PERMISSION_DENIED') as Error & { status: number };
                e.status = 403;
                throw e;
              },
            },
            {
              label: 'gemini-3.1-flash-lite',
              run: async () => {
                nonRetryCalls += 1;
                return 'should-not-run';
              },
            },
          ],
          10
        ),
      /PERMISSION_DENIED/
    );
    assert.equal(nonRetryCalls, 1);
  });

  console.log(`\nAll ${passed} AI Drawing to 2D tests passed!\n`);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
