import React, { useMemo, useRef, useState } from 'react';
import { CATALOG_MAP, findRoomAtPoint, FT_TO_M, siteToMeters } from '../data/presets';
import {
  ArchitecturalOpening,
  CanvasTool,
  CircuitId,
  ElectricalItemType,
  ElectricalPoint,
  ProjectData,
  RoomZone,
  SelectedEntity,
} from '../types/design';
import {
  extractMergedWalls,
  findNearestWallAttachment,
  formatArea,
  formatFloorLabel,
  formatLength,
  isPointInsideRoom,
  sliceProjectForFloor,
  snapCoordinate,
  snapCoordinateFree,
  validateRoomPlacement,
} from '../utils/geometry';

interface FloorPlan2DProps {
  project: ProjectData;
  activeFloor?: number;
  selectedEntity?: SelectedEntity;
  selectedPointId?: string | null;
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
  onSelectEntity?: (entity: SelectedEntity) => void;
  onSelectPoint?: (pointId: string) => void;
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
  onDuplicatePoint?: (pointId: string) => ElectricalPoint | null;
  onDuplicateRoom?: (roomId: string) => RoomZone | null;
  onDuplicateOpening?: (openingId: string) => ArchitecturalOpening | null;
  onDuplicateWall?: (wallId: string) => void;
  onPlacePointAt?: (itemType: ElectricalItemType, x: number, y: number, roomId: string) => void;
  onValidationWarning?: (message: string) => void;
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
  selectedPointId = null,
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
  onDuplicatePoint,
  onDuplicateRoom,
  onDuplicateOpening,
  onDuplicateWall,
  onPlacePointAt,
  onValidationWarning,
}) => {
  const project = useMemo(
    () => sliceProjectForFloor(fullProject, activeFloor),
    [fullProject, activeFloor]
  );
  const underlayRooms = useMemo(
    () => (activeFloor > 1 ? sliceProjectForFloor(fullProject, activeFloor - 1).rooms : []),
    [fullProject, activeFloor]
  );

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [draggingPoint, setDraggingPoint] = useState<{
    id: string;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const [draggingOpening, setDraggingOpening] = useState<{
    id: string;
    startX: number;
    startY: number;
    moved: boolean;
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

  const { lengthM, widthM, ceilingM } = useMemo(() => siteToMeters(project.site), [project.site]);
  const mergedWalls = useMemo(() => extractMergedWalls(project), [project]);
  const units = project.site.units;

  // Dynamic scale so very large plots (e.g., 100ft) and compact plots (20ft) both look crisp
  const maxDim = Math.max(lengthM, widthM, 4);
  const SCALE = Math.max(18, Math.min(52, 540 / maxDim));
  const PAD = previewOnly ? 22 : 64;
  const planW = lengthM * SCALE;
  const planH = widthM * SCALE;
  const vbW = planW + PAD * 2;
  const vbH = planH + PAD * 2;

  // Architectural grid step in SVG units (1 ft or 0.5 m minor; 5 ft or 2 m major)
  const minorGridM = units === 'ft' ? FT_TO_M : 0.5;
  const majorGridM = units === 'ft' ? 5 * FT_TO_M : 2;
  const minorStepPx = minorGridM * SCALE;
  const majorStepPx = majorGridM * SCALE;

  const activePointId =
    selectedEntity?.kind === 'point' ? selectedEntity.id : selectedPointId;
  const selectedRoomId =
    selectedEntity?.kind === 'room' ? selectedEntity.id : null;
  const selectedWallId =
    selectedEntity?.kind === 'wall' ? selectedEntity.id : null;
  const selectedOpeningId =
    selectedEntity?.kind === 'opening' ? selectedEntity.id : null;

  const clientToRawMeters = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0, inside: false };
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0, inside: false };

    // Account for preserveAspectRatio="xMidYMid meet"
    const scaleX = rect.width / vbW;
    const scaleY = rect.height / vbH;
    const fitScale = Math.min(scaleX, scaleY);
    const renderedW = vbW * fitScale;
    const renderedH = vbH * fitScale;
    const offsetX = rect.left + (rect.width - renderedW) / 2;
    const offsetY = rect.top + (rect.height - renderedH) / 2;

    const svgX = (clientX - offsetX) / fitScale;
    const svgY = (clientY - offsetY) / fitScale;

    const zoomFactor = zoom / 100;
    const cx = vbW / 2;
    const cy = vbH / 2;
    const unscaledX = (svgX - cx - panOffset.x) / zoomFactor + cx;
    const unscaledY = (svgY - cy - panOffset.y) / zoomFactor + cy;

    const mx = (unscaledX - PAD) / SCALE;
    const my = (unscaledY - PAD) / SCALE;
    const inside = mx >= 0 && mx <= lengthM && my >= 0 && my <= widthM;
    return { x: mx, y: my, inside };
  };

  // Group electrical points by circuit for dashed schematic overlay
  const circuitPaths = useMemo(() => {
    const groups = new Map<CircuitId, ElectricalPoint[]>();
    project.points.forEach((pt) => {
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
    onZoomChange(Math.max(40, Math.min(250, zoom + delta)));
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

    // Click on empty area inside site boundary -> Phase 4 Click-to-Create Room Modal!
    if ((activeTool === 'select' || activeTool === 'add-room') && raw.inside) {
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

    // Dragging an electrical point freely
    if (draggingPoint && onMovePoint) {
      const dist = Math.hypot(raw.x - draggingPoint.startX, raw.y - draggingPoint.startY);
      if (!draggingPoint.moved && dist < 0.06) return;
      if (!draggingPoint.moved) {
        setDraggingPoint((prev) => (prev ? { ...prev, moved: true } : null));
      }
      const snapped = snapCoordinateFree(raw.x, raw.y, project, snapEnabled);
      const room = findRoomAtPoint(project.rooms, snapped.x, snapped.y) ?? project.rooms[0];
      onMovePoint(draggingPoint.id, snapped.x, snapped.y, room?.id ?? '');
      return;
    }

    // Dragging a door/window opening freely
    if (draggingOpening && onMoveOpening) {
      const dist = Math.hypot(raw.x - draggingOpening.startX, raw.y - draggingOpening.startY);
      if (!draggingOpening.moved && dist < 0.06) return;
      if (!draggingOpening.moved) {
        setDraggingOpening((prev) => (prev ? { ...prev, moved: true } : null));
      }
      const snapped = snapCoordinateFree(raw.x, raw.y, project, snapEnabled);
      onMoveOpening(draggingOpening.id, snapped.x, snapped.y);
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
      activeTool === 'dimension' ||
      activeTool === 'add-door' ||
      activeTool === 'add-window' ||
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

    onClearAllSelection?.();
    onSelectEntity?.({ kind: 'room', id: room.id });

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
        activeTool === 'add-room' ||
        activeTool === 'add-door' ||
        activeTool === 'add-window' ||
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

  return (
    <div
      className={`w-full h-full flex items-center justify-center bg-surface select-none overflow-hidden ${
        previewOnly ? 'p-1.5' : 'p-gutter-sm'
      }`}
    >
      <svg
        ref={svgRef}
        tabIndex={previewOnly ? undefined : 0}
        viewBox={`0 0 ${vbW} ${vbH}`}
        className={`w-full h-full max-h-full overflow-visible touch-none outline-none ${cursorClass}`}
        onWheel={handleWheel}
        onPointerDown={handleSvgPointerDown}
        onPointerMove={handleSvgPointerMove}
        onPointerUp={handleSvgPointerUp}
        onPointerCancel={handleSvgPointerUp}
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
        </defs>

        <g
          transform={`translate(${vbW / 2 + panOffset.x} ${vbH / 2 + panOffset.y}) scale(${zoom / 100}) translate(${-vbW / 2} ${-vbH / 2})`}
        >
          {/* Site Interior Floor Slab */}
          <rect
            x={PAD}
            y={PAD}
            width={planW}
            height={planH}
            fill={showGrid ? `url(#major-grid-${project.id})` : '#0B1325'}
          />

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

          {/* Blank Site Guidance Prompt when no rooms exist yet on this floor */}
          {!previewOnly && project.rooms.length === 0 && (
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
                  ? `${formatFloorLabel(activeFloor)} is ready — click inside to add rooms or click Copy Below`
                  : 'Click anywhere inside the site boundary to create a room'}
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

          {/* Room Zones */}
          {project.rooms.map((room) => {
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

            const isSingleSelected = !previewOnly && !allSelected && selectedRoomId === room.id;
            const isSelected = !previewOnly && (selectedRoomId === room.id || allSelected);
            const isInvalidDraft =
              (isBeingDragged && !roomDrag.valid) || (!!groupDrag && !groupDrag.valid);
            const dimText = `${formatLength(dispW, units, 1)} × ${formatLength(dispH, units, 1)}`;
            const areaText = formatArea(dispW * dispH, units);
            const showExtraLines = !previewOnly && rw > 62 && rh > 42;

            return (
              <g
                key={room.id}
                onPointerDown={(e) => startRoomInteraction(e, room, 'move')}
                className={
                  previewOnly
                    ? ''
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
                <rect
                  x={rx}
                  y={ry}
                  width={rw}
                  height={rh}
                  fill={
                    isInvalidDraft
                      ? 'rgba(255, 157, 0, 0.18)'
                      : isSelected
                        ? 'rgba(0, 168, 255, 0.16)'
                        : ROOM_FILLS[room.floorFinish] ?? 'rgba(0,168,255,0.06)'
                  }
                  stroke={
                    isInvalidDraft
                      ? '#FF9D00'
                      : isSelected
                        ? '#00A8FF'
                        : '#334C73'
                  }
                  strokeWidth={isSelected || isInvalidDraft ? 2.5 : 1.5}
                  strokeDasharray={isInvalidDraft ? '6,4' : undefined}
                />

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

          {/* Subtle Furniture Outlines (for preloaded apartments) */}
          {project.furniture.map((f) => {
            const fx = PAD + (f.x - f.width / 2) * SCALE;
            const fy = PAD + (f.y - f.depth / 2) * SCALE;
            return (
              <rect
                key={f.id}
                x={fx}
                y={fy}
                width={f.width * SCALE}
                height={f.depth * SCALE}
                rx="3"
                fill="rgba(197, 205, 216, 0.05)"
                stroke="#2C3E5E"
                strokeWidth="1"
                strokeDasharray="2,2"
                pointerEvents="none"
              />
            );
          })}

          {/* Canonical Merged Architectural Walls (Perimeter + Deduplicated Shared Room Walls + Custom Walls) */}
          {mergedWalls.map((seg) => {
            const isInteriorSeg = seg.source !== 'perimeter';
            const gdx = isInteriorSeg && groupDrag ? groupDrag.dx : 0;
            const gdy = isInteriorSeg && groupDrag ? groupDrag.dy : 0;
            const x1 = PAD + (seg.x1 + gdx) * SCALE;
            const y1 = PAD + (seg.y1 + gdy) * SCALE;
            const x2 = PAD + (seg.x2 + gdx) * SCALE;
            const y2 = PAD + (seg.y2 + gdy) * SCALE;
            const isCustom = seg.source === 'custom' && !!seg.customWallId;
            const isSelectedWall =
              (isCustom && (selectedWallId === seg.customWallId || allSelected)) ||
              (allSelected && !previewOnly && seg.source === 'room');
            const strokeW = Math.max(
              previewOnly ? 2 : 3,
              Math.min(previewOnly ? 5.5 : 8.5, seg.thickness * SCALE)
            );

            return (
              <g key={seg.id}>
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={
                    isSelectedWall
                      ? '#00A8FF'
                      : seg.isExterior
                        ? '#F5F7FA'
                        : '#CBD5E1'
                  }
                  strokeWidth={strokeW}
                  strokeLinecap="square"
                  pointerEvents="none"
                />
                {/* Interactive hit area for custom walls so user can select/edit/delete them */}
                {isCustom && !previewOnly && (
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
                      if (activeTool === 'erase') {
                        onEraseEntity?.({ kind: 'wall', id: seg.customWallId! });
                      } else if ((e.ctrlKey || e.metaKey) && e.button === 0 && onDuplicateWall) {
                        e.preventDefault();
                        onClearAllSelection?.();
                        onDuplicateWall(seg.customWallId!);
                      } else {
                        onClearAllSelection?.();
                        onSelectEntity?.({ kind: 'wall', id: seg.customWallId! });
                      }
                    }}
                  />
                )}
                {isSelectedWall && (
                  <>
                    <circle cx={x1} cy={y1} r="4.5" fill="#00A8FF" stroke="#080F20" strokeWidth="1.5" />
                    <circle cx={x2} cy={y2} r="4.5" fill="#00A8FF" stroke="#080F20" strokeWidth="1.5" />
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
          {project.openings.map((op) => {
            const ox = PAD + (op.x + (groupDrag ? groupDrag.dx : 0)) * SCALE;
            const oy = PAD + (op.y + (groupDrag ? groupDrag.dy : 0)) * SCALE;
            const ow = op.width * SCALE;
            const isSelectedOp = !previewOnly && (selectedOpeningId === op.id || allSelected);

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
                    onSelectEntity?.({ kind: 'opening', id: op.id });
                    onRotateEntity?.({ kind: 'opening', id: op.id });
                  } else if ((e.ctrlKey || e.metaKey) && e.button === 0 && onDuplicateOpening) {
                    e.preventDefault();
                    onClearAllSelection?.();
                    const dup = onDuplicateOpening(op.id);
                    if (dup) {
                      const raw = clientToRawMeters(e.clientX, e.clientY);
                      setDraggingOpening({ id: dup.id, startX: raw.x, startY: raw.y, moved: false });
                    }
                  } else {
                    onClearAllSelection?.();
                    onSelectEntity?.({ kind: 'opening', id: op.id });
                    if (activeTool === 'select' || activeTool === 'move') {
                      const raw = clientToRawMeters(e.clientX, e.clientY);
                      setDraggingOpening({ id: op.id, startX: raw.x, startY: raw.y, moved: false });
                    }
                  }
                }}
              >
                {/* Invisible generous hit box */}
                <rect x={-ow / 2 - 4} y={-10} width={ow + 8} height={20} fill="transparent" />
                {op.kind === 'window' ? (
                  <>
                    <line x1={-ow / 2} y1={0} x2={ow / 2} y2={0} stroke="#080F20" strokeWidth="7" />
                    <line x1={-ow / 2} y1={-2.5} x2={ow / 2} y2={-2.5} stroke={isSelectedOp ? '#FF9D00' : '#00A8FF'} strokeWidth="2" />
                    <line x1={-ow / 2} y1={2.5} x2={ow / 2} y2={2.5} stroke={isSelectedOp ? '#FF9D00' : '#00A8FF'} strokeWidth="2" />
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
                {isSelectedOp && (
                  <rect
                    x={-ow / 2 - 4}
                    y={-8}
                    width={ow + 8}
                    height={16}
                    fill="none"
                    stroke="#00A8FF"
                    strokeWidth="1.2"
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
          {!previewOnly &&
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

          {/* Electrical Circuit Bus Wiring Overlay */}
          {circuitPaths.map((c) => (
            <path
              key={c.circuit}
              d={c.d}
              fill="none"
              stroke={c.color}
              strokeWidth={previewOnly ? 1.1 : 1.3}
              strokeOpacity="0.4"
              strokeDasharray="5,4"
              pointerEvents="none"
            />
          ))}

          {/* Electrical Points */}
          {project.points.map((pt) => {
            const px = PAD + (pt.x + (groupDrag ? groupDrag.dx : 0)) * SCALE;
            const py = PAD + (pt.y + (groupDrag ? groupDrag.dy : 0)) * SCALE;
            const isSelected = (pt.id === activePointId || allSelected) && !previewOnly;
            const isHighPower = pt.category === 'Appliances' || pt.itemType === 'socket_16a';
            const fill = isSelected ? '#00A8FF' : isHighPower ? '#FF9D00' : '#0D1528';
            const stroke = isSelected ? '#F5F7FA' : isHighPower ? '#FFE2B3' : '#00A8FF';
            const radius = previewOnly ? 4 : isSelected ? 9 : 6.5;

            return (
              <g
                key={pt.id}
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
                  if (activeTool === 'erase') {
                    onEraseEntity?.({ kind: 'point', id: pt.id });
                    return;
                  }
                  // Ctrl + Left Click on any electrical point (fan, light, switch, socket, AC, etc.) -> Duplicate & position freely!
                  if ((e.ctrlKey || e.metaKey) && e.button === 0 && onDuplicatePoint) {
                    e.preventDefault();
                    onClearAllSelection?.();
                    const dup = onDuplicatePoint(pt.id);
                    if (dup) {
                      const raw = clientToRawMeters(e.clientX, e.clientY);
                      setDraggingPoint({ id: dup.id, startX: raw.x, startY: raw.y, moved: false });
                    }
                    return;
                  }
                  onClearAllSelection?.();
                  onSelectEntity?.({ kind: 'point', id: pt.id });
                  onSelectPoint?.(pt.id);
                  if (activeTool === 'select' || activeTool === 'move') {
                    const raw = clientToRawMeters(e.clientX, e.clientY);
                    setDraggingPoint({ id: pt.id, startX: raw.x, startY: raw.y, moved: false });
                  }
                }}
              >
                {isSelected && (
                  <circle r="14" fill="none" stroke="#00A8FF" strokeWidth="1.5" strokeDasharray="3,2" />
                )}
                <circle r={radius} fill={fill} stroke={stroke} strokeWidth={isSelected ? 2 : 1.5} />
                {!previewOnly && (
                  <text
                    y={-11}
                    textAnchor="middle"
                    fill={isSelected ? '#FFFFFF' : isHighPower ? '#FFE2B3' : '#C5CDD8'}
                    fontFamily="Red Hat Mono, monospace"
                    fontSize={isSelected ? '9.5' : '8.5'}
                    fontWeight={isSelected ? '700' : '500'}
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
      </svg>
    </div>
  );
};
