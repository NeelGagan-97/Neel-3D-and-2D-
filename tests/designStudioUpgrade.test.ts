import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_PROJECTS } from '../src/data/presets';
import { extractMergedWalls, isWallHiddenInProject } from '../src/utils/geometry';
import {
  addWireWaypointToProject,
  applyWallCutawayPreset,
  countHiddenWallsOnFloor,
  deleteWireWaypointFromProject,
  materializeWallForEdit,
  moveWireWaypointInProject,
  placeElectricalPointInRoom,
  removeWallFromProject,
  restoreAllHiddenWallsInProject,
  toggleWallVisibilityInProject,
  updateCustomWallEndpoints,
  updateWireRoutingModeInProject,
} from '../src/utils/studioEditor';
import {
  buildSmoothSvgPath,
  computeReconciledBoq,
  computeWireConsumptionSummary,
  computeWireLengthBreakdown,
  createElectricalWire,
  sampleCurvedPath3D,
} from '../src/utils/buildingWiring';
import { buildFloorCollisionObstacles } from '../src/three/fpsCollision';
import { ProjectData } from '../src/types/design';

function buildFixtureProject(): ProjectData {
  const base = JSON.parse(JSON.stringify(INITIAL_PROJECTS[0])) as ProjectData;
  base.name = 'Design Studio Upgrade Fixture';
  // Ensure deterministic 2 rooms on floor 1: Kitchen + Master Bedroom
  const kitchen = {
    id: 'rm-kitchen',
    name: 'Kitchen',
    type: 'kitchen' as const,
    floor: 1,
    x: 0.5,
    y: 0.5,
    width: 4.0,
    height: 3.5,
    wallThickness: 0.15,
    rotation: 0,
    floorFinish: 'tile' as const,
  };
  const bedroom = {
    id: 'rm-bedroom',
    name: 'Master Bedroom',
    type: 'bedroom' as const,
    floor: 1,
    x: 5.0,
    y: 0.5,
    width: 4.5,
    height: 4.0,
    wallThickness: 0.15,
    rotation: 0,
    floorFinish: 'wood' as const,
  };
  return {
    ...base,
    site: {
      length: 12,
      width: 10,
      ceilingHeight: 3.0,
      wallThickness: 0.23,
      units: 'm',
      floors: 1,
    },
    rooms: [kitchen, bedroom],
    customWalls: [
      {
        id: 'cw-partition-1',
        floor: 1,
        x1: 4.7,
        y1: 0.5,
        x2: 4.7,
        y2: 4.0,
        thickness: 0.15,
        wallKind: 'internal',
      },
    ],
    points: [],
    wires: [],
    openings: [],
    furniture: [],
    hiddenWallIds: [],
  };
}

// ============================================================================
// 1. WALL EDITING & CROSS-SECTION / CUTAWAY VIEW
// ============================================================================

test('Wall cutaway hide/restore preserves rooms, electrical points, and wires while syncing 2D/3D & FPS collision', () => {
  let proj = buildFixtureProject();
  const placed1 = placeElectricalPointInRoom(proj, 'switchboard', 'rm-kitchen', 1.2, 1.0);
  assert.ok(placed1);
  proj = placed1.project;
  const placed2 = placeElectricalPointInRoom(proj, 'refrigerator', 'rm-kitchen', 3.5, 2.8);
  assert.ok(placed2);
  proj = placed2.project;

  const wire = createElectricalWire({
    project: proj,
    fromPoint: placed1.point,
    toPoint: placed2.point,
    waypoints: [{ x: 3.5, y: 1.0 }],
    category: 'phase',
    circuit: 'CKT-P1 (Kitchen)',
    cableSizeSqMm: 2.5,
  });
  proj = { ...proj, wires: [wire] };

  const visibleBefore = extractMergedWalls(proj, { floor: 1 });
  const fpsObstaclesBefore = buildFloorCollisionObstacles(proj, 1);

  // Hide front exterior wall 'ext-s'
  const toggled = toggleWallVisibilityInProject(proj, 1, 'ext-s');
  assert.equal(toggled.hidden, true);
  proj = toggled.project;

  assert.equal(isWallHiddenInProject(proj, 1, 'ext-s'), true);
  assert.equal(countHiddenWallsOnFloor(proj, 1), 1);

  // Visible walls (used by 3D & FPS collision) must exclude hidden wall
  const visibleAfter = extractMergedWalls(proj, { floor: 1 });
  assert.equal(visibleAfter.some((w) => w.id === 'ext-s'), false);
  assert.equal(visibleAfter.length, visibleBefore.length - 1);

  // includeHidden (used by 2D restore dashed ghost) must still expose it marked isHidden
  const allWithHidden = extractMergedWalls(proj, { floor: 1, includeHidden: true });
  const extS = allWithHidden.find((w) => w.id === 'ext-s');
  assert.ok(extS);
  assert.equal(extS.isHidden, true);

  // FPS collision obstacles shrink when wall is hidden
  const fpsObstaclesAfter = buildFloorCollisionObstacles(proj, 1);
  assert.ok(fpsObstaclesAfter.length < fpsObstaclesBefore.length);

  // Rooms, electrical points, and wiring MUST remain completely untouched
  assert.equal(proj.rooms.length, 2);
  assert.equal(proj.points.length, 2);
  assert.equal(proj.wires?.length, 1);

  // Restore all hidden walls
  const restored = restoreAllHiddenWallsInProject(proj, 1);
  assert.equal(restored.restoredCount, 1);
  assert.equal(countHiddenWallsOnFloor(restored.project, 1), 0);
  assert.equal(extractMergedWalls(restored.project, { floor: 1 }).length, visibleBefore.length);
});

test('Cutaway presets (front, south-east, exterior, restore) and individual wall materialization/editing work cleanly', () => {
  let proj = buildFixtureProject();

  proj = applyWallCutawayPreset(proj, 1, 'south-east');
  assert.equal(isWallHiddenInProject(proj, 1, 'ext-s'), true);
  assert.equal(isWallHiddenInProject(proj, 1, 'ext-e'), true);
  assert.equal(isWallHiddenInProject(proj, 1, 'ext-n'), false);

  proj = applyWallCutawayPreset(proj, 1, 'exterior');
  assert.equal(isWallHiddenInProject(proj, 1, 'ext-n'), true);
  assert.equal(isWallHiddenInProject(proj, 1, 'ext-w'), true);

  proj = applyWallCutawayPreset(proj, 1, 'restore');
  assert.equal(countHiddenWallsOnFloor(proj, 1), 0);

  // Materialize an auto room wall for endpoint editing
  const roomWall = extractMergedWalls(proj, { floor: 1 }).find((w) => w.source === 'room');
  assert.ok(roomWall);
  const mat = materializeWallForEdit(proj, 1, roomWall);
  proj = mat.project;
  assert.equal(isWallHiddenInProject(proj, 1, roomWall.id), true);

  const edited = updateCustomWallEndpoints(proj, mat.customWallId, {
    x2: roomWall.x2 + 0.5,
    thickness: 0.2,
  });
  const cw = edited.customWalls.find((w) => w.id === mat.customWallId);
  assert.ok(cw);
  assert.equal(cw.x2, Number((roomWall.x2 + 0.5).toFixed(3)));
  assert.equal(cw.thickness, 0.2);

  // Removing a custom wall deletes it; removing an auto wall hides it without deleting rooms
  const remCustom = removeWallFromProject(edited, 1, 'cw-partition-1');
  assert.equal(remCustom.mode, 'deleted-custom');
  assert.equal(remCustom.project.customWalls.some((w) => w.id === 'cw-partition-1'), false);

  const remAuto = removeWallFromProject(remCustom.project, 1, 'ext-n');
  assert.equal(remAuto.mode, 'removed-auto');
  assert.equal(isWallHiddenInProject(remAuto.project, 1, 'ext-n'), true);
  assert.equal(remAuto.project.rooms.length, 2);
});

// ============================================================================
// 2. ROOM-LEVEL ELECTRICAL DESIGN
// ============================================================================

test('Room-level electrical placement saves exact position, rotation, height, and roomId across independent rooms', () => {
  let proj = buildFixtureProject();

  // Place refrigerator & 16A socket in Kitchen (with out-of-bounds test for clamping)
  const fridgeRes = placeElectricalPointInRoom(proj, 'refrigerator', 'rm-kitchen', 99, -5, {
    rotation: 90,
    z: 0.95,
  });
  assert.ok(fridgeRes);
  proj = fridgeRes.project;
  assert.equal(fridgeRes.point.roomId, 'rm-kitchen');
  assert.equal(fridgeRes.point.itemType, 'refrigerator');
  assert.equal(fridgeRes.point.rotation, 90);
  assert.equal(fridgeRes.point.z, 0.95);
  // Clamped strictly inside Kitchen bounds [0.5, 4.5] x [0.5, 4.0]
  assert.ok(fridgeRes.point.x >= 0.5 && fridgeRes.point.x <= 4.5);
  assert.ok(fridgeRes.point.y >= 0.5 && fridgeRes.point.y <= 4.0);

  // Switch independently to Master Bedroom and place AC + Ceiling Fan
  const acRes = placeElectricalPointInRoom(proj, 'split_ac', 'rm-bedroom', 7.2, 1.0, {
    rotation: 180,
    z: 2.35,
  });
  assert.ok(acRes);
  proj = acRes.project;
  const fanRes = placeElectricalPointInRoom(proj, 'ceiling_fan', 'rm-bedroom', 7.25, 2.5, {
    rotation: 0,
    z: 2.8,
  });
  assert.ok(fanRes);
  proj = fanRes.project;

  assert.equal(acRes.point.roomId, 'rm-bedroom');
  assert.equal(fanRes.point.roomId, 'rm-bedroom');
  assert.equal(acRes.point.z, 2.35);
  assert.equal(fanRes.point.z, 2.8);

  const kitchenPoints = proj.points.filter((p) => p.roomId === 'rm-kitchen');
  const bedroomPoints = proj.points.filter((p) => p.roomId === 'rm-bedroom');
  assert.equal(kitchenPoints.length, 1);
  assert.equal(bedroomPoints.length, 2);
});

// ============================================================================
// 3. FLEXIBLE CABLE ROUTING & LIVE LENGTH / BOQ SYNCHRONIZATION
// ============================================================================

test('Flexible cable routing supports cable metadata, P/N/E colors, 3D X/Y/Z waypoints, curved arcs, and BOQ sync', () => {
  let proj = buildFixtureProject();
  const sb = placeElectricalPointInRoom(proj, 'switchboard', 'rm-kitchen', 1.0, 1.0, { z: 1.35 });
  assert.ok(sb);
  proj = sb.project;
  const fridge = placeElectricalPointInRoom(proj, 'refrigerator', 'rm-kitchen', 4.0, 3.0, { z: 0.9 });
  assert.ok(fridge);
  proj = fridge.project;

  // Create Phase (Red), Neutral (Blue), Earth (Green) multi-point wires with brand/type/size/spec
  const phaseWire = createElectricalWire({
    project: proj,
    fromPoint: sb.point,
    toPoint: fridge.point,
    waypoints: [
      { x: 1.0, y: 3.0, z: 2.4 },
      { x: 2.5, y: 3.0, z: 2.4 },
    ],
    category: 'phase',
    circuit: 'CKT-P1 (Kitchen)',
    cableSizeSqMm: 2.5,
    cableMaterial: 'Copper',
    routingMode: 'orthogonal',
    wireType: 'FR-LSH Copper',
    brand: 'Polycab',
    manufacturer: 'Polycab',
    specification: 'IS 694 1100V',
  });
  const neutralWire = createElectricalWire({
    project: proj,
    fromPoint: sb.point,
    toPoint: fridge.point,
    waypoints: [{ x: 1.0, y: 3.0, z: 2.4 }],
    category: 'neutral',
    circuit: 'CKT-P1 (Kitchen)',
    cableSizeSqMm: 2.5,
    routingMode: 'freeform',
  });
  const earthWire = createElectricalWire({
    project: proj,
    fromPoint: sb.point,
    toPoint: fridge.point,
    waypoints: [{ x: 1.0, y: 3.0, z: 2.4 }],
    category: 'earth',
    circuit: 'CKT-P1 (Kitchen)',
    cableSizeSqMm: 1.5,
    routingMode: 'curved',
  });

  // Verify Phase (Red), Neutral (Blue), Earth (Green) colors + metadata
  assert.equal(phaseWire.color.toUpperCase(), '#EF4444');
  assert.equal(neutralWire.color.toUpperCase(), '#3B82F6');
  assert.equal(earthWire.color.toUpperCase(), '#22C55E');
  assert.equal(phaseWire.brand, 'Polycab');
  assert.equal(phaseWire.wireType, 'FR-LSH Copper');
  assert.equal(phaseWire.specification, 'IS 694 1100V');
  assert.equal(phaseWire.routingMode, 'orthogonal');
  assert.equal(earthWire.routingMode, 'curved');

  proj = { ...proj, wires: [phaseWire, neutralWire, earthWire] };

  // Measure initial 3D breakdown (includes horizontal + Z-elevation changes)
  const initialBreakdown = computeWireLengthBreakdown(phaseWire, proj);
  assert.ok(initialBreakdown.baseRouteM > 5.0);
  assert.ok(initialBreakdown.verticalDropsM > 1.5); // climbs 1.35 -> 2.4 and drops 2.4 -> 0.9

  // Move waypoint #0 in X, Y, and Z — endpoints MUST stay connected, length MUST increase
  const movedProj = moveWireWaypointInProject(proj, phaseWire.id, 0, {
    x: 1.0,
    y: 3.5,
    z: 2.8,
  });
  const movedWire = movedProj.wires!.find((w) => w.id === phaseWire.id)!;
  assert.equal(movedWire.fromPointId, sb.point.id);
  assert.equal(movedWire.toPointId, fridge.point.id);
  assert.equal(movedWire.waypoints[0].z, 2.8);

  const movedBreakdown = computeWireLengthBreakdown(movedWire, movedProj);
  assert.ok(movedBreakdown.baseRouteM > initialBreakdown.baseRouteM);

  // Add & delete waypoint cleanly
  const withAdded = addWireWaypointToProject(movedProj, phaseWire.id, 1, { x: 1.8, y: 3.5, z: 2.8 });
  assert.equal(withAdded.wires!.find((w) => w.id === phaseWire.id)!.waypoints.length, 3);
  const afterDeleted = deleteWireWaypointFromProject(withAdded, phaseWire.id, 1);
  assert.equal(afterDeleted.wires!.find((w) => w.id === phaseWire.id)!.waypoints.length, 2);

  // Switch routing mode to curved and verify smooth spline sampling & SVG path generation
  const curvedProj = updateWireRoutingModeInProject(afterDeleted, phaseWire.id, 'curved');
  const curvedWire = curvedProj.wires!.find((w) => w.id === phaseWire.id)!;
  assert.equal(curvedWire.routingMode, 'curved');
  const sampled = sampleCurvedPath3D(
    [
      { x: sb.point.x, y: sb.point.y, z: sb.point.z },
      { x: 1.0, y: 3.5, z: 2.8 },
      { x: 2.5, y: 3.0, z: 2.4 },
      { x: fridge.point.x, y: fridge.point.y, z: fridge.point.z },
    ],
    8
  );
  assert.ok(sampled.length > 10);
  const svgD = buildSmoothSvgPath([
    { x: 10, y: 10 },
    { x: 50, y: 10 },
    { x: 80, y: 60 },
  ]);
  assert.ok(svgD.startsWith('M ') && svgD.includes('C '));

  // Verify synchronization with Wire Consumption Summary & BOQ
  const summaryBefore = computeWireConsumptionSummary(proj);
  const summaryAfter = computeWireConsumptionSummary(movedProj);
  assert.ok(summaryBefore.overallInstalledLengthM !== null);
  assert.ok(summaryAfter.overallInstalledLengthM !== null);
  assert.ok(summaryBefore.overallInstalledLengthM > 0);
  assert.ok(summaryAfter.overallInstalledLengthM > summaryBefore.overallInstalledLengthM);

  const boq = computeReconciledBoq(movedProj);
  const cableRows = boq.rows.filter((r) => r.kind === 'cable');
  assert.ok(cableRows.length > 0);
  // Refrigerator must also appear in BOQ
  const fridgeBoqRow = boq.rows.find((r) => r.productName.toLowerCase().includes('refrigerator'));
  assert.ok(fridgeBoqRow);
  assert.equal(fridgeBoqRow.quantity, 1);
});
