import React, { useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Crop,
  DoorOpen,
  Eye,
  EyeOff,
  HelpCircle,
  Layers,
  Lock,
  MousePointer2,
  Plus,
  Ruler,
  Square,
  Trash2,
  Unlock,
  XCircle,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  CalibrationConfig,
  DetectionStatus,
  DrawingLayerId,
  DrawingLayerState,
  IntermediateDrawingModel,
  NormalizedPoint,
  NormalizedRect,
  SymbolMappingDefinition,
  UploadedDrawingSource,
} from '../../types/aiDrawing';
import { RoomType } from '../../types/design';
import { clamp01, round2 } from '../../utils/aiDrawingConverter';

export type ReviewCanvasMode =
  | 'select'
  | 'calibrate'
  | 'crop-legend'
  | 'add-wall'
  | 'add-room'
  | 'add-door'
  | 'add-window'
  | 'add-symbol';

type SelectedReviewEntity =
  | { kind: 'wall'; id: string }
  | { kind: 'room'; id: string }
  | { kind: 'opening'; id: string }
  | { kind: 'column'; id: string }
  | { kind: 'staircase'; id: string }
  | { kind: 'furniture'; id: string }
  | { kind: 'symbol'; id: string }
  | { kind: 'wiring'; id: string }
  | { kind: 'dimension'; id: string }
  | { kind: 'label'; id: string }
  | null;

interface DrawingReviewCanvasProps {
  source: UploadedDrawingSource;
  model: IntermediateDrawingModel;
  calibration: CalibrationConfig;
  symbolMappings: SymbolMappingDefinition[];
  layers: DrawingLayerState[];
  mode: ReviewCanvasMode;
  onChangeMode: (mode: ReviewCanvasMode) => void;
  onChangeModel: (next: IntermediateDrawingModel) => void;
  onChangeLayers: (next: DrawingLayerState[]) => void;
  onCalibrationPairPicked?: (pointA: NormalizedPoint, pointB: NormalizedPoint) => void;
  onLegendCropRectPicked?: (rect: NormalizedRect) => void;
  showInspector?: boolean;
}

const STATUS_COLORS: Record<DetectionStatus, string> = {
  approved: '#10b981',
  uncertain: '#f59e0b',
  rejected: '#64748b',
};

const ROOM_TYPE_OPTIONS: RoomType[] = [
  'living',
  'hall',
  'kitchen',
  'master-bedroom',
  'bedroom',
  'bathroom',
  'dining',
  'study',
  'balcony',
  'utility',
  'store',
  'pooja',
  'custom',
];

export const DrawingReviewCanvas: React.FC<DrawingReviewCanvasProps> = ({
  source,
  model,
  calibration,
  symbolMappings,
  layers,
  mode,
  onChangeMode,
  onChangeModel,
  onChangeLayers,
  onCalibrationPairPicked,
  onLegendCropRectPicked,
  showInspector = true,
}) => {
  const [zoom, setZoom] = useState(1);
  const [imageOpacity, setImageOpacity] = useState(0.75);
  const [showCadOverlay, setShowCadOverlay] = useState(true);
  const [selected, setSelected] = useState<SelectedReviewEntity>(null);
  const [showRejected, setShowRejected] = useState(false);
  const [activeSymbolMappingId, setActiveSymbolMappingId] = useState<string>(
    symbolMappings.find((s) => s.enabled)?.id ?? ''
  );

  // Interactive gesture states
  const [calPointA, setCalPointA] = useState<NormalizedPoint | null>(calibration.pointA ?? null);
  const [draftWallStart, setDraftWallStart] = useState<NormalizedPoint | null>(null);
  const [dragBoxStart, setDragBoxStart] = useState<NormalizedPoint | null>(null);
  const [dragBoxCurrent, setDragBoxCurrent] = useState<NormalizedPoint | null>(null);
  const [draggingEntity, setDraggingEntity] = useState<
    | { kind: 'opening' | 'symbol' | 'room' | 'label' | 'furniture'; id: string; offsetX: number; offsetY: number }
    | { kind: 'wall-p1' | 'wall-p2'; id: string }
    | null
  >(null);

  const svgRef = useRef<SVGSVGElement | null>(null);

  const layerMap = useMemo(() => {
    const map = new Map<DrawingLayerId, DrawingLayerState>();
    for (const l of layers) map.set(l.id, l);
    return map;
  }, [layers]);

  const isVisible = (id: DrawingLayerId) => layerMap.get(id)?.visible !== false;
  const isLocked = (id: DrawingLayerId) => layerMap.get(id)?.locked === true;

  const getNormCoords = (e: React.PointerEvent<SVGSVGElement>): NormalizedPoint => {
    const svg = svgRef.current;
    if (!svg) return { x: 0.5, y: 0.5 };
    const rect = svg.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / Math.max(1, rect.width)),
      y: clamp01((e.clientY - rect.top) / Math.max(1, rect.height)),
    };
  };

  const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const pt = getNormCoords(e);

    if (mode === 'calibrate') {
      if (!calPointA) {
        setCalPointA(pt);
      } else {
        onCalibrationPairPicked?.(calPointA, pt);
        setCalPointA(null);
      }
      return;
    }

    if (mode === 'crop-legend' || mode === 'add-room') {
      setDragBoxStart(pt);
      setDragBoxCurrent(pt);
      return;
    }

    if (mode === 'add-wall') {
      if (!draftWallStart) {
        setDraftWallStart(pt);
      } else {
        if (Math.hypot(pt.x - draftWallStart.x, pt.y - draftWallStart.y) >= 0.01) {
          const newWall = {
            id: `man-wall-${Date.now()}`,
            x1: draftWallStart.x,
            y1: draftWallStart.y,
            x2: pt.x,
            y2: pt.y,
            wallKind: 'internal' as const,
            confidence: 1,
            status: 'approved' as const,
            source: 'manual' as const,
          };
          onChangeModel({ ...model, walls: [...model.walls, newWall] });
          setSelected({ kind: 'wall', id: newWall.id });
        }
        setDraftWallStart(null);
      }
      return;
    }

    if (mode === 'add-door' || mode === 'add-window') {
      const newOpening = {
        id: `man-open-${Date.now()}`,
        kind: mode === 'add-door' ? ('door' as const) : ('window' as const),
        x: pt.x,
        y: pt.y,
        widthNorm: 0.06,
        rotationDeg: 0,
        confidence: 1,
        status: 'approved' as const,
        source: 'manual' as const,
      };
      onChangeModel({ ...model, openings: [...model.openings, newOpening] });
      setSelected({ kind: 'opening', id: newOpening.id });
      return;
    }

    if (mode === 'add-symbol') {
      const mapping =
        symbolMappings.find((s) => s.id === activeSymbolMappingId) ??
        symbolMappings.find((s) => s.enabled);
      const newSymbol = {
        id: `man-sym-${Date.now()}`,
        symbolMappingId: mapping?.id ?? null,
        symbolName: mapping?.name ?? 'Custom Symbol',
        symbolCode: mapping?.code ?? 'SYM',
        domain: mapping?.domain ?? ('custom' as const),
        electricalItemType: mapping?.electricalItemType,
        electricalCategory: mapping?.electricalCategory,
        x: pt.x,
        y: pt.y,
        rotationDeg: 0,
        confidence: 1,
        status: 'approved' as const,
        source: 'manual' as const,
        matchedByUserLegend: Boolean(mapping),
      };
      onChangeModel({ ...model, symbols: [...model.symbols, newSymbol] });
      setSelected({ kind: 'symbol', id: newSymbol.id });
      return;
    }

    if (mode === 'select' && e.target === svgRef.current) {
      setSelected(null);
    }
  };

  const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const pt = getNormCoords(e);
    if (dragBoxStart) {
      setDragBoxCurrent(pt);
      return;
    }

    if (draggingEntity && mode === 'select') {
      if ((draggingEntity.kind === 'wall-p1' || draggingEntity.kind === 'wall-p2') && !isLocked('walls')) {
        onChangeModel({
          ...model,
          walls: model.walls.map((w) =>
            w.id === draggingEntity.id
              ? draggingEntity.kind === 'wall-p1'
                ? { ...w, x1: clamp01(pt.x), y1: clamp01(pt.y) }
                : { ...w, x2: clamp01(pt.x), y2: clamp01(pt.y) }
              : w
          ),
        });
      } else if (draggingEntity.kind === 'opening' && !isLocked('openings')) {
        onChangeModel({
          ...model,
          openings: model.openings.map((o) =>
            o.id === draggingEntity.id
              ? { ...o, x: clamp01(pt.x - draggingEntity.offsetX), y: clamp01(pt.y - draggingEntity.offsetY) }
              : o
          ),
        });
      } else if (draggingEntity.kind === 'symbol' && !isLocked('symbols')) {
        onChangeModel({
          ...model,
          symbols: model.symbols.map((s) =>
            s.id === draggingEntity.id
              ? { ...s, x: clamp01(pt.x - draggingEntity.offsetX), y: clamp01(pt.y - draggingEntity.offsetY) }
              : s
          ),
        });
      } else if (draggingEntity.kind === 'furniture' && !isLocked('furniture')) {
        onChangeModel({
          ...model,
          furniture: (model.furniture ?? []).map((f) =>
            f.id === draggingEntity.id
              ? { ...f, x: clamp01(pt.x - draggingEntity.offsetX), y: clamp01(pt.y - draggingEntity.offsetY) }
              : f
          ),
        });
      } else if (draggingEntity.kind === 'room' && !isLocked('rooms')) {
        onChangeModel({
          ...model,
          rooms: model.rooms.map((r) => {
            if (r.id !== draggingEntity.id) return r;
            const nx = clamp01(Math.min(1 - r.width, pt.x - draggingEntity.offsetX));
            const ny = clamp01(Math.min(1 - r.height, pt.y - draggingEntity.offsetY));
            const dx = nx - r.x;
            const dy = ny - r.y;
            return {
              ...r,
              x: nx,
              y: ny,
              polygon: r.polygon?.map((v) => ({ x: clamp01(v.x + dx), y: clamp01(v.y + dy) })),
            };
          }),
        });
      } else if (draggingEntity.kind === 'label' && !isLocked('labels')) {
        onChangeModel({
          ...model,
          textLabels: model.textLabels.map((t) =>
            t.id === draggingEntity.id
              ? { ...t, x: clamp01(pt.x - draggingEntity.offsetX), y: clamp01(pt.y - draggingEntity.offsetY) }
              : t
          ),
        });
      }
    }
  };

  const handleSvgPointerUp = () => {
    if (dragBoxStart && dragBoxCurrent) {
      const x = Math.min(dragBoxStart.x, dragBoxCurrent.x);
      const y = Math.min(dragBoxStart.y, dragBoxCurrent.y);
      const width = Math.abs(dragBoxCurrent.x - dragBoxStart.x);
      const height = Math.abs(dragBoxCurrent.y - dragBoxStart.y);

      if (width >= 0.015 && height >= 0.015) {
        if (mode === 'crop-legend') {
          onLegendCropRectPicked?.({ x, y, width, height });
        } else if (mode === 'add-room') {
          const newRoom = {
            id: `man-room-${Date.now()}`,
            name: `Room ${model.rooms.length + 1}`,
            roomType: 'custom' as RoomType,
            x,
            y,
            width,
            height,
            confidence: 1,
            status: 'approved' as const,
            source: 'manual' as const,
          };
          onChangeModel({ ...model, rooms: [...model.rooms, newRoom] });
          setSelected({ kind: 'room', id: newRoom.id });
        }
      }
    }
    setDragBoxStart(null);
    setDragBoxCurrent(null);
    setDraggingEntity(null);
  };

  const updateSelectedStatus = (status: DetectionStatus) => {
    if (!selected) return;
    switch (selected.kind) {
      case 'wall':
        onChangeModel({ ...model, walls: model.walls.map((w) => (w.id === selected.id ? { ...w, status } : w)) });
        break;
      case 'room':
        onChangeModel({ ...model, rooms: model.rooms.map((r) => (r.id === selected.id ? { ...r, status } : r)) });
        break;
      case 'opening':
        onChangeModel({ ...model, openings: model.openings.map((o) => (o.id === selected.id ? { ...o, status } : o)) });
        break;
      case 'column':
        onChangeModel({ ...model, columns: model.columns.map((c) => (c.id === selected.id ? { ...c, status } : c)) });
        break;
      case 'staircase':
        onChangeModel({ ...model, staircases: model.staircases.map((s) => (s.id === selected.id ? { ...s, status } : s)) });
        break;
      case 'furniture':
        onChangeModel({
          ...model,
          furniture: (model.furniture ?? []).map((f) => (f.id === selected.id ? { ...f, status } : f)),
        });
        break;
      case 'symbol':
        onChangeModel({ ...model, symbols: model.symbols.map((s) => (s.id === selected.id ? { ...s, status } : s)) });
        break;
      case 'wiring':
        onChangeModel({ ...model, wiringPaths: model.wiringPaths.map((w) => (w.id === selected.id ? { ...w, status } : w)) });
        break;
      case 'dimension':
        onChangeModel({ ...model, dimensions: model.dimensions.map((d) => (d.id === selected.id ? { ...d, status } : d)) });
        break;
      case 'label':
        onChangeModel({ ...model, textLabels: model.textLabels.map((t) => (t.id === selected.id ? { ...t, status } : t)) });
        break;
    }
  };

  const deleteSelected = () => {
    if (!selected) return;
    switch (selected.kind) {
      case 'wall':
        onChangeModel({ ...model, walls: model.walls.filter((w) => w.id !== selected.id) });
        break;
      case 'room':
        onChangeModel({ ...model, rooms: model.rooms.filter((r) => r.id !== selected.id) });
        break;
      case 'opening':
        onChangeModel({ ...model, openings: model.openings.filter((o) => o.id !== selected.id) });
        break;
      case 'column':
        onChangeModel({ ...model, columns: model.columns.filter((c) => c.id !== selected.id) });
        break;
      case 'staircase':
        onChangeModel({ ...model, staircases: model.staircases.filter((s) => s.id !== selected.id) });
        break;
      case 'furniture':
        onChangeModel({
          ...model,
          furniture: (model.furniture ?? []).filter((f) => f.id !== selected.id),
        });
        break;
      case 'symbol':
        onChangeModel({ ...model, symbols: model.symbols.filter((s) => s.id !== selected.id) });
        break;
      case 'wiring':
        onChangeModel({ ...model, wiringPaths: model.wiringPaths.filter((w) => w.id !== selected.id) });
        break;
      case 'dimension':
        onChangeModel({ ...model, dimensions: model.dimensions.filter((d) => d.id !== selected.id) });
        break;
      case 'label':
        onChangeModel({ ...model, textLabels: model.textLabels.filter((t) => t.id !== selected.id) });
        break;
    }
    setSelected(null);
  };

  const toggleLayerVisibility = (id: DrawingLayerId) => {
    onChangeLayers(layers.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)));
  };

  const toggleLayerLock = (id: DrawingLayerId) => {
    onChangeLayers(layers.map((l) => (l.id === id ? { ...l, locked: !l.locked } : l)));
  };

  const shouldRenderStatus = (status: DetectionStatus) => status !== 'rejected' || showRejected;

  const selectedObj = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === 'wall') return model.walls.find((x) => x.id === selected.id) ?? null;
    if (selected.kind === 'room') return model.rooms.find((x) => x.id === selected.id) ?? null;
    if (selected.kind === 'opening') return model.openings.find((x) => x.id === selected.id) ?? null;
    if (selected.kind === 'column') return model.columns.find((x) => x.id === selected.id) ?? null;
    if (selected.kind === 'staircase') return model.staircases.find((x) => x.id === selected.id) ?? null;
    if (selected.kind === 'furniture') return (model.furniture ?? []).find((x) => x.id === selected.id) ?? null;
    if (selected.kind === 'symbol') return model.symbols.find((x) => x.id === selected.id) ?? null;
    if (selected.kind === 'wiring') return model.wiringPaths.find((x) => x.id === selected.id) ?? null;
    if (selected.kind === 'dimension') return model.dimensions.find((x) => x.id === selected.id) ?? null;
    if (selected.kind === 'label') return model.textLabels.find((x) => x.id === selected.id) ?? null;
    return null;
  }, [selected, model]);

  const vbW = 1000;
  const vbH = Math.max(300, Math.round(1000 * (source.imageHeightPx / Math.max(1, source.imageWidthPx))));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
      {/* Main Canvas Column */}
      <div className={showInspector ? 'lg:col-span-8 flex flex-col gap-2' : 'lg:col-span-12 flex flex-col gap-2'}>
        {/* Top Review Toolbar */}
        <div className="bg-[#11161f] border border-slate-800 rounded-xl p-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {[
              { id: 'select' as const, label: 'Select / Drag', icon: MousePointer2 },
              { id: 'calibrate' as const, label: '2-Pt Scale', icon: Ruler },
              ...(onLegendCropRectPicked
                ? [{ id: 'crop-legend' as const, label: 'Crop Legend', icon: Crop }]
                : []),
              { id: 'add-wall' as const, label: '+ Wall', icon: Plus },
              { id: 'add-room' as const, label: '+ Room', icon: Square },
              { id: 'add-door' as const, label: '+ Door', icon: DoorOpen },
              { id: 'add-window' as const, label: '+ Window', icon: Square },
              { id: 'add-symbol' as const, label: '+ Symbol', icon: Zap },
            ].map((tool) => {
              const Icon = tool.icon;
              const active = mode === tool.id;
              return (
                <button
                  key={tool.id}
                  type="button"
                  onClick={() => {
                    onChangeMode(tool.id);
                    setDraftWallStart(null);
                    setCalPointA(null);
                  }}
                  className={`px-2 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 transition ${
                    active
                      ? 'bg-sky-600 text-white'
                      : 'bg-[#0d1117] text-slate-300 border border-slate-800 hover:border-slate-600'
                  }`}
                >
                  <Icon className="w-3 h-3" />
                  {tool.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            {mode === 'add-symbol' && symbolMappings.length > 0 && (
              <select
                value={activeSymbolMappingId}
                onChange={(e) => setActiveSymbolMappingId(e.target.value)}
                className="px-2 py-1 text-[11px] rounded bg-[#0d1117] border border-slate-700 text-white"
              >
                {symbolMappings
                  .filter((s) => s.enabled)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} — {s.name}
                    </option>
                  ))}
              </select>
            )}

            {/* Visual Alignment Comparison Quick Toggles */}
            <div className="flex items-center gap-1 border-r border-slate-800 pr-2">
              <button
                type="button"
                onClick={() => toggleLayerVisibility('referenceImage')}
                className={`px-2 py-1 rounded text-[11px] font-medium flex items-center gap-1 border ${
                  isVisible('referenceImage')
                    ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
                    : 'bg-[#0d1117] border-slate-800 text-slate-500'
                }`}
                title="Show / Hide Reference PDF"
              >
                {isVisible('referenceImage') ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                PDF
              </button>
              <button
                type="button"
                onClick={() => setShowCadOverlay((prev) => !prev)}
                className={`px-2 py-1 rounded text-[11px] font-medium flex items-center gap-1 border ${
                  showCadOverlay
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                    : 'bg-[#0d1117] border-slate-800 text-slate-500'
                }`}
                title="Show / Hide Reconstructed CAD Geometry"
              >
                {showCadOverlay ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                CAD
              </button>
            </div>

            <label className="flex items-center gap-1 text-[11px] text-slate-400">
              PDF %
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={imageOpacity}
                onChange={(e) => setImageOpacity(Number(e.target.value))}
                className="w-14 accent-sky-500"
              />
            </label>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
                className="p-1 rounded bg-[#0d1117] border border-slate-800 text-slate-300 hover:text-white"
                title="Zoom Out"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="text-[11px] text-slate-300 w-10 text-center">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))}
                className="p-1 rounded bg-[#0d1117] border border-slate-800 text-slate-300 hover:text-white"
                title="Zoom In"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Active Mode Instruction Strip */}
        {mode !== 'select' && (
          <div className="px-3 py-1.5 rounded-lg bg-sky-500/10 border border-sky-500/30 text-[11px] text-sky-200 flex items-center justify-between">
            <span>
              {mode === 'calibrate' &&
                (calPointA
                  ? 'Scale Calibration: Click Point B at the other end of your known dimension.'
                  : 'Scale Calibration: Click Point A at the start of a known wall or dimension line.')}
              {mode === 'crop-legend' &&
                'Legend Crop: Click and drag a rectangle tightly around a symbol in the drawing legend.'}
              {mode === 'add-wall' &&
                (draftWallStart
                  ? 'Add Wall: Click wall end point.'
                  : 'Add Wall: Click wall start point.')}
              {mode === 'add-room' && 'Add Room: Click and drag a rectangle over the room footprint.'}
              {mode === 'add-door' && 'Add Door: Click on a wall to place a door opening.'}
              {mode === 'add-window' && 'Add Window: Click on a wall to place a window opening.'}
              {mode === 'add-symbol' && 'Add Symbol: Click on the drawing to place the selected symbol.'}
            </span>
            <button
              type="button"
              onClick={() => onChangeMode('select')}
              className="text-sky-300 hover:text-white font-semibold ml-2"
            >
              Done
            </button>
          </div>
        )}

        {/* Interactive SVG Over Drawing */}
        <div className="bg-[#090d14] border border-slate-800 rounded-xl overflow-auto max-h-[480px] min-h-[340px] flex items-start justify-center p-2">
          <div style={{ width: `${Math.round(zoom * 100)}%`, minWidth: '480px' }}>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${vbW} ${vbH}`}
              onPointerDown={handleSvgPointerDown}
              onPointerMove={handleSvgPointerMove}
              onPointerUp={handleSvgPointerUp}
              className={`w-full h-auto select-none block rounded bg-white ${
                mode === 'select' ? 'cursor-default' : 'cursor-crosshair'
              }`}
            >
              {/* Layer 0: Reference Drawing Image */}
              {isVisible('referenceImage') && (
                <image
                  href={source.preparedImageDataUrl}
                  x={0}
                  y={0}
                  width={vbW}
                  height={vbH}
                  opacity={imageOpacity}
                  preserveAspectRatio="none"
                />
              )}

              {/* Layer 1: Rooms (polygon-faithful when available) */}
              {showCadOverlay && isVisible('rooms') &&
                model.rooms.filter((r) => shouldRenderStatus(r.status)).map((room) => {
                  const isSel = selected?.kind === 'room' && selected.id === room.id;
                  const stroke = isSel ? '#38bdf8' : STATUS_COLORS[room.status];
                  const hasPoly = Array.isArray(room.polygon) && room.polygon.length >= 3;
                  const polyPoints = hasPoly
                    ? room.polygon!.map((p) => `${p.x * vbW},${p.y * vbH}`).join(' ')
                    : '';
                  return (
                    <g
                      key={room.id}
                      onPointerDown={(e) => {
                        if (mode !== 'select') return;
                        e.stopPropagation();
                        setSelected({ kind: 'room', id: room.id });
                        if (!isLocked('rooms')) {
                          const pt = getNormCoords(e as unknown as React.PointerEvent<SVGSVGElement>);
                          setDraggingEntity({
                            kind: 'room',
                            id: room.id,
                            offsetX: pt.x - room.x,
                            offsetY: pt.y - room.y,
                          });
                        }
                      }}
                      className="cursor-pointer"
                    >
                      {hasPoly ? (
                        <polygon
                          points={polyPoints}
                          fill={room.status === 'approved' ? 'rgba(99,102,241,0.16)' : 'rgba(245,158,11,0.14)'}
                          stroke={stroke}
                          strokeWidth={isSel ? 3 : 2}
                          strokeDasharray={room.status === 'approved' ? undefined : '6 4'}
                        />
                      ) : (
                        <rect
                          x={room.x * vbW}
                          y={room.y * vbH}
                          width={room.width * vbW}
                          height={room.height * vbH}
                          fill={room.status === 'approved' ? 'rgba(99,102,241,0.16)' : 'rgba(245,158,11,0.14)'}
                          stroke={stroke}
                          strokeWidth={isSel ? 3 : 2}
                          strokeDasharray={room.status === 'approved' ? undefined : '6 4'}
                        />
                      )}
                      <text
                        x={(room.x + room.width / 2) * vbW}
                        y={(room.y + room.height / 2) * vbH}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={12}
                        fontWeight={700}
                        fill="#0f172a"
                        stroke="#ffffff"
                        strokeWidth={3}
                        paintOrder="stroke"
                      >
                        {room.name}
                      </text>
                    </g>
                  );
                })}

              {/* Layer 2: Walls (with interactive endpoint drag handles when selected) */}
              {showCadOverlay && isVisible('walls') &&
                model.walls.filter((w) => shouldRenderStatus(w.status)).map((wall) => {
                  const isSel = selected?.kind === 'wall' && selected.id === wall.id;
                  const stroke = isSel
                    ? '#38bdf8'
                    : wall.isCurvedSegment && wall.status === 'approved'
                    ? '#06b6d4'
                    : STATUS_COLORS[wall.status];
                  return (
                    <g key={wall.id}>
                      <line
                        x1={wall.x1 * vbW}
                        y1={wall.y1 * vbH}
                        x2={wall.x2 * vbW}
                        y2={wall.y2 * vbH}
                        stroke={stroke}
                        strokeWidth={isSel ? 7 : wall.wallKind === 'external' ? 5 : 3.5}
                        strokeLinecap="round"
                        strokeDasharray={wall.status === 'approved' ? undefined : '7 4'}
                        className="cursor-pointer"
                        onPointerDown={(e) => {
                          if (mode !== 'select') return;
                          e.stopPropagation();
                          setSelected({ kind: 'wall', id: wall.id });
                        }}
                      />
                      {isSel && mode === 'select' && !isLocked('walls') && (
                        <>
                          <circle
                            cx={wall.x1 * vbW}
                            cy={wall.y1 * vbH}
                            r={7}
                            fill="#38bdf8"
                            stroke="#ffffff"
                            strokeWidth={2}
                            className="cursor-move"
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              setDraggingEntity({ kind: 'wall-p1', id: wall.id });
                            }}
                          />
                          <circle
                            cx={wall.x2 * vbW}
                            cy={wall.y2 * vbH}
                            r={7}
                            fill="#38bdf8"
                            stroke="#ffffff"
                            strokeWidth={2}
                            className="cursor-move"
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              setDraggingEntity({ kind: 'wall-p2', id: wall.id });
                            }}
                          />
                        </>
                      )}
                    </g>
                  );
                })}

              {/* Layer 3: Columns */}
              {showCadOverlay && isVisible('columns') &&
                model.columns.filter((c) => shouldRenderStatus(c.status)).map((col) => {
                  const isSel = selected?.kind === 'column' && selected.id === col.id;
                  return (
                    <rect
                      key={col.id}
                      x={(col.x - col.widthNorm / 2) * vbW}
                      y={(col.y - col.heightNorm / 2) * vbH}
                      width={col.widthNorm * vbW}
                      height={col.heightNorm * vbH}
                      fill="rgba(71,85,105,0.65)"
                      stroke={isSel ? '#38bdf8' : STATUS_COLORS[col.status]}
                      strokeWidth={isSel ? 3 : 2}
                      className="cursor-pointer"
                      onPointerDown={(e) => {
                        if (mode !== 'select') return;
                        e.stopPropagation();
                        setSelected({ kind: 'column', id: col.id });
                      }}
                    />
                  );
                })}

              {/* Layer 4: Staircases */}
              {showCadOverlay && isVisible('staircases') &&
                model.staircases.filter((s) => shouldRenderStatus(s.status)).map((st) => {
                  const isSel = selected?.kind === 'staircase' && selected.id === st.id;
                  return (
                    <g
                      key={st.id}
                      className="cursor-pointer"
                      onPointerDown={(e) => {
                        if (mode !== 'select') return;
                        e.stopPropagation();
                        setSelected({ kind: 'staircase', id: st.id });
                      }}
                    >
                      <rect
                        x={st.x * vbW}
                        y={st.y * vbH}
                        width={st.widthNorm * vbW}
                        height={st.heightNorm * vbH}
                        fill="rgba(236,72,153,0.18)"
                        stroke={isSel ? '#38bdf8' : STATUS_COLORS[st.status]}
                        strokeWidth={2}
                      />
                      <text
                        x={(st.x + st.widthNorm / 2) * vbW}
                        y={(st.y + st.heightNorm / 2) * vbH}
                        textAnchor="middle"
                        fontSize={10}
                        fontWeight={700}
                        fill="#831843"
                      >
                        {st.label}
                      </text>
                    </g>
                  );
                })}

              {/* Layer 4b: Furniture */}
              {showCadOverlay && isVisible('furniture') &&
                (model.furniture ?? []).filter((f) => shouldRenderStatus(f.status)).map((furn) => {
                  const isSel = selected?.kind === 'furniture' && selected.id === furn.id;
                  const cx = furn.x * vbW;
                  const cy = furn.y * vbH;
                  const fw = furn.widthNorm * vbW;
                  const fh = furn.heightNorm * vbH;
                  return (
                    <g
                      key={furn.id}
                      transform={`translate(${cx}, ${cy}) rotate(${furn.rotationDeg})`}
                      className="cursor-pointer"
                      onPointerDown={(e) => {
                        if (mode !== 'select') return;
                        e.stopPropagation();
                        setSelected({ kind: 'furniture', id: furn.id });
                        if (!isLocked('furniture')) {
                          const pt = getNormCoords(e as unknown as React.PointerEvent<SVGSVGElement>);
                          setDraggingEntity({
                            kind: 'furniture',
                            id: furn.id,
                            offsetX: pt.x - furn.x,
                            offsetY: pt.y - furn.y,
                          });
                        }
                      }}
                    >
                      <rect
                        x={-fw / 2}
                        y={-fh / 2}
                        width={fw}
                        height={fh}
                        rx={3}
                        fill="rgba(168,85,247,0.18)"
                        stroke={isSel ? '#38bdf8' : STATUS_COLORS[furn.status]}
                        strokeWidth={isSel ? 2.5 : 1.5}
                      />
                      <text y={3} textAnchor="middle" fontSize={8} fontWeight={600} fill="#e9d5ff">
                        {furn.label.slice(0, 12)}
                      </text>
                    </g>
                  );
                })}

              {/* Layer 5: Openings */}
              {showCadOverlay && isVisible('openings') &&
                model.openings.filter((o) => shouldRenderStatus(o.status)).map((op) => {
                  const isSel = selected?.kind === 'opening' && selected.id === op.id;
                  const cx = op.x * vbW;
                  const cy = op.y * vbH;
                  const w = op.widthNorm * vbW;
                  return (
                    <g
                      key={op.id}
                      transform={`translate(${cx}, ${cy}) rotate(${op.rotationDeg})`}
                      className="cursor-pointer"
                      onPointerDown={(e) => {
                        if (mode !== 'select') return;
                        e.stopPropagation();
                        setSelected({ kind: 'opening', id: op.id });
                        if (!isLocked('openings')) {
                          const pt = getNormCoords(e as unknown as React.PointerEvent<SVGSVGElement>);
                          setDraggingEntity({
                            kind: 'opening',
                            id: op.id,
                            offsetX: pt.x - op.x,
                            offsetY: pt.y - op.y,
                          });
                        }
                      }}
                    >
                      <rect
                        x={-w / 2}
                        y={-6}
                        width={w}
                        height={12}
                        rx={2}
                        fill={op.kind === 'door' ? '#f59e0b' : '#0ea5e9'}
                        stroke={isSel ? '#ffffff' : STATUS_COLORS[op.status]}
                        strokeWidth={isSel ? 2.5 : 1.5}
                      />
                      <text y={3} textAnchor="middle" fontSize={8} fontWeight={700} fill="#0f172a">
                        {op.kind === 'door' ? 'D' : 'W'}
                      </text>
                    </g>
                  );
                })}

              {/* Layer 6: Wiring Paths */}
              {showCadOverlay && isVisible('wiring') &&
                model.wiringPaths.filter((w) => shouldRenderStatus(w.status)).map((wp) => {
                  const isSel = selected?.kind === 'wiring' && selected.id === wp.id;
                  const ptsStr = wp.points.map((p) => `${p.x * vbW},${p.y * vbH}`).join(' ');
                  return (
                    <polyline
                      key={wp.id}
                      points={ptsStr}
                      fill="none"
                      stroke={isSel ? '#38bdf8' : wp.status === 'approved' ? '#ef4444' : '#f59e0b'}
                      strokeWidth={isSel ? 3.5 : 2}
                      strokeDasharray={wp.status === 'approved' ? '5 3' : '3 3'}
                      className="cursor-pointer"
                      onPointerDown={(e) => {
                        if (mode !== 'select') return;
                        e.stopPropagation();
                        setSelected({ kind: 'wiring', id: wp.id });
                      }}
                    />
                  );
                })}

              {/* Layer 7: Symbols */}
              {showCadOverlay && isVisible('symbols') &&
                model.symbols.filter((s) => shouldRenderStatus(s.status)).map((sym) => {
                  const isSel = selected?.kind === 'symbol' && selected.id === sym.id;
                  const mapping = symbolMappings.find((m) => m.id === sym.symbolMappingId);
                  const fillColor = mapping?.markerColor ?? STATUS_COLORS[sym.status];
                  const cx = sym.x * vbW;
                  const cy = sym.y * vbH;
                  return (
                    <g
                      key={sym.id}
                      transform={`translate(${cx}, ${cy})`}
                      className="cursor-pointer"
                      onPointerDown={(e) => {
                        if (mode !== 'select') return;
                        e.stopPropagation();
                        setSelected({ kind: 'symbol', id: sym.id });
                        if (!isLocked('symbols')) {
                          const pt = getNormCoords(e as unknown as React.PointerEvent<SVGSVGElement>);
                          setDraggingEntity({
                            kind: 'symbol',
                            id: sym.id,
                            offsetX: pt.x - sym.x,
                            offsetY: pt.y - sym.y,
                          });
                        }
                      }}
                    >
                      <circle
                        r={isSel ? 12 : 9}
                        fill={fillColor}
                        fillOpacity={0.9}
                        stroke={isSel ? '#ffffff' : STATUS_COLORS[sym.status]}
                        strokeWidth={isSel ? 3 : 2}
                        strokeDasharray={sym.status === 'approved' ? undefined : '3 2'}
                      />
                      <text
                        y={3}
                        textAnchor="middle"
                        fontSize={8}
                        fontWeight={800}
                        fill="#0f172a"
                      >
                        {sym.status === 'uncertain' ? '?' : sym.symbolCode.slice(0, 3)}
                      </text>
                    </g>
                  );
                })}

              {/* Layer 8: Dimensions (distinguishing Exact vs Estimated) */}
              {showCadOverlay && isVisible('dimensions') &&
                model.dimensions.filter((d) => shouldRenderStatus(d.status)).map((dim) => {
                  const isSel = selected?.kind === 'dimension' && selected.id === dim.id;
                  const isExact = dim.measurementKind === 'exact';
                  return (
                    <g
                      key={dim.id}
                      className="cursor-pointer"
                      onPointerDown={(e) => {
                        if (mode !== 'select') return;
                        e.stopPropagation();
                        setSelected({ kind: 'dimension', id: dim.id });
                      }}
                    >
                      <line
                        x1={dim.x1 * vbW}
                        y1={dim.y1 * vbH}
                        x2={dim.x2 * vbW}
                        y2={dim.y2 * vbH}
                        stroke={isSel ? '#38bdf8' : isExact ? '#06b6d4' : '#f59e0b'}
                        strokeWidth={2}
                        strokeDasharray={isExact ? undefined : '4 2'}
                      />
                      {dim.labelText && (
                        <text
                          x={((dim.x1 + dim.x2) / 2) * vbW}
                          y={((dim.y1 + dim.y2) / 2) * vbH - 5}
                          textAnchor="middle"
                          fontSize={10}
                          fontWeight={700}
                          fill={isExact ? '#0e7490' : '#b45309'}
                          stroke="#ffffff"
                          strokeWidth={2.5}
                          paintOrder="stroke"
                        >
                          {dim.labelText}
                          {!isExact ? ' (est.)' : ''}
                        </text>
                      )}
                    </g>
                  );
                })}

              {/* Layer 9: Text Labels (collision-decluttered & legend/title-block filtered by default) */}
              {showCadOverlay && isVisible('labels') &&
                (() => {
                  const placed: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
                  return model.textLabels
                    .filter(
                      (t) =>
                        shouldRenderStatus(t.status) &&
                        (showRejected || (t.kind !== 'legend-text' && t.kind !== 'title-block'))
                    )
                    .map((lbl) => {
                      const isSel = selected?.kind === 'label' && selected.id === lbl.id;
                      const x = lbl.x * vbW;
                      const y = lbl.y * vbH;
                      const display = lbl.text.slice(0, 38);
                      const w = Math.max(24, display.length * 6.2);
                      const h = 13;
                      const box = { x1: x - 2, y1: y - h, x2: x + w, y2: y + 3 };
                      if (!isSel && placed.some((b) => box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1)) {
                        return null;
                      }
                      placed.push(box);
                      return (
                        <text
                          key={lbl.id}
                          x={x}
                          y={y}
                          fontSize={11}
                          fontWeight={600}
                          fill={isSel ? '#0284c7' : '#334155'}
                          stroke="#ffffff"
                          strokeWidth={2.5}
                          paintOrder="stroke"
                          className="cursor-pointer"
                          onPointerDown={(e) => {
                            if (mode !== 'select') return;
                            e.stopPropagation();
                            setSelected({ kind: 'label', id: lbl.id });
                            if (!isLocked('labels')) {
                              const pt = getNormCoords(e as unknown as React.PointerEvent<SVGSVGElement>);
                              setDraggingEntity({
                                kind: 'label',
                                id: lbl.id,
                                offsetX: pt.x - lbl.x,
                                offsetY: pt.y - lbl.y,
                              });
                            }
                          }}
                        >
                          {display}
                        </text>
                      );
                    });
                })()}

              {/* Existing Calibration Line */}
              {calibration.calibrated && calibration.pointA && calibration.pointB && (
                <g pointerEvents="none">
                  <line
                    x1={calibration.pointA.x * vbW}
                    y1={calibration.pointA.y * vbH}
                    x2={calibration.pointB.x * vbW}
                    y2={calibration.pointB.y * vbH}
                    stroke="#22c55e"
                    strokeWidth={3}
                    strokeDasharray="6 3"
                  />
                  <circle cx={calibration.pointA.x * vbW} cy={calibration.pointA.y * vbH} r={6} fill="#22c55e" />
                  <circle cx={calibration.pointB.x * vbW} cy={calibration.pointB.y * vbH} r={6} fill="#22c55e" />
                </g>
              )}

              {/* Active Calibration Point A */}
              {calPointA && (
                <circle
                  cx={calPointA.x * vbW}
                  cy={calPointA.y * vbH}
                  r={7}
                  fill="#0ea5e9"
                  stroke="#ffffff"
                  strokeWidth={2}
                  pointerEvents="none"
                />
              )}

              {/* Active Draft Wall Start */}
              {draftWallStart && (
                <circle
                  cx={draftWallStart.x * vbW}
                  cy={draftWallStart.y * vbH}
                  r={6}
                  fill="#38bdf8"
                  stroke="#ffffff"
                  strokeWidth={2}
                  pointerEvents="none"
                />
              )}

              {/* Active Drag Rectangle (Legend Crop or Add Room) */}
              {dragBoxStart && dragBoxCurrent && (
                <rect
                  x={Math.min(dragBoxStart.x, dragBoxCurrent.x) * vbW}
                  y={Math.min(dragBoxStart.y, dragBoxCurrent.y) * vbH}
                  width={Math.abs(dragBoxCurrent.x - dragBoxStart.x) * vbW}
                  height={Math.abs(dragBoxCurrent.y - dragBoxStart.y) * vbH}
                  fill="rgba(56,189,248,0.18)"
                  stroke="#38bdf8"
                  strokeWidth={2.5}
                  strokeDasharray="5 3"
                  pointerEvents="none"
                />
              )}
            </svg>
          </div>
        </div>
      </div>

      {/* Right Inspector & Layers Column */}
      {showInspector && (
        <div className="lg:col-span-4 flex flex-col gap-3">
          {/* Selected Object Inspector */}
          <div className="bg-[#11161f] border border-slate-800 rounded-xl p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">Detection Inspector</span>
              <label className="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showRejected}
                  onChange={(e) => setShowRejected(e.target.checked)}
                  className="accent-sky-500"
                />
                Show rejected
              </label>
            </div>

            {!selected || !selectedObj ? (
              <p className="text-[11px] text-slate-400 py-3">
                Click any detected wall, room, opening, symbol, or label on the drawing to inspect, move, edit, reclassify, approve, or delete it.
              </p>
            ) : (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] uppercase tracking-wide text-sky-400 font-semibold">
                      {selected.kind}
                    </span>
                    {'origin' in selectedObj && selectedObj.origin && (
                      <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] text-slate-300">
                        {selectedObj.origin === 'pdf-vector'
                          ? 'PDF Vector'
                          : selectedObj.origin === 'raster-cv'
                          ? 'Raster CV'
                          : selectedObj.origin === 'vision-ai'
                          ? 'Vision AI'
                          : 'Manual'}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-slate-400">
                    Confidence: {Math.round(selectedObj.confidence * 100)}%
                  </span>
                </div>

                {/* Status Action Buttons */}
                <div className="grid grid-cols-3 gap-1">
                  <button
                    type="button"
                    onClick={() => updateSelectedStatus('approved')}
                    className={`py-1 rounded text-[11px] font-medium flex items-center justify-center gap-1 ${
                      selectedObj.status === 'approved'
                        ? 'bg-emerald-600 text-white'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    <CheckCircle2 className="w-3 h-3" /> Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => updateSelectedStatus('uncertain')}
                    className={`py-1 rounded text-[11px] font-medium flex items-center justify-center gap-1 ${
                      selectedObj.status === 'uncertain'
                        ? 'bg-amber-600 text-white'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    <HelpCircle className="w-3 h-3" /> Uncertain
                  </button>
                  <button
                    type="button"
                    onClick={() => updateSelectedStatus('rejected')}
                    className={`py-1 rounded text-[11px] font-medium flex items-center justify-center gap-1 ${
                      selectedObj.status === 'rejected'
                        ? 'bg-rose-600 text-white'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    <XCircle className="w-3 h-3" /> Reject
                  </button>
                </div>

                {/* Specific fields by entity kind */}
                {selected.kind === 'room' && 'roomType' in selectedObj && (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={selectedObj.name}
                      onChange={(e) =>
                        onChangeModel({
                          ...model,
                          rooms: model.rooms.map((r) =>
                            r.id === selected.id ? { ...r, name: e.target.value } : r
                          ),
                        })
                      }
                      className="w-full px-2 py-1 text-xs rounded bg-[#0d1117] border border-slate-700 text-white"
                    />
                    <select
                      value={selectedObj.roomType}
                      onChange={(e) =>
                        onChangeModel({
                          ...model,
                          rooms: model.rooms.map((r) =>
                            r.id === selected.id ? { ...r, roomType: e.target.value as RoomType } : r
                          ),
                        })
                      }
                      className="w-full px-2 py-1 text-xs rounded bg-[#0d1117] border border-slate-700 text-white"
                    >
                      {ROOM_TYPE_OPTIONS.map((rt) => (
                        <option key={rt} value={rt}>
                          {rt}
                        </option>
                      ))}
                    </select>
                    <div className="text-[11px] text-slate-400">
                      Est. size: {round2(selectedObj.width * calibration.drawingWidthMeters)} m ×{' '}
                      {round2(selectedObj.height * calibration.drawingHeightMeters)} m
                    </div>
                  </div>
                )}

                {selected.kind === 'wall' && 'wallKind' in selectedObj && (
                  <div className="space-y-2">
                    <select
                      value={selectedObj.wallKind}
                      onChange={(e) =>
                        onChangeModel({
                          ...model,
                          walls: model.walls.map((w) =>
                            w.id === selected.id
                              ? { ...w, wallKind: e.target.value as 'external' | 'internal' }
                              : w
                          ),
                        })
                      }
                      className="w-full px-2 py-1 text-xs rounded bg-[#0d1117] border border-slate-700 text-white"
                    >
                      <option value="external">External Wall</option>
                      <option value="internal">Internal Partition Wall</option>
                    </select>
                    <div className="text-[11px] text-slate-400">
                      Length:{' '}
                      {round2(
                        Math.hypot(
                          (selectedObj.x2 - selectedObj.x1) * calibration.drawingWidthMeters,
                          (selectedObj.y2 - selectedObj.y1) * calibration.drawingHeightMeters
                        )
                      )}{' '}
                      m
                    </div>
                  </div>
                )}

                {selected.kind === 'opening' && 'kind' in selectedObj && 'rotationDeg' in selectedObj && (
                  <div className="grid grid-cols-2 gap-2">
                    <select
                      value={selectedObj.kind}
                      onChange={(e) =>
                        onChangeModel({
                          ...model,
                          openings: model.openings.map((o) =>
                            o.id === selected.id
                              ? { ...o, kind: e.target.value as 'door' | 'window' }
                              : o
                          ),
                        })
                      }
                      className="px-2 py-1 text-xs rounded bg-[#0d1117] border border-slate-700 text-white"
                    >
                      <option value="door">Door</option>
                      <option value="window">Window</option>
                    </select>
                    <input
                      type="number"
                      step={15}
                      value={selectedObj.rotationDeg}
                      onChange={(e) =>
                        onChangeModel({
                          ...model,
                          openings: model.openings.map((o) =>
                            o.id === selected.id ? { ...o, rotationDeg: Number(e.target.value) || 0 } : o
                          ),
                        })
                      }
                      placeholder="Angle °"
                      className="px-2 py-1 text-xs rounded bg-[#0d1117] border border-slate-700 text-white"
                    />
                  </div>
                )}

                {selected.kind === 'symbol' && 'symbolCode' in selectedObj && (
                  <div className="space-y-2">
                    <label className="block text-[11px] text-slate-400">
                      Assign User Symbol Mapping
                    </label>
                    <select
                      value={selectedObj.symbolMappingId ?? ''}
                      onChange={(e) => {
                        const mapping = symbolMappings.find((m) => m.id === e.target.value);
                        onChangeModel({
                          ...model,
                          symbols: model.symbols.map((s) =>
                            s.id === selected.id
                              ? {
                                  ...s,
                                  symbolMappingId: mapping?.id ?? null,
                                  symbolName: mapping?.name ?? s.symbolName,
                                  symbolCode: mapping?.code ?? s.symbolCode,
                                  domain: mapping?.domain ?? s.domain,
                                  electricalItemType: mapping?.electricalItemType,
                                  electricalCategory: mapping?.electricalCategory,
                                  matchedByUserLegend: Boolean(mapping),
                                  status: mapping ? 'approved' : s.status,
                                }
                              : s
                          ),
                        });
                      }}
                      className="w-full px-2 py-1 text-xs rounded bg-[#0d1117] border border-slate-700 text-white"
                    >
                      <option value="">-- Unmapped Symbol --</option>
                      {symbolMappings.map((m) => (
                        <option key={m.id} value={m.id}>
                          [{m.code}] {m.name}
                        </option>
                      ))}
                    </select>
                    {'note' in selectedObj && selectedObj.note && (
                      <p className="text-[11px] text-amber-300">{selectedObj.note}</p>
                    )}
                  </div>
                )}

                {selected.kind === 'dimension' && 'labelText' in selectedObj && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-400">Measurement Basis</span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          selectedObj.measurementKind === 'exact'
                            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                            : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                        }`}
                      >
                        {selectedObj.measurementKind === 'exact' ? 'Exact (Drawing)' : 'Estimated'}
                      </span>
                    </div>
                    <input
                      type="text"
                      value={selectedObj.labelText}
                      onChange={(e) =>
                        onChangeModel({
                          ...model,
                          dimensions: model.dimensions.map((d) =>
                            d.id === selected.id ? { ...d, labelText: e.target.value } : d
                          ),
                        })
                      }
                      className="w-full px-2 py-1 text-xs rounded bg-[#0d1117] border border-slate-700 text-white"
                    />
                  </div>
                )}

                {selected.kind === 'label' && 'text' in selectedObj && (
                  <input
                    type="text"
                    value={selectedObj.text}
                    onChange={(e) =>
                      onChangeModel({
                        ...model,
                        textLabels: model.textLabels.map((t) =>
                          t.id === selected.id ? { ...t, text: e.target.value } : t
                        ),
                      })
                    }
                    className="w-full px-2 py-1 text-xs rounded bg-[#0d1117] border border-slate-700 text-white"
                  />
                )}

                <button
                  type="button"
                  onClick={deleteSelected}
                  className="w-full py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-medium flex items-center justify-center gap-1"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Delete Detection
                </button>
              </div>
            )}
          </div>

          {/* CAD Layer Controls */}
          <div className="bg-[#11161f] border border-slate-800 rounded-xl p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
              <Layers className="w-3.5 h-3.5 text-sky-400" />
              2D Layers
            </div>
            <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
              {layers.map((layer) => {
                const isRefLayer = layer.id === 'referenceImage';
                return (
                  <div
                    key={layer.id}
                    className="flex items-center justify-between px-2 py-1 rounded bg-[#0d1117] border border-slate-800/80 text-[11px]"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: layer.color }}
                      />
                      <span className="text-slate-200 truncate">{layer.label}</span>
                      {isRefLayer && (
                        <span className="px-1 py-0.2 rounded bg-slate-800 text-[9px] text-amber-300 shrink-0">
                          Locked Ref
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => toggleLayerVisibility(layer.id)}
                        className="p-1 text-slate-400 hover:text-white"
                        title={layer.visible ? 'Hide layer' : 'Show layer'}
                      >
                        {layer.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5 text-slate-600" />}
                      </button>
                      <button
                        type="button"
                        disabled={isRefLayer}
                        onClick={() => toggleLayerLock(layer.id)}
                        className="p-1 text-slate-400 hover:text-white disabled:opacity-60"
                        title={isRefLayer ? 'Reference PDF stays permanently locked' : layer.locked ? 'Unlock layer' : 'Lock layer'}
                      >
                        {isRefLayer || layer.locked ? <Lock className="w-3 h-3 text-amber-400" /> : <Unlock className="w-3 h-3" />}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
