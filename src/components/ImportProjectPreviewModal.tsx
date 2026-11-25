import React, { useState } from 'react';
import { ParsedImportPreview } from '../services/projectStorage';
import { BUILDING_TYPE_LABELS, getProjectFloors, inferBuildingType } from '../utils/buildingWiring';

interface ImportProjectPreviewModalProps {
  preview: ParsedImportPreview | null;
  onCancel: () => void;
  onConfirmImport: (finalName: string) => void;
}

export const ImportProjectPreviewModal: React.FC<ImportProjectPreviewModalProps> = ({
  preview,
  onCancel,
  onConfirmImport,
}) => {
  const [nameInput, setNameInput] = useState(preview?.project.name ?? '');

  React.useEffect(() => {
    if (preview) {
      setNameInput(preview.project.name);
    }
  }, [preview]);

  if (!preview) return null;

  const p = preview.project;
  const floors = getProjectFloors(p);
  const bType = inferBuildingType(p);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Import Project Preview"
    >
      <div className="w-full max-w-lg bg-surface-container border border-outline shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-outline bg-surface-container-low">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-secondary">
              SAFE PROJECT IMPORT PREVIEW
            </p>
            <h2 className="font-headline text-base font-semibold text-on-surface mt-0.5">
              Review Project Before Importing
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="p-1 text-on-surface-variant hover:text-on-surface cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        <div className="p-5 space-y-4 text-xs">
          <div className="border border-outline bg-surface p-3 space-y-2">
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span className="text-on-surface-variant">File Format</span>
              <span className="text-secondary">
                {preview.formatLabel} ({preview.schemaVersion})
              </span>
            </div>
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span className="text-on-surface-variant">Building Typology</span>
              <span className="text-on-surface">{BUILDING_TYPE_LABELS[bType]}</span>
            </div>
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span className="text-on-surface-variant">Site Dimensions</span>
              <span className="text-on-surface">
                {p.site.length} × {p.site.width} {p.site.units} ({floors.length} Floor
                {floors.length > 1 ? 's' : ''})
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2 pt-2 border-t border-outline/60 text-center font-mono">
              <div className="bg-surface-container-low p-2 border border-outline/50">
                <div className="text-sm font-semibold text-on-surface">{p.rooms.length}</div>
                <div className="text-[10px] text-on-surface-variant">Rooms</div>
              </div>
              <div className="bg-surface-container-low p-2 border border-outline/50">
                <div className="text-sm font-semibold text-on-surface">{p.points.length}</div>
                <div className="text-[10px] text-on-surface-variant">Electrical</div>
              </div>
              <div className="bg-surface-container-low p-2 border border-outline/50">
                <div className="text-sm font-semibold text-on-surface">{(p.wires ?? []).length}</div>
                <div className="text-[10px] text-on-surface-variant">Wires</div>
              </div>
              <div className="bg-surface-container-low p-2 border border-outline/50">
                <div className="text-sm font-semibold text-on-surface">
                  {(p.staircases ?? []).length}
                </div>
                <div className="text-[10px] text-on-surface-variant">Stairs</div>
              </div>
            </div>
          </div>

          <label className="block space-y-1">
            <span className="font-mono text-[10px] uppercase text-on-surface-variant">
              Imported Project Name (Created as New Project — Existing Projects Are Never Overwritten)
            </span>
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              className="w-full px-3 py-2 bg-surface border border-outline text-on-surface"
            />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-outline bg-surface-container-low">
          <button
            type="button"
            onClick={onCancel}
            className="px-3.5 py-1.5 text-xs font-label border border-outline bg-surface text-on-surface-variant hover:text-on-surface cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirmImport(nameInput.trim() || p.name)}
            className="px-4 py-1.5 text-xs font-label bg-primary text-on-primary cursor-pointer"
          >
            Import as New Project
          </button>
        </div>
      </div>
    </div>
  );
};
