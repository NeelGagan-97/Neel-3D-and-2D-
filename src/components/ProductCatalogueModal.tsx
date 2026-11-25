import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  addCatalogueProduct,
  CATALOGUE_CATEGORIES,
  deleteCatalogueProduct,
  downloadCatalogueCsvTemplate,
  inferMappedItemType,
  loadCatalogueProducts,
  MANUFACTURER_NAMES,
  MANUFACTURER_REFERENCES,
  parseCatalogueSpreadsheet,
  saveCatalogueProducts,
  updateCatalogueProduct,
} from '../services/productCatalogueStorage';
import { CatalogueCategory, ProductCatalogueItem } from '../types/catalogue';
import { CircuitId } from '../types/design';
import { CIRCUITS, formatINR } from '../data/presets';
import { sanitizeSafeUrl, validateSafeUrl } from '../utils/urlSecurity';

interface ProductCatalogueModalProps {
  open: boolean;
  onClose: () => void;
  isAdmin: boolean;
  activeCircuit?: CircuitId;
  onAddProductToProject: (product: ProductCatalogueItem) => void;
  onAssignCableToCircuit?: (product: ProductCatalogueItem, circuit: CircuitId) => void;
}

interface ProductFormState {
  category: CatalogueCategory;
  manufacturer: string;
  brand: string;
  productName: string;
  modelNumber: string;
  specification: string;
  rating: string;
  wattageW: string;
  cableSizeSqMm: string;
  dimensions: string;
  unit: string;
  unitPrice: string;
  gstPercent: string;
  imageUrl: string;
  datasheetUrl: string;
  manufacturerUrl: string;
}

const EMPTY_FORM: ProductFormState = {
  category: 'Cables & Wires',
  manufacturer: 'Polycab',
  brand: '',
  productName: '',
  modelNumber: '',
  specification: '',
  rating: '',
  wattageW: '',
  cableSizeSqMm: '',
  dimensions: '',
  unit: 'm',
  unitPrice: '',
  gstPercent: '',
  imageUrl: '',
  datasheetUrl: '',
  manufacturerUrl: '',
};

export const ProductCatalogueModal: React.FC<ProductCatalogueModalProps> = ({
  open,
  onClose,
  isAdmin,
  activeCircuit = 'CKT-L1 (Lighting)',
  onAddProductToProject,
  onAssignCableToCircuit,
}) => {
  const [products, setProducts] = useState<ProductCatalogueItem[]>(() => loadCatalogueProducts());
  const [tab, setTab] = useState<'browse' | 'directory' | 'compare' | 'admin'>('browse');
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<CatalogueCategory | 'ALL'>('ALL');
  const [selectedManufacturer, setSelectedManufacturer] = useState<string>('ALL');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [targetCircuit, setTargetCircuit] = useState<CircuitId>(activeCircuit);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProductFormState>(EMPTY_FORM);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setProducts(loadCatalogueProducts());
    }
  }, [open]);

  useEffect(() => {
    setTargetCircuit(activeCircuit);
  }, [activeCircuit]);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (selectedCategory !== 'ALL' && p.category !== selectedCategory) return false;
      if (
        selectedManufacturer !== 'ALL' &&
        p.manufacturer.toLowerCase() !== selectedManufacturer.toLowerCase()
      ) {
        return false;
      }
      if (!q) return true;
      return (
        p.productName.toLowerCase().includes(q) ||
        p.manufacturer.toLowerCase().includes(q) ||
        p.brand.toLowerCase().includes(q) ||
        p.modelNumber.toLowerCase().includes(q) ||
        p.specification.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
      );
    });
  }, [products, search, selectedCategory, selectedManufacturer]);

  const comparedItems = useMemo(
    () =>
      compareIds
        .map((id) => products.find((p) => p.id === id))
        .filter((p): p is ProductCatalogueItem => Boolean(p)),
    [compareIds, products]
  );

  if (!open) return null;

  const toggleCompare = (id: string) => {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 3) {
        setNotice({ kind: 'err', text: 'You can compare up to 3 products side-by-side.' });
        return prev;
      }
      return [...prev, id];
    });
  };

  const handleFormCategoryChange = (category: CatalogueCategory) => {
    setForm((prev) => ({
      ...prev,
      category,
      unit: category === 'Cables & Wires' ? 'm' : prev.unit === 'm' ? 'Nos' : prev.unit,
    }));
  };

  const startEdit = (item: ProductCatalogueItem) => {
    setEditingId(item.id);
    setForm({
      category: item.category,
      manufacturer: item.manufacturer,
      brand: item.brand,
      productName: item.productName,
      modelNumber: item.modelNumber,
      specification: item.specification,
      rating: item.rating,
      wattageW: item.wattageW !== null ? String(item.wattageW) : '',
      cableSizeSqMm: item.cableSizeSqMm !== null ? String(item.cableSizeSqMm) : '',
      dimensions: item.dimensions,
      unit: item.unit,
      unitPrice: item.unitPrice !== null ? String(item.unitPrice) : '',
      gstPercent: item.gstPercent !== null ? String(item.gstPercent) : '',
      imageUrl: item.imageUrl ?? '',
      datasheetUrl: item.datasheetUrl ?? '',
      manufacturerUrl: item.manufacturerUrl ?? '',
    });
    setTab('admin');
  };

  const handleSaveForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    const name = form.productName.trim();
    if (!name) {
      setNotice({ kind: 'err', text: 'Product name is required.' });
      return;
    }

    const imageCheck = validateSafeUrl(form.imageUrl, 'Product Image URL');
    if (!imageCheck.valid) {
      setNotice({ kind: 'err', text: imageCheck.error ?? 'Invalid Product Image URL.' });
      return;
    }
    const datasheetCheck = validateSafeUrl(form.datasheetUrl, 'Datasheet URL');
    if (!datasheetCheck.valid) {
      setNotice({ kind: 'err', text: datasheetCheck.error ?? 'Invalid Datasheet URL.' });
      return;
    }
    const manufacturerCheck = validateSafeUrl(form.manufacturerUrl, 'Manufacturer Page URL');
    if (!manufacturerCheck.valid) {
      setNotice({ kind: 'err', text: manufacturerCheck.error ?? 'Invalid Manufacturer Page URL.' });
      return;
    }

    const toNumOrNull = (val: string): number | null => {
      if (!val.trim()) return null;
      const n = Number(val);
      return Number.isFinite(n) ? n : null;
    };

    const unitPriceVal = toNumOrNull(form.unitPrice);
    if (unitPriceVal !== null && unitPriceVal < 0) {
      setNotice({ kind: 'err', text: 'Unit price cannot be negative.' });
      return;
    }
    const gstVal = toNumOrNull(form.gstPercent);
    if (gstVal !== null && (gstVal < 0 || gstVal > 100)) {
      setNotice({ kind: 'err', text: 'GST % must be between 0 and 100.' });
      return;
    }

    const payload = {
      category: form.category,
      manufacturer: form.manufacturer.trim() || 'Unspecified',
      brand: form.brand.trim() || form.manufacturer.trim() || 'Unspecified',
      productName: name,
      modelNumber: form.modelNumber.trim() || 'Not specified',
      specification: form.specification.trim(),
      rating: form.rating.trim(),
      wattageW: toNumOrNull(form.wattageW),
      cableSizeSqMm: toNumOrNull(form.cableSizeSqMm),
      dimensions: form.dimensions.trim(),
      unit: form.unit.trim() || (form.category === 'Cables & Wires' ? 'm' : 'Nos'),
      unitPrice: unitPriceVal,
      gstPercent: gstVal,
      imageUrl: imageCheck.normalized,
      datasheetUrl: datasheetCheck.normalized,
      manufacturerUrl: manufacturerCheck.normalized,
      mappedItemType: inferMappedItemType(form.category, name),
      source: 'admin-entry' as const,
    };

    const next = editingId
      ? updateCatalogueProduct(editingId, payload)
      : addCatalogueProduct(payload);

    setProducts(next);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setNotice({
      kind: 'ok',
      text: editingId
        ? `Updated catalogue product "${name}".`
        : `Added "${name}" to verified product catalogue.`,
    });
    setTab('browse');
  };

  const handleDeleteProduct = (id: string) => {
    if (!isAdmin) return;
    const next = deleteCatalogueProduct(id);
    setProducts(next);
    setCompareIds((prev) => prev.filter((x) => x !== id));
    setConfirmDeleteId(null);
    setNotice({ kind: 'ok', text: 'Removed product from catalogue.' });
  };

  const handleSpreadsheetImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !isAdmin) return;
    try {
      const buffer = await file.arrayBuffer();
      const res = await parseCatalogueSpreadsheet(buffer, {
        name: file.name,
        type: file.type,
        size: file.size,
      });
      if (res.items.length === 0) {
        setNotice({
          kind: 'err',
          text: res.errors[0] || 'No valid product rows found in uploaded spreadsheet.',
        });
        return;
      }
      const merged = [...res.items, ...products];
      saveCatalogueProducts(merged);
      setProducts(merged);
      setNotice({
        kind: 'ok',
        text: `Imported ${res.items.length} catalogue product(s) from ${file.name}${
          res.errors.length > 0 ? ` (${res.errors.length} row warning(s))` : ''
        }.`,
      });
      setTab('browse');
    } catch (err) {
      setNotice({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to import uploaded spreadsheet.',
      });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Multi-Brand Electrical Product Catalogue"
    >
      <div className="w-full max-w-6xl max-h-[90vh] flex flex-col bg-surface-container border border-outline shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-outline bg-surface-container-low">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-secondary">
              VERIFIED MULTI-BRAND ELECTRICAL CATALOGUE
            </p>
            <h2 className="font-headline text-lg font-semibold text-on-surface mt-0.5">
              Electrical Product Catalogue &amp; Official Manufacturer Directory
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <>
                <button
                  type="button"
                  onClick={downloadCatalogueCsvTemplate}
                  className="px-2.5 py-1.5 text-[11px] font-label border border-outline bg-surface text-on-surface-variant hover:text-on-surface hover:border-secondary/50 transition-colors cursor-pointer flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-[15px]">download</span>
                  CSV Template
                </button>
                <button
                  type="button"
                  onClick={() => importInputRef.current?.click()}
                  className="px-2.5 py-1.5 text-[11px] font-label border border-secondary/40 bg-secondary/10 text-secondary hover:bg-secondary/20 transition-colors cursor-pointer flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-[15px]">upload_file</span>
                  Import Excel / CSV
                </button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".xlsx,.csv"
                  onChange={handleSpreadsheetImport}
                  className="hidden"
                />
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors cursor-pointer"
              aria-label="Close catalogue"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center justify-between px-5 py-2 border-b border-outline bg-surface">
          <div className="flex items-center gap-1">
            {[
              { id: 'browse', label: `Catalogue Products (${products.length})`, icon: 'inventory_2' },
              {
                id: 'directory',
                label: `Manufacturer Directory (${MANUFACTURER_REFERENCES.length})`,
                icon: 'factory',
              },
              { id: 'compare', label: `Compare (${compareIds.length}/3)`, icon: 'compare_arrows' },
              ...(isAdmin
                ? [{ id: 'admin', label: editingId ? 'Edit Product' : 'Add Product (Admin)', icon: 'add_box' }]
                : []),
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id as typeof tab)}
                className={`px-3 py-1.5 text-xs font-label flex items-center gap-1.5 border transition-colors cursor-pointer ${
                  tab === t.id
                    ? 'bg-primary text-on-primary border-primary'
                    : 'bg-surface-container text-on-surface-variant border-outline hover:text-on-surface'
                }`}
              >
                <span className="material-symbols-outlined text-[15px]">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 text-[11px] font-mono text-on-surface-variant">
            <span>Target Cable Circuit:</span>
            <select
              value={targetCircuit}
              onChange={(e) => setTargetCircuit(e.target.value as CircuitId)}
              className="bg-surface-container border border-outline px-2 py-1 text-[11px] text-on-surface"
            >
              {CIRCUITS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Notice Banner */}
        {notice && (
          <div
            className={`px-5 py-2 text-xs font-label flex items-center justify-between border-b border-outline ${
              notice.kind === 'ok'
                ? 'bg-emerald-950/50 text-emerald-200'
                : 'bg-red-950/60 text-red-200'
            }`}
          >
            <span>{notice.text}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="text-xs underline cursor-pointer ml-4"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'browse' && (
            <div className="space-y-4">
              {/* Filter Bar */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5">
                <div className="md:col-span-5 relative">
                  <span className="material-symbols-outlined text-[16px] text-on-surface-variant absolute left-2.5 top-2.5">
                    search
                  </span>
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by product, manufacturer, brand, model, or spec..."
                    className="w-full pl-8 pr-3 py-2 text-xs bg-surface border border-outline text-on-surface placeholder:text-on-surface-variant/60"
                  />
                </div>
                <select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value as CatalogueCategory | 'ALL')}
                  className="md:col-span-4 px-2.5 py-2 text-xs bg-surface border border-outline text-on-surface"
                >
                  <option value="ALL">All Categories ({CATALOGUE_CATEGORIES.length})</option>
                  {CATALOGUE_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
                <select
                  value={selectedManufacturer}
                  onChange={(e) => setSelectedManufacturer(e.target.value)}
                  className="md:col-span-3 px-2.5 py-2 text-xs bg-surface border border-outline text-on-surface"
                >
                  <option value="ALL">All Manufacturers ({MANUFACTURER_NAMES.length})</option>
                  {MANUFACTURER_NAMES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              {/* Empty state with clear honest explanation (no invented SKUs/prices) */}
              {products.length === 0 ? (
                <div className="border border-outline bg-surface p-6 text-center space-y-3">
                  <span className="material-symbols-outlined text-[36px] text-secondary">
                    verified
                  </span>
                  <h3 className="font-headline text-base text-on-surface">
                    No Manufacturer Products Imported Yet
                  </h3>
                  <p className="text-xs text-on-surface-variant max-w-2xl mx-auto leading-relaxed">
                    To protect procurement accuracy, Blue Space never fabricates manufacturer model
                    numbers, technical datasheets, or unit prices. Use the{' '}
                    <strong className="text-on-surface">Manufacturer Directory</strong> tab to open
                    official portals (Polycab, Finolex, Havells, RR Kabel, KEI, Legrand, Schneider
                    Electric, Anchor / Panasonic, GM Modular, Philips / Signify, Wipro, Crompton,
                    Bajaj), or{' '}
                    {isAdmin
                      ? 'add verified SKUs manually or bulk-import your company Excel / CSV price list.'
                      : 'ask an administrator to upload the verified company Excel / CSV catalogue.'}
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setTab('directory')}
                      className="px-3.5 py-2 text-xs font-label border border-outline bg-surface-container text-on-surface hover:border-secondary/50 cursor-pointer"
                    >
                      Open Manufacturer Directory (13 Brands)
                    </button>
                    {isAdmin && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(null);
                            setForm(EMPTY_FORM);
                            setTab('admin');
                          }}
                          className="px-3.5 py-2 text-xs font-label bg-primary text-on-primary cursor-pointer"
                        >
                          + Add Verified Product
                        </button>
                        <button
                          type="button"
                          onClick={() => importInputRef.current?.click()}
                          className="px-3.5 py-2 text-xs font-label border border-secondary/50 bg-secondary/10 text-secondary cursor-pointer"
                        >
                          Upload Excel / CSV Catalogue
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ) : filteredProducts.length === 0 ? (
                <div className="border border-outline bg-surface p-6 text-center text-xs text-on-surface-variant">
                  No catalogue items match your current search or filter criteria.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {filteredProducts.map((item) => {
                    const isCompared = compareIds.includes(item.id);
                    const isCable = item.category === 'Cables & Wires';
                    const safeImageUrl = sanitizeSafeUrl(item.imageUrl);
                    const safeDatasheetUrl = sanitizeSafeUrl(item.datasheetUrl);
                    const safeManufacturerUrl = sanitizeSafeUrl(item.manufacturerUrl);
                    return (
                      <div
                        key={item.id}
                        className="border border-outline bg-surface flex flex-col justify-between p-3.5 gap-3"
                      >
                        <div className="space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <span className="inline-block px-1.5 py-0.5 text-[10px] font-mono uppercase bg-surface-container-high text-secondary border border-outline">
                                {item.category}
                              </span>
                              <p className="text-[11px] font-mono text-on-surface-variant mt-1">
                                {item.manufacturer} · {item.brand}
                              </p>
                            </div>
                            {safeImageUrl && (
                              <img
                                src={safeImageUrl}
                                alt={item.productName}
                                className="w-12 h-12 object-contain border border-outline bg-surface-container"
                              />
                            )}
                          </div>

                          <div>
                            <h4 className="text-sm font-medium text-on-surface leading-snug">
                              {item.productName}
                            </h4>
                            <p className="text-[11px] font-mono text-on-surface-variant mt-0.5">
                              Model: <span className="text-on-surface">{item.modelNumber}</span>
                            </p>
                          </div>

                          {item.specification && (
                            <p className="text-[11px] text-on-surface-variant leading-relaxed line-clamp-2">
                              {item.specification}
                            </p>
                          )}

                          <div className="grid grid-cols-2 gap-1.5 text-[11px] font-mono bg-surface-container-low p-2 border border-outline/60">
                            <div>
                              <span className="text-on-surface-variant block text-[10px]">
                                Rating / Size
                              </span>
                              <span className="text-on-surface">
                                {item.cableSizeSqMm !== null
                                  ? `${item.cableSizeSqMm} sq.mm`
                                  : item.wattageW !== null
                                    ? `${item.wattageW} W`
                                    : item.rating || '—'}
                              </span>
                            </div>
                            <div>
                              <span className="text-on-surface-variant block text-[10px]">
                                Unit Price ({item.unit})
                              </span>
                              <span className="text-on-surface">
                                {item.unitPrice !== null
                                  ? `${formatINR(item.unitPrice)}${
                                      item.gstPercent !== null ? ` + ${item.gstPercent}% GST` : ''
                                    }`
                                  : 'Not configured'}
                              </span>
                            </div>
                          </div>

                          {(safeDatasheetUrl || safeManufacturerUrl) && (
                            <div className="flex items-center gap-3 text-[11px]">
                              {safeDatasheetUrl && (
                                <a
                                  href={safeDatasheetUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-secondary hover:underline flex items-center gap-0.5"
                                >
                                  Datasheet
                                  <span className="material-symbols-outlined text-[13px]">
                                    open_in_new
                                  </span>
                                </a>
                              )}
                              {safeManufacturerUrl && (
                                <a
                                  href={safeManufacturerUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-secondary hover:underline flex items-center gap-0.5"
                                >
                                  Manufacturer
                                  <span className="material-symbols-outlined text-[13px]">
                                    open_in_new
                                  </span>
                                </a>
                              )}
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-outline/60">
                          {isCable && onAssignCableToCircuit ? (
                            <button
                              type="button"
                              onClick={() => {
                                onAssignCableToCircuit(item, targetCircuit);
                                setNotice({
                                  kind: 'ok',
                                  text: `Assigned "${item.productName}" (${
                                    item.cableSizeSqMm ?? 'unrated'
                                  } sq.mm) to ${targetCircuit}.`,
                                });
                              }}
                              className="flex-1 px-2.5 py-1.5 text-[11px] font-label bg-primary text-on-primary cursor-pointer"
                            >
                              Assign to {targetCircuit.split(' ')[0]}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                onAddProductToProject(item);
                                setNotice({
                                  kind: 'ok',
                                  text: `Added "${item.productName}" to active floor design.`,
                                });
                              }}
                              className="flex-1 px-2.5 py-1.5 text-[11px] font-label bg-primary text-on-primary cursor-pointer"
                            >
                              + Add to Project
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => toggleCompare(item.id)}
                            className={`px-2 py-1.5 text-[11px] font-label border cursor-pointer ${
                              isCompared
                                ? 'border-secondary bg-secondary/15 text-secondary'
                                : 'border-outline bg-surface-container text-on-surface-variant hover:text-on-surface'
                            }`}
                          >
                            {isCompared ? 'Compared' : 'Compare'}
                          </button>

                          {isAdmin && (
                            <>
                              <button
                                type="button"
                                onClick={() => startEdit(item)}
                                className="p-1.5 border border-outline bg-surface-container text-on-surface-variant hover:text-on-surface cursor-pointer"
                                title="Edit product"
                              >
                                <span className="material-symbols-outlined text-[14px]">edit</span>
                              </button>
                              {confirmDeleteId === item.id ? (
                                <button
                                  type="button"
                                  onClick={() => handleDeleteProduct(item.id)}
                                  className="px-2 py-1 text-[10px] font-mono bg-red-700 text-white cursor-pointer"
                                >
                                  Confirm
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(item.id)}
                                  className="p-1.5 border border-outline bg-surface-container text-on-surface-variant hover:text-red-400 cursor-pointer"
                                  title="Delete product"
                                >
                                  <span className="material-symbols-outlined text-[14px]">
                                    delete
                                  </span>
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'directory' && (
            <div className="space-y-4">
              <div className="border border-outline bg-surface p-3.5 text-xs text-on-surface-variant">
                Official reference portals for all 13 supported electrical manufacturers across all
                14 Blue Space product categories. Verify model codes, ratings, datasheets, and
                dealer pricing directly from official sources before importing into your catalogue.
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {MANUFACTURER_REFERENCES.map((m) => (
                  <div
                    key={m.name}
                    className="border border-outline bg-surface p-3.5 flex flex-col justify-between gap-2.5"
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="font-headline text-sm font-semibold text-on-surface">
                          {m.name}
                        </h3>
                        <a
                          href={m.websiteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] font-mono text-secondary hover:underline flex items-center gap-0.5"
                        >
                          Official Site
                          <span className="material-symbols-outlined text-[13px]">
                            open_in_new
                          </span>
                        </a>
                      </div>
                      <p className="text-[11px] text-on-surface-variant mt-1 leading-relaxed">
                        {m.notes}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1 pt-2 border-t border-outline/60">
                      {m.primaryCategories.map((cat) => (
                        <span
                          key={cat}
                          className="px-1.5 py-0.5 text-[10px] font-mono bg-surface-container text-on-surface-variant border border-outline/60"
                        >
                          {cat}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'compare' && (
            <div className="space-y-4">
              {comparedItems.length === 0 ? (
                <div className="border border-outline bg-surface p-6 text-center text-xs text-on-surface-variant">
                  Select up to 3 products from the Catalogue Products tab using the{' '}
                  <strong className="text-on-surface">Compare</strong> button to inspect
                  specifications, ratings, cable sizes, and pricing side-by-side.
                </div>
              ) : (
                <div className="overflow-x-auto border border-outline bg-surface">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-outline bg-surface-container-low">
                        <th className="p-3 font-mono text-[11px] text-on-surface-variant w-44">
                          Attribute
                        </th>
                        {comparedItems.map((item) => (
                          <th key={item.id} className="p-3 font-headline text-on-surface">
                            <div className="flex items-center justify-between gap-2">
                              <span>{item.productName}</span>
                              <button
                                type="button"
                                onClick={() => toggleCompare(item.id)}
                                className="text-[11px] text-on-surface-variant hover:text-red-400 cursor-pointer"
                              >
                                Remove
                              </button>
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline/60 font-mono text-[11px]">
                      {[
                        ['Category', (p: ProductCatalogueItem) => p.category],
                        ['Manufacturer', (p: ProductCatalogueItem) => p.manufacturer],
                        ['Brand / Series', (p: ProductCatalogueItem) => p.brand],
                        ['Model Number', (p: ProductCatalogueItem) => p.modelNumber],
                        ['Specification', (p: ProductCatalogueItem) => p.specification || '—'],
                        ['Rating', (p: ProductCatalogueItem) => p.rating || '—'],
                        [
                          'Wattage',
                          (p: ProductCatalogueItem) =>
                            p.wattageW !== null ? `${p.wattageW} W` : '—',
                        ],
                        [
                          'Cable Size',
                          (p: ProductCatalogueItem) =>
                            p.cableSizeSqMm !== null ? `${p.cableSizeSqMm} sq.mm` : '—',
                        ],
                        ['Dimensions', (p: ProductCatalogueItem) => p.dimensions || '—'],
                        ['Unit', (p: ProductCatalogueItem) => p.unit],
                        [
                          'Unit Price',
                          (p: ProductCatalogueItem) =>
                            p.unitPrice !== null ? formatINR(p.unitPrice) : 'Not configured',
                        ],
                        [
                          'GST %',
                          (p: ProductCatalogueItem) =>
                            p.gstPercent !== null ? `${p.gstPercent}%` : 'Not configured',
                        ],
                      ].map(([label, getter]) => (
                        <tr key={label as string}>
                          <td className="p-2.5 text-on-surface-variant bg-surface-container-low/40">
                            {label as string}
                          </td>
                          {comparedItems.map((item) => (
                            <td key={item.id} className="p-2.5 text-on-surface">
                              {(getter as (p: ProductCatalogueItem) => string)(item)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {tab === 'admin' && isAdmin && (
            <form onSubmit={handleSaveForm} className="space-y-4 max-w-4xl">
              <div className="border border-outline bg-surface p-3 text-xs text-on-surface-variant">
                Enter verified manufacturer product details from official datasheets or company
                price lists. Leave Price or GST blank if not yet approved — Blue Space will label
                unconfigured rates transparently in BOQ exports.
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                    Product Category *
                  </span>
                  <select
                    value={form.category}
                    onChange={(e) => handleFormCategoryChange(e.target.value as CatalogueCategory)}
                    className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                  >
                    {CATALOGUE_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                    Manufacturer *
                  </span>
                  <select
                    value={form.manufacturer}
                    onChange={(e) => setForm((f) => ({ ...f, manufacturer: e.target.value }))}
                    className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                  >
                    {MANUFACTURER_NAMES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                    Brand / Series
                  </span>
                  <input
                    type="text"
                    value={form.brand}
                    onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
                    placeholder="e.g. Manufacturer product line"
                    className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                  />
                </label>

                <label className="space-y-1 md:col-span-2">
                  <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                    Product Name *
                  </span>
                  <input
                    type="text"
                    required
                    value={form.productName}
                    onChange={(e) => setForm((f) => ({ ...f, productName: e.target.value }))}
                    placeholder="Official manufacturer product name"
                    className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                  />
                </label>

                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                    Model / Part Number
                  </span>
                  <input
                    type="text"
                    value={form.modelNumber}
                    onChange={(e) => setForm((f) => ({ ...f, modelNumber: e.target.value }))}
                    placeholder="Official SKU / catalogue code"
                    className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                  />
                </label>

                <label className="space-y-1 md:col-span-3">
                  <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                    Technical Specification
                  </span>
                  <input
                    type="text"
                    value={form.specification}
                    onChange={(e) => setForm((f) => ({ ...f, specification: e.target.value }))}
                    placeholder="Insulation grade, IP rating, pole configuration, lumen output, etc."
                    className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                  />
                </label>

                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                    Electrical Rating
                  </span>
                  <input
                    type="text"
                    value={form.rating}
                    onChange={(e) => setForm((f) => ({ ...f, rating: e.target.value }))}
                    placeholder="e.g. 240V AC / 16A / 1100V"
                    className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                  />
                </label>

                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                    Wattage (W) — Optional
                  </span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={form.wattageW}
                    onChange={(e) => setForm((f) => ({ ...f, wattageW: e.target.value }))}
                    placeholder="Leave blank if N/A"
                    className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                  />
                </label>

                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                    Cable Size (sq.mm) — Cables only
                  </span>
                  <input
                    type="number"
                    step="0.25"
                    min="0.5"
                    value={form.cableSizeSqMm}
                    onChange={(e) => setForm((f) => ({ ...f, cableSizeSqMm: e.target.value }))}
                    placeholder="e.g. 1.5, 2.5, 4.0"
                    className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                  />
                </label>

                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                    Dimensions
                  </span>
                  <input
                    type="text"
                    value={form.dimensions}
                    onChange={(e) => setForm((f) => ({ ...f, dimensions: e.target.value }))}
                    placeholder="Optional physical dimensions"
                    className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                  />
                </label>

                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                    Unit
                  </span>
                  <input
                    type="text"
                    value={form.unit}
                    onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
                    placeholder="Nos / m / Coil"
                    className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                  />
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1">
                    <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                      Unit Price (₹)
                    </span>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={form.unitPrice}
                      onChange={(e) => setForm((f) => ({ ...f, unitPrice: e.target.value }))}
                      placeholder="Optional"
                      className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                      GST %
                    </span>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      max="100"
                      value={form.gstPercent}
                      onChange={(e) => setForm((f) => ({ ...f, gstPercent: e.target.value }))}
                      placeholder="e.g. 18"
                      className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                    />
                  </label>
                </div>

                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                    Product Image URL
                  </span>
                  <input
                    type="url"
                    value={form.imageUrl}
                    onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))}
                    placeholder="https://..."
                    className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                  />
                </label>

                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                    Datasheet URL
                  </span>
                  <input
                    type="url"
                    value={form.datasheetUrl}
                    onChange={(e) => setForm((f) => ({ ...f, datasheetUrl: e.target.value }))}
                    placeholder="https://..."
                    className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                  />
                </label>

                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                    Manufacturer Page URL
                  </span>
                  <input
                    type="url"
                    value={form.manufacturerUrl}
                    onChange={(e) => setForm((f) => ({ ...f, manufacturerUrl: e.target.value }))}
                    placeholder="https://..."
                    className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                  />
                </label>
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-label bg-primary text-on-primary cursor-pointer"
                >
                  {editingId ? 'Save Catalogue Changes' : 'Add Product to Catalogue'}
                </button>
                {editingId && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(null);
                      setForm(EMPTY_FORM);
                    }}
                    className="px-3 py-2 text-xs font-label border border-outline bg-surface text-on-surface-variant cursor-pointer"
                  >
                    Cancel Edit
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
