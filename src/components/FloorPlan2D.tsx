import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CATALOG_MAP, findRoomAtPoint, FT_TO_M, siteToMeters } from '../data/presets';
import {
  ArchitecturalOpening,
  CanvasTool,
  CircuitId,
  ElectricalItemType,
  ElectricalPoint,
  ElectricalWire,
  FurnitureItem,
  ProjectData,
  RoomZone,
  SelectedEntity,
  StaircaseItem,
  StudioEntityRef,
  StudioFocusTarget,
  WireCategory,
  WireRoutingMode,
  WireWaypoint,
} from '../types/design';
import {
  appendPolylineVertex,
  buildSmoothSvgPath,
  checkTerminalCompatibility,
  computeDetailedWireQuantityReport,
  computePolylineSegmentMetrics,
  computeStaircaseFootprint,
  computeWireLengthBreakdown,
  CONDUCTOR_COLOR_LEGEND,
  DEFAULT_INSTALLATION_ALLOWANCE_PCT,
  finalizePolylineWaypoints,
  getFloorBoundaryMeters,
  getFloorLabel,
  getWiringConfig,
  resolvePolylineStartPoint,
  sampleCurvedPath3D,
  WIRE_STANDARD_COLORS,
} from '../utils/buildingWiring';
import {
  CANVAS_ASPECT_LABEL,
  computeCalibrated2DCanvasMetrics,
  CONDUCTOR_VISUAL_LANE_OFFSET_PX,
  offsetPolylinePerpendicular,
  screenToCalibratedMeters,
} from '../utils/canvasScale2D';
import {
  extractMergedWalls,
  findNearestWallAttachment,
  formatArea,
  formatFloorLabel,
  formatLength,
  getItemFloor,
  isPointInsideRoom,
  MergedWallSegment,
  sliceProjectForFloor,
  snapCoordinate,
  snapCoordinateFree,
  validateRoomPlacement,
} from '../utils/geometry';
import { FURNITURE_MAP } from '../utils/studioEditor';

interface FloorPlan2DProps {
  project: ProjectData;
  activeFloor?: number;
  selectedEntity?: SelectedEntity;
  selectedEntities?: StudioEntityRef[];
  selectedPointId?: string | null;
  highlightedIds?: Set<string>;
  activeHighlightId?: string | null;
  focusTarget?: StudioFocusTarget | null;
  allSelected?: boolean;
  activeTool?: CanvasTool;
  pendingPlaceItem?: ElectricalItemType | null;
  showGrid?: boolean;
  snapEnabled?: boolean;
  zoom?: number;
  panOffset?: { x: number; y: number };
  previewOnly?: boolean;
  onPanChange?: (offset: { x: number; y: number }) => void;
  onZoomChange?: (nextZoom: number) => void;
  onSelectEntity?: (entity: SelectedEntity, additive?: boolean) => void;
  onSelectPoint?: (pointId: string, additive?: boolean) => void;
  onClearAllSelection?: () => void;
  onMoveAll?: (dxM: number, dyM: number) => void;
  onEmptySiteClick?: (xM: number, yM: number) => void;
  onUpdateRoom?: (
    roomId: string,
    patch: Partial<Pick<RoomZone, 'x' | 'y' | 'width' | 'height'>>,
    recordHistory?: boolean
  ) => void;
  onAddCustomWall?: (x1: number, y1: number, x2: number, y2: number) => void;
  onAddOpening?: (kind: 'door' | 'window', x: number, y: number, rotation: number) => void;
  onAddDimension?: (x1: number, y1: number, x2: number, y2: number) => void;
  onEraseEntity?: (entity: NonNullable<SelectedEntity> | { kind: 'dimension'; id: string }) => void;
  onRotateEntity?: (entity: NonNullable<SelectedEntity>) => void;
  onMovePoint?: (pointId: string, x: number, y: number, roomId: string) => void;
  onMoveOpening?: (openingId: string, x: number, y: number) => void;
  onMoveFurniture?: (furnitureId: string, x: number, y: number, roomId: string) => void;
  onDuplicatePoint?: (pointId: string) => ElectricalPoint | null;
  onDuplicateRoom?: (roomId: string) => RoomZone | null;
  onDuplicateOpening?: (openingId: string) => ArchitecturalOpening | null;
  onDuplicateFurniture?: (furnitureId: string) => FurnitureItem | null;
  onDuplicateWall?: (wallId: string) => void;
  onPlacePointAt?: (itemType: ElectricalItemType, x: number, y: number, roomId: string) => void;
  activeWireCategory?: WireCategory;
  allowInterFloorWiring?: boolean;
  onAddStaircase?: (x: number, y: number) => void;
  onMoveStaircase?: (staircaseId: string, x: number, y: number) => void;
  onCreateWire?: (fromPointId: string, toPointId: string, waypoints: WireWaypoint[]) => void;
  onUpdateWireWaypoints?: (
    wireId: string,
    waypoints: WireWaypoint[],
    recordHistory?: boolean
  ) => void;
  onAutoRouteWires?: () => void;
  onRecordHistorySnapshot?: () => void;
  onValidationWarning?: (message: string) => void;
  onApprove2DFor3D?: () => void;
  onExportDxf?: () => void;
  isolatedRoomId?: string | null;
  activeWireRoutingMode?: WireRoutingMode;
  activeWireDefaultZ?: number;
  wireConfigReady?: boolean;
  wireGridSnap?: boolean;
  pendingStartWirePointId?: string | null;
  pendingStartWireCoord?: { x: number; y: number } | null;
  onRequestCableConfig?: (startPointId?: string, startCoord?: { x: number; y: number }) => void;
  onConsumePendingStartWirePoint?: () => void;
  onEnterRoomView?: (roomId: string) => void;
  onToggleHideWall?: (floor: number, wallId: string) => void;
  onUpdateWallEndpoints?: (
    wallId: string,
    patch: { x1?: number; y1?: number; x2?: number; y2?: number },
    recordHistory?: boolean
  ) => void;
  onMaterializeAndSelectWall?: (wallSeg: MergedWallSegment) => string | null;
}

const CIRCUIT_COLORS: Record<CircuitId, string> = {
  'CKT-L1 (Lighting)': '#00A8FF',
  'CKT-L2 (Bedrooms)': '#38BDF8',
  'CKT-P1 (Kitchen)': '#FF9D00',
  'CKT-P2 (Power 16A)': '#F97316',
};

const ROOM_FILLS: Record<string, string> = {
  wood: 'rgba(0, 168, 255, 0.08)',
  tile: 'rgba(255, 157, 0, 0.08)',
  terrazzo: 'rgba(56, 189, 248, 0.06)',
  stone: 'rgba(148, 163, 184, 0.09)',
};

type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se' | 'e' | 's';

interface RoomDragState {
  mode: 'move' | 'resize';
  roomId: string;
  handle?: ResizeHandle;
  startPointerX: number;
  startPointerY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
  draftX: number;
  draftY: number;
  draftW: number;
  draftH: number;
  valid: boolean;
  reason?: string;
  moved: boolean;
}

interface GroupDragState {
  startPointerX: number;
  startPointerY: number;
  dx: number;
  dy: number;
  valid: boolean;
  moved: boolean;
}

export const FloorPlan2D: React.FC<FloorPlan2DProps> = ({
  project: fullProject,
  activeFloor = 1,
  selectedEntity = null,
  selectedEntities = [],
  selectedPointId = null,
  highlightedIds,
  activeHighlightId = null,
  focusTarget = null,
  allSelected = false,
  activeTool = 'select',
  pendingPlaceItem = null,
  showGrid = true,
  snapEnabled = true,
  zoom = 100,
  panOffset = { x: 0, y: 0 },
  previewOnly = false,
  onPanChange,
  onZoomChange,
  onSelectEntity,
  onSelectPoint,
  onClearAllSelection,
  onMoveAll,
  onEmptySiteClick,
  onUpdateRoom,
  onAddCustomWall,
  onAddOpening,
  onAddDimension,
  onEraseEntity,
  onRotateEntity,
  onMovePoint,
  onMoveOpening,
  onMoveFurniture,
  onDuplicatePoint,
  onDuplicateRoom,
  onDuplicateOpening,
  onDuplicateFurniture,
  onDuplicateWall,
  onPlacePointAt,
  activeWireCategory = 'phase',
  allowInterFloorWiring = false,
  onAddStaircase,
  onMoveStaircase,
  onCreateWire,
  onUpdateWireWaypoints,
  onAutoRouteWires,
  onRecordHistorySnapshot,
  onValidationWarning,
  onApprove2DFor3D,
  onExportDxf,
  isolatedRoomId = null,
  activeWireRoutingMode = 'freeform',
  activeWireDefaultZ,
  wireConfigReady = true,
  wireGridSnap = false,
  pendingStartWirePointId = null,
  pendingStartWireCoord = null,
  onRequestCableConfig,
  onConsumePendingStartWirePoint,
  onEnterRoomView,
  onToggleHideWall,
  onUpdateWallEndpoints,
  onMaterializeAndSelectWall,
}) => {
  const project = useMemo(
    () => sliceProjectForFloor(fullProject, activeFloor),
    [fullProject, activeFloor]
  );
  const wiringConfig = useMemo(() => getWiringConfig(fullProject), [fullProject]);
  const floorStaircases = useMemo<StaircaseItem[]>(
    () =>
      (fullProject.staircases ?? []).filter(
        (s) => s.fromFloor === activeFloor || s.toFloor === activeFloor
      ),
    [fullProject.staircases, activeFloor]
  );
  const visibleWires = useMemo<ElectricalWire[]>(() => {
    if (!wiringConfig.showWires) return [];
    const all = fullProject.wires ?? [];
    return all.filter((w) => {
      if (wiringConfig.visibleCategories[w.category] === false) return false;
      if (wiringConfig.showAllFloorsElectrical) return true;
      return w.floor === activeFloor || w.fromFloor === activeFloor || w.toFloor === activeFloor;
    });
  }, [fullProject.wires, activeFloor, wiringConfig]);
  const pointLookup = useMemo(() => {
    const m = new Map<string, ElectricalPoint>();
    fullProject.points.forEach((p) => m.set(p.id, p));
    return m;
  }, [fullProject.points]);

  const underlayRooms = useMemo(
    () => (activeFloor > 1 ? sliceProjectForFloor(fullProject, activeFloor - 1).rooms : []),
    [fullProject, activeFloor]
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number } | null>(null);
  const [wirePanelOpen, setWirePanelOpen] = useState(false);
  const [wireScopeAllFloors, setWireScopeAllFloors] = useState(false);
  const [allowancePct, setAllowancePct] = useState<number>(DEFAULT_INSTALLATION_ALLOWANCE_PCT);

  // Aligned Reference PDF vs Reconstructed CAD comparison state (for AI/PDF imported plans)
  const referenceOverlay = fullProject.aiDrawingImport?.referenceOverlay;
  const [showReferencePdf, setShowReferencePdf] = useState<boolean>(
    () => referenceOverlay?.visible ?? true
  );
  const [referencePdfOpacity, setReferencePdfOpacity] = useState<number>(
    () => referenceOverlay?.opacity ?? 0.45
  );
  const [showReconstructedCad, setShowReconstructedCad] = useState<boolean>(true);
  const [cadLayersOpen, setCadLayersOpen] = useState<boolean>(false);
  const [cadLayers, setCadLayers] = useState<{
    walls: boolean;
    rooms: boolean;
    openings: boolean;
    columns: boolean;
    symbols: boolean;
    dimensions: boolean;
    labels: boolean;
  }>(() => {
    const getLayerVis = (id: string) =>
      fullProject.aiDrawingImport?.layers?.find((l) => l.id === id)?.visible ?? true;
    return {
      walls: getLayerVis('walls'),
      rooms: getLayerVis('rooms'),
      openings: getLayerVis('openings'),
      columns: getLayerVis('columns'),
      symbols: getLayerVis('symbols'),
      dimensions: getLayerVis('dimensions'),
      labels: getLayerVis('labels'),
    };
  });

  useEffect(() => {
    if (referenceOverlay) {
      setShowReferencePdf(referenceOverlay.visible);
      setReferencePdfOpacity(referenceOverlay.opacity);
      setShowReconstructedCad(true);
    }
    const getLayerVis = (id: string) =>
      fullProject.aiDrawingImport?.layers?.find((l) => l.id === id)?.visible ?? true;
    setCadLayers({
      walls: getLayerVis('walls'),
      rooms: getLayerVis('rooms'),
      openings: getLayerVis('openings'),
      columns: getLayerVis('columns'),
      symbols: getLayerVis('symbols'),
      dimensions: getLayerVis('dimensions'),
      labels: getLayerVis('labels'),
    });
  }, [fullProject.id, referenceOverlay?.dataUrl]);

  useEffect(() => {
    if (previewOnly) return;
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setViewportSize((prev) =>
          prev && Math.abs(prev.width - rect.width) < 1 && Math.abs(prev.height - rect.height) < 1
            ? prev
            : { width: rect.width, height: rect.height }
        );
      }
    };
    updateSize();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [previewOnly]);

  const [draggingPoint, setDraggingPoint] = useState<{
    id: string;
    startX: number;
    startY: number;
    moved: boolean;
    snapshotRecorded: boolean;
  } | null>(null);
  const [draggingOpening, setDraggingOpening] = useState<{
    id: string;
    startX: number;
    startY: number;
    moved: boolean;
    snapshotRecorded: boolean;
  } | null>(null);
  const [draggingFurniture, setDraggingFurniture] = useState<{
    id: string;
    startX: number;
    startY: number;
    moved: boolean;
    snapshotRecorded: boolean;
  } | null>(null);
  const [draggingStaircase, setDraggingStaircase] = useState<{
    id: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
    snapshotRecorded: boolean;
  } | null>(null);
  const [wireDraft, setWireDraft] = useState<{
    fromPointId: string;
    waypoints: WireWaypoint[];
    preview: { x: number; y: number } | null;
  } | null>(null);
  const [selectedVertexRef, setSelectedVertexRef] = useState<{
    wireId: string;
    index: number;
  } | null>(null);
  const [draggingWaypoint, setDraggingWaypoint] = useState<{
    wireId: string;
    index: number;
    snapshotRecorded: boolean;
  } | null>(null);
  const [draggingWireRoute, setDraggingWireRoute] = useState<{
    wireId: string;
    startX: number;
    startY: number;
    origWaypoints: WireWaypoint[];
    moved: boolean;
    snapshotRecorded: boolean;
  } | null>(null);
  const [draggingWallEndpoint, setDraggingWallEndpoint] = useState<{
    wallId: string;
    endpoint: 'start' | 'end';
    snapshotRecorded: boolean;
  } | null>(null);
  const [roomDrag, setRoomDrag] = useState<RoomDragState | null>(null);
  const [groupDrag, setGroupDrag] = useState<GroupDragState | null>(null);
  const [lineStart, setLineStart] = useState<{ x: number; y: number } | null>(null);
  const [linePreview, setLinePreview] = useState<{ x: number; y: number } | null>(null);
  const [hoverOpening, setHoverOpening] = useState<{
    x: number;
    y: number;
    rotation: number;
    kind: 'door' | 'window';
  } | null>(null);
  const [panStart, setPanStart] = useState<{
    x: number;
    y: number;
    ox: number;
    oy: number;
    pointerId: number;
  } | null>(null);

  // Clear active wire draft when switching away from add-wire
  useEffect(() => {
    if (activeTool !== 'add-wire' && wireDraft) {
      setWireDraft(null);
    }
  }, [activeTool, wireDraft]);

  // Clear selected vertex grip if its wire is no longer selected
  useEffect(() => {
    if (!selectedVertexRef) return;
    const stillSelected =
      selectedEntity?.kind === 'wire' && selectedEntity.id === selectedVertexRef.wireId;
    if (!stillSelected) {
      setSelectedVertexRef(null);
    }
  }, [selectedEntity, selectedVertexRef]);

  // Helper to finish an active AutoCAD LINE/POLYLINE cable route (used by Enter key & Double-click)
  const finishWireDraft = (finishCoord?: { x: number; y: number } | null, isDoubleClick = false) => {
    if (!wireDraft) return;
    const fromPt = pointLookup.get(wireDraft.fromPointId);
    if (!fromPt) {
      setWireDraft(null);
      return;
    }
    const lastAnchor =
      finishCoord ??
      wireDraft.preview ??
      (wireDraft.waypoints.length > 0
        ? wireDraft.waypoints[wireDraft.waypoints.length - 1]
        : { x: fromPt.x, y: fromPt.y });

    const candidates = allowInterFloorWiring ? fullProject.points : project.points;
    let targetPt: ElectricalPoint | null = null;
    let bestDist = Infinity;
    candidates.forEach((pt) => {
      if (pt.id === fromPt.id) return;
      const compat = checkTerminalCompatibility(
        fromPt,
        pt,
        activeWireCategory,
        allowInterFloorWiring
      );
      if (!compat.compatible) return;
      const d = Math.hypot(pt.x - lastAnchor.x, pt.y - lastAnchor.y);
      if (d < bestDist) {
        bestDist = d;
        targetPt = pt;
      }
    });

    if (!targetPt) {
      onValidationWarning?.(
        'Place at least two compatible electrical components to complete this cable route (press Esc to cancel).'
      );
      return;
    }

    const chosen = targetPt as ElectricalPoint;
    const compat = checkTerminalCompatibility(
      fromPt,
      chosen,
      activeWireCategory,
      allowInterFloorWiring
    );
    if (!compat.compatible) {
      onValidationWarning?.(compat.reason || 'Selected electrical terminals are incompatible.');
      return;
    }

    const finalWaypoints = finalizePolylineWaypoints(wireDraft.waypoints, chosen, isDoubleClick);
    if (compat.warning) {
      onValidationWarning?.(compat.warning);
    }
    onCreateWire?.(fromPt.id, chosen.id, finalWaypoints);
    setWireDraft(null);
  };

  // If user clicked the canvas or an electrical component to open the Cable Selection Popup and confirmed it,
  // start AutoCAD LINE/POLYLINE drafting immediately from that exact starting point.
  useEffect(() => {
    if (
      activeTool === 'add-wire' &&
      wireConfigReady &&
      (pendingStartWirePointId || pendingStartWireCoord) &&
      !wireDraft
    ) {
      if (pendingStartWirePointId) {
        const pt = pointLookup.get(pendingStartWirePointId);
        if (pt) {
          setWireDraft({
            fromPointId: pt.id,
            waypoints: [],
            preview: { x: pt.x, y: pt.y },
          });
        }
      } else if (pendingStartWireCoord) {
        const candidates = allowInterFloorWiring ? fullProject.points : project.points;
        const resolved = resolvePolylineStartPoint(pendingStartWireCoord, candidates, {
          snapRadiusM: 0.55,
          defaultZ: activeWireDefaultZ,
        });
        if (resolved) {
          setWireDraft({
            fromPointId: resolved.fromPoint.id,
            waypoints: resolved.initialWaypoints,
            preview:
              resolved.initialWaypoints[0] ?? {
                x: resolved.fromPoint.x,
                y: resolved.fromPoint.y,
              },
          });
        } else {
          onValidationWarning?.(
            'Place electrical components on this floor first before routing a cable.'
          );
        }
      }
      onConsumePendingStartWirePoint?.();
    }
  }, [
    activeTool,
    wireConfigReady,
    pendingStartWirePointId,
    pendingStartWireCoord,
    wireDraft,
    pointLookup,
    allowInterFloorWiring,
    fullProject.points,
    project.points,
    activeWireDefaultZ,
    onConsumePendingStartWirePoint,
    onValidationWarning,
  ]);

  // AutoCAD LINE/POLYLINE keyboard controls: Enter = finish, Esc = cancel, Backspace = undo last vertex
  useEffect(() => {
    if (!wireDraft) return;
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        setWireDraft(null);
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
        finishWireDraft(wireDraft.preview, false);
      } else if (ev.key === 'Backspace') {
        ev.preventDefault();
        ev.stopPropagation();
        if (wireDraft.waypoints.length > 0) {
          setWireDraft((prev) =>
            prev ? { ...prev, waypoints: prev.waypoints.slice(0, -1) } : null
          );
        } else {
          setWireDraft(null);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Delete / Backspace removes the focused vertex grip on a selected cable without deleting the cable itself
  useEffect(() => {
    if (!selectedVertexRef || !onUpdateWireWaypoints) return;
    const onVertexKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        const wire = (fullProject.wires ?? []).find((w) => w.id === selectedVertexRef.wireId);
        if (!wire || selectedVertexRef.index < 0 || selectedVertexRef.index >= wire.waypoints.length) {
          setSelectedVertexRef(null);
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        onRecordHistorySnapshot?.();
        onUpdateWireWaypoints(
          wire.id,
          wire.waypoints.filter((_, i) => i !== selectedVertexRef.index),
          false
        );
        setSelectedVertexRef(null);
      } else if (ev.key === 'Escape') {
        setSelectedVertexRef(null);
      }
    };
    window.addEventListener('keydown', onVertexKey, true);
    return () => window.removeEventListener('keydown', onVertexKey, true);
  }, [selectedVertexRef, fullProject.wires, onRecordHistorySnapshot, onUpdateWireWaypoints]);

  const { lengthM, widthM, ceilingM } = useMemo(() => siteToMeters(project.site), [project.site]);
  const floorBounds = useMemo(
    () => getFloorBoundaryMeters(fullProject, activeFloor),
    [fullProject, activeFloor]
  );
  const allMergedWalls = useMemo(
    () => extractMergedWalls(project, { includeHidden: true, floor: activeFloor }),
    [project, activeFloor]
  );
  const mergedWalls = useMemo(
    () => allMergedWalls.filter((w) => !w.isHidden),
    [allMergedWalls]
  );
  const isolatedRoom = useMemo(
    () => (isolatedRoomId ? project.rooms.find((r) => r.id === isolatedRoomId) ?? null : null),
    [project.rooms, isolatedRoomId]
  );
  const prevIsolatedRoomIdRef = useRef<string | null>(null);
  const units = project.site.units;

  // Calibrated 1:4 (width:height) CAD sheet with viewport-matched isotropic scaling (scaleX === scaleY)
  const canvasMetrics = useMemo(
    () =>
      computeCalibrated2DCanvasMetrics(lengthM, widthM, {
        previewOnly,
        viewport: viewportSize,
      }),
    [lengthM, widthM, previewOnly, viewportSize]
  );
  const SCALE = canvasMetrics.scalePxPerMeter;
  const PAD = canvasMetrics.pad;
  const planW = canvasMetrics.planW;
  const planH = canvasMetrics.planH;
  const sheetW = canvasMetrics.sheetW;
  const sheetH = canvasMetrics.sheetH;
  const originX = canvasMetrics.originX;
  const originY = canvasMetrics.originY;
  const planCenterX = canvasMetrics.planCenterX;
  const planCenterY = canvasMetrics.planCenterY;
  const viewX = canvasMetrics.viewX;
  const viewY = canvasMetrics.viewY;
  const vbW = canvasMetrics.vbW;
  const vbH = canvasMetrics.vbH;

  // Live auto-recalculating real-world wire quantity report (L / N / E separately in m & ft)
  const activeWireReport = useMemo(
    () =>
      computeDetailedWireQuantityReport(fullProject, {
        floor: wireScopeAllFloors ? undefined : activeFloor,
        installationAllowancePct: allowancePct,
      }),
    [fullProject, activeFloor, wireScopeAllFloors, allowancePct]
  );

  // Count sibling conductors sharing each undirected corridor for parallel visual separation
  const corridorConductorCount = useMemo(() => {
    const counts = new Map<string, number>();
    visibleWires.forEach((w) => {
      const key =
        w.fromPointId < w.toPointId
          ? `${w.fromPointId}::${w.toPointId}`
          : `${w.toPointId}::${w.fromPointId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return counts;
  }, [visibleWires]);

  // Auto-center viewport pan when Find Component navigates to a component in 2D
  useEffect(() => {
    if (previewOnly || !focusTarget || !onPanChange) return;
    const zoomFactor = zoom / 100;
    const targetSheetX = originX + focusTarget.x * SCALE;
    const targetSheetY = originY + focusTarget.y * SCALE;
    const nextPanX = Math.round((planCenterX - targetSheetX) * zoomFactor);
    const nextPanY = Math.round((planCenterY - targetSheetY) * zoomFactor);
    onPanChange({ x: nextPanX, y: nextPanY });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTarget?.nonce]);

  // Auto-frame isolated room top-down view in 2D and restore full building view when exiting (ESC)
  useEffect(() => {
    if (previewOnly || !onPanChange || !onZoomChange) return;
    if (isolatedRoom) {
      const roomWpx = Math.max(40, isolatedRoom.width * SCALE);
      const roomHpx = Math.max(40, isolatedRoom.height * SCALE);
      const fitZoom = Math.round(
        Math.max(115, Math.min(280, Math.min((vbW * 0.72) / roomWpx, (vbH * 0.72) / roomHpx) * 100))
      );
      const zoomFactor = fitZoom / 100;
      const roomCenterSheetX = originX + (isolatedRoom.x + isolatedRoom.width / 2) * SCALE;
      const roomCenterSheetY = originY + (isolatedRoom.y + isolatedRoom.height / 2) * SCALE;
      onZoomChange(fitZoom);
      onPanChange({
        x: Math.round((planCenterX - roomCenterSheetX) * zoomFactor),
        y: Math.round((planCenterY - roomCenterSheetY) * zoomFactor),
      });
    } else if (prevIsolatedRoomIdRef.current !== null) {
      onZoomChange(100);
      onPanChange({ x: 0, y: 0 });
    }
    prevIsolatedRoomIdRef.current = isolatedRoom?.id ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isolatedRoom?.id]);

  // Architectural grid step in SVG units (1 ft or 0.5 m minor; 5 ft or 2 m major)
  const minorGridM = units === 'ft' ? FT_TO_M : 0.5;
  const majorGridM = units === 'ft' ? 5 * FT_TO_M : 2;
  const minorStepPx = minorGridM * SCALE;
  const majorStepPx = majorGridM * SCALE;

  const selectedEntitySet = useMemo(() => {
    const map = new Set<string>();
    if (selectedEntity) map.add(`${selectedEntity.kind}:${selectedEntity.id}`);
    if (selectedPointId) map.add(`point:${selectedPointId}`);
    selectedEntities.forEach((e) => map.add(`${e.kind}:${e.id}`));
    return map;
  }, [selectedEntity, selectedPointId, selectedEntities]);

  const isEntitySelected = (kind: StudioEntityRef['kind'], id: string) =>
    !previewOnly && (allSelected || selectedEntitySet.has(`${kind}:${id}`));

  const selectedRoomId =
    selectedEntity?.kind === 'room' ? selectedEntity.id : null;

  const clientToRawMeters = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0, inside: false };
    const rect = svg.getBoundingClientRect();
    return screenToCalibratedMeters(clientX, clientY, rect, canvasMetrics, zoom, panOffset);
  };

  // Group electrical points by circuit for dashed schematic overlay
  const circuitPaths = useMemo(() => {
    const groups = new Map<CircuitId, ElectricalPoint[]>();
    project.points.forEach((pt) => {
      if (!pt.circuit) return;
      const list = groups.get(pt.circuit) ?? [];
      list.push(pt);
      groups.set(pt.circuit, list);
    });

    const paths: { circuit: CircuitId; color: string; d: string }[] = [];
    groups.forEach((pts, circuit) => {
      if (pts.length < 2) return;
      const sorted = [...pts].sort((a, b) => a.x + a.y * 0.4 - (b.x + b.y * 0.4));
      const d = sorted
        .map(
          (p, idx) =>
            `${idx === 0 ? 'M' : 'L'} ${(PAD + p.x * SCALE).toFixed(1)} ${(PAD + p.y * SCALE).toFixed(1)}`
        )
        .join(' ');
      paths.push({
        circuit,
        color: CIRCUIT_COLORS[circuit] ?? '#FF9D00',
        d,
      });
    });
    return paths;
  }, [project.points, PAD, SCALE]);

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    if (previewOnly || !onZoomChange) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -10 : 10;
    onZoomChange(Math.max(15, Math.min(300, zoom + delta)));
  };

  const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (previewOnly) return;

    // Middle mouse button or Pan tool starts smooth 1:1 panning anywhere over the model
    if (activeTool === 'pan' || e.button === 1) {
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture is unsupported
      }
      setPanStart({
        x: e.clientX,
        y: e.clientY,
        ox: panOffset.x,
        oy: panOffset.y,
        pointerId: e.pointerId,
      });
      return;
    }

    const raw = clientToRawMeters(e.clientX, e.clientY);
    const snapped = snapCoordinate(raw.x, raw.y, project, snapEnabled);

    // If all objects are selected (Ctrl+A) and user drags anywhere on the canvas, drag the whole model together
    if (
      allSelected &&
      (activeTool === 'select' || activeTool === 'move') &&
      (project.rooms.length > 0 ||
        project.customWalls.length > 0 ||
        project.openings.length > 0 ||
        project.points.length > 0)
    ) {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      setGroupDrag({
        startPointerX: raw.x,
        startPointerY: raw.y,
        dx: 0,
        dy: 0,
        valid: true,
        moved: false,
      });
      return;
    }

    if (allSelected) {
      onClearAllSelection?.();
    }

    // Placing an electrical component
    if (pendingPlaceItem && onPlacePointAt) {
      if (!raw.inside) return;
      if (isolatedRoom) {
        const pad = 0.12;
        const cx = Math.max(
          isolatedRoom.x + pad,
          Math.min(isolatedRoom.x + Math.max(pad * 2, isolatedRoom.width - pad), snapped.x)
        );
        const cy = Math.max(
          isolatedRoom.y + pad,
          Math.min(isolatedRoom.y + Math.max(pad * 2, isolatedRoom.height - pad), snapped.y)
        );
        onPlacePointAt(
          pendingPlaceItem,
          Number(cx.toFixed(2)),
          Number(cy.toFixed(2)),
          isolatedRoom.id
        );
        return;
      }
      const targetRoom = findRoomAtPoint(project.rooms, snapped.x, snapped.y) ?? project.rooms[0];
      onPlacePointAt(pendingPlaceItem, snapped.x, snapped.y, targetRoom?.id ?? '');
      return;
    }

    // Draw Wall or Dimension tool
    if (activeTool === 'draw-wall' || activeTool === 'dimension') {
      if (!raw.inside) return;
      setLineStart(snapped);
      setLinePreview(snapped);
      return;
    }

    // Add Door or Add Window snapped to nearest wall
    if ((activeTool === 'add-door' || activeTool === 'add-window') && onAddOpening) {
      const kind = activeTool === 'add-door' ? 'door' : 'window';
      const attach = findNearestWallAttachment(raw.x, raw.y, mergedWalls, 1.1);
      if (attach) {
        onAddOpening(kind, attach.x, attach.y, attach.rotation);
      } else {
        onValidationWarning?.(
          `Click closer to an exterior or room wall to place a ${kind}.`
        );
      }
      return;
    }

    // Add Staircase tool: click inside site boundary to place parametric staircase
    if (activeTool === 'add-staircase' && onAddStaircase) {
      if (!raw.inside) return;
      onAddStaircase(snapped.x, snapped.y);
      return;
    }

    // Add Wire tool (AutoCAD LINE/POLYLINE workflow):
    // 1. If cable config not confirmed yet, open Cable Selection Popup & remember clicked start point
    // 2. If no active draft, start polyline from clicked canvas coordinate (snapping to nearby component if within 0.55m)
    // 3. While drafting, each left-click places a connected intermediate vertex freely in any direction/angle
    if (activeTool === 'add-wire') {
      const useGridSnap = wireGridSnap && snapEnabled;
      const baseCoord = useGridSnap
        ? snapCoordinate(raw.x, raw.y, project, true)
        : {
            x: Number(raw.x.toFixed(2)),
            y: Number(raw.y.toFixed(2)),
          };
      const candidates = allowInterFloorWiring ? fullProject.points : project.points;

      if (!wireConfigReady) {
        const resolved = resolvePolylineStartPoint(baseCoord, candidates, {
          snapRadiusM: 0.55,
          defaultZ: activeWireDefaultZ,
        });
        onRequestCableConfig?.(
          resolved?.snappedToComponent ? resolved.fromPoint.id : undefined,
          baseCoord
        );
        return;
      }

      if (!wireDraft) {
        const resolved = resolvePolylineStartPoint(baseCoord, candidates, {
          snapRadiusM: 0.55,
          defaultZ: activeWireDefaultZ,
        });
        if (!resolved) {
          onValidationWarning?.(
            'Place electrical components on this floor first before routing a cable.'
          );
          return;
        }
        setWireDraft({
          fromPointId: resolved.fromPoint.id,
          waypoints: resolved.initialWaypoints,
          preview:
            resolved.initialWaypoints[0] ?? {
              x: resolved.fromPoint.x,
              y: resolved.fromPoint.y,
            },
        });
        return;
      }

      // Second click ends the cable route immediately (one click to start, one click to end)
      const fromPt = pointLookup.get(wireDraft.fromPointId);
      if (!fromPt) {
        setWireDraft(null);
        return;
      }

      const anchor =
        wireDraft.waypoints.length > 0
          ? wireDraft.waypoints[wireDraft.waypoints.length - 1]
          : fromPt;
      let ex = baseCoord.x;
      let ey = baseCoord.y;
      const enforceOrthogonal =
        activeWireRoutingMode === 'orthogonal' ? !e.shiftKey : e.shiftKey;
      if (enforceOrthogonal) {
        if (Math.abs(ex - anchor.x) >= Math.abs(ey - anchor.y)) {
          ey = anchor.y;
        } else {
          ex = anchor.x;
        }
      }
      const endCoord = { x: Number(ex.toFixed(2)), y: Number(ey.toFixed(2)) };

      // Find nearest compatible destination electrical component to the clicked end point
      let targetPt: ElectricalPoint | null = null;
      let bestDist = Infinity;
      candidates.forEach((pt) => {
        if (pt.id === fromPt.id) return;
        const compat = checkTerminalCompatibility(
          fromPt,
          pt,
          activeWireCategory,
          allowInterFloorWiring
        );
        if (!compat.compatible) return;
        const d = Math.hypot(pt.x - endCoord.x, pt.y - endCoord.y);
        if (d < bestDist) {
          bestDist = d;
          targetPt = pt;
        }
      });

      if (!targetPt) {
        onValidationWarning?.(
          'Place at least two compatible electrical components to complete this cable route (press Esc to cancel).'
        );
        setWireDraft(null);
        return;
      }

      const chosen = targetPt as ElectricalPoint;
      const compat = checkTerminalCompatibility(
        fromPt,
        chosen,
        activeWireCategory,
        allowInterFloorWiring
      );
      if (!compat.compatible) {
        onValidationWarning?.(compat.reason || 'Selected electrical terminals are incompatible.');
        setWireDraft(null);
        return;
      }

      // If user clicked directly on/near the destination component (<= 0.55m), connect straight to it;
      // otherwise include the exact clicked end coordinate in the route before anchoring to the component.
      const nextWps =
        bestDist <= 0.55
          ? wireDraft.waypoints
          : appendPolylineVertex(wireDraft.waypoints, fromPt, endCoord, {
              defaultZ: activeWireDefaultZ,
            });
      const finalWps = finalizePolylineWaypoints(nextWps, chosen, false);
      if (compat.warning) onValidationWarning?.(compat.warning);
      onCreateWire?.(fromPt.id, chosen.id, finalWps);
      setWireDraft(null);
      return;
    }

    // Default Select tool: clicking empty space on the canvas simply clears selection
    if (activeTool === 'select') {
      onSelectEntity?.(null);
      onClearAllSelection?.();
      return;
    }

    // Add Room tool: click on empty area inside site boundary -> Create Room Modal
    if (activeTool === 'add-room' && raw.inside) {
      if (isolatedRoom) {
        onSelectEntity?.(null);
        return;
      }
      const clickedExistingRoom = project.rooms.some((r) => isPointInsideRoom(r, raw.x, raw.y));
      if (!clickedExistingRoom) {
        onSelectEntity?.(null);
        onEmptySiteClick?.(snapped.x, snapped.y);
      }
      return;
    }

    if (!raw.inside) {
      onSelectEntity?.(null);
      onClearAllSelection?.();
    }
  };

  const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (previewOnly) return;

    if (panStart) {
      const svg = svgRef.current;
      let fitScale = 1;
      if (svg) {
        const rect = svg.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          fitScale = Math.min(rect.width / vbW, rect.height / vbH);
        }
      }
      const dx = (e.clientX - panStart.x) / fitScale;
      const dy = (e.clientY - panStart.y) / fitScale;
      onPanChange?.({ x: panStart.ox + dx, y: panStart.oy + dy });
      return;
    }

    const raw = clientToRawMeters(e.clientX, e.clientY);

    // Dragging all selected items together freely anywhere on canvas (after Ctrl+A)
    if (groupDrag) {
      const step = snapEnabled ? (units === 'ft' ? 0.5 * FT_TO_M : 0.1) : 0.01;
      const rawDx = raw.x - groupDrag.startPointerX;
      const rawDy = raw.y - groupDrag.startPointerY;
      const dx = Number((Math.round(rawDx / step) * step).toFixed(3));
      const dy = Number((Math.round(rawDy / step) * step).toFixed(3));
      const moved = groupDrag.moved || Math.hypot(rawDx, rawDy) > 0.06;

      setGroupDrag({
        ...groupDrag,
        dx,
        dy,
        valid: true,
        moved,
      });
      return;
    }

    // Live opening snap preview when Add Door or Add Window is active
    if (activeTool === 'add-door' || activeTool === 'add-window') {
      const kind = activeTool === 'add-door' ? 'door' : 'window';
      const attach = findNearestWallAttachment(raw.x, raw.y, mergedWalls, 1.1);
      if (attach) {
        setHoverOpening({ x: attach.x, y: attach.y, rotation: attach.rotation, kind });
      } else {
        setHoverOpening(null);
      }
      return;
    } else if (hoverOpening) {
      setHoverOpening(null);
    }

    // Dragging an electrical point freely (clamped inside isolatedRoom if room view is active)
    if (draggingPoint && onMovePoint) {
      const dist = Math.hypot(raw.x - draggingPoint.startX, raw.y - draggingPoint.startY);
      if (!draggingPoint.moved && dist < 0.06) return;
      if (!draggingPoint.snapshotRecorded) {
        onRecordHistorySnapshot?.();
      }
      if (!draggingPoint.moved || !draggingPoint.snapshotRecorded) {
        setDraggingPoint((prev) => (prev ? { ...prev, moved: true, snapshotRecorded: true } : null));
      }
      const snapped = snapCoordinateFree(raw.x, raw.y, project, snapEnabled);
      if (isolatedRoom) {
        const pad = 0.1;
        const cx = Math.max(
          isolatedRoom.x + pad,
          Math.min(isolatedRoom.x + Math.max(pad * 2, isolatedRoom.width - pad), snapped.x)
        );
        const cy = Math.max(
          isolatedRoom.y + pad,
          Math.min(isolatedRoom.y + Math.max(pad * 2, isolatedRoom.height - pad), snapped.y)
        );
        onMovePoint(draggingPoint.id, Number(cx.toFixed(2)), Number(cy.toFixed(2)), isolatedRoom.id);
        return;
      }
      const room = findRoomAtPoint(project.rooms, snapped.x, snapped.y) ?? project.rooms[0];
      onMovePoint(draggingPoint.id, snapped.x, snapped.y, room?.id ?? '');
      return;
    }

    // Dragging an editable wall endpoint handle
    if (draggingWallEndpoint && onUpdateWallEndpoints) {
      if (!draggingWallEndpoint.snapshotRecorded) {
        onRecordHistorySnapshot?.();
        setDraggingWallEndpoint((prev) => (prev ? { ...prev, snapshotRecorded: true } : null));
      }
      const snapped = snapCoordinate(raw.x, raw.y, project, snapEnabled);
      const patch =
        draggingWallEndpoint.endpoint === 'start'
          ? { x1: Number(snapped.x.toFixed(2)), y1: Number(snapped.y.toFixed(2)) }
          : { x2: Number(snapped.x.toFixed(2)), y2: Number(snapped.y.toFixed(2)) };
      onUpdateWallEndpoints(draggingWallEndpoint.wallId, patch, false);
      return;
    }

    // Dragging a door/window opening freely (record single pre-drag snapshot for Ctrl+Z!)
    if (draggingOpening && onMoveOpening) {
      const dist = Math.hypot(raw.x - draggingOpening.startX, raw.y - draggingOpening.startY);
      if (!draggingOpening.moved && dist < 0.06) return;
      if (!draggingOpening.snapshotRecorded) {
        onRecordHistorySnapshot?.();
      }
      if (!draggingOpening.moved || !draggingOpening.snapshotRecorded) {
        setDraggingOpening((prev) => (prev ? { ...prev, moved: true, snapshotRecorded: true } : null));
      }
      const snapped = snapCoordinateFree(raw.x, raw.y, project, snapEnabled);
      onMoveOpening(draggingOpening.id, snapped.x, snapped.y);
      return;
    }

    // Dragging a furniture item freely (record single pre-drag snapshot for Ctrl+Z!)
    if (draggingFurniture && onMoveFurniture) {
      const dist = Math.hypot(raw.x - draggingFurniture.startX, raw.y - draggingFurniture.startY);
      if (!draggingFurniture.moved && dist < 0.06) return;
      if (!draggingFurniture.snapshotRecorded) {
        onRecordHistorySnapshot?.();
      }
      if (!draggingFurniture.moved || !draggingFurniture.snapshotRecorded) {
        setDraggingFurniture((prev) => (prev ? { ...prev, moved: true, snapshotRecorded: true } : null));
      }
      const snapped = snapCoordinateFree(raw.x, raw.y, project, snapEnabled);
      const room = findRoomAtPoint(project.rooms, snapped.x, snapped.y) ?? project.rooms[0];
      onMoveFurniture(draggingFurniture.id, snapped.x, snapped.y, room?.id ?? '');
      return;
    }

    // Dragging (freely dismantling/placing) or Resizing a room
    if (roomDrag) {
      const dx = raw.x - roomDrag.startPointerX;
      const dy = raw.y - roomDrag.startPointerY;
      const moved = roomDrag.moved || Math.hypot(dx, dy) > 0.06;

      let nextX = roomDrag.origX;
      let nextY = roomDrag.origY;
      let nextW = roomDrag.origW;
      let nextH = roomDrag.origH;
      const minSize = units === 'ft' ? 3 * FT_TO_M : 0.9;

      if (roomDrag.mode === 'move') {
        const target = snapCoordinateFree(
          roomDrag.origX + dx,
          roomDrag.origY + dy,
          project,
          snapEnabled,
          roomDrag.roomId
        );
        // Also magnetically snap right/bottom edge to adjacent room edges or site perimeter without trapping
        let finalX = target.x;
        let finalY = target.y;
        if (snapEnabled) {
          const rightEdge = target.x + roomDrag.origW;
          const botEdge = target.y + roomDrag.origH;
          const xGuides = [
            0,
            lengthM,
            ...project.rooms
              .filter((r) => r.id !== roomDrag.roomId)
              .flatMap((r) => [r.x, r.x + r.width]),
          ];
          const yGuides = [
            0,
            widthM,
            ...project.rooms
              .filter((r) => r.id !== roomDrag.roomId)
              .flatMap((r) => [r.y, r.y + r.height]),
          ];
          for (const gx of xGuides) {
            if (Math.abs(rightEdge - gx) < 0.16) {
              finalX = Number((gx - roomDrag.origW).toFixed(3));
              break;
            }
          }
          for (const gy of yGuides) {
            if (Math.abs(botEdge - gy) < 0.16) {
              finalY = Number((gy - roomDrag.origH).toFixed(3));
              break;
            }
          }
        }
        nextX = finalX;
        nextY = finalY;
      } else if (roomDrag.handle) {
        const snappedPtr = snapCoordinateFree(raw.x, raw.y, project, snapEnabled, roomDrag.roomId);
        const h = roomDrag.handle;
        const origRight = roomDrag.origX + roomDrag.origW;
        const origBottom = roomDrag.origY + roomDrag.origH;

        if (h === 'e' || h === 'se' || h === 'ne') {
          nextW = Math.max(minSize, Number((snappedPtr.x - roomDrag.origX).toFixed(3)));
        }
        if (h === 's' || h === 'se' || h === 'sw') {
          nextH = Math.max(minSize, Number((snappedPtr.y - roomDrag.origY).toFixed(3)));
        }
        if (h === 'nw' || h === 'sw') {
          const clampedLeft = Math.min(origRight - minSize, snappedPtr.x);
          nextX = Number(clampedLeft.toFixed(3));
          nextW = Number((origRight - clampedLeft).toFixed(3));
        }
        if (h === 'nw' || h === 'ne') {
          const clampedTop = Math.min(origBottom - minSize, snappedPtr.y);
          nextY = Number(clampedTop.toFixed(3));
          nextH = Number((origBottom - clampedTop).toFixed(3));
        }
      }

      const check = validateRoomPlacement(
        { x: nextX, y: nextY, width: nextW, height: nextH },
        project,
        roomDrag.roomId
      );

      setRoomDrag({
        ...roomDrag,
        draftX: nextX,
        draftY: nextY,
        draftW: nextW,
        draftH: nextH,
        valid: check.valid,
        reason: check.reason,
        moved,
      });
      return;
    }

    // Dragging a staircase freely
    if (draggingStaircase && onMoveStaircase) {
      const dx = raw.x - draggingStaircase.startX;
      const dy = raw.y - draggingStaircase.startY;
      if (!draggingStaircase.moved && Math.hypot(dx, dy) < 0.06) return;
      if (!draggingStaircase.snapshotRecorded) {
        onRecordHistorySnapshot?.();
      }
      if (!draggingStaircase.moved || !draggingStaircase.snapshotRecorded) {
        setDraggingStaircase((prev) =>
          prev ? { ...prev, moved: true, snapshotRecorded: true } : null
        );
      }
      const snapped = snapCoordinateFree(
        draggingStaircase.origX + dx,
        draggingStaircase.origY + dy,
        project,
        snapEnabled
      );
      onMoveStaircase(draggingStaircase.id, snapped.x, snapped.y);
      return;
    }

    // Dragging a single wire waypoint handle freely (optional grid snap, preserving wp.z height!)
    if (draggingWaypoint && onUpdateWireWaypoints) {
      const wire = (fullProject.wires ?? []).find((w) => w.id === draggingWaypoint.wireId);
      if (!wire) return;
      if (!draggingWaypoint.snapshotRecorded) {
        onRecordHistorySnapshot?.();
        setDraggingWaypoint((prev) => (prev ? { ...prev, snapshotRecorded: true } : null));
      }
      const useGridSnap = wireGridSnap && snapEnabled;
      const targetPt = useGridSnap
        ? snapCoordinate(raw.x, raw.y, project, true)
        : { x: Number(raw.x.toFixed(2)), y: Number(raw.y.toFixed(2)) };
      const nextWps = wire.waypoints.map((wp, idx) =>
        idx === draggingWaypoint.index
          ? { ...wp, x: Number(targetPt.x.toFixed(2)), y: Number(targetPt.y.toFixed(2)) }
          : wp
      );
      onUpdateWireWaypoints(wire.id, nextWps, false);
      return;
    }

    // Dragging a wire segment to shift the intermediate route freely while keeping endpoints anchored (preserving wp.z!)
    if (draggingWireRoute && onUpdateWireWaypoints) {
      const rawDx = raw.x - draggingWireRoute.startX;
      const rawDy = raw.y - draggingWireRoute.startY;
      if (!draggingWireRoute.moved && Math.hypot(rawDx, rawDy) < 0.05) return;
      if (!draggingWireRoute.snapshotRecorded) {
        onRecordHistorySnapshot?.();
      }
      if (!draggingWireRoute.moved || !draggingWireRoute.snapshotRecorded) {
        setDraggingWireRoute((prev) =>
          prev ? { ...prev, moved: true, snapshotRecorded: true } : null
        );
      }
      const useGridSnap = wireGridSnap && snapEnabled;
      const step = useGridSnap ? (units === 'ft' ? 0.5 * FT_TO_M : 0.1) : 0.01;
      const dx = Math.round(rawDx / step) * step;
      const dy = Math.round(rawDy / step) * step;
      const maxBoundX = Math.max(lengthM, floorBounds.lengthM);
      const maxBoundY = Math.max(widthM, floorBounds.widthM);
      const shifted = draggingWireRoute.origWaypoints.map((wp) => ({
        ...wp,
        x: Number(Math.max(0.02, Math.min(maxBoundX - 0.02, wp.x + dx)).toFixed(2)),
        y: Number(Math.max(0.02, Math.min(maxBoundY - 0.02, wp.y + dy)).toFixed(2)),
      }));
      onUpdateWireWaypoints(draggingWireRoute.wireId, shifted, false);
      return;
    }

    // Live AutoCAD LINE/POLYLINE rubber-band cable preview (free cursor movement in any direction/angle by default)
    if (activeTool === 'add-wire' && wireDraft) {
      const useGridSnap = wireGridSnap && snapEnabled;
      const baseCoord = useGridSnap
        ? snapCoordinate(raw.x, raw.y, project, true)
        : { x: Number(raw.x.toFixed(2)), y: Number(raw.y.toFixed(2)) };
      const fromPt = pointLookup.get(wireDraft.fromPointId);
      const anchor =
        wireDraft.waypoints.length > 0
          ? wireDraft.waypoints[wireDraft.waypoints.length - 1]
          : fromPt ?? baseCoord;
      let px = baseCoord.x;
      let py = baseCoord.y;
      const enforceOrthogonal =
        activeWireRoutingMode === 'orthogonal' ? !e.shiftKey : e.shiftKey;
      if (enforceOrthogonal) {
        if (Math.abs(px - anchor.x) >= Math.abs(py - anchor.y)) {
          py = anchor.y;
        } else {
          px = anchor.x;
        }
      }
      setWireDraft((prev) =>
        prev
          ? { ...prev, preview: { x: Number(px.toFixed(2)), y: Number(py.toFixed(2)) } }
          : null
      );
      return;
    }

    // Wall drawing or Dimension drawing preview (orthogonal H/V snap unless Shift held)
    if (lineStart && (activeTool === 'draw-wall' || activeTool === 'dimension')) {
      const snapped = snapCoordinate(raw.x, raw.y, project, snapEnabled);
      let endX = snapped.x;
      let endY = snapped.y;

      if (!e.shiftKey) {
        const adx = Math.abs(endX - lineStart.x);
        const ady = Math.abs(endY - lineStart.y);
        if (adx >= ady) {
          endY = lineStart.y;
        } else {
          endX = lineStart.x;
        }
      }
      setLinePreview({ x: Number(endX.toFixed(3)), y: Number(endY.toFixed(3)) });
    }
  };

  const handleSvgPointerUp = (e?: React.PointerEvent<SVGSVGElement>) => {
    if (previewOnly) return;

    if (panStart) {
      if (e) {
        try {
          e.currentTarget.releasePointerCapture(panStart.pointerId);
        } catch {
          // Ignore if already released
        }
      }
      setPanStart(null);
      return;
    }

    if (groupDrag) {
      if (groupDrag.moved && (Math.abs(groupDrag.dx) > 0.001 || Math.abs(groupDrag.dy) > 0.001)) {
        onMoveAll?.(groupDrag.dx, groupDrag.dy);
      } else if (!groupDrag.moved) {
        // Simple click without drag clears Select All
        onClearAllSelection?.();
      }
      setGroupDrag(null);
      return;
    }

    if (draggingPoint) {
      setDraggingPoint(null);
      return;
    }

    if (draggingOpening) {
      setDraggingOpening(null);
      return;
    }

    if (draggingFurniture) {
      setDraggingFurniture(null);
      return;
    }

    if (draggingStaircase) {
      setDraggingStaircase(null);
      return;
    }

    if (draggingWaypoint) {
      setDraggingWaypoint(null);
      return;
    }

    if (draggingWireRoute) {
      setDraggingWireRoute(null);
      return;
    }

    if (draggingWallEndpoint) {
      setDraggingWallEndpoint(null);
      return;
    }

    if (roomDrag) {
      if (roomDrag.moved) {
        // Allow freely dismantling & placing room sections anywhere on the canvas
        onUpdateRoom?.(
          roomDrag.roomId,
          {
            x: roomDrag.draftX,
            y: roomDrag.draftY,
            width: roomDrag.draftW,
            height: roomDrag.draftH,
          },
          true
        );
      }
      setRoomDrag(null);
      return;
    }

    if (lineStart && linePreview) {
      const dist = Math.hypot(linePreview.x - lineStart.x, linePreview.y - lineStart.y);
      if (dist >= 0.25) {
        if (activeTool === 'draw-wall') {
          onAddCustomWall?.(lineStart.x, lineStart.y, linePreview.x, linePreview.y);
        } else if (activeTool === 'dimension') {
          onAddDimension?.(lineStart.x, lineStart.y, linePreview.x, linePreview.y);
        }
      }
      setLineStart(null);
      setLinePreview(null);
    }
  };

  // Double-click to finish an active AutoCAD LINE/POLYLINE cable route cleanly
  const handleSvgDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (previewOnly || activeTool !== 'add-wire' || !wireDraft) return;
    e.preventDefault();
    const raw = clientToRawMeters(e.clientX, e.clientY);
    finishWireDraft(raw, true);
  };

  const startRoomInteraction = (
    e: React.PointerEvent,
    room: RoomZone,
    mode: 'move' | 'resize',
    handle?: ResizeHandle
  ) => {
    if (previewOnly) return;

    // Let Pan, middle-button drag, drawing tools, or Ctrl+A group drag bubble directly to <svg>
    if (
      e.button === 1 ||
      activeTool === 'pan' ||
      pendingPlaceItem ||
      activeTool === 'draw-wall' ||
      activeTool === 'hide-wall' ||
      activeTool === 'dimension' ||
      activeTool === 'add-door' ||
      activeTool === 'add-window' ||
      activeTool === 'add-staircase' ||
      activeTool === 'add-wire' ||
      (allSelected && mode === 'move' && (activeTool === 'select' || activeTool === 'move'))
    ) {
      return;
    }

    e.stopPropagation();

    if (activeTool === 'erase') {
      onEraseEntity?.({ kind: 'room', id: room.id });
      return;
    }
    if (activeTool === 'rotate') {
      onClearAllSelection?.();
      onSelectEntity?.({ kind: 'room', id: room.id });
      onRotateEntity?.({ kind: 'room', id: room.id });
      return;
    }

    // Ctrl + Left Click on a room -> duplicate immediately & allow dragging it freely
    if ((e.ctrlKey || e.metaKey) && e.button === 0 && mode === 'move' && onDuplicateRoom) {
      e.preventDefault();
      onClearAllSelection?.();
      const dup = onDuplicateRoom(room.id);
      if (dup) {
        try {
          svgRef.current?.setPointerCapture(e.pointerId);
        } catch {
          // Ignore if unsupported
        }
        const raw = clientToRawMeters(e.clientX, e.clientY);
        setRoomDrag({
          mode: 'move',
          roomId: dup.id,
          startPointerX: raw.x,
          startPointerY: raw.y,
          origX: dup.x,
          origY: dup.y,
          origW: dup.width,
          origH: dup.height,
          draftX: dup.x,
          draftY: dup.y,
          draftW: dup.width,
          draftH: dup.height,
          valid: true,
          moved: false,
        });
      }
      return;
    }

    if (e.shiftKey && mode === 'move') {
      onClearAllSelection?.();
      onSelectEntity?.({ kind: 'room', id: room.id }, true);
      return;
    }

    onClearAllSelection?.();
    onSelectEntity?.({ kind: 'room', id: room.id }, false);

    if (activeTool === 'select' || activeTool === 'move') {
      try {
        svgRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if unsupported
      }
      const raw = clientToRawMeters(e.clientX, e.clientY);
      setRoomDrag({
        mode,
        roomId: room.id,
        handle,
        startPointerX: raw.x,
        startPointerY: raw.y,
        origX: room.x,
        origY: room.y,
        origW: room.width,
        origH: room.height,
        draftX: room.x,
        draftY: room.y,
        draftW: room.width,
        draftH: room.height,
        valid: true,
        moved: false,
      });
    }
  };

  const cursorClass = previewOnly
    ? ''
    : pendingPlaceItem ||
        activeTool === 'draw-wall' ||
        activeTool === 'hide-wall' ||
        activeTool === 'add-room' ||
        activeTool === 'add-door' ||
        activeTool === 'add-window' ||
        activeTool === 'add-staircase' ||
        activeTool === 'add-wire' ||
        activeTool === 'dimension'
      ? 'cursor-crosshair'
      : activeTool === 'pan'
        ? panStart
          ? 'cursor-grabbing'
          : 'cursor-grab'
        : activeTool === 'erase'
          ? 'cursor-not-allowed'
          : activeTool === 'move'
            ? 'cursor-move'
            : 'cursor-default';

  const siteLenLabel = formatLength(lengthM, units, 1);
  const siteWidLabel = formatLength(widthM, units, 1);
  const customDims = project.dimensions ?? [];

  const handle2DDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (previewOnly) return;
    if (e.dataTransfer.types.includes('application/x-bluespace-electrical')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  const handle2DDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (previewOnly || !onPlacePointAt) return;
    const itemType = e.dataTransfer.getData('application/x-bluespace-electrical') as
      | ElectricalItemType
      | '';
    if (!itemType) return;
    e.preventDefault();
    const raw = clientToRawMeters(e.clientX, e.clientY);
    const snapped = snapCoordinate(raw.x, raw.y, project, snapEnabled);
    if (isolatedRoom) {
      const pad = 0.12;
      const cx = Math.max(
        isolatedRoom.x + pad,
        Math.min(isolatedRoom.x + Math.max(pad * 2, isolatedRoom.width - pad), snapped.x)
      );
      const cy = Math.max(
        isolatedRoom.y + pad,
        Math.min(isolatedRoom.y + Math.max(pad * 2, isolatedRoom.height - pad), snapped.y)
      );
      onPlacePointAt(itemType, Number(cx.toFixed(2)), Number(cy.toFixed(2)), isolatedRoom.id);
      return;
    }
    const targetRoom = findRoomAtPoint(project.rooms, snapped.x, snapped.y) ?? project.rooms[0];
    onPlacePointAt(itemType, snapped.x, snapped.y, targetRoom?.id ?? '');
  };

  return (
    <div
      ref={containerRef}
      onDragOver={handle2DDragOver}
      onDrop={handle2DDrop}
      data-canvas-aspect={previewOnly ? 'compact' : CANVAS_ASPECT_LABEL}
      className={`relative w-full h-full flex-1 min-h-0 flex items-center justify-center bg-surface select-none overflow-hidden ${
        previewOnly ? 'p-1.5' : 'p-gutter-sm'
      }`}
    >
      <svg
        ref={svgRef}
        tabIndex={previewOnly ? undefined : 0}
        viewBox={`${viewX} ${viewY} ${vbW} ${vbH}`}
        preserveAspectRatio="xMidYMid meet"
        className={`w-full h-full max-h-full overflow-visible touch-none outline-none ${cursorClass}`}
        onWheel={handleWheel}
        onPointerDown={handleSvgPointerDown}
        onPointerMove={handleSvgPointerMove}
        onPointerUp={handleSvgPointerUp}
        onPointerCancel={handleSvgPointerUp}
        onDoubleClick={handleSvgDoubleClick}
        onPointerLeave={(e) => {
          if (!panStart && !roomDrag && !groupDrag) handleSvgPointerUp(e);
        }}
      >
        <defs>
          <pattern
            id={`minor-grid-${project.id}`}
            width={minorStepPx}
            height={minorStepPx}
            patternUnits="userSpaceOnUse"
            x={PAD}
            y={PAD}
          >
            <path
              d={`M ${minorStepPx} 0 L 0 0 0 ${minorStepPx}`}
              fill="none"
              stroke="#18253C"
              strokeWidth="0.65"
            />
          </pattern>
          <pattern
            id={`major-grid-${project.id}`}
            width={majorStepPx}
            height={majorStepPx}
            patternUnits="userSpaceOnUse"
            x={PAD}
            y={PAD}
          >
            <rect width={majorStepPx} height={majorStepPx} fill={`url(#minor-grid-${project.id})`} />
            <path
              d={`M ${majorStepPx} 0 L 0 0 0 ${majorStepPx}`}
              fill="none"
              stroke="#243756"
              strokeWidth="1.05"
            />
          </pattern>
          <pattern
            id={`sheet-grid-${project.id}`}
            width={majorStepPx}
            height={majorStepPx}
            patternUnits="userSpaceOnUse"
            x={originX}
            y={originY}
          >
            <path
              d={`M ${majorStepPx} 0 L 0 0 0 ${majorStepPx}`}
              fill="none"
              stroke="#132038"
              strokeWidth="0.7"
            />
          </pattern>
        </defs>

        <g
          transform={`translate(${planCenterX + panOffset.x} ${planCenterY + panOffset.y}) scale(${zoom / 100}) translate(${-planCenterX} ${-planCenterY})`}
        >
          {/* Calibrated 1:4 (width:height) CAD Drawing Sheet */}
          {!previewOnly && (
            <g pointerEvents="none" data-cad-sheet="1:4">
              <rect
                x={0}
                y={0}
                width={sheetW}
                height={sheetH}
                fill={showGrid ? `url(#sheet-grid-${project.id})` : '#070E1D'}
                stroke="#1E3558"
                strokeWidth="1.5"
              />
              <rect
                x={8}
                y={8}
                width={sheetW - 16}
                height={sheetH - 16}
                fill="none"
                stroke="#162844"
                strokeWidth="0.8"
                strokeDasharray="6,6"
              />
              <text
                x={18}
                y={26}
                fill="#4E6B94"
                fontFamily="Red Hat Mono, monospace"
                fontSize="10"
                fontWeight="600"
              >
                {`1:4 CALIBRATED CAD SHEET · ${siteLenLabel} × ${siteWidLabel} · 1m = ${SCALE.toFixed(1)}u`}
              </text>
            </g>
          )}

          {/* Building Floor Plan Layer positioned at calibrated (originX, originY) inside the 1:4 sheet */}
          <g transform={`translate(${originX - PAD} ${originY - PAD})`}>
          {/* Site Interior Floor Slab */}
          <rect
            x={PAD}
            y={PAD}
            width={planW}
            height={planH}
            fill={showGrid ? `url(#major-grid-${project.id})` : '#0B1325'}
          />

          {/* Aligned Reference PDF / Source Drawing Underlay (Locked Reference Layer) */}
          {!previewOnly &&
            referenceOverlay?.dataUrl &&
            showReferencePdf && (
              <image
                href={referenceOverlay.dataUrl}
                x={PAD}
                y={PAD}
                width={(fullProject.aiDrawingImport?.drawingWidthMeters ?? lengthM) * SCALE}
                height={(fullProject.aiDrawingImport?.drawingHeightMeters ?? widthM) * SCALE}
                opacity={referencePdfOpacity}
                preserveAspectRatio="xMinYMin meet"
                pointerEvents="none"
                data-reference-pdf-overlay="true"
              />
            )}

          {/* Reconstructed Editable 2D CAD Layer (toggleable for instant PDF-vs-CAD alignment comparison) */}
          <g
            opacity={showReconstructedCad ? 1 : 0}
            pointerEvents={showReconstructedCad ? 'auto' : 'none'}
            data-reconstructed-cad-layer="true"
          >

          {/* Faint ghost underlay of the floor directly below so upper floors align cleanly */}
          {!previewOnly && activeFloor > 1 && underlayRooms.length > 0 && (
            <g pointerEvents="none" opacity="0.32">
              {underlayRooms.map((ur) => {
                const ux = PAD + ur.x * SCALE;
                const uy = PAD + ur.y * SCALE;
                const uw = ur.width * SCALE;
                const uh = ur.height * SCALE;
                return (
                  <g key={`underlay-${ur.id}`}>
                    <rect
                      x={ux}
                      y={uy}
                      width={uw}
                      height={uh}
                      fill="rgba(56, 189, 248, 0.04)"
                      stroke="#38BDF8"
                      strokeWidth="1"
                      strokeDasharray="4,4"
                    />
                    <text
                      x={ux + uw / 2}
                      y={uy + uh / 2}
                      textAnchor="middle"
                      fill="#64748B"
                      fontFamily="Red Hat Mono, monospace"
                      fontSize="8"
                    >
                      {formatFloorLabel(activeFloor - 1)}: {ur.name}
                    </text>
                  </g>
                );
              })}
            </g>
          )}

          {/* Blank Site Guidance Prompt when no rooms or walls exist yet on this floor */}
          {!previewOnly && project.rooms.length === 0 && project.customWalls.length === 0 && (
            <g pointerEvents="none">
              <text
                x={PAD + planW / 2}
                y={PAD + planH / 2 - 8}
                textAnchor="middle"
                fill="#7A8CA8"
                fontFamily="Instrument Sans, sans-serif"
                fontSize="13"
                fontWeight="600"
              >
                {activeFloor > 1
                  ? `${formatFloorLabel(activeFloor)} is ready — choose Add Room or click Copy Below`
                  : 'Select mode active — choose Add Room or Draw Wall in Drawing Tools to begin'}
              </text>
              <text
                x={PAD + planW / 2}
                y={PAD + planH / 2 + 12}
                textAnchor="middle"
                fill="#4E6280"
                fontFamily="Red Hat Mono, monospace"
                fontSize="10"
              >
                SITE BOUNDARY: {siteLenLabel} × {siteWidLabel} ({formatArea(lengthM * widthM, units)})
                {activeFloor > 1 ? ` · ELEVATION +${formatLength((activeFloor - 1) * ceilingM, units, 1)}` : ''}
              </text>
            </g>
          )}

          {/* 4-Side Site Measurement Annotations (Top, Bottom, Left, Right) */}
          {!previewOnly && (
            <g fontFamily="Red Hat Mono, monospace" fontSize="10.5">
              {/* TOP Dimension */}
              <line x1={PAD} y1={PAD - 24} x2={PAD + planW} y2={PAD - 24} stroke="#00A8FF" strokeWidth="1" strokeDasharray="3,3" />
              <line x1={PAD} y1={PAD - 30} x2={PAD} y2={PAD - 18} stroke="#00A8FF" strokeWidth="1.2" />
              <line x1={PAD + planW} y1={PAD - 30} x2={PAD + planW} y2={PAD - 18} stroke="#00A8FF" strokeWidth="1.2" />
              <rect x={PAD + planW / 2 - 38} y={PAD - 34} width="76" height="19" rx="3" fill="#0D1528" stroke="#2C3E5E" />
              <text x={PAD + planW / 2} y={PAD - 21} textAnchor="middle" fill="#E0F4FF">
                {siteLenLabel}
              </text>

              {/* BOTTOM Dimension */}
              <line x1={PAD} y1={PAD + planH + 24} x2={PAD + planW} y2={PAD + planH + 24} stroke="#00A8FF" strokeWidth="1" strokeDasharray="3,3" />
              <line x1={PAD} y1={PAD + planH + 18} x2={PAD} y2={PAD + planH + 30} stroke="#00A8FF" strokeWidth="1.2" />
              <line x1={PAD + planW} y1={PAD + planH + 18} x2={PAD + planW} y2={PAD + planH + 30} stroke="#00A8FF" strokeWidth="1.2" />
              <rect x={PAD + planW / 2 - 38} y={PAD + planH + 14} width="76" height="19" rx="3" fill="#0D1528" stroke="#2C3E5E" />
              <text x={PAD + planW / 2} y={PAD + planH + 27} textAnchor="middle" fill="#E0F4FF">
                {siteLenLabel}
              </text>

              {/* LEFT Dimension */}
              <line x1={PAD - 24} y1={PAD} x2={PAD - 24} y2={PAD + planH} stroke="#00A8FF" strokeWidth="1" strokeDasharray="3,3" />
              <line x1={PAD - 30} y1={PAD} x2={PAD - 18} y2={PAD} stroke="#00A8FF" strokeWidth="1.2" />
              <line x1={PAD - 30} y1={PAD + planH} x2={PAD - 18} y2={PAD + planH} stroke="#00A8FF" strokeWidth="1.2" />
              <g transform={`translate(${PAD - 24} ${PAD + planH / 2}) rotate(-90)`}>
                <rect x="-36" y="-10" width="72" height="19" rx="3" fill="#0D1528" stroke="#2C3E5E" />
                <text x="0" y="3" textAnchor="middle" fill="#E0F4FF">
                  {siteWidLabel}
                </text>
              </g>

              {/* RIGHT Dimension */}
              <line x1={PAD + planW + 24} y1={PAD} x2={PAD + planW + 24} y2={PAD + planH} stroke="#00A8FF" strokeWidth="1" strokeDasharray="3,3" />
              <line x1={PAD + planW + 18} y1={PAD} x2={PAD + planW + 30} y2={PAD} stroke="#00A8FF" strokeWidth="1.2" />
              <line x1={PAD + planW + 18} y1={PAD + planH} x2={PAD + planW + 30} y2={PAD + planH} stroke="#00A8FF" strokeWidth="1.2" />
              <g transform={`translate(${PAD + planW + 24} ${PAD + planH / 2}) rotate(90)`}>
                <rect x="-36" y="-10" width="72" height="19" rx="3" fill="#0D1528" stroke="#2C3E5E" />
                <text x="0" y="3" textAnchor="middle" fill="#E0F4FF">
                  {siteWidLabel}
                </text>
              </g>
            </g>
          )}

          {/* Independent Per-Floor Boundary Outline (when custom lengthM/widthM is set) */}
          {floorBounds.isCustom && (
            <g pointerEvents="none">
              <rect
                x={PAD}
                y={PAD}
                width={floorBounds.lengthM * SCALE}
                height={floorBounds.widthM * SCALE}
                fill="none"
                stroke={floorBounds.exceedsSite ? '#FF9D00' : '#38BDF8'}
                strokeWidth="2"
                strokeDasharray="7,4"
              />
              {!previewOnly && (
                <text
                  x={PAD + floorBounds.lengthM * SCALE - 6}
                  y={PAD + 14}
                  textAnchor="end"
                  fill={floorBounds.exceedsSite ? '#FDBA74' : '#7DD3FC'}
                  fontFamily="Red Hat Mono, monospace"
                  fontSize="9.5"
                >
                  FLOOR BOUNDARY: {formatLength(floorBounds.lengthM, units, 1)} × {formatLength(floorBounds.widthM, units, 1)}
                </text>
              )}
            </g>
          )}

          {/* Room Zones */}
          {cadLayers.rooms && project.rooms.map((room) => {
            const isBeingDragged = roomDrag?.roomId === room.id;
            const gdx = groupDrag ? groupDrag.dx : 0;
            const gdy = groupDrag ? groupDrag.dy : 0;
            const dispX = isBeingDragged ? roomDrag.draftX : room.x + gdx;
            const dispY = isBeingDragged ? roomDrag.draftY : room.y + gdy;
            const dispW = isBeingDragged ? roomDrag.draftW : room.width;
            const dispH = isBeingDragged ? roomDrag.draftH : room.height;

            const rx = PAD + dispX * SCALE;
            const ry = PAD + dispY * SCALE;
            const rw = dispW * SCALE;
            const rh = dispH * SCALE;

            const isSingleSelected =
              !previewOnly && !allSelected && selectedEntities.length <= 1 && selectedRoomId === room.id;
            const isSelected = isEntitySelected('room', room.id);
            const isActiveFind = !previewOnly && activeHighlightId === room.id;
            const isFindMatch = !previewOnly && !!highlightedIds?.has(room.id);
            const isInvalidDraft =
              (isBeingDragged && !roomDrag.valid) || (!!groupDrag && !groupDrag.valid);
            const dimText = `${formatLength(dispW, units, 1)} × ${formatLength(dispH, units, 1)}`;
            const areaText = formatArea(dispW * dispH, units);
            const showExtraLines = !previewOnly && rw > 62 && rh > 42;

            const isIsolatedFocus = !!isolatedRoom && room.id === isolatedRoom.id;
            const isDimmedByIsolation = !!isolatedRoom && room.id !== isolatedRoom.id;

            return (
              <g
                key={room.id}
                opacity={isDimmedByIsolation ? 0.16 : 1}
                onPointerDown={(e) => {
                  if (isDimmedByIsolation) return;
                  startRoomInteraction(e, room, 'move');
                }}
                onDoubleClick={(e) => {
                  if (previewOnly || !onEnterRoomView) return;
                  e.stopPropagation();
                  onEnterRoomView(room.id);
                }}
                className={
                  previewOnly
                    ? ''
                    : isDimmedByIsolation
                      ? 'cursor-pointer'
                      : activeTool === 'pan'
                        ? ''
                        : activeTool === 'select' || activeTool === 'move'
                          ? 'cursor-move'
                          : activeTool === 'erase'
                            ? 'cursor-not-allowed'
                            : activeTool === 'rotate'
                              ? 'cursor-pointer'
                              : ''
                }
              >
                {isIsolatedFocus && (
                  <rect
                    x={rx - 3}
                    y={ry - 3}
                    width={rw + 6}
                    height={rh + 6}
                    fill="none"
                    stroke="#00A8FF"
                    strokeWidth="2.8"
                    strokeDasharray="8,4"
                    pointerEvents="none"
                  />
                )}
                {Array.isArray(room.polygon) && room.polygon.length >= 3 ? (
                  <polygon
                    points={room.polygon
                      .map((pt) => {
                        const dxOff = isBeingDragged ? roomDrag.draftX - room.x : gdx;
                        const dyOff = isBeingDragged ? roomDrag.draftY - room.y : gdy;
                        return `${PAD + (pt.x + dxOff) * SCALE},${PAD + (pt.y + dyOff) * SCALE}`;
                      })
                      .join(' ')}
                    fill={
                      isInvalidDraft
                        ? 'rgba(255, 157, 0, 0.18)'
                        : isActiveFind
                          ? 'rgba(255, 157, 0, 0.22)'
                          : isSelected
                            ? 'rgba(0, 168, 255, 0.16)'
                            : isFindMatch
                              ? 'rgba(251, 191, 36, 0.12)'
                              : ROOM_FILLS[room.floorFinish] ?? 'rgba(0,168,255,0.06)'
                    }
                    stroke={
                      isInvalidDraft || isActiveFind
                        ? '#FF9D00'
                        : isSelected
                          ? '#00A8FF'
                          : isFindMatch
                            ? '#FBBF24'
                            : '#334C73'
                    }
                    strokeWidth={isActiveFind ? 3 : isSelected || isInvalidDraft || isFindMatch ? 2.5 : 1.5}
                    strokeDasharray={isInvalidDraft || isFindMatch ? '6,4' : undefined}
                  />
                ) : (
                  <rect
                    x={rx}
                    y={ry}
                    width={rw}
                    height={rh}
                    fill={
                      isInvalidDraft
                        ? 'rgba(255, 157, 0, 0.18)'
                        : isActiveFind
                          ? 'rgba(255, 157, 0, 0.22)'
                          : isSelected
                            ? 'rgba(0, 168, 255, 0.16)'
                            : isFindMatch
                              ? 'rgba(251, 191, 36, 0.12)'
                              : ROOM_FILLS[room.floorFinish] ?? 'rgba(0,168,255,0.06)'
                    }
                    stroke={
                      isInvalidDraft || isActiveFind
                        ? '#FF9D00'
                        : isSelected
                          ? '#00A8FF'
                          : isFindMatch
                            ? '#FBBF24'
                            : '#334C73'
                    }
                    strokeWidth={isActiveFind ? 3 : isSelected || isInvalidDraft || isFindMatch ? 2.5 : 1.5}
                    strokeDasharray={isInvalidDraft || isFindMatch ? '6,4' : undefined}
                  />
                )}

                {/* Room Name + Dimensions + Area */}
                <text
                  x={rx + rw / 2}
                  y={ry + rh / 2 - (showExtraLines ? 8 : 0)}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={isInvalidDraft ? '#FFE2B3' : '#F5F7FA'}
                  fontFamily="Instrument Sans, sans-serif"
                  fontSize={previewOnly ? 8.5 : Math.min(12, Math.max(8.5, rw / 11))}
                  fontWeight="600"
                  pointerEvents="none"
                >
                  {room.name}
                </text>

                {showExtraLines && (
                  <>
                    <text
                      x={rx + rw / 2}
                      y={ry + rh / 2 + 8}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill="#7DD3FC"
                      fontFamily="Red Hat Mono, monospace"
                      fontSize="9.5"
                      pointerEvents="none"
                    >
                      {dimText}
                    </text>
                    {rh > 62 && (
                      <text
                        x={rx + rw / 2}
                        y={ry + rh / 2 + 21}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="#94A3B8"
                        fontFamily="Red Hat Mono, monospace"
                        fontSize="8.5"
                        pointerEvents="none"
                      >
                        {areaText}
                      </text>
                    )}
                  </>
                )}

                {/* Selection Resize Handles (4 corners + East/South midpoints) */}
                {isSingleSelected && (activeTool === 'select' || activeTool === 'move') && (
                  <g>
                    {(
                      [
                        { h: 'nw' as ResizeHandle, cx: rx, cy: ry, cur: 'cursor-nwse-resize' },
                        { h: 'ne' as ResizeHandle, cx: rx + rw, cy: ry, cur: 'cursor-nesw-resize' },
                        { h: 'sw' as ResizeHandle, cx: rx, cy: ry + rh, cur: 'cursor-nesw-resize' },
                        { h: 'se' as ResizeHandle, cx: rx + rw, cy: ry + rh, cur: 'cursor-nwse-resize' },
                        { h: 'e' as ResizeHandle, cx: rx + rw, cy: ry + rh / 2, cur: 'cursor-ew-resize' },
                        { h: 's' as ResizeHandle, cx: rx + rw / 2, cy: ry + rh, cur: 'cursor-ns-resize' },
                      ]
                    ).map((pt) => (
                      <rect
                        key={pt.h}
                        x={pt.cx - 4.5}
                        y={pt.cy - 4.5}
                        width={9}
                        height={9}
                        rx="1.5"
                        fill="#00A8FF"
                        stroke="#080F20"
                        strokeWidth="1.5"
                        className={pt.cur}
                        onPointerDown={(e) => startRoomInteraction(e, room, 'resize', pt.h)}
                      />
                    ))}
                  </g>
                )}
              </g>
            );
          })}

          {/* Interactive Furniture Items (selectable, draggable, rotatable, searchable) */}
          {project.furniture.map((f) => {
            const gdx = groupDrag ? groupDrag.dx : 0;
            const gdy = groupDrag ? groupDrag.dy : 0;
            const cx = PAD + (f.x + gdx) * SCALE;
            const cy = PAD + (f.y + gdy) * SCALE;
            const fw = f.width * SCALE;
            const fd = f.depth * SCALE;
            const isSelFurn = isEntitySelected('furniture', f.id);
            const isActiveFindFurn = !previewOnly && activeHighlightId === f.id;
            const isFindMatchFurn = !previewOnly && !!highlightedIds?.has(f.id);
            const furnMeta = FURNITURE_MAP[f.kind];

            return (
              <g
                key={f.id}
                transform={`translate(${cx} ${cy}) rotate(${f.rotation || 0})`}
                className={
                  previewOnly || activeTool === 'pan'
                    ? ''
                    : activeTool === 'erase'
                      ? 'cursor-not-allowed'
                      : 'cursor-pointer'
                }
                onPointerDown={(e) => {
                  if (
                    previewOnly ||
                    e.button === 1 ||
                    activeTool === 'pan' ||
                    activeTool === 'draw-wall' ||
                    activeTool === 'dimension' ||
                    pendingPlaceItem ||
                    allSelected
                  ) {
                    return;
                  }
                  e.stopPropagation();
                  if (activeTool === 'erase') {
                    onEraseEntity?.({ kind: 'furniture', id: f.id });
                    return;
                  }
                  if (activeTool === 'rotate') {
                    onClearAllSelection?.();
                    onSelectEntity?.({ kind: 'furniture', id: f.id }, false);
                    onRotateEntity?.({ kind: 'furniture', id: f.id });
                    return;
                  }
                  if ((e.ctrlKey || e.metaKey) && e.button === 0 && onDuplicateFurniture) {
                    e.preventDefault();
                    onClearAllSelection?.();
                    const dup = onDuplicateFurniture(f.id);
                    if (dup) {
                      const raw = clientToRawMeters(e.clientX, e.clientY);
                      setDraggingFurniture({
                        id: dup.id,
                        startX: raw.x,
                        startY: raw.y,
                        moved: false,
                        snapshotRecorded: true,
                      });
                    }
                    return;
                  }
                  onClearAllSelection?.();
                  onSelectEntity?.({ kind: 'furniture', id: f.id }, e.shiftKey);
                  if (!e.shiftKey && (activeTool === 'select' || activeTool === 'move')) {
                    const raw = clientToRawMeters(e.clientX, e.clientY);
                    setDraggingFurniture({
                      id: f.id,
                      startX: raw.x,
                      startY: raw.y,
                      moved: false,
                      snapshotRecorded: false,
                    });
                  }
                }}
              >
                <rect
                  x={-fw / 2}
                  y={-fd / 2}
                  width={fw}
                  height={fd}
                  rx="3"
                  fill={
                    isActiveFindFurn
                      ? 'rgba(255, 157, 0, 0.24)'
                      : isSelFurn
                        ? 'rgba(0, 168, 255, 0.18)'
                        : isFindMatchFurn
                          ? 'rgba(251, 191, 36, 0.14)'
                          : 'rgba(197, 205, 216, 0.06)'
                  }
                  stroke={
                    isActiveFindFurn
                      ? '#FF9D00'
                      : isSelFurn
                        ? '#00A8FF'
                        : isFindMatchFurn
                          ? '#FBBF24'
                          : '#334C73'
                  }
                  strokeWidth={isActiveFindFurn ? 2.5 : isSelFurn || isFindMatchFurn ? 2 : 1}
                  strokeDasharray={isSelFurn || isActiveFindFurn ? undefined : '3,2'}
                />
                {!previewOnly && fw > 28 && fd > 18 && (
                  <text
                    x={0}
                    y={0}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill={isActiveFindFurn ? '#FFE2B3' : isSelFurn ? '#E0F4FF' : '#94A3B8'}
                    fontFamily="Red Hat Mono, monospace"
                    fontSize="7.5"
                    pointerEvents="none"
                  >
                    {f.kind.replace('-', ' ').toUpperCase()}
                  </text>
                )}
                <title>{furnMeta?.label ?? f.kind}</title>
              </g>
            );
          })}

          {/* Canonical Merged Architectural Walls (Perimeter + Deduplicated Shared Room Walls + Custom Walls + Hidden Cutaway Indicators) */}
          {cadLayers.walls && allMergedWalls.map((seg) => {
            const isInteriorSeg = seg.source !== 'perimeter';
            const gdx = isInteriorSeg && groupDrag ? groupDrag.dx : 0;
            const gdy = isInteriorSeg && groupDrag ? groupDrag.dy : 0;
            const x1 = PAD + (seg.x1 + gdx) * SCALE;
            const y1 = PAD + (seg.y1 + gdy) * SCALE;
            const x2 = PAD + (seg.x2 + gdx) * SCALE;
            const y2 = PAD + (seg.y2 + gdy) * SCALE;
            const isCustom = seg.source === 'custom' && !!seg.customWallId;
            const wallTargetId = seg.customWallId ?? seg.id;
            const isHiddenWall = !!seg.isHidden;
            const isSelectedWall =
              isEntitySelected('wall', wallTargetId) ||
              (isCustom && isEntitySelected('wall', seg.customWallId!)) ||
              (allSelected && !previewOnly && seg.source === 'room');
            const isActiveFindWall =
              !previewOnly && (activeHighlightId === wallTargetId || (isCustom && activeHighlightId === seg.customWallId));
            const isFindMatchWall =
              !previewOnly && (!!highlightedIds?.has(wallTargetId) || (isCustom && !!highlightedIds?.has(seg.customWallId!)));
            const strokeW = Math.max(
              previewOnly ? 2 : 3,
              Math.min(previewOnly ? 5.5 : 8.5, seg.thickness * SCALE)
            );
            const wallDimmed =
              !!isolatedRoom &&
              (Math.max(seg.x1, seg.x2) < isolatedRoom.x - 0.25 ||
                Math.min(seg.x1, seg.x2) > isolatedRoom.x + isolatedRoom.width + 0.25 ||
                Math.max(seg.y1, seg.y2) < isolatedRoom.y - 0.25 ||
                Math.min(seg.y1, seg.y2) > isolatedRoom.y + isolatedRoom.height + 0.25);

            return (
              <g key={seg.id} opacity={wallDimmed ? 0.16 : 1}>
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={
                    isHiddenWall
                      ? '#FF9D00'
                      : isActiveFindWall
                        ? '#FF9D00'
                        : isSelectedWall
                          ? '#00A8FF'
                          : isFindMatchWall
                            ? '#FBBF24'
                            : seg.isExterior
                              ? '#F5F7FA'
                              : '#CBD5E1'
                  }
                  strokeWidth={isHiddenWall ? Math.max(2, strokeW * 0.6) : strokeW}
                  strokeOpacity={isHiddenWall ? 0.45 : 1}
                  strokeDasharray={isHiddenWall ? '6,5' : undefined}
                  strokeLinecap="square"
                  pointerEvents="none"
                />
                {/* Interactive hit area for ALL walls (perimeter, room, custom, and hidden cutaway restore) */}
                {!previewOnly && !wallDimmed && (
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke="transparent"
                    strokeWidth={Math.max(14, strokeW + 8)}
                    className={
                      activeTool === 'pan'
                        ? ''
                        : activeTool === 'erase'
                          ? 'cursor-not-allowed'
                          : activeTool === 'hide-wall'
                            ? 'cursor-crosshair'
                            : 'cursor-pointer'
                    }
                    onPointerDown={(e) => {
                      if (
                        e.button === 1 ||
                        activeTool === 'draw-wall' ||
                        activeTool === 'add-door' ||
                        activeTool === 'add-window' ||
                        activeTool === 'dimension' ||
                        activeTool === 'pan' ||
                        allSelected
                      ) {
                        return;
                      }
                      e.stopPropagation();
                      if (activeTool === 'hide-wall' && onToggleHideWall) {
                        onToggleHideWall(activeFloor, seg.id);
                        return;
                      }
                      if (activeTool === 'erase') {
                        onEraseEntity?.({ kind: 'wall', id: wallTargetId });
                        return;
                      }
                      if (isHiddenWall && onToggleHideWall) {
                        onToggleHideWall(activeFloor, seg.id);
                        return;
                      }
                      if (isCustom && (e.ctrlKey || e.metaKey) && e.button === 0 && onDuplicateWall) {
                        e.preventDefault();
                        onClearAllSelection?.();
                        onDuplicateWall(seg.customWallId!);
                        return;
                      }
                      onClearAllSelection?.();
                      onSelectEntity?.({ kind: 'wall', id: wallTargetId }, e.shiftKey);
                    }}
                  >
                    <title>
                      {isHiddenWall
                        ? 'Hidden cutaway wall — click to restore'
                        : activeTool === 'hide-wall'
                          ? 'Click to hide wall for cross-section cutaway'
                          : `${seg.isExterior ? 'Exterior' : 'Internal'} wall — click to select or edit`}
                    </title>
                  </line>
                )}
                {(isSelectedWall || isActiveFindWall) && !isHiddenWall && !previewOnly && (
                  <>
                    <circle
                      cx={x1}
                      cy={y1}
                      r="5.5"
                      fill={isActiveFindWall ? '#FF9D00' : '#00A8FF'}
                      stroke="#080F20"
                      strokeWidth="1.5"
                      className="cursor-move"
                      onPointerDown={(e) => {
                        if (e.button !== 0 || !onUpdateWallEndpoints) return;
                        e.stopPropagation();
                        let editWallId = seg.customWallId ?? null;
                        if (!editWallId && onMaterializeAndSelectWall) {
                          editWallId = onMaterializeAndSelectWall(seg);
                        }
                        if (editWallId) {
                          setDraggingWallEndpoint({
                            wallId: editWallId,
                            endpoint: 'start',
                            snapshotRecorded: false,
                          });
                        }
                      }}
                    >
                      <title>Drag wall start endpoint</title>
                    </circle>
                    <circle
                      cx={x2}
                      cy={y2}
                      r="5.5"
                      fill={isActiveFindWall ? '#FF9D00' : '#00A8FF'}
                      stroke="#080F20"
                      strokeWidth="1.5"
                      className="cursor-move"
                      onPointerDown={(e) => {
                        if (e.button !== 0 || !onUpdateWallEndpoints) return;
                        e.stopPropagation();
                        let editWallId = seg.customWallId ?? null;
                        if (!editWallId && onMaterializeAndSelectWall) {
                          editWallId = onMaterializeAndSelectWall(seg);
                        }
                        if (editWallId) {
                          setDraggingWallEndpoint({
                            wallId: editWallId,
                            endpoint: 'end',
                            snapshotRecorded: false,
                          });
                        }
                      }}
                    >
                      <title>Drag wall end endpoint</title>
                    </circle>
                  </>
                )}
              </g>
            );
          })}

          {/* Active Wall / Dimension Drawing Preview with Live Length Readout */}
          {lineStart && linePreview && (
            <g pointerEvents="none">
              <line
                x1={PAD + lineStart.x * SCALE}
                y1={PAD + lineStart.y * SCALE}
                x2={PAD + linePreview.x * SCALE}
                y2={PAD + linePreview.y * SCALE}
                stroke={activeTool === 'dimension' ? '#FF9D00' : '#00A8FF'}
                strokeWidth={activeTool === 'dimension' ? 1.8 : 4.5}
                strokeDasharray="6,4"
              />
              <circle cx={PAD + lineStart.x * SCALE} cy={PAD + lineStart.y * SCALE} r="4" fill="#00A8FF" />
              <circle cx={PAD + linePreview.x * SCALE} cy={PAD + linePreview.y * SCALE} r="4" fill="#00A8FF" />
              {Math.hypot(linePreview.x - lineStart.x, linePreview.y - lineStart.y) > 0.15 && (
                <g
                  transform={`translate(${PAD + ((lineStart.x + linePreview.x) / 2) * SCALE} ${PAD + ((lineStart.y + linePreview.y) / 2) * SCALE - 16})`}
                >
                  <rect x="-34" y="-10" width="68" height="19" rx="3" fill="#080F20" stroke="#00A8FF" />
                  <text
                    x="0"
                    y="3"
                    textAnchor="middle"
                    fill="#E0F4FF"
                    fontFamily="Red Hat Mono, monospace"
                    fontSize="10"
                  >
                    {formatLength(
                      Math.hypot(linePreview.x - lineStart.x, linePreview.y - lineStart.y),
                      units,
                      1
                    )}
                  </text>
                </g>
              )}
            </g>
          )}

          {/* Doors & Windows */}
          {cadLayers.openings && project.openings.map((op) => {
            const ox = PAD + (op.x + (groupDrag ? groupDrag.dx : 0)) * SCALE;
            const oy = PAD + (op.y + (groupDrag ? groupDrag.dy : 0)) * SCALE;
            const ow = op.width * SCALE;
            const isSelectedOp = isEntitySelected('opening', op.id);
            const isActiveFindOp = !previewOnly && activeHighlightId === op.id;
            const isFindMatchOp = !previewOnly && !!highlightedIds?.has(op.id);

            return (
              <g
                key={op.id}
                transform={`translate(${ox} ${oy}) rotate(${op.rotation})`}
                className={
                  previewOnly || activeTool === 'pan'
                    ? ''
                    : activeTool === 'erase'
                      ? 'cursor-not-allowed'
                      : 'cursor-pointer'
                }
                onPointerDown={(e) => {
                  if (
                    previewOnly ||
                    e.button === 1 ||
                    activeTool === 'pan' ||
                    activeTool === 'draw-wall' ||
                    activeTool === 'dimension' ||
                    allSelected
                  ) {
                    return;
                  }
                  e.stopPropagation();
                  if (activeTool === 'erase') {
                    onEraseEntity?.({ kind: 'opening', id: op.id });
                  } else if (activeTool === 'rotate') {
                    onClearAllSelection?.();
                    onSelectEntity?.({ kind: 'opening', id: op.id }, false);
                    onRotateEntity?.({ kind: 'opening', id: op.id });
                  } else if ((e.ctrlKey || e.metaKey) && e.button === 0 && onDuplicateOpening) {
                    e.preventDefault();
                    onClearAllSelection?.();
                    const dup = onDuplicateOpening(op.id);
                    if (dup) {
                      const raw = clientToRawMeters(e.clientX, e.clientY);
                      setDraggingOpening({
                        id: dup.id,
                        startX: raw.x,
                        startY: raw.y,
                        moved: false,
                        snapshotRecorded: true,
                      });
                    }
                  } else {
                    onClearAllSelection?.();
                    onSelectEntity?.({ kind: 'opening', id: op.id }, e.shiftKey);
                    if (!e.shiftKey && (activeTool === 'select' || activeTool === 'move')) {
                      const raw = clientToRawMeters(e.clientX, e.clientY);
                      setDraggingOpening({
                        id: op.id,
                        startX: raw.x,
                        startY: raw.y,
                        moved: false,
                        snapshotRecorded: false,
                      });
                    }
                  }
                }}
              >
                {/* Invisible generous hit box */}
                <rect x={-ow / 2 - 4} y={-10} width={ow + 8} height={20} fill="transparent" />
                {op.kind === 'window' ? (
                  <>
                    <line x1={-ow / 2} y1={0} x2={ow / 2} y2={0} stroke="#080F20" strokeWidth="7" />
                    <line x1={-ow / 2} y1={-2.5} x2={ow / 2} y2={-2.5} stroke={isSelectedOp || isActiveFindOp ? '#FF9D00' : '#00A8FF'} strokeWidth="2" />
                    <line x1={-ow / 2} y1={2.5} x2={ow / 2} y2={2.5} stroke={isSelectedOp || isActiveFindOp ? '#FF9D00' : '#00A8FF'} strokeWidth="2" />
                  </>
                ) : (
                  <>
                    <line x1={-ow / 2} y1={0} x2={ow / 2} y2={0} stroke="#080F20" strokeWidth="7" />
                    <line x1={-ow / 2} y1={0} x2={-ow / 2} y2={ow * 0.85} stroke={isSelectedOp ? '#00A8FF' : '#FF9D00'} strokeWidth="2" />
                    <path
                      d={`M ${-ow / 2} ${ow * 0.85} A ${ow * 0.85} ${ow * 0.85} 0 0 0 ${ow / 2} 0`}
                      fill="none"
                      stroke={isSelectedOp ? '#00A8FF' : '#FF9D00'}
                      strokeOpacity="0.65"
                      strokeWidth="1.2"
                      strokeDasharray="3,2"
                    />
                  </>
                )}
                {(isSelectedOp || isActiveFindOp || isFindMatchOp) && (
                  <rect
                    x={-ow / 2 - 4}
                    y={-8}
                    width={ow + 8}
                    height={16}
                    fill="none"
                    stroke={isActiveFindOp ? '#FF9D00' : isSelectedOp ? '#00A8FF' : '#FBBF24'}
                    strokeWidth={isActiveFindOp ? '2' : '1.3'}
                    strokeDasharray="3,2"
                  />
                )}
              </g>
            );
          })}

          {/* Hover Preview for Placing Door / Window onto a Wall */}
          {hoverOpening && !previewOnly && (
            <g
              transform={`translate(${PAD + hoverOpening.x * SCALE} ${PAD + hoverOpening.y * SCALE}) rotate(${hoverOpening.rotation})`}
              pointerEvents="none"
              opacity="0.85"
            >
              <line
                x1={-(hoverOpening.kind === 'door' ? 0.9 : 1.4) * SCALE * 0.5}
                y1={0}
                x2={(hoverOpening.kind === 'door' ? 0.9 : 1.4) * SCALE * 0.5}
                y2={0}
                stroke={hoverOpening.kind === 'door' ? '#FF9D00' : '#00A8FF'}
                strokeWidth="5"
              />
            </g>
          )}

          {/* Custom User-Placed Dimension Annotations */}
          {!previewOnly && cadLayers.dimensions &&
            customDims.map((dim) => {
              const x1 = PAD + dim.x1 * SCALE;
              const y1 = PAD + dim.y1 * SCALE;
              const x2 = PAD + dim.x2 * SCALE;
              const y2 = PAD + dim.y2 * SCALE;
              const lenM = Math.hypot(dim.x2 - dim.x1, dim.y2 - dim.y1);
              return (
                <g
                  key={dim.id}
                  className={activeTool === 'erase' ? 'cursor-not-allowed' : ''}
                  onPointerDown={(e) => {
                    if (activeTool !== 'erase') return;
                    e.stopPropagation();
                    onEraseEntity?.({ kind: 'dimension', id: dim.id });
                  }}
                >
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#FF9D00" strokeWidth="1.4" strokeDasharray="4,3" />
                  <circle cx={x1} cy={y1} r="3" fill="#FF9D00" />
                  <circle cx={x2} cy={y2} r="3" fill="#FF9D00" />
                  <rect
                    x={(x1 + x2) / 2 - 28}
                    y={(y1 + y2) / 2 - 18}
                    width="56"
                    height="16"
                    rx="2"
                    fill="#080F20"
                    stroke="#FF9D00"
                    strokeWidth="0.9"
                  />
                  <text
                    x={(x1 + x2) / 2}
                    y={(y1 + y2) / 2 - 7}
                    textAnchor="middle"
                    fill="#FFE2B3"
                    fontFamily="Red Hat Mono, monospace"
                    fontSize="9"
                  >
                    {formatLength(lenM, units, 1)}
                  </text>
                </g>
              );
            })}

          {/* Parametric Staircases on Active Floor */}
          {floorStaircases.map((st) => {
            const { footprintW, footprintD } = computeStaircaseFootprint(st);
            const sx = PAD + st.x * SCALE;
            const sy = PAD + st.y * SCALE;
            const sw = footprintW * SCALE;
            const sd = footprintD * SCALE;
            const isSelStair = isEntitySelected('staircase', st.id);
            const isDestination = st.toFloor === activeFloor && st.fromFloor !== activeFloor;
            const stepLines = Math.max(4, Math.min(18, st.steps));

            return (
              <g
                key={st.id}
                transform={`translate(${sx} ${sy}) rotate(${st.rotation || 0})`}
                className={
                  previewOnly || activeTool === 'pan'
                    ? ''
                    : activeTool === 'erase'
                      ? 'cursor-not-allowed'
                      : 'cursor-pointer'
                }
                onPointerDown={(e) => {
                  if (
                    previewOnly ||
                    e.button === 1 ||
                    activeTool === 'pan' ||
                    activeTool === 'draw-wall' ||
                    activeTool === 'dimension' ||
                    activeTool === 'add-wire' ||
                    allSelected
                  ) {
                    return;
                  }
                  e.stopPropagation();
                  if (activeTool === 'erase') {
                    onEraseEntity?.({ kind: 'staircase', id: st.id });
                    return;
                  }
                  if (activeTool === 'rotate') {
                    onClearAllSelection?.();
                    onSelectEntity?.({ kind: 'staircase', id: st.id }, false);
                    onRotateEntity?.({ kind: 'staircase', id: st.id });
                    return;
                  }
                  onClearAllSelection?.();
                  onSelectEntity?.({ kind: 'staircase', id: st.id }, e.shiftKey);
                  if (!e.shiftKey && (activeTool === 'select' || activeTool === 'move')) {
                    const raw = clientToRawMeters(e.clientX, e.clientY);
                    setDraggingStaircase({
                      id: st.id,
                      startX: raw.x,
                      startY: raw.y,
                      origX: st.x,
                      origY: st.y,
                      moved: false,
                      snapshotRecorded: false,
                    });
                  }
                }}
              >
                {st.type === 'spiral' ? (
                  <>
                    <circle
                      cx={sw / 2}
                      cy={sd / 2}
                      r={Math.min(sw, sd) / 2}
                      fill={isSelStair ? 'rgba(0, 168, 255, 0.22)' : 'rgba(56, 189, 248, 0.12)'}
                      stroke={isSelStair ? '#00A8FF' : '#94A3B8'}
                      strokeWidth={isSelStair ? 2.2 : 1.4}
                      strokeDasharray={isDestination ? '4,3' : undefined}
                    />
                    {Array.from({ length: 10 }).map((_, i) => {
                      const a = (i * Math.PI * 2) / 10;
                      const r = Math.min(sw, sd) / 2;
                      return (
                        <line
                          key={i}
                          x1={sw / 2}
                          y1={sd / 2}
                          x2={sw / 2 + Math.cos(a) * r}
                          y2={sd / 2 + Math.sin(a) * r}
                          stroke="#64748B"
                          strokeWidth="0.9"
                        />
                      );
                    })}
                    <circle cx={sw / 2} cy={sd / 2} r={4} fill="#CBD5E1" />
                  </>
                ) : (
                  <>
                    <rect
                      x={0}
                      y={0}
                      width={sw}
                      height={sd}
                      rx="2"
                      fill={isSelStair ? 'rgba(0, 168, 255, 0.22)' : 'rgba(56, 189, 248, 0.12)'}
                      stroke={isSelStair ? '#00A8FF' : '#94A3B8'}
                      strokeWidth={isSelStair ? 2.2 : 1.4}
                      strokeDasharray={isDestination ? '4,3' : undefined}
                    />
                    {Array.from({ length: stepLines - 1 }).map((_, idx) => {
                      const xStep = ((idx + 1) / stepLines) * sw;
                      return (
                        <line
                          key={idx}
                          x1={xStep}
                          y1={0}
                          x2={xStep}
                          y2={sd}
                          stroke="#64748B"
                          strokeWidth="0.9"
                        />
                      );
                    })}
                    <line
                      x1={6}
                      y1={sd / 2}
                      x2={Math.max(12, sw - 6)}
                      y2={sd / 2}
                      stroke={isSelStair ? '#00A8FF' : '#FF9D00'}
                      strokeWidth="1.4"
                    />
                  </>
                )}
                {!previewOnly && (
                  <text
                    x={sw / 2}
                    y={-6}
                    textAnchor="middle"
                    fill={isSelStair ? '#E0F4FF' : '#CBD5E1'}
                    fontFamily="Red Hat Mono, monospace"
                    fontSize="8.5"
                    pointerEvents="none"
                  >
                    {st.name} ({isDestination ? 'DN' : 'UP'} {getFloorLabel(fullProject, st.fromFloor).split(' ')[0]}→{getFloorLabel(fullProject, st.toFloor).split(' ')[0]})
                  </text>
                )}
              </g>
            );
          })}

          {/* Electrical Auto Circuit Bus Overlay (toggleable via Wiring Config) */}
          {wiringConfig.showAutoCircuitBus &&
            circuitPaths.map((c) => (
              <path
                key={c.circuit}
                d={c.d}
                fill="none"
                stroke={c.color}
                strokeWidth={previewOnly ? 1.1 : 1.3}
                strokeOpacity="0.35"
                strokeDasharray="5,4"
                pointerEvents="none"
              />
            ))}

          {/* Interactive Routed Electrical Wires & Waypoint Editing Layer */}
          {visibleWires.map((wire) => {
            const fromPt = pointLookup.get(wire.fromPointId);
            const toPt = pointLookup.get(wire.toPointId);
            if (!fromPt || !toPt) return null;

            const isSelWire = isEntitySelected('wire', wire.id);
            const isActiveFindWire = !previewOnly && activeHighlightId === wire.id;
            const isFindMatchWire = !previewOnly && !!highlightedIds?.has(wire.id);
            const nodes = [
              { x: fromPt.x, y: fromPt.y },
              ...(wire.waypoints ?? []),
              { x: toPt.x, y: toPt.y },
            ];
            const corridorKey =
              wire.fromPointId < wire.toPointId
                ? `${wire.fromPointId}::${wire.toPointId}`
                : `${wire.toPointId}::${wire.fromPointId}`;
            const hasParallelConductors = (corridorConductorCount.get(corridorKey) ?? 1) > 1;
            const rawSvgPts = nodes.map((n) => ({
              x: PAD + n.x * SCALE,
              y: PAD + n.y * SCALE,
            }));
            const dirSign = wire.fromPointId < wire.toPointId ? 1 : -1;
            const visualOffsetPx =
              hasParallelConductors && !previewOnly
                ? (CONDUCTOR_VISUAL_LANE_OFFSET_PX[wire.category] ?? 0) * dirSign
                : 0;
            const displayPts =
              visualOffsetPx !== 0
                ? offsetPolylinePerpendicular(rawSvgPts, visualOffsetPx)
                : rawSvgPts;
            const pathD =
              wire.routingMode === 'curved' && displayPts.length >= 3
                ? buildSmoothSvgPath(displayPts)
                : displayPts
                    .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
                    .join(' ');
            const wireBreakdown = computeWireLengthBreakdown(wire, fullProject, allowancePct);
            const conductorTag =
              wire.category === 'phase'
                ? 'L'
                : wire.category === 'neutral'
                  ? 'N'
                  : wire.category === 'earth'
                    ? 'E'
                    : wire.code;
            const midNodeIdx = Math.min(
              Math.max(0, Math.floor((displayPts.length - 1) / 2)),
              Math.max(0, displayPts.length - 2)
            );
            const labelX =
              displayPts.length >= 2
                ? (displayPts[midNodeIdx].x + displayPts[midNodeIdx + 1].x) / 2
                : rawSvgPts[0].x;
            const labelY =
              displayPts.length >= 2
                ? (displayPts[midNodeIdx].y + displayPts[midNodeIdx + 1].y) / 2
                : rawSvgPts[0].y;

            return (
              <g key={wire.id}>
                {/* Selection glow underlay */}
                {(isSelWire || isActiveFindWire || isFindMatchWire) && (
                  <path
                    d={pathD}
                    fill="none"
                    stroke={isActiveFindWire ? '#FF9D00' : isSelWire ? '#00A8FF' : '#FBBF24'}
                    strokeWidth={wire.lineThickness + 5}
                    strokeOpacity="0.32"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    pointerEvents="none"
                  />
                )}
                {/* Actual styled wire conductor */}
                <path
                  d={pathD}
                  fill="none"
                  stroke={wire.color}
                  strokeWidth={previewOnly ? 1.4 : Math.max(1.6, wire.lineThickness)}
                  strokeDasharray={wire.lineStyle === 'dashed' ? '6,4' : undefined}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  pointerEvents="none"
                />
                {/* Generous hit target for selecting, deleting, or shifting route */}
                {!previewOnly && (
                  <path
                    d={pathD}
                    fill="none"
                    stroke="transparent"
                    strokeWidth="14"
                    className={
                      activeTool === 'erase'
                        ? 'cursor-not-allowed'
                        : activeTool === 'pan'
                          ? ''
                          : 'cursor-pointer'
                    }
                    onPointerDown={(e) => {
                      if (
                        e.button === 1 ||
                        activeTool === 'pan' ||
                        activeTool === 'draw-wall' ||
                        activeTool === 'dimension' ||
                        activeTool === 'add-wire' ||
                        allSelected
                      ) {
                        return;
                      }
                      e.stopPropagation();
                      if (activeTool === 'erase') {
                        // Delete ONLY the wire, preserving connected components
                        onEraseEntity?.({ kind: 'wire', id: wire.id });
                        return;
                      }
                      onClearAllSelection?.();
                      onSelectEntity?.({ kind: 'wire', id: wire.id }, e.shiftKey);
                      // Allow dragging ANY wire path freely: shift existing waypoints,
                      // or if it's currently a direct 2-point wire, insert & drag a live bend right under the cursor!
                      if (
                        !e.shiftKey &&
                        (activeTool === 'select' || activeTool === 'move') &&
                        onUpdateWireWaypoints
                      ) {
                        const raw = clientToRawMeters(e.clientX, e.clientY);
                        if (wire.waypoints.length > 0) {
                          setDraggingWireRoute({
                            wireId: wire.id,
                            startX: raw.x,
                            startY: raw.y,
                            origWaypoints: wire.waypoints.map((wp) => ({ ...wp })),
                            moved: false,
                            snapshotRecorded: false,
                          });
                        } else {
                          onRecordHistorySnapshot?.();
                          const newWp: WireWaypoint = {
                            x: Number(raw.x.toFixed(2)),
                            y: Number(raw.y.toFixed(2)),
                          };
                          onUpdateWireWaypoints(wire.id, [newWp], false);
                          setDraggingWaypoint({
                            wireId: wire.id,
                            index: 0,
                            snapshotRecorded: true,
                          });
                        }
                      }
                    }}
                  />
                )}

                {/* Endpoint connection rings */}
                {!previewOnly && wiringConfig.showEndpointMarkers && (
                  <>
                    <circle
                      cx={PAD + fromPt.x * SCALE}
                      cy={PAD + fromPt.y * SCALE}
                      r={isSelWire ? 10 : 8}
                      fill="none"
                      stroke={wire.color}
                      strokeWidth="1.2"
                      strokeOpacity="0.8"
                      pointerEvents="none"
                    />
                    <circle
                      cx={PAD + toPt.x * SCALE}
                      cy={PAD + toPt.y * SCALE}
                      r={isSelWire ? 10 : 8}
                      fill="none"
                      stroke={wire.color}
                      strokeWidth="1.2"
                      strokeOpacity="0.8"
                      pointerEvents="none"
                    />
                  </>
                )}

                {/* Wire Label & Live Length Readout (m & ft) */}
                {!previewOnly && (wiringConfig.showWireLabels || isSelWire) && (
                  <g transform={`translate(${labelX} ${labelY - 12})`} pointerEvents="none">
                    <rect
                      x={isSelWire ? -68 : -34}
                      y="-9"
                      width={isSelWire ? 136 : 68}
                      height="16"
                      rx="2"
                      fill="#080F20"
                      stroke={isSelWire ? '#00A8FF' : wire.color}
                      strokeWidth="0.9"
                    />
                    <text
                      x="0"
                      y="2.5"
                      textAnchor="middle"
                      fill="#E0F4FF"
                      fontFamily="Red Hat Mono, monospace"
                      fontSize="8.2"
                    >
                      {isSelWire
                        ? `${conductorTag} · ${wireBreakdown.baseRouteM.toFixed(1)}m / ${wireBreakdown.baseRouteFt.toFixed(1)}ft`
                        : `${wire.code} (${conductorTag})${wire.isInterFloor ? ' ↕' : ''}`}
                    </text>
                  </g>
                )}

                {/* Waypoint Vertex Grips & Midpoint Insert Grips when Cable Polyline is Selected */}
                {!previewOnly && isSelWire && onUpdateWireWaypoints && (
                  <g>
                    {/* Segment Midpoint '+' handles to insert new polyline vertex */}
                    {nodes.slice(0, -1).map((a, segIdx) => {
                      const b = nodes[segIdx + 1];
                      const segDist = Math.hypot(b.x - a.x, b.y - a.y);
                      if (segDist < 0.2) return null;
                      const mx = PAD + ((a.x + b.x) / 2) * SCALE;
                      const my = PAD + ((a.y + b.y) / 2) * SCALE;
                      return (
                        <g
                          key={`mid-${segIdx}`}
                          transform={`translate(${mx} ${my})`}
                          className="cursor-copy"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            onRecordHistorySnapshot?.();
                            const prevZ = segIdx > 0 ? wire.waypoints[segIdx - 1]?.z : undefined;
                            const nextZ = segIdx < wire.waypoints.length ? wire.waypoints[segIdx]?.z : undefined;
                            const midZ =
                              prevZ !== undefined && nextZ !== undefined
                                ? Number(((prevZ + nextZ) / 2).toFixed(2))
                                : prevZ ?? nextZ;
                            const inserted: WireWaypoint = {
                              x: Number(((a.x + b.x) / 2).toFixed(2)),
                              y: Number(((a.y + b.y) / 2).toFixed(2)),
                              ...(midZ !== undefined ? { z: midZ } : {}),
                            };
                            const nextWps = [...wire.waypoints];
                            nextWps.splice(segIdx, 0, inserted);
                            onUpdateWireWaypoints(wire.id, nextWps, false);
                            setSelectedVertexRef({ wireId: wire.id, index: segIdx });
                            setDraggingWaypoint({
                              wireId: wire.id,
                              index: segIdx,
                              snapshotRecorded: true,
                            });
                          }}
                        >
                          <circle r="5.5" fill="#0D1528" stroke="#00A8FF" strokeWidth="1.2" />
                          <text
                            y="3"
                            textAnchor="middle"
                            fill="#00A8FF"
                            fontSize="9"
                            fontWeight="700"
                            pointerEvents="none"
                          >
                            +
                          </text>
                          <title>Click &amp; drag to insert new vertex</title>
                        </g>
                      );
                    })}

                    {/* AutoCAD Square Vertex Grips (Drag freely to move · Click + Delete or Dbl-click/Right-click to remove) */}
                    {wire.waypoints.map((wp, wpIdx) => {
                      const isVertexActive =
                        selectedVertexRef?.wireId === wire.id &&
                        selectedVertexRef?.index === wpIdx;
                      const vx = PAD + wp.x * SCALE;
                      const vy = PAD + wp.y * SCALE;
                      const half = isVertexActive ? 6 : 5;
                      return (
                        <rect
                          key={`wp-${wpIdx}`}
                          x={vx - half}
                          y={vy - half}
                          width={half * 2}
                          height={half * 2}
                          rx="1.2"
                          fill={isVertexActive ? '#FF9D00' : '#00A8FF'}
                          stroke="#080F20"
                          strokeWidth="1.6"
                          className="cursor-move"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            if (e.button === 2) return;
                            setSelectedVertexRef({ wireId: wire.id, index: wpIdx });
                            setDraggingWaypoint({
                              wireId: wire.id,
                              index: wpIdx,
                              snapshotRecorded: false,
                            });
                          }}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            onRecordHistorySnapshot?.();
                            onUpdateWireWaypoints(
                              wire.id,
                              wire.waypoints.filter((_, i) => i !== wpIdx),
                              false
                            );
                            setSelectedVertexRef(null);
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onRecordHistorySnapshot?.();
                            onUpdateWireWaypoints(
                              wire.id,
                              wire.waypoints.filter((_, i) => i !== wpIdx),
                              false
                            );
                            setSelectedVertexRef(null);
                          }}
                        >
                          <title>Drag to move vertex · Press Delete, Double-click, or Right-click to remove vertex</title>
                        </rect>
                      );
                    })}
                  </g>
                )}
              </g>
            );
          })}

          {/* Live AutoCAD LINE/POLYLINE Cable Routing Preview (Free cursor movement, segment & total length HUD, OSNAP ring) */}
          {!previewOnly && activeTool === 'add-wire' && wireDraft && (() => {
            const fromPt = pointLookup.get(wireDraft.fromPointId);
            if (!fromPt) return null;
            const committedNodes = [
              { x: fromPt.x, y: fromPt.y },
              ...wireDraft.waypoints,
            ];
            const draftNodes = [
              ...committedNodes,
              ...(wireDraft.preview ? [wireDraft.preview] : []),
            ];
            const committedSvgPts = committedNodes.map((n) => ({
              x: PAD + n.x * SCALE,
              y: PAD + n.y * SCALE,
            }));
            const draftSvgPts = draftNodes.map((n) => ({
              x: PAD + n.x * SCALE,
              y: PAD + n.y * SCALE,
            }));
            const committedD =
              committedSvgPts.length >= 2
                ? activeWireRoutingMode === 'curved' && committedSvgPts.length >= 3
                  ? buildSmoothSvgPath(committedSvgPts)
                  : committedSvgPts
                      .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
                      .join(' ')
                : '';
            const lastCommittedSvg = committedSvgPts[committedSvgPts.length - 1];
            const cursorSvg = wireDraft.preview
              ? { x: PAD + wireDraft.preview.x * SCALE, y: PAD + wireDraft.preview.y * SCALE }
              : null;
            const fullCurvedD =
              activeWireRoutingMode === 'curved' && draftSvgPts.length >= 3
                ? buildSmoothSvgPath(draftSvgPts)
                : '';

            const metrics = computePolylineSegmentMetrics(draftNodes);
            let draftLen = metrics.totalLengthM;
            if (activeWireRoutingMode === 'curved' && draftNodes.length >= 3) {
              draftLen = 0;
              const sampled = sampleCurvedPath3D(
                draftNodes.map((n) => ({ x: n.x, y: n.y, z: 0 })),
                8
              );
              for (let i = 0; i < sampled.length - 1; i++) {
                draftLen += Math.hypot(
                  sampled[i + 1].x - sampled[i].x,
                  sampled[i + 1].y - sampled[i].y
                );
              }
            }

            // Detect OSNAP proximity to any compatible destination electrical component
            let osnapTarget: ElectricalPoint | null = null;
            if (wireDraft.preview) {
              const candidates = allowInterFloorWiring ? fullProject.points : project.points;
              let bestSnap = 0.55;
              candidates.forEach((pt) => {
                if (pt.id === fromPt.id) return;
                const d = Math.hypot(pt.x - wireDraft.preview!.x, pt.y - wireDraft.preview!.y);
                if (d <= bestSnap) {
                  const compat = checkTerminalCompatibility(
                    fromPt,
                    pt,
                    activeWireCategory,
                    allowInterFloorWiring
                  );
                  if (compat.compatible) {
                    bestSnap = d;
                    osnapTarget = pt;
                  }
                }
              });
            }

            const lastNode = draftNodes[draftNodes.length - 1];
            const draftColor = WIRE_STANDARD_COLORS[wiringConfig.standard][activeWireCategory];
            return (
              <g pointerEvents="none">
                {/* Placed connected polyline segments (solid) */}
                {committedD && (
                  <path
                    d={committedD}
                    fill="none"
                    stroke={draftColor}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
                {/* Live rubber-band preview segment following cursor freely in any angle */}
                {activeWireRoutingMode === 'curved' && fullCurvedD ? (
                  <path
                    d={fullCurvedD}
                    fill="none"
                    stroke={draftColor}
                    strokeWidth="2.2"
                    strokeDasharray="6,4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeOpacity="0.85"
                  />
                ) : (
                  lastCommittedSvg &&
                  cursorSvg && (
                    <line
                      x1={lastCommittedSvg.x}
                      y1={lastCommittedSvg.y}
                      x2={cursorSvg.x}
                      y2={cursorSvg.y}
                      stroke={draftColor}
                      strokeWidth="2.2"
                      strokeDasharray="6,4"
                      strokeLinecap="round"
                    />
                  )
                )}
                {/* AutoCAD square vertex grips at every placed point */}
                {wireDraft.waypoints.map((wp, idx) => (
                  <rect
                    key={`draft-wp-${idx}`}
                    x={PAD + wp.x * SCALE - 4}
                    y={PAD + wp.y * SCALE - 4}
                    width="8"
                    height="8"
                    rx="1"
                    fill={draftColor}
                    stroke="#080F20"
                    strokeWidth="1.2"
                  />
                ))}
                {/* Active cursor point indicator */}
                {cursorSvg && (
                  <circle
                    cx={cursorSvg.x}
                    cy={cursorSvg.y}
                    r="3.2"
                    fill="#E0F4FF"
                    stroke={draftColor}
                    strokeWidth="1.4"
                  />
                )}
                {/* AutoCAD OSNAP ring when hovering near a compatible destination component */}
                {osnapTarget && (
                  <g
                    transform={`translate(${PAD + (osnapTarget as ElectricalPoint).x * SCALE} ${PAD + (osnapTarget as ElectricalPoint).y * SCALE})`}
                  >
                    <circle
                      r="13"
                      fill="none"
                      stroke="#22C55E"
                      strokeWidth="1.8"
                      strokeDasharray="3,2"
                    />
                    <rect
                      x="-5"
                      y="-5"
                      width="10"
                      height="10"
                      fill="none"
                      stroke="#22C55E"
                      strokeWidth="1.4"
                    />
                  </g>
                )}
                {/* Dynamic Input HUD: Active Segment Length & Angle + Cumulative Total Length */}
                <g
                  transform={`translate(${PAD + lastNode.x * SCALE} ${PAD + lastNode.y * SCALE - 22})`}
                >
                  <rect
                    x="-98"
                    y="-12"
                    width="196"
                    height="20"
                    rx="3"
                    fill="#080F20"
                    fillOpacity="0.94"
                    stroke={osnapTarget ? '#22C55E' : draftColor}
                  />
                  <text
                    x="0"
                    y="1.5"
                    textAnchor="middle"
                    fill="#E0F4FF"
                    fontFamily="Red Hat Mono, monospace"
                    fontSize="8.2"
                  >
                    {metrics.lastSegmentLengthM.toFixed(2)}m ∠{metrics.lastSegmentAngleDeg.toFixed(0)}° · Click to end · Esc cancel
                  </text>
                </g>
              </g>
            );
          })()}

          {/* Electrical Points */}
          {cadLayers.symbols && project.points.map((pt) => {
            const px = PAD + (pt.x + (groupDrag ? groupDrag.dx : 0)) * SCALE;
            const py = PAD + (pt.y + (groupDrag ? groupDrag.dy : 0)) * SCALE;
            const isSelected = isEntitySelected('point', pt.id);
            const isActiveFind = !previewOnly && activeHighlightId === pt.id;
            const isFindMatch = !previewOnly && !!highlightedIds?.has(pt.id);
            const isHighPower = pt.category === 'Appliances' || pt.itemType === 'socket_16a';
            const fill = isActiveFind
              ? '#FF9D00'
              : isSelected
                ? '#00A8FF'
                : isHighPower
                  ? '#FF9D00'
                  : '#0D1528';
            const stroke = isActiveFind || isSelected ? '#F5F7FA' : isFindMatch ? '#FBBF24' : isHighPower ? '#FFE2B3' : '#00A8FF';
            const radius = previewOnly ? 4 : isActiveFind ? 10 : isSelected ? 9 : isFindMatch ? 8 : 6.5;

            const isPointDimmed =
              !!isolatedRoom &&
              pt.roomId !== isolatedRoom.id &&
              !isPointInsideRoom(isolatedRoom, pt.x, pt.y);

            return (
              <g
                key={pt.id}
                opacity={isPointDimmed ? 0.14 : 1}
                pointerEvents={isPointDimmed ? 'none' : 'auto'}
                transform={`translate(${px} ${py})`}
                className={
                  previewOnly || activeTool === 'pan'
                    ? ''
                    : activeTool === 'erase'
                      ? 'cursor-not-allowed'
                      : 'cursor-pointer'
                }
                onPointerDown={(e) => {
                  if (
                    previewOnly ||
                    e.button === 1 ||
                    activeTool === 'pan' ||
                    activeTool === 'draw-wall' ||
                    activeTool === 'dimension' ||
                    allSelected
                  ) {
                    return;
                  }
                  e.stopPropagation();
                  if (activeTool === 'add-wire') {
                    if (!wireConfigReady) {
                      onRequestCableConfig?.(pt.id, { x: pt.x, y: pt.y });
                      return;
                    }
                    if (!wireDraft) {
                      setWireDraft({
                        fromPointId: pt.id,
                        waypoints: [],
                        preview: { x: pt.x, y: pt.y },
                      });
                    } else {
                      const fromPt = pointLookup.get(wireDraft.fromPointId);
                      if (!fromPt) {
                        setWireDraft(null);
                        return;
                      }
                      const compat = checkTerminalCompatibility(
                        fromPt,
                        pt,
                        activeWireCategory,
                        allowInterFloorWiring
                      );
                      if (!compat.compatible) {
                        onValidationWarning?.(
                          compat.reason || 'Selected electrical terminals are incompatible.'
                        );
                        return;
                      }
                      if (compat.warning) {
                        onValidationWarning?.(compat.warning);
                      }
                      const cleaned = finalizePolylineWaypoints(wireDraft.waypoints, pt, false);
                      onCreateWire?.(fromPt.id, pt.id, cleaned);
                      setWireDraft(null);
                    }
                    return;
                  }
                  if (activeTool === 'erase') {
                    onEraseEntity?.({ kind: 'point', id: pt.id });
                    return;
                  }
                  if (activeTool === 'rotate') {
                    onClearAllSelection?.();
                    onSelectEntity?.({ kind: 'point', id: pt.id }, false);
                    onRotateEntity?.({ kind: 'point', id: pt.id });
                    return;
                  }
                  // Ctrl + Left Click on any electrical point (fan, light, switch, socket, AC, etc.) -> Duplicate & position freely!
                  if ((e.ctrlKey || e.metaKey) && e.button === 0 && onDuplicatePoint) {
                    e.preventDefault();
                    onClearAllSelection?.();
                    const dup = onDuplicatePoint(pt.id);
                    if (dup) {
                      const raw = clientToRawMeters(e.clientX, e.clientY);
                      setDraggingPoint({
                        id: dup.id,
                        startX: raw.x,
                        startY: raw.y,
                        moved: false,
                        snapshotRecorded: true,
                      });
                    }
                    return;
                  }
                  onClearAllSelection?.();
                  onSelectEntity?.({ kind: 'point', id: pt.id }, e.shiftKey);
                  onSelectPoint?.(pt.id, e.shiftKey);
                  if (!e.shiftKey && (activeTool === 'select' || activeTool === 'move')) {
                    const raw = clientToRawMeters(e.clientX, e.clientY);
                    setDraggingPoint({
                      id: pt.id,
                      startX: raw.x,
                      startY: raw.y,
                      moved: false,
                      snapshotRecorded: false,
                    });
                  }
                }}
              >
                {isActiveFind && (
                  <circle r="19" fill="rgba(255, 157, 0, 0.16)" stroke="#FF9D00" strokeWidth="2" />
                )}
                {(isSelected || isFindMatch || wireDraft?.fromPointId === pt.id) && (
                  <circle
                    r="14"
                    fill="none"
                    stroke={
                      wireDraft?.fromPointId === pt.id
                        ? '#22C55E'
                        : isActiveFind
                          ? '#FF9D00'
                          : isSelected
                            ? '#00A8FF'
                            : '#FBBF24'
                    }
                    strokeWidth="1.8"
                    strokeDasharray="3,2"
                  />
                )}
                {pt.itemType === 'distribution_board' ? (
                  <g>
                    <rect
                      x={previewOnly ? -6 : -10}
                      y={previewOnly ? -4.5 : -7}
                      width={previewOnly ? 12 : 20}
                      height={previewOnly ? 9 : 14}
                      rx="1.5"
                      fill={isSelected ? '#00A8FF' : '#0D1528'}
                      stroke={isSelected ? '#F5F7FA' : '#38BDF8'}
                      strokeWidth={isSelected ? 2 : 1.6}
                    />
                    <line
                      x1={previewOnly ? -6 : -10}
                      y1={previewOnly ? 4.5 : 7}
                      x2={previewOnly ? 6 : 10}
                      y2={previewOnly ? -4.5 : -7}
                      stroke={isSelected ? '#080F20' : '#38BDF8'}
                      strokeWidth="1.4"
                    />
                  </g>
                ) : pt.itemType === 'earthing_point' ? (
                  <g>
                    <circle
                      r={previewOnly ? 5 : 8.5}
                      fill={isSelected ? '#16A34A' : '#0D1528'}
                      stroke="#22C55E"
                      strokeWidth={isSelected ? 2.2 : 1.6}
                    />
                    {/* Standard IEC Earthing Symbol */}
                    <line x1="0" y1="-4.5" x2="0" y2="0.5" stroke="#4ADE80" strokeWidth="1.4" />
                    <line x1="-4.5" y1="0.5" x2="4.5" y2="0.5" stroke="#4ADE80" strokeWidth="1.4" />
                    <line x1="-3" y1="2.8" x2="3" y2="2.8" stroke="#4ADE80" strokeWidth="1.3" />
                    <line x1="-1.5" y1="5" x2="1.5" y2="5" stroke="#4ADE80" strokeWidth="1.2" />
                  </g>
                ) : (
                  <circle
                    r={radius}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={isSelected || isActiveFind ? 2 : 1.5}
                  />
                )}
                {!previewOnly && (
                  <text
                    y={-12}
                    textAnchor="middle"
                    fill={
                      pt.itemType === 'earthing_point'
                        ? '#4ADE80'
                        : pt.itemType === 'distribution_board'
                          ? '#7DD3FC'
                          : isActiveFind
                            ? '#FFE2B3'
                            : isSelected
                              ? '#FFFFFF'
                              : isFindMatch
                                ? '#FDE68A'
                                : isHighPower
                                  ? '#FFE2B3'
                                  : '#C5CDD8'
                    }
                    fontFamily="Red Hat Mono, monospace"
                    fontSize={isSelected || isActiveFind ? '9.5' : '8.5'}
                    fontWeight={isSelected || isActiveFind || pt.category === 'Distribution' ? '700' : '500'}
                    pointerEvents="none"
                  >
                    {pt.code}
                  </text>
                )}
                <title>
                  {pt.name} ({pt.wattage}W · {pt.circuit}) — {CATALOG_MAP[pt.itemType]?.productName}
                </title>
              </g>
            );
          })}

          {/* Optional AI Drawing Imported Columns & Collision-Decluttered Text Annotations (Single Canonical Pass) */}
          {fullProject.aiDrawingImport && (
            <g pointerEvents="none">
              {cadLayers.columns &&
                (fullProject.aiDrawingImport.columns ?? [])
                  .filter((col) => (col.floor ?? 1) === activeFloor)
                  .map((col) => {
                    const cx = PAD + (col.x + (groupDrag ? groupDrag.dx : 0)) * SCALE;
                    const cy = PAD + (col.y + (groupDrag ? groupDrag.dy : 0)) * SCALE;
                    const wPx = Math.max(6, col.width * SCALE);
                    const hPx = Math.max(6, col.height * SCALE);
                    return (
                      <g key={col.id}>
                        <rect
                          x={cx - wPx / 2}
                          y={cy - hPx / 2}
                          width={wPx}
                          height={hPx}
                          fill="rgba(148, 163, 184, 0.38)"
                          stroke="#94A3B8"
                          strokeWidth="1.4"
                        />
                        {!previewOnly && wPx >= 14 && (
                          <text
                            x={cx}
                            y={cy + 3}
                            textAnchor="middle"
                            fill="#E2E8F0"
                            fontFamily="Red Hat Mono, monospace"
                            fontSize="7.5"
                          >
                            {col.label}
                          </text>
                        )}
                      </g>
                    );
                  })}
              {!previewOnly &&
                cadLayers.labels &&
                (() => {
                  const placedBoxes: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
                  // Reserve existing room label centers so imported annotations never overlap room names
                  project.rooms.forEach((rm) => {
                    const rcx = PAD + (rm.x + rm.width / 2) * SCALE;
                    const rcy = PAD + (rm.y + rm.height / 2) * SCALE;
                    placedBoxes.push({ x1: rcx - 38, y1: rcy - 14, x2: rcx + 38, y2: rcy + 14 });
                  });
                  const candidates = (fullProject.aiDrawingImport?.textAnnotations ?? [])
                    .filter(
                      (lbl) =>
                        (lbl.floor ?? 1) === activeFloor &&
                        lbl.kind !== 'title-block' &&
                        lbl.kind !== 'legend-text' &&
                        lbl.text.trim().length > 0
                    )
                    .slice(0, 120);

                  return candidates.map((lbl) => {
                    const lx = PAD + (lbl.x + (groupDrag ? groupDrag.dx : 0)) * SCALE;
                    const ly = PAD + (lbl.y + (groupDrag ? groupDrag.dy : 0)) * SCALE;
                    const display = lbl.text.trim().slice(0, 36);
                    const estW = Math.max(24, display.length * 5.2);
                    const estH = 12;
                    const box = {
                      x1: lx - estW / 2 - 2,
                      y1: ly - estH,
                      x2: lx + estW / 2 + 2,
                      y2: ly + 3,
                    };
                    const collides = placedBoxes.some(
                      (b) =>
                        box.x1 < b.x2 &&
                        box.x2 > b.x1 &&
                        box.y1 < b.y2 &&
                        box.y2 > b.y1
                    );
                    if (collides) return null;
                    placedBoxes.push(box);
                    return (
                      <text
                        key={lbl.id}
                        x={lx}
                        y={ly}
                        textAnchor="middle"
                        fill={lbl.kind === 'room-label' ? '#E2E8F0' : '#94A3B8'}
                        fontFamily="Red Hat Mono, monospace"
                        fontSize={lbl.kind === 'room-label' ? '8.5' : '7.5'}
                        fontWeight={lbl.kind === 'room-label' ? '600' : '400'}
                      >
                        {display}
                      </text>
                    );
                  });
                })()}
            </g>
          )}

          {/* Ctrl+A Select All Visual Bounding Frame */}
          {allSelected && !previewOnly && (
            <g pointerEvents="none">
              <rect
                x={PAD - 6}
                y={PAD - 6}
                width={planW + 12}
                height={planH + 12}
                rx="4"
                fill="rgba(0, 168, 255, 0.04)"
                stroke={groupDrag && !groupDrag.valid ? '#EF4444' : '#00A8FF'}
                strokeWidth="2"
                strokeDasharray="8,4"
              />
              <rect
                x={PAD + 8}
                y={PAD + 8}
                width="184"
                height="20"
                rx="3"
                fill="#080F20"
                stroke="#00A8FF"
                strokeWidth="1"
              />
              <text
                x={PAD + 100}
                y={PAD + 21}
                textAnchor="middle"
                fill="#00A8FF"
                fontFamily="Red Hat Mono, monospace"
                fontSize="9.5"
                fontWeight="600"
              >
                ALL SELECTED · DRAG TO MOVE
              </text>
            </g>
          )}
          </g>
          </g>
        </g>
      </svg>

      {/* Top-Left PDF-vs-CAD Alignment, Layer Visibility & 2D Approval Controls */}
      {!previewOnly && (referenceOverlay?.dataUrl || fullProject.aiDrawingImport) && (
        <div
          data-pdf-compare-controls="true"
          className="absolute top-3 left-3 z-20 flex flex-col gap-1.5"
        >
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-outline bg-surface-container px-2.5 py-1.5 text-[11px] font-mono text-on-surface shadow-md">
            <span className="font-semibold text-primary">
              {referenceOverlay?.dataUrl ? 'Locked Ref PDF' : 'CAD Import'}
            </span>
            {referenceOverlay?.dataUrl && (
              <button
                type="button"
                onClick={() => setShowReferencePdf((v) => !v)}
                className={`rounded border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                  showReferencePdf
                    ? 'border-primary bg-primary/15 text-primary'
                    : 'border-outline bg-surface text-on-surface-variant'
                }`}
              >
                {showReferencePdf ? 'Hide PDF' : 'Show PDF'}
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowReconstructedCad((v) => !v)}
              className={`rounded border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                showReconstructedCad
                  ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300'
                  : 'border-outline bg-surface text-on-surface-variant'
              }`}
            >
              {showReconstructedCad ? 'Hide CAD' : 'Show CAD'}
            </button>
            {referenceOverlay?.dataUrl && showReferencePdf && (
              <label className="flex items-center gap-1.5 text-[10px] text-on-surface-variant">
                <span>Opacity</span>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={referencePdfOpacity}
                  onChange={(e) => setReferencePdfOpacity(Number(e.target.value))}
                  className="w-16 accent-primary"
                />
                <span className="w-7 text-right text-on-surface">
                  {Math.round(referencePdfOpacity * 100)}%
                </span>
              </label>
            )}
            <button
              type="button"
              onClick={() => setCadLayersOpen((v) => !v)}
              className={`rounded border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                cadLayersOpen
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-outline bg-surface text-on-surface-variant hover:text-on-surface'
              }`}
            >
              CAD Layers
            </button>
            {onExportDxf && (
              <button
                type="button"
                onClick={onExportDxf}
                className="rounded border border-outline bg-surface px-2 py-0.5 text-[10px] font-semibold text-on-surface hover:border-primary hover:text-primary transition-colors"
                title="Export validated editable AutoCAD DXF"
              >
                Export DXF
              </button>
            )}
            {fullProject.aiDrawingImport &&
              fullProject.aiDrawingImport.approvedFor3D === false &&
              onApprove2DFor3D && (
                <button
                  type="button"
                  onClick={onApprove2DFor3D}
                  className="rounded border border-emerald-500 bg-emerald-600 px-2.5 py-0.5 text-[10px] font-semibold text-white hover:bg-emerald-500 transition-colors"
                  title="Approve the reconstructed 2D CAD geometry and generate the 3D scene"
                >
                  Approve 2D & Open 3D
                </button>
              )}
          </div>

          {cadLayersOpen && (
            <div className="w-60 rounded-md border border-outline bg-surface-container p-2.5 text-[11px] font-mono text-on-surface shadow-xl space-y-1.5">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-on-surface-variant pb-1 border-b border-outline-variant">
                <span>Editable CAD Layers</span>
                <span className="text-primary">PDF Locked</span>
              </div>
              {(
                [
                  ['walls', 'Walls & Boundaries'],
                  ['rooms', 'Rooms & Spaces'],
                  ['openings', 'Doors & Windows'],
                  ['columns', 'Columns & Structure'],
                  ['symbols', 'Electrical & Lighting'],
                  ['dimensions', 'Dimensions'],
                  ['labels', 'Annotations & Labels'],
                ] as const
              ).map(([key, label]) => (
                <label
                  key={key}
                  className="flex items-center justify-between gap-2 cursor-pointer py-0.5 hover:text-primary"
                >
                  <span>{label}</span>
                  <input
                    type="checkbox"
                    checked={cadLayers[key]}
                    onChange={() =>
                      setCadLayers((prev) => ({ ...prev, [key]: !prev[key] }))
                    }
                    className="accent-primary"
                  />
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Bottom-Left Calibrated 1:4 Canvas Ratio & Scale HUD */}
      {!previewOnly && (
        <div className="absolute bottom-3 left-3 z-20 flex items-center gap-2 rounded-md border border-outline bg-surface-container px-2.5 py-1.5 text-[11px] font-mono text-on-surface shadow-md">
          <span className="font-semibold text-primary">1:4 Canvas</span>
          <span className="text-on-surface-variant">·</span>
          <span className="text-on-surface-variant">
            {siteLenLabel} × {siteWidLabel}
          </span>
          <span className="text-on-surface-variant">·</span>
          <span className="text-on-surface">{zoom}%</span>
          {onZoomChange && onPanChange && (
            <div className="ml-1 flex items-center gap-1 border-l border-outline pl-2">
              <button
                type="button"
                onClick={() => {
                  onZoomChange(100);
                  onPanChange({ x: 0, y: 0 });
                }}
                className="rounded border border-outline bg-surface px-1.5 py-0.5 text-[10px] text-on-surface hover:border-primary hover:text-primary transition-colors"
                title="Fit building plan at calibrated 100% scale"
              >
                Fit Plan
              </button>
              <button
                type="button"
                onClick={() => {
                  onZoomChange(canvasMetrics.fitSheetZoomPct);
                  onPanChange({ x: 0, y: 0 });
                }}
                className="rounded border border-outline bg-surface px-1.5 py-0.5 text-[10px] text-on-surface-variant hover:border-primary hover:text-primary transition-colors"
                title="View entire 1:4 calibrated drawing sheet"
              >
                1:4 Sheet
              </button>
            </div>
          )}
        </div>
      )}

      {/* Bottom-Right Live 3-Conductor (L/N/E) Wire Routing & Quantity Schedule HUD */}
      {!previewOnly && (
        <div className="absolute bottom-3 right-3 z-20 flex flex-col items-end">
          {wirePanelOpen && (
            <div className="mb-2 w-[560px] max-w-[calc(100vw-2rem)] max-h-[380px] flex flex-col rounded-lg border border-outline bg-surface-container shadow-xl overflow-hidden text-xs">
              {/* Panel Header */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-outline bg-surface px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-on-surface tracking-tight">
                    Wire Routing & Quantities
                  </span>
                  <span className="font-mono text-[10px] text-on-surface-variant">
                    ({activeWireReport.wireCount} runs)
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setWireScopeAllFloors((v) => !v)}
                    className="rounded border border-outline bg-surface-container px-2 py-0.5 font-mono text-[10px] text-on-surface hover:border-primary transition-colors"
                  >
                    {wireScopeAllFloors ? 'All Floors' : getFloorLabel(fullProject, activeFloor)}
                  </button>
                  <label className="flex items-center gap-1 font-mono text-[10px] text-on-surface-variant">
                    <span>Allow:</span>
                    <select
                      value={allowancePct}
                      onChange={(e) => setAllowancePct(Number(e.target.value))}
                      className="rounded border border-outline bg-surface-container px-1 py-0.5 font-mono text-[10px] text-on-surface outline-none focus:border-primary"
                    >
                      <option value={0}>0%</option>
                      <option value={5}>5%</option>
                      <option value={10}>10%</option>
                      <option value={15}>15%</option>
                    </select>
                  </label>
                  {onAutoRouteWires && (
                    <button
                      type="button"
                      onClick={onAutoRouteWires}
                      className="rounded bg-primary px-2 py-0.5 font-mono text-[10px] font-semibold text-on-primary hover:opacity-90 transition-opacity"
                    >
                      Route L/N/E
                    </button>
                  )}
                </div>
              </div>

              {/* Conductor Legend Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-outline/60 bg-surface-container px-3 py-1.5 text-[10px] font-mono">
                <div className="flex items-center gap-3">
                  {(['phase', 'neutral', 'earth'] as const).map((cat) => (
                    <span key={cat} className="inline-flex items-center gap-1.5 text-on-surface">
                      <span
                        className="inline-block h-2 w-4 rounded-sm"
                        style={{ backgroundColor: CONDUCTOR_COLOR_LEGEND[cat].color }}
                      />
                      {CONDUCTOR_COLOR_LEGEND[cat].label}
                    </span>
                  ))}
                </div>
                <span className="text-on-surface-variant">
                  Base (H+V) · Term. · Allow ({allowancePct}%) · Total
                </span>
              </div>

              {/* Per-Circuit Table */}
              <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2.5">
                {activeWireReport.circuits.length === 0 ? (
                  <div className="py-5 text-center text-on-surface-variant">
                    <p className="mb-2">No routed electrical conductors on this view yet.</p>
                    {onAutoRouteWires && (
                      <button
                        type="button"
                        onClick={onAutoRouteWires}
                        className="rounded bg-primary px-3 py-1 font-mono text-[11px] font-semibold text-on-primary hover:opacity-90"
                      >
                        Auto-Route Phase (L), Neutral (N) & Earth (E)
                      </button>
                    )}
                  </div>
                ) : (
                  activeWireReport.circuits.map((ckt) => {
                    const rows = [ckt.phase, ckt.neutral, ckt.earth].filter(
                      (r) => r.wireCount > 0 || ckt.phase.wireCount > 0 || ckt.neutral.wireCount > 0
                    );
                    if (ckt.other.wireCount > 0) rows.push(ckt.other);
                    return (
                      <div
                        key={ckt.circuit}
                        className="rounded border border-outline/70 bg-surface overflow-hidden"
                      >
                        <div className="flex items-center justify-between border-b border-outline/60 px-2.5 py-1 bg-surface-container/60">
                          <span className="font-mono text-[11px] font-semibold text-on-surface">
                            {ckt.circuit}
                          </span>
                          <span className="font-mono text-[10px] text-on-surface-variant">
                            Subtotal: {ckt.subtotal.totalM.toFixed(2)} m /{' '}
                            {ckt.subtotal.totalFt.toFixed(2)} ft
                          </span>
                        </div>
                        <table className="w-full text-left font-mono text-[10px]">
                          <thead>
                            <tr className="border-b border-outline/40 text-on-surface-variant">
                              <th className="py-1 pl-2.5 pr-1 font-medium">Conductor</th>
                              <th className="py-1 px-1 text-right font-medium">Base (H+V)</th>
                              <th className="py-1 px-1 text-right font-medium">Term.</th>
                              <th className="py-1 px-1 text-right font-medium">Allow.</th>
                              <th className="py-1 pl-1 pr-2.5 text-right font-medium text-on-surface">
                                Total (m / ft)
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((row) => (
                              <tr
                                key={`${ckt.circuit}-${row.category}`}
                                className="border-b border-outline/20 last:border-b-0"
                              >
                                <td className="py-1 pl-2.5 pr-1">
                                  <span className="inline-flex items-center gap-1.5 text-on-surface">
                                    <span
                                      className="inline-block h-2 w-2 rounded-full"
                                      style={{ backgroundColor: row.color }}
                                    />
                                    {row.label}
                                  </span>
                                </td>
                                <td className="py-1 px-1 text-right text-on-surface-variant">
                                  {row.baseRouteM.toFixed(2)}m
                                  <span className="block text-[9px] opacity-75">
                                    {row.baseRouteFt.toFixed(1)}ft
                                  </span>
                                </td>
                                <td className="py-1 px-1 text-right text-on-surface-variant">
                                  {row.terminationM.toFixed(2)}m
                                  <span className="block text-[9px] opacity-75">
                                    {row.terminationFt.toFixed(1)}ft
                                  </span>
                                </td>
                                <td className="py-1 px-1 text-right text-on-surface-variant">
                                  {row.allowanceM.toFixed(2)}m
                                  <span className="block text-[9px] opacity-75">
                                    {row.allowanceFt.toFixed(1)}ft
                                  </span>
                                </td>
                                <td className="py-1 pl-1 pr-2.5 text-right font-semibold text-on-surface">
                                  {row.totalM.toFixed(2)} m
                                  <span className="block text-[9px] font-normal text-primary">
                                    {row.totalFt.toFixed(2)} ft
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Grand Total Summary Footer */}
              {activeWireReport.wireCount > 0 && (
                <div className="border-t border-outline bg-surface px-3 py-2 font-mono text-[10px]">
                  <div className="grid grid-cols-3 gap-2 mb-1.5">
                    {(['phase', 'neutral', 'earth'] as const).map((cat) => {
                      const t = activeWireReport.totalsByConductor[cat];
                      return (
                        <div
                          key={cat}
                          className="rounded border border-outline/60 bg-surface-container px-2 py-1"
                        >
                          <div className="flex items-center gap-1 text-on-surface-variant">
                            <span
                              className="inline-block h-2 w-2 rounded-full"
                              style={{ backgroundColor: CONDUCTOR_COLOR_LEGEND[cat].color }}
                            />
                            <span>{CONDUCTOR_COLOR_LEGEND[cat].label}</span>
                          </div>
                          <div className="font-semibold text-on-surface">
                            {t.totalM.toFixed(2)} m · {t.totalFt.toFixed(1)} ft
                          </div>
                          <div className="text-[9px] text-on-surface-variant">
                            Base {t.baseRouteM.toFixed(1)}m + Term {t.terminationM.toFixed(1)}m + Allow{' '}
                            {t.allowanceM.toFixed(1)}m
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center justify-between pt-1 border-t border-outline/50 text-[11px]">
                    <span className="font-semibold text-on-surface">
                      Total All Conductors (Base {activeWireReport.grandTotal.baseRouteM.toFixed(1)}m ·
                      Term {activeWireReport.grandTotal.terminationM.toFixed(1)}m · Allow{' '}
                      {activeWireReport.grandTotal.allowanceM.toFixed(1)}m)
                    </span>
                    <span className="font-bold text-primary">
                      {activeWireReport.grandTotal.totalM.toFixed(2)} m /{' '}
                      {activeWireReport.grandTotal.totalFt.toFixed(2)} ft
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Compact Always-Visible Bottom-Right Wire Totals Bar */}
          <div className="flex items-center gap-2 rounded-md border border-outline bg-surface-container px-2.5 py-1.5 font-mono text-[11px] shadow-md">
            <span className="inline-flex items-center gap-1 text-on-surface" title="Phase (L) Total">
              <span className="inline-block h-2 w-2 rounded-full bg-[#EF4444]" />
              <span>L:</span>
              <span className="font-semibold">
                {activeWireReport.totalsByConductor.phase.totalM.toFixed(1)}m
              </span>
              <span className="text-on-surface-variant text-[10px]">
                ({activeWireReport.totalsByConductor.phase.totalFt.toFixed(0)}ft)
              </span>
            </span>
            <span className="inline-flex items-center gap-1 text-on-surface" title="Neutral (N) Total">
              <span className="inline-block h-2 w-2 rounded-full bg-[#3B82F6]" />
              <span>N:</span>
              <span className="font-semibold">
                {activeWireReport.totalsByConductor.neutral.totalM.toFixed(1)}m
              </span>
              <span className="text-on-surface-variant text-[10px]">
                ({activeWireReport.totalsByConductor.neutral.totalFt.toFixed(0)}ft)
              </span>
            </span>
            <span className="inline-flex items-center gap-1 text-on-surface" title="Earth (E) Total">
              <span className="inline-block h-2 w-2 rounded-full bg-[#22C55E]" />
              <span>E:</span>
              <span className="font-semibold">
                {activeWireReport.totalsByConductor.earth.totalM.toFixed(1)}m
              </span>
              <span className="text-on-surface-variant text-[10px]">
                ({activeWireReport.totalsByConductor.earth.totalFt.toFixed(0)}ft)
              </span>
            </span>
            {onAutoRouteWires && activeWireReport.wireCount === 0 && (
              <button
                type="button"
                onClick={onAutoRouteWires}
                className="ml-1 rounded bg-primary px-2 py-0.5 text-[10px] font-semibold text-on-primary hover:opacity-90"
              >
                Route L/N/E
              </button>
            )}
            <button
              type="button"
              onClick={() => setWirePanelOpen((v) => !v)}
              className="ml-1 rounded border border-outline bg-surface px-2 py-0.5 text-[10px] font-semibold text-primary hover:border-primary transition-colors"
            >
              {wirePanelOpen ? 'Hide Schedule' : 'Wire Schedule'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
