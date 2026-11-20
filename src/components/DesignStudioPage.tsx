import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  ArchitecturalOpening,
  CameraMode,
  CanvasTool,
  CircuitId,
  ElectricalItemType,
  ElectricalPoint,
  FloorView3DMode,
  FurnitureItem,
  LightingMode,
  ProjectData,
  RoomType,
  RoomZone,
  ScreenId,
  SelectedEntity,
  SiteConfig,
  UnitSystem,
  ViewMode,
} from '../types/design';
import {
  downloadFloorPlanPdf,
  downloadFloorPlanPng,
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
import { CreateRoomModal } from './CreateRoomModal';
import { DrawingInstructionsModal } from './DrawingInstructionsModal';
import { FloorPlan2D } from './FloorPlan2D';
import { Navbar } from './Navbar';
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
  { id: 'erase', label: 'Erase', icon: 'ink_eraser', hint: 'Click any room, custom wall, door, window, dimension, or electrical point to remove' },
  { id: 'dimension', label: 'Dimension', icon: 'straighten', hint: 'Click & drag between two points to place a measurement annotation' },
  { id: 'move', label: 'Move', icon: 'open_with', hint: 'Drag any room or electrical point to reposition it' },
  { id: 'rotate', label: 'Rotate', icon: 'rotate_right', hint: 'Click any room or door/window to rotate 90°' },
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
  onCompleteSiteConfig,
  onSaveAsProject,
  onImportProject,
  onUndo,
  onRedo,
  onSaveProject,
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>(
    project.siteConfigured === false ? '2d' : initialViewMode
  );
  const [activeFloor, setActiveFloor] = useState<number>(1);
  const [floorView3D, setFloorView3D] = useState<FloorView3DMode>('active-only');
  const [showGuideModal, setShowGuideModal] = useState<boolean>(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>('orbit');
  const [lightingMode, setLightingMode] = useState<LightingMode>('daylight');
  const [zoom, setZoom] = useState<number>(100);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const showGrid = true;
  const snapEnabled = true;
  const [activeTool, setActiveTool] = useState<CanvasTool>('select');

  const totalFloors = Math.max(1, Math.min(5, Math.round(project.site.floors || 1)));

  useEffect(() => {
    if (activeFloor > totalFloors) {
      setActiveFloor(totalFloors);
    }
  }, [activeFloor, totalFloors]);

  const floorProject = useMemo(
    () => sliceProjectForFloor(project, activeFloor),
    [project, activeFloor]
  );

  const [selectedEntity, setSelectedEntity] = useState<SelectedEntity>(() =>
    project.rooms[0] ? { kind: 'room', id: project.rooms[0].id } : null
  );
  const [allSelected, setAllSelected] = useState<boolean>(false);
  const [pendingPlaceItem, setPendingPlaceItem] = useState<ElectricalItemType | null>(null);
  const [pendingRoomModal, setPendingRoomModal] = useState<{
    x: number;
    y: number;
    roomType?: RoomType;
  } | null>(null);

  const [showExportMenu, setShowExportMenu] = useState(false);
  const [openDrawer, setOpenDrawer] = useState<'tools' | 'rooms' | 'site' | 'electrical' | null>(null);
  const [showSaveAsModal, setShowSaveAsModal] = useState(false);
  const [saveAsName, setSaveAsName] = useState(`${project.name} (Copy)`);
  const [saveAsError, setSaveAsError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const [inspectorWarning, setInspectorWarning] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{
    text: string;
    tone: 'info' | 'warning';
  }>(() => ({
    text:
      project.rooms.length === 0
        ? 'Blank site ready — click anywhere inside the site boundary to create a room'
        : 'Select any room to edit dimensions, or click empty space to add a room',
    tone: 'info',
  }));

  const notify = (text: string, tone: 'info' | 'warning' = 'info') => {
    setStatusMessage({ text, tone });
  };

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

  // Keyboard shortcuts for 2D SVG Floor Plan: Ctrl+A (Select All), Escape (Clear), Delete (Clear All Selected)
  useEffect(() => {
    if (project.siteConfigured === false || viewMode !== '2d') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (pendingRoomModal || showSaveAsModal || showGuideModal) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelectedEntity(null);
        setAllSelected(true);
        setInspectorWarning(null);
        const total =
          floorProject.rooms.length +
          floorProject.customWalls.length +
          floorProject.openings.length +
          floorProject.points.length +
          (floorProject.dimensions?.length ?? 0);
        setStatusMessage({
          text:
            total > 0
              ? `Selected all on ${formatFloorLabel(activeFloor)} (${floorProject.rooms.length} rooms, ${floorProject.customWalls.length} walls, ${floorProject.openings.length} openings) — drag to move together, Delete to clear, or Esc to deselect`
              : `${formatFloorLabel(activeFloor)} selected — click inside the boundary to create rooms or press Esc to deselect`,
          tone: 'info',
        });
        return;
      }

      if (e.key === 'Escape') {
        setAllSelected(false);
        setSelectedEntity(null);
        setPendingPlaceItem(null);
        setOpenDrawer(null);
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && allSelected) {
        e.preventDefault();
        onUpdateProject(
          (prev) => ({
            ...prev,
            rooms: prev.rooms.filter((r) => getItemFloor(r) !== activeFloor),
            customWalls: prev.customWalls.filter((w) => getItemFloor(w) !== activeFloor),
            openings: prev.openings.filter((o) => getItemFloor(o) !== activeFloor),
            dimensions: (prev.dimensions ?? []).filter((d) => getItemFloor(d) !== activeFloor),
            furniture: prev.furniture.filter((f) => getItemFloor(f) !== activeFloor),
            points: prev.points.filter((p) => getItemFloor(p) !== activeFloor),
          }),
          true
        );
        setAllSelected(false);
        setSelectedEntity(null);
        setStatusMessage({
          text: `Cleared all selected elements on ${formatFloorLabel(activeFloor)} (click Undo to restore)`,
          tone: 'info',
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    project.siteConfigured,
    floorProject.rooms.length,
    floorProject.customWalls.length,
    floorProject.openings.length,
    floorProject.points.length,
    floorProject.dimensions?.length,
    activeFloor,
    viewMode,
    pendingRoomModal,
    showSaveAsModal,
    showGuideModal,
    allSelected,
    onUpdateProject,
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
    const clamped = Math.max(1, Math.min(totalFloors, floorNum));
    setActiveFloor(clamped);
    setFloorView3D('active-only');
    setSelectedEntity(null);
    setAllSelected(false);
    setInspectorWarning(null);
    const { ceilingM } = siteToMeters(project.site);
    const elev =
      clamped > 1 ? ` · Elevation +${formatLength((clamped - 1) * ceilingM, units, 1)}` : ' · Ground Level';
    notify(`Showing ${formatFloorLabel(clamped)} only${elev}`);
  };

  const handleToggleElevatedView = () => {
    setFloorView3D('all');
    setViewMode('3d');
    setSelectedEntity(null);
    setAllSelected(false);
    setInspectorWarning(null);
    notify(`Elevated View — displaying all ${totalFloors} floors stacked together`);
  };

  const handleCopyFloorBelow = () => {
    if (activeFloor <= 1) return;
    const sourceFloor = activeFloor - 1;
    const sourceSlice = sliceProjectForFloor(project, sourceFloor);
    if (
      sourceSlice.rooms.length === 0 &&
      sourceSlice.customWalls.length === 0 &&
      sourceSlice.openings.length === 0
    ) {
      notify(`${formatFloorLabel(sourceFloor)} has no rooms or walls to copy yet.`, 'warning');
      return;
    }

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    const roomIdMap = new Map<string, string>();

    const clonedRooms = sourceSlice.rooms.map((r, idx) => {
      const nextId = `rm-f${activeFloor}-${stamp}-${idx}`;
      roomIdMap.set(r.id, nextId);
      return { ...r, id: nextId, floor: activeFloor };
    });
    const clonedWalls = sourceSlice.customWalls.map((w, idx) => ({
      ...w,
      id: `cw-f${activeFloor}-${stamp}-${idx}`,
      floor: activeFloor,
    }));
    const clonedOpenings = sourceSlice.openings.map((o, idx) => ({
      ...o,
      id: `op-f${activeFloor}-${stamp}-${idx}`,
      floor: activeFloor,
    }));
    const clonedFurniture = sourceSlice.furniture.map((f, idx) => ({
      ...f,
      id: `fn-f${activeFloor}-${stamp}-${idx}`,
      roomId: roomIdMap.get(f.roomId) ?? f.roomId,
      floor: activeFloor,
    }));
    const clonedPoints = sourceSlice.points.map((p, idx) => ({
      ...p,
      id: `pt-f${activeFloor}-${stamp}-${idx}`,
      code: `F${activeFloor}-${p.code}`,
      roomId: roomIdMap.get(p.roomId) ?? p.roomId,
      floor: activeFloor,
    }));

    onUpdateProject(
      (prev) => ({
        ...prev,
        rooms: [...prev.rooms.filter((r) => getItemFloor(r) !== activeFloor), ...clonedRooms],
        customWalls: [
          ...prev.customWalls.filter((w) => getItemFloor(w) !== activeFloor),
          ...clonedWalls,
        ],
        openings: [
          ...prev.openings.filter((o) => getItemFloor(o) !== activeFloor),
          ...clonedOpenings,
        ],
        furniture: [
          ...prev.furniture.filter((f) => getItemFloor(f) !== activeFloor),
          ...clonedFurniture,
        ],
        points: [
          ...prev.points.filter((p) => getItemFloor(p) !== activeFloor),
          ...clonedPoints,
        ],
      }),
      true
    );
    setSelectedEntity(null);
    notify(
      `Copied ${formatFloorLabel(sourceFloor)} layout (${clonedRooms.length} rooms) onto ${formatFloorLabel(activeFloor)}`
    );
  };

  const handleMoveAll = (dxM: number, dyM: number) => {
    const shift = (v: number, delta: number) => Number((v + delta).toFixed(3));

    onUpdateProject(
      (prev) => ({
        ...prev,
        rooms: prev.rooms.map((r) =>
          getItemFloor(r) === activeFloor
            ? { ...r, x: shift(r.x, dxM), y: shift(r.y, dyM) }
            : r
        ),
        customWalls: prev.customWalls.map((w) =>
          getItemFloor(w) === activeFloor
            ? {
                ...w,
                x1: shift(w.x1, dxM),
                y1: shift(w.y1, dyM),
                x2: shift(w.x2, dxM),
                y2: shift(w.y2, dyM),
              }
            : w
        ),
        openings: prev.openings.map((op) =>
          getItemFloor(op) === activeFloor
            ? { ...op, x: shift(op.x, dxM), y: shift(op.y, dyM) }
            : op
        ),
        dimensions: (prev.dimensions ?? []).map((d) =>
          getItemFloor(d) === activeFloor
            ? {
                ...d,
                x1: shift(d.x1, dxM),
                y1: shift(d.y1, dyM),
                x2: shift(d.x2, dxM),
                y2: shift(d.y2, dyM),
              }
            : d
        ),
        furniture: prev.furniture.map((f) =>
          getItemFloor(f) === activeFloor
            ? { ...f, x: shift(f.x, dxM), y: shift(f.y, dyM) }
            : f
        ),
        points: prev.points.map((p) =>
          getItemFloor(p) === activeFloor
            ? { ...p, x: shift(p.x, dxM), y: shift(p.y, dyM) }
            : p
        ),
      }),
      true
    );
    notify(`Moved all selected elements on ${formatFloorLabel(activeFloor)} freely on canvas`);
  };

  const handleClearAllSelected = () => {
    onUpdateProject(
      (prev) => ({
        ...prev,
        rooms: prev.rooms.filter((r) => getItemFloor(r) !== activeFloor),
        customWalls: prev.customWalls.filter((w) => getItemFloor(w) !== activeFloor),
        openings: prev.openings.filter((o) => getItemFloor(o) !== activeFloor),
        dimensions: (prev.dimensions ?? []).filter((d) => getItemFloor(d) !== activeFloor),
        furniture: prev.furniture.filter((f) => getItemFloor(f) !== activeFloor),
        points: prev.points.filter((p) => getItemFloor(p) !== activeFloor),
      }),
      true
    );
    setAllSelected(false);
    setSelectedEntity(null);
    notify(`Cleared all selected elements on ${formatFloorLabel(activeFloor)} (click Undo to restore)`);
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
    if (entity.kind === 'room') {
      const rm = project.rooms.find((r) => r.id === entity.id);
      onUpdateProject((prev) => ({
        ...prev,
        rooms: prev.rooms.filter((r) => r.id !== entity.id),
      }));
      if (selectedEntity?.kind === 'room' && selectedEntity.id === entity.id) {
        setSelectedEntity(null);
      }
      notify(`Deleted room "${rm?.name ?? 'Room'}"`);
    } else if (entity.kind === 'wall') {
      onUpdateProject((prev) => ({
        ...prev,
        customWalls: prev.customWalls.filter((w) => w.id !== entity.id),
      }));
      if (selectedEntity?.kind === 'wall' && selectedEntity.id === entity.id) {
        setSelectedEntity(null);
      }
      notify('Deleted custom wall');
    } else if (entity.kind === 'opening') {
      onUpdateProject((prev) => ({
        ...prev,
        openings: prev.openings.filter((o) => o.id !== entity.id),
      }));
      if (selectedEntity?.kind === 'opening' && selectedEntity.id === entity.id) {
        setSelectedEntity(null);
      }
      notify('Deleted door/window');
    } else if (entity.kind === 'point') {
      onUpdateProject((prev) => ({
        ...prev,
        points: prev.points.filter((p) => p.id !== entity.id),
      }));
      if (selectedEntity?.kind === 'point' && selectedEntity.id === entity.id) {
        setSelectedEntity(null);
      }
      notify('Deleted electrical point');
    } else if (entity.kind === 'dimension') {
      onUpdateProject((prev) => ({
        ...prev,
        dimensions: (prev.dimensions ?? []).filter((d) => d.id !== entity.id),
      }));
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
      }
    }
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

  const handleSiteChange = <K extends keyof SiteConfig>(field: K, value: SiteConfig[K]) => {
    onUpdateProject((prev) => ({
      ...prev,
      site: { ...prev.site, [field]: value },
    }));
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
      const result = onImportProject(String(reader.result ?? ''));
      if (result.ok) {
        notify(`Imported project from ${file.name}`);
      } else {
        notify(result.error ?? 'Failed to import project file.', 'warning');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const selectedRoomArea = selectedRoom
    ? formatArea(selectedRoom.width * selectedRoom.height, units)
    : '—';

  return (
    <div className="min-h-screen flex flex-col bg-surface text-on-surface">
      {/* Shared Top Navigation */}
      <Navbar
        activeScreen="studio"
        onNavigate={onNavigate}
        compact={true}
        rightSlot={
          <span className="font-mono text-mono-sm text-on-surface-variant">
            {project.projectType ?? 'Residential'} · {project.refCode}
          </span>
        }
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
                className="absolute left-0 top-full mt-1 w-48 z-40 bg-surface-container border border-outline rounded-md shadow-xl py-1 flex flex-col"
                onMouseLeave={() => setShowExportMenu(false)}
              >
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
                  <span>Download JSON</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    downloadFloorPlanPdf(project, activeFloor);
                    setShowExportMenu(false);
                    notify(`Exported ${project.name} (${formatFloorLabel(activeFloor)}) PDF`);
                  }}
                  className="px-gutter-md py-gutter-xs text-left font-label text-label-sm text-on-surface hover:bg-surface-container-high flex items-center gap-gutter-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-secondary text-[16px]">picture_as_pdf</span>
                  <span>Export Floor Plan (PDF)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    downloadFloorPlanPng(project, activeFloor);
                    setShowExportMenu(false);
                    notify(`Exported ${project.name} (${formatFloorLabel(activeFloor)}) PNG`);
                  }}
                  className="px-gutter-md py-gutter-xs text-left font-label text-label-sm text-on-surface hover:bg-surface-container-high flex items-center gap-gutter-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-primary text-[16px]">image</span>
                  <span>Export Floor Plan (PNG)</span>
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
                  <span>Import Project (.json)</span>
                </button>
              </div>
            )}
            <input
              ref={importInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={handleImportFileChange}
            />
          </div>
        </div>

        {/* Right: Undo/Redo, Zoom/Fit, Grid/Snap, 2D/3D, Project Summary */}
        <div className="flex flex-wrap items-center gap-gutter-xs">
          {/* Undo / Redo */}
          <div className="inline-flex items-center rounded-sm border border-outline-variant bg-surface-container">
            <button
              type="button"
              disabled={!canUndo}
              onClick={() => {
                onUndo();
                notify('Undid last action');
              }}
              title="Undo"
              aria-label="Undo"
              className="px-2 py-1 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high border-r border-outline-variant disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">undo</span>
            </button>
            <button
              type="button"
              disabled={!canRedo}
              onClick={() => {
                onRedo();
                notify('Redid action');
              }}
              title="Redo"
              aria-label="Redo"
              className="px-2 py-1 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">redo</span>
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

          {/* 2D View / 3D Preview Switch */}
          <div className="inline-flex items-center rounded-sm border border-outline bg-surface-container p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('2d')}
              className={`px-gutter-sm py-0.5 rounded-sm font-label text-label-sm transition-colors cursor-pointer whitespace-nowrap ${
                viewMode === '2d'
                  ? 'bg-primary text-on-primary'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              2D View
            </button>
            <button
              type="button"
              onClick={() => {
                setViewMode('3d');
                notify('3D Preview synchronized from 2D floor plan geometry');
              }}
              className={`px-gutter-sm py-0.5 rounded-sm font-label text-label-sm transition-colors cursor-pointer whitespace-nowrap ${
                viewMode === '3d'
                  ? 'bg-primary text-on-primary'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              3D Preview
            </button>
          </div>

          {/* 3D-specific Camera & Lighting controls when in 3D Preview */}
          {viewMode === '3d' && (
            <div className="inline-flex items-center rounded-sm border border-outline-variant bg-surface-container p-0.5 gap-0.5">
              <button
                type="button"
                onClick={() => setCameraMode('orbit')}
                className={`px-2 py-0.5 rounded-sm font-label text-label-sm cursor-pointer ${
                  cameraMode === 'orbit' ? 'bg-surface-container-high text-primary' : 'text-on-surface-variant'
                }`}
              >
                Orbit
              </button>
              <button
                type="button"
                onClick={() => {
                  setCameraMode('fps');
                  notify(`First-Person walkthrough on ${formatFloorLabel(activeFloor)} — use WASD keys & drag to look`);
                }}
                className={`px-2 py-0.5 rounded-sm font-label text-label-sm cursor-pointer ${
                  cameraMode === 'fps' ? 'bg-surface-container-high text-primary' : 'text-on-surface-variant'
                }`}
              >
                Walk
              </button>
              <button
                type="button"
                onClick={() => setLightingMode((l) => (l === 'daylight' ? 'evening' : 'daylight'))}
                title="Toggle Daylight / Evening Lighting"
                className="px-1.5 py-0.5 rounded-sm text-secondary hover:bg-surface-container-high cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px]">
                  {lightingMode === 'daylight' ? 'light_mode' : 'dark_mode'}
                </span>
              </button>
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

          {/* Project Summary */}
          <button
            type="button"
            onClick={() => onNavigate('summary')}
            className="inline-flex items-center gap-1 px-gutter-md py-1 rounded-sm bg-secondary text-on-secondary font-label text-label-sm hover:bg-on-secondary-container cursor-pointer whitespace-nowrap"
          >
            <span className="material-symbols-outlined text-[15px]" aria-hidden="true">summarize</span>
            <span>Project Summary</span>
          </button>
        </div>
      </div>

      {/* MAIN CAD WORKSPACE (Canvas extended to occupy left area + Right Properties Inspector) */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_292px] min-h-0">
        {/* PRIMARY WORKSPACE: A. Drawing Tools + B/C/D Drawers + Floor Strip + Extended 2D/3D Canvas */}
        <main className="min-w-0 bg-surface cad-grid relative flex flex-col p-gutter-sm gap-gutter-xs min-h-[520px] lg:max-h-[calc(100vh-146px)]">
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
                      min={5}
                      value={project.site.length}
                      onChange={(e) => handleSiteChange('length', Math.max(5, Number(e.target.value) || 10))}
                      className="w-full bg-surface border border-outline rounded-sm px-2 py-1 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="font-label text-[11px] text-on-surface-variant">Width ({unitShort})</span>
                    <input
                      type="number"
                      step="0.5"
                      min={5}
                      value={project.site.width}
                      onChange={(e) => handleSiteChange('width', Math.max(5, Number(e.target.value) || 10))}
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
                      onChange={(e) => handleSiteChange('ceilingHeight', Math.max(2, Number(e.target.value) || 10))}
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
                      max={5}
                      value={project.site.floors}
                      onChange={(e) => handleSiteChange('floors', Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
                      className="w-full bg-surface border border-outline rounded-sm px-2 py-1 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                    />
                  </label>
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
                <div className="absolute left-0 top-full mt-1 w-64 max-h-80 overflow-y-auto z-40 bg-surface-container border border-outline rounded-md shadow-2xl p-gutter-xs flex flex-col gap-1">
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
                        {item.defaultWattage}W
                      </span>
                    </button>
                  ))}
                </div>
              </details>
            </div>

            {/* Active Tool & Live Status Pill */}
            <div
              className={`inline-flex items-center gap-gutter-xs px-gutter-sm py-1 rounded-sm border font-mono text-mono-sm truncate max-w-full ${
                statusMessage.tone === 'warning'
                  ? 'bg-secondary-container/75 border-secondary text-on-secondary-container'
                  : 'bg-surface-container border-outline-variant text-primary'
              }`}
            >
              {statusMessage.tone === 'warning' && (
                <span className="material-symbols-outlined text-secondary text-[15px] shrink-0">warning</span>
              )}
              <span className="truncate">{statusMessage.text}</span>
            </div>
          </div>

          {/* Multi-Floor Level Switcher Strip (1st Floor, 2nd Floor, 3rd Floor + Elevated) */}
          <div className="flex flex-wrap items-center justify-between gap-gutter-xs px-gutter-sm py-1 rounded-md bg-surface-container border border-outline-variant z-20">
            <div className="flex flex-wrap items-center gap-1">
              <span className="inline-flex items-center gap-1 pr-1.5 font-mono text-[11px] text-on-surface-variant uppercase">
                <span className="material-symbols-outlined text-primary text-[15px]" aria-hidden="true">
                  layers
                </span>
                <span>Floors ({totalFloors}):</span>
              </span>
              {Array.from({ length: totalFloors }, (_, idx) => idx + 1).map((fl) => {
                const isElevatedActive = viewMode === '3d' && floorView3D === 'all' && totalFloors > 1;
                const isActive = fl === activeFloor && !isElevatedActive;
                return (
                  <button
                    key={fl}
                    type="button"
                    onClick={() => handleSwitchFloor(fl)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm border font-label text-label-sm transition-colors cursor-pointer whitespace-nowrap ${
                      isActive
                        ? 'bg-primary text-on-primary border-primary'
                        : 'bg-surface-container-low text-on-surface-variant border-outline-variant hover:border-primary hover:text-on-surface'
                    }`}
                  >
                    <span>{formatFloorLabel(fl)}</span>
                  </button>
                );
              })}

              {totalFloors > 1 && (
                <button
                  type="button"
                  onClick={handleToggleElevatedView}
                  title={`Show all ${totalFloors} floors stacked together in Elevated 3D view`}
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
              )}

              {totalFloors < 5 && (
                <button
                  type="button"
                  onClick={() => {
                    const nextFloors = Math.min(5, totalFloors + 1);
                    handleSiteChange('floors', nextFloors);
                    setActiveFloor(nextFloors);
                    setFloorView3D('active-only');
                    setSelectedEntity(null);
                    setAllSelected(false);
                    notify(
                      `Added ${formatFloorLabel(nextFloors)} — click Elevated to view all ${nextFloors} floors stacked`
                    );
                  }}
                  title="Add an elevated floor (up to 5 floors)"
                  className="inline-flex items-center gap-0.5 px-2 py-1 rounded-sm border border-dashed border-outline text-on-surface-variant hover:text-primary hover:border-primary font-label text-label-sm cursor-pointer whitespace-nowrap"
                >
                  <span className="material-symbols-outlined text-[14px]" aria-hidden="true">add</span>
                  <span>Floor</span>
                </button>
              )}
            </div>

            <div className="flex items-center gap-gutter-xs">
              {activeFloor > 1 && !(viewMode === '3d' && floorView3D === 'all') && (
                <button
                  type="button"
                  onClick={handleCopyFloorBelow}
                  title={`Copy layout from ${formatFloorLabel(activeFloor - 1)} to ${formatFloorLabel(activeFloor)}`}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-sm bg-surface-container-high border border-outline text-primary hover:border-primary font-label text-label-sm cursor-pointer whitespace-nowrap"
                >
                  <span className="material-symbols-outlined text-[14px]" aria-hidden="true">content_copy</span>
                  <span>Copy {formatFloorLabel(activeFloor - 1)}</span>
                </button>
              )}
              <span className="font-mono text-[11px] text-on-surface-variant hidden sm:inline">
                {viewMode === '3d' && floorView3D === 'all' && totalFloors > 1
                  ? `Elevated · All ${totalFloors} Floors`
                  : activeFloor === 1
                    ? 'Ground Level (0)'
                    : `Elev. +${formatLength((activeFloor - 1) * siteToMeters(project.site).ceilingM, units, 1)}`}
              </span>
            </div>
          </div>

          {/* Primary Canvas Frame */}
          <div
            className="relative flex-1 min-h-[420px] rounded-lg border border-outline bg-surface-container-low overflow-hidden"
            onPointerDown={() => {
              if (openDrawer) setOpenDrawer(null);
            }}
          >
            {viewMode === '2d' ? (
              <FloorPlan2D
                project={project}
                activeFloor={activeFloor}
                selectedEntity={selectedEntity}
                allSelected={allSelected}
                activeTool={activeTool}
                pendingPlaceItem={pendingPlaceItem}
                showGrid={showGrid}
                snapEnabled={snapEnabled}
                zoom={zoom}
                panOffset={panOffset}
                onPanChange={setPanOffset}
                onZoomChange={setZoom}
                onSelectEntity={(ent) => {
                  setSelectedEntity(ent);
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
                onDuplicatePoint={handleDuplicatePoint}
                onDuplicateRoom={handleDuplicateRoomFree}
                onDuplicateOpening={handleDuplicateOpening}
                onDuplicateWall={handleDuplicateWall}
                onPlacePointAt={handlePlacePointAt}
                onValidationWarning={(msg) => notify(msg, 'warning')}
              />
            ) : (
              <Viewport3D
                project={project}
                activeFloor={activeFloor}
                floorViewMode={floorView3D}
                selectedPointId={selectedPoint?.id ?? null}
                cameraMode={cameraMode}
                lightingMode={lightingMode}
                zoom={zoom}
                pendingPlaceItem={pendingPlaceItem}
                onSelectPoint={(pid) => setSelectedEntity({ kind: 'point', id: pid })}
                onPlacePointAt={handlePlacePointAt}
                onDuplicatePoint={handleDuplicatePoint}
                onMovePoint={handleMovePoint}
                onDuplicateFurniture={handleDuplicateFurniture}
                onMoveFurniture={handleMoveFurniture}
              />
            )}
          </div>
        </main>

        {/* RIGHT SIDEBAR: Context-Sensitive Properties Inspector */}
        <aside className="bg-surface-container border-t lg:border-t-0 lg:border-l border-outline-variant p-gutter-md flex flex-col gap-gutter-md overflow-y-auto lg:max-h-[calc(100vh-146px)]">
          <div className="flex items-center justify-between border-b border-outline-variant pb-gutter-sm">
            <span className="font-label text-label-sm text-on-surface-variant uppercase tracking-wider">
              Properties Inspector
            </span>
            <span className="px-2 py-0.5 rounded-full bg-primary-container text-primary font-mono text-[11px] uppercase">
              {allSelected
                ? 'ALL SELECTED'
                : selectedRoom
                  ? 'ROOM'
                  : selectedWall
                    ? 'WALL'
                    : selectedOpening
                      ? selectedOpening.kind
                      : selectedPoint
                        ? 'ELECTRICAL'
                        : 'SITE'}
            </span>
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
                  Drag inside the 2D canvas to move all items together, or use Pan to move the entire model freely in the viewport.
                </span>
                <div className="grid grid-cols-2 gap-1 pt-1 font-mono text-mono-sm text-on-surface">
                  <span>Rooms: {project.rooms.length}</span>
                  <span>Walls: {project.customWalls.length}</span>
                  <span>Openings: {project.openings.length}</span>
                  <span>Points: {project.points.length}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setAllSelected(false)}
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

          {/* 1. ROOM INSPECTOR (PHASE 5) */}
          {selectedRoom && (
            <div className="flex flex-col gap-gutter-sm">
              <label className="flex flex-col gap-1">
                <span className="font-label text-label-sm text-on-surface-variant">Room Name</span>
                <input
                  type="text"
                  value={selectedRoom.name}
                  onChange={(e) => handleUpdateRoom(selectedRoom.id, { name: e.target.value }, false)}
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

          {/* 4. ELECTRICAL POINT INSPECTOR (Preserved) */}
          {selectedPoint && (
            <div className="flex flex-col gap-gutter-sm">
              <label className="flex flex-col gap-1">
                <span className="font-label text-label-sm text-on-surface-variant">Component Name</span>
                <input
                  type="text"
                  value={selectedPoint.name}
                  onChange={(e) => handleUpdateSelectedPoint({ name: e.target.value })}
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
                    onChange={(e) => handleUpdateSelectedPoint({ x: Number(e.target.value) || 0 })}
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-mono text-mono-sm text-on-surface tabular-nums"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-label text-[11px] text-on-surface-variant">Y (m)</span>
                  <input
                    type="number"
                    step="0.1"
                    value={selectedPoint.y}
                    onChange={(e) => handleUpdateSelectedPoint({ y: Number(e.target.value) || 0 })}
                    className="w-full bg-surface-container-low border border-outline rounded-sm px-1.5 py-1 font-mono text-mono-sm text-on-surface tabular-nums"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-label text-[11px] text-on-surface-variant">Z (m)</span>
                  <input
                    type="number"
                    step="0.05"
                    value={selectedPoint.z}
                    onChange={(e) => handleUpdateSelectedPoint({ z: Number(e.target.value) || 0.4 })}
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

          {/* 5. DEFAULT SITE OVERVIEW WHEN NOTHING IS SELECTED */}
          {!allSelected && !selectedRoom && !selectedWall && !selectedOpening && !selectedPoint && (
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
    </div>
  );
};
