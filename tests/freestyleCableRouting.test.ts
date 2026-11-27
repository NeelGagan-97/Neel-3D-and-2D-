import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { INITIAL_PROJECTS } from '../src/data/presets';
import {
  appendPolylineVertex,
  computePolylineSegmentMetrics,
  computeReconciledBoq,
  computeWireConsumptionSummary,
  computeWireLengthBreakdown,
  createElectricalWire,
  evaluateCableSizingEngineering,
  finalizePolylineWaypoints,
  resolvePolylineStartPoint,
  SELECTABLE_WIRE_SIZES_SQ_MM,
  simplifyFreehandWaypoints,
} from '../src/utils/buildingWiring';
import {
  addWireWaypointToProject,
  deleteEntitiesFromProject,
  deleteWireWaypointFromProject,
  moveWireWaypointInProject,
  placeElectricalPointInRoom,
  updateWireRoutingModeInProject,
} from '../src/utils/studioEditor';
import { buildArchitecturalScene } from '../src/three/architecturalBuilder';
import { ArchitecturalTextureSet } from '../src/three/proceduralTextures';
import { projectStorage } from '../src/services/projectStorage';
import { ProjectData } from '../src/types/design';

function createMockTextureSet(): ArchitecturalTextureSet {
  const mk = () =>
    new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1) as unknown as THREE.CanvasTexture;
  const wood = mk();
  const tile = mk();
  const terrazzo = mk();
  const stone = mk();
  return {
    wood,
    tile,
    terrazzo,
    stone,
    dispose: () => {
      wood.dispose();
      tile.dispose();
      terrazzo.dispose();
      stone.dispose();
    },
  };
}

function buildWireTestProject(): ProjectData {
  const base = JSON.parse(JSON.stringify(INITIAL_PROJECTS[0])) as ProjectData;
  return {
    ...base,
    name: 'Free-Style Cable Routing Test',
    site: {
      length: 12,
      width: 10,
      ceilingHeight: 3.0,
      wallThickness: 0.23,
      units: 'm',
      floors: 1,
    },
    rooms: [
      {
        id: 'rm-living',
        name: 'Living Hall',
        type: 'living',
        floor: 1,
        x: 0.5,
        y: 0.5,
        width: 8.0,
        height: 6.0,
        wallThickness: 0.15,
        rotation: 0,
        floorFinish: 'tile',
      },
    ],
    customWalls: [],
    points: [],
    wires: [],
    openings: [],
    furniture: [],
    hiddenWallIds: [],
  };
}

test('Selectable wire sizes include exactly 1, 1.5, 2, 2.5, 3, and 4 sq.mm', () => {
  assert.deepEqual([...SELECTABLE_WIRE_SIZES_SQ_MM], [1, 1.5, 2, 2.5, 3, 4]);
});

test('Free-style diagonal, curved, and irregular cable routes calculate exact dynamic lengths in metres', () => {
  let proj = buildWireTestProject();
  const p1 = placeElectricalPointInRoom(proj, 'distribution_board', 'rm-living', 1.0, 1.0);
  assert.ok(p1);
  proj = p1.project;
  const p2 = placeElectricalPointInRoom(proj, 'split_ac', 'rm-living', 7.0, 5.0);
  assert.ok(p2);
  proj = p2.project;

  // 1. Direct diagonal freeform route (no forced H/V movement)
  const diagWire = createElectricalWire({
    project: proj,
    fromPoint: p1.point,
    toPoint: p2.point,
    waypoints: [],
    category: 'phase',
    circuit: 'CKT-P2 (Power 16A)',
    cableSizeSqMm: 4,
    routingMode: 'freeform',
    brand: 'Polycab',
    wireType: 'FR PVC Insulated Copper',
    specification: 'IS 694 1100V',
  });
  const projWithDiag: ProjectData = { ...proj, wires: [diagWire] };
  const diagBreakdown = computeWireLengthBreakdown(diagWire, projWithDiag);
  // Horizontal distance between (1,1) and (7,5) is sqrt(6^2 + 4^2) = sqrt(52) ≈ 7.211 m
  // (would be 10.0m if forced orthogonal!)
  assert.ok(
    Math.abs(diagBreakdown.horizontalM - Math.hypot(6, 4)) < 0.05,
    `Expected diagonal ~7.21m, got ${diagBreakdown.horizontalM}m`
  );

  // 2. Irregular multi-point free-style route
  const irregularWire = createElectricalWire({
    project: proj,
    fromPoint: p1.point,
    toPoint: p2.point,
    waypoints: [
      { x: 2.3, y: 2.8 },
      { x: 4.9, y: 1.9 },
      { x: 6.1, y: 4.4 },
    ],
    category: 'neutral',
    circuit: 'CKT-P2 (Power 16A)',
    cableSizeSqMm: 4,
    routingMode: 'freeform',
  });
  const projWithIrregular: ProjectData = { ...proj, wires: [irregularWire] };
  const irregularBreakdown = computeWireLengthBreakdown(irregularWire, projWithIrregular);
  assert.ok(
    irregularBreakdown.horizontalM > diagBreakdown.horizontalM + 0.5,
    'Irregular multi-bend route must have longer horizontal run than straight diagonal'
  );

  // 3. Curved free-style route
  const curvedProj = updateWireRoutingModeInProject(projWithIrregular, irregularWire.id, 'curved');
  const curvedWire = (curvedProj.wires ?? [])[0];
  assert.ok(curvedWire);
  assert.equal(curvedWire.routingMode, 'curved');
  const curvedBreakdown = computeWireLengthBreakdown(curvedWire, curvedProj);
  assert.ok(curvedBreakdown.totalM > 0);
  assert.ok(Number.isFinite(curvedBreakdown.totalM));
});

test('Click-and-drag freehand simplification preserves curved irregular geometry without redundant noise points', () => {
  // Simulate 40 dense pointer-move points along an S-curve
  const rawStroke = Array.from({ length: 40 }, (_, i) => {
    const t = i / 39;
    return {
      x: Number((1.0 + t * 6.0).toFixed(3)),
      y: Number((2.0 + Math.sin(t * Math.PI * 2) * 1.1).toFixed(3)),
    };
  });

  const simplified = simplifyFreehandWaypoints(rawStroke, 0.08);
  assert.ok(simplified.length >= 4, 'Must retain curve inflection points');
  assert.ok(simplified.length < rawStroke.length / 2, 'Must simplify dense stroke points cleanly');
  assert.deepEqual(simplified[0], rawStroke[0]);
  assert.deepEqual(simplified[simplified.length - 1], rawStroke[rawStroke.length - 1]);
});

test('Reshaping existing route (add/move/delete waypoints) keeps endpoints connected & syncs 2D, 3D, Storage, and BOQ', () => {
  let proj = buildWireTestProject();
  const sb = placeElectricalPointInRoom(proj, 'switchboard', 'rm-living', 1.2, 1.2);
  assert.ok(sb);
  proj = sb.project;
  const fan = placeElectricalPointInRoom(proj, 'ceiling_fan', 'rm-living', 6.5, 4.8);
  assert.ok(fan);
  proj = fan.project;

  const wire = createElectricalWire({
    project: proj,
    fromPoint: sb.point,
    toPoint: fan.point,
    waypoints: [{ x: 3.5, y: 2.1 }],
    category: 'phase',
    circuit: 'CKT-L1 (Lighting)',
    cableSizeSqMm: 2,
    routingMode: 'freeform',
    brand: 'Finolex',
    manufacturer: 'Finolex',
    wireType: 'FR PVC Copper',
    specification: 'IS 694 1100V',
    unitPricePerM: 28,
  });
  proj = { ...proj, wires: [wire] };

  const initialBreakdown = computeWireLengthBreakdown(wire, proj);

  // Add intermediate point
  proj = addWireWaypointToProject(proj, wire.id, 1, { x: 5.2, y: 1.4, z: 2.75 });
  const wiresAfterAdd = proj.wires ?? [];
  assert.equal(wiresAfterAdd[0].waypoints.length, 2);
  assert.equal(wiresAfterAdd[0].fromPointId, sb.point.id);
  assert.equal(wiresAfterAdd[0].toPointId, fan.point.id);

  // Move intermediate point freely (diagonal / non-orthogonal coordinates)
  proj = moveWireWaypointInProject(proj, wire.id, 0, { x: 2.73, y: 4.18, z: 2.65 });
  const wiresAfterMove = proj.wires ?? [];
  assert.equal(wiresAfterMove[0].waypoints[0].x, 2.73);
  assert.equal(wiresAfterMove[0].waypoints[0].y, 4.18);
  assert.equal(wiresAfterMove[0].waypoints[0].z, 2.65);

  const reshapedBreakdown = computeWireLengthBreakdown(wiresAfterMove[0], proj);
  assert.notEqual(
    Number(reshapedBreakdown.totalM.toFixed(2)),
    Number(initialBreakdown.totalM.toFixed(2)),
    'Reshaping waypoints must dynamically recalculate cable length'
  );

  // Delete an intermediate point while preserving endpoint connections
  proj = deleteWireWaypointFromProject(proj, wire.id, 1);
  const wiresAfterDelWp = proj.wires ?? [];
  assert.equal(wiresAfterDelWp[0].waypoints.length, 1);
  assert.equal(wiresAfterDelWp[0].fromPointId, sb.point.id);
  assert.equal(wiresAfterDelWp[0].toPointId, fan.point.id);

  // Edit cable specifications without redrawing route geometry
  const editedWire = {
    ...wiresAfterDelWp[0],
    cableSizeSqMm: 3,
    brand: 'Havells',
    manufacturer: 'Havells',
    specification: 'IS 694 FRLS-H 1100V',
  };
  proj = { ...proj, wires: [editedWire] };
  assert.deepEqual(proj.wires?.[0].waypoints, [{ x: 2.73, y: 4.18, z: 2.65 }]);

  // Verify 3D synchronization via buildArchitecturalScene
  const textures = createMockTextureSet();
  const built = buildArchitecturalScene(
    proj,
    textures,
    null,
    'daylight',
    true,
    false,
    1,
    'active-only'
  );
  let foundWireMesh = false;
  built.root.traverse((obj: THREE.Object3D) => {
    if (obj.userData?.wireId === editedWire.id) {
      foundWireMesh = true;
    }
  });
  built.dispose();
  textures.dispose();
  assert.equal(foundWireMesh, true, '3D scene must render the synchronized free-style wire geometry');

  // Verify BOQ & Wire Consumption Summary sync
  const summary = computeWireConsumptionSummary(proj);
  assert.ok(summary.overallInstalledLengthM != null && summary.overallInstalledLengthM > 0);
  const matchingGroup = summary.rows.find(
    (g) => g.cableSizeSqMm === 3 && g.wireType.toLowerCase().includes('phase')
  );
  assert.ok(matchingGroup, 'BOQ Wire Consumption Summary must include edited 3 sq.mm Phase cable');
  assert.ok(matchingGroup.installedLengthM != null && matchingGroup.installedLengthM > 0);
  const boq = computeReconciledBoq(proj);
  assert.ok(boq.totalCableLengthM > 0, 'BOQ cable schedule must reflect the routed wire length');

  // Verify Project Storage round-trip (.bluespace JSON export/import)
  const serialized = projectStorage.exportNativeBluespace(proj);
  const restored = projectStorage.parseImportedJson(serialized);
  assert.ok(restored);
  const restoredWire = (restored.wires ?? []).find((w) => w.id === editedWire.id);
  assert.ok(restoredWire);
  assert.equal(restoredWire.cableSizeSqMm, 3);
  assert.equal(restoredWire.brand, 'Havells');
  assert.equal(restoredWire.routingMode, 'freeform');
  assert.deepEqual(restoredWire.waypoints, [{ x: 2.73, y: 4.18, z: 2.65 }]);

  // Verify route deletion
  const afterDelete = deleteEntitiesFromProject(proj, [{ kind: 'wire', id: editedWire.id }]);
  assert.equal((afterDelete.project.wires ?? []).length, 0);
  assert.equal(
    afterDelete.project.points.length,
    2,
    'Deleting a cable route must not delete connected devices'
  );
});

test('Engineering cable-sizing advisory warns on overload, voltage drop, protection, and never certifies safety automatically', () => {
  // Undersized 1 sq.mm copper on a heavy 3500W AC load over 35m in concealed conduit
  const overloadAssessment = evaluateCableSizingEngineering({
    cableSizeSqMm: 1,
    cableMaterial: 'Copper',
    category: 'phase',
    circuit: 'CKT-P2 (Power 16A)',
    loadWatts: 3500,
    routeLengthM: 35,
    installationCondition: 'concealed-conduit',
  });

  assert.ok(
    overloadAssessment.warnings.some(
      (w) => w.code === 'overload-ampacity' && w.severity === 'error'
    ),
    'Must flag error ampacity overload for 1 sq.mm on 3500W load'
  );
  assert.ok(
    overloadAssessment.warnings.some((w) => w.code === 'voltage-drop'),
    'Must flag excessive voltage drop over 35m run'
  );
  assert.ok(
    overloadAssessment.warnings.some((w) => w.code === 'circuit-range'),
    'Must flag circuit sizing mismatch for 16A power circuit'
  );
  assert.ok(
    overloadAssessment.warnings.some((w) => w.code === 'protection-coordination'),
    'Must provide MCB/breaker protection coordination advisory'
  );
  assert.match(
    overloadAssessment.disclaimer,
    /NOT automatic safety certification/i,
    'Must explicitly state selection is NOT automatic safety certification'
  );

  // Appropriate 2.5 sq.mm copper for a modest 1000W socket over 8m still includes protection & non-certification disclaimer
  const normalAssessment = evaluateCableSizingEngineering({
    cableSizeSqMm: 2.5,
    cableMaterial: 'Copper',
    category: 'phase',
    circuit: 'CKT-P2 (Power 16A)',
    loadWatts: 1000,
    routeLengthM: 8,
    installationCondition: 'surface-conduit',
  });
  assert.equal(
    normalAssessment.warnings.some((w) => w.code === 'overload-ampacity'),
    false,
    '2.5 sq.mm copper on 1000W should not trigger ampacity overload'
  );
  assert.ok(
    normalAssessment.recommendedMaxBreakerA != null && normalAssessment.recommendedMaxBreakerA > 0
  );
  assert.match(normalAssessment.disclaimer, /NOT automatic safety certification/i);
});

test('AutoCAD LINE/POLYLINE workflow: free-angle multi-segment placement, exact segment sum, Enter & double-click finish', () => {
  let proj = buildWireTestProject();
  const db = placeElectricalPointInRoom(proj, 'distribution_board', 'rm-living', 1.0, 1.0);
  assert.ok(db);
  proj = db.project;
  const fan = placeElectricalPointInRoom(proj, 'ceiling_fan', 'rm-living', 7.0, 5.0);
  assert.ok(fan);
  proj = fan.project;

  // 1. Clicking near an electrical point snaps cleanly onto it
  const snappedStart = resolvePolylineStartPoint({ x: 1.15, y: 1.1 }, proj.points);
  assert.ok(snappedStart);
  assert.equal(snappedStart.snappedToComponent, true);
  assert.equal(snappedStart.fromPoint.id, db.point.id);
  assert.equal(snappedStart.initialWaypoints.length, 0);

  // 2. Clicking open 2D canvas connects start to nearest component AND preserves exact clicked canvas point
  const openStart = resolvePolylineStartPoint({ x: 2.5, y: 2.2 }, proj.points);
  assert.ok(openStart);
  assert.equal(openStart.snappedToComponent, false);
  assert.equal(openStart.fromPoint.id, db.point.id);
  assert.deepEqual(openStart.initialWaypoints, [{ x: 2.5, y: 2.2 }]);

  // 3. Place connected arbitrary-angle intermediate vertices (zero H/V locking)
  let wps = snappedStart.initialWaypoints;
  wps = appendPolylineVertex(wps, db.point, { x: 2.4, y: 2.7 });
  wps = appendPolylineVertex(wps, db.point, { x: 4.8, y: 1.6 });
  wps = appendPolylineVertex(wps, db.point, { x: 5.9, y: 4.2 });
  // Duplicate click at same point is ignored
  wps = appendPolylineVertex(wps, db.point, { x: 5.91, y: 4.21 });
  assert.equal(wps.length, 3);

  // 4. Verify live segment metrics = exact sum of all connected segments & non-orthogonal angle
  const allNodes = [
    { x: db.point.x, y: db.point.y },
    ...wps,
    { x: fan.point.x, y: fan.point.y },
  ];
  const metrics = computePolylineSegmentMetrics(allNodes);
  assert.equal(metrics.segmentLengthsM.length, 4);
  const expectedSum =
    Math.hypot(2.4 - 1.0, 2.7 - 1.0) +
    Math.hypot(4.8 - 2.4, 1.6 - 2.7) +
    Math.hypot(5.9 - 4.8, 4.2 - 1.6) +
    Math.hypot(7.0 - 5.9, 5.0 - 4.2);
  assert.ok(Math.abs(metrics.totalLengthM - expectedSum) < 0.001);
  assert.ok(
    metrics.lastSegmentAngleDeg % 90 !== 0,
    'Angle must reflect true free-angle segment rather than forced 90° snap'
  );

  // 5. Double-click finish removes duplicate trailing click vertex and preserves all earlier vertices
  const withDblClickDup = [...wps, { x: 5.92, y: 4.22 }];
  const finalizedDbl = finalizePolylineWaypoints(withDblClickDup, fan.point, true);
  assert.equal(finalizedDbl.length, 3);

  // 6. Enter finish trims trailing vertex ONLY if sitting directly on target component
  const finalizedEnter = finalizePolylineWaypoints(
    [...wps, { x: fan.point.x - 0.05, y: fan.point.y + 0.05 }],
    fan.point,
    false
  );
  assert.equal(finalizedEnter.length, 3);

  // 7. Saved polyline route matches exact horizontal segment sum and keeps endpoints anchored
  const polyWire = createElectricalWire({
    project: proj,
    fromPoint: db.point,
    toPoint: fan.point,
    waypoints: finalizedEnter,
    category: 'phase',
    circuit: 'CKT-L1 (Lighting)',
    cableSizeSqMm: 1.5,
    routingMode: 'freeform',
  });
  const savedProj: ProjectData = { ...proj, wires: [polyWire] };
  const breakdown = computeWireLengthBreakdown(polyWire, savedProj);
  assert.ok(
    Math.abs(breakdown.horizontalM - expectedSum) < 0.05,
    `Saved polyline horizontal length ${breakdown.horizontalM}m should match sum of connected segments ${expectedSum.toFixed(2)}m`
  );
});

