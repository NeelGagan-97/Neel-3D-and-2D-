import assert from 'node:assert/strict';
import test from 'node:test';
import readXlsxFile from 'read-excel-file/universal';
import { computeProjectMetrics, INITIAL_PROJECTS } from '../src/data/presets';
import { ElectricalPoint, ElectricalWire, ProjectData } from '../src/types/design';
import {
  autoRouteUnwiredCables,
  computeReconciledBoq,
  computeWireConsumptionSummary,
  computeWireLengthMeters,
  createElectricalWire,
  duplicateFloorInProject,
} from '../src/utils/buildingWiring';
import { buildExcelBoqBlob, buildExcelBoqSheets } from '../src/utils/excelBoqExporter';

function cloneSampleProject(): ProjectData {
  return JSON.parse(JSON.stringify(INITIAL_PROJECTS[0])) as ProjectData;
}

test('1. computeProjectMetrics populates unitPrice and Estimated Cost = Quantity × Price/Unit', () => {
  const project = cloneSampleProject();
  const metrics = computeProjectMetrics(project);

  assert.ok(metrics.boqRows.length > 0, 'Sample project must have BOQ rows');
  for (const row of metrics.boqRows) {
    assert.equal(typeof row.unitPrice, 'number', `Row "${row.productName}" must have numeric unitPrice`);
    assert.equal(
      row.estimatedCost,
      Number((row.quantity * (row.unitPrice ?? 0)).toFixed(2)),
      `Estimated Cost must equal Quantity × Price/Unit for "${row.productName}"`
    );
  }
});

test('2. BOQ Price/Unit override propagates to computeReconciledBoq while preserving GST & totals', () => {
  const project = cloneSampleProject();
  // Configure GST 18% on ceiling fans
  project.points = project.points.map((p) =>
    p.itemType === 'ceiling_fan' ? { ...p, gstPercent: 18 } : p
  );
  // Apply BOQ Price/Unit override of ₹4,000 for ceiling_fan
  project.summaryOverrides = {
    boqEdits: {
      ceiling_fan: { unitPrice: 4000 },
    },
  };

  const fanCount = project.points.filter((p) => p.itemType === 'ceiling_fan').length;
  assert.ok(fanCount > 0);

  const boq = computeReconciledBoq(project);
  const fanRow = boq.rows.find((r) => r.productCategory === 'Ceiling Fans');
  assert.ok(fanRow, 'Ceiling fan BOQ row must exist');
  assert.equal(fanRow.quantity, fanCount);
  assert.equal(fanRow.unitPrice, 4000);
  assert.equal(fanRow.subtotal, Number((fanCount * 4000).toFixed(2)));
  assert.equal(fanRow.gstPercent, 18);
  assert.equal(fanRow.gstAmount, Number((fanCount * 4000 * 0.18).toFixed(2)));
  assert.equal(fanRow.total, Number((fanCount * 4000 * 1.18).toFixed(2)));
});

test('3. Wire Consumption Summary returns null / "Not calculated" when no wiring routes exist (never invents values)', () => {
  const project = cloneSampleProject();
  project.wires = [];

  const summary = computeWireConsumptionSummary(project);
  assert.equal(summary.rows.length, 0);
  assert.equal(summary.uniqueRouteCount, 0);
  assert.equal(summary.overallInstalledLengthM, null);
  assert.equal(summary.overallProcurementAllowanceM, null);

  const sheets = buildExcelBoqSheets(project);
  const sheet1Text = sheets[0].rows.map((r) => r.join(' | ')).join('\n');
  assert.ok(sheet1Text.includes('WIRE CONSUMPTION SUMMARY'));
  assert.ok(sheet1Text.includes('Not calculated'));
});

test('4. Wire Consumption Summary includes all floors, deduplicates repeated routes, groups by wire type/size, and separates procurement allowance', () => {
  const base = cloneSampleProject();
  const routed = autoRouteUnwiredCables(base);
  const withWires: ProjectData = { ...base, wires: routed.nextWires };

  // Duplicate ground floor to create multi-floor project (Floor 1 + Floor 2)
  const dup = duplicateFloorInProject(withWires, 1);
  const multiFloor = dup.project;

  // Add an inter-floor riser wire between a Floor 1 point and a Floor 2 point
  const f1Db = multiFloor.points.find((p) => (p.floor ?? 1) === 1 && p.itemType === 'distribution_board')!;
  const f2Fan = multiFloor.points.find((p) => (p.floor ?? 1) === dup.newFloor && p.itemType === 'ceiling_fan')!;
  assert.ok(f1Db && f2Fan, 'Both Ground and Upper floor points must exist');

  const riserWire: ElectricalWire = {
    ...createElectricalWire({
      project: multiFloor,
      fromPoint: f1Db,
      toPoint: f2Fan,
      category: 'phase',
      circuit: 'CKT-L1 (Lighting)',
      cableSizeSqMm: 2.5,
    }),
    id: 'wire-riser-unique-1',
  };

  // Intentionally inject two duplicates:
  // (a) exact same wire ID repeated
  // (b) reversed endpoints (f2Fan -> f1Db) with same category ('phase') and a new ID
  const duplicateById: ElectricalWire = { ...riserWire };
  const duplicateReversed: ElectricalWire = {
    ...riserWire,
    id: 'wire-riser-duplicate-reversed',
    fromPointId: f2Fan.id,
    toPointId: f1Db.id,
  };

  // Add a wire with missing endpoint so its length is unavailable
  const brokenWire: ElectricalWire = {
    ...riserWire,
    id: 'wire-broken-endpoint',
    fromPointId: 'non-existent-pt-1',
    toPointId: 'non-existent-pt-2',
    category: 'control',
    cableSizeSqMm: 1.0,
    wireType: 'Control Cable Missing Geometry',
  };

  const projectWithMultiAndDups: ProjectData = {
    ...multiFloor,
    wires: [
      ...(multiFloor.wires ?? []),
      riserWire,
      duplicateById,
      duplicateReversed,
      brokenWire,
    ],
  };

  const summary = computeWireConsumptionSummary(projectWithMultiAndDups, {
    procurementAllowancePct: 10,
  });

  // Both floors must be included
  assert.ok(summary.floorsCovered.includes(1), 'Floor 1 must be included');
  assert.ok(summary.floorsCovered.includes(dup.newFloor), 'Upper floor must be included');

  // Both injected duplicates must be excluded
  assert.ok(summary.duplicateRoutesExcluded >= 2, 'Duplicate routes must be excluded');

  // Overall installed length must equal the sum of all valid grouped rows (NOT including 10% allowance)
  const expectedInstalledSum = Number(
    summary.rows.reduce((s, r) => s + (r.installedLengthM ?? 0), 0).toFixed(2)
  );
  assert.equal(summary.overallInstalledLengthM, expectedInstalledSum);
  assert.ok(summary.overallInstalledLengthM !== null && summary.overallInstalledLengthM > 0);

  // Procurement allowance must be strictly separate (10% of overall installed length)
  assert.equal(
    summary.overallProcurementAllowanceM,
    Number((expectedInstalledSum * 0.1).toFixed(2))
  );

  // Adding duplicate routes must NOT change overall installed length compared to clean project
  const cleanProject: ProjectData = {
    ...multiFloor,
    wires: [...(multiFloor.wires ?? []), riserWire],
  };
  const cleanSummary = computeWireConsumptionSummary(cleanProject, {
    procurementAllowancePct: 10,
  });
  assert.equal(summary.overallInstalledLengthM, cleanSummary.overallInstalledLengthM);

  // The broken-geometry wire group must report null (displayed as "Not calculated") instead of inventing a value
  const brokenRow = summary.rows.find((r) => r.wireType.includes('Control Cable Missing Geometry'));
  assert.ok(brokenRow, 'Broken wire group should be listed');
  assert.equal(brokenRow.installedLengthM, null);
  assert.equal(brokenRow.procurementAllowanceM, null);
  assert.equal(brokenRow.uncalculatedRouteCount, 1);

  // Verify exact geometry match for the riser wire itself
  const riserLen = computeWireLengthMeters(riserWire, projectWithMultiAndDups);
  assert.ok(riserLen > 3, 'Inter-floor riser length must include floor-to-floor vertical rise');
});

test('5. Excel BOQ workbook places Price/Unit (₹) immediately after Quantity and includes Wire Consumption Summary across all 6 sheets', async () => {
  const base = cloneSampleProject();
  const routed = autoRouteUnwiredCables(base);
  const project: ProjectData = { ...base, wires: routed.nextWires };

  const defs = buildExcelBoqSheets(project, { wireProcurementAllowancePct: 12 });
  assert.equal(defs.length, 6, 'Must preserve all 6 workbook sheets');

  // Sheet 1 header checks: Price/Unit (₹) immediately after Quantity, Estimated Cost (₹) present, GST preserved
  const sheet1Header = defs[0].rows[3].map(String);
  const qtyIdx = sheet1Header.indexOf('Quantity');
  assert.ok(qtyIdx >= 0, 'Quantity column must exist');
  assert.equal(sheet1Header[qtyIdx + 1], 'Price/Unit (₹)', 'Price/Unit (₹) must be immediately after Quantity');
  assert.equal(sheet1Header[qtyIdx + 2], 'Estimated Cost (₹)', 'Estimated Cost (₹) must follow Price/Unit (₹)');
  assert.ok(sheet1Header.includes('GST %'));
  assert.ok(sheet1Header.includes('GST Amount (INR)'));
  assert.ok(sheet1Header.includes('Total (INR)'));

  // Sheet 3 header checks: Price/Unit (₹) immediately after Quantity
  const sheet3Header = defs[2].rows[1].map(String);
  const s3QtyIdx = sheet3Header.indexOf('Quantity');
  assert.equal(sheet3Header[s3QtyIdx + 1], 'Price/Unit (₹)');
  assert.ok(sheet3Header.includes('Estimated Cost (₹)'));

  // Round-trip via write-excel-file + read-excel-file
  const blob = await buildExcelBoqBlob(project, { wireProcurementAllowancePct: 12 });
  const parsed = await readXlsxFile(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(parsed.length, 6);

  const sheet1Flat = parsed[0].data.map((r) => r.map((c) => String(c ?? '')).join(' | ')).join('\n');
  assert.ok(sheet1Flat.includes('WIRE CONSUMPTION SUMMARY'));
  assert.ok(sheet1Flat.includes('OVERALL TOTAL WIRE LENGTH (INSTALLED)'));
  assert.ok(sheet1Flat.includes('PROCUREMENT ALLOWANCE (12% — SEPARATE)'));

  // Verify numeric Estimated Cost = Quantity × Price/Unit on a component row in Sheet 1
  const fanExcelRow = parsed[0].data.find(
    (r) => String(r[0] ?? '') === 'Ceiling Fans' && typeof r[qtyIdx] === 'number' && typeof r[qtyIdx + 1] === 'number'
  );
  assert.ok(fanExcelRow, 'Ceiling Fans BOQ row must exist in exported Excel Sheet 1');
  assert.equal(
    Number(fanExcelRow[qtyIdx + 2]),
    Number((Number(fanExcelRow[qtyIdx]) * Number(fanExcelRow[qtyIdx + 1])).toFixed(2))
  );
});

test('6. Distinct Phase (L), Neutral (N), and Earth (E) conductors between the same two points are NOT treated as duplicates', () => {
  const project = cloneSampleProject();
  const db: ElectricalPoint = project.points.find((p) => p.itemType === 'distribution_board')!;
  const fan: ElectricalPoint = project.points.find((p) => p.itemType === 'ceiling_fan')!;
  assert.ok(db && fan);

  const phaseW = createElectricalWire({ project, fromPoint: db, toPoint: fan, category: 'phase', cableSizeSqMm: 1.5 });
  const neutralW = createElectricalWire({ project, fromPoint: db, toPoint: fan, category: 'neutral', cableSizeSqMm: 1.5 });
  const earthW = createElectricalWire({ project, fromPoint: db, toPoint: fan, category: 'earth', cableSizeSqMm: 1.0 });

  const with3C: ProjectData = { ...project, wires: [phaseW, neutralW, earthW] };
  const summary = computeWireConsumptionSummary(with3C);

  assert.equal(summary.uniqueRouteCount, 3, 'All 3 distinct conductors (L, N, E) must be counted');
  assert.equal(summary.duplicateRoutesExcluded, 0);
  assert.equal(summary.rows.length, 3);
});
