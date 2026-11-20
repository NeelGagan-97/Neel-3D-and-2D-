import React, { useMemo, useState } from 'react';
import { ROOM_LIBRARY } from '../data/presets';
import { ProjectData, RoomType } from '../types/design';
import {
  findNearestValidPosition,
  formatArea,
  fromMeters,
  toMeters,
  validateRoomPlacement,
} from '../utils/geometry';

interface CreateRoomModalProps {
  project: ProjectData;
  initialX: number; // meters
  initialY: number; // meters
  initialRoomType?: RoomType;
  onCancel: () => void;
  onPlaceRoom: (payload: {
    name: string;
    type: RoomType;
    x: number;
    y: number;
    width: number;
    height: number;
    finish: 'wood' | 'tile' | 'stone' | 'terrazzo';
  }) => void;
}

export const CreateRoomModal: React.FC<CreateRoomModalProps> = ({
  project,
  initialX,
  initialY,
  initialRoomType,
  onCancel,
  onPlaceRoom,
}) => {
  const units = project.site.units;
  const initialTemplate =
    ROOM_LIBRARY.find((r) => r.type === initialRoomType) ?? ROOM_LIBRARY[2]; // Kitchen default if unset

  const [selectedType, setSelectedType] = useState<RoomType>(initialTemplate.type);
  const [customName, setCustomName] = useState<string>(() => {
    const count = project.rooms.filter((r) => r.type === initialTemplate.type).length;
    return count > 0 ? `${initialTemplate.label} ${count + 1}` : initialTemplate.label;
  });

  const [lengthInput, setLengthInput] = useState<number>(() =>
    units === 'ft'
      ? initialTemplate.defaultLengthFt
      : Number(initialTemplate.defaultW.toFixed(1))
  );
  const [widthInput, setWidthInput] = useState<number>(() =>
    units === 'ft'
      ? initialTemplate.defaultWidthFt
      : Number(initialTemplate.defaultH.toFixed(1))
  );

  // Position in project display units (ft or m), anchored cleanly at clicked point
  const [posXInput, setPosXInput] = useState<number>(() =>
    Number(Math.max(0, fromMeters(initialX, units)).toFixed(1))
  );
  const [posYInput, setPosYInput] = useState<number>(() =>
    Number(Math.max(0, fromMeters(initialY, units)).toFixed(1))
  );

  const handleSelectRoomType = (type: RoomType) => {
    const tpl = ROOM_LIBRARY.find((r) => r.type === type) ?? ROOM_LIBRARY[0];
    setSelectedType(type);
    const existingCount = project.rooms.filter((r) => r.type === type).length;
    setCustomName(existingCount > 0 ? `${tpl.label} ${existingCount + 1}` : tpl.label);
    setLengthInput(units === 'ft' ? tpl.defaultLengthFt : Number(tpl.defaultW.toFixed(1)));
    setWidthInput(units === 'ft' ? tpl.defaultWidthFt : Number(tpl.defaultH.toFixed(1)));
  };

  const widthM = toMeters(lengthInput, units);
  const heightM = toMeters(widthInput, units);
  const xM = toMeters(posXInput, units);
  const yM = toMeters(posYInput, units);

  const calculatedAreaSqM = widthM > 0 && heightM > 0 ? widthM * heightM : 0;

  const validation = useMemo(
    () =>
      validateRoomPlacement(
        { x: xM, y: yM, width: widthM, height: heightM },
        project
      ),
    [xM, yM, widthM, heightM, project]
  );

  const suggestedPos = useMemo(() => {
    if (validation.valid || widthM <= 0.1 || heightM <= 0.1) return null;
    return findNearestValidPosition(xM, yM, widthM, heightM, project);
  }, [validation.valid, xM, yM, widthM, heightM, project]);

  const handleApplySuggestion = () => {
    if (!suggestedPos) return;
    setPosXInput(Number(fromMeters(suggestedPos.x, units).toFixed(2)));
    setPosYInput(Number(fromMeters(suggestedPos.y, units).toFixed(2)));
  };

  const handlePlace = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validation.valid) return;
    const tpl = ROOM_LIBRARY.find((r) => r.type === selectedType) ?? ROOM_LIBRARY[0];
    onPlaceRoom({
      name: customName.trim() || tpl.label,
      type: selectedType,
      x: Number(xM.toFixed(3)),
      y: Number(yM.toFixed(3)),
      width: Number(widthM.toFixed(3)),
      height: Number(heightM.toFixed(3)),
      finish: tpl.finish,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-deep-navy/85 flex items-center justify-center p-gutter-md overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-room-modal-title"
    >
      <form
        onSubmit={handlePlace}
        className="w-full max-w-2xl bg-surface-container border border-outline rounded-lg overflow-hidden my-auto"
      >
        {/* Header */}
        <div className="px-gutter-xl py-gutter-lg border-b border-outline-variant bg-surface-container-high flex items-center justify-between">
          <div>
            <h2 id="create-room-modal-title" className="font-headline text-headline-sm text-on-surface">
              What would you like to create here?
            </h2>
            <p className="font-mono text-mono-sm text-on-surface-variant">
              SELECT ROOM TYPE &amp; CONFIGURE EXACT ARCHITECTURAL DIMENSIONS
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close modal"
            className="text-on-surface-variant hover:text-on-surface cursor-pointer p-1"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <div className="p-gutter-xl flex flex-col gap-gutter-lg max-h-[75vh] overflow-y-auto">
          {/* Room Type Picker Grid */}
          <div>
            <span className="block font-label text-label-sm text-on-surface-variant uppercase tracking-wider mb-gutter-sm">
              Room Type
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-gutter-xs">
              {ROOM_LIBRARY.map((rm) => {
                const isSelected = selectedType === rm.type;
                return (
                  <button
                    key={rm.type}
                    type="button"
                    onClick={() => handleSelectRoomType(rm.type)}
                    className={`flex items-center gap-gutter-xs px-gutter-sm py-gutter-sm rounded-sm border text-left transition-colors duration-state-change cursor-pointer ${
                      isSelected
                        ? 'bg-primary-container border-primary text-on-primary-container'
                        : 'bg-surface-container-low border-outline-variant text-on-surface-variant hover:border-outline hover:text-on-surface'
                    }`}
                  >
                    <span
                      className={`material-symbols-outlined text-[16px] shrink-0 ${
                        isSelected ? 'text-primary' : 'text-on-surface-variant'
                      }`}
                      aria-hidden="true"
                    >
                      {rm.icon}
                    </span>
                    <span className="font-label text-label-sm truncate">{rm.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Room Label + Dimensions */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-gutter-md">
            <label className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-sm text-on-surface-variant">Room Name</span>
              <input
                type="text"
                required
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                className="w-full bg-surface border border-outline rounded-sm px-gutter-md py-gutter-sm font-body text-body-md text-on-surface focus:border-primary focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-sm text-on-surface-variant">
                Length ({units})
              </span>
              <input
                type="number"
                step="0.5"
                min={0.5}
                required
                value={lengthInput}
                onChange={(e) => setLengthInput(Number(e.target.value))}
                className="w-full bg-surface border border-outline rounded-sm px-gutter-md py-gutter-sm font-mono text-mono-md text-on-surface tabular-nums focus:border-primary focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-sm text-on-surface-variant">
                Width ({units})
              </span>
              <input
                type="number"
                step="0.5"
                min={0.5}
                required
                value={widthInput}
                onChange={(e) => setWidthInput(Number(e.target.value))}
                className="w-full bg-surface border border-outline rounded-sm px-gutter-md py-gutter-sm font-mono text-mono-md text-on-surface tabular-nums focus:border-primary focus:outline-none"
              />
            </label>
          </div>

          {/* Placement Origin + Calculated Area */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-gutter-md items-end bg-surface-container-low border border-outline-variant rounded-md p-gutter-md">
            <label className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-sm text-on-surface-variant">
                X Position ({units})
              </span>
              <input
                type="number"
                step="0.5"
                value={posXInput}
                onChange={(e) => setPosXInput(Number(e.target.value))}
                className="w-full bg-surface border border-outline rounded-sm px-gutter-sm py-gutter-xs font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-sm text-on-surface-variant">
                Y Position ({units})
              </span>
              <input
                type="number"
                step="0.5"
                value={posYInput}
                onChange={(e) => setPosYInput(Number(e.target.value))}
                className="w-full bg-surface border border-outline rounded-sm px-gutter-sm py-gutter-xs font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
              />
            </label>

            <div className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-sm text-on-surface-variant">
                Calculated Area
              </span>
              <span className="font-mono text-headline-sm text-primary tabular-nums">
                {formatArea(calculatedAreaSqM, units)}
              </span>
            </div>
          </div>

          {/* Geometric Validation Warning (never silently resizes!) */}
          {!validation.valid && (
            <div
              role="alert"
              className="p-gutter-md rounded-md bg-secondary-container/70 border border-secondary flex flex-col sm:flex-row sm:items-center justify-between gap-gutter-sm"
            >
              <div className="flex items-start gap-gutter-sm">
                <span className="material-symbols-outlined text-secondary text-[20px] shrink-0 mt-0.5">
                  warning
                </span>
                <span className="font-body text-body-sm text-on-secondary-container">
                  {validation.reason}
                </span>
              </div>
              {suggestedPos && (
                <button
                  type="button"
                  onClick={handleApplySuggestion}
                  className="px-gutter-md py-gutter-xs rounded-sm bg-secondary text-on-secondary font-label text-label-sm whitespace-nowrap shrink-0 cursor-pointer hover:opacity-90"
                >
                  Snap to Valid Spot
                </button>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-gutter-xl py-gutter-md border-t border-outline-variant bg-surface-container-low flex items-center justify-end gap-gutter-sm">
          <button
            type="button"
            onClick={onCancel}
            className="px-gutter-lg py-gutter-sm rounded-sm border border-outline text-on-surface-variant hover:text-on-surface font-label text-label-md cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!validation.valid}
            className="inline-flex items-center gap-gutter-xs px-gutter-xl py-gutter-sm rounded-sm bg-primary text-on-primary font-label text-label-md hover:bg-on-primary-container transition-colors duration-state-change cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              add_location_alt
            </span>
            <span>Place Room</span>
          </button>
        </div>
      </form>
    </div>
  );
};
