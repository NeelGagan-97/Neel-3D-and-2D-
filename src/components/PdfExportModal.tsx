import React, { useState } from 'react';
import { ProjectData } from '../types/design';
import {
  DEFAULT_PDF_PACKAGE_OPTIONS,
  downloadProjectPdfPackage,
  PdfOrientation,
  PdfPackageOptions,
  PdfPageSize,
  PdfScaleOption,
} from '../utils/pdfPackageExporter';

interface PdfExportModalProps {
  open: boolean;
  project: ProjectData;
  wireProcurementAllowancePct?: number;
  onClose: () => void;
  onExported?: (pageCount: number) => void;
}

export const PdfExportModal: React.FC<PdfExportModalProps> = ({
  open,
  project,
  wireProcurementAllowancePct,
  onClose,
  onExported,
}) => {
  const [opts, setOpts] = useState<PdfPackageOptions>(DEFAULT_PDF_PACKAGE_OPTIONS);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  if (!open) return null;

  const handleExport = () => {
    setExportError(null);
    setExporting(true);
    window.setTimeout(() => {
      try {
        const count = downloadProjectPdfPackage(project, {
          ...opts,
          ...(wireProcurementAllowancePct !== undefined
            ? { wireProcurementAllowancePct }
            : {}),
        });
        onExported?.(count);
        onClose();
      } catch (err) {
        console.error('[PDF Export] Failed to generate PDF drawing package:', err);
        setExportError(
          err instanceof Error
            ? err.message
            : 'Unable to generate PDF package. Please check console for details.'
        );
      } finally {
        setExporting(false);
      }
    }, 30);
  };

  const toggle = (key: keyof PdfPackageOptions) => {
    setOpts((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Export Architectural & Electrical Drawing Package PDF"
    >
      <div className="w-full max-w-xl bg-surface-container border border-outline shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-outline bg-surface-container-low">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-secondary">
              MULTI-PAGE DRAWING PACKAGE (PDF)
            </p>
            <h2 className="font-headline text-base font-semibold text-on-surface mt-0.5">
              Configure Engineering PDF Package
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-on-surface-variant hover:text-on-surface cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        <div className="p-5 space-y-4 text-xs">
          {/* Page Setup */}
          <div className="grid grid-cols-3 gap-3">
            <label className="space-y-1">
              <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                Page Size
              </span>
              <select
                value={opts.pageSize}
                onChange={(e) => setOpts((p) => ({ ...p, pageSize: e.target.value as PdfPageSize }))}
                className="w-full px-2.5 py-1.5 bg-surface border border-outline text-on-surface"
              >
                <option value="a4">A4</option>
                <option value="a3">A3 (Recommended)</option>
                <option value="a2">A2 (Large Format)</option>
              </select>
            </label>

            <label className="space-y-1">
              <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                Orientation
              </span>
              <select
                value={opts.orientation}
                onChange={(e) =>
                  setOpts((p) => ({ ...p, orientation: e.target.value as PdfOrientation }))
                }
                className="w-full px-2.5 py-1.5 bg-surface border border-outline text-on-surface"
              >
                <option value="landscape">Landscape</option>
                <option value="portrait">Portrait</option>
              </select>
            </label>

            <label className="space-y-1">
              <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                Drawing Scale
              </span>
              <select
                value={opts.scale}
                onChange={(e) => setOpts((p) => ({ ...p, scale: e.target.value as PdfScaleOption }))}
                className="w-full px-2.5 py-1.5 bg-surface border border-outline text-on-surface"
              >
                <option value="auto">Auto Fit</option>
                <option value="1:50">1:50</option>
                <option value="1:100">1:100</option>
                <option value="1:200">1:200</option>
              </select>
            </label>
          </div>

          <label className="flex items-center gap-2 border border-outline bg-surface px-3 py-2 cursor-pointer">
            <input
              type="checkbox"
              checked={opts.includeAnnotations}
              onChange={() => toggle('includeAnnotations')}
            />
            <span className="text-on-surface">
              Include Room Dimensions, Site Measurements &amp; Wire Length Annotations
            </span>
          </label>

          {/* Sheets Selection */}
          <div className="space-y-1.5">
            <p className="font-mono text-[10px] uppercase text-on-surface-variant">
              Included Sheets (Generated Directly From Project Geometry)
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(
                [
                  ['includeCover', 'Title Page & Multi-Floor Schedule'],
                  ['includeFloorPlans', '2D Architectural Floor Plans (All Floors)'],
                  ['include3DViews', 'Orthographic Top & Isometric 3D View'],
                  ['includeElevations', 'Front, Rear, Left & Right Elevations'],
                  ['includeElectricalLayouts', 'Electrical Component Layout (All Floors)'],
                  ['includeWiringLayouts', 'Electrical Wiring & Cable Routing'],
                  ['includeDbAndEarthing', 'DB, Earthing, Circuits & Wiring Legend'],
                  ['includeSummaryAndBoq', 'Project Summary, BOQ & Diagnostics'],
                ] as [keyof PdfPackageOptions, string][]
              ).map(([key, label]) => (
                <label
                  key={key}
                  className="flex items-center gap-2 border border-outline/70 bg-surface px-2.5 py-2 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={Boolean(opts[key])}
                    onChange={() => toggle(key)}
                  />
                  <span className="text-on-surface">{label}</span>
                </label>
              ))}
            </div>
          </div>

          {exportError && (
            <div className="border border-error/60 bg-error/10 px-3 py-2 text-error font-mono text-[11px]">
              {exportError}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-outline bg-surface-container-low">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 text-xs font-label border border-outline bg-surface text-on-surface-variant hover:text-on-surface cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={exporting}
            onClick={handleExport}
            className="px-4 py-1.5 text-xs font-label bg-primary text-on-primary cursor-pointer disabled:opacity-60"
          >
            {exporting ? 'Generating Multi-Page PDF...' : 'Download PDF Package'}
          </button>
        </div>
      </div>
    </div>
  );
};
