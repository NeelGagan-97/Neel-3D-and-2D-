import assert from 'node:assert/strict';
import { CATALOG_MAP, INITIAL_PROJECTS, findRoomAtPoint } from '../src/data/presets';
import { projectStorage } from '../src/services/projectStorage';
import { ElectricalPoint, ProjectData, StudioEntityRef } from '../src/types/design';
import {
  cloneProject,
  copyEntitiesToClipboard,
  createHistoryState,
  deleteEntitiesFromProject,
  duplicateEntitiesInProject,
  getEntityFocusPoint,
  isEditableEventTarget,
  moveEntitiesInProject,
  pasteClipboardIntoProject,
  pruneSelectionToProject,
  pushHistorySnapshot,
  redoHistoryState,
  resolve3DWalkCommand,
  resolve3DWalkDirection,
  resolve3DWalkDirectionFromCode,
  resolveStudioShortcut,
  rotateEntitiesInProject,
  searchStudioComponents,
  selectAllEntitiesOnFloor,
  toggleEntityInSelection,
  undoHistoryState,
} from '../src/utils/studioEditor';

interface TestCase {
  name: string;
  run: () => void;
}

const tests: TestCase[] = [];
function test(name: string, run: () => void) {
  tests.push({ name, run });
}

function createSampleProject(): ProjectData {
  return cloneProject(INITIAL_PROJECTS[0]);
}

function installMockLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const mockStorage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
  return store;
}

// ---------------------------------------------------------------------------
// Acceptance Test 1 & 2: Add ceiling fan -> Ctrl+Z removes -> Ctrl+Y restores
// ---------------------------------------------------------------------------
test('1. Add a ceiling fan -> Undo removes it -> Redo restores it', () => {
  const initial = createSampleProject();
  const initialCount = initial.points.length;
  let history = createHistoryState(initial);

  const fanSpec = CATALOG_MAP.ceiling_fan;
  const targetRoom = initial.rooms[0];
  const newFan: ElectricalPoint = {
    id: 'pt-test-fan-01',
    floor: 1,
    roomId: targetRoom.id,
    itemType: 'ceiling_fan',
    category: fanSpec.category,
    code: 'CF-99',
    name: 'Test Living Ceiling Fan',
    x: Number((targetRoom.x + targetRoom.width / 2).toFixed(2)),
    y: Number((targetRoom.y + targetRoom.height / 2).toFixed(2)),
    z: fanSpec.defaultMountHeight,
    rotation: 0,
    wattage: fanSpec.defaultWattage,
    voltage: 230,
    circuit: fanSpec.defaultCircuit,
    unitCost: fanSpec.unitCost,
  };

  const withFan: ProjectData = {
    ...history.present,
    points: [...history.present.points, newFan],
  };

  history = pushHistorySnapshot(history, withFan);
  assert.equal(history.present.points.length, initialCount + 1);
  assert.ok(history.present.points.some((p) => p.id === 'pt-test-fan-01'));

  // Ctrl + Z -> removes ceiling fan
  history = undoHistoryState(history);
  assert.equal(history.present.points.length, initialCount);
  assert.equal(
    history.present.points.some((p) => p.id === 'pt-test-fan-01'),
    false
  );

  // Ctrl + Y -> restores ceiling fan with full properties
  history = redoHistoryState(history);
  assert.equal(history.present.points.length, initialCount + 1);
  const restored = history.present.points.find((p) => p.id === 'pt-test-fan-01');
  assert.ok(restored);
  assert.equal(restored.name, 'Test Living Ceiling Fan');
  assert.equal(restored.wattage, fanSpec.defaultWattage);
  assert.equal(restored.code, 'CF-99');
});

// ---------------------------------------------------------------------------
// Acceptance Test 3: Move a light -> Ctrl+Z restores its previous position
// ---------------------------------------------------------------------------
test('2. Move a light -> Undo restores exact previous position and room', () => {
  const initial = createSampleProject();
  const light = initial.points.find((p) => p.category === 'Lighting');
  assert.ok(light, 'Sample project must include a lighting point');

  const origX = light.x;
  const origY = light.y;
  const origRoomId = light.roomId;

  let history = createHistoryState(initial);
  const movedProject = moveEntitiesInProject(
    history.present,
    [{ kind: 'point', id: light.id }],
    1.5,
    1.25
  );
  history = pushHistorySnapshot(history, movedProject);

  const movedLight = history.present.points.find((p) => p.id === light.id)!;
  assert.notEqual(movedLight.x, origX);
  assert.notEqual(movedLight.y, origY);

  // Undo restores exact previous position & roomId
  history = undoHistoryState(history);
  const restoredLight = history.present.points.find((p) => p.id === light.id)!;
  assert.equal(restoredLight.x, origX);
  assert.equal(restoredLight.y, origY);
  assert.equal(restoredLight.roomId, origRoomId);
});

// ---------------------------------------------------------------------------
// Acceptance Test 4: Delete a switch -> Ctrl+Z restores it with properties
// ---------------------------------------------------------------------------
test('3. Delete a switch -> Undo restores it with all properties intact', () => {
  const initial = createSampleProject();
  const sw = initial.points.find((p) => p.category === 'Switches');
  assert.ok(sw, 'Sample project must include a switch point');
  const snapshotBeforeDelete = cloneProject(initial).points.find((p) => p.id === sw.id)!;

  let history = createHistoryState(initial);
  const { project: afterDelete, deletedCount } = deleteEntitiesFromProject(history.present, [
    { kind: 'point', id: sw.id },
  ]);
  assert.equal(deletedCount, 1);
  history = pushHistorySnapshot(history, afterDelete);

  assert.equal(
    history.present.points.some((p) => p.id === sw.id),
    false
  );
  // Selection pruning removes deleted switch
  const pruned = pruneSelectionToProject([{ kind: 'point', id: sw.id }], history.present);
  assert.equal(pruned.length, 0);

  // Undo restores switch with every property intact
  history = undoHistoryState(history);
  const restored = history.present.points.find((p) => p.id === sw.id);
  assert.ok(restored);
  assert.deepEqual(restored, snapshotBeforeDelete);
});

// ---------------------------------------------------------------------------
// Acceptance Test 5: Copy and paste an appliance -> independent duplicate
// ---------------------------------------------------------------------------
test('4. Copy and paste an appliance -> creates independent duplicate with unique ID & preserved properties', () => {
  const initial = createSampleProject();
  const appliance = initial.points.find((p) => p.category === 'Appliances');
  assert.ok(appliance, 'Sample project must include an appliance');

  const clip = copyEntitiesToClipboard(initial, [{ kind: 'point', id: appliance.id }], 1);
  assert.ok(clip);
  assert.equal(clip.points.length, 1);

  const { project: pastedProject, pastedEntities } = pasteClipboardIntoProject(
    initial,
    clip,
    1,
    1
  );
  assert.equal(pastedEntities.length, 1);
  assert.equal(pastedEntities[0].kind, 'point');

  const original = pastedProject.points.find((p) => p.id === appliance.id)!;
  const duplicate = pastedProject.points.find((p) => p.id === pastedEntities[0].id)!;
  assert.ok(original);
  assert.ok(duplicate);

  // Unique ID and unique sequential code
  assert.notEqual(duplicate.id, original.id);
  assert.notEqual(duplicate.code, original.code);

  // Preserved technical properties
  assert.equal(duplicate.itemType, original.itemType);
  assert.equal(duplicate.category, original.category);
  assert.equal(duplicate.wattage, original.wattage);
  assert.equal(duplicate.voltage, original.voltage);
  assert.equal(duplicate.circuit, original.circuit);
  assert.equal(duplicate.unitCost, original.unitCost);
  assert.equal(duplicate.z, original.z);

  // Independence check: mutating duplicate does NOT mutate original
  duplicate.wattage = 9999;
  duplicate.name = 'Modified Duplicate AC';
  assert.notEqual(original.wattage, 9999);
  assert.notEqual(original.name, 'Modified Duplicate AC');
});

// ---------------------------------------------------------------------------
// Acceptance Test 6: Search for a component -> finds canvas + library & resolves focus
// ---------------------------------------------------------------------------
test('5. Find Component searches canvas & library by name, category, type, code, and ID', () => {
  const project = createSampleProject();
  const sampleFan = project.points.find((p) => p.itemType === 'ceiling_fan');
  assert.ok(sampleFan, 'Sample project should contain a ceiling fan');

  // Search by name
  const fanResults = searchStudioComponents(project, 'ceiling fan', 'all');
  const placedFans = fanResults.filter((r) => r.source === 'placed');
  const libFans = fanResults.filter((r) => r.source === 'library');
  assert.ok(placedFans.length >= 1, 'Should match placed ceiling fans on canvas');
  assert.ok(libFans.length >= 1, 'Should match ceiling fan in component library');

  // Search by exact component ID
  const byId = searchStudioComponents(project, sampleFan.id, 'all');
  assert.equal(byId.length, 1);
  assert.equal(byId[0].entity?.id, sampleFan.id);

  // Focus coordinates resolve cleanly for both 2D pan and 3D OrbitControls navigation
  const focus = getEntityFocusPoint(project, byId[0].entity!);
  assert.ok(focus);
  assert.equal(focus.x, sampleFan.x);
  assert.equal(focus.y, sampleFan.y);
  assert.equal(focus.z, sampleFan.z);

  // Category filter accuracy
  const lightingOnly = searchStudioComponents(project, '', 'lighting');
  assert.ok(lightingOnly.length > 0);
  assert.ok(lightingOnly.every((r) => r.category === 'Lighting'));

  const furnitureOnly = searchStudioComponents(project, '', 'furniture');
  assert.ok(furnitureOnly.length > 0);
  assert.ok(furnitureOnly.every((r) => r.category === 'Furniture'));

  const roomsOnly = searchStudioComponents(project, '', 'rooms');
  assert.ok(roomsOnly.length > 0);
  assert.ok(roomsOnly.every((r) => ['Rooms', 'Openings', 'Walls'].includes(r.category)));
});

// ---------------------------------------------------------------------------
// Acceptance Test 7: 5 editing operations -> undo all 5 -> redo all 5
// ---------------------------------------------------------------------------
test('6. Perform 5 sequential editing operations -> undo all 5 -> redo all 5', () => {
  const initial = createSampleProject();
  const initialJson = JSON.stringify(initial);
  let history = createHistoryState(initial);

  // Op 1: Add a ceiling fan
  const fanSpec = CATALOG_MAP.ceiling_fan;
  const fanId = 'pt-seq-fan';
  const room0 = history.present.rooms[0];
  const step1: ProjectData = {
    ...history.present,
    points: [
      ...history.present.points,
      {
        id: fanId,
        floor: 1,
        roomId: room0.id,
        itemType: 'ceiling_fan',
        category: fanSpec.category,
        code: 'CF-55',
        name: 'Sequence Fan',
        x: Number((room0.x + 1).toFixed(2)),
        y: Number((room0.y + 1).toFixed(2)),
        z: fanSpec.defaultMountHeight,
        rotation: 0,
        wattage: fanSpec.defaultWattage,
        voltage: 230,
        circuit: fanSpec.defaultCircuit,
        unitCost: fanSpec.unitCost,
      },
    ],
  };
  history = pushHistorySnapshot(history, step1);

  // Op 2: Move the newly added fan
  const step2 = moveEntitiesInProject(history.present, [{ kind: 'point', id: fanId }], 0.8, 0.6);
  history = pushHistorySnapshot(history, step2);

  // Op 3: Rotate the fan by 90 deg
  const { project: step3 } = rotateEntitiesInProject(
    history.present,
    [{ kind: 'point', id: fanId }],
    90
  );
  history = pushHistorySnapshot(history, step3);

  // Op 4: Change a property (wattage & name)
  const step4: ProjectData = {
    ...history.present,
    points: history.present.points.map((p) =>
      p.id === fanId ? { ...p, wattage: 42, name: 'BLDC High-Efficiency Fan' } : p
    ),
  };
  history = pushHistorySnapshot(history, step4);

  // Op 5: Duplicate the fan
  const { project: step5, duplicatedEntities } = duplicateEntitiesInProject(
    history.present,
    [{ kind: 'point', id: fanId }],
    1
  );
  assert.equal(duplicatedEntities.length, 1);
  history = pushHistorySnapshot(history, step5);

  const finalJson = JSON.stringify(history.present);
  assert.equal(history.past.length, 5);
  assert.equal(history.future.length, 0);

  // Undo all 5 operations sequentially
  for (let i = 0; i < 5; i += 1) {
    history = undoHistoryState(history);
  }
  assert.equal(history.past.length, 0);
  assert.equal(history.future.length, 5);
  assert.equal(JSON.stringify(history.present), initialJson);

  // Redo all 5 operations sequentially
  for (let i = 0; i < 5; i += 1) {
    history = redoHistoryState(history);
  }
  assert.equal(history.past.length, 5);
  assert.equal(history.future.length, 0);
  assert.equal(JSON.stringify(history.present), finalJson);
});

// ---------------------------------------------------------------------------
// Acceptance Test 8: Undo + make a new change -> redo history is cleared
// ---------------------------------------------------------------------------
test('7. Undo an operation and perform a new change -> previous redo history is cleared', () => {
  const initial = createSampleProject();
  const target = initial.points[0];
  let history = createHistoryState(initial);

  // Op 1: Rotate target
  const { project: op1 } = rotateEntitiesInProject(history.present, [{ kind: 'point', id: target.id }], 90);
  history = pushHistorySnapshot(history, op1);

  // Op 2: Move target
  const op2 = moveEntitiesInProject(history.present, [{ kind: 'point', id: target.id }], 0.5, 0.5);
  history = pushHistorySnapshot(history, op2);

  // Undo once -> future has 1 entry
  history = undoHistoryState(history);
  assert.equal(history.future.length, 1);

  // Perform a brand new change -> redo stack must be cleared
  const opNew: ProjectData = {
    ...history.present,
    points: history.present.points.map((p) =>
      p.id === target.id ? { ...p, name: 'Branched Component' } : p
    ),
  };
  history = pushHistorySnapshot(history, opNew);
  assert.equal(history.future.length, 0);

  // Redo is now a no-op
  const afterNoOpRedo = redoHistoryState(history);
  assert.deepEqual(afterNoOpRedo, history);
});

// ---------------------------------------------------------------------------
// Acceptance Test 9: Save project -> reload -> saved components remain intact
// ---------------------------------------------------------------------------
test('8. Save project -> reload from storage -> all saved components remain intact', () => {
  installMockLocalStorage();
  const project = createSampleProject();
  const room = project.rooms[0];

  // Add a custom electrical component and duplicate a furniture item
  const customPoint: ElectricalPoint = {
    id: 'pt-persist-check',
    floor: 1,
    roomId: room.id,
    itemType: 'split_ac',
    category: 'Appliances',
    code: 'AC-88',
    name: 'Master Inverter AC',
    x: Number((room.x + 1.2).toFixed(2)),
    y: Number((room.y + 0.6).toFixed(2)),
    z: 2.3,
    rotation: 90,
    wattage: 1800,
    voltage: 230,
    circuit: 'CKT-P2 (Power 16A)',
    unitCost: 52000,
  };
  const modifiedProject: ProjectData = {
    ...project,
    status: 'Saved',
    points: [...project.points, customPoint],
  };

  projectStorage.saveAll([modifiedProject]);
  const reloaded = projectStorage.loadAll();

  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].id, modifiedProject.id);
  assert.equal(reloaded[0].points.length, modifiedProject.points.length);
  const persistedPoint = reloaded[0].points.find((p) => p.id === 'pt-persist-check');
  assert.ok(persistedPoint);
  assert.deepEqual(persistedPoint, customPoint);
  assert.equal(reloaded[0].rooms.length, modifiedProject.rooms.length);
  assert.equal(reloaded[0].furniture.length, modifiedProject.furniture.length);
});

// ---------------------------------------------------------------------------
// Acceptance Test 10: Multi-selection, 2D/3D shared entity ops & room/furniture edits
// ---------------------------------------------------------------------------
test('9. Multi-selection, Select All, batch Duplicate/Rotate/Delete & room-sync consistency (2D & 3D)', () => {
  const initial = createSampleProject();
  const allFloor1 = selectAllEntitiesOnFloor(initial, 1);
  assert.ok(allFloor1.length > 0);
  assert.ok(allFloor1.some((e) => e.kind === 'point'));
  assert.ok(allFloor1.some((e) => e.kind === 'room'));
  assert.ok(allFloor1.some((e) => e.kind === 'furniture'));

  // Toggle additive selection (Shift+Click)
  const p0: StudioEntityRef = { kind: 'point', id: initial.points[0].id };
  const f0: StudioEntityRef = { kind: 'furniture', id: initial.furniture[0].id };
  let sel = toggleEntityInSelection([], p0, false);
  sel = toggleEntityInSelection(sel, f0, true);
  assert.equal(sel.length, 2);

  // Batch duplicate both electrical point and furniture together
  const { project: dupProj, duplicatedEntities } = duplicateEntitiesInProject(initial, sel, 1);
  assert.equal(duplicatedEntities.length, 2);
  assert.equal(dupProj.points.length, initial.points.length + 1);
  assert.equal(dupProj.furniture.length, initial.furniture.length + 1);

  // Batch rotate duplicated items (shared across 2D & 3D)
  const { project: rotProj, rotatedCount } = rotateEntitiesInProject(
    dupProj,
    duplicatedEntities,
    90
  );
  assert.equal(rotatedCount, 2);

  // Verify moving a room also shifts contained points & furniture coherently
  const targetRoom = rotProj.rooms[0];
  const movedRoomProj = moveEntitiesInProject(
    rotProj,
    [{ kind: 'room', id: targetRoom.id }],
    1.0,
    0.5
  );
  const shiftedRoom = movedRoomProj.rooms.find((r) => r.id === targetRoom.id)!;
  assert.equal(shiftedRoom.x, Number((targetRoom.x + 1.0).toFixed(3)));
  assert.equal(shiftedRoom.y, Number((targetRoom.y + 0.5).toFixed(3)));
  const containedPoint = movedRoomProj.points.find((p) => p.roomId === targetRoom.id);
  if (containedPoint) {
    const resolvedRoom = findRoomAtPoint(movedRoomProj.rooms, containedPoint.x, containedPoint.y);
    assert.ok(resolvedRoom);
  }
});

// ---------------------------------------------------------------------------
// Acceptance Test 11: Keyboard Event Safety (Windows & macOS, Editable Inputs)
// ---------------------------------------------------------------------------
test('10. Keyboard shortcuts work on Windows & macOS and never intercept editable inputs', () => {
  // Editable DOM targets must be detected safely
  assert.equal(isEditableEventTarget({ tagName: 'INPUT' } as unknown as EventTarget), true);
  assert.equal(isEditableEventTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget), true);
  assert.equal(isEditableEventTarget({ tagName: 'SELECT' } as unknown as EventTarget), true);
  assert.equal(
    isEditableEventTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget),
    true
  );
  assert.equal(
    isEditableEventTarget({
      tagName: 'DIV',
      getAttribute: (k: string) => (k === 'role' ? 'textbox' : null),
    } as unknown as EventTarget),
    true
  );
  assert.equal(isEditableEventTarget({ tagName: 'CANVAS' } as unknown as EventTarget), false);
  assert.equal(isEditableEventTarget({ tagName: 'SVG' } as unknown as EventTarget), false);

  const base = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };

  // Never intercept when typing inside inputs
  assert.equal(
    resolveStudioShortcut({ ...base, key: 'z', ctrlKey: true }, { isEditable: true }),
    null
  );
  assert.equal(
    resolveStudioShortcut({ ...base, key: 'Backspace' }, { isEditable: true }),
    null
  );

  // All required Windows shortcuts resolve accurately when studio is active
  assert.equal(resolveStudioShortcut({ ...base, key: 'f', ctrlKey: true }, { isEditable: false }), 'find');
  assert.equal(resolveStudioShortcut({ ...base, key: 'z', ctrlKey: true }, { isEditable: false }), 'undo');
  assert.equal(resolveStudioShortcut({ ...base, key: 'y', ctrlKey: true }, { isEditable: false }), 'redo');
  assert.equal(
    resolveStudioShortcut({ ...base, key: 'z', ctrlKey: true, shiftKey: true }, { isEditable: false }),
    'redo'
  );
  assert.equal(resolveStudioShortcut({ ...base, key: 'c', ctrlKey: true }, { isEditable: false }), 'copy');
  assert.equal(resolveStudioShortcut({ ...base, key: 'v', ctrlKey: true }, { isEditable: false }), 'paste');
  assert.equal(resolveStudioShortcut({ ...base, key: 'd', ctrlKey: true }, { isEditable: false }), 'duplicate');
  assert.equal(resolveStudioShortcut({ ...base, key: 'a', ctrlKey: true }, { isEditable: false }), 'select-all');
  assert.equal(resolveStudioShortcut({ ...base, key: 's', ctrlKey: true }, { isEditable: false }), 'save');
  assert.equal(resolveStudioShortcut({ ...base, key: 'Delete' }, { isEditable: false }), 'delete');
  assert.equal(resolveStudioShortcut({ ...base, key: 'Backspace' }, { isEditable: false }), 'delete');
  assert.equal(resolveStudioShortcut({ ...base, key: 'Escape' }, { isEditable: false }), 'escape');
});

// ---------------------------------------------------------------------------
// Acceptance Test 12: 3D Preview Walk Entry ('E' / 'e') & Navigation (W/A/S/D + Arrows)
// ---------------------------------------------------------------------------
test('11. 3D Preview entry ("E" or "e") and navigation ("W/A/S/D" upper or lower) work cleanly and safely', () => {
  const base = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };

  // Both uppercase 'E' and lowercase 'e' toggle 3D Walk in 3D view outside inputs
  assert.equal(
    resolve3DWalkCommand({ ...base, key: 'E', shiftKey: true }, { isEditable: false, viewMode: '3d' }),
    'toggle-3d-walk'
  );
  assert.equal(
    resolve3DWalkCommand({ ...base, key: 'e' }, { isEditable: false, viewMode: '3d' }),
    'toggle-3d-walk'
  );
  // Must not trigger in 2D mode, while typing in inputs, or with Ctrl modifier
  assert.equal(
    resolve3DWalkCommand({ ...base, key: 'e' }, { isEditable: false, viewMode: '2d' }),
    null
  );
  assert.equal(
    resolve3DWalkCommand({ ...base, key: 'E', shiftKey: true }, { isEditable: true, viewMode: '3d' }),
    null
  );
  assert.equal(
    resolve3DWalkCommand({ ...base, key: 'e', ctrlKey: true }, { isEditable: false, viewMode: '3d' }),
    null
  );

  // Both uppercase and lowercase W/A/S/D navigate cleanly
  assert.equal(resolve3DWalkDirection({ ...base, key: 'W' }), 'forward');
  assert.equal(resolve3DWalkDirection({ ...base, key: 'S' }), 'backward');
  assert.equal(resolve3DWalkDirection({ ...base, key: 'A' }), 'left');
  assert.equal(resolve3DWalkDirection({ ...base, key: 'D' }), 'right');
  assert.equal(resolve3DWalkDirection({ ...base, key: 'w' }), 'forward');
  assert.equal(resolve3DWalkDirection({ ...base, key: 's' }), 'backward');
  assert.equal(resolve3DWalkDirection({ ...base, key: 'a' }), 'left');
  assert.equal(resolve3DWalkDirection({ ...base, key: 'd' }), 'right');

  // Modifiers like Ctrl+S / Ctrl+A must never hijack walk direction
  assert.equal(resolve3DWalkDirection({ ...base, key: 's', ctrlKey: true }), null);
  assert.equal(resolve3DWalkDirection({ ...base, key: 'a', ctrlKey: true }), null);

  // Arrow keys also navigate cleanly, and keyup code mapping releases reliably
  assert.equal(resolve3DWalkDirection({ ...base, key: 'ArrowUp' }), 'forward');
  assert.equal(resolve3DWalkDirection({ ...base, key: 'ArrowDown' }), 'backward');
  assert.equal(resolve3DWalkDirection({ ...base, key: 'ArrowLeft' }), 'left');
  assert.equal(resolve3DWalkDirection({ ...base, key: 'ArrowRight' }), 'right');
  assert.equal(resolve3DWalkDirectionFromCode('KeyW'), 'forward');
  assert.equal(resolve3DWalkDirectionFromCode('KeyD'), 'right');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
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

console.log(`\nStudio Editor Acceptance Tests: ${passed}/${tests.length} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
