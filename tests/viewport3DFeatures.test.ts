import assert from 'node:assert/strict';
import * as THREE from 'three';
import { INITIAL_PROJECTS } from '../src/data/presets';
import {
  applyElectricalVisibilityToScene,
  buildArchitecturalScene,
  classifyElectricalSymbolGroup,
  DEFAULT_ELECTRICAL_VISIBILITY,
  isElectricalPointVisible,
  toggleElectricalVisibilityGroup,
  toggleMasterElectricalVisibility,
} from '../src/three/architecturalBuilder';
import {
  buildFloorCollisionObstacles,
  computeInitialFpsSpawn,
  FPS_EYE_HEIGHT_M,
  FPS_PLAYER_RADIUS_M,
  isPointCollidingWithObstacles,
  normalizeHorizontalMoveInput,
  resolveFpsMovementWithCollisions,
} from '../src/three/fpsCollision';
import { ArchitecturalTextureSet } from '../src/three/proceduralTextures';
import { ElectricalItemType } from '../src/types/design';
import { createElectricalWire } from '../src/utils/buildingWiring';
import {
  cloneProject,
  resolve3DWalkCommand,
  resolve3DWalkDirection,
  resolve3DWalkDirectionFromCode,
} from '../src/utils/studioEditor';

interface TestCase {
  name: string;
  run: () => void;
}

const tests: TestCase[] = [];
function test(name: string, run: () => void) {
  tests.push({ name, run });
}

function createStubTextures(): ArchitecturalTextureSet {
  const mk = () =>
    new THREE.DataTexture(
      new Uint8Array([200, 200, 200, 255]),
      1,
      1
    ) as unknown as THREE.CanvasTexture;
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

function isEffectiveVisible(obj: THREE.Object3D): boolean {
  let curr: THREE.Object3D | null = obj;
  while (curr) {
    if (!curr.visible) return false;
    curr = curr.parent;
  }
  return true;
}

test('1. All 17 ElectricalItemType values map cleanly into the 7 electrical symbol groups', () => {
  const expected: Record<ElectricalItemType, ReturnType<typeof classifyElectricalSymbolGroup>> = {
    ceiling_fan: 'fans',
    exhaust_fan: 'fans',
    split_ac: 'acs',
    switchboard: 'switchboards',
    switch: 'switchboards',
    panel_light: 'panels',
    distribution_board: 'panels',
    socket_5a: 'sockets',
    socket_16a: 'sockets',
    usb_outlet: 'sockets',
    geyser: 'geysers',
    led_light: 'other',
    spotlight: 'other',
    strip_light: 'other',
    chandelier: 'other',
    appliance: 'other',
    refrigerator: 'other',
    earthing_point: 'other',
  };

  (Object.keys(expected) as ElectricalItemType[]).forEach((itemType) => {
    assert.equal(classifyElectricalSymbolGroup(itemType), expected[itemType]);
  });
});

test('2. Group-based electrical visibility hides ONLY annotations, icons/labels, and wiring overlays — NEVER physical 3D products or building geometry', () => {
  const project = cloneProject(INITIAL_PROJECTS[0]);
  const pointA = project.points.find((p) => p.itemType === 'switchboard') ?? project.points[0];
  const pointB = project.points.find((p) => p.itemType === 'ceiling_fan') ?? project.points[1];
  assert.ok(pointA && pointB, 'Demo project must contain points to wire');

  const testWire = createElectricalWire({
    project,
    fromPoint: pointA,
    toPoint: pointB,
    category: 'phase',
  });
  const testProject = {
    ...project,
    wires: [...(project.wires ?? []), testWire],
  };

  const originalPointsSnapshot = JSON.stringify(testProject.points);
  const originalWiresSnapshot = JSON.stringify(testProject.wires);

  const textures = createStubTextures();
  const built = buildArchitecturalScene(
    testProject,
    textures,
    pointB.id, // select a ceiling fan so selection annotation rings exist in electricalAnnotations.symbols.fans
    'daylight',
    true,
    true,
    1,
    'all'
  );

  try {
    assert.ok(built.physicalProducts.length > 0, 'Scene must contain physical 3D electrical products');
    assert.ok(
      built.electricalAnnotations.symbols.fans.children.length > 0,
      'Selected ceiling fan should place its annotation overlay in electricalAnnotations.symbols.fans'
    );
    assert.ok(
      built.electricalAnnotations.wiring.children.length > 0,
      '3D electrical wiring overlay group should contain wire visualization meshes'
    );

    // Disable Fan Symbols: fan icon/label & fan annotation overlay hide, physical 3D ceiling fan stays visible!
    let vis = toggleElectricalVisibilityGroup(DEFAULT_ELECTRICAL_VISIBILITY, 'fans');
    applyElectricalVisibilityToScene(built, vis);
    assert.equal(isElectricalPointVisible('ceiling_fan', vis), false);
    assert.equal(isElectricalPointVisible('split_ac', vis), true);
    assert.equal(built.electricalAnnotations.symbols.fans.visible, false);
    assert.equal(built.electricalAnnotations.wiring.visible, true);
    assert.ok(
      built.physicalProducts.every((p) => isEffectiveVisible(p)),
      'ALL physical 3D products (including ceiling fans) must remain visible when Fan Symbols is OFF'
    );

    // Disable AC, Switchboard, Panel, Socket, Geyser, Other, and Wiring overlays
    vis = toggleElectricalVisibilityGroup(vis, 'acs');
    vis = toggleElectricalVisibilityGroup(vis, 'switchboards');
    vis = toggleElectricalVisibilityGroup(vis, 'panels');
    vis = toggleElectricalVisibilityGroup(vis, 'sockets');
    vis = toggleElectricalVisibilityGroup(vis, 'geysers');
    vis = toggleElectricalVisibilityGroup(vis, 'other');
    vis = toggleElectricalVisibilityGroup(vis, 'wiring');
    applyElectricalVisibilityToScene(built, vis);

    assert.equal(isElectricalPointVisible('split_ac', vis), false);
    assert.equal(isElectricalPointVisible('switchboard', vis), false);
    assert.equal(isElectricalPointVisible('panel_light', vis), false);
    assert.equal(isElectricalPointVisible('distribution_board', vis), false);
    assert.equal(isElectricalPointVisible('socket_5a', vis), false);
    assert.equal(isElectricalPointVisible('socket_16a', vis), false);
    assert.equal(isElectricalPointVisible('geyser', vis), false);
    assert.equal(isElectricalPointVisible('led_light', vis), false);
    assert.equal(built.electricalAnnotations.wiring.visible, false);
    assert.ok(
      built.physicalProducts.every((p) => isEffectiveVisible(p)),
      'ALL physical 3D appliances & fixtures must remain visible even when every symbol & wiring group is OFF'
    );

    // Project electrical data (positions, IDs, wires, properties) must be 100% preserved
    assert.equal(JSON.stringify(testProject.points), originalPointsSnapshot);
    assert.equal(JSON.stringify(testProject.wires), originalWiresSnapshot);
  } finally {
    applyElectricalVisibilityToScene(
      built,
      toggleMasterElectricalVisibility(DEFAULT_ELECTRICAL_VISIBILITY, false)
    );
    built.dispose();
    textures.dispose();
    assert.equal(built.resourceStats.disposed, true);
    assert.equal(
      built.resourceStats.disposedGeometries,
      built.resourceStats.trackedGeometries,
      'All tracked geometries must dispose cleanly'
    );
    assert.equal(
      built.resourceStats.disposedMaterials,
      built.resourceStats.trackedMaterials,
      'All tracked materials must dispose cleanly'
    );
  }
});

test('3. Master Electrical Symbols toggle hides/shows all overlays while preserving individual group visibility states', () => {
  let vis = DEFAULT_ELECTRICAL_VISIBILITY;
  // User disables Fan Symbols, Socket Symbols, and Electrical Wiring individually
  vis = toggleElectricalVisibilityGroup(vis, 'fans');
  vis = toggleElectricalVisibilityGroup(vis, 'sockets');
  vis = toggleElectricalVisibilityGroup(vis, 'wiring');

  assert.equal(vis.all, true);
  assert.equal(vis.fans, false);
  assert.equal(vis.acs, true);
  assert.equal(vis.switchboards, true);
  assert.equal(vis.panels, true);
  assert.equal(vis.sockets, false);
  assert.equal(vis.geysers, true);
  assert.equal(vis.other, true);
  assert.equal(vis.wiring, false);

  // Turn Master OFF -> every symbol becomes effectively hidden, yet individual booleans stay preserved
  vis = toggleMasterElectricalVisibility(vis, false);
  assert.equal(vis.all, false);
  assert.equal(isElectricalPointVisible('split_ac', vis), false);
  assert.equal(isElectricalPointVisible('switchboard', vis), false);
  assert.equal(isElectricalPointVisible('geyser', vis), false);
  assert.equal(vis.fans, false);
  assert.equal(vis.acs, true);
  assert.equal(vis.sockets, false);
  assert.equal(vis.wiring, false);

  // Turn Master back ON -> individual states are restored identically!
  vis = toggleMasterElectricalVisibility(vis, true);
  assert.equal(vis.all, true);
  assert.equal(isElectricalPointVisible('ceiling_fan', vis), false);
  assert.equal(isElectricalPointVisible('split_ac', vis), true);
  assert.equal(isElectricalPointVisible('switchboard', vis), true);
  assert.equal(isElectricalPointVisible('panel_light', vis), true);
  assert.equal(isElectricalPointVisible('socket_16a', vis), false);
  assert.equal(isElectricalPointVisible('geyser', vis), true);
  assert.equal(isElectricalPointVisible('led_light', vis), true);
  assert.equal(vis.wiring, false);
});

test('4. First-Person Navigation enforces 1.65m eye height, straight-ahead pitch=0 spawn, normalized diagonal speed, and wall/obstacle collision with doorway traversal', () => {
  assert.equal(FPS_EYE_HEIGHT_M, 1.65, 'Eye height must be 1.65 metres');

  // Diagonal movement normalization
  const diag = normalizeHorizontalMoveInput({
    forward: true,
    backward: false,
    left: false,
    right: true,
  });
  assert.equal(diag.moving, true);
  assert.ok(
    Math.abs(Math.hypot(diag.forward, diag.right) - 1) < 1e-6,
    'Diagonal WASD movement must be normalized to unit speed (1.0, not sqrt(2))'
  );

  const cardinal = normalizeHorizontalMoveInput({
    forward: true,
    backward: false,
    left: false,
    right: false,
  });
  assert.equal(cardinal.forward, 1);
  assert.equal(cardinal.right, 0);

  // Spawn must be unobstructed and looking straight ahead (pitch = 0)
  const project = cloneProject(INITIAL_PROJECTS[0]);
  const obstacles = buildFloorCollisionObstacles(project, 1);
  assert.ok(obstacles.some((o) => o.kind === 'wall'), 'Floor must produce wall colliders');
  assert.ok(obstacles.some((o) => o.kind === 'furniture'), 'Floor must produce furniture colliders');

  const spawn = computeInitialFpsSpawn(project, 1, obstacles);
  assert.equal(spawn.pitch, 0, 'Initial FPS camera must look straight ahead (pitch === 0)');
  assert.equal(
    isPointCollidingWithObstacles(spawn.x, spawn.y, obstacles, FPS_PLAYER_RADIUS_M),
    false,
    'Initial FPS spawn point must not collide with any wall or furniture obstacle'
  );

  // Wall collision test: solid vertical wall at x = 5.0 (thickness 0.2m), player approaches from x = 4.0 -> cannot pass x = 5.0
  const wallBox = [
    {
      id: 'solid-wall',
      kind: 'wall' as const,
      cx: 5.0,
      cy: 4.0,
      hx: 0.1,
      hy: 3.0,
      theta: 0,
    },
  ];
  const blocked = resolveFpsMovementWithCollisions(4.0, 4.0, 2.5, 0, wallBox, FPS_PLAYER_RADIUS_M);
  assert.ok(
    blocked.x <= 5.0 - 0.1 - FPS_PLAYER_RADIUS_M + 0.01,
    `Player must be stopped before solid wall, got x=${blocked.x}`
  );

  // Diagonal slide test: moving diagonally into the solid wall blocks X penetration while smoothly sliding along Y
  const slid = resolveFpsMovementWithCollisions(4.5, 3.0, 1.5, 1.2, wallBox, FPS_PLAYER_RADIUS_M);
  assert.ok(slid.x <= 5.0 - 0.1 - FPS_PLAYER_RADIUS_M + 0.01, 'Wall must block X penetration');
  assert.ok(slid.y > 4.0, `Player should slide smoothly along wall in +Y, got y=${slid.y}`);

  // Doorway traversal test: wall with a 1.0m door gap centered at y = 4.0 allows walking straight through!
  const wallWithDoor = [
    { id: 'wall-top', kind: 'wall' as const, cx: 5.0, cy: 2.0, hx: 0.1, hy: 1.45, theta: 0 },
    { id: 'wall-bot', kind: 'wall' as const, cx: 5.0, cy: 6.0, hx: 0.1, hy: 1.45, theta: 0 },
  ];
  const walkedThrough = resolveFpsMovementWithCollisions(
    4.0,
    4.0,
    2.0,
    0,
    wallWithDoor,
    FPS_PLAYER_RADIUS_M
  );
  assert.ok(
    walkedThrough.x > 5.8,
    `Player should walk cleanly through open doorway, got x=${walkedThrough.x}`
  );

  // Keyboard mapping: E toggles FPS, WASD moves horizontally
  const base = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
  assert.equal(
    resolve3DWalkCommand({ ...base, key: 'e' }, { isEditable: false, viewMode: '3d' }),
    'toggle-3d-walk'
  );
  assert.equal(resolve3DWalkDirection({ ...base, key: 'w' }), 'forward');
  assert.equal(resolve3DWalkDirection({ ...base, key: 's' }), 'backward');
  assert.equal(resolve3DWalkDirection({ ...base, key: 'a' }), 'left');
  assert.equal(resolve3DWalkDirection({ ...base, key: 'd' }), 'right');
  assert.equal(resolve3DWalkDirectionFromCode('KeyW'), 'forward');
  assert.equal(resolve3DWalkDirectionFromCode('KeyS'), 'backward');
  assert.equal(resolve3DWalkDirectionFromCode('KeyA'), 'left');
  assert.equal(resolve3DWalkDirectionFromCode('KeyD'), 'right');
});

let passed = 0;
let failed = 0;

for (const tc of tests) {
  try {
    tc.run();
    passed += 1;
    console.log(`PASS  ${tc.name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${tc.name}`);
    console.error(err);
  }
}

console.log(`\nViewport 3D Feature Tests: ${passed}/${tests.length} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
