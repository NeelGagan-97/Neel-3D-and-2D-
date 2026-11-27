import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  CATALOG_MAP,
  CIRCUITS,
  computeProjectMetrics,
  ELECTRICAL_CATALOG,
  FT_TO_M,
  M_TO_FT,
  ROOM_LIBRARY,
  siteToMeters,
} from '../data/presets';
import {
  inferMappedItemType,
  loadCatalogueProducts,
} from '../services/productCatalogueStorage';
import { ParsedImportPreview, projectStorage } from '../services/projectStorage';
import { ProductCatalogueItem } from '../types/catalogue';
import { ConvertTo2DResult } from '../utils/aiDrawingConverter';
import { AiDrawingImporterModal } from './aiDrawing/AiDrawingImporterModal';
import {
  ArchitecturalOpening,
  BuildingType,
  CableMaterial,
  CameraMode,
  CameraPreset,
  CanvasTool,
  CircuitCableConfig,
  CircuitId,
  DistributionBoardConfig,
  EarthingPointConfig,
  ElectricalItemType,
  ElectricalPoint,
  ElectricalWire,
  FloorView3DMode,
  FurnitureItem,
  LightingMode,
  PhaseDesignation,
  ProjectData,
  RoomType,
  RoomZone,
  SavedCameraView,
  ScreenId,
  SelectedEntity,
  SiteConfig,
  StaircaseItem,
  StaircaseType,
  StudioEntityRef,
  StudioFocusTarget,
  UnitSystem,
  ViewMode,
  WireCategory,
  WireLineStyle,
  WireStandard,
  WireWaypoint,
  WiringDisplayConfig,
} from '../types/design';
import {
  addFloorToProject,
  applyBuildingTypeSafely,
  autoRouteUnwiredCables,
  buildCircuitCableWireFields,
  BUILDING_TYPE_LABELS,
  CIRCUIT_CABLE_RANGES,
  computeActualGeometryBounds,
  computeWireLengthMeters,
  countElementsOnFloor,
  createDefaultDbAndEarthingPoints,
  createDefaultStaircase,
  createElectricalWire,
  duplicateFloorInProject,
  fitSiteToActualGeometry,
  generateAutoRouteWaypoints,
  generateWallAlignedWaypoints,
  getFloorLabel,
  getProjectFloors,
  getWiringConfig,
  inferBuildingType,
  isDuplicateWireConnection,
  removeFloorFromProject,
  setProjectFloorCountSafely,
  updateFloorConfigInProject,
  validateBuildingAndElectrical,
  validateCableSizeForCircuit,
  validateWireRoutePath,
  WIRE_CATEGORY_LABELS,
  WIRE_STANDARD_COLORS,
  WIRE_STANDARD_LABELS,
} from '../utils/buildingWiring';
import { downloadExcelBoq } from '../utils/excelBoqExporter';
import { downloadValidatedProjectDxf } from '../utils/dxfExporter';
import type { CadCapabilitiesResponse } from '../types/aiDrawing';
import {
  downloadFloorPlanPdf,
  downloadFloorPlanPng,
  downloadNativeBluespace,
  downloadProjectJson,
} from '../utils/exporters';
import {
  findNearestValidPosition,
  formatArea,
  formatFloorLabel,
  formatLength,
  fromMeters,
  getItemFloor,
  sliceProjectForFloor,
  toMeters,
  validateRoomPlacement,
} from '../utils/geometry';
import {
  applyCircuitCableConfigToProject,
  assignCatalogueCableToCircuit,
  clearFloorInProject,
  copyEntitiesToClipboard,
  copyFloorBelowInProject,
  deleteEntitiesFromProject,
  duplicateEntitiesInProject,
  eraseEntityFromProject,
  FindCategoryFilter,
  FURNITURE_MAP,
  generateUniqueEntityId,
  getEntityFocusPoint,
  getFloorBelow,
  isEditableEventTarget,
  moveAllOnFloorInProject,
  pasteClipboardIntoProject,
  pruneSelectionToProject,
  resolve3DWalkCommand,
  resolveStudioShortcut,
  rotateEntitiesInProject,
  searchStudioComponents,
  selectAllEntitiesOnFloor,
  StudioClipboard,
  StudioSearchResult,
  toggleEntityInSelection,
} from '../utils/studioEditor';
import { CanvasContextMenu, CanvasContextMenuItem } from './CanvasContextMenu';
import { CreateRoomModal } from './CreateRoomModal';
import { DrawingInstructionsModal } from './DrawingInstructionsModal';
import { FindComponentPanel } from './FindComponentPanel';
import { FloorPlan2D } from './FloorPlan2D';
import { ImportProjectPreviewModal } from './ImportProjectPreviewModal';
import { Navbar } from './Navbar';
import { PdfExportModal } from './PdfExportModal';
import { ProductCatalogueModal } from './ProductCatalogueModal';
import { SiteConfigStep } from './SiteConfigStep';
import { Viewport3D } from './Viewport3D';

interface DesignStudioPageProps {
  projects: ProjectData[];
  project: ProjectData;
  initialViewMode: ViewMode;
  canUndo: boolean;
  canRedo: boolean;
  onNavigate: (screen: ScreenId) => void;
  onSwitchProject: (projectId: string) => void;
  onUpdateProject: (updater: (prev: ProjectData) => ProjectData, recordHistory?: boolean) => void;
  onRecordSnapshot?: () => void;
  onCompleteSiteConfig: (site: SiteConfig) => void;
  onSaveAsProject: (newName: string) => void;
  onImportProject: (rawJson: string) => { ok: boolean; error?: string };
  onUndo: () => void;
  onRedo: () => void;
  onSaveProject: () => void;
}

const DRAWING_TOOLS: { id: CanvasTool; label: string; icon: string; hint: string }[] = [
  { id: 'select', label: 'Select', icon: 'arrow_selector_tool', hint: 'Click empty space to create a room, or click/drag rooms to edit' },
  { id: 'draw-wall', label: 'Draw Wall', icon: 'horizontal_rule', hint: 'Click & drag to draw a wall (auto H/V snap; hold Shift for angled)' },
  { id: 'add-room', label: 'Add Room', icon: 'add_box', hint: 'Click any empty area inside the site boundary to create a room' },
  { id: 'add-door', label: 'Add Door', icon: 'door_front', hint: 'Click on any exterior or interior wall to place a door' },
  { id: 'add-window', label: 'Add Window', icon: 'window', hint: 'Click on any wall to snap a parametric window' },
  { id: 'add-staircase', label: 'Staircase', icon: 'stairs', hint: 'Click inside the plan to place a parametric inter-floor staircase' },
  { id: 'add-wire', label: 'Route Cable', icon: 'cable', hint: 'Click a source electrical point, click to place waypoints (Shift for angled), click destination point (Esc to cancel)' },
  { id: 'erase', label: 'Erase', icon: 'ink_eraser', hint: 'Click any room, wall, door, window, staircase, wire, dimension, or electrical point to remove' },
  { id: 'dimension', label: 'Dimension', icon: 'straighten', hint: 'Click & drag between two points to place a measurement annotation' },
  { id: 'move', label: 'Move', icon: 'open_with', hint: 'Drag any room, staircase, wire waypoint, or electrical point to reposition it' },
  { id: 'rotate', label: 'Rotate', icon: 'rotate_right', hint: 'Click any room, staircase, or door/window to rotate 90°' },
  { id: 'pan', label: 'Pan', icon: 'pan_tool', hint: 'Pan active — drag anywhere on the model to move it freely inside the canvas' },
];

export const DesignStudioPage: React.FC<DesignStudioPageProps> = ({
  projects,
  project,
  initialViewMode,
  canUndo,
  canRedo,
  onNavigate,
  onSwitchProject,
  onUpdateProject,
  onRecordSnapshot,
  onCompleteSiteConfig,
  onSaveAsProject,
  onImportProject,
  onUndo,
  onRedo,
  onSaveProject,
}) => {
  const { profile, isAdmin: authIsAdmin } = useAuth();
  const isAdmin = authIsAdmin || profile?.role === 'ADMIN';

  const [viewMode, setViewMode] = useState<ViewMode>(
    project.siteConfigured === false ? '2d' : initialViewMode
  );
  const [activeFloor, setActiveFloor] = useState<number>(1);
  const [floorView3D, setFloorView3D] = useState<FloorView3DMode>('active-only');
  const [showGuideModal, setShowGuideModal] = useState<boolean>(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>('orbit');
  const requestFpsPointerLockRef = useRef<(() => void) | null>(null);
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>('perspective');
  const [appliedSavedView, setAppliedSavedView] = useState<SavedCameraView | null>(null);
  const captureCameraRef = useRef<(() => SavedCameraView | null) | null>(null);
  const [savedViewLabel, setSavedViewLabel] = useState<string>('');
  const [lightingMode, setLightingMode] = useState<LightingMode>('daylight');
  const [zoom, setZoom] = useState<number>(100);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [canvasContextMenu, setCanvasContextMenu] = useState<{ x: number; y: number } | null>(null);
  const showGrid = true;
  const snapEnabled = true;
  const [activeTool, setActiveTool] = useState<CanvasTool>('select');

  // Interactive wiring, product catalogue, PDF package & safe import states
  const [activeWireCategory, setActiveWireCategory] = useState<WireCategory>('phase');
  const [allowInterFloorWiring, setAllowInterFloorWiring] = useState<boolean>(false);
  const [catalogueOpen, setCatalogueOpen] = useState<boolean>(false);
  const [catalogueVersion, setCatalogueVersion] = useState<number>(0);
  const [pdfModalOpen, setPdfModalOpen] = useState<boolean>(false);
  const [aiDrawingModalOpen, setAiDrawingModalOpen] = useState<boolean>(false);
  const [importPreview, setImportPreview] = useState<ParsedImportPreview | null>(null);
  const [pendingDeleteFloor, setPendingDeleteFloor] = useState<number | null>(null);

  useEffect(() => {
    setCanvasContextMenu(null);
    setOpenToolbarDropdown(null);
  }, [viewMode, activeFloor, project.id]);

  const projectFloors = useMemo(() => getProjectFloors(project), [project]);
  const totalFloors = projectFloors.length;
  const wiringConfig = useMemo(() => getWiringConfig(project), [project]);
  const validationIssues = useMemo(() => validateBuildingAndElectrical(project), [project]);
  const catalogueProducts = useMemo(
    () => loadCatalogueProducts(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalogueVersion, catalogueOpen]
  );
  const cableCatalogueProducts = useMemo(
    () => catalogueProducts.filter((p) => p.category === 'Cables & Wires'),
    [catalogueProducts]
  );
  const hasDbPoint = useMemo(
    () => project.points.some((p) => p.itemType === 'distribution_board'),
    [project.points]
  );
  const hasEarthingPoint = useMemo(
    () => project.points.some((p) => p.itemType === 'earthing_point'),
    [project.points]
  );

  useEffect(() => {
    if (!projectFloors.some((f) => f.floor === activeFloor)) {
      setActiveFloor(projectFloors.find((f) => f.floor === 1)?.floor ?? projectFloors[0]?.floor ?? 1);
    }
  }, [activeFloor, projectFloors]);

  const floorProject = useMemo(
    () => sliceProjectForFloor(project, activeFloor),
    [project, activeFloor]
  );

  // Multi-selection state (length 1 -> single entity inspector; length > 1 -> multi-selection inspector)
  const [selectedEntities, setSelectedEntities] = useState<StudioEntityRef[]>(() =>
    project.rooms[0] ? [{ kind: 'room', id: project.rooms[0].id }] : []
  );
  const [allSelected, setAllSelected] = useState<boolean>(false);
  const [pendingPlaceItem, setPendingPlaceItem] = useState<ElectricalItemType | null>(null);
  const [pendingRoomModal, setPendingRoomModal] = useState<{
    x: number;
    y: number;
    roomType?: RoomType;
  } | null>(null);

  // Simulink-style Clipboard & Find Component state
  const [clipboard, setClipboard] = useState<StudioClipboard | null>(null);
  const pasteStepRef = useRef<number>(1);
  const [findOpen, setFindOpen] = useState<boolean>(false);
  const [findQuery, setFindQuery] = useState<string>('');
  const [findCategory, setFindCategory] = useState<FindCategoryFilter>('all');
  const [findActiveIndex, setFindActiveIndex] = useState<number>(0);
  const [focusTarget, setFocusTarget] = useState<StudioFocusTarget | null>(null);

  // Tracks whether a text/number inspector edit session already recorded an undo snapshot
  const inspectorSnapshotGuardRef = useRef<string | null>(null);
  const ensureInspectorSnapshot = (fieldKey: string) => {
    if (inspectorSnapshotGuardRef.current !== fieldKey) {
      inspectorSnapshotGuardRef.current = fieldKey;
      onRecordSnapshot?.();
    }
  };
  const resetInspectorSnapshotGuard = () => {
    inspectorSnapshotGuardRef.current = null;
  };

  // Convenience setters that keep selectedEntities & allSelected synchronized
  const setSelectedEntity = useCallback((entity: SelectedEntity, additive = false) => {
    resetInspectorSnapshotGuard();
    if (!entity) {
      setSelectedEntities([]);
      return;
    }
    setSelectedEntities((prev) => toggleEntityInSelection(prev, entity, additive));
  }, []);

  // Automatically prune deleted/undone entities from selection so Inspector never references stale IDs
  useEffect(() => {
    setSelectedEntities((prev) => {
      const pruned = pruneSelectionToProject(prev, project);
      return pruned.length === prev.length ? prev : pruned;
    });
  }, [project]);

  const selectedEntity: SelectedEntity =
    selectedEntities.length === 1 ? selectedEntities[0] : null;

  const [showExportMenu, setShowExportMenu] = useState(false);
  const [cadCapabilities, setCadCapabilities] = useState<CadCapabilitiesResponse | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/cad/capabilities', { signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && typeof data.dxfReady === 'boolean') {
          setCadCapabilities(data as CadCapabilitiesResponse);
        }
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  const handleExportValidatedDxf = () => {
    const res = downloadValidatedProjectDxf(project, activeFloor);
    if (!res.ok) {
      notify(res.error, 'error');
      return;
    }
    notify(
      `Exported validated editable AutoCAD DXF (${res.bundle.validation.entityCount} entities across ${res.bundle.validation.layerNames.length} CAD layers).`,
      'success'
    );
  };

  const handleExportNativeDwg = async () => {
    if (!cadCapabilities?.dwgReady) {
      notify(
        cadCapabilities?.dwgReason ||
          'Native binary DWG export requires an installed licensed CAD converter (ODA File Converter or LibreDWG dxf2dwg). Use validated AutoCAD DXF export instead — Blue Space never renames DXF as DWG.',
        'warning'
      );
      return;
    }
    try {
      const resp = await fetch('/api/cad/export-dwg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, activeFloor }),
      });
      if (!resp.ok) {
        const errJson = await resp.json().catch(() => null);
        notify(errJson?.error || 'Native DWG export failed.', 'error');
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.replace(/[^a-zA-Z0-9_-]+/g, '-') || 'bluespace-cad'}.dwg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify(`Exported native binary DWG via ${cadCapabilities.dwgEngine}.`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Native DWG export failed.', 'error');
    }
  };

  const handleApprove2DFor3D = () => {
    onUpdateProject(
      (prev) => ({
        ...prev,
        aiDrawingImport: prev.aiDrawingImport
          ? {
              ...prev.aiDrawingImport,
              approvedFor3D: true,
              approvedFor3DAt: new Date().toISOString(),
            }
          : prev.aiDrawingImport,
      }),
      true
    );
    setViewMode('3d');
    notify('2D CAD approved — 3D architectural & electrical model synchronized in Blue Space.', 'success');
  };

  const requestSwitchTo3D = () => {
    if (project.aiDrawingImport && project.aiDrawingImport.approvedFor3D === false) {
      notify(
        'Review your reconstructed 2D CAD layers first, then click "Approve 2D & Open 3D" on the top-left overlay bar to convert the approved 2D model into 3D.',
        'warning'
      );
      return;
    }
    setViewMode('3d');
    notify('3D Preview synchronized from 2D floor plan geometry');
  };
  const [openToolbarDropdown, setOpenToolbarDropdown] = useState<'view' | 'camera' | 'sky' | null>(null);
  const [openDrawer, setOpenDrawer] = useState<
    'tools' | 'rooms' | 'site' | 'electrical' | 'wiring' | 'floors' | 'properties' | null
  >(null);
  const [showSaveAsModal, setShowSaveAsModal] = useState(false);
  const [saveAsName, setSaveAsName] = useState(`${project.name} (Copy)`);
  const [saveAsError, setSaveAsError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const [inspectorWarning, setInspectorWarning] = useState<string | null>(null);
  type NotificationTone = 'info' | 'success' | 'warning' | 'error';
  const [statusMessage, setStatusMessage] = useState<{
    id: number;
    text: string;
    tone: NotificationTone;
  } | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const lastStatusRef = useRef<{ text: string; tone: NotificationTone; ts: number } | null>(null);

  useEffect(() => {
    return () => {
      if (statusTimerRef.current !== null) {
        window.clearTimeout(statusTimerRef.current);
        statusTimerRef.current = null;
      }
    };
  }, []);

  const dismissNotification = useCallback(() => {
    if (statusTimerRef.current !== null) {
      window.clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
    setStatusMessage(null);
  }, []);

  const notify = useCallback((text: string, tone: NotificationTone = 'info') => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const now = Date.now();
    const last = lastStatusRef.current;
    // Deduplicate rapid repeated identical notifications
    if (last && last.text === trimmed && last.tone === tone && now - last.ts < 800) {
      return;
    }
    lastStatusRef.current = { text: trimmed, tone, ts: now };

    if (statusTimerRef.current !== null) {
      window.clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }

    setStatusMessage({ id: now, text: trimmed, tone });

    const durationMs = tone === 'error' ? 7000 : tone === 'warning' ? 5500 : 4000;
    statusTimerRef.current = window.setTimeout(() => {
      statusTimerRef.current = null;
      setStatusMessage(null);
    }, durationMs);
  }, []);

  const metrics = useMemo(() => computeProjectMetrics(project), [project]);
  const units = project.site.units;
  const unitShort = units === 'ft' ? 'ft' : 'm';

  const selectedRoom = useMemo(() => {
    if (selectedEntity?.kind !== 'room') return null;
    return project.rooms.find((r) => r.id === selectedEntity.id) ?? null;
  }, [project.rooms, selectedEntity]);

  const selectedWall = useMemo(() => {
    if (selectedEntity?.kind !== 'wall') return null;
    return project.customWalls.find((w) => w.id === selectedEntity.id) ?? null;
  }, [project.customWalls, selectedEntity]);

  const selectedOpening = useMemo(() => {
    if (selectedEntity?.kind !== 'opening') return null;
    return project.openings.find((o) => o.id === selectedEntity.id) ?? null;
  }, [project.openings, selectedEntity]);

  const selectedPoint = useMemo(() => {
    if (selectedEntity?.kind !== 'point') return null;
    return project.points.find((p) => p.id === selectedEntity.id) ?? null;
  }, [project.points, selectedEntity]);

  const selectedFurniture = useMemo(() => {
    if (selectedEntity?.kind !== 'furniture') return null;
    return project.furniture.find((f) => f.id === selectedEntity.id) ?? null;
  }, [project.furniture, selectedEntity]);

  const selectedStaircase = useMemo(() => {
    if (selectedEntity?.kind !== 'staircase') return null;
    return (project.staircases ?? []).find((s) => s.id === selectedEntity.id) ?? null;
  }, [project.staircases, selectedEntity]);

  const selectedWire = useMemo(() => {
    if (selectedEntity?.kind !== 'wire') return null;
    return (project.wires ?? []).find((w) => w.id === selectedEntity.id) ?? null;
  }, [project.wires, selectedEntity]);

  // Live Find Component search results across placed canvas entities + component library
  const findResults = useMemo(
    () => (findOpen ? searchStudioComponents(project, findQuery, findCategory) : []),
    [findOpen, project, findQuery, findCategory]
  );

  // Keep active search index in bounds when query or filter changes
  useEffect(() => {
    if (!findOpen) return;
    setFindActiveIndex(0);
  }, [findQuery, findCategory, findOpen]);

  const highlightedIds = useMemo(() => {
    const set = new Set<string>();
    if (!findOpen) return set;
    findResults.forEach((res) => {
      if (res.source === 'placed' && res.entity) {
        set.add(res.entity.id);
      }
    });
    return set;
  }, [findOpen, findResults]);

  const activeHighlightId = useMemo(() => {
    if (!findOpen || findResults.length === 0) return null;
    const clampedIdx = Math.max(0, Math.min(findActiveIndex, findResults.length - 1));
    const active = findResults[clampedIdx];
    return active?.source === 'placed' && active.entity ? active.entity.id : null;
  }, [findOpen, findResults, findActiveIndex]);

  // --- Simulink-Style Selection & Clipboard Operations (Work in BOTH 2D & 3D) ---

  const getActiveSelectionForOp = useCallback((): StudioEntityRef[] => {
    if (allSelected) {
      return selectAllEntitiesOnFloor(project, activeFloor);
    }
    return selectedEntities;
  }, [allSelected, project, activeFloor, selectedEntities]);

  const handleSelectAll = useCallback(() => {
    const allOnFloor = selectAllEntitiesOnFloor(project, activeFloor);
    setSelectedEntities(allOnFloor);
    setAllSelected(true);
    setInspectorWarning(null);
    notify(
      allOnFloor.length > 0
        ? `Selected all ${allOnFloor.length} components on ${formatFloorLabel(activeFloor)} — Ctrl+C Copy, Ctrl+D Duplicate, Delete to remove, Esc to clear`
        : `${formatFloorLabel(activeFloor)} has no components to select yet`
    );
  }, [project, activeFloor, notify]);

  const handleCopySelection = useCallback(() => {
    const targets = getActiveSelectionForOp();
    const clip = copyEntitiesToClipboard(project, targets, activeFloor);
    if (!clip) {
      notify('Select one or more components first before copying (Ctrl+C)', 'warning');
      return;
    }
    const count =
      clip.points.length +
      clip.rooms.length +
      clip.customWalls.length +
      clip.openings.length +
      clip.furniture.length;
    setClipboard(clip);
    pasteStepRef.current = 1;
    notify(`Copied ${count} component${count === 1 ? '' : 's'} to clipboard — press Ctrl+V to paste`);
  }, [getActiveSelectionForOp, project, activeFloor, notify]);

  const handlePasteClipboard = useCallback(() => {
    if (!clipboard) {
      notify('Clipboard is empty — select a component and press Ctrl+C first', 'warning');
      return;
    }
    const step = pasteStepRef.current;
    pasteStepRef.current += 1;
    const result = pasteClipboardIntoProject(project, clipboard, activeFloor, step);
    if (result.pastedEntities.length === 0) return;

    onUpdateProject(() => result.project, true);
    setAllSelected(false);
    setSelectedEntities(result.pastedEntities);
    setInspectorWarning(null);
    notify(
      `Pasted ${result.pastedEntities.length} independent component${result.pastedEntities.length === 1 ? '' : 's'} onto ${formatFloorLabel(activeFloor)}`
    );
  }, [clipboard, project, activeFloor, onUpdateProject, notify]);

  const handleDuplicateSelection = useCallback(() => {
    const targets = getActiveSelectionForOp();
    if (targets.length === 0) {
      notify('Select one or more components first to duplicate (Ctrl+D)', 'warning');
      return;
    }
    const result = duplicateEntitiesInProject(project, targets, activeFloor);
    if (result.duplicatedEntities.length === 0) return;

    onUpdateProject(() => result.project, true);
    setAllSelected(false);
    setSelectedEntities(result.duplicatedEntities);
    setInspectorWarning(null);
    notify(
      `Duplicated ${result.duplicatedEntities.length} component${result.duplicatedEntities.length === 1 ? '' : 's'} with unique IDs`
    );
  }, [getActiveSelectionForOp, project, activeFloor, onUpdateProject, notify]);

  const handleDeleteSelection = useCallback(() => {
    const targets = getActiveSelectionForOp();
    if (targets.length === 0 && !allSelected) return;

    if (allSelected) {
      const clearedProject = clearFloorInProject(project, activeFloor);
      const clearedCount =
        (project.rooms.length - clearedProject.rooms.length) +
        (project.customWalls.length - clearedProject.customWalls.length) +
        (project.openings.length - clearedProject.openings.length) +
        ((project.dimensions?.length ?? 0) - (clearedProject.dimensions?.length ?? 0)) +
        (project.furniture.length - clearedProject.furniture.length) +
        (project.points.length - clearedProject.points.length) +
        ((project.staircases?.length ?? 0) - (clearedProject.staircases?.length ?? 0)) +
        ((project.wires?.length ?? 0) - (clearedProject.wires?.length ?? 0));
      if (clearedCount === 0) {
        setAllSelected(false);
        setSelectedEntities([]);
        notify(`${getFloorLabel(project, activeFloor)} has no elements to clear.`, 'info');
        return;
      }
      onUpdateProject(() => clearedProject, true);
      setAllSelected(false);
      setSelectedEntities([]);
      notify(
        `Cleared ${clearedCount} element${clearedCount === 1 ? '' : 's'} on ${getFloorLabel(project, activeFloor)} (Ctrl+Z to undo)`,
        'success'
      );
      return;
    }

    const result = deleteEntitiesFromProject(project, targets);
    if (result.deletedCount === 0) return;
    onUpdateProject(() => result.project, true);
    setSelectedEntities([]);
    setAllSelected(false);
    notify(
      `Deleted ${result.deletedCount} component${result.deletedCount === 1 ? '' : 's'} (Ctrl+Z to restore)`
    );
  }, [getActiveSelectionForOp, allSelected, project, activeFloor, onUpdateProject, notify]);

  const handleRotateSelection = useCallback(() => {
    const targets = getActiveSelectionForOp();
    if (targets.length === 0) {
      notify('Select one or more components to rotate 90°', 'warning');
      return;
    }
    const result = rotateEntitiesInProject(project, targets, 90);
    if (result.rotatedCount === 0) {
      notify('Selected item cannot be rotated', 'warning');
      return;
    }
    onUpdateProject(() => result.project, true);
    notify(`Rotated ${result.rotatedCount} component${result.rotatedCount === 1 ? '' : 's'} by 90°`);
  }, [getActiveSelectionForOp, project, onUpdateProject, notify]);

  const handleFocusAndSelectEntity = useCallback(
    (entity: StudioEntityRef, targetProject: ProjectData = project) => {
      const focus = getEntityFocusPoint(targetProject, entity);
      if (focus) {
        if (focus.floor !== activeFloor) {
          setActiveFloor(focus.floor);
          setFloorView3D('active-only');
        }
        setFocusTarget({
          x: focus.x,
          y: focus.y,
          z: focus.z,
          floor: focus.floor,
          nonce: Date.now() + Math.random(),
        });
      }
      setAllSelected(false);
      setSelectedEntities([entity]);
      setInspectorWarning(null);
    },
    [project, activeFloor]
  );

  const handlePlaceFurnitureFromLibrary = useCallback(
    (kind: FurnitureItem['kind']) => {
      const meta = FURNITURE_MAP[kind];
      const targetRoom =
        (selectedRoom && getItemFloor(selectedRoom) === activeFloor ? selectedRoom : null) ??
        floorProject.rooms[0];
      const { lengthM, widthM } = siteToMeters(project.site);
      const cx = targetRoom ? targetRoom.x + targetRoom.width / 2 : lengthM / 2;
      const cy = targetRoom ? targetRoom.y + targetRoom.height / 2 : widthM / 2;
      const existingIds = new Set(project.furniture.map((f) => f.id));
      const newFurn: FurnitureItem = {
        id: generateUniqueEntityId('fn', existingIds),
        floor: activeFloor,
        kind,
        roomId: targetRoom?.id ?? '',
        x: Number(cx.toFixed(2)),
        y: Number(cy.toFixed(2)),
        width: meta.defaultWidth,
        depth: meta.defaultDepth,
        rotation: 0,
      };
      onUpdateProject(
        (prev) => ({
          ...prev,
          furniture: [...prev.furniture, newFurn],
        }),
        true
      );
      setAllSelected(false);
      setSelectedEntities([{ kind: 'furniture', id: newFurn.id }]);
      setFocusTarget({
        x: newFurn.x,
        y: newFurn.y,
        z: 0.6,
        floor: activeFloor,
        nonce: Date.now() + Math.random(),
      });
      notify(`Placed ${meta.label} on ${formatFloorLabel(activeFloor)}`);
    },
    [selectedRoom, activeFloor, floorProject.rooms, project.site, project.furniture, onUpdateProject, notify]
  );

  // Global Simulink-Style Keyboard Shortcuts (Active in BOTH 2D & 3D modes, Input-Safe)
  useEffect(() => {
    if (project.siteConfigured === false) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const modalBlocking = Boolean(
        pendingRoomModal || showSaveAsModal || showGuideModal || catalogueOpen || pdfModalOpen || importPreview
      );

      // Allow Ctrl+S save even when Find input is open (prevent browser Save Page dialog)
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's' && !modalBlocking) {
        if (!isEditableEventTarget(e.target) || findOpen) {
          e.preventDefault();
          onSaveProject();
          notify(`Saved "${project.name}" to workspace`);
          return;
        }
      }

      const isEditable = isEditableEventTarget(e.target);

      // 'E' / 'e' command in 3D Preview: Enter / Exit 3D Walk Mode
      const walkCmd = resolve3DWalkCommand(e, {
        isEditable,
        modalBlocking,
        viewMode,
      });
      if (walkCmd === 'toggle-3d-walk') {
        e.preventDefault();
        setCanvasContextMenu(null);
        setOpenDrawer(null);
        if (cameraMode === 'fps') {
          try {
            if (document.pointerLockElement) {
              document.exitPointerLock?.();
            }
          } catch {
            // Ignore pointer lock exit errors
          }
          setCameraMode('orbit');
          notify('Exited First-Person Navigation back to Orbit view');
        } else {
          setCameraMode('fps');
          requestFpsPointerLockRef.current?.();
          notify(
            `Entered First-Person Navigation (1.65m eye level) on ${formatFloorLabel(activeFloor)} — Mouse to look, WASD to move, ESC to exit`
          );
        }
        return;
      }

      const action = resolveStudioShortcut(e, {
        isEditable,
        modalBlocking,
      });
      if (!action) return;

      switch (action) {
        case 'find':
          e.preventDefault();
          setCanvasContextMenu(null);
          setOpenDrawer(null);
          setFindOpen(true);
          notify('Find Component open — type name, category, type, or ID (Esc to close)');
          break;
        case 'undo':
          e.preventDefault();
          if (canUndo) {
            onUndo();
            notify('Undid last action (Ctrl+Z)');
          }
          break;
        case 'redo':
          e.preventDefault();
          if (canRedo) {
            onRedo();
            notify('Redid action (Ctrl+Y)');
          }
          break;
        case 'copy':
          e.preventDefault();
          handleCopySelection();
          break;
        case 'paste':
          e.preventDefault();
          handlePasteClipboard();
          break;
        case 'duplicate':
          e.preventDefault();
          handleDuplicateSelection();
          break;
        case 'delete':
          if (selectedEntities.length > 0 || allSelected) {
            e.preventDefault();
            handleDeleteSelection();
          }
          break;
        case 'select-all':
          e.preventDefault();
          handleSelectAll();
          break;
        case 'save':
          e.preventDefault();
          onSaveProject();
          notify(`Saved "${project.name}" to workspace`);
          break;
        case 'escape':
          e.preventDefault();
          if (openToolbarDropdown) {
            setOpenToolbarDropdown(null);
          } else if (canvasContextMenu) {
            setCanvasContextMenu(null);
          } else if (viewMode === '3d' && cameraMode === 'fps') {
            try {
              if (document.pointerLockElement) {
                document.exitPointerLock?.();
              }
            } catch {
              // Ignore
            }
            setCameraMode('orbit');
            notify('Exited First-Person Navigation back to Orbit view');
          } else if (findOpen) {
            setFindOpen(false);
            notify('Closed Find Component');
          } else if (openDrawer) {
            setOpenDrawer(null);
          } else if (pendingPlaceItem) {
            setPendingPlaceItem(null);
            notify('Cancelled component placement');
          } else {
            setAllSelected(false);
            setSelectedEntities([]);
            setInspectorWarning(null);
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    project.siteConfigured,
    project.name,
    viewMode,
    cameraMode,
    activeFloor,
    canvasContextMenu,
    openToolbarDropdown,
    pendingRoomModal,
    showSaveAsModal,
    showGuideModal,
    catalogueOpen,
    pdfModalOpen,
    importPreview,
    findOpen,
    openDrawer,
    pendingPlaceItem,
    canUndo,
    canRedo,
    selectedEntities.length,
    allSelected,
    onUndo,
    onRedo,
    onSaveProject,
    handleCopySelection,
    handlePasteClipboard,
    handleDuplicateSelection,
    handleDeleteSelection,
    handleSelectAll,
    notify,
  ]);

  // PHASE 2: If this project has not configured its site yet, show Site Dimension Configuration first
  if (project.siteConfigured === false) {
    return (
      <div className="min-h-screen flex flex-col bg-surface text-on-surface">
        <Navbar
          activeScreen="studio"
          onNavigate={onNavigate}
          compact={true}
          rightSlot={
            <span className="font-mono text-mono-sm text-primary">
              PROJECT: {project.name}
            </span>
          }
        />
        <SiteConfigStep
          project={project}
          onCreateSite={(site) => {
            onCompleteSiteConfig(site);
            setViewMode('2d');
            setZoom(100);
            setPanOffset({ x: 0, y: 0 });
            setSelectedEntity(null);
            notify(
              `Site created (${site.length} ${site.units} × ${site.width} ${site.units}) — click inside the boundary to add your first room`
            );
          }}
          onBackHome={() => onNavigate('home')}
        />
      </div>
    );
  }

  // --- Handlers ---

  const handleSelectTool = (tool: CanvasTool) => {
    setActiveTool(tool);
    setPendingPlaceItem(null);
    if (tool !== 'select') {
      setViewMode('2d');
    }
    const meta = DRAWING_TOOLS.find((t) => t.id === tool);
    if (meta) notify(meta.hint);
  };

  const handleSwitchFloor = (floorNum: number) => {
    const targetCfg = projectFloors.find((f) => f.floor === floorNum) ?? projectFloors[0];
    if (!targetCfg) return;
    setActiveFloor(targetCfg.floor);
    setFloorView3D('active-only');
    setSelectedEntity(null);
    setAllSelected(false);
    setInspectorWarning(null);
    const elev =
      targetCfg.elevationM !== 0
        ? ` · Elevation ${targetCfg.elevationM >= 0 ? '+' : ''}${formatLength(targetCfg.elevationM, units, 1)}`
        : ' · Ground Level';
    notify(`Showing ${targetCfg.name}${elev}`);
  };

  const handleToggleElevatedView = () => {
    setFloorView3D('all');
    setViewMode('3d');
    setSelectedEntity(null);
    setAllSelected(false);
    setInspectorWarning(null);
    notify(`Complete Building View — displaying all ${totalFloors} floors stacked together`);
  };

  const handleToggleExplodedView = () => {
    setFloorView3D('exploded');
    setViewMode('3d');
    setSelectedEntity(null);
    setAllSelected(false);
    setInspectorWarning(null);
    notify(`Exploded 3D View — inspecting all ${totalFloors} floors with vertical separation`);
  };

  const floorBelowConfig = useMemo(
    () => getFloorBelow(project, activeFloor),
    [project, activeFloor]
  );

  const handleCopyFloorBelow = () => {
    const result = copyFloorBelowInProject(project, activeFloor);
    if (!result.ok) {
      notify(result.reason ?? 'Unable to copy floor below.', 'warning');
      return;
    }
    onUpdateProject(() => result.project, true);
    setSelectedEntity(null);
    setAllSelected(false);
    const srcLabel =
      result.sourceFloor !== undefined
        ? getFloorLabel(project, result.sourceFloor)
        : 'floor below';
    notify(
      `Copied ${srcLabel} onto ${getFloorLabel(project, activeFloor)} (${result.clonedRoomCount} rooms, ${result.clonedPointCount} points, ${result.clonedWireCount} cables — Ctrl+Z to undo)`,
      'success'
    );
  };

  const handleMoveAll = (dxM: number, dyM: number) => {
    onUpdateProject((prev) => moveAllOnFloorInProject(prev, activeFloor, dxM, dyM), true);
    notify(`Moved all elements on ${getFloorLabel(project, activeFloor)} (Ctrl+Z to undo)`);
  };

  const handleClearAllSelected = () => {
    const clearedProject = clearFloorInProject(project, activeFloor);
    const clearedCount =
      (project.rooms.length - clearedProject.rooms.length) +
      (project.customWalls.length - clearedProject.customWalls.length) +
      (project.openings.length - clearedProject.openings.length) +
      ((project.dimensions?.length ?? 0) - (clearedProject.dimensions?.length ?? 0)) +
      (project.furniture.length - clearedProject.furniture.length) +
      (project.points.length - clearedProject.points.length) +
      ((project.staircases?.length ?? 0) - (clearedProject.staircases?.length ?? 0)) +
      ((project.wires?.length ?? 0) - (clearedProject.wires?.length ?? 0));
    if (clearedCount === 0) {
      setAllSelected(false);
      setSelectedEntity(null);
      notify(`${getFloorLabel(project, activeFloor)} is already empty.`, 'info');
      return;
    }
    onUpdateProject(() => clearedProject, true);
    setAllSelected(false);
    setSelectedEntity(null);
    notify(
      `Cleared ${clearedCount} element${clearedCount === 1 ? '' : 's'} on ${getFloorLabel(project, activeFloor)} (click Undo to restore)`,
      'success'
    );
  };

  const handleFitToScreen = () => {
    setZoom(100);
    setPanOffset({ x: 0, y: 0 });
    notify('Canvas reset to Fit to Screen (100%)');
  };

  const handleEmptySiteClick = (xM: number, yM: number) => {
    setInspectorWarning(null);
    setPendingRoomModal({ x: xM, y: yM });
  };

  const handleOpenRoomLibraryModal = (type: RoomType) => {
    const tpl = ROOM_LIBRARY.find((r) => r.type === type) ?? ROOM_LIBRARY[0];
    const defaultW = units === 'ft' ? tpl.defaultLengthFt * FT_TO_M : tpl.defaultW;
    const defaultH = units === 'ft' ? tpl.defaultWidthFt * FT_TO_M : tpl.defaultH;
    const suggested = findNearestValidPosition(0, 0, defaultW, defaultH, floorProject);
    setViewMode('2d');
    setInspectorWarning(null);
    setPendingRoomModal({
      x: suggested?.x ?? 0,
      y: suggested?.y ?? 0,
      roomType: type,
    });
  };

  const handlePlaceRoomFromModal = (payload: {
    name: string;
    type: RoomType;
    x: number;
    y: number;
    width: number;
    height: number;
    finish: 'wood' | 'tile' | 'stone' | 'terrazzo';
  }) => {
    const check = validateRoomPlacement(payload, floorProject);
    if (!check.valid) {
      notify(check.reason ?? 'Invalid room placement.', 'warning');
      return;
    }

    const { wallThickM } = siteToMeters(project.site);
    const newId = `rm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newRoom: RoomZone = {
      id: newId,
      name: payload.name,
      type: payload.type,
      floor: activeFloor,
      x: payload.x,
      y: payload.y,
      width: payload.width,
      height: payload.height,
      wallThickness: Number(Math.max(0.11, wallThickM * 0.72).toFixed(3)),
      rotation: 0,
      floorFinish: payload.finish,
    };

    onUpdateProject((prev) => ({
      ...prev,
      rooms: [...prev.rooms, newRoom],
    }));

    setPendingRoomModal(null);
    setSelectedEntity({ kind: 'room', id: newId });
    setActiveTool('select');
    notify(
      `Placed ${newRoom.name} on ${formatFloorLabel(activeFloor)} (${formatLength(newRoom.width, units)} × ${formatLength(newRoom.height, units)})`
    );
  };

  const handleUpdateRoom = (
    roomId: string,
    patch: Partial<RoomZone>,
    recordHistory = true
  ) => {
    const current = project.rooms.find((r) => r.id === roomId);
    if (!current) return;
    const next = { ...current, ...patch };

    if (!Number.isFinite(next.width) || !Number.isFinite(next.height) || next.width <= 0.1 || next.height <= 0.1) {
      const msg = 'Room length and width must be greater than zero.';
      setInspectorWarning(msg);
      notify(msg, 'warning');
      return;
    }

    const dx = Number((next.x - current.x).toFixed(3));
    const dy = Number((next.y - current.y).toFixed(3));
    const movedPos = Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001;

    // Non-blocking geometric check: lets users dismantle & place sections freely anywhere on canvas
    const check = validateRoomPlacement(
      { x: next.x, y: next.y, width: next.width, height: next.height },
      floorProject,
      roomId
    );
    if (!check.valid) {
      setInspectorWarning(null);
      notify(`Placed "${next.name}" freely on canvas (${check.reason})`);
    } else {
      setInspectorWarning(null);
      if (movedPos) {
        notify(`Moved "${next.name}"`);
      }
    }

    onUpdateProject(
      (prev) => ({
        ...prev,
        rooms: prev.rooms.map((r) => (r.id === roomId ? next : r)),
        // Carry attached furniture & electrical points along with the dismantled room section
        furniture: movedPos
          ? prev.furniture.map((f) =>
              f.roomId === roomId
                ? { ...f, x: Number((f.x + dx).toFixed(3)), y: Number((f.y + dy).toFixed(3)) }
                : f
            )
          : prev.furniture,
        points: movedPos
          ? prev.points.map((p) =>
              p.roomId === roomId
                ? { ...p, x: Number((p.x + dx).toFixed(3)), y: Number((p.y + dy).toFixed(3)) }
                : p
            )
          : prev.points,
      }),
      recordHistory
    );
  };

  const handleDismantleRoom = (roomId: string) => {
    const room = project.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const { lengthM } = siteToMeters(project.site);
    const detachedX = Number((lengthM + 1.2).toFixed(2));
    handleUpdateRoom(room.id, { x: detachedX, y: room.y }, true);
    notify(`Dismantled "${room.name}" onto open canvas — drag freely anywhere to re-place`);
  };

  const handleRotateRoom = (roomId: string) => {
    const room = project.rooms.find((r) => r.id === roomId);
    if (!room) return;
    // Rotate 90° around room center or anchor at top-left, keeping valid inside site
    const swappedW = room.height;
    const swappedH = room.width;
    const checkAnchor = validateRoomPlacement(
      { x: room.x, y: room.y, width: swappedW, height: swappedH },
      floorProject,
      room.id
    );

    if (checkAnchor.valid) {
      handleUpdateRoom(
        room.id,
        {
          width: swappedW,
          height: swappedH,
          rotation: ((room.rotation ?? 0) + 90) % 360,
        },
        true
      );
      notify(`Rotated ${room.name} 90°`);
      return;
    }

    // Try nearest valid position near current center without resizing
    const nearest = findNearestValidPosition(room.x, room.y, swappedW, swappedH, floorProject, room.id);
    if (nearest) {
      handleUpdateRoom(
        room.id,
        {
          x: nearest.x,
          y: nearest.y,
          width: swappedW,
          height: swappedH,
          rotation: ((room.rotation ?? 0) + 90) % 360,
        },
        true
      );
      notify(`Rotated ${room.name} 90° and aligned to clear space`);
    } else {
      const msg = `Cannot rotate "${room.name}" 90° here — rotated footprint (${formatLength(swappedW, units)} × ${formatLength(swappedH, units)}) exceeds available space.`;
      setInspectorWarning(msg);
      notify(msg, 'warning');
    }
  };

  const handleDuplicateRoom = (roomId: string) => {
    const room = project.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const spot = findNearestValidPosition(
      room.x + room.width,
      room.y,
      room.width,
      room.height,
      floorProject
    );
    if (!spot) {
      const msg = `No open space available inside the site to duplicate "${room.name}" (${formatLength(room.width, units)} × ${formatLength(room.height, units)}).`;
      setInspectorWarning(msg);
      notify(msg, 'warning');
      return;
    }

    const newId = `rm-${Date.now()}-dup`;
    const sameTypeCount = floorProject.rooms.filter((r) => r.type === room.type).length;
    const copy: RoomZone = {
      ...room,
      id: newId,
      floor: activeFloor,
      name: `${room.name.replace(/\s+\d+$/, '')} ${sameTypeCount + 1}`,
      x: spot.x,
      y: spot.y,
    };

    onUpdateProject((prev) => ({
      ...prev,
      rooms: [...prev.rooms, copy],
    }));
    setSelectedEntity({ kind: 'room', id: newId });
    setInspectorWarning(null);
    notify(`Duplicated room as "${copy.name}"`);
  };

  const handleAddCustomWall = (x1: number, y1: number, x2: number, y2: number) => {
    const { wallThickM } = siteToMeters(project.site);
    const id = `cw-${Date.now()}`;
    onUpdateProject((prev) => ({
      ...prev,
      customWalls: [
        ...prev.customWalls,
        {
          id,
          floor: activeFloor,
          x1,
          y1,
          x2,
          y2,
          thickness: Number(Math.max(0.11, wallThickM * 0.75).toFixed(3)),
          wallKind: 'internal',
        },
      ],
    }));
    setSelectedEntity({ kind: 'wall', id });
    notify(`Added wall on ${formatFloorLabel(activeFloor)} (${formatLength(Math.hypot(x2 - x1, y2 - y1), units)})`);
  };

  const handleUpdateWall = (
    wallId: string,
    patch: { thickness?: number; wallKind?: 'internal' | 'external'; lengthM?: number }
  ) => {
    const wall = project.customWalls.find((w) => w.id === wallId);
    if (!wall) return;
    const { lengthM: siteL, widthM: siteW } = siteToMeters(project.site);

    let x2 = wall.x2;
    let y2 = wall.y2;
    if (patch.lengthM !== undefined && patch.lengthM >= 0.2) {
      const dx = wall.x2 - wall.x1;
      const dy = wall.y2 - wall.y1;
      const curLen = Math.hypot(dx, dy) || 1;
      const ux = dx / curLen;
      const uy = dy / curLen;
      x2 = Number(Math.max(0, Math.min(siteL, wall.x1 + ux * patch.lengthM)).toFixed(3));
      y2 = Number(Math.max(0, Math.min(siteW, wall.y1 + uy * patch.lengthM)).toFixed(3));
    }

    onUpdateProject((prev) => ({
      ...prev,
      customWalls: prev.customWalls.map((w) =>
        w.id === wallId
          ? {
              ...w,
              x2,
              y2,
              thickness: patch.thickness ?? w.thickness,
              wallKind: patch.wallKind ?? w.wallKind,
            }
          : w
      ),
    }));
  };

  const handleAddOpening = (kind: 'door' | 'window', x: number, y: number, rotation: number) => {
    const id = `op-${Date.now()}`;
    onUpdateProject((prev) => ({
      ...prev,
      openings: [
        ...prev.openings,
        {
          id,
          floor: activeFloor,
          kind,
          x,
          y,
          width: kind === 'door' ? 0.92 : 1.5,
          rotation,
        },
      ],
    }));
    setSelectedEntity({ kind: 'opening', id });
    notify(`Placed ${kind} on ${formatFloorLabel(activeFloor)}`);
  };

  const handleUpdateOpening = (
    openingId: string,
    patch: { x?: number; y?: number; width?: number; rotation?: number }
  ) => {
    onUpdateProject((prev) => ({
      ...prev,
      openings: prev.openings.map((op) => (op.id === openingId ? { ...op, ...patch } : op)),
    }));
  };

  const handleAddDimension = (x1: number, y1: number, x2: number, y2: number) => {
    onUpdateProject((prev) => ({
      ...prev,
      dimensions: [
        ...(prev.dimensions ?? []),
        { id: `dim-${Date.now()}`, floor: activeFloor, x1, y1, x2, y2 },
      ],
    }));
    notify(`Added dimension (${formatLength(Math.hypot(x2 - x1, y2 - y1), units)})`);
  };

  const handleEraseEntity = (
    entity: NonNullable<SelectedEntity> | { kind: 'dimension'; id: string }
  ) => {
    const result = eraseEntityFromProject(project, entity);
    if (!result.deleted) return;

    const rm = entity.kind === 'room' ? project.rooms.find((r) => r.id === entity.id) : null;
    const pt = entity.kind === 'point' ? project.points.find((p) => p.id === entity.id) : null;
    const w = entity.kind === 'wire' ? (project.wires ?? []).find((item) => item.id === entity.id) : null;

    onUpdateProject(() => result.project, true);

    if (entity.kind !== 'dimension') {
      setSelectedEntities((prev) =>
        prev.filter((s) => !(s.kind === entity.kind && s.id === entity.id))
      );
    }

    if (entity.kind === 'room') {
      notify(`Deleted room "${rm?.name ?? 'Room'}"`);
    } else if (entity.kind === 'wall') {
      notify('Deleted custom wall');
    } else if (entity.kind === 'opening') {
      notify('Deleted door/window');
    } else if (entity.kind === 'point') {
      notify(
        result.removedWireCount > 0
          ? `Deleted ${pt?.code ?? 'electrical point'} and ${result.removedWireCount} connected cable${result.removedWireCount === 1 ? '' : 's'} (Ctrl+Z to undo)`
          : `Deleted ${pt?.code ?? 'electrical point'} (Ctrl+Z to undo)`
      );
    } else if (entity.kind === 'furniture') {
      notify('Deleted furniture item');
    } else if (entity.kind === 'staircase') {
      notify('Deleted staircase');
    } else if (entity.kind === 'wire') {
      notify(`Deleted cable ${w?.code ?? ''} (connected electrical components preserved)`);
    } else if (entity.kind === 'dimension') {
      notify('Deleted dimension annotation');
    }
  };

  const handleRotateEntity = (entity: NonNullable<SelectedEntity>) => {
    if (entity.kind === 'room') {
      handleRotateRoom(entity.id);
    } else if (entity.kind === 'opening') {
      const op = project.openings.find((o) => o.id === entity.id);
      if (op) {
        handleUpdateOpening(op.id, { rotation: (op.rotation + 90) % 360 });
        notify(`Rotated ${op.kind} 90°`);
      }
    } else if (entity.kind === 'point') {
      const pt = project.points.find((p) => p.id === entity.id);
      if (pt) {
        onUpdateProject((prev) => ({
          ...prev,
          points: prev.points.map((p) =>
            p.id === pt.id ? { ...p, rotation: (p.rotation + 90) % 360 } : p
          ),
        }));
        notify(`Rotated ${pt.code} 90°`);
      }
    } else if (entity.kind === 'furniture') {
      const fn = project.furniture.find((f) => f.id === entity.id);
      if (fn) {
        onUpdateProject((prev) => ({
          ...prev,
          furniture: prev.furniture.map((f) =>
            f.id === fn.id ? { ...f, rotation: (f.rotation + 90) % 360 } : f
          ),
        }));
        notify(`Rotated ${fn.kind.replace('-', ' ')} 90°`);
      }
    } else if (entity.kind === 'staircase') {
      const st = (project.staircases ?? []).find((s) => s.id === entity.id);
      if (st) {
        onUpdateProject((prev) => ({
          ...prev,
          staircases: (prev.staircases ?? []).map((s) =>
            s.id === st.id ? { ...s, rotation: (s.rotation + 90) % 360 } : s
          ),
        }));
        notify(`Rotated ${st.name} 90°`);
      }
    }
  };

  // --- Additive Staircase, Cable Routing, DB/Earthing, Catalogue & Camera Handlers ---

  const handleAddStaircase = (x: number, y: number) => {
    const stair = createDefaultStaircase(project, activeFloor, x, y, 'straight');
    onUpdateProject(
      (prev) => ({
        ...prev,
        staircases: [...(prev.staircases ?? []), stair],
      }),
      true
    );
    setSelectedEntity({ kind: 'staircase', id: stair.id });
    setActiveTool('select');
    notify(
      `Placed ${stair.name} (${getFloorLabel(project, stair.fromFloor)} → ${getFloorLabel(project, stair.toFloor)})`
    );
  };

  const handleMoveStaircase = (staircaseId: string, x: number, y: number) => {
    onUpdateProject(
      (prev) => ({
        ...prev,
        staircases: (prev.staircases ?? []).map((s) =>
          s.id === staircaseId ? { ...s, x, y } : s
        ),
      }),
      false
    );
  };

  const handleUpdateStaircase = (
    staircaseId: string,
    patch: Partial<StaircaseItem>,
    recordHistory = true
  ) => {
    onUpdateProject(
      (prev) => ({
        ...prev,
        staircases: (prev.staircases ?? []).map((s) =>
          s.id === staircaseId ? { ...s, ...patch } : s
        ),
      }),
      recordHistory
    );
  };

  const handleCreateWire = (
    fromPointId: string,
    toPointId: string,
    waypoints: WireWaypoint[]
  ) => {
    const fromPt = project.points.find((p) => p.id === fromPointId);
    const toPt = project.points.find((p) => p.id === toPointId);
    if (!fromPt || !toPt) return;

    if (isDuplicateWireConnection(project.wires ?? [], fromPointId, toPointId, activeWireCategory)) {
      notify(
        `A ${WIRE_CATEGORY_LABELS[activeWireCategory]} wire already connects ${fromPt.code} and ${toPt.code}.`,
        'warning'
      );
      return;
    }

    const pathCheck = validateWireRoutePath(fromPt, toPt, waypoints, project);
    if (!pathCheck.valid) {
      notify(pathCheck.reason ?? 'Cable path is invalid or zero length.', 'warning');
      return;
    }

    const targetCircuit = fromPt.circuit || toPt.circuit;
    const circuitCfg = targetCircuit ? project.circuitCableConfigs?.[targetCircuit] : undefined;

    const newWire = createElectricalWire({
      project,
      fromPoint: fromPt,
      toPoint: toPt,
      waypoints,
      category: activeWireCategory,
      circuit: targetCircuit,
      cableMaterial: circuitCfg?.cableMaterial ?? 'Copper',
      cableSizeSqMm: circuitCfg?.cableSizeSqMm ?? null,
    });

    const enrichedWire: ElectricalWire = {
      ...newWire,
      ...buildCircuitCableWireFields(circuitCfg),
    };

    onUpdateProject(
      (prev) => ({
        ...prev,
        wires: [...(prev.wires ?? []), enrichedWire],
      }),
      true
    );
    setSelectedEntity({ kind: 'wire', id: enrichedWire.id });
    const wireLen = computeWireLengthMeters(enrichedWire, {
      ...project,
      wires: [...(project.wires ?? []), enrichedWire],
    });
    notify(
      `Routed ${enrichedWire.code} (${fromPt.code} → ${toPt.code}, ${wireLen.toFixed(1)} m)`
    );
  };

  const handleUpdateWireWaypoints = (
    wireId: string,
    waypoints: WireWaypoint[],
    recordHistory = false
  ) => {
    onUpdateProject(
      (prev) => ({
        ...prev,
        wires: (prev.wires ?? []).map((w) =>
          w.id === wireId ? { ...w, waypoints } : w
        ),
      }),
      recordHistory
    );
  };

  const handleUpdateWire = (
    wireId: string,
    patch: Partial<ElectricalWire>,
    recordHistory = true
  ) => {
    onUpdateProject(
      (prev) => ({
        ...prev,
        wires: (prev.wires ?? []).map((w) =>
          w.id === wireId ? { ...w, ...patch } : w
        ),
      }),
      recordHistory
    );
  };

  const handleUpdateWiringConfig = (patch: Partial<WiringDisplayConfig>) => {
    onUpdateProject(
      (prev) => {
        const current = getWiringConfig(prev);
        const next: WiringDisplayConfig = { ...current, ...patch };
        // When standard changes, update wire colors that still match the previous standard's default
        const nextWires =
          patch.standard && patch.standard !== current.standard
            ? (prev.wires ?? []).map((w) => ({
                ...w,
                color: WIRE_STANDARD_COLORS[patch.standard!][w.category],
              }))
            : prev.wires;
        return {
          ...prev,
          wiringConfig: next,
          ...(nextWires ? { wires: nextWires } : {}),
        };
      },
      true
    );
  };

  const handleUpdateCircuitCableConfig = (
    circuit: CircuitId,
    patch: Partial<CircuitCableConfig>,
    applyToCircuitWires = true
  ) => {
    onUpdateProject(
      (prev) => applyCircuitCableConfigToProject(prev, circuit, patch, applyToCircuitWires),
      true
    );
  };

  const handleAddMissingDbAndEarthing = () => {
    const res = createDefaultDbAndEarthingPoints(project);
    if (res.added.length === 0) {
      notify('Distribution Board (DB) and Earthing Point are already present in this design.');
      return;
    }
    onUpdateProject(
      (prev) => {
        const built = createDefaultDbAndEarthingPoints(prev);
        return {
          ...prev,
          points: built.nextPoints,
        };
      },
      true
    );
    setSelectedEntity({ kind: 'point', id: res.added[0].id });
    setOpenDrawer('properties');
    notify(
      `Added ${res.added.map((a) => `${a.code} (${a.name})`).join(' & ')} on Ground Floor`
    );
  };

  const handleAutoRouteFromDb = () => {
    const dbCheck = createDefaultDbAndEarthingPoints(project);
    const preparedProject: ProjectData =
      dbCheck.added.length > 0 ? { ...project, points: dbCheck.nextPoints } : project;
    const routed = autoRouteUnwiredCables(preparedProject);
    if (routed.addedCount === 0 && dbCheck.added.length === 0) {
      notify('All branch electrical points are already connected with routed cables.');
      return;
    }
    const nextProj: ProjectData = {
      ...preparedProject,
      wires: routed.nextWires,
    };
    const totalLen = routed.nextWires.reduce(
      (sum, w) => sum + computeWireLengthMeters(w, nextProj),
      0
    );
    onUpdateProject(() => nextProj, true);
    notify(
      `Routed ${routed.addedCount} wall-aligned cable run${routed.addedCount === 1 ? '' : 's'} from DB-1 (Total: ${totalLen.toFixed(1)} m)`
    );
  };

  const handleFitSiteToGeometry = () => {
    const fitted = fitSiteToActualGeometry(project);
    if (!fitted.changed) {
      notify('Site boundary already encloses all room and electrical geometry.');
      return;
    }
    onUpdateProject(
      (prev) => fitSiteToActualGeometry(prev).project,
      true
    );
    notify(
      `Expanded site boundary to ${fitted.nextLength} ${project.site.units} × ${fitted.nextWidth} ${project.site.units} (all rooms preserved)`
    );
  };

  const handleAddCatalogueProductToProject = (product: ProductCatalogueItem) => {
    const mappedType: ElectricalItemType =
      product.mappedItemType ?? inferMappedItemType(product.category) ?? 'switch';
    const cat = CATALOG_MAP[mappedType];
    const targetRoom =
      (selectedRoom && getItemFloor(selectedRoom) === activeFloor ? selectedRoom : null) ??
      floorProject.rooms[0];
    const { lengthM, widthM } = siteToMeters(project.site);

    const existingCount = project.points.filter((p) => p.itemType === mappedType).length + 1;
    const code = `${cat.shortCode}-${String(existingCount).padStart(2, '0')}`;
    const offsetAngle = (existingCount * 1.35) % (Math.PI * 2);
    const rx = targetRoom ? Math.min(targetRoom.width * 0.25, 0.7) : 0.6;
    const ry = targetRoom ? Math.min(targetRoom.height * 0.25, 0.7) : 0.6;
    const px = Number(
      (
        (targetRoom ? targetRoom.x + targetRoom.width / 2 : lengthM / 2) +
        Math.cos(offsetAngle) * rx
      ).toFixed(2)
    );
    const py = Number(
      (
        (targetRoom ? targetRoom.y + targetRoom.height / 2 : widthM / 2) +
        Math.sin(offsetAngle) * ry
      ).toFixed(2)
    );

    const newPoint: ElectricalPoint = {
      id: `pt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      floor: activeFloor,
      code,
      name: `${product.brand || product.manufacturer} ${product.productName}`.trim(),
      itemType: mappedType,
      category: cat.category,
      roomId: targetRoom?.id ?? 'site',
      x: px,
      y: py,
      z: cat.defaultMountHeight,
      rotation: 0,
      wattage: product.wattageW ?? cat.defaultWattage,
      voltage: 230,
      circuit: cat.defaultCircuit,
      unitCost: product.unitPrice ?? 0,
      productId: product.id,
      manufacturer: product.manufacturer,
      brand: product.brand || product.manufacturer,
      modelNumber: product.modelNumber,
      specification: product.specification,
      gstPercent: product.gstPercent ?? undefined,
    };

    onUpdateProject(
      (prev) => ({
        ...prev,
        points: [...prev.points, newPoint],
      }),
      true
    );
    setSelectedEntity({ kind: 'point', id: newPoint.id });
    setCatalogueOpen(false);
    setOpenDrawer('properties');
    notify(
      `Added ${product.manufacturer} ${product.productName} (${code}) to ${getFloorLabel(project, activeFloor)}`
    );
  };

  const handleAssignCableToCircuit = (product: ProductCatalogueItem, circuit: CircuitId) => {
    onUpdateProject((prev) => assignCatalogueCableToCircuit(prev, product, circuit), true);
    setCatalogueOpen(false);
    const priceSuffix =
      product.unitPrice !== null
        ? ` · ₹${product.unitPrice}/${product.unit || 'm'}${
            product.gstPercent !== null ? ` + ${product.gstPercent}% GST` : ''
          }`
        : '';
    notify(
      `Assigned ${product.manufacturer} ${product.productName}${
        product.cableSizeSqMm ? ` (${product.cableSizeSqMm} sq.mm)` : ''
      }${priceSuffix} to ${circuit}`,
      'success'
    );
  };

  const handleSaveCurrentCameraView = () => {
    const captured = captureCameraRef.current?.();
    if (!captured) {
      notify('Switch to 3D Preview to save the current camera angle.', 'warning');
      return;
    }
    const existingCount = (project.savedCameraViews ?? []).length;
    const namedView: SavedCameraView = {
      ...captured,
      name: savedViewLabel.trim() || `View ${existingCount + 1} (${cameraPreset.toUpperCase()})`,
    };
    onUpdateProject(
      (prev) => ({
        ...prev,
        savedCameraViews: [...(prev.savedCameraViews ?? []), namedView],
      }),
      true
    );
    setSavedViewLabel('');
    notify(`Saved 3D camera view "${namedView.name}"`);
  };

  const handleDeleteSavedCameraView = (viewId: string) => {
    onUpdateProject(
      (prev) => ({
        ...prev,
        savedCameraViews: (prev.savedCameraViews ?? []).filter((v) => v.id !== viewId),
      }),
      true
    );
    notify('Removed saved camera view');
  };

  // --- Electrical helpers (preserved & multi-floor aware) ---
  const handlePlaceElectrical = (itemType: ElectricalItemType) => {
    const cat = CATALOG_MAP[itemType];
    const targetRoom =
      (selectedRoom && getItemFloor(selectedRoom) === activeFloor ? selectedRoom : null) ??
      floorProject.rooms[0];
    if (!targetRoom) {
      notify(
        `Create at least one room on ${formatFloorLabel(activeFloor)} first, or click on the 2D floor plan to place electrical items.`,
        'warning'
      );
      setPendingPlaceItem(itemType);
      setViewMode('2d');
      return;
    }

    const existingCount = project.points.filter((p) => p.itemType === itemType).length + 1;
    const code = `${cat.shortCode}-${String(existingCount).padStart(2, '0')}`;
    const offsetAngle = (existingCount * 1.35) % (Math.PI * 2);
    const rx = Math.min(targetRoom.width * 0.28, 0.8);
    const ry = Math.min(targetRoom.height * 0.28, 0.8);
    const px = Number((targetRoom.x + targetRoom.width / 2 + Math.cos(offsetAngle) * rx).toFixed(2));
    const py = Number((targetRoom.y + targetRoom.height / 2 + Math.sin(offsetAngle) * ry).toFixed(2));

    const newPoint: ElectricalPoint = {
      id: `pt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      floor: activeFloor,
      code,
      name: `${cat.label.replace(/s$/, '')} — ${targetRoom.name}`,
      itemType,
      category: cat.category,
      roomId: targetRoom.id,
      x: px,
      y: py,
      z: cat.defaultMountHeight,
      rotation: 0,
      wattage: cat.defaultWattage,
      voltage: 230,
      circuit: cat.defaultCircuit,
      unitCost: cat.unitCost,
    };

    onUpdateProject((prev) => ({
      ...prev,
      points: [...prev.points, newPoint],
      ...(prev.summaryOverrides?.deletedBoqKeys?.includes(itemType)
        ? {
            summaryOverrides: {
              ...prev.summaryOverrides,
              deletedBoqKeys: prev.summaryOverrides.deletedBoqKeys.filter((k) => k !== itemType),
            },
          }
        : {}),
    }));

    setSelectedEntity({ kind: 'point', id: newPoint.id });
    notify(`Placed ${newPoint.name} (${newPoint.wattage} W) on ${formatFloorLabel(activeFloor)}`);
  };

  const handlePlacePointAt = (
    itemType: ElectricalItemType,
    x: number,
    y: number,
    roomId: string
  ) => {
    const cat = CATALOG_MAP[itemType];
    const targetRoom = floorProject.rooms.find((r) => r.id === roomId) ?? floorProject.rooms[0];
    const existingCount = project.points.filter((p) => p.itemType === itemType).length + 1;
    const newPoint: ElectricalPoint = {
      id: `pt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      floor: activeFloor,
      code: `${cat.shortCode}-${String(existingCount).padStart(2, '0')}`,
      name: `${cat.label.replace(/s$/, '')} — ${targetRoom?.name ?? 'Site'}`,
      itemType,
      category: cat.category,
      roomId: targetRoom?.id ?? '',
      x,
      y,
      z: cat.defaultMountHeight,
      rotation: 0,
      wattage: cat.defaultWattage,
      voltage: 230,
      circuit: cat.defaultCircuit,
      unitCost: cat.unitCost,
    };

    onUpdateProject((prev) => ({
      ...prev,
      points: [...prev.points, newPoint],
      ...(prev.summaryOverrides?.deletedBoqKeys?.includes(itemType)
        ? {
            summaryOverrides: {
              ...prev.summaryOverrides,
              deletedBoqKeys: prev.summaryOverrides.deletedBoqKeys.filter((k) => k !== itemType),
            },
          }
        : {}),
    }));
    setSelectedEntity({ kind: 'point', id: newPoint.id });
    setPendingPlaceItem(null);
    notify(`Placed ${newPoint.name} on ${formatFloorLabel(activeFloor)}`);
  };

  const handleUpdateSelectedPoint = (patch: Partial<ElectricalPoint>, recordHistory = false) => {
    if (!selectedPoint) return;
    onUpdateProject(
      (prev) => ({
        ...prev,
        points: prev.points.map((p) => (p.id === selectedPoint.id ? { ...p, ...patch } : p)),
      }),
      recordHistory
    );
  };

  const handleMovePoint = (pointId: string, x: number, y: number, roomId: string) => {
    onUpdateProject(
      (prev) => ({
        ...prev,
        points: prev.points.map((p) =>
          p.id === pointId ? { ...p, x, y, roomId: roomId || p.roomId } : p
        ),
      }),
      false
    );
  };

  // --- Ctrl + Left Click Free Duplication Handlers (2D & 3D) ---
  const handleDuplicatePoint = (pointId: string): ElectricalPoint | null => {
    const src = project.points.find((p) => p.id === pointId);
    if (!src) return null;
    const cat = CATALOG_MAP[src.itemType];
    const targetFloor = getItemFloor(src);
    const { lengthM, widthM } = siteToMeters(project.site);
    const existingCount = project.points.filter((p) => p.itemType === src.itemType).length + 1;
    const shortCode = cat?.shortCode ?? 'PT';
    const nextCode = `${shortCode}-${String(existingCount).padStart(2, '0')}`;

    // Slight visible offset so quick Ctrl+Click clearly separates the duplicate, clamped cleanly
    const nextX = Number(Math.min(lengthM - 0.25, Math.max(0.25, src.x + 0.65)).toFixed(2));
    const nextY = Number(Math.min(widthM - 0.25, Math.max(0.25, src.y + 0.45)).toFixed(2));
    const floorRooms = project.rooms.filter((r) => getItemFloor(r) === targetFloor);
    const targetRoom =
      floorRooms.find(
        (r) => nextX >= r.x && nextX <= r.x + r.width && nextY >= r.y && nextY <= r.y + r.height
      ) ?? floorRooms.find((r) => r.id === src.roomId);

    const duplicated: ElectricalPoint = {
      ...src,
      id: `pt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      floor: targetFloor,
      code: nextCode,
      roomId: targetRoom?.id ?? src.roomId,
      x: nextX,
      y: nextY,
    };

    onUpdateProject((prev) => ({
      ...prev,
      points: [...prev.points, duplicated],
      ...(prev.summaryOverrides?.deletedBoqKeys?.includes(src.itemType)
        ? {
            summaryOverrides: {
              ...prev.summaryOverrides,
              deletedBoqKeys: prev.summaryOverrides.deletedBoqKeys.filter(
                (k) => k !== src.itemType
              ),
            },
          }
        : {}),
    }));
    setSelectedEntity({ kind: 'point', id: duplicated.id });
    notify(`Duplicated ${src.code} as ${duplicated.code} — drag freely to position`);
    return duplicated;
  };

  const handleDuplicateRoomFree = (roomId: string): RoomZone | null => {
    const src = project.rooms.find((r) => r.id === roomId);
    if (!src) return null;
    const targetFloor = getItemFloor(src);
    const sameTypeCount = floorProject.rooms.filter((r) => r.type === src.type).length;
    const spot = findNearestValidPosition(
      src.x + src.width,
      src.y,
      src.width,
      src.height,
      floorProject
    );
    const copy: RoomZone = {
      ...src,
      id: `rm-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      floor: targetFloor,
      name: `${src.name.replace(/\s+\d+$/, '')} ${sameTypeCount + 1}`,
      x: spot ? spot.x : Number((src.x + 0.7).toFixed(2)),
      y: spot ? spot.y : Number((src.y + 0.7).toFixed(2)),
    };
    onUpdateProject((prev) => ({
      ...prev,
      rooms: [...prev.rooms, copy],
    }));
    setSelectedEntity({ kind: 'room', id: copy.id });
    notify(`Duplicated "${src.name}" as "${copy.name}" — drag freely to position`);
    return copy;
  };

  const handleDuplicateOpening = (openingId: string): ArchitecturalOpening | null => {
    const src = project.openings.find((o) => o.id === openingId);
    if (!src) return null;
    const copy: ArchitecturalOpening = {
      ...src,
      id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      floor: getItemFloor(src),
      x: Number((src.x + 0.6).toFixed(2)),
      y: Number((src.y + 0.4).toFixed(2)),
    };
    onUpdateProject((prev) => ({
      ...prev,
      openings: [...prev.openings, copy],
    }));
    setSelectedEntity({ kind: 'opening', id: copy.id });
    notify(`Duplicated ${src.kind} — drag freely to position`);
    return copy;
  };

  const handleMoveOpening = (openingId: string, x: number, y: number) => {
    onUpdateProject(
      (prev) => ({
        ...prev,
        openings: prev.openings.map((o) => (o.id === openingId ? { ...o, x, y } : o)),
      }),
      false
    );
  };

  const handleDuplicateWall = (wallId: string) => {
    const src = project.customWalls.find((w) => w.id === wallId);
    if (!src) return;
    const copy = {
      ...src,
      id: `cw-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      floor: getItemFloor(src),
      x1: Number((src.x1 + 0.5).toFixed(2)),
      y1: Number((src.y1 + 0.5).toFixed(2)),
      x2: Number((src.x2 + 0.5).toFixed(2)),
      y2: Number((src.y2 + 0.5).toFixed(2)),
    };
    onUpdateProject((prev) => ({
      ...prev,
      customWalls: [...prev.customWalls, copy],
    }));
    setSelectedEntity({ kind: 'wall', id: copy.id });
    notify('Duplicated custom wall');
  };

  const handleDuplicateFurniture = (furnitureId: string): FurnitureItem | null => {
    const src = project.furniture.find((f) => f.id === furnitureId);
    if (!src) return null;
    const { lengthM, widthM } = siteToMeters(project.site);
    const copy: FurnitureItem = {
      ...src,
      id: `fn-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      floor: getItemFloor(src),
      x: Number(Math.min(lengthM - 0.4, Math.max(0.4, src.x + 0.7)).toFixed(2)),
      y: Number(Math.min(widthM - 0.4, Math.max(0.4, src.y + 0.5)).toFixed(2)),
    };
    onUpdateProject((prev) => ({
      ...prev,
      furniture: [...prev.furniture, copy],
    }));
    setSelectedEntity({ kind: 'furniture', id: copy.id });
    notify(`Duplicated ${src.kind.replace('-', ' ')} — drag freely to position`);
    return copy;
  };

  const handleMoveFurniture = (furnitureId: string, x: number, y: number, roomId: string) => {
    onUpdateProject(
      (prev) => ({
        ...prev,
        furniture: prev.furniture.map((f) =>
          f.id === furnitureId ? { ...f, x, y, roomId: roomId || f.roomId } : f
        ),
      }),
      false
    );
  };

  const handleUpdateSelectedFurniture = (
    patch: Partial<FurnitureItem>,
    recordHistory = true
  ) => {
    if (!selectedFurniture) return;
    onUpdateProject(
      (prev) => ({
        ...prev,
        furniture: prev.furniture.map((f) =>
          f.id === selectedFurniture.id ? { ...f, ...patch } : f
        ),
      }),
      recordHistory
    );
  };

  // --- Find Component Panel Navigation Handlers ---
  const handleSelectFindResult = (result: StudioSearchResult, index: number) => {
    setFindActiveIndex(index);
    if (result.source === 'placed' && result.entity) {
      handleFocusAndSelectEntity(result.entity);
      notify(`Selected "${result.title}" (${result.badge})`);
    } else if (result.source === 'library') {
      if (result.libraryKind === 'electrical' && result.electricalType) {
        handlePlaceElectrical(result.electricalType);
        setFindOpen(false);
      } else if (result.libraryKind === 'furniture' && result.furnitureKind) {
        handlePlaceFurnitureFromLibrary(result.furnitureKind);
        setFindOpen(false);
      } else if (result.libraryKind === 'room' && result.roomType) {
        setFindOpen(false);
        handleOpenRoomLibraryModal(result.roomType);
      }
    }
  };

  const handleStepFindResult = (delta: 1 | -1) => {
    if (findResults.length === 0) return;
    const nextIdx = (findActiveIndex + delta + findResults.length) % findResults.length;
    setFindActiveIndex(nextIdx);
    const nextRes = findResults[nextIdx];
    if (nextRes?.source === 'placed' && nextRes.entity) {
      handleFocusAndSelectEntity(nextRes.entity);
    }
  };

  const handleSiteChange = <K extends keyof SiteConfig>(field: K, value: SiteConfig[K]) => {
    if (field === 'floors') {
      const safe = setProjectFloorCountSafely(project, Number(value));
      if (safe.blockedReason) {
        notify(safe.blockedReason, 'warning');
        return;
      }
      onUpdateProject(() => safe.project, true);
      return;
    }

    onUpdateProject((prev) => {
      const nextSite = { ...prev.site, [field]: value };
      return {
        ...prev,
        site: nextSite,
      };
    });

    if (field === 'length' || field === 'width') {
      const nextSite = { ...project.site, [field]: value };
      const { lengthM: nextL, widthM: nextW } = siteToMeters(nextSite);
      const overflowRooms = project.rooms.filter(
        (r) => r.x + r.width > nextL + 0.04 || r.y + r.height > nextW + 0.04
      );
      if (overflowRooms.length > 0) {
        notify(
          `Validation Error: ${overflowRooms.length} room(s) now exceed the ${nextSite.length} × ${nextSite.width} ${nextSite.units} site boundary. Resize rooms or expand site dimensions.`,
          'warning'
        );
      }
    }
  };

  const handleSaveAsSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = saveAsName.trim();
    if (trimmed.length < 2 || /[<>:"/\\|?*]/.test(trimmed)) {
      setSaveAsError('Enter a valid project name (2+ characters, no special file characters).');
      return;
    }
    onSaveAsProject(trimmed);
    setShowSaveAsModal(false);
    setSaveAsError(null);
    notify(`Saved project copy as "${trimmed}"`);
  };

  const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result ?? '');
      const preview = projectStorage.parseNativeProjectFile(raw);
      if (!preview) {
        notify(
          `Could not parse "${file.name}". Please select a valid Blue Space (.bluespace or .json) file.`,
          'warning'
        );
        return;
      }
      setImportPreview(preview);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleConfirmSafeImport = (finalName: string) => {
    if (!importPreview) return;
    const renamedProject: ProjectData = {
      ...importPreview.project,
      name: finalName,
    };
    const serialized = projectStorage.exportNativeBluespace(renamedProject);
    const result = onImportProject(serialized);
    setImportPreview(null);
    if (result.ok) {
      notify(`Imported "${finalName}" as a new project (existing projects preserved)`);
    } else {
      notify(result.error ?? 'Failed to import project file.', 'warning');
    }
  };

  const selectedRoomArea = selectedRoom
    ? formatArea(selectedRoom.width * selectedRoom.height, units)
    : '—';

  const inspectorBadgeLabel = allSelected
    ? 'ALL SELECTED'
    : selectedEntities.length > 1
      ? `${selectedEntities.length} SELECTED`
      : selectedRoom
        ? 'ROOM'
        : selectedWall
          ? 'WALL'
          : selectedOpening
            ? selectedOpening.kind
            : selectedStaircase
              ? 'STAIRCASE'
              : selectedWire
                ? 'CABLE'
                : selectedPoint
                  ? selectedPoint.itemType === 'distribution_board'
                    ? 'DIST. BOARD'
                    : selectedPoint.itemType === 'earthing_point'
                      ? 'EARTHING'
                      : 'ELECTRICAL'
                  : selectedFurniture
                    ? 'FURNITURE'
                    : 'SITE';

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden flex flex-col bg-surface text-on-surface">
      {/* Shared Top Navigation */}
      <Navbar
        activeScreen="studio"
        onNavigate={onNavigate}
        compact={true}
      />

      {/* PHASE 3 TOP TOOLBAR */}
      <div className="px-gutter-md py-gutter-xs bg-surface-container-low border-b border-outline-variant flex flex-wrap items-center justify-between gap-gutter-sm">
        {/* Left: Project Selector + Save / Save As / Export */}
        <div className="flex flex-wrap items-center gap-gutter-sm min-w-0">
          <div className="flex items-center gap-gutter-xs bg-surface-container border border-outline-variant rounded-sm px-gutter-sm py-1">
            <span className="material-symbols-outlined text-primary text-[16px] shrink-0" aria-hidden="true">
              folder_open
            </span>
            <select
              aria-label="Active Project"
              value={project.id}
              onChange={(e) => {
                onSwitchProject(e.target.value);
                setSelectedEntity(null);
                setPanOffset({ x: 0, y: 0 });
                setZoom(100);
              }}
              className="bg-transparent font-title text-title-sm text-on-surface focus:outline-none focus:text-primary cursor-pointer truncate max-w-[200px]"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id} className="bg-surface-container text-on-surface">
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={() => {
              onSaveProject();
              notify(`Saved "${project.name}" to workspace`);
            }}
            title="Save Project (Ctrl+S)"
            className="inline-flex items-center gap-1 px-gutter-sm py-1 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
          >
            <span className="material-symbols-outlined text-[15px]" aria-hidden="true">save</span>
            <span>Save</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setSaveAsName(`${project.name} (Copy)`);
              setSaveAsError(null);
              setShowSaveAsModal(true);
            }}
            className="inline-flex items-center gap-1 px-gutter-sm py-1 rounded-sm bg-surface-container border border-outline-variant text-on-surface-variant hover:text-on-surface hover:border-outline font-label text-label-sm cursor-pointer"
          >
            <span className="material-symbols-outlined text-[15px]" aria-hidden="true">save_as</span>
            <span>Save As</span>
          </button>

          {/* AI Drawing Import Direct Entry Point */}
          <button
            type="button"
            onClick={() => setAiDrawingModalOpen(true)}
            title="Convert a PDF, PNG, or JPG drawing into an editable 2D Blue Space model"
            className="inline-flex items-center gap-1 px-gutter-sm py-1 rounded-sm bg-primary-container/40 border border-primary/60 text-primary hover:bg-primary hover:text-on-primary font-label text-label-sm cursor-pointer whitespace-nowrap"
          >
            <span className="material-symbols-outlined text-[15px]" aria-hidden="true">auto_awesome</span>
            <span>AI Drawing Import</span>
          </button>

          {/* Export & Import Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowExportMenu((v) => !v)}
              className="inline-flex items-center gap-1 px-gutter-sm py-1 rounded-sm bg-surface-container border border-outline-variant text-on-surface-variant hover:text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
            >
              <span className="material-symbols-outlined text-[15px]" aria-hidden="true">download</span>
              <span>Export</span>
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">expand_more</span>
            </button>

            {showExportMenu && (
              <div
                className="absolute left-0 top-full mt-1 w-64 z-40 bg-surface-container border border-outline rounded-md shadow-xl py-1 flex flex-col"
                onMouseLeave={() => setShowExportMenu(false)}
              >
                <button
                  type="button"
                  onClick={() => {
                    downloadNativeBluespace(project);
                    setShowExportMenu(false);
                    notify(`Downloaded lossless native project (${project.name}.bluespace)`);
                  }}
                  className="px-gutter-md py-gutter-xs text-left font-label text-label-sm text-primary hover:bg-surface-container-high flex items-center gap-gutter-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-primary text-[16px]">deployed_code</span>
                  <span>Download Native (.bluespace)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    downloadProjectJson(project);
                    setShowExportMenu(false);
                    notify(`Downloaded ${project.name}.json`);
                  }}
                  className="px-gutter-md py-gutter-xs text-left font-label text-label-sm text-on-surface hover:bg-surface-container-high flex items-center gap-gutter-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-primary text-[16px]">data_object</span>
                  <span>Download JSON (.json)</span>
                </button>
                <div className="my-1 border-t border-outline-variant" />
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    setPdfModalOpen(true);
                  }}
                  className="px-gutter-md py-gutter-xs text-left font-label text-label-sm text-secondary hover:bg-surface-container-high flex items-center gap-gutter-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-secondary text-[16px]">auto_stories</span>
                  <span>Drawing Package (Multi-Page PDF)...</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    void downloadExcelBoq(project)
                      .then(() => {
                        notify(
                          `Exported multi-sheet Excel BOQ (.xlsx) for "${project.name}"`,
                          'success'
                        );
                      })
                      .catch((err) => {
                        notify(
                          err instanceof Error
                            ? `Excel BOQ export failed: ${err.message}`
                            : 'Excel BOQ export failed.',
                          'error'
                        );
                      });
                  }}
                  className="px-gutter-md py-gutter-xs text-left font-label text-label-sm text-on-surface hover:bg-surface-container-high flex items-center gap-gutter-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-secondary text-[16px]">table_view</span>
                  <span>Export Excel BOQ (.xlsx)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    downloadFloorPlanPdf(project, activeFloor);
                    setShowExportMenu(false);
                    notify(`Exported ${project.name} (${getFloorLabel(project, activeFloor)}) PDF`);
                  }}
                  className="px-gutter-md py-gutter-xs text-left font-label text-label-sm text-on-surface hover:bg-surface-container-high flex items-center gap-gutter-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-secondary text-[16px]">picture_as_pdf</span>
                  <span>Export Active Floor (PDF)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    downloadFloorPlanPng(project, activeFloor);
                    setShowExportMenu(false);
                    notify(`Exported ${project.name} (${getFloorLabel(project, activeFloor)}) PNG`);
                  }}
                  className="px-gutter-md py-gutter-xs text-left font-label text-label-sm text-on-surface hover:bg-surface-container-high flex items-center gap-gutter-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-primary text-[16px]">image</span>
                  <span>Export Active Floor (PNG)</span>
                </button>
                <div className="my-1 border-t border-outline-variant" />
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    handleExportValidatedDxf();
                  }}
                  className="px-gutter-md py-gutter-xs text-left font-label text-label-sm text-primary hover:bg-surface-container-high flex items-center gap-gutter-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-primary text-[16px]">architecture</span>
                  <span>Export Editable CAD (.dxf)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    void handleExportNativeDwg();
                  }}
                  className={`px-gutter-md py-gutter-xs text-left font-label text-label-sm hover:bg-surface-container-high flex items-center gap-gutter-sm cursor-pointer ${
                    cadCapabilities?.dwgReady ? 'text-on-surface' : 'text-on-surface-variant'
                  }`}
                  title={
                    cadCapabilities?.dwgReady
                      ? `Native DWG via ${cadCapabilities.dwgEngine}`
                      : cadCapabilities?.dwgReason ||
                        'Native DWG requires an installed ODA/LibreDWG converter on the server (DXF is never renamed as DWG)'
                  }
                >
                  <span className="material-symbols-outlined text-[16px]">deployed_code_alert</span>
                  <span>
                    Export Native DWG (.dwg)
                    {!cadCapabilities?.dwgReady ? ' — Needs Engine' : ''}
                  </span>
                </button>
                <div className="my-1 border-t border-outline-variant" />
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    importInputRef.current?.click();
                  }}
                  className="px-gutter-md py-gutter-xs text-left font-label text-label-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high flex items-center gap-gutter-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[16px]">upload_file</span>
                  <span>Import (.bluespace / .json)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    setAiDrawingModalOpen(true);
                  }}
                  className="px-gutter-md py-gutter-xs text-left font-label text-label-sm text-primary hover:bg-surface-container-high flex items-center gap-gutter-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-primary text-[16px]">auto_awesome</span>
                  <span>AI Drawing Import (PDF / Image)...</span>
                </button>
              </div>
            )}
            <input
              ref={importInputRef}
              type="file"
              accept=".bluespace,.json,application/json"
              className="hidden"
              onChange={handleImportFileChange}
            />
          </div>
        </div>

        {/* Right: Simulink Editing Controls (Find, Undo/Redo, Copy/Paste/Duplicate/Rotate/Delete/Select All), Zoom, 2D/3D, Summary */}
        <div className="flex flex-wrap items-center gap-gutter-xs">
          {/* Find Component (Ctrl+F) */}
          <button
            type="button"
            onClick={() => {
              setOpenDrawer(null);
              setFindOpen((prev) => !prev);
            }}
            title="Find Component (Ctrl+F)"
            aria-label="Find Component"
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-sm border font-label text-label-sm cursor-pointer whitespace-nowrap transition-colors ${
              findOpen
                ? 'bg-primary text-on-primary border-primary'
                : 'bg-surface-container border-outline-variant text-on-surface-variant hover:text-primary hover:border-primary'
            }`}
          >
            <span className="material-symbols-outlined text-[15px]" aria-hidden="true">search</span>
            <span>Find</span>
            <span className="font-mono text-[10px] opacity-75 hidden xl:inline">Ctrl+F</span>
          </button>

          {/* Component Operations: Rotate / Delete */}
          <div className="inline-flex items-center rounded-sm border border-outline-variant bg-surface-container">
            <button
              type="button"
              disabled={selectedEntities.length === 0 && !allSelected}
              onClick={handleRotateSelection}
              title="Rotate Selected 90°"
              aria-label="Rotate Selected"
              className="px-1.5 py-1 text-on-surface-variant hover:text-primary hover:bg-surface-container-high border-r border-outline-variant disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined text-[15px]" aria-hidden="true">rotate_right</span>
            </button>
            <button
              type="button"
              disabled={selectedEntities.length === 0 && !allSelected}
              onClick={handleDeleteSelection}
              title="Delete Selected (Delete / Backspace)"
              aria-label="Delete Selected"
              className="px-1.5 py-1 text-on-surface-variant hover:text-error hover:bg-error/10 disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined text-[15px]" aria-hidden="true">delete</span>
            </button>
          </div>

          {/* Zoom In / Out / Fit to Screen */}
          <div className="inline-flex items-center rounded-sm border border-outline-variant bg-surface-container">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(40, z - 15))}
              title="Zoom Out"
              aria-label="Zoom Out"
              className="px-1.5 py-1 text-on-surface-variant hover:text-on-surface cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">zoom_out</span>
            </button>
            <span className="px-1.5 font-mono text-mono-sm text-on-surface tabular-nums">
              {zoom}%
            </span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(250, z + 15))}
              title="Zoom In"
              aria-label="Zoom In"
              className="px-1.5 py-1 text-on-surface-variant hover:text-on-surface cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">zoom_in</span>
            </button>
            <button
              type="button"
              onClick={handleFitToScreen}
              title="Fit to Screen"
              className="px-2 py-1 border-l border-outline-variant font-label text-label-sm text-on-surface-variant hover:text-primary cursor-pointer"
            >
              Fit
            </button>
          </div>

          {/* Separate Dropdown 1: View Mode (2D View / 3D Preview) */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setShowExportMenu(false);
                setOpenToolbarDropdown((prev) => (prev === 'view' ? null : 'view'));
              }}
              title="Switch between 2D View and 3D Preview"
              className="inline-flex items-center gap-1 px-gutter-sm py-1 rounded-sm bg-primary text-on-primary border border-primary font-label text-label-sm cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
                {viewMode === '2d' ? 'grid_on' : 'view_in_ar'}
              </span>
              <span>{viewMode === '2d' ? '2D View' : '3D Preview'}</span>
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">expand_more</span>
            </button>

            {openToolbarDropdown === 'view' && (
              <div
                className="absolute right-0 top-full mt-1 w-44 z-40 bg-surface-container border border-outline rounded-md shadow-xl py-1 flex flex-col"
                onMouseLeave={() => setOpenToolbarDropdown(null)}
              >
                <button
                  type="button"
                  onClick={() => {
                    setViewMode('2d');
                    setOpenToolbarDropdown(null);
                  }}
                  className={`px-gutter-md py-gutter-xs text-left font-label text-label-sm hover:bg-surface-container-high flex items-center justify-between gap-2 cursor-pointer ${
                    viewMode === '2d' ? 'text-primary' : 'text-on-surface'
                  }`}
                >
                  <span className="inline-flex items-center gap-gutter-xs">
                    <span className="material-symbols-outlined text-[16px]" aria-hidden="true">grid_on</span>
                    <span>2D View</span>
                  </span>
                  {viewMode === '2d' && (
                    <span className="material-symbols-outlined text-[15px]" aria-hidden="true">check</span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpenToolbarDropdown(null);
                    requestSwitchTo3D();
                  }}
                  className={`px-gutter-md py-gutter-xs text-left font-label text-label-sm hover:bg-surface-container-high flex items-center justify-between gap-2 cursor-pointer ${
                    viewMode === '3d' ? 'text-primary' : 'text-on-surface'
                  }`}
                >
                  <span className="inline-flex items-center gap-gutter-xs">
                    <span className="material-symbols-outlined text-[16px]" aria-hidden="true">view_in_ar</span>
                    <span>
                      3D Preview
                      {project.aiDrawingImport?.approvedFor3D === false ? ' (Approve 2D)' : ''}
                    </span>
                  </span>
                  {viewMode === '3d' && (
                    <span className="material-symbols-outlined text-[15px]" aria-hidden="true">check</span>
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Separate Dropdown 2: 3D Camera Mode & Architectural Projections */}
          {viewMode === '3d' && (
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setShowExportMenu(false);
                  setOpenToolbarDropdown((prev) => (prev === 'camera' ? null : 'camera'));
                }}
                title="3D Camera Modes, Elevations & Saved Views"
                className="inline-flex items-center gap-1 px-gutter-sm py-1 rounded-sm bg-surface-container border border-outline-variant text-on-surface hover:border-primary font-label text-label-sm cursor-pointer whitespace-nowrap"
              >
                <span className="material-symbols-outlined text-primary text-[15px]" aria-hidden="true">
                  {cameraMode === 'fps' ? 'directions_walk' : '3d_rotation'}
                </span>
                <span>
                  {cameraMode === 'fps'
                    ? 'Walk'
                    : cameraPreset === 'perspective'
                      ? 'Orbit'
                      : cameraPreset.charAt(0).toUpperCase() + cameraPreset.slice(1)}
                </span>
                <span className="material-symbols-outlined text-[14px] text-on-surface-variant" aria-hidden="true">
                  expand_more
                </span>
              </button>

              {openToolbarDropdown === 'camera' && (
                <div
                  className="absolute right-0 top-full mt-1 w-64 z-40 bg-surface-container border border-outline rounded-md shadow-xl py-1 flex flex-col max-h-[75vh] overflow-y-auto"
                >
                  <div className="px-gutter-md py-1 font-mono text-[10px] uppercase text-on-surface-variant">
                    Navigation Modes
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setCameraMode('orbit');
                      setCameraPreset('perspective');
                      setAppliedSavedView(null);
                      setOpenToolbarDropdown(null);
                    }}
                    className={`px-gutter-md py-gutter-xs text-left font-label text-label-sm hover:bg-surface-container-high flex items-center justify-between gap-2 cursor-pointer ${
                      cameraMode === 'orbit' && cameraPreset === 'perspective' ? 'text-primary' : 'text-on-surface'
                    }`}
                  >
                    <span className="inline-flex items-center gap-gutter-xs">
                      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">3d_rotation</span>
                      <span>Perspective Orbit</span>
                    </span>
                    {cameraMode === 'orbit' && cameraPreset === 'perspective' && (
                      <span className="material-symbols-outlined text-[15px]" aria-hidden="true">check</span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCameraMode('fps');
                      setCameraPreset('perspective');
                      setAppliedSavedView(null);
                      setOpenToolbarDropdown(null);
                      requestFpsPointerLockRef.current?.();
                      notify(
                        `Entered First-Person Navigation (1.65m eye level) on ${getFloorLabel(project, activeFloor)} — Mouse to look, WASD to move, ESC to exit`
                      );
                    }}
                    className={`px-gutter-md py-gutter-xs text-left font-label text-label-sm hover:bg-surface-container-high flex items-center justify-between gap-2 cursor-pointer ${
                      cameraMode === 'fps' ? 'text-primary' : 'text-on-surface'
                    }`}
                  >
                    <span className="inline-flex items-center gap-gutter-xs">
                      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">directions_walk</span>
                      <span>Walk (E)</span>
                    </span>
                    {cameraMode === 'fps' && (
                      <span className="material-symbols-outlined text-[15px]" aria-hidden="true">check</span>
                    )}
                  </button>

                  <div className="my-1 border-t border-outline-variant" />
                  <div className="px-gutter-md py-1 font-mono text-[10px] uppercase text-on-surface-variant">
                    Orthographic &amp; Elevation Views
                  </div>
                  {(
                    [
                      { id: 'top', label: 'Orthographic Top', icon: 'vertical_align_top' },
                      { id: 'isometric', label: 'Isometric 3D', icon: 'view_in_ar' },
                      { id: 'front', label: 'Front Elevation', icon: 'crop_landscape' },
                      { id: 'rear', label: 'Rear Elevation', icon: 'flip' },
                      { id: 'left', label: 'Left Elevation', icon: 'west' },
                      { id: 'right', label: 'Right Elevation', icon: 'east' },
                    ] as const
                  ).map((preset) => {
                    const active = cameraMode === 'orbit' && cameraPreset === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => {
                          setCameraMode('orbit');
                          setCameraPreset(preset.id);
                          setAppliedSavedView(null);
                          setOpenToolbarDropdown(null);
                          notify(`Switched 3D camera to ${preset.label}`);
                        }}
                        className={`px-gutter-md py-gutter-xs text-left font-label text-label-sm hover:bg-surface-container-high flex items-center justify-between gap-2 cursor-pointer ${
                          active ? 'text-primary' : 'text-on-surface'
                        }`}
                      >
                        <span className="inline-flex items-center gap-gutter-xs">
                          <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
                            {preset.icon}
                          </span>
                          <span>{preset.label}</span>
                        </span>
                        {active && (
                          <span className="material-symbols-outlined text-[15px]" aria-hidden="true">check</span>
                        )}
                      </button>
                    );
                  })}

                  <div className="my-1 border-t border-outline-variant" />
                  <div className="px-gutter-md py-1 font-mono text-[10px] uppercase text-on-surface-variant">
                    Saved Camera Views ({(project.savedCameraViews ?? []).length})
                  </div>
                  <div className="px-gutter-sm py-1 flex items-center gap-1">
                    <input
                      type="text"
                      placeholder="Angle name..."
                      value={savedViewLabel}
                      onChange={(e) => setSavedViewLabel(e.target.value)}
                      className="flex-1 min-w-0 bg-surface border border-outline rounded-sm px-2 py-1 font-body text-xs text-on-surface focus:border-primary focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleSaveCurrentCameraView}
                      className="px-2 py-1 rounded-sm bg-primary text-on-primary font-label text-[11px] cursor-pointer whitespace-nowrap"
                    >
                      Save
                    </button>
                  </div>
                  {(project.savedCameraViews ?? []).length > 0 && (
                    <div className="flex flex-col px-1 pb-1 gap-0.5">
                      {(project.savedCameraViews ?? []).map((sv) => (
                        <div
                          key={sv.id}
                          className="flex items-center justify-between gap-1 px-2 py-1 rounded-sm hover:bg-surface-container-high"
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setCameraMode('orbit');
                              setCameraPreset(sv.preset);
                              setAppliedSavedView({ ...sv });
                              setOpenToolbarDropdown(null);
                              notify(`Loaded saved view "${sv.name}"`);
                            }}
                            className="flex-1 text-left font-body text-xs text-on-surface truncate cursor-pointer"
                          >
                            {sv.name}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteSavedCameraView(sv.id)}
                            title="Delete saved view"
                            className="text-on-surface-variant hover:text-error cursor-pointer"
                          >
                            <span className="material-symbols-outlined text-[14px]">delete</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Separate Dropdown 3: 3D Sky & Atmosphere (Sunrise / Sun / Sunset / Night) */}
          {viewMode === '3d' && (
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setShowExportMenu(false);
                  setOpenToolbarDropdown((prev) => (prev === 'sky' ? null : 'sky'));
                }}
                title="3D Sky & Atmosphere Effects"
                className="inline-flex items-center gap-1 px-gutter-sm py-1 rounded-sm bg-surface-container border border-outline-variant text-on-surface hover:border-secondary font-label text-label-sm cursor-pointer whitespace-nowrap"
              >
                <span className="material-symbols-outlined text-secondary text-[15px]" aria-hidden="true">
                  {lightingMode === 'sunrise'
                    ? 'wb_twilight'
                    : lightingMode === 'daylight'
                      ? 'light_mode'
                      : lightingMode === 'sunset'
                        ? 'wb_sunny'
                        : 'dark_mode'}
                </span>
                <span>
                  {lightingMode === 'sunrise'
                    ? 'Sunrise'
                    : lightingMode === 'daylight'
                      ? 'Sun'
                      : lightingMode === 'sunset'
                        ? 'Sunset'
                        : 'Night'}
                </span>
                <span className="material-symbols-outlined text-[14px] text-on-surface-variant" aria-hidden="true">
                  expand_more
                </span>
              </button>

              {openToolbarDropdown === 'sky' && (
                <div
                  className="absolute right-0 top-full mt-1 w-48 z-40 bg-surface-container border border-outline rounded-md shadow-xl py-1 flex flex-col"
                  onMouseLeave={() => setOpenToolbarDropdown(null)}
                >
                  {(
                    [
                      { id: 'sunrise', label: 'Sunrise', icon: 'wb_twilight', title: 'Golden Sunrise with Clouds & Birds' },
                      { id: 'daylight', label: 'Sun (Daylight)', icon: 'light_mode', title: 'Sunlit Daylight Sky with Clouds & Birds' },
                      { id: 'sunset', label: 'Sunset', icon: 'wb_sunny', title: 'Warm Sunset Sky with Clouds & Soaring Birds' },
                      { id: 'evening', label: 'Night', icon: 'dark_mode', title: 'Starlit Night Sky with Interior Lighting' },
                    ] as const
                  ).map((sky) => {
                    const active = lightingMode === sky.id;
                    return (
                      <button
                        key={sky.id}
                        type="button"
                        title={sky.title}
                        onClick={() => {
                          setLightingMode(sky.id);
                          setOpenToolbarDropdown(null);
                        }}
                        className={`px-gutter-md py-gutter-xs text-left font-label text-label-sm hover:bg-surface-container-high flex items-center justify-between gap-2 cursor-pointer ${
                          active ? 'text-secondary' : 'text-on-surface'
                        }`}
                      >
                        <span className="inline-flex items-center gap-gutter-xs">
                          <span className="material-symbols-outlined text-secondary text-[16px]" aria-hidden="true">
                            {sky.icon}
                          </span>
                          <span>{sky.label}</span>
                        </span>
                        {active && (
                          <span className="material-symbols-outlined text-[15px]" aria-hidden="true">check</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Drawing Instructions Guide */}
          <button
            type="button"
            onClick={() => setShowGuideModal(true)}
            title="How to Work on Drawings & Multi-Floor Models"
            className="inline-flex items-center gap-1 px-gutter-sm py-1 rounded-sm bg-surface-container border border-outline-variant text-on-surface-variant hover:text-primary hover:border-primary font-label text-label-sm cursor-pointer whitespace-nowrap"
          >
            <span className="material-symbols-outlined text-[15px]" aria-hidden="true">menu_book</span>
            <span>Guide</span>
          </button>
        </div>
      </div>

      {/* MAIN CAD WORKSPACE (Full-width canvas; Properties Inspector opens as a dropdown) */}
      <div className="flex-1 flex flex-col min-h-0 relative">
        {/* PRIMARY WORKSPACE: A. Drawing Tools + B/C/D Drawers + Properties Dropdown + Floor Strip + Full-Width 2D/3D Canvas */}
        <main className="flex-1 min-w-0 min-h-[520px] lg:min-h-0 bg-surface cad-grid relative flex flex-col p-gutter-sm gap-gutter-xs">
          {/* Summary Components Row with A. Drawing Tools positioned beside B. Room Library */}
          <div className="flex flex-wrap items-center justify-between gap-gutter-xs z-30">
            <div className="flex flex-wrap items-center gap-gutter-xs">
              {/* A. DRAWING TOOLS */}
              <details
                open={openDrawer === 'tools'}
                className="relative group bg-surface-container border border-outline-variant rounded-md"
              >
                <summary
                  onClick={(e) => {
                    e.preventDefault();
                    setOpenDrawer((prev) => (prev === 'tools' ? null : 'tools'));
                  }}
                  className={`flex items-center gap-1.5 px-gutter-sm py-1.5 cursor-pointer list-none select-none hover:bg-surface-container-high rounded-md ${
                    openDrawer === 'tools' ? 'bg-surface-container-high border-primary' : ''
                  }`}
                >
                  <span className="material-symbols-outlined text-primary text-[15px]" aria-hidden="true">
                    architecture
                  </span>
                  <span className="font-label text-label-sm text-primary uppercase tracking-wider whitespace-nowrap">
                    A. Drawing Tools
                  </span>
                  <span
                    className="material-symbols-outlined text-on-surface-variant text-[16px] transition-transform duration-panel-toggle group-open:rotate-180"
                    aria-hidden="true"
                  >
                    expand_more
                  </span>
                </summary>
                <div className="absolute left-0 top-full mt-1 w-64 z-40 bg-surface-container border border-outline rounded-md shadow-2xl p-gutter-xs grid grid-cols-2 gap-1">
                  {DRAWING_TOOLS.map((tool) => {
                    const isActive = activeTool === tool.id && !pendingPlaceItem;
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        onClick={() => {
                          handleSelectTool(tool.id);
                          setOpenDrawer(null);
                        }}
                        className={`flex items-center gap-1.5 px-2 py-1.5 rounded-sm border text-left transition-colors cursor-pointer ${
                          isActive
                            ? 'bg-primary-container border-primary text-primary'
                            : 'bg-surface-container-low border-outline-variant text-on-surface-variant hover:border-outline hover:text-on-surface'
                        }`}
                      >
                        <span className="material-symbols-outlined text-[15px] shrink-0" aria-hidden="true">
                          {tool.icon}
                        </span>
                        <span className="font-label text-label-sm truncate">{tool.label}</span>
                      </button>
                    );
                  })}
                </div>
              </details>

              {/* B. ROOM LIBRARY (15 Architectural Rooms) */}
              <details
                open={openDrawer === 'rooms'}
                className="relative group bg-surface-container border border-outline-variant rounded-md"
              >
                <summary
                  onClick={(e) => {
                    e.preventDefault();
                    setOpenDrawer((prev) => (prev === 'rooms' ? null : 'rooms'));
                  }}
                  className={`flex items-center gap-1.5 px-gutter-sm py-1.5 cursor-pointer list-none select-none hover:bg-surface-container-high rounded-md ${
                    openDrawer === 'rooms' ? 'bg-surface-container-high border-primary' : ''
                  }`}
                >
                  <span className="material-symbols-outlined text-primary text-[15px]" aria-hidden="true">
                    meeting_room
                  </span>
                  <span className="font-label text-label-sm text-primary uppercase tracking-wider whitespace-nowrap">
                    B. Room Library ({ROOM_LIBRARY.length})
                  </span>
                  <span
                    className="material-symbols-outlined text-on-surface-variant text-[16px] transition-transform duration-panel-toggle group-open:rotate-180"
                    aria-hidden="true"
                  >
                    expand_more
                  </span>
                </summary>
                <div className="absolute left-0 top-full mt-1 w-64 max-h-80 overflow-y-auto z-40 bg-surface-container border border-outline rounded-md shadow-2xl p-gutter-xs flex flex-col gap-1">
                  {ROOM_LIBRARY.map((rm) => (
                    <button
                      key={rm.type}
                      type="button"
                      onClick={() => {
                        setOpenDrawer(null);
                        handleOpenRoomLibraryModal(rm.type);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-sm bg-surface-container-low border border-outline-variant hover:border-primary text-left transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="material-symbols-outlined text-primary text-[16px] shrink-0" aria-hidden="true">
                          {rm.icon}
                        </span>
                        <span className="font-body text-body-sm text-on-surface truncate">
                          {rm.label}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-on-surface-variant shrink-0">
                        {units === 'ft'
                          ? `${rm.defaultLengthFt}×${rm.defaultWidthFt}'`
                          : `${rm.defaultW.toFixed(1)}×${rm.defaultH.toFixed(1)}m`}
                      </span>
                    </button>
                  ))}
                </div>
              </details>

              {/* C. SITE PARAMETERS */}
              <details
                open={openDrawer === 'site'}
                className="relative group bg-surface-container border border-outline-variant rounded-md"
              >
                <summary
                  onClick={(e) => {
                    e.preventDefault();
                    setOpenDrawer((prev) => (prev === 'site' ? null : 'site'));
                  }}
                  className={`flex items-center gap-1.5 px-gutter-sm py-1.5 cursor-pointer list-none select-none hover:bg-surface-container-high rounded-md ${
                    openDrawer === 'site' ? 'bg-surface-container-high' : ''
                  }`}
                >
                  <span className="material-symbols-outlined text-on-surface-variant text-[15px]" aria-hidden="true">
                    square_foot
                  </span>
                  <span className="font-label text-label-sm text-on-surface uppercase tracking-wider whitespace-nowrap">
                    C. Site Parameters
                  </span>
                  <span
                    className="material-symbols-outlined text-on-surface-variant text-[16px] transition-transform duration-panel-toggle group-open:rotate-180"
                    aria-hidden="true"
                  >
                    expand_more
                  </span>
                </summary>
                <div className="absolute left-0 top-full mt-1 w-64 z-40 bg-surface-container border border-outline rounded-md shadow-2xl p-gutter-sm grid grid-cols-2 gap-gutter-xs">
                  <label className="flex flex-col gap-0.5">
                    <span className="font-label text-[11px] text-on-surface-variant">Length ({unitShort})</span>
                    <input
                      type="number"
                      step="0.5"
                      min={1}
                      value={project.site.length}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        if (!raw) return;
                        const parsed = Number(raw);
                        if (!Number.isFinite(parsed) || parsed < 1) return;
                        handleSiteChange('length', parsed);
                      }}
                      className="w-full bg-surface border border-outline rounded-sm px-2 py-1 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="font-label text-[11px] text-on-surface-variant">Width ({unitShort})</span>
                    <input
                      type="number"
                      step="0.5"
                      min={1}
                      value={project.site.width}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        if (!raw) return;
                        const parsed = Number(raw);
                        if (!Number.isFinite(parsed) || parsed < 1) return;
                        handleSiteChange('width', parsed);
                      }}
                      className="w-full bg-surface border border-outline rounded-sm px-2 py-1 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="font-label text-[11px] text-on-surface-variant">Ceiling ({unitShort})</span>
                    <input
                      type="number"
                      step="0.5"
                      min={2}
                      value={project.site.ceilingHeight}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        if (!raw) return;
                        const parsed = Number(raw);
                        if (!Number.isFinite(parsed) || parsed < 2) return;
                        handleSiteChange('ceilingHeight', parsed);
                      }}
                      className="w-full bg-surface border border-outline rounded-sm px-2 py-1 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="font-label text-[11px] text-on-surface-variant">
                      Wall ({units === 'ft' ? 'in' : 'm'})
                    </span>
                    <input
                      type="number"
                      step={units === 'ft' ? '1' : '0.02'}
                      min={units === 'ft' ? 2 : 0.05}
                      value={
                        units === 'ft'
                          ? Math.round(project.site.wallThickness * 12)
                          : Number(project.site.wallThickness.toFixed(2))
                      }
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v) || v <= 0) return;
                        handleSiteChange(
                          'wallThickness',
                          units === 'ft' ? Number((v / 12).toFixed(3)) : Number(v.toFixed(3))
                        );
                      }}
                      className="w-full bg-surface border border-outline rounded-sm px-2 py-1 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="font-label text-[11px] text-on-surface-variant">Units</span>
                    <select
                      value={project.site.units}
                      onChange={(e) => {
                        const nextU = e.target.value as UnitSystem;
                        if (nextU === project.site.units) return;
                        const factor = nextU === 'm' ? FT_TO_M : M_TO_FT;
                        onUpdateProject((prev) => ({
                          ...prev,
                          site: {
                            ...prev.site,
                            units: nextU,
                            length: Number((prev.site.length * factor).toFixed(1)),
                            width: Number((prev.site.width * factor).toFixed(1)),
                            ceilingHeight: Number((prev.site.ceilingHeight * factor).toFixed(1)),
                            wallThickness: Number((prev.site.wallThickness * factor).toFixed(3)),
                          },
                        }));
                      }}
                      className="w-full bg-surface border border-outline rounded-sm px-2 py-1 font-mono text-mono-sm text-on-surface focus:border-primary focus:outline-none"
                    >
                      <option value="ft">Feet (ft)</option>
                      <option value="m">Metres (m)</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="font-label text-[11px] text-on-surface-variant">Floors</span>
                    <input
                      type="number"
                      min={1}
                      max={8}
                      value={projectFloors.length}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        if (!raw) return;
                        const parsed = Number(raw);
                        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 8) return;
                        handleSiteChange('floors', parsed);
                      }}
                      className="w-full bg-surface border border-outline rounded-sm px-2 py-1 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                    />
                  </label>
                  <label className="col-span-2 flex items-center gap-1.5 pt-1 border-t border-outline-variant cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(project.site.allowFloorExceedSite)}
                      onChange={(e) =>
                        onUpdateProject(
                          (prev) => ({
                            ...prev,
                            site: {
                              ...prev.site,
                              allowFloorExceedSite: e.target.checked,
                            },
                          }),
                          true
                        )
                      }
                      className="accent-primary"
                    />
                    <span className="font-label text-[10px] text-on-surface-variant">
                      Allow floor overhangs beyond site
                    </span>
                  </label>
                  {(() => {
                    const geomBounds = computeActualGeometryBounds(project);
                    if (!geomBounds.exceedsSite) return null;
                    return (
                      <div className="col-span-2 mt-0.5 p-1.5 rounded-sm bg-error/10 border border-error/60 flex flex-col gap-1">
                        <span className="font-mono text-[10px] text-error leading-snug">
                          Geometry ({formatLength(geomBounds.spanXM, units, 1)} × {formatLength(geomBounds.spanYM, units, 1)}) exceeds site ({project.site.length} × {project.site.width} {unitShort}).
                        </span>
                        <button
                          type="button"
                          onClick={handleFitSiteToGeometry}
                          className="w-full inline-flex items-center justify-center gap-1 px-2 py-1 rounded-sm bg-primary text-on-primary font-label text-[10px] font-semibold cursor-pointer hover:brightness-110"
                        >
                          <span className="material-symbols-outlined text-[13px]" aria-hidden="true">fit_screen</span>
                          Fit Site to Geometry
                        </button>
                      </div>
                    );
                  })()}
                </div>
              </details>

              {/* D. ELECTRICAL LIBRARY */}
              <details
                open={openDrawer === 'electrical'}
                className="relative group bg-surface-container border border-outline-variant rounded-md"
              >
                <summary
                  onClick={(e) => {
                    e.preventDefault();
                    setOpenDrawer((prev) => (prev === 'electrical' ? null : 'electrical'));
                  }}
                  className={`flex items-center gap-1.5 px-gutter-sm py-1.5 cursor-pointer list-none select-none hover:bg-surface-container-high rounded-md ${
                    openDrawer === 'electrical' ? 'bg-surface-container-high' : ''
                  }`}
                >
                  <span className="material-symbols-outlined text-secondary text-[15px]" aria-hidden="true">
                    bolt
                  </span>
                  <span className="font-label text-label-sm text-secondary uppercase tracking-wider whitespace-nowrap">
                    D. Electrical Library ({ELECTRICAL_CATALOG.length})
                  </span>
                  <span
                    className="material-symbols-outlined text-on-surface-variant text-[16px] transition-transform duration-panel-toggle group-open:rotate-180"
                    aria-hidden="true"
                  >
                    expand_more
                  </span>
                </summary>
                <div className="absolute left-0 top-full mt-1 w-72 max-h-96 overflow-y-auto z-40 bg-surface-container border border-outline rounded-md shadow-2xl p-gutter-xs flex flex-col gap-1">
                  {/* Multi-Brand Product Catalogue Launcher */}
                  <button
                    type="button"
                    onClick={() => {
                      setOpenDrawer(null);
                      setCatalogueOpen(true);
                    }}
                    className="w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-sm bg-primary-container/35 border border-primary text-primary hover:bg-primary-container/50 text-left transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="material-symbols-outlined text-[16px] shrink-0" aria-hidden="true">
                        inventory_2
                      </span>
                      <span className="font-label text-label-sm truncate">
                        Multi-Brand Product Catalogue
                      </span>
                    </div>
                    <span className="font-mono text-[10px] shrink-0">13 Brands</span>
                  </button>

                  {(!hasDbPoint || !hasEarthingPoint) && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpenDrawer(null);
                        handleAddMissingDbAndEarthing();
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-sm bg-secondary-container/30 border border-secondary text-secondary hover:bg-secondary-container/45 text-left transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="material-symbols-outlined text-[15px] shrink-0" aria-hidden="true">
                          electrical_services
                        </span>
                        <span className="font-label text-label-sm truncate">
                          Add Missing {!hasDbPoint && !hasEarthingPoint ? 'DB & Earthing' : !hasDbPoint ? 'Distribution Board' : 'Earthing Point'}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] shrink-0">GF</span>
                    </button>
                  )}

                  <div className="my-0.5 border-t border-outline-variant" />

                  {ELECTRICAL_CATALOG.map((item) => (
                    <button
                      key={item.itemType}
                      type="button"
                      onClick={() => {
                        setOpenDrawer(null);
                        handlePlaceElectrical(item.itemType);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-sm bg-surface-container-low border border-outline-variant hover:border-secondary text-left transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="material-symbols-outlined text-secondary text-[15px] shrink-0" aria-hidden="true">
                          {item.icon}
                        </span>
                        <span className="font-body text-body-sm text-on-surface truncate">
                          {item.label}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-on-surface-variant shrink-0">
                        {item.defaultWattage > 0 ? `${item.defaultWattage}W` : item.shortCode}
                      </span>
                    </button>
                  ))}
                </div>
              </details>

              {/* E. WIRING, CABLE SIZES & VALIDATION */}
              <details
                open={openDrawer === 'wiring'}
                className="relative group bg-surface-container border border-outline-variant rounded-md"
              >
                <summary
                  onClick={(e) => {
                    e.preventDefault();
                    setOpenDrawer((prev) => (prev === 'wiring' ? null : 'wiring'));
                  }}
                  className={`flex items-center gap-1.5 px-gutter-sm py-1.5 cursor-pointer list-none select-none hover:bg-surface-container-high rounded-md ${
                    openDrawer === 'wiring' ? 'bg-surface-container-high' : ''
                  }`}
                >
                  <span className="material-symbols-outlined text-secondary text-[15px]" aria-hidden="true">
                    cable
                  </span>
                  <span className="font-label text-label-sm text-on-surface uppercase tracking-wider whitespace-nowrap">
                    E. Wiring &amp; Cables ({(project.wires ?? []).length})
                  </span>
                  {validationIssues.length > 0 && (
                    <span className="px-1.5 py-0.2 rounded-full bg-secondary-container text-secondary font-mono text-[10px]">
                      {validationIssues.length}
                    </span>
                  )}
                  <span
                    className="material-symbols-outlined text-on-surface-variant text-[16px] transition-transform duration-panel-toggle group-open:rotate-180"
                    aria-hidden="true"
                  >
                    expand_more
                  </span>
                </summary>
                <div
                  onPointerDown={(e) => e.stopPropagation()}
                  className="absolute left-0 top-full mt-1 w-[340px] max-w-[92vw] max-h-[72vh] overflow-y-auto z-40 bg-surface-container border border-outline rounded-md shadow-2xl p-gutter-sm flex flex-col gap-2.5"
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        handleSelectTool('add-wire');
                        setOpenDrawer(null);
                      }}
                      className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-sm border font-label text-label-sm cursor-pointer ${
                        activeTool === 'add-wire'
                          ? 'bg-secondary text-on-secondary border-secondary'
                          : 'bg-secondary-container/30 border-secondary text-secondary hover:bg-secondary-container/50'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[15px]">cable</span>
                      <span>Route Cable</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        handleAutoRouteFromDb();
                      }}
                      title="Generate obstacle-aware editable cable runs from Main Distribution Board (DB-1) to unwired circuit points"
                      className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-primary-container/30 border border-primary text-primary hover:bg-primary-container/50 font-label text-label-sm cursor-pointer whitespace-nowrap"
                    >
                      <span className="material-symbols-outlined text-[14px]">route</span>
                      <span>Auto-Route DB</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenDrawer(null);
                        setCatalogueOpen(true);
                      }}
                      className="px-2 py-1.5 rounded-sm bg-surface-container-high border border-outline text-primary hover:border-primary font-label text-label-sm cursor-pointer whitespace-nowrap"
                    >
                      Catalogue
                    </button>
                  </div>

                  {/* Active wire category & standard */}
                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="flex flex-col gap-0.5">
                      <span className="font-label text-[10px] text-on-surface-variant uppercase">Wire Category</span>
                      <select
                        value={activeWireCategory}
                        onChange={(e) => setActiveWireCategory(e.target.value as WireCategory)}
                        className="bg-surface border border-outline rounded-sm px-2 py-1 font-body text-xs text-on-surface"
                      >
                        {(Object.keys(WIRE_CATEGORY_LABELS) as WireCategory[]).map((cat) => (
                          <option key={cat} value={cat} className="bg-surface-container">
                            {WIRE_CATEGORY_LABELS[cat]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="font-label text-[10px] text-on-surface-variant uppercase">Color Standard</span>
                      <select
                        value={wiringConfig.standard}
                        onChange={(e) =>
                          handleUpdateWiringConfig({ standard: e.target.value as WireStandard })
                        }
                        className="bg-surface border border-outline rounded-sm px-2 py-1 font-body text-xs text-on-surface"
                      >
                        {(Object.keys(WIRE_STANDARD_LABELS) as WireStandard[]).map((std) => (
                          <option key={std} value={std} className="bg-surface-container">
                            {std}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  {/* Layer Toggles */}
                  <div className="grid grid-cols-2 gap-1 text-xs">
                    <label className="flex items-center gap-1.5 cursor-pointer text-on-surface-variant">
                      <input
                        type="checkbox"
                        checked={wiringConfig.showWires}
                        onChange={(e) => handleUpdateWiringConfig({ showWires: e.target.checked })}
                      />
                      <span>2D Wires</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer text-on-surface-variant">
                      <input
                        type="checkbox"
                        checked={wiringConfig.showWireLabels}
                        onChange={(e) =>
                          handleUpdateWiringConfig({ showWireLabels: e.target.checked })
                        }
                      />
                      <span>Wire Labels</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer text-on-surface-variant">
                      <input
                        type="checkbox"
                        checked={wiringConfig.show3DWires}
                        onChange={(e) => handleUpdateWiringConfig({ show3DWires: e.target.checked })}
                      />
                      <span>3D Conduits</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer text-on-surface-variant">
                      <input
                        type="checkbox"
                        checked={allowInterFloorWiring}
                        onChange={(e) => setAllowInterFloorWiring(e.target.checked)}
                      />
                      <span>Inter-Floor Riser</span>
                    </label>
                  </div>

                  {/* Per-Circuit Cable Size Configuration */}
                  <div className="border-t border-outline-variant pt-2 flex flex-col gap-1.5">
                    <span className="font-mono text-[10px] uppercase text-primary">
                      Circuit Cable Size Configuration (sq.mm)
                    </span>
                    <p className="font-body text-[11px] text-on-surface-variant">
                      Lighting: {CIRCUIT_CABLE_RANGES.lighting.minSqMm}–{CIRCUIT_CABLE_RANGES.lighting.maxSqMm} sq.mm · Heating/Power: {CIRCUIT_CABLE_RANGES.power.minSqMm}–{CIRCUIT_CABLE_RANGES.power.maxSqMm} sq.mm
                    </p>
                    {CIRCUITS.map((ckt) => {
                      const cfg = project.circuitCableConfigs?.[ckt];
                      const check = validateCableSizeForCircuit(ckt, cfg?.cableSizeSqMm);
                      return (
                        <div
                          key={ckt}
                          className="p-2 rounded-sm bg-surface-container-low border border-outline-variant flex flex-col gap-1"
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="font-mono text-[11px] text-on-surface truncate">
                              {ckt}
                            </span>
                            <span className="font-mono text-[10px] text-on-surface-variant shrink-0">
                              {check.range.minSqMm}–{check.range.maxSqMm} mm²
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <select
                              value={cfg?.cableSizeSqMm ?? ''}
                              onChange={(e) => {
                                const val = e.target.value === '' ? null : Number(e.target.value);
                                handleUpdateCircuitCableConfig(ckt, { cableSizeSqMm: val });
                              }}
                              className="w-28 bg-surface border border-outline rounded-sm px-1.5 py-1 font-mono text-[11px] text-on-surface"
                            >
                              <option value="">Not set</option>
                              {[1.0, 1.5, 2.5, 4.0, 6.0, 10.0].map((sz) => (
                                <option key={sz} value={sz}>
                                  {sz} sq.mm
                                </option>
                              ))}
                            </select>
                            {cableCatalogueProducts.length > 0 && (
                              <select
                                value={cfg?.productId ?? ''}
                                onChange={(e) => {
                                  const prod = cableCatalogueProducts.find(
                                    (p) => p.id === e.target.value
                                  );
                                  if (!prod) return;
                                  handleAssignCableToCircuit(prod, ckt);
                                }}
                                className="flex-1 min-w-0 bg-surface border border-outline rounded-sm px-1.5 py-1 font-body text-[11px] text-on-surface"
                              >
                                <option value="">Link catalogue cable...</option>
                                {cableCatalogueProducts.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.manufacturer} {p.productName}
                                    {p.cableSizeSqMm ? ` (${p.cableSizeSqMm}mm²)` : ''}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                          {cfg?.manufacturer && (
                            <span className="font-mono text-[10px] text-primary truncate">
                              Linked: {cfg.manufacturer} {cfg.modelNumber ?? ''}
                            </span>
                          )}
                          {check.status === 'out-of-range' && (
                            <span className="font-body text-[10px] text-secondary">
                              ⚠ {check.warning}
                            </span>
                          )}
                        </div>
                      );
                    })}
                    <span className="font-body text-[10px] text-on-surface-variant">
                      Note: Configurable design ranges only — verify final conductor size against load current, voltage drop, breaker rating, and local wiring codes.
                    </span>
                  </div>

                  {/* Engineering Validation Diagnostics (ERROR / WARNING / INFO) */}
                  {validationIssues.length > 0 && (
                    <div className="border-t border-outline-variant pt-2 flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-mono text-[10px] uppercase text-secondary">
                          Diagnostics ({validationIssues.length})
                        </span>
                        <span className="font-mono text-[10px] text-on-surface-variant">
                          {validationIssues.filter((i) => i.severity === 'error').length} ERR ·{' '}
                          {validationIssues.filter((i) => i.severity === 'warning').length} WARN ·{' '}
                          {validationIssues.filter((i) => i.severity === 'info').length} INFO
                        </span>
                      </div>
                      {(() => {
                        const needsSiteFit = computeActualGeometryBounds(project).exceedsSite;
                        const needsDbOrEp = validationIssues.some(
                          (i) => i.id === 'proj-missing-db' || i.id === 'proj-missing-ep'
                        );
                        const needsAutoRoute = validationIssues.some(
                          (i) => i.id === 'proj-no-routed-cables'
                        );
                        if (!needsSiteFit && !needsDbOrEp && !needsAutoRoute) return null;
                        return (
                          <div className="flex flex-wrap gap-1 py-0.5">
                            {needsSiteFit && (
                              <button
                                type="button"
                                onClick={handleFitSiteToGeometry}
                                className="px-1.5 py-0.5 rounded-sm bg-primary/15 border border-primary/60 text-primary font-label text-[10px] cursor-pointer hover:bg-primary/25"
                              >
                                Fit Site to Geometry
                              </button>
                            )}
                            {needsDbOrEp && (
                              <button
                                type="button"
                                onClick={handleAddMissingDbAndEarthing}
                                className="px-1.5 py-0.5 rounded-sm bg-primary/15 border border-primary/60 text-primary font-label text-[10px] cursor-pointer hover:bg-primary/25"
                              >
                                Add DB-1 &amp; EP-1
                              </button>
                            )}
                            {needsAutoRoute && (
                              <button
                                type="button"
                                onClick={handleAutoRouteFromDb}
                                className="px-1.5 py-0.5 rounded-sm bg-primary/15 border border-primary/60 text-primary font-label text-[10px] cursor-pointer hover:bg-primary/25"
                              >
                                Auto-Route DB
                              </button>
                            )}
                          </div>
                        );
                      })()}
                      <div className="flex flex-col gap-1 max-h-36 overflow-y-auto">
                        {validationIssues.slice(0, 8).map((iss) => (
                          <div
                            key={iss.id}
                            className={`px-2 py-1 rounded-sm border text-[11px] font-body ${
                              iss.severity === 'error'
                                ? 'bg-error/10 border-error text-error'
                                : iss.severity === 'warning'
                                  ? 'bg-secondary-container/25 border-secondary/60 text-on-surface'
                                  : 'bg-surface-container-low border-outline-variant text-on-surface-variant'
                            }`}
                          >
                            <span className="font-mono text-[9px] uppercase font-semibold mr-1">
                              [{iss.severity}]
                            </span>
                            {iss.message}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </details>
            </div>
          </div>

          {/* Multi-Floor Level Switcher Strip (Supports Ground, Upper, Basement, Terrace + Complete/Exploded 3D + Manage Floors) */}
          <div className="flex flex-wrap items-center justify-between gap-gutter-xs px-gutter-sm py-1 rounded-md bg-surface-container border border-outline-variant z-20">
            <div className="flex flex-wrap items-center gap-1">
              <span className="inline-flex items-center gap-1 pr-1.5 font-mono text-[11px] text-on-surface-variant uppercase">
                <span className="material-symbols-outlined text-primary text-[15px]" aria-hidden="true">
                  layers
                </span>
                <span>
                  {BUILDING_TYPE_LABELS[inferBuildingType(project)]} ({totalFloors}):
                </span>
              </span>
              {projectFloors.map((fc) => {
                const isMultiViewActive =
                  viewMode === '3d' && (floorView3D === 'all' || floorView3D === 'exploded') && totalFloors > 1;
                const isActive = fc.floor === activeFloor && !isMultiViewActive;
                return (
                  <button
                    key={fc.floor}
                    type="button"
                    onClick={() => handleSwitchFloor(fc.floor)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-sm border font-label text-label-sm transition-colors cursor-pointer whitespace-nowrap ${
                      isActive
                        ? 'bg-primary text-on-primary border-primary'
                        : 'bg-surface-container-low text-on-surface-variant border-outline-variant hover:border-primary hover:text-on-surface'
                    } ${fc.visible === false ? 'opacity-50 line-through' : ''}`}
                  >
                    <span>{fc.name}</span>
                  </button>
                );
              })}

              {totalFloors > 1 && (
                <>
                  <button
                    type="button"
                    onClick={handleToggleElevatedView}
                    title={`Show all ${totalFloors} floors stacked together in Complete Building 3D view`}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-sm border font-label text-label-sm transition-colors cursor-pointer whitespace-nowrap ${
                      viewMode === '3d' && floorView3D === 'all'
                        ? 'bg-secondary text-on-secondary border-secondary'
                        : 'bg-surface-container-low text-secondary border-secondary/50 hover:border-secondary hover:bg-secondary/10'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                      apartment
                    </span>
                    <span>Elevated</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleToggleExplodedView}
                    title="Exploded 3D View separating storeys vertically"
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-sm border font-label text-label-sm transition-colors cursor-pointer whitespace-nowrap ${
                      viewMode === '3d' && floorView3D === 'exploded'
                        ? 'bg-secondary text-on-secondary border-secondary'
                        : 'bg-surface-container-low text-on-surface-variant border-outline-variant hover:border-secondary hover:text-secondary'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                      layers
                    </span>
                    <span>Exploded</span>
                  </button>
                </>
              )}

              {/* Manage Floors Popover Trigger */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() =>
                    setOpenDrawer((prev) => (prev === 'floors' ? null : 'floors'))
                  }
                  title="Manage Building Type & Floors (Duplex, Triplex, Basement, Terrace)"
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-sm border font-label text-label-sm cursor-pointer whitespace-nowrap ${
                    openDrawer === 'floors'
                      ? 'bg-primary-container border-primary text-primary'
                      : 'border-dashed border-outline text-on-surface-variant hover:text-primary hover:border-primary'
                  }`}
                >
                  <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                    add
                  </span>
                  <span>Manage Floors</span>
                </button>

                {openDrawer === 'floors' && (
                  <div
                    onPointerDown={(e) => e.stopPropagation()}
                    className="absolute left-0 top-full mt-1 w-[360px] max-w-[92vw] max-h-[70vh] overflow-y-auto z-40 bg-surface-container border border-outline rounded-md shadow-2xl p-gutter-sm flex flex-col gap-2.5"
                  >
                    <div className="flex items-center justify-between border-b border-outline-variant pb-1.5">
                      <span className="font-mono text-[11px] uppercase text-primary">
                        Multi-Storey Floor Manager
                      </span>
                      <button
                        type="button"
                        onClick={() => setOpenDrawer(null)}
                        className="text-on-surface-variant hover:text-on-surface cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-[16px]">close</span>
                      </button>
                    </div>

                    {/* Building Type Quick Selector */}
                    <label className="flex flex-col gap-1">
                      <span className="font-label text-[11px] text-on-surface-variant">
                        Building Typology (non-destructive)
                      </span>
                      <select
                        value={inferBuildingType(project)}
                        onChange={(e) => {
                          const nextType = e.target.value as BuildingType;
                          onUpdateProject((prev) => applyBuildingTypeSafely(prev, nextType), true);
                          notify(`Updated building type to ${BUILDING_TYPE_LABELS[nextType]}`);
                        }}
                        className="bg-surface border border-outline rounded-sm px-2 py-1 font-body text-xs text-on-surface"
                      >
                        {(Object.keys(BUILDING_TYPE_LABELS) as BuildingType[]).map((bt) => (
                          <option key={bt} value={bt} className="bg-surface-container">
                            {BUILDING_TYPE_LABELS[bt]}
                          </option>
                        ))}
                      </select>
                    </label>

                    {/* Quick Add Floor Actions */}
                    <div className="grid grid-cols-3 gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          const res = addFloorToProject(project, 'upper');
                          onUpdateProject(() => res.project, true);
                          setActiveFloor(res.newFloor);
                          notify(`Added upper floor (${getFloorLabel(res.project, res.newFloor)})`);
                        }}
                        className="px-2 py-1 rounded-sm bg-primary-container/30 border border-primary text-primary font-label text-[11px] cursor-pointer"
                      >
                        + Upper
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const res = addFloorToProject(project, 'basement');
                          onUpdateProject(() => res.project, true);
                          setActiveFloor(res.newFloor);
                          notify(`Added ${getFloorLabel(res.project, res.newFloor)}`);
                        }}
                        className="px-2 py-1 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-[11px] cursor-pointer"
                      >
                        + Basement
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const res = addFloorToProject(project, 'terrace');
                          onUpdateProject(() => res.project, true);
                          setActiveFloor(res.newFloor);
                          notify(`Added ${getFloorLabel(res.project, res.newFloor)}`);
                        }}
                        className="px-2 py-1 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-[11px] cursor-pointer"
                      >
                        + Terrace
                      </button>
                    </div>

                    {/* Per-Floor Editor List */}
                    <div className="flex flex-col gap-1.5">
                      {projectFloors.map((fc) => {
                        const elemCount = countElementsOnFloor(project, fc.floor);
                        const confirmingDelete = pendingDeleteFloor === fc.floor;
                        return (
                          <div
                            key={fc.floor}
                            className="p-2 rounded-sm bg-surface-container-low border border-outline-variant flex flex-col gap-1.5"
                          >
                            <div className="flex items-center justify-between gap-1">
                              <input
                                type="text"
                                value={fc.name}
                                onChange={(e) =>
                                  onUpdateProject(
                                    (prev) =>
                                      updateFloorConfigInProject(prev, fc.floor, {
                                        name: e.target.value,
                                      }),
                                    false
                                  )
                                }
                                className="flex-1 min-w-0 bg-surface border border-outline rounded-sm px-1.5 py-0.5 font-body text-xs text-on-surface"
                              />
                              <button
                                type="button"
                                title={fc.visible === false ? 'Show floor in 3D' : 'Hide floor in 3D'}
                                onClick={() =>
                                  onUpdateProject(
                                    (prev) =>
                                      updateFloorConfigInProject(prev, fc.floor, {
                                        visible: fc.visible === false,
                                      }),
                                    true
                                  )
                                }
                                className="p-1 text-on-surface-variant hover:text-primary cursor-pointer"
                              >
                                <span className="material-symbols-outlined text-[15px]">
                                  {fc.visible === false ? 'visibility_off' : 'visibility'}
                                </span>
                              </button>
                              <button
                                type="button"
                                title="Duplicate floor layout"
                                onClick={() => {
                                  const dup = duplicateFloorInProject(project, fc.floor);
                                  onUpdateProject(() => dup.project, true);
                                  setActiveFloor(dup.newFloor);
                                  notify(`Duplicated ${fc.name}`);
                                }}
                                className="p-1 text-on-surface-variant hover:text-primary cursor-pointer"
                              >
                                <span className="material-symbols-outlined text-[15px]">content_copy</span>
                              </button>
                              {projectFloors.length > 1 && (
                                <button
                                  type="button"
                                  title="Delete floor"
                                  onClick={() => {
                                    if (elemCount > 0 && !confirmingDelete) {
                                      setPendingDeleteFloor(fc.floor);
                                      return;
                                    }
                                    const rem = removeFloorFromProject(project, fc.floor);
                                    if (rem) {
                                      onUpdateProject(() => rem.project, true);
                                      setActiveFloor(rem.fallbackFloor);
                                      setPendingDeleteFloor(null);
                                      notify(`Deleted ${fc.name}`);
                                    }
                                  }}
                                  className="p-1 text-on-surface-variant hover:text-error cursor-pointer"
                                >
                                  <span className="material-symbols-outlined text-[15px]">delete</span>
                                </button>
                              )}
                            </div>

                            {confirmingDelete && (
                              <div className="flex items-center justify-between gap-1 px-2 py-1 rounded-sm bg-error/15 border border-error text-[11px] text-error">
                                <span>Remove {elemCount} items on {fc.name}?</span>
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const rem = removeFloorFromProject(project, fc.floor);
                                      if (rem) {
                                        onUpdateProject(() => rem.project, true);
                                        setActiveFloor(rem.fallbackFloor);
                                        setPendingDeleteFloor(null);
                                        notify(`Deleted ${fc.name}`);
                                      }
                                    }}
                                    className="px-1.5 py-0.5 bg-error text-on-primary rounded-sm cursor-pointer"
                                  >
                                    Delete
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setPendingDeleteFloor(null)}
                                    className="px-1.5 py-0.5 bg-surface text-on-surface rounded-sm cursor-pointer"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}

                            <div className="grid grid-cols-3 gap-1 font-mono text-[10px]">
                              <label className="flex flex-col gap-0.5">
                                <span className="text-on-surface-variant">Elev (m)</span>
                                <input
                                  type="number"
                                  step="0.1"
                                  value={fc.elevationM}
                                  onChange={(e) =>
                                    onUpdateProject(
                                      (prev) =>
                                        updateFloorConfigInProject(prev, fc.floor, {
                                          elevationM: Number(e.target.value) || 0,
                                        }),
                                      true
                                    )
                                  }
                                  className="bg-surface border border-outline rounded-sm px-1 py-0.5 text-on-surface"
                                />
                              </label>
                              <label className="flex flex-col gap-0.5">
                                <span className="text-on-surface-variant">Height (m)</span>
                                <input
                                  type="number"
                                  step="0.1"
                                  min={1}
                                  value={fc.floorHeightM}
                                  onChange={(e) =>
                                    onUpdateProject(
                                      (prev) =>
                                        updateFloorConfigInProject(prev, fc.floor, {
                                          floorHeightM: Math.max(1, Number(e.target.value) || 3),
                                        }),
                                      true
                                    )
                                  }
                                  className="bg-surface border border-outline rounded-sm px-1 py-0.5 text-on-surface"
                                />
                              </label>
                              <label className="flex flex-col gap-0.5">
                                <span className="text-on-surface-variant">Slab (m)</span>
                                <input
                                  type="number"
                                  step="0.02"
                                  min={0.1}
                                  value={fc.slabThicknessM}
                                  onChange={(e) =>
                                    onUpdateProject(
                                      (prev) =>
                                        updateFloorConfigInProject(prev, fc.floor, {
                                          slabThicknessM: Math.max(0.1, Number(e.target.value) || 0.22),
                                        }),
                                      true
                                    )
                                  }
                                  className="bg-surface border border-outline rounded-sm px-1 py-0.5 text-on-surface"
                                />
                              </label>
                            </div>
                            <div className="grid grid-cols-2 gap-1 font-mono text-[10px]">
                              <label className="flex flex-col gap-0.5">
                                <span className="text-on-surface-variant">
                                  Floor Len ({unitShort}){fc.lengthM ? ' *' : ''}
                                </span>
                                <input
                                  type="number"
                                  step={units === 'ft' ? '0.5' : '0.1'}
                                  min={1}
                                  placeholder={`${project.site.length} (site)`}
                                  value={
                                    typeof fc.lengthM === 'number' && fc.lengthM > 0
                                      ? Number(fromMeters(fc.lengthM, units).toFixed(2))
                                      : ''
                                  }
                                  onChange={(e) => {
                                    const raw = e.target.value.trim();
                                    if (!raw) {
                                      onUpdateProject(
                                        (prev) =>
                                          updateFloorConfigInProject(prev, fc.floor, {
                                            lengthM: undefined,
                                          }),
                                        true
                                      );
                                      return;
                                    }
                                    const val = Number(raw);
                                    if (!Number.isFinite(val) || val <= 0) return;
                                    onUpdateProject(
                                      (prev) =>
                                        updateFloorConfigInProject(prev, fc.floor, {
                                          lengthM: Number(toMeters(val, units).toFixed(3)),
                                        }),
                                      true
                                    );
                                  }}
                                  className="bg-surface border border-outline rounded-sm px-1 py-0.5 text-on-surface"
                                />
                              </label>
                              <label className="flex flex-col gap-0.5">
                                <span className="text-on-surface-variant">
                                  Floor Wid ({unitShort}){fc.widthM ? ' *' : ''}
                                </span>
                                <input
                                  type="number"
                                  step={units === 'ft' ? '0.5' : '0.1'}
                                  min={1}
                                  placeholder={`${project.site.width} (site)`}
                                  value={
                                    typeof fc.widthM === 'number' && fc.widthM > 0
                                      ? Number(fromMeters(fc.widthM, units).toFixed(2))
                                      : ''
                                  }
                                  onChange={(e) => {
                                    const raw = e.target.value.trim();
                                    if (!raw) {
                                      onUpdateProject(
                                        (prev) =>
                                          updateFloorConfigInProject(prev, fc.floor, {
                                            widthM: undefined,
                                          }),
                                        true
                                      );
                                      return;
                                    }
                                    const val = Number(raw);
                                    if (!Number.isFinite(val) || val <= 0) return;
                                    onUpdateProject(
                                      (prev) =>
                                        updateFloorConfigInProject(prev, fc.floor, {
                                          widthM: Number(toMeters(val, units).toFixed(3)),
                                        }),
                                      true
                                    );
                                  }}
                                  className="bg-surface border border-outline rounded-sm px-1 py-0.5 text-on-surface"
                                />
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-gutter-xs">
              {floorBelowConfig && !(viewMode === '3d' && (floorView3D === 'all' || floorView3D === 'exploded')) && (
                <button
                  type="button"
                  onClick={handleCopyFloorBelow}
                  title={`Copy layout from ${floorBelowConfig.name} to ${getFloorLabel(project, activeFloor)}`}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-sm bg-surface-container-high border border-outline text-primary hover:border-primary font-label text-label-sm cursor-pointer whitespace-nowrap"
                >
                  <span className="material-symbols-outlined text-[14px]" aria-hidden="true">content_copy</span>
                  <span>Copy {floorBelowConfig.name}</span>
                </button>
              )}
              {/* PROPERTIES INSPECTOR DROPDOWN TRIGGER */}
              <button
                type="button"
                onClick={() => {
                  setOpenToolbarDropdown(null);
                  setOpenDrawer((prev) => (prev === 'properties' ? null : 'properties'));
                }}
                aria-expanded={openDrawer === 'properties'}
                title="Toggle Properties Inspector Dropdown"
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-sm border cursor-pointer select-none transition-colors ${
                  openDrawer === 'properties'
                    ? 'bg-surface-container-high border-primary'
                    : 'bg-surface-container-low border-outline-variant hover:border-primary hover:bg-surface-container-high'
                }`}
              >
                <span className="material-symbols-outlined text-primary text-[15px]" aria-hidden="true">
                  tune
                </span>
                <span className="font-label text-label-sm text-on-surface uppercase tracking-wider whitespace-nowrap">
                  Properties Inspector
                </span>
                <span className="px-1.5 py-0.5 rounded-full bg-primary-container text-primary font-mono text-[10px] uppercase whitespace-nowrap">
                  {inspectorBadgeLabel}
                </span>
                <span
                  className={`material-symbols-outlined text-on-surface-variant text-[16px] transition-transform duration-panel-toggle ${
                    openDrawer === 'properties' ? 'rotate-180' : ''
                  }`}
                  aria-hidden="true"
                >
                  expand_more
                </span>
              </button>
            </div>
          </div>

          {/* Primary Canvas Frame */}
          <div
            className="relative flex-1 flex flex-col min-h-[420px] lg:min-h-0 w-full rounded-lg border border-outline bg-surface-container-low overflow-hidden"
            onPointerDown={(e) => {
              if (openDrawer) setOpenDrawer(null);
              if (openToolbarDropdown) setOpenToolbarDropdown(null);
              if (e.button === 0 && canvasContextMenu) setCanvasContextMenu(null);
            }}
            onContextMenu={(e) => {
              if (viewMode === '2d') {
                e.preventDefault();
                setOpenDrawer(null);
                setCanvasContextMenu({ x: e.clientX, y: e.clientY });
              }
            }}
          >
            {/* Simulink-Style Find Component Floating Search Panel (Ctrl+F) */}
            {findOpen && (
              <FindComponentPanel
                query={findQuery}
                category={findCategory}
                results={findResults}
                activeIndex={findActiveIndex}
                onQueryChange={setFindQuery}
                onCategoryChange={setFindCategory}
                onSelectResult={handleSelectFindResult}
                onNext={() => handleStepFindResult(1)}
                onPrev={() => handleStepFindResult(-1)}
                onClose={() => setFindOpen(false)}
              />
            )}

            {/* Extensible Right-Click Canvas Context Menu (2D & 3D) */}
            {canvasContextMenu && (
              <CanvasContextMenu
                x={canvasContextMenu.x}
                y={canvasContextMenu.y}
                headerLabel={
                  viewMode === '3d'
                    ? `3D Preview · ${formatFloorLabel(activeFloor)}`
                    : `2D Canvas · ${formatFloorLabel(activeFloor)}`
                }
                onClose={() => setCanvasContextMenu(null)}
                items={(
                  [
                    {
                      id: 'find',
                      label: 'Find Component',
                      icon: 'search',
                      shortcut: 'Ctrl+F',
                      onSelect: () => {
                        setOpenDrawer(null);
                        setFindOpen(true);
                      },
                    },
                    ...(viewMode === '3d'
                      ? [
                          {
                            id: 'toggle-walk',
                            label: cameraMode === 'fps' ? 'Exit 3D Walk' : 'Enter 3D Walk',
                            icon: cameraMode === 'fps' ? '3d_rotation' : 'directions_walk',
                            shortcut: 'E',
                            onSelect: () => {
                              if (cameraMode === 'fps') {
                                setCameraMode('orbit');
                              } else {
                                setCameraMode('fps');
                                requestFpsPointerLockRef.current?.();
                              }
                            },
                          },
                          {
                            id: 'sky-cycle',
                            label: `Sky: ${
                              lightingMode === 'sunrise'
                                ? 'Sunrise → Sun'
                                : lightingMode === 'daylight'
                                  ? 'Sun → Sunset'
                                  : lightingMode === 'sunset'
                                    ? 'Sunset → Night'
                                    : 'Night → Sunrise'
                            }`,
                            icon: 'wb_twilight',
                            onSelect: () => {
                              const order: LightingMode[] = ['sunrise', 'daylight', 'sunset', 'evening'];
                              setLightingMode((prev) => order[(order.indexOf(prev) + 1) % order.length]);
                            },
                          },
                          {
                            id: 'switch-2d',
                            label: 'Switch to 2D View',
                            icon: 'grid_on',
                            onSelect: () => setViewMode('2d'),
                          },
                        ]
                      : [
                          {
                            id: 'fit-screen',
                            label: 'Fit to Screen',
                            icon: 'fit_screen',
                            onSelect: handleFitToScreen,
                          },
                          {
                            id: 'switch-3d',
                            label: 'Switch to 3D Preview',
                            icon: 'view_in_ar',
                            onSelect: () => requestSwitchTo3D(),
                          },
                        ]),
                    {
                      id: 'copy',
                      label: 'Copy Selected',
                      icon: 'content_copy',
                      shortcut: 'Ctrl+C',
                      disabled: selectedEntities.length === 0 && !allSelected,
                      dividerBefore: true,
                      onSelect: handleCopySelection,
                    },
                    {
                      id: 'paste',
                      label: 'Paste',
                      icon: 'content_paste',
                      shortcut: 'Ctrl+V',
                      disabled: !clipboard,
                      onSelect: handlePasteClipboard,
                    },
                    {
                      id: 'duplicate',
                      label: 'Duplicate Selected',
                      icon: 'control_point_duplicate',
                      shortcut: 'Ctrl+D',
                      disabled: selectedEntities.length === 0 && !allSelected,
                      onSelect: handleDuplicateSelection,
                    },
                    {
                      id: 'rotate',
                      label: 'Rotate 90°',
                      icon: 'rotate_right',
                      disabled: selectedEntities.length === 0 && !allSelected,
                      onSelect: handleRotateSelection,
                    },
                    {
                      id: 'select-all',
                      label: 'Select All on Floor',
                      icon: 'select_all',
                      shortcut: 'Ctrl+A',
                      onSelect: handleSelectAll,
                    },
                    {
                      id: 'undo',
                      label: 'Undo',
                      icon: 'undo',
                      shortcut: 'Ctrl+Z',
                      disabled: !canUndo,
                      dividerBefore: true,
                      onSelect: onUndo,
                    },
                    {
                      id: 'redo',
                      label: 'Redo',
                      icon: 'redo',
                      shortcut: 'Ctrl+Y',
                      disabled: !canRedo,
                      onSelect: onRedo,
                    },
                    {
                      id: 'save',
                      label: 'Save Project',
                      icon: 'save',
                      shortcut: 'Ctrl+S',
                      onSelect: () => {
                        onSaveProject();
                        notify(`Saved "${project.name}" to workspace`);
                      },
                    },
                    {
                      id: 'delete',
                      label: 'Delete Selected',
                      icon: 'delete',
                      shortcut: 'Del',
                      danger: true,
                      disabled: selectedEntities.length === 0 && !allSelected,
                      dividerBefore: true,
                      onSelect: handleDeleteSelection,
                    },
                  ] satisfies CanvasContextMenuItem[]
                )}
              />
            )}

            {viewMode === '2d' ? (
              <FloorPlan2D
                project={project}
                activeFloor={activeFloor}
                selectedEntity={selectedEntity}
                selectedEntities={selectedEntities}
                highlightedIds={highlightedIds}
                activeHighlightId={activeHighlightId}
                focusTarget={focusTarget}
                allSelected={allSelected}
                activeTool={activeTool}
                pendingPlaceItem={pendingPlaceItem}
                showGrid={showGrid}
                snapEnabled={snapEnabled}
                zoom={zoom}
                panOffset={panOffset}
                onPanChange={setPanOffset}
                onZoomChange={setZoom}
                onSelectEntity={(ent, additive) => {
                  setSelectedEntity(ent, additive);
                  if (ent) setAllSelected(false);
                  setInspectorWarning(null);
                }}
                onClearAllSelection={() => setAllSelected(false)}
                onMoveAll={handleMoveAll}
                onEmptySiteClick={handleEmptySiteClick}
                onUpdateRoom={handleUpdateRoom}
                onAddCustomWall={handleAddCustomWall}
                onAddOpening={handleAddOpening}
                onAddDimension={handleAddDimension}
                onEraseEntity={handleEraseEntity}
                onRotateEntity={handleRotateEntity}
                onMovePoint={handleMovePoint}
                onMoveOpening={handleMoveOpening}
                onMoveFurniture={handleMoveFurniture}
                onDuplicatePoint={handleDuplicatePoint}
                onDuplicateRoom={handleDuplicateRoomFree}
                onDuplicateOpening={handleDuplicateOpening}
                onDuplicateFurniture={handleDuplicateFurniture}
                onDuplicateWall={handleDuplicateWall}
                onPlacePointAt={handlePlacePointAt}
                activeWireCategory={activeWireCategory}
                allowInterFloorWiring={allowInterFloorWiring}
                onAddStaircase={handleAddStaircase}
                onMoveStaircase={handleMoveStaircase}
                onCreateWire={handleCreateWire}
                onUpdateWireWaypoints={handleUpdateWireWaypoints}
                onAutoRouteWires={handleAutoRouteFromDb}
                onRecordHistorySnapshot={onRecordSnapshot}
                onValidationWarning={(msg) => notify(msg, 'warning')}
                onApprove2DFor3D={handleApprove2DFor3D}
                onExportDxf={handleExportValidatedDxf}
              />
            ) : (
              <Viewport3D
                project={project}
                activeFloor={activeFloor}
                floorViewMode={floorView3D}
                selectedPointId={selectedPoint?.id ?? null}
                selectedEntities={selectedEntities}
                highlightedIds={highlightedIds}
                activeHighlightId={activeHighlightId}
                focusTarget={focusTarget}
                cameraMode={cameraMode}
                cameraPreset={cameraPreset}
                savedCameraView={appliedSavedView}
                onCameraCaptureReady={(fn) => {
                  captureCameraRef.current = fn;
                }}
                lightingMode={lightingMode}
                zoom={zoom}
                pendingPlaceItem={pendingPlaceItem}
                onSelectEntity={(ent, additive) => {
                  setSelectedEntity(ent, additive);
                  if (ent) setAllSelected(false);
                  setInspectorWarning(null);
                }}
                onSelectPoint={(pid, additive) => {
                  setSelectedEntity({ kind: 'point', id: pid }, additive);
                  setAllSelected(false);
                }}
                onPlacePointAt={handlePlacePointAt}
                onDuplicatePoint={handleDuplicatePoint}
                onMovePoint={handleMovePoint}
                onDuplicateFurniture={handleDuplicateFurniture}
                onMoveFurniture={handleMoveFurniture}
                onRecordHistorySnapshot={onRecordSnapshot}
                onCanvasContextMenu={(pos) => {
                  setOpenDrawer(null);
                  setCanvasContextMenu(pos);
                }}
                onSwitchTo2D={() => setViewMode('2d')}
                onExitFpsMode={() => {
                  setCameraMode((prev) => {
                    if (prev !== 'fps') return prev;
                    notify('Exited First-Person Navigation back to Orbit view');
                    return 'orbit';
                  });
                }}
                onRegisterFpsPointerLock={(fn) => {
                  requestFpsPointerLockRef.current = fn;
                }}
              />
            )}
          </div>
        </main>

        {/* PROPERTIES INSPECTOR DROPDOWN PANEL */}
        {openDrawer === 'properties' && (
        <aside
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          className="absolute right-2 top-[88px] z-40 w-[308px] max-w-[calc(100%-16px)] max-h-[calc(100%-96px)] bg-surface-container border border-outline rounded-md shadow-2xl p-gutter-md flex flex-col gap-gutter-md overflow-y-auto"
        >
          <div className="flex items-center justify-between gap-2 border-b border-outline-variant pb-gutter-sm">
            <span className="font-label text-label-sm text-on-surface-variant uppercase tracking-wider">
              Properties Inspector
            </span>
            <div className="flex items-center gap-1.5">
              <span className="px-2 py-0.5 rounded-full bg-primary-container text-primary font-mono text-[11px] uppercase">
                {inspectorBadgeLabel}
              </span>
              <button
                type="button"
                onClick={() => setOpenDrawer(null)}
                aria-label="Close Properties Inspector"
                title="Close"
                className="p-0.5 rounded-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">close</span>
              </button>
            </div>
          </div>

          {inspectorWarning && (
            <div
              role="alert"
              className="p-gutter-sm rounded-sm bg-secondary-container/70 border border-secondary text-on-secondary-container font-body text-body-sm flex items-start gap-1.5"
            >
              <span className="material-symbols-outlined text-secondary text-[16px] shrink-0 mt-0.5">warning</span>
              <span>{inspectorWarning}</span>
            </div>
          )}

          {/* 0. ALL SELECTED (Ctrl+A) INSPECTOR */}
          {allSelected && (
            <div className="flex flex-col gap-gutter-sm">
              <div className="p-gutter-sm rounded-md bg-primary-container/25 border border-primary flex flex-col gap-1.5">
                <span className="font-label text-label-md text-primary">
                  All Floor Plan Elements Selected
                </span>
                <span className="font-body text-body-sm text-on-surface-variant">
                  Drag inside the 2D canvas to move all items together, or use Copy (Ctrl+C), Duplicate (Ctrl+D), or Delete.
                </span>
                <div className="grid grid-cols-2 gap-1 pt-1 font-mono text-mono-sm text-on-surface">
                  <span>Rooms: {floorProject.rooms.length}</span>
                  <span>Walls: {floorProject.customWalls.length}</span>
                  <span>Openings: {floorProject.openings.length}</span>
                  <span>Points: {floorProject.points.length}</span>
                  <span>Furniture: {floorProject.furniture.length}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-gutter-xs">
                <button
                  type="button"
                  onClick={handleCopySelection}
                  className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">content_copy</span>
                  <span>Copy</span>
                </button>
                <button
                  type="button"
                  onClick={handleDuplicateSelection}
                  className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">control_point_duplicate</span>
                  <span>Duplicate</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  setAllSelected(false);
                  setSelectedEntities([]);
                }}
                className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px]">deselect</span>
                <span>Deselect All (Esc)</span>
              </button>

              <button
                type="button"
                onClick={handleClearAllSelected}
                className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-low border border-error text-error hover:bg-error/15 font-label text-label-sm cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px]">delete_sweep</span>
                <span>Clear All Selected</span>
              </button>
            </div>
          )}

          {/* 0B. MULTI-SELECTION INSPECTOR (Shift+Click / Paste Multi) */}
          {!allSelected && selectedEntities.length > 1 && (
            <div className="flex flex-col gap-gutter-sm">
              <div className="p-gutter-sm rounded-md bg-primary-container/25 border border-primary flex flex-col gap-1.5">
                <span className="font-label text-label-md text-primary">
                  {selectedEntities.length} Components Selected
                </span>
                <span className="font-body text-body-sm text-on-surface-variant">
                  Use Shift+Click to add or remove items. Perform batch Copy, Duplicate, Rotate, or Delete.
                </span>
                <div className="grid grid-cols-2 gap-1 pt-1 font-mono text-mono-sm text-on-surface">
                  <span>Points: {selectedEntities.filter((s) => s.kind === 'point').length}</span>
                  <span>Rooms: {selectedEntities.filter((s) => s.kind === 'room').length}</span>
                  <span>Furniture: {selectedEntities.filter((s) => s.kind === 'furniture').length}</span>
                  <span>Openings: {selectedEntities.filter((s) => s.kind === 'opening').length}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-gutter-xs">
                <button
                  type="button"
                  onClick={handleCopySelection}
                  className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">content_copy</span>
                  <span>Copy</span>
                </button>
                <button
                  type="button"
                  onClick={handleDuplicateSelection}
                  className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">control_point_duplicate</span>
                  <span>Duplicate</span>
                </button>
              </div>

              <button
                type="button"
                onClick={handleRotateSelection}
                className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px]">rotate_right</span>
                <span>Rotate Selected 90°</span>
              </button>

              <button
                type="button"
                onClick={() => setSelectedEntities([])}
                className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px]">deselect</span>
                <span>Clear Selection (Esc)</span>
              </button>

              <button
                type="button"
                onClick={handleDeleteSelection}
                className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-low border border-error text-error hover:bg-error/15 font-label text-label-sm cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px]">delete</span>
                <span>Delete {selectedEntities.length} Selected</span>
              </button>
            </div>
          )}

          {/* 1. ROOM INSPECTOR (PHASE 5) */}
          {selectedRoom && (
            <div className="flex flex-col gap-gutter-sm">
              <label className="flex flex-col gap-1">
                <span className="font-label text-label-sm text-on-surface-variant">Room Name</span>
                <input
                  type="text"
                  value={selectedRoom.name}
                  onBlur={resetInspectorSnapshotGuard}
                  onChange={(e) => {
                    ensureInspectorSnapshot(`room-name-${selectedRoom.id}`);
                    handleUpdateRoom(selectedRoom.id, { name: e.target.value }, false);
                  }}
                  className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-body text-body-md text-on-surface focus:border-primary focus:outline-none"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="font-label text-label-sm text-on-surface-variant">Room Type</span>
                <select
                  value={selectedRoom.type}
                  onChange={(e) => {
                    const nextType = e.target.value as RoomType;
                    const tpl = ROOM_LIBRARY.find((r) => r.type === nextType);
                    handleUpdateRoom(
                      selectedRoom.id,
                      { type: nextType, floorFinish: tpl?.finish ?? selectedRoom.floorFinish },
                      true
                    );
                  }}
                  className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-body text-body-sm text-on-surface focus:border-primary focus:outline-none"
                >
                  {ROOM_LIBRARY.map((rm) => (
                    <option key={rm.type} value={rm.type} className="bg-surface-container">
                      {rm.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-gutter-xs">
                <label className="flex flex-col gap-1">
                  <span className="font-label text-label-sm text-on-surface-variant">
                    Length ({unitShort})
                  </span>
                  <input
                    type="number"
                    step="0.5"
                    min={1}
                    value={Number(fromMeters(selectedRoom.width, units).toFixed(2))}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v) || v <= 0) return;
                      handleUpdateRoom(
                        selectedRoom.id,
                        { width: Number(toMeters(v, units).toFixed(3)) },
                        true
                      );
                    }}
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-label text-label-sm text-on-surface-variant">
                    Width ({unitShort})
                  </span>
                  <input
                    type="number"
                    step="0.5"
                    min={1}
                    value={Number(fromMeters(selectedRoom.height, units).toFixed(2))}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v) || v <= 0) return;
                      handleUpdateRoom(
                        selectedRoom.id,
                        { height: Number(toMeters(v, units).toFixed(3)) },
                        true
                      );
                    }}
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                  />
                </label>
              </div>

              <div className="px-gutter-sm py-gutter-xs rounded-sm bg-surface-container-low border border-outline-variant flex items-center justify-between">
                <span className="font-label text-label-sm text-on-surface-variant">Room Area</span>
                <span className="font-mono text-mono-md text-primary tabular-nums">
                  {selectedRoomArea}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-gutter-xs">
                <label className="flex flex-col gap-1">
                  <span className="font-label text-label-sm text-on-surface-variant">
                    X Position ({unitShort})
                  </span>
                  <input
                    type="number"
                    step="0.5"
                    value={Number(fromMeters(selectedRoom.x, units).toFixed(2))}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v)) return;
                      handleUpdateRoom(
                        selectedRoom.id,
                        { x: Number(toMeters(v, units).toFixed(3)) },
                        true
                      );
                    }}
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-label text-label-sm text-on-surface-variant">
                    Y Position ({unitShort})
                  </span>
                  <input
                    type="number"
                    step="0.5"
                    value={Number(fromMeters(selectedRoom.y, units).toFixed(2))}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v)) return;
                      handleUpdateRoom(
                        selectedRoom.id,
                        { y: Number(toMeters(v, units).toFixed(3)) },
                        true
                      );
                    }}
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                  />
                </label>
              </div>

              <label className="flex flex-col gap-1">
                <span className="font-label text-label-sm text-on-surface-variant">
                  Partition Wall Thickness ({units === 'ft' ? 'inches' : 'cm'})
                </span>
                <input
                  type="number"
                  step={units === 'ft' ? '0.5' : '1'}
                  min={units === 'ft' ? 2 : 5}
                  max={units === 'ft' ? 18 : 45}
                  value={
                    units === 'ft'
                      ? Number(((selectedRoom.wallThickness ?? 0.15) * M_TO_FT * 12).toFixed(1))
                      : Math.round((selectedRoom.wallThickness ?? 0.15) * 100)
                  }
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v) || v <= 0) return;
                    const meters = units === 'ft' ? (v / 12) * FT_TO_M : v / 100;
                    handleUpdateRoom(selectedRoom.id, { wallThickness: Number(meters.toFixed(3)) }, true);
                  }}
                  className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                />
              </label>

              <div className="grid grid-cols-2 gap-gutter-xs pt-gutter-xs">
                <button
                  type="button"
                  onClick={() => handleRotateRoom(selectedRoom.id)}
                  className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">rotate_right</span>
                  <span>Rotate 90°</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleDuplicateRoom(selectedRoom.id)}
                  className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">content_copy</span>
                  <span>Duplicate</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => handleDismantleRoom(selectedRoom.id)}
                className="w-full inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-sm bg-primary-container/30 border border-primary text-primary hover:bg-primary-container/50 font-label text-label-sm cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px]">open_with</span>
                <span>Dismantle Section to Canvas</span>
              </button>

              <button
                type="button"
                onClick={() => handleEraseEntity({ kind: 'room', id: selectedRoom.id })}
                className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-low border border-error text-error hover:bg-error/15 font-label text-label-sm cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px]">delete</span>
                <span>Delete Room</span>
              </button>
            </div>
          )}

          {/* 2. CUSTOM WALL INSPECTOR (PHASE 6) */}
          {selectedWall && (
            <div className="flex flex-col gap-gutter-sm">
              <label className="flex flex-col gap-1">
                <span className="font-label text-label-sm text-on-surface-variant">Wall Classification</span>
                <select
                  value={selectedWall.wallKind ?? 'internal'}
                  onChange={(e) =>
                    handleUpdateWall(selectedWall.id, {
                      wallKind: e.target.value as 'internal' | 'external',
                    })
                  }
                  className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-body text-body-sm text-on-surface focus:border-primary focus:outline-none"
                >
                  <option value="internal" className="bg-surface-container">Internal Partition Wall</option>
                  <option value="external" className="bg-surface-container">External Structural Wall</option>
                </select>
              </label>

              <label className="flex flex-col gap-1">
                <span className="font-label text-label-sm text-on-surface-variant">
                  Exact Wall Length ({unitShort})
                </span>
                <input
                  type="number"
                  step="0.5"
                  min={0.5}
                  value={Number(
                    fromMeters(
                      Math.hypot(selectedWall.x2 - selectedWall.x1, selectedWall.y2 - selectedWall.y1),
                      units
                    ).toFixed(2)
                  )}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v) || v <= 0.2) return;
                    handleUpdateWall(selectedWall.id, { lengthM: toMeters(v, units) });
                  }}
                  className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="font-label text-label-sm text-on-surface-variant">
                  Wall Thickness ({units === 'ft' ? 'inches' : 'cm'})
                </span>
                <input
                  type="number"
                  step={units === 'ft' ? '0.5' : '1'}
                  min={units === 'ft' ? 2 : 5}
                  max={units === 'ft' ? 24 : 60}
                  value={
                    units === 'ft'
                      ? Number(((selectedWall.thickness ?? 0.15) * M_TO_FT * 12).toFixed(1))
                      : Math.round((selectedWall.thickness ?? 0.15) * 100)
                  }
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v) || v <= 0) return;
                    const meters = units === 'ft' ? (v / 12) * FT_TO_M : v / 100;
                    handleUpdateWall(selectedWall.id, { thickness: Number(meters.toFixed(3)) });
                  }}
                  className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                />
              </label>

              <div className="p-gutter-sm rounded-sm bg-surface-container-low border border-outline-variant font-mono text-mono-sm text-on-surface-variant flex flex-col gap-1">
                <span>
                  Start: ({formatLength(selectedWall.x1, units)}, {formatLength(selectedWall.y1, units)})
                </span>
                <span>
                  End: ({formatLength(selectedWall.x2, units)}, {formatLength(selectedWall.y2, units)})
                </span>
              </div>

              <button
                type="button"
                onClick={() => handleEraseEntity({ kind: 'wall', id: selectedWall.id })}
                className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-low border border-error text-error hover:bg-error/15 font-label text-label-sm cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px]">delete</span>
                <span>Delete Wall</span>
              </button>
            </div>
          )}

          {/* 3. DOOR / WINDOW INSPECTOR */}
          {selectedOpening && (
            <div className="flex flex-col gap-gutter-sm">
              <div className="px-gutter-sm py-1.5 rounded-sm bg-surface-container-low border border-outline-variant flex items-center justify-between">
                <span className="font-label text-label-sm text-on-surface-variant">Type</span>
                <span className="font-mono text-mono-sm text-primary uppercase">
                  {selectedOpening.kind}
                </span>
              </div>

              <label className="flex flex-col gap-1">
                <span className="font-label text-label-sm text-on-surface-variant">
                  Opening Width ({unitShort})
                </span>
                <input
                  type="number"
                  step="0.25"
                  min={0.5}
                  value={Number(fromMeters(selectedOpening.width, units).toFixed(2))}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v) || v <= 0.2) return;
                    handleUpdateOpening(selectedOpening.id, {
                      width: Number(toMeters(v, units).toFixed(3)),
                    });
                  }}
                  className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                />
              </label>

              <div className="grid grid-cols-2 gap-gutter-xs">
                <label className="flex flex-col gap-1">
                  <span className="font-label text-label-sm text-on-surface-variant">X ({unitShort})</span>
                  <input
                    type="number"
                    step="0.5"
                    value={Number(fromMeters(selectedOpening.x, units).toFixed(2))}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v)) return;
                      handleUpdateOpening(selectedOpening.id, {
                        x: Number(toMeters(v, units).toFixed(3)),
                      });
                    }}
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-label text-label-sm text-on-surface-variant">Y ({unitShort})</span>
                  <input
                    type="number"
                    step="0.5"
                    value={Number(fromMeters(selectedOpening.y, units).toFixed(2))}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v)) return;
                      handleUpdateOpening(selectedOpening.id, {
                        y: Number(toMeters(v, units).toFixed(3)),
                      });
                    }}
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                  />
                </label>
              </div>

              <button
                type="button"
                onClick={() => handleRotateEntity({ kind: 'opening', id: selectedOpening.id })}
                className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px]">rotate_right</span>
                <span>Rotate 90° ({selectedOpening.rotation}°)</span>
              </button>

              <button
                type="button"
                onClick={() => handleEraseEntity({ kind: 'opening', id: selectedOpening.id })}
                className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-low border border-error text-error hover:bg-error/15 font-label text-label-sm cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px]">delete</span>
                <span>Delete {selectedOpening.kind === 'door' ? 'Door' : 'Window'}</span>
              </button>
            </div>
          )}

          {/* 4. ELECTRICAL POINT INSPECTOR (History-Safe & Simulink Actions) */}
          {selectedPoint && (
            <div className="flex flex-col gap-gutter-sm">
              <div className="px-gutter-sm py-1 rounded-sm bg-surface-container-low border border-outline-variant flex items-center justify-between font-mono text-[11px]">
                <span className="text-on-surface-variant">ID / Code</span>
                <span className="text-primary">{selectedPoint.code}</span>
              </div>

              <label className="flex flex-col gap-1">
                <span className="font-label text-label-sm text-on-surface-variant">Component Name</span>
                <input
                  type="text"
                  value={selectedPoint.name}
                  onBlur={resetInspectorSnapshotGuard}
                  onChange={(e) => {
                    ensureInspectorSnapshot(`pt-name-${selectedPoint.id}`);
                    handleUpdateSelectedPoint({ name: e.target.value }, false);
                  }}
                  className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-body text-body-sm text-on-surface focus:border-primary focus:outline-none"
                />
              </label>

              {project.rooms.length > 0 && (
                <label className="flex flex-col gap-1">
                  <span className="font-label text-label-sm text-on-surface-variant">Assigned Room</span>
                  <select
                    value={selectedPoint.roomId}
                    onChange={(e) => handleUpdateSelectedPoint({ roomId: e.target.value }, true)}
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-body text-body-sm text-on-surface focus:border-primary focus:outline-none"
                  >
                    {project.rooms.map((rm) => (
                      <option key={rm.id} value={rm.id} className="bg-surface-container">
                        {rm.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div className="grid grid-cols-3 gap-gutter-xs">
                <label className="flex flex-col gap-1">
                  <span className="font-label text-[11px] text-on-surface-variant">X (m)</span>
                  <input
                    type="number"
                    step="0.1"
                    value={selectedPoint.x}
                    onChange={(e) =>
                      handleUpdateSelectedPoint({ x: Number(e.target.value) || 0 }, true)
                    }
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-mono text-mono-sm text-on-surface tabular-nums"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-label text-[11px] text-on-surface-variant">Y (m)</span>
                  <input
                    type="number"
                    step="0.1"
                    value={selectedPoint.y}
                    onChange={(e) =>
                      handleUpdateSelectedPoint({ y: Number(e.target.value) || 0 }, true)
                    }
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-mono text-mono-sm text-on-surface tabular-nums"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-label text-[11px] text-on-surface-variant">Z (m)</span>
                  <input
                    type="number"
                    step="0.05"
                    value={selectedPoint.z}
                    onChange={(e) =>
                      handleUpdateSelectedPoint({ z: Number(e.target.value) || 0.4 }, true)
                    }
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-mono text-mono-sm text-on-surface tabular-nums"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-gutter-xs">
                <label className="flex flex-col gap-1">
                  <span className="font-label text-label-sm text-on-surface-variant">Wattage (W)</span>
                  <input
                    type="number"
                    min={0}
                    value={selectedPoint.wattage}
                    onChange={(e) =>
                      handleUpdateSelectedPoint({ wattage: Math.max(0, Number(e.target.value) || 0) }, true)
                    }
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-mono text-mono-sm text-secondary tabular-nums"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-label text-label-sm text-on-surface-variant">Circuit</span>
                  <select
                    value={selectedPoint.circuit}
                    onChange={(e) =>
                      handleUpdateSelectedPoint({ circuit: e.target.value as CircuitId }, true)
                    }
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-1.5 py-1.5 font-mono text-[11px] text-on-surface"
                  >
                    {CIRCUITS.map((c) => (
                      <option key={c} value={c} className="bg-surface-container">
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {/* Brand / Catalogue Metadata & Unit Price Override */}
              {(selectedPoint.manufacturer || selectedPoint.modelNumber) && (
                <div className="p-2 rounded-sm bg-surface-container-low border border-outline-variant flex flex-col gap-0.5 font-mono text-[10px]">
                  <span className="text-primary">
                    {selectedPoint.brand || selectedPoint.manufacturer}
                  </span>
                  {selectedPoint.modelNumber && (
                    <span className="text-on-surface-variant">Model: {selectedPoint.modelNumber}</span>
                  )}
                  {selectedPoint.specification && (
                    <span className="text-on-surface-variant">{selectedPoint.specification}</span>
                  )}
                </div>
              )}

              <label className="flex flex-col gap-1">
                <span className="font-label text-[11px] text-on-surface-variant">
                  Unit Rate Override (₹, 0 = Not configured)
                </span>
                <input
                  type="number"
                  min={0}
                  step={10}
                  value={selectedPoint.unitCost ?? 0}
                  onChange={(e) =>
                    handleUpdateSelectedPoint(
                      { unitCost: Math.max(0, Number(e.target.value) || 0) },
                      true
                    )
                  }
                  className="w-full bg-surface-container-low border border-outline rounded-sm px-2 py-1 font-mono text-mono-sm text-on-surface tabular-nums"
                />
              </label>

              {/* Distribution Board Configuration */}
              {selectedPoint.itemType === 'distribution_board' && (
                <div className="p-2 rounded-sm bg-primary-container/15 border border-primary/50 flex flex-col gap-1.5">
                  <span className="font-mono text-[10px] uppercase text-primary">
                    Distribution Board Specification
                  </span>
                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="flex flex-col gap-0.5">
                      <span className="font-label text-[10px] text-on-surface-variant">Phase</span>
                      <select
                        value={selectedPoint.dbConfig?.phaseType ?? 'Single Phase (1Φ)'}
                        onChange={(e) =>
                          handleUpdateSelectedPoint(
                            {
                              dbConfig: {
                                incomingRatingAmps: selectedPoint.dbConfig?.incomingRatingAmps ?? 63,
                                waysCount: selectedPoint.dbConfig?.waysCount ?? 12,
                                rccbSensitivityMa: selectedPoint.dbConfig?.rccbSensitivityMa ?? 30,
                                associatedCircuits: selectedPoint.dbConfig?.associatedCircuits ?? CIRCUITS,
                                enclosureType: selectedPoint.dbConfig?.enclosureType ?? 'Double Door Flush Metal DB',
                                phaseType: e.target.value as DistributionBoardConfig['phaseType'],
                              },
                            },
                            true
                          )
                        }
                        className="bg-surface border border-outline rounded-sm px-1.5 py-1 font-body text-[11px] text-on-surface"
                      >
                        <option value="Single Phase (1Φ)">Single Phase (1Φ)</option>
                        <option value="Three Phase (3Φ)">Three Phase (3Φ)</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="font-label text-[10px] text-on-surface-variant">Incoming (A)</span>
                      <input
                        type="number"
                        min={16}
                        step={1}
                        value={selectedPoint.dbConfig?.incomingRatingAmps ?? 63}
                        onChange={(e) =>
                          handleUpdateSelectedPoint(
                            {
                              dbConfig: {
                                ...(selectedPoint.dbConfig ?? {
                                  waysCount: 12,
                                  phaseType: 'Single Phase (1Φ)',
                                  rccbSensitivityMa: 30,
                                  associatedCircuits: CIRCUITS,
                                  enclosureType: 'Double Door Flush Metal DB',
                                }),
                                incomingRatingAmps: Math.max(16, Number(e.target.value) || 63),
                              },
                            },
                            true
                          )
                        }
                        className="bg-surface border border-outline rounded-sm px-1.5 py-1 font-mono text-[11px] text-on-surface"
                      />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="font-label text-[10px] text-on-surface-variant">Ways</span>
                      <input
                        type="number"
                        min={4}
                        step={2}
                        value={selectedPoint.dbConfig?.waysCount ?? 12}
                        onChange={(e) =>
                          handleUpdateSelectedPoint(
                            {
                              dbConfig: {
                                ...(selectedPoint.dbConfig ?? {
                                  incomingRatingAmps: 63,
                                  phaseType: 'Single Phase (1Φ)',
                                  rccbSensitivityMa: 30,
                                  associatedCircuits: CIRCUITS,
                                  enclosureType: 'Double Door Flush Metal DB',
                                }),
                                waysCount: Math.max(4, Number(e.target.value) || 12),
                              },
                            },
                            true
                          )
                        }
                        className="bg-surface border border-outline rounded-sm px-1.5 py-1 font-mono text-[11px] text-on-surface"
                      />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="font-label text-[10px] text-on-surface-variant">RCCB (mA)</span>
                      <select
                        value={selectedPoint.dbConfig?.rccbSensitivityMa ?? 30}
                        onChange={(e) =>
                          handleUpdateSelectedPoint(
                            {
                              dbConfig: {
                                ...(selectedPoint.dbConfig ?? {
                                  incomingRatingAmps: 63,
                                  waysCount: 12,
                                  phaseType: 'Single Phase (1Φ)',
                                  associatedCircuits: CIRCUITS,
                                  enclosureType: 'Double Door Flush Metal DB',
                                }),
                                rccbSensitivityMa: Number(e.target.value),
                              },
                            },
                            true
                          )
                        }
                        className="bg-surface border border-outline rounded-sm px-1.5 py-1 font-mono text-[11px] text-on-surface"
                      >
                        <option value={30}>30 mA</option>
                        <option value={100}>100 mA</option>
                        <option value={300}>300 mA</option>
                      </select>
                    </label>
                  </div>
                </div>
              )}

              {/* Earthing Point Configuration */}
              {selectedPoint.itemType === 'earthing_point' && (
                <div className="p-2 rounded-sm bg-emerald-500/10 border border-emerald-500/50 flex flex-col gap-1.5">
                  <span className="font-mono text-[10px] uppercase text-emerald-400">
                    Earthing Point Specification
                  </span>
                  <label className="flex flex-col gap-0.5">
                    <span className="font-label text-[10px] text-on-surface-variant">Electrode Type</span>
                    <select
                      value={selectedPoint.earthingConfig?.earthingType ?? 'Copper Plate'}
                      onChange={(e) =>
                        handleUpdateSelectedPoint(
                          {
                            earthingConfig: {
                              ...(selectedPoint.earthingConfig ?? {
                                targetResistanceOhm: 2,
                                earthConductorSizeSqMm: 4,
                              }),
                              earthingType: e.target.value as EarthingPointConfig['earthingType'],
                            },
                          },
                          true
                        )
                      }
                      className="bg-surface border border-outline rounded-sm px-1.5 py-1 font-body text-[11px] text-on-surface"
                    >
                      <option value="Copper Plate">Copper Plate</option>
                      <option value="GI Pipe">GI Pipe</option>
                      <option value="Chemical Maintenance-Free">Chemical Maintenance-Free</option>
                      <option value="Copper Rod">Copper Rod</option>
                    </select>
                  </label>
                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="flex flex-col gap-0.5">
                      <span className="font-label text-[10px] text-on-surface-variant">Target Ω</span>
                      <input
                        type="number"
                        step="0.5"
                        min={0.5}
                        value={selectedPoint.earthingConfig?.targetResistanceOhm ?? 2}
                        onChange={(e) =>
                          handleUpdateSelectedPoint(
                            {
                              earthingConfig: {
                                ...(selectedPoint.earthingConfig ?? {
                                  earthingType: 'Copper Plate',
                                  earthConductorSizeSqMm: 4,
                                }),
                                targetResistanceOhm: Math.max(0.5, Number(e.target.value) || 2),
                              },
                            },
                            true
                          )
                        }
                        className="bg-surface border border-outline rounded-sm px-1.5 py-1 font-mono text-[11px] text-on-surface"
                      />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="font-label text-[10px] text-on-surface-variant">Earth Cond (mm²)</span>
                      <input
                        type="number"
                        step="0.5"
                        min={1.5}
                        value={selectedPoint.earthingConfig?.earthConductorSizeSqMm ?? 4}
                        onChange={(e) =>
                          handleUpdateSelectedPoint(
                            {
                              earthingConfig: {
                                ...(selectedPoint.earthingConfig ?? {
                                  earthingType: 'Copper Plate',
                                  targetResistanceOhm: 2,
                                }),
                                earthConductorSizeSqMm: Math.max(1.5, Number(e.target.value) || 4),
                              },
                            },
                            true
                          )
                        }
                        className="bg-surface border border-outline rounded-sm px-1.5 py-1 font-mono text-[11px] text-on-surface"
                      />
                    </label>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-gutter-xs">
                <button
                  type="button"
                  onClick={() => handleRotateEntity({ kind: 'point', id: selectedPoint.id })}
                  className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">rotate_right</span>
                  <span>Rotate ({selectedPoint.rotation}°)</span>
                </button>
                <button
                  type="button"
                  onClick={handleDuplicateSelection}
                  className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">control_point_duplicate</span>
                  <span>Duplicate</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => handleEraseEntity({ kind: 'point', id: selectedPoint.id })}
                className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-low border border-error text-error hover:bg-error/15 font-label text-label-sm cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px]">delete</span>
                <span>Delete Electrical Point</span>
              </button>
            </div>
          )}

          {/* 4C. STAIRCASE INSPECTOR */}
          {selectedStaircase && (
            <div className="flex flex-col gap-gutter-sm">
              <label className="flex flex-col gap-1">
                <span className="font-label text-label-sm text-on-surface-variant">Staircase Name</span>
                <input
                  type="text"
                  value={selectedStaircase.name}
                  onChange={(e) =>
                    handleUpdateStaircase(selectedStaircase.id, { name: e.target.value }, false)
                  }
                  className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-body text-body-sm text-on-surface"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="font-label text-label-sm text-on-surface-variant">Geometry Type</span>
                <select
                  value={selectedStaircase.type}
                  onChange={(e) =>
                    handleUpdateStaircase(
                      selectedStaircase.id,
                      { type: e.target.value as StaircaseType },
                      true
                    )
                  }
                  className="w-full bg-surface-container-low border border-outline rounded-sm px-gutter-sm py-1.5 font-body text-body-sm text-on-surface"
                >
                  <option value="straight">Straight Flight</option>
                  <option value="l-shaped">L-Shaped (Quarter Turn)</option>
                  <option value="u-shaped">U-Shaped (Half Turn)</option>
                  <option value="spiral">Spiral Staircase</option>
                </select>
              </label>

              <div className="grid grid-cols-2 gap-gutter-xs">
                <label className="flex flex-col gap-1">
                  <span className="font-label text-[11px] text-on-surface-variant">From Floor</span>
                  <select
                    value={selectedStaircase.fromFloor}
                    onChange={(e) =>
                      handleUpdateStaircase(
                        selectedStaircase.id,
                        { fromFloor: Number(e.target.value) },
                        true
                      )
                    }
                    className="bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-body text-xs text-on-surface"
                  >
                    {projectFloors.map((fc) => (
                      <option key={fc.floor} value={fc.floor}>
                        {fc.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-label text-[11px] text-on-surface-variant">To Floor</span>
                  <select
                    value={selectedStaircase.toFloor}
                    onChange={(e) =>
                      handleUpdateStaircase(
                        selectedStaircase.id,
                        { toFloor: Number(e.target.value) },
                        true
                      )
                    }
                    className="bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-body text-xs text-on-surface"
                  >
                    {projectFloors.map((fc) => (
                      <option key={fc.floor} value={fc.floor}>
                        {fc.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-3 gap-gutter-xs">
                <label className="flex flex-col gap-1">
                  <span className="font-label text-[11px] text-on-surface-variant">Width (m)</span>
                  <input
                    type="number"
                    step="0.05"
                    min={0.75}
                    value={selectedStaircase.width}
                    onChange={(e) =>
                      handleUpdateStaircase(
                        selectedStaircase.id,
                        { width: Math.max(0.75, Number(e.target.value) || 1.05) },
                        true
                      )
                    }
                    className="bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-mono text-xs text-on-surface"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-label text-[11px] text-on-surface-variant">Steps</span>
                  <input
                    type="number"
                    min={6}
                    max={30}
                    value={selectedStaircase.steps}
                    onChange={(e) =>
                      handleUpdateStaircase(
                        selectedStaircase.id,
                        { steps: Math.max(6, Math.min(30, Number(e.target.value) || 16)) },
                        true
                      )
                    }
                    className="bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-mono text-xs text-on-surface"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-label text-[11px] text-on-surface-variant">Tread (m)</span>
                  <input
                    type="number"
                    step="0.01"
                    min={0.2}
                    max={0.4}
                    value={selectedStaircase.treadDepth}
                    onChange={(e) =>
                      handleUpdateStaircase(
                        selectedStaircase.id,
                        { treadDepth: Math.max(0.2, Number(e.target.value) || 0.27) },
                        true
                      )
                    }
                    className="bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-mono text-xs text-on-surface"
                  />
                </label>
              </div>

              <button
                type="button"
                onClick={() => handleRotateEntity({ kind: 'staircase', id: selectedStaircase.id })}
                className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px]">rotate_right</span>
                <span>Rotate 90° ({selectedStaircase.rotation}°)</span>
              </button>

              <button
                type="button"
                onClick={() => handleEraseEntity({ kind: 'staircase', id: selectedStaircase.id })}
                className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-low border border-error text-error hover:bg-error/15 font-label text-label-sm cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px]">delete</span>
                <span>Delete Staircase</span>
              </button>
            </div>
          )}

          {/* 4D. ELECTRICAL WIRE / CABLE INSPECTOR */}
          {selectedWire && (() => {
            const fromPt = project.points.find((p) => p.id === selectedWire.fromPointId);
            const toPt = project.points.find((p) => p.id === selectedWire.toPointId);
            const routedLen = computeWireLengthMeters(selectedWire, project);
            const cableValidation = validateCableSizeForCircuit(
              selectedWire.circuit,
              selectedWire.cableSizeSqMm
            );
            return (
              <div className="flex flex-col gap-gutter-sm">
                <div className="px-gutter-sm py-1.5 rounded-sm bg-surface-container-low border border-outline-variant flex items-center justify-between font-mono text-[11px]">
                  <span className="text-on-surface-variant">
                    {selectedWire.code} ({fromPt?.code ?? '?'} → {toPt?.code ?? '?'})
                  </span>
                  <span className="text-secondary">{routedLen.toFixed(2)} m</span>
                </div>

                <div className="grid grid-cols-2 gap-gutter-xs">
                  <label className="flex flex-col gap-0.5">
                    <span className="font-label text-[11px] text-on-surface-variant">Category</span>
                    <select
                      value={selectedWire.category}
                      onChange={(e) => {
                        const cat = e.target.value as WireCategory;
                        handleUpdateWire(selectedWire.id, {
                          category: cat,
                          color: WIRE_STANDARD_COLORS[wiringConfig.standard][cat],
                        });
                      }}
                      className="bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-body text-xs text-on-surface"
                    >
                      {(Object.keys(WIRE_CATEGORY_LABELS) as WireCategory[]).map((cat) => (
                        <option key={cat} value={cat}>
                          {WIRE_CATEGORY_LABELS[cat]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="font-label text-[11px] text-on-surface-variant">Circuit</span>
                    <select
                      value={selectedWire.circuit}
                      onChange={(e) =>
                        handleUpdateWire(selectedWire.id, {
                          circuit: e.target.value as CircuitId | '',
                        })
                      }
                      className="bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-mono text-[11px] text-on-surface"
                    >
                      <option value="">Unassigned</option>
                      {CIRCUITS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-gutter-xs">
                  <label className="flex flex-col gap-0.5">
                    <span className="font-label text-[11px] text-on-surface-variant">
                      Cable Size (sq.mm)
                    </span>
                    <select
                      value={selectedWire.cableSizeSqMm ?? ''}
                      onChange={(e) =>
                        handleUpdateWire(selectedWire.id, {
                          cableSizeSqMm: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                      className="bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-mono text-xs text-on-surface"
                    >
                      <option value="">Not configured</option>
                      {[1.0, 1.5, 2.5, 4.0, 6.0, 10.0].map((sz) => (
                        <option key={sz} value={sz}>
                          {sz} sq.mm
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="font-label text-[11px] text-on-surface-variant">Conductor</span>
                    <select
                      value={selectedWire.cableMaterial}
                      onChange={(e) =>
                        handleUpdateWire(selectedWire.id, {
                          cableMaterial: e.target.value as CableMaterial,
                        })
                      }
                      className="bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-body text-xs text-on-surface"
                    >
                      <option value="Copper">Copper</option>
                      <option value="Aluminium">Aluminium</option>
                      <option value="Data/Fiber">Data / Fiber</option>
                    </select>
                  </label>
                </div>

                {cableValidation.warning && (
                  <div className="p-2 rounded-sm bg-secondary-container/25 border border-secondary/70 font-body text-[11px] text-on-surface">
                    ⚠ {cableValidation.warning}
                  </div>
                )}

                <div className="grid grid-cols-3 gap-gutter-xs">
                  <label className="flex flex-col gap-0.5">
                    <span className="font-label text-[10px] text-on-surface-variant">Cores</span>
                    <input
                      type="number"
                      min={1}
                      max={6}
                      value={selectedWire.cores}
                      onChange={(e) =>
                        handleUpdateWire(selectedWire.id, {
                          cores: Math.max(1, Math.min(6, Number(e.target.value) || 2)),
                        })
                      }
                      className="bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-mono text-xs text-on-surface"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="font-label text-[10px] text-on-surface-variant">Phase</span>
                    <select
                      value={selectedWire.phaseDesignation}
                      onChange={(e) =>
                        handleUpdateWire(selectedWire.id, {
                          phaseDesignation: e.target.value as PhaseDesignation,
                        })
                      }
                      className="bg-surface-container-low border border-outline rounded-sm px-1 py-1 font-mono text-[11px] text-on-surface"
                    >
                      {(['L1', 'L2', 'L3', 'N', 'PE', 'SW', 'DATA'] as PhaseDesignation[]).map(
                        (ph) => (
                          <option key={ph} value={ph}>
                            {ph}
                          </option>
                        )
                      )}
                    </select>
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="font-label text-[10px] text-on-surface-variant">Line Style</span>
                    <select
                      value={selectedWire.lineStyle}
                      onChange={(e) =>
                        handleUpdateWire(selectedWire.id, {
                          lineStyle: e.target.value as WireLineStyle,
                        })
                      }
                      className="bg-surface-container-low border border-outline rounded-sm px-1 py-1 font-body text-[11px] text-on-surface"
                    >
                      <option value="solid">Solid</option>
                      <option value="dashed">Dashed</option>
                      <option value="dotted">Dotted</option>
                    </select>
                  </label>
                </div>

                {/* Route Shaping Actions */}
                <div className="flex flex-col gap-1">
                  <span className="font-label text-[10px] text-on-surface-variant uppercase">
                    Route Editing ({selectedWire.waypoints.length} bends — drag handles or + in 2D)
                  </span>
                  <div className="grid grid-cols-3 gap-1">
                    <button
                      type="button"
                      disabled={!fromPt || !toPt}
                      onClick={() => {
                        if (!fromPt || !toPt) return;
                        handleUpdateWire(selectedWire.id, {
                          waypoints: generateAutoRouteWaypoints(fromPt, toPt, 'horizontal-first'),
                        });
                      }}
                      className="px-1.5 py-1 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-[11px] cursor-pointer"
                    >
                      90° Route
                    </button>
                    <button
                      type="button"
                      disabled={!fromPt || !toPt}
                      onClick={() => {
                        if (!fromPt || !toPt) return;
                        const { lengthM, widthM } = siteToMeters(project.site);
                        handleUpdateWire(selectedWire.id, {
                          waypoints: generateWallAlignedWaypoints(
                            fromPt,
                            toPt,
                            floorProject.rooms,
                            lengthM,
                            widthM
                          ),
                        });
                      }}
                      className="px-1.5 py-1 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-[11px] cursor-pointer"
                    >
                      Wall-Align
                    </button>
                    <button
                      type="button"
                      onClick={() => handleUpdateWire(selectedWire.id, { waypoints: [] })}
                      className="px-1.5 py-1 rounded-sm bg-surface-container-high border border-outline text-on-surface-variant hover:border-outline font-label text-[11px] cursor-pointer"
                    >
                      Direct
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => handleEraseEntity({ kind: 'wire', id: selectedWire.id })}
                  className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-low border border-error text-error hover:bg-error/15 font-label text-label-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">delete</span>
                  <span>Delete Wire (Keep Endpoints)</span>
                </button>
              </div>
            );
          })()}

          {/* 4B. FURNITURE INSPECTOR */}
          {selectedFurniture && (
            <div className="flex flex-col gap-gutter-sm">
              <div className="px-gutter-sm py-1.5 rounded-sm bg-surface-container-low border border-outline-variant flex items-center justify-between">
                <span className="font-label text-label-sm text-on-surface-variant">Furniture</span>
                <span className="font-mono text-mono-sm text-primary">
                  {FURNITURE_MAP[selectedFurniture.kind]?.label ?? selectedFurniture.kind}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-gutter-xs">
                <label className="flex flex-col gap-1">
                  <span className="font-label text-[11px] text-on-surface-variant">Width (m)</span>
                  <input
                    type="number"
                    step="0.1"
                    min={0.3}
                    value={selectedFurniture.width}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v) || v < 0.3) return;
                      handleUpdateSelectedFurniture({ width: Number(v.toFixed(2)) }, true);
                    }}
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-mono text-mono-sm text-on-surface tabular-nums"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-label text-[11px] text-on-surface-variant">Depth (m)</span>
                  <input
                    type="number"
                    step="0.1"
                    min={0.3}
                    value={selectedFurniture.depth}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v) || v < 0.3) return;
                      handleUpdateSelectedFurniture({ depth: Number(v.toFixed(2)) }, true);
                    }}
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-mono text-mono-sm text-on-surface tabular-nums"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-gutter-xs">
                <label className="flex flex-col gap-1">
                  <span className="font-label text-[11px] text-on-surface-variant">X (m)</span>
                  <input
                    type="number"
                    step="0.1"
                    value={selectedFurniture.x}
                    onChange={(e) =>
                      handleUpdateSelectedFurniture({ x: Number(e.target.value) || 0 }, true)
                    }
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-mono text-mono-sm text-on-surface tabular-nums"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-label text-[11px] text-on-surface-variant">Y (m)</span>
                  <input
                    type="number"
                    step="0.1"
                    value={selectedFurniture.y}
                    onChange={(e) =>
                      handleUpdateSelectedFurniture({ y: Number(e.target.value) || 0 }, true)
                    }
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-mono text-mono-sm text-on-surface tabular-nums"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-gutter-xs">
                <button
                  type="button"
                  onClick={() => handleRotateEntity({ kind: 'furniture', id: selectedFurniture.id })}
                  className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">rotate_right</span>
                  <span>Rotate ({selectedFurniture.rotation}°)</span>
                </button>
                <button
                  type="button"
                  onClick={handleDuplicateSelection}
                  className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">control_point_duplicate</span>
                  <span>Duplicate</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => handleEraseEntity({ kind: 'furniture', id: selectedFurniture.id })}
                className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-sm bg-surface-container-low border border-error text-error hover:bg-error/15 font-label text-label-sm cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px]">delete</span>
                <span>Delete Furniture</span>
              </button>
            </div>
          )}

          {/* 5. DEFAULT SITE OVERVIEW WHEN NOTHING IS SELECTED */}
          {!allSelected &&
            selectedEntities.length === 0 &&
            !selectedRoom &&
            !selectedWall &&
            !selectedOpening &&
            !selectedStaircase &&
            !selectedWire &&
            !selectedPoint &&
            !selectedFurniture && (
            <div className="flex flex-col gap-gutter-md">
              <div className="p-gutter-sm rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="font-label text-label-sm text-on-surface-variant">Site Boundary</span>
                  <span className="font-mono text-mono-sm text-on-surface tabular-nums">
                    {project.site.length} {unitShort} × {project.site.width} {unitShort}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-label text-label-sm text-on-surface-variant">Total Site Area</span>
                  <span className="font-mono text-mono-sm text-on-surface tabular-nums">
                    {formatArea(metrics.siteAreaSqM, units)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-label text-label-sm text-on-surface-variant">Built-up Area</span>
                  <span className="font-mono text-mono-sm text-primary tabular-nums">
                    {formatArea(metrics.builtUpAreaSqM, units)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-label text-label-sm text-on-surface-variant">Remaining Area</span>
                  <span className="font-mono text-mono-sm text-secondary tabular-nums">
                    {formatArea(metrics.remainingAreaSqM, units)}
                  </span>
                </div>
              </div>

              {/* Placed Rooms Quick Index */}
              <div className="flex flex-col gap-gutter-xs">
                <span className="font-label text-label-sm text-on-surface-variant uppercase tracking-wider">
                  Rooms on {formatFloorLabel(activeFloor)} ({floorProject.rooms.length})
                </span>
                {floorProject.rooms.length === 0 ? (
                  <p className="font-body text-body-sm text-on-surface-variant bg-surface-container-low border border-dashed border-outline-variant rounded-md p-gutter-sm">
                    No rooms created on {formatFloorLabel(activeFloor)} yet. Click anywhere inside the site boundary on the 2D canvas, or choose a room from B. Room Library.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1 max-h-56 overflow-y-auto">
                    {floorProject.rooms.map((rm) => (
                      <button
                        key={rm.id}
                        type="button"
                        onClick={() => setSelectedEntity({ kind: 'room', id: rm.id })}
                        className="w-full flex items-center justify-between px-gutter-sm py-1.5 rounded-sm bg-surface-container-low border border-outline-variant hover:border-primary text-left cursor-pointer"
                      >
                        <span className="font-body text-body-sm text-on-surface truncate">
                          {rm.name}
                        </span>
                        <span className="font-mono text-[11px] text-primary shrink-0">
                          {formatLength(rm.width, units, 1)} × {formatLength(rm.height, units, 1)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>
        )}
      </div>

      {/* PHASE 3 BOTTOM STATUS BAR */}
      <footer className="px-gutter-md py-gutter-xs bg-surface-container border-t border-outline-variant flex flex-wrap items-center justify-between gap-gutter-md font-mono text-mono-sm">
        <div className="flex flex-wrap items-center gap-gutter-lg">
          <div className="flex items-center gap-1.5">
            <span className="text-on-surface-variant">SITE:</span>
            <span className="text-on-surface tabular-nums">
              {project.site.length} {unitShort} × {project.site.width} {unitShort}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-on-surface-variant">FLOOR:</span>
            <span className="text-primary">
              {formatFloorLabel(activeFloor)} / {totalFloors}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-on-surface-variant">SELECTED ROOM:</span>
            <span className="text-primary">
              {selectedRoom ? selectedRoom.name : 'None'}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-on-surface-variant">ROOM AREA:</span>
            <span className="text-on-surface tabular-nums">{selectedRoomArea}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-gutter-lg">
          <div className="flex items-center gap-1.5">
            <span className="text-on-surface-variant">BUILT-UP AREA:</span>
            <span className="text-primary tabular-nums">
              {formatArea(metrics.builtUpAreaSqM, units)}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-on-surface-variant">REMAINING AREA:</span>
            <span className="text-secondary tabular-nums">
              {formatArea(metrics.remainingAreaSqM, units)}
            </span>
          </div>
        </div>
      </footer>

      {/* PHASE 4 CLICK-TO-CREATE ROOM MODAL */}
      {pendingRoomModal && (
        <CreateRoomModal
          project={project}
          activeFloor={activeFloor}
          initialX={pendingRoomModal.x}
          initialY={pendingRoomModal.y}
          initialRoomType={pendingRoomModal.roomType}
          onCancel={() => setPendingRoomModal(null)}
          onPlaceRoom={handlePlaceRoomFromModal}
        />
      )}

      {/* DRAWING INSTRUCTIONS MODAL */}
      {showGuideModal && (
        <DrawingInstructionsModal onClose={() => setShowGuideModal(false)} />
      )}

      {/* SAVE AS INLINE MODAL (zero window.prompt) */}
      {showSaveAsModal && (
        <div
          className="fixed inset-0 z-50 bg-deep-navy/85 flex items-center justify-center p-gutter-lg"
          role="dialog"
          aria-modal="true"
          aria-labelledby="save-as-title"
        >
          <form
            onSubmit={handleSaveAsSubmit}
            className="w-full max-w-md bg-surface-container border border-outline rounded-lg overflow-hidden"
          >
            <div className="px-gutter-xl py-gutter-md border-b border-outline-variant bg-surface-container-high flex items-center justify-between">
              <h3 id="save-as-title" className="font-headline text-headline-sm text-on-surface">
                Save Project As
              </h3>
              <button
                type="button"
                onClick={() => setShowSaveAsModal(false)}
                className="text-on-surface-variant hover:text-on-surface cursor-pointer"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>
            <div className="p-gutter-xl flex flex-col gap-gutter-sm">
              <label className="flex flex-col gap-1">
                <span className="font-label text-label-sm text-on-surface-variant">New Project Name</span>
                <input
                  type="text"
                  autoFocus
                  required
                  value={saveAsName}
                  onChange={(e) => setSaveAsName(e.target.value)}
                  className="w-full bg-surface border border-outline rounded-sm px-gutter-md py-gutter-sm font-body text-body-md text-on-surface focus:border-primary focus:outline-none"
                />
              </label>
              {saveAsError && (
                <span className="font-mono text-mono-sm text-error">{saveAsError}</span>
              )}
            </div>
            <div className="px-gutter-xl py-gutter-md border-t border-outline-variant bg-surface-container-low flex items-center justify-end gap-gutter-sm">
              <button
                type="button"
                onClick={() => setShowSaveAsModal(false)}
                className="px-gutter-lg py-gutter-xs rounded-sm border border-outline text-on-surface-variant hover:text-on-surface font-label text-label-md cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-gutter-lg py-gutter-xs rounded-sm bg-primary text-on-primary font-label text-label-md hover:bg-on-primary-container cursor-pointer"
              >
                Save Copy
              </button>
            </div>
          </form>
        </div>
      )}
      {/* MULTI-BRAND ELECTRICAL PRODUCT CATALOGUE MODAL */}
      <ProductCatalogueModal
        open={catalogueOpen}
        onClose={() => {
          setCatalogueOpen(false);
          setCatalogueVersion((v) => v + 1);
        }}
        isAdmin={isAdmin}
        activeCircuit={(selectedPoint?.circuit ?? selectedWire?.circuit) || CIRCUITS[0]}
        onAddProductToProject={handleAddCatalogueProductToProject}
        onAssignCableToCircuit={handleAssignCableToCircuit}
      />

      {/* MULTI-PAGE ARCHITECTURAL & ELECTRICAL PDF PACKAGE MODAL */}
      <PdfExportModal
        open={pdfModalOpen}
        project={project}
        onClose={() => setPdfModalOpen(false)}
        onExported={(count) =>
          notify(`Exported ${count}-page Architectural & Electrical PDF Drawing Package`)
        }
      />

      {/* SAFE PROJECT IMPORT PREVIEW MODAL (.bluespace / .json) */}
      <ImportProjectPreviewModal
        preview={importPreview}
        onCancel={() => setImportPreview(null)}
        onConfirmImport={handleConfirmSafeImport}
      />

      {/* AI DRAWING TO 2D IMPORTER MODAL (PDF / PNG / JPG) */}
      <AiDrawingImporterModal
        isOpen={aiDrawingModalOpen}
        onClose={() => setAiDrawingModalOpen(false)}
        activeProject={project}
        activeFloor={activeFloor}
        onNotify={(type, msg) => notify(msg, type)}
        onImportComplete={(result: ConvertTo2DResult) => {
          const { summary, isNewProject, project: nextProj } = result;
          if (isNewProject) {
            const res = onImportProject(projectStorage.exportNativeBluespace(nextProj));
            if (!res.ok) {
              notify(res.error || 'Could not load imported 2D project.', 'error');
              return;
            }
          } else {
            onUpdateProject(() => nextProj, true);
          }
          setViewMode('2d');
          notify(
            `Generated editable 2D CAD model: ${summary.walls} walls, ${summary.rooms} rooms, ${summary.openings} openings, ${summary.electricalPoints} electrical points. Review layers & click "Approve 2D & Open 3D" when ready for 3D.${
              nextProj.aiDrawingImport?.calibrated
                ? ''
                : ' Note: Drawing scale is uncalibrated — review dimensions.'
            }`,
            nextProj.aiDrawingImport?.calibrated ? 'success' : 'warning'
          );
        }}
      />

      {/* DESIGN STUDIO NOTIFICATION TOAST (INFO / SUCCESS / WARNING / ERROR) */}
      {statusMessage && (
        <div
          key={statusMessage.id}
          role={statusMessage.tone === 'error' || statusMessage.tone === 'warning' ? 'alert' : 'status'}
          aria-live={statusMessage.tone === 'error' ? 'assertive' : 'polite'}
          className={`fixed bottom-4 right-4 z-50 max-w-md px-3.5 py-2.5 rounded-md border shadow-xl flex items-start gap-2.5 text-xs font-label ${
            statusMessage.tone === 'error'
              ? 'bg-surface-container border-error text-on-surface'
              : statusMessage.tone === 'warning'
                ? 'bg-surface-container border-secondary text-on-surface'
                : statusMessage.tone === 'success'
                  ? 'bg-surface-container border-success text-on-surface'
                  : 'bg-surface-container border-primary text-on-surface'
          }`}
        >
          <span
            className={`material-symbols-outlined text-[17px] shrink-0 mt-0.5 ${
              statusMessage.tone === 'error'
                ? 'text-error'
                : statusMessage.tone === 'warning'
                  ? 'text-secondary'
                  : statusMessage.tone === 'success'
                    ? 'text-success'
                    : 'text-primary'
            }`}
            aria-hidden="true"
          >
            {statusMessage.tone === 'error'
              ? 'error'
              : statusMessage.tone === 'warning'
                ? 'warning'
                : statusMessage.tone === 'success'
                  ? 'check_circle'
                  : 'info'}
          </span>
          <span className="flex-1 leading-snug">{statusMessage.text}</span>
          <button
            type="button"
            onClick={dismissNotification}
            aria-label="Dismiss notification"
            className="text-on-surface-variant hover:text-on-surface cursor-pointer p-0.5 -mr-1"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              close
            </span>
          </button>
        </div>
      )}
    </div>
  );
};
