import assert from 'node:assert/strict';
import { FT_TO_M, M_TO_FT } from '../src/data/presets';
import { ProjectData } from '../src/types/design';
import {
  autoRouteUnwiredCables,
  computeDetailedWireQuantityReport,
  computeWireLengthBreakdown,
  computeWireLengthMeters,
  WIRE_STANDARD_COLORS,
} from '../src/utils/buildingWiring';
import {
  CANVAS_ASPECT_RATIO_W_TO_H,
  computeCalibrated2DCanvasMetrics,
  CONDUCTOR_VISUAL_LANE_OFFSET_PX,
  metersToScreenCoords,
  offsetPolylinePerpendicular,
  screenToCalibratedMeters,
} from '../src/utils/canvasScale2D';

let passed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    throw err;
  }
}

function buildHall20x13Project(): ProjectData {
  const lengthFt = 20;
  const widthFt = 13;
  const lengthM = Number((lengthFt * FT_TO_M).toFixed(3)); // 6.096 m
  const widthM = Number((widthFt * FT_TO_M).toFixed(3)); // 3.962 m

  return {
    id: 'proj-hall-20x13',
    refCode: 'HALL-20X13',
    name: 'Hall 20ft x 13ft Calibration Test',
    projectType: 'Residential',
    status: 'Active',
    description: '20ft x 13ft Hall calibration and 3-conductor wire routing verification',
    site: {
      length: lengthFt,
      width: widthFt,
      ceilingHeight: 10,
      wallThickness: 0.5,
      units: 'ft',
      floors: 1,
    },
    rooms: [
      {
        id: 'room-hall',
        name: 'Hall',
        type: 'hall',
        x: 0,
        y: 0,
        width: lengthM,
        height: widthM,
        floorFinish: 'tile',
        floor: 1,
      },
    ],
    points: [
      {
        id: 'pt-ep1',
        code: 'EP-1',
        name: 'Main Earthing Pit',
        itemType: 'earthing_point',
        category: 'Distribution',
        roomId: 'room-hall',
        x: 0.25,
        y: 0.25,
        z: 0.3,
        rotation: 0,
        wattage: 0,
        voltage: 230,
        unitCost: 0,
        circuit: 'CKT-P2 (Power 16A)',
        floor: 1,
      },
      {
        id: 'pt-db1',
        code: 'DB-1',
        name: 'Main Distribution Board',
        itemType: 'distribution_board',
        category: 'Distribution',
        roomId: 'room-hall',
        x: 0.4,
        y: 0.5,
        z: 1.6,
        rotation: 0,
        wattage: 0,
        voltage: 230,
        unitCost: 0,
        circuit: 'CKT-L1 (Lighting)',
        floor: 1,
      },
      {
        id: 'pt-sb1',
        code: 'SB-1',
        name: 'Hall Main Switchboard',
        itemType: 'switchboard',
        category: 'Switches',
        roomId: 'room-hall',
        x: 1.1,
        y: 0.2,
        z: 1.3,
        rotation: 0,
        wattage: 0,
        voltage: 230,
        unitCost: 0,
        circuit: 'CKT-L1 (Lighting)',
        floor: 1,
      },
      {
        id: 'pt-l1',
        code: 'L-1',
        name: 'Hall Ceiling Light 1',
        itemType: 'led_light',
        category: 'Lighting',
        roomId: 'room-hall',
        x: 1.6,
        y: 1.1,
        z: 3.0,
        rotation: 0,
        wattage: 18,
        voltage: 230,
        unitCost: 0,
        circuit: 'CKT-L1 (Lighting)',
        floor: 1,
      },
      {
        id: 'pt-l2',
        code: 'L-2',
        name: 'Hall Ceiling Light 2',
        itemType: 'led_light',
        category: 'Lighting',
        roomId: 'room-hall',
        x: 4.5,
        y: 1.1,
        z: 3.0,
        rotation: 0,
        wattage: 18,
        voltage: 230,
        unitCost: 0,
        circuit: 'CKT-L1 (Lighting)',
        floor: 1,
      },
      {
        id: 'pt-f1',
        code: 'F-1',
        name: 'Hall Ceiling Fan',
        itemType: 'ceiling_fan',
        category: 'Fans',
        roomId: 'room-hall',
        x: 3.05,
        y: 1.98,
        z: 2.75,
        rotation: 0,
        wattage: 75,
        voltage: 230,
        unitCost: 0,
        circuit: 'CKT-L1 (Lighting)',
        floor: 1,
      },
      {
        id: 'pt-l3',
        code: 'L-3',
        name: 'Hall Ceiling Light 3',
        itemType: 'led_light',
        category: 'Lighting',
        roomId: 'room-hall',
        x: 4.5,
        y: 2.9,
        z: 3.0,
        rotation: 0,
        wattage: 18,
        voltage: 230,
        unitCost: 0,
        circuit: 'CKT-L1 (Lighting)',
        floor: 1,
      },
      {
        id: 'pt-p1',
        code: 'P-1',
        name: 'Hall 16A Power Socket',
        itemType: 'socket_16a',
        category: 'Sockets',
        roomId: 'room-hall',
        x: 5.8,
        y: 2.2,
        z: 0.45,
        rotation: 0,
        wattage: 1200,
        voltage: 230,
        unitCost: 0,
        circuit: 'CKT-P2 (Power 16A)',
        floor: 1,
      },
      {
        id: 'pt-ac1',
        code: 'AC-1',
        name: 'Hall Split AC 1.5T',
        itemType: 'split_ac',
        category: 'Appliances',
        roomId: 'room-hall',
        x: 5.9,
        y: 1.0,
        z: 2.4,
        rotation: 0,
        wattage: 1800,
        voltage: 230,
        unitCost: 0,
        circuit: 'CKT-P2 (Power 16A)',
        floor: 1,
      },
    ],
    wires: [],
    customWalls: [],
    openings: [],
    furniture: [],
    staircases: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('1. Canvas aspect ratio is strictly 1:4 (width:height) with exact calibrated room proportions', () => {
  const hallLenM = 20 * FT_TO_M; // 6.096 m
  const hallWidM = 13 * FT_TO_M; // 3.9624 m

  const testCases = [
    { len: hallLenM, wid: hallWidM, vp: { width: 1440, height: 820 } },
    { len: 12, wid: 8, vp: { width: 1024, height: 768 } },
    { len: 30, wid: 20, vp: { width: 800, height: 800 } },
    { len: 4, wid: 18, vp: { width: 430, height: 932 } },
  ];

  for (const tc of testCases) {
    const m = computeCalibrated2DCanvasMetrics(tc.len, tc.wid, { viewport: tc.vp });
    assert.ok(
      Math.abs(m.sheetAspectRatio - CANVAS_ASPECT_RATIO_W_TO_H) < 1e-9,
      `Expected exact 1:4 (0.25) sheet aspect ratio, got ${m.sheetAspectRatio}`
    );
    assert.ok(
      Math.abs(m.sheetW / m.sheetH - 0.25) < 1e-9,
      `Expected sheetW/sheetH === 0.25, got ${m.sheetW / m.sheetH}`
    );

    // Real-world room proportion preserved identically on X and Y
    const realRatio = tc.len / tc.wid;
    const planRatio = m.planW / m.planH;
    assert.ok(
      Math.abs(planRatio - realRatio) < 1e-9,
      `Room proportion distorted: expected ${realRatio}, got ${planRatio}`
    );
  }
});

test('2. Zero distortion during zoom, pan, and arbitrary container resize (exact round-trip)', () => {
  const hallLenM = 20 * FT_TO_M;
  const hallWidM = 13 * FT_TO_M;
  const expectedHallRatio = 20 / 13;

  const rects = [
    { left: 0, top: 0, width: 1920, height: 900 },
    { left: 24, top: 64, width: 1280, height: 720 },
    { left: 10, top: 20, width: 800, height: 800 },
    { left: 0, top: 0, width: 420, height: 880 },
  ];
  const zooms = [20, 50, 100, 175, 250];
  const pans = [
    { x: 0, y: 0 },
    { x: 145, y: -220 },
    { x: -310, y: 410 },
  ];

  for (const rect of rects) {
    const metrics = computeCalibrated2DCanvasMetrics(hallLenM, hallWidM, {
      viewport: { width: rect.width, height: rect.height },
    });
    for (const zoom of zooms) {
      for (const pan of pans) {
        const p0 = metersToScreenCoords(0, 0, rect, metrics, zoom, pan);
        const px = metersToScreenCoords(hallLenM, 0, rect, metrics, zoom, pan);
        const py = metersToScreenCoords(0, hallWidM, rect, metrics, zoom, pan);

        const renderedW = Math.hypot(px.x - p0.x, px.y - p0.y);
        const renderedH = Math.hypot(py.x - p0.x, py.y - p0.y);
        const renderedRatio = renderedW / renderedH;

        assert.ok(
          Math.abs(renderedRatio - expectedHallRatio) < 1e-6,
          `Distortion detected at ${rect.width}x${rect.height} zoom=${zoom}% pan=(${pan.x},${pan.y}): expected ratio ${expectedHallRatio}, got ${renderedRatio}`
        );

        // Verify exact screen -> calibrated meters round-trip for a Hall ceiling fan position
        const targetM = { x: 3.05, y: 1.98 };
        const screenPt = metersToScreenCoords(targetM.x, targetM.y, rect, metrics, zoom, pan);
        const back = screenToCalibratedMeters(screenPt.x, screenPt.y, rect, metrics, zoom, pan);
        assert.equal(back.inside, true);
        assert.ok(Math.abs(back.x - targetM.x) < 1e-6, `Round-trip X mismatch: ${back.x} vs ${targetM.x}`);
        assert.ok(Math.abs(back.y - targetM.y) < 1e-6, `Round-trip Y mismatch: ${back.y} vs ${targetM.y}`);
      }
    }
  }
});

test('3. Parallel conductor visual offset separates Phase (L), Neutral (N), and Earth (E) cleanly', () => {
  const centerline = [
    { x: 100, y: 100 },
    { x: 300, y: 100 },
    { x: 300, y: 240 },
  ];
  const phasePts = offsetPolylinePerpendicular(centerline, CONDUCTOR_VISUAL_LANE_OFFSET_PX.phase);
  const neutralPts = offsetPolylinePerpendicular(centerline, CONDUCTOR_VISUAL_LANE_OFFSET_PX.neutral);
  const earthPts = offsetPolylinePerpendicular(centerline, CONDUCTOR_VISUAL_LANE_OFFSET_PX.earth);

  assert.equal(phasePts.length, 3);
  assert.equal(neutralPts.length, 3);
  assert.equal(earthPts.length, 3);
  // On horizontal segment (100,100)->(300,100), normal is (0, +1), so Phase/Neutral/Earth have distinct Y
  assert.notEqual(phasePts[0].y, neutralPts[0].y);
  assert.notEqual(earthPts[0].y, neutralPts[0].y);
  assert.ok(Math.abs((earthPts[0].y - phasePts[0].y) - 5.6) < 1e-6);
});

test('4. Hall 20ft x 13ft: routes separate Phase (Red), Neutral (Blue), and Earth (Green) along DB -> Switchboard -> Loads', () => {
  assert.equal(WIRE_STANDARD_COLORS['IS-732'].phase, '#EF4444');
  assert.equal(WIRE_STANDARD_COLORS['IS-732'].neutral, '#3B82F6');
  assert.equal(WIRE_STANDARD_COLORS['IS-732'].earth, '#22C55E');

  const hall = buildHall20x13Project();
  const routed = autoRouteUnwiredCables(hall);
  assert.ok(routed.addedCount > 0, 'Expected auto-routed conductors to be created');

  const wires = routed.nextWires;
  const phaseWires = wires.filter((w) => w.category === 'phase');
  const neutralWires = wires.filter((w) => w.category === 'neutral');
  const earthWires = wires.filter((w) => w.category === 'earth');

  assert.ok(phaseWires.length >= 6, `Expected >=6 phase runs, got ${phaseWires.length}`);
  assert.equal(neutralWires.length, phaseWires.length, 'Neutral must be routed as separate conductor matching Phase');
  // Earth includes all branch conductors + EP-1 -> DB-1 main earth bonding
  assert.equal(earthWires.length, phaseWires.length + 1, 'Earth must be routed separately for every run plus EP->DB');

  // Verify color coding on routed wires
  phaseWires.forEach((w) => assert.equal(w.color, '#EF4444'));
  neutralWires.forEach((w) => assert.equal(w.color, '#3B82F6'));
  earthWires.forEach((w) => assert.equal(w.color, '#22C55E'));

  // Verify continuous lighting topology: DB-1 -> SB-1 -> Ceiling Lights/Fan (not bypassing SB-1)
  const dbToSb = wires.filter((w) => w.fromPointId === 'pt-db1' && w.toPointId === 'pt-sb1');
  assert.equal(dbToSb.length, 3, 'DB-1 -> SB-1 must carry separate Phase, Neutral, and Earth');
  assert.deepEqual(
    dbToSb.map((w) => w.category).sort(),
    ['earth', 'neutral', 'phase']
  );

  const fromSbToLights = wires.filter((w) => w.fromPointId === 'pt-sb1');
  assert.equal(fromSbToLights.length, 3, 'SB-1 must branch separate Phase, Neutral, and Earth to Hall lights/fan');

  // Verify AC-1 dedicated feed comes directly from DB-1
  const dbToAc = wires.filter((w) => w.fromPointId === 'pt-db1' && w.toPointId === 'pt-ac1');
  assert.equal(dbToAc.length, 3, 'Dedicated Split AC must route separate L, N, E from DB-1');

  // Verify idempotency: running autoRouteUnwiredCables again adds 0 duplicates
  const secondRun = autoRouteUnwiredCables({ ...hall, wires });
  assert.equal(secondRun.addedCount, 0, 'Re-running auto-route must not duplicate any wires');
});

test('5. Hall 20ft x 13ft: accurate per-circuit L/N/E lengths in metres & feet with separate base, termination & allowance', () => {
  const hall = buildHall20x13Project();
  const routed = autoRouteUnwiredCables(hall);
  const projectWithWires: ProjectData = { ...hall, wires: routed.nextWires };

  const report = computeDetailedWireQuantityReport(projectWithWires, {
    installationAllowancePct: 10,
  });

  assert.equal(report.isCompleteThreeConductor, true);
  assert.equal(report.circuits.length, 2, 'Expected CKT-L1 (Lighting) and CKT-P2 (Power 16A)');

  const lightingCkt = report.circuits.find((c) => c.circuit === 'CKT-L1 (Lighting)');
  const powerCkt = report.circuits.find((c) => c.circuit === 'CKT-P2 (Power 16A)');
  assert.ok(lightingCkt, 'Lighting circuit summary missing');
  assert.ok(powerCkt, 'Power circuit summary missing');

  // Every applicable circuit must report individual Phase, Neutral, and Earth separately
  for (const ckt of [lightingCkt, powerCkt]) {
    assert.equal(ckt.hasAllThreeConductors, true);
    for (const cond of [ckt.phase, ckt.neutral, ckt.earth]) {
      assert.ok(cond.horizontalM > 0, `${ckt.circuit} ${cond.label} must include horizontal route length`);
      assert.ok(cond.verticalDropsM > 0, `${ckt.circuit} ${cond.label} must include vertical drops`);
      assert.ok(
        Math.abs(cond.baseRouteM - (cond.horizontalM + cond.verticalDropsM)) <= 0.05,
        `Base route must equal horizontal + vertical drops`
      );
      assert.ok(cond.terminationM > 0, 'Termination length must be calculated separately and > 0');
      assert.ok(cond.allowanceM > 0, 'Installation allowance (10%) must be calculated separately and > 0');
      assert.ok(
        Math.abs(cond.totalM - (cond.baseRouteM + cond.terminationM + cond.allowanceM)) <= 0.03,
        `Total (${cond.totalM}) must equal Base (${cond.baseRouteM}) + Term (${cond.terminationM}) + Allowance (${cond.allowanceM})`
      );
      // Verify metres <-> feet conversion accuracy
      assert.ok(
        Math.abs(cond.baseRouteFt - cond.baseRouteM * M_TO_FT) <= 0.05,
        'Base route feet conversion mismatch'
      );
      assert.ok(
        Math.abs(cond.totalFt - cond.totalM * M_TO_FT) <= 0.05,
        'Total feet conversion mismatch'
      );
    }
  }

  // Verify lighting conductor length is NOT derived from room perimeter (66 ft = 20.12 m) or area (260 sq.ft)
  const hallPerimeterM = 2 * (20 + 13) * FT_TO_M;
  assert.notEqual(
    Number(lightingCkt.phase.baseRouteM.toFixed(1)),
    Number(hallPerimeterM.toFixed(1)),
    'Wire length must come from actual calibrated coordinates, not room perimeter'
  );

  // Verify single-wire breakdown matches computeWireLengthMeters for base route
  const sampleWire = routed.nextWires[0];
  const breakdown = computeWireLengthBreakdown(sampleWire, projectWithWires, 10);
  assert.equal(breakdown.baseRouteM, computeWireLengthMeters(sampleWire, projectWithWires));
  assert.ok(breakdown.totalM > breakdown.baseRouteM);
});

test('6. Moving devices or resizing room automatically recalculates wire quantities', () => {
  const hall = buildHall20x13Project();
  const routed = autoRouteUnwiredCables(hall);
  const beforeProj: ProjectData = { ...hall, wires: routed.nextWires };
  const beforeReport = computeDetailedWireQuantityReport(beforeProj, {
    installationAllowancePct: 10,
  });

  // Move Ceiling Light 3 farther across the Hall and raise ceiling height from 10 ft to 12 ft
  const movedProj: ProjectData = {
    ...beforeProj,
    site: { ...beforeProj.site, ceilingHeight: 12 },
    points: beforeProj.points.map((pt) =>
      pt.id === 'pt-l3' ? { ...pt, x: 5.8, y: 3.7 } : pt
    ),
  };
  const afterReport = computeDetailedWireQuantityReport(movedProj, {
    installationAllowancePct: 10,
  });

  assert.ok(
    afterReport.totalsByConductor.phase.baseRouteM > beforeReport.totalsByConductor.phase.baseRouteM,
    'Moving light & increasing ceiling height must automatically increase Phase length'
  );
  assert.ok(
    afterReport.totalsByConductor.neutral.baseRouteM > beforeReport.totalsByConductor.neutral.baseRouteM,
    'Moving light & increasing ceiling height must automatically increase Neutral length'
  );
  assert.ok(
    afterReport.totalsByConductor.earth.baseRouteM > beforeReport.totalsByConductor.earth.baseRouteM,
    'Moving light & increasing ceiling height must automatically increase Earth length'
  );
  assert.ok(
    afterReport.grandTotal.totalFt > beforeReport.grandTotal.totalFt,
    'Grand total in feet must automatically increase'
  );
});

console.log(`\nAll ${passed} 2D Canvas 1:4 & 3-Conductor Wire Routing tests passed.`);
