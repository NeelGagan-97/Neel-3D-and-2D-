import React, { useMemo, useState } from 'react';
import { ProductCatalogueItem } from '../types/catalogue';
import {
  CableMaterial,
  CircuitId,
  WireCategory,
  WireRoutingMode,
} from '../types/design';
import {
  CableInstallationCondition,
  evaluateCableSizingEngineering,
  SELECTABLE_WIRE_SIZES_SQ_MM,
} from '../utils/buildingWiring';

export interface ActiveCableConfigState {
  productId: string;
  wireType: string;
  brand: string;
  manufacturer: string;
  productName: string;
  modelNumber: string;
  specification: string;
  cableSizeSqMm: number | null;
  cableMaterial: CableMaterial;
  unit?: string;
  unitPricePerM?: number;
  mrpPerM?: number;
  discountPercent?: number;
  gstPercent?: number;
  variantSku?: string;
  variantLabel?: string;
  priceCapturedAt?: string;
  routeHeightZ: string;
}

interface CableConfigModalProps {
  open: boolean;
  category: WireCategory;
  routingMode: WireRoutingMode;
  gridSnap: boolean;
  cableSpec: ActiveCableConfigState;
  cableCatalogueProducts: ProductCatalogueItem[];
  startPointLabel?: string | null;
  startPointCircuit?: CircuitId | '';
  startPointLoadW?: number;
  onConfirm: (result: {
    category: WireCategory;
    routingMode: WireRoutingMode;
    gridSnap: boolean;
    cableSpec: ActiveCableConfigState;
  }) => void;
  onCancel: () => void;
}

const CONDUCTOR_OPTIONS: Array<{
  id: WireCategory;
  label: string;
  short: string;
  color: string;
}> = [
  { id: 'phase', label: 'Phase (L)', short: 'Live / Phase', color: '#EF4444' },
  { id: 'neutral', label: 'Neutral (N)', short: 'Return Neutral', color: '#3B82F6' },
  { id: 'earth', label: 'Earth (E)', short: 'Protective Earth', color: '#22C55E' },
  { id: 'control', label: 'Control', short: 'Switch Wire', color: '#F59E0B' },
  { id: 'communication', label: 'Data / Comm', short: 'Low Voltage', color: '#A855F7' },
];

export const CableConfigModal: React.FC<CableConfigModalProps> = ({
  open,
  category,
  routingMode,
  gridSnap,
  cableSpec,
  cableCatalogueProducts,
  startPointLabel,
  startPointCircuit,
  startPointLoadW,
  onConfirm,
  onCancel,
}) => {
  const [draftCategory, setDraftCategory] = useState<WireCategory>(category);
  const [draftRoutingMode, setDraftRoutingMode] = useState<WireRoutingMode>(routingMode);
  const [draftGridSnap, setDraftGridSnap] = useState<boolean>(gridSnap);
  const [draftSpec, setDraftSpec] = useState<ActiveCableConfigState>(cableSpec);
  const [installCond, setInstallCond] =
    useState<CableInstallationCondition>('concealed-conduit');

  // Sync modal draft whenever opened
  React.useEffect(() => {
    if (!open) return;
    setDraftCategory(category);
    setDraftRoutingMode(routingMode);
    setDraftGridSnap(gridSnap);
    setDraftSpec(cableSpec);
  }, [open, category, routingMode, gridSnap, cableSpec]);

  const availableBrands = useMemo(() => {
    const set = new Set<string>();
    cableCatalogueProducts.forEach((p) => {
      const b = (p.brand || p.manufacturer || '').trim();
      if (b) set.add(b);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [cableCatalogueProducts]);

  const filteredCatalogueProducts = useMemo(() => {
    const brandLower = draftSpec.brand.trim().toLowerCase();
    return cableCatalogueProducts.filter((p) => {
      if (brandLower) {
        const pBrand = (p.brand || p.manufacturer || '').toLowerCase();
        if (!pBrand.includes(brandLower)) return false;
      }
      return true;
    });
  }, [cableCatalogueProducts, draftSpec.brand]);

  const engineering = useMemo(
    () =>
      evaluateCableSizingEngineering({
        cableSizeSqMm: draftSpec.cableSizeSqMm,
        cableMaterial: draftSpec.cableMaterial,
        category: draftCategory,
        circuit: startPointCircuit ?? '',
        loadWatts: startPointLoadW,
        routeLengthM: 12, // representative preliminary run estimate prior to drawing
        installationCondition: installCond,
      }),
    [
      draftSpec.cableSizeSqMm,
      draftSpec.cableMaterial,
      draftCategory,
      startPointCircuit,
      startPointLoadW,
      installCond,
    ]
  );

  if (!open) return null;

  const handleSelectCatalogueProduct = (prodId: string) => {
    const prod = cableCatalogueProducts.find((p) => p.id === prodId);
    if (!prod) {
      setDraftSpec((prev) => ({ ...prev, productId: '' }));
      return;
    }
    const inferredMat: CableMaterial = /alum/i.test(
      `${prod.productName} ${prod.specification ?? ''}`
    )
      ? 'Aluminium'
      : /cat6|fiber|data|coax/i.test(`${prod.productName} ${prod.specification ?? ''}`)
        ? 'Unspecified'
        : 'Copper';
    setDraftSpec((prev) => ({
      ...prev,
      productId: prod.id,
      wireType: prod.productName,
      brand: prod.brand || prod.manufacturer,
      manufacturer: prod.manufacturer,
      productName: prod.productName,
      modelNumber: prod.modelNumber ?? '',
      specification: prod.specification ?? prev.specification,
      cableSizeSqMm: prod.cableSizeSqMm ?? prev.cableSizeSqMm,
      cableMaterial: inferredMat,
      unit: prod.unit || 'm',
      unitPricePerM: prod.unitPrice ?? undefined,
      mrpPerM: prod.mrp ?? undefined,
      discountPercent: prod.discountPercent ?? undefined,
      gstPercent: prod.gstPercent ?? undefined,
      variantSku: prod.sku || undefined,
      priceCapturedAt: new Date().toISOString(),
    }));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cable-config-modal-title"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-xs p-4"
    >
      <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-lg bg-surface-container border border-outline shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-outline-variant bg-surface-container-high">
          <div className="flex items-center gap-2">
            <span
              className="material-symbols-outlined text-secondary text-[20px]"
              aria-hidden="true"
            >
              cable
            </span>
            <div className="flex flex-col">
              <h2
                id="cable-config-modal-title"
                className="font-label text-label-md text-on-surface uppercase tracking-wider"
              >
                Cable Configuration — Route Cable
              </h2>
              <span className="font-mono text-[11px] text-on-surface-variant">
                {startPointLabel
                  ? `Starting from ${startPointLabel} · Free-style drawing ready after confirm`
                  : 'Select wire size, conductor type & catalogue specification before drawing'}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close cable configuration popup"
            className="p-1 rounded-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-container cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="p-4 flex flex-col gap-3.5">
          {/* 1. Conductor / Cable Type (Phase, Neutral, Earth + optional Control/Data) */}
          <div className="flex flex-col gap-1.5">
            <span className="font-label text-[11px] uppercase tracking-wider text-on-surface-variant">
              1. Conductor Type
            </span>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
              {CONDUCTOR_OPTIONS.map((opt) => {
                const active = draftCategory === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setDraftCategory(opt.id)}
                    className={`flex flex-col items-start gap-0.5 px-2.5 py-2 rounded-sm border text-left transition-colors cursor-pointer ${
                      active
                        ? 'bg-surface-container-high border-primary text-on-surface'
                        : 'bg-surface-container-low border-outline-variant text-on-surface-variant hover:border-outline'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: opt.color }}
                      />
                      <span className="font-label text-xs font-semibold">{opt.label}</span>
                    </div>
                    <span className="font-mono text-[9px] text-on-surface-variant">
                      {opt.short}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. Wire Size (sq.mm): 1, 1.5, 2, 2.5, 3, 4 */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="font-label text-[11px] uppercase tracking-wider text-on-surface-variant">
                2. Wire Size (sq.mm)
              </span>
              <span className="font-mono text-[10px] text-primary">
                Selected: {draftSpec.cableSizeSqMm ? `${draftSpec.cableSizeSqMm} sq.mm` : 'Not set'}
              </span>
            </div>
            <div className="grid grid-cols-6 gap-1.5">
              {SELECTABLE_WIRE_SIZES_SQ_MM.map((sz) => {
                const active = draftSpec.cableSizeSqMm === sz;
                return (
                  <button
                    key={sz}
                    type="button"
                    onClick={() =>
                      setDraftSpec((prev) => ({
                        ...prev,
                        cableSizeSqMm: sz,
                      }))
                    }
                    className={`px-2 py-2 rounded-sm border font-mono text-xs tabular-nums transition-colors cursor-pointer ${
                      active
                        ? 'bg-primary text-on-primary border-primary font-bold'
                        : 'bg-surface-container-low border-outline-variant text-on-surface hover:border-primary'
                    }`}
                  >
                    {sz} mm²
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3. Brand & Catalogue Product Specification */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <label className="flex flex-col gap-1">
              <span className="font-label text-[11px] uppercase tracking-wider text-on-surface-variant">
                3. Brand (Catalogue or Custom)
              </span>
              <div className="flex gap-1.5">
                {availableBrands.length > 0 && (
                  <select
                    aria-label="Filter cable brand from catalogue"
                    value={availableBrands.includes(draftSpec.brand) ? draftSpec.brand : ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      setDraftSpec((prev) => ({
                        ...prev,
                        brand: val,
                        manufacturer: val,
                        productId: '',
                      }));
                    }}
                    className="w-1/2 bg-surface border border-outline rounded-sm px-2 py-1.5 font-body text-xs text-on-surface"
                  >
                    <option value="">All Brands</option>
                    {availableBrands.map((b) => (
                      <option key={b} value={b} className="bg-surface-container">
                        {b}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  type="text"
                  placeholder="e.g. Polycab, Finolex, Havells"
                  value={draftSpec.brand}
                  onChange={(e) =>
                    setDraftSpec((prev) => ({
                      ...prev,
                      brand: e.target.value,
                      manufacturer: e.target.value,
                    }))
                  }
                  className="flex-1 min-w-0 bg-surface border border-outline rounded-sm px-2 py-1.5 font-body text-xs text-on-surface"
                />
              </div>
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-label text-[11px] uppercase tracking-wider text-on-surface-variant">
                Conductor Material
              </span>
              <select
                value={draftSpec.cableMaterial}
                onChange={(e) =>
                  setDraftSpec((prev) => ({
                    ...prev,
                    cableMaterial: e.target.value as CableMaterial,
                  }))
                }
                className="bg-surface border border-outline rounded-sm px-2 py-1.5 font-body text-xs text-on-surface"
              >
                <option value="Copper">Copper (Cu)</option>
                <option value="Aluminium">Aluminium (Al)</option>
                <option value="Unspecified">Other / Unspecified</option>
              </select>
            </label>
          </div>

          <div className="flex flex-col gap-1">
            <span className="font-label text-[11px] uppercase tracking-wider text-on-surface-variant">
              4. Catalogue Product &amp; Specification ({filteredCatalogueProducts.length} available)
            </span>
            <select
              aria-label="Catalogue cable product"
              value={draftSpec.productId}
              onChange={(e) => handleSelectCatalogueProduct(e.target.value)}
              className="w-full bg-surface border border-outline rounded-sm px-2 py-1.5 font-body text-xs text-on-surface"
            >
              <option value="">Custom / Manual Cable Specification...</option>
              {filteredCatalogueProducts.map((p) => (
                <option key={p.id} value={p.id} className="bg-surface-container">
                  {p.manufacturer} — {p.productName}
                  {p.cableSizeSqMm ? ` (${p.cableSizeSqMm} sq.mm)` : ''}
                  {p.unitPrice !== null ? ` · ₹${p.unitPrice}/${p.unit}` : ''}
                </option>
              ))}
            </select>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
              <label className="flex flex-col gap-0.5">
                <span className="font-label text-[10px] text-on-surface-variant">Cable Type</span>
                <input
                  type="text"
                  value={draftSpec.wireType}
                  placeholder="FR-LSH PVC Insulated Copper"
                  onChange={(e) =>
                    setDraftSpec((prev) => ({ ...prev, wireType: e.target.value }))
                  }
                  className="bg-surface border border-outline rounded-sm px-2 py-1 font-body text-xs text-on-surface"
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="font-label text-[10px] text-on-surface-variant">
                  Technical Specification
                </span>
                <input
                  type="text"
                  value={draftSpec.specification}
                  placeholder="IS 694 1100V Multi-strand"
                  onChange={(e) =>
                    setDraftSpec((prev) => ({ ...prev, specification: e.target.value }))
                  }
                  className="bg-surface border border-outline rounded-sm px-2 py-1 font-mono text-[11px] text-on-surface"
                />
              </label>
            </div>
          </div>

          {/* 5. Drawing Style (Free-Style Default) & Optional Orthogonal / Grid Snap */}
          <div className="p-2.5 rounded-sm bg-surface-container-low border border-outline-variant flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-label text-[11px] uppercase tracking-wider text-primary">
                5. Routing Style &amp; Snapping
              </span>
              <div className="flex items-center gap-1">
                {(
                  [
                    { id: 'freeform', label: 'Free-Style (Default)' },
                    { id: 'curved', label: 'Curved Free-Style' },
                    { id: 'orthogonal', label: 'Orthogonal (90°)' },
                  ] as Array<{ id: WireRoutingMode; label: string }>
                ).map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => setDraftRoutingMode(mode.id)}
                    className={`px-2 py-1 rounded-sm border font-label text-[11px] cursor-pointer ${
                      draftRoutingMode === mode.id
                        ? 'bg-primary text-on-primary border-primary font-semibold'
                        : 'bg-surface border-outline text-on-surface-variant hover:text-on-surface'
                    }`}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-outline-variant/60">
              <label className="inline-flex items-center gap-1.5 cursor-pointer text-xs text-on-surface-variant">
                <input
                  type="checkbox"
                  checked={draftGridSnap}
                  onChange={(e) => setDraftGridSnap(e.target.checked)}
                  className="accent-primary"
                />
                <span>Optional Grid Snapping (off = smooth free cursor movement)</span>
              </label>
              <label className="inline-flex items-center gap-1.5 font-mono text-[11px] text-on-surface-variant">
                <span>Route Height Z (m):</span>
                <input
                  type="number"
                  step="0.1"
                  min={0.05}
                  placeholder="Auto"
                  value={draftSpec.routeHeightZ}
                  onChange={(e) =>
                    setDraftSpec((prev) => ({ ...prev, routeHeightZ: e.target.value }))
                  }
                  className="w-16 bg-surface border border-outline rounded-sm px-1.5 py-0.5 font-mono text-xs text-on-surface"
                />
              </label>
            </div>
            <p className="font-body text-[11px] text-on-surface-variant">
              Tip: Click a source component, then click to add intermediate bends or hold &amp; drag for smooth freehand paths; click or double-click a destination component to finish.
            </p>
          </div>

          {/* 6. Engineering Cable-Sizing Advisory & Non-Certification Notice */}
          <div className="p-2.5 rounded-sm bg-surface-container-low border border-secondary/50 flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase font-semibold text-secondary">
                Engineering Cable-Sizing Advisory (Non-Certified Estimate)
              </span>
              <select
                aria-label="Installation condition"
                value={installCond}
                onChange={(e) => setInstallCond(e.target.value as CableInstallationCondition)}
                className="bg-surface border border-outline rounded-sm px-1.5 py-0.5 font-mono text-[10px] text-on-surface"
              >
                <option value="concealed-conduit">Concealed Conduit (0.80 derate)</option>
                <option value="surface-conduit">Surface Conduit (0.88 derate)</option>
                <option value="cable-tray">Open Cable Tray (0.95 derate)</option>
              </select>
            </div>

            {engineering.deratedAmpacityA !== null && (
              <div className="flex flex-wrap gap-3 font-mono text-[10px] text-on-surface-variant">
                <span>Est. Load: {engineering.estimatedLoadW} W ({engineering.estimatedCurrentA} A)</span>
                <span>Derated Capacity: ~{engineering.deratedAmpacityA} A</span>
                {engineering.recommendedMaxBreakerA !== null && (
                  <span>Typical Max MCB: ≤{engineering.recommendedMaxBreakerA} A</span>
                )}
              </div>
            )}

            <div className="flex flex-col gap-1">
              {engineering.warnings.map((w, idx) => (
                <div
                  key={`${w.code}-${idx}`}
                  className={`px-2 py-1 rounded-sm border font-body text-[11px] leading-snug ${
                    w.severity === 'error'
                      ? 'bg-error/15 border-error text-error'
                      : w.severity === 'warning'
                        ? 'bg-secondary-container/25 border-secondary/70 text-on-surface'
                        : 'bg-surface border-outline-variant text-on-surface-variant'
                  }`}
                >
                  <span className="font-mono text-[9px] uppercase font-bold mr-1">
                    [{w.severity}]
                  </span>
                  {w.message}
                </div>
              ))}
            </div>

            <p className="font-body text-[10px] text-on-surface-variant italic leading-snug pt-0.5">
              {engineering.disclaimer}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-outline-variant bg-surface-container-high">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-sm bg-surface-container border border-outline text-on-surface-variant hover:text-on-surface font-label text-label-sm cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              onConfirm({
                category: draftCategory,
                routingMode: draftRoutingMode,
                gridSnap: draftGridSnap,
                cableSpec: draftSpec,
              })
            }
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-sm bg-primary text-on-primary hover:brightness-110 font-label text-label-sm font-semibold cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              gesture
            </span>
            <span>
              {draftRoutingMode === 'orthogonal'
                ? 'Start Orthogonal Routing'
                : 'Start Free-Style Routing'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
