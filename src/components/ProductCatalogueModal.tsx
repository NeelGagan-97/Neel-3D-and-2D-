import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CATALOGUE_CATEGORIES,
  downloadCatalogueCsvTemplate,
  fetchCauveryImportStatus,
  getCentralStorageBackend,
  hydrateCentralCatalogue,
  inferMappedItemType,
  loadCatalogueManufacturers,
  loadCatalogueProducts,
  parseCatalogueSpreadsheet,
  pauseCauveryImport,
  removeCentralCatalogueProduct,
  removeCentralManufacturer,
  resolveProductWithVariant,
  saveCatalogueProducts,
  saveCentralCatalogueProduct,
  saveCentralManufacturer,
  subscribeCentralCatalogue,
  triggerCauveryImport,
  uploadCatalogueProductImage,
} from '../services/productCatalogueStorage';
import {
  CatalogueCategory,
  CatalogueImportJobStatus,
  ManufacturerReference,
  ProductCatalogueItem,
} from '../types/catalogue';
import { CircuitId } from '../types/design';
import { CIRCUITS, formatINR } from '../data/presets';
import {
  sanitizeSafeCatalogueImageUrl,
  sanitizeSafeUrl,
  validateSafeUrl,
} from '../utils/urlSecurity';

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
  subcategory: string;
  manufacturer: string;
  brand: string;
  productName: string;
  modelNumber: string;
  sku: string;
  specification: string;
  rating: string;
  wattageW: string;
  cableSizeSqMm: string;
  dimensions: string;
  unit: string;
  mrp: string;
  unitPrice: string;
  discountPercent: string;
  gstPercent: string;
  imageUrl: string;
  imageStoragePath: string;
  datasheetUrl: string;
  manufacturerUrl: string;
}

interface ManufacturerFormState {
  slug: string;
  name: string;
  websiteUrl: string;
  notes: string;
  primaryCategories: CatalogueCategory[];
}

const EMPTY_FORM: ProductFormState = {
  category: 'Cables & Wires',
  subcategory: '',
  manufacturer: 'Polycab',
  brand: '',
  productName: '',
  modelNumber: '',
  sku: '',
  specification: '',
  rating: '',
  wattageW: '',
  cableSizeSqMm: '',
  dimensions: '',
  unit: 'm',
  mrp: '',
  unitPrice: '',
  discountPercent: '',
  gstPercent: '18',
  imageUrl: '',
  imageStoragePath: '',
  datasheetUrl: '',
  manufacturerUrl: '',
};

const EMPTY_MANUFACTURER_FORM: ManufacturerFormState = {
  slug: '',
  name: '',
  websiteUrl: '',
  notes: '',
  primaryCategories: ['Switches'],
};

const PAGE_SIZE = 24;

export const ProductCatalogueModal: React.FC<ProductCatalogueModalProps> = ({
  open,
  onClose,
  isAdmin,
  activeCircuit = 'CKT-L1 (Lighting)',
  onAddProductToProject,
  onAssignCableToCircuit,
}) => {
  const [products, setProducts] = useState<ProductCatalogueItem[]>(() => loadCatalogueProducts());
  const [manufacturers, setManufacturers] = useState<ManufacturerReference[]>(() =>
    loadCatalogueManufacturers()
  );
  const [storageBackend, setStorageBackend] = useState<'supabase' | 'local-store'>(() =>
    getCentralStorageBackend()
  );
  const [loadingCentral, setLoadingCentral] = useState(false);

  const [tab, setTab] = useState<'browse' | 'directory' | 'compare' | 'admin'>('browse');
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<CatalogueCategory | 'ALL'>('ALL');
  const [selectedSubcategory, setSelectedSubcategory] = useState<string>('ALL');
  const [selectedManufacturer, setSelectedManufacturer] = useState<string>('ALL');
  const [page, setPage] = useState<number>(1);
  const [selectedVariantByProduct, setSelectedVariantByProduct] = useState<Record<string, string>>(
    {}
  );

  const [directorySearch, setDirectorySearch] = useState('');
  const [editingMfgSlug, setEditingMfgSlug] = useState<string | null>(null);
  const [mfgForm, setMfgForm] = useState<ManufacturerFormState>(EMPTY_MANUFACTURER_FORM);
  const [showMfgForm, setShowMfgForm] = useState(false);

  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [targetCircuit, setTargetCircuit] = useState<CircuitId>(activeCircuit);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProductFormState>(EMPTY_FORM);
  const [savingProduct, setSavingProduct] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [importStatus, setImportStatus] = useState<CatalogueImportJobStatus | null>(null);
  const [showImportErrors, setShowImportErrors] = useState(false);
  const [busyImportAction, setBusyImportAction] = useState(false);

  const importInputRef = useRef<HTMLInputElement>(null);
  const imageUploadInputRef = useRef<HTMLInputElement>(null);

  // Hydrate central catalogue on open & subscribe to live store updates
  useEffect(() => {
    const unsub = subscribeCentralCatalogue(() => {
      setProducts(loadCatalogueProducts());
      setManufacturers(loadCatalogueManufacturers());
      setStorageBackend(getCentralStorageBackend());
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoadingCentral(true);
    hydrateCentralCatalogue(true)
      .then((res) => {
        if (!active) return;
        setProducts(res.products);
        setManufacturers(res.manufacturers);
        setStorageBackend(res.storageBackend);
      })
      .finally(() => {
        if (active) setLoadingCentral(false);
      });
    if (isAdmin) {
      fetchCauveryImportStatus().then((res) => {
        if (active && res.ok && res.status) setImportStatus(res.status);
      });
    }
    return () => {
      active = false;
    };
  }, [open, isAdmin]);

  // Poll Cauvery import status while running
  useEffect(() => {
    if (!open || !isAdmin || importStatus?.status !== 'running') return;
    const timer = window.setInterval(async () => {
      const res = await fetchCauveryImportStatus();
      if (res.ok && res.status) {
        setImportStatus(res.status);
        if (res.status.status !== 'running') {
          await hydrateCentralCatalogue(true);
        }
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [open, isAdmin, importStatus?.status]);

  useEffect(() => {
    setTargetCircuit(activeCircuit);
  }, [activeCircuit]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [search, selectedCategory, selectedSubcategory, selectedManufacturer]);

  const categoryCounts = useMemo(() => {
    const map = new Map<string, number>();
    products.forEach((p) => {
      map.set(p.category, (map.get(p.category) ?? 0) + 1);
    });
    return map;
  }, [products]);

  const availableSubcategories = useMemo(() => {
    const map = new Map<string, number>();
    products.forEach((p) => {
      if (selectedCategory !== 'ALL' && p.category !== selectedCategory) return;
      const sub = (p.subcategory || '').trim();
      if (!sub) return;
      map.set(sub, (map.get(sub) ?? 0) + 1);
    });
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [products, selectedCategory]);

  const manufacturerCounts = useMemo(() => {
    const map = new Map<string, number>();
    products.forEach((p) => {
      const key = p.manufacturer.trim().toLowerCase();
      if (key) map.set(key, (map.get(key) ?? 0) + 1);
    });
    return map;
  }, [products]);

  const allManufacturerNames = useMemo(() => {
    const set = new Set<string>();
    manufacturers.forEach((m) => set.add(m.name));
    products.forEach((p) => {
      if (p.manufacturer?.trim()) set.add(p.manufacturer.trim());
    });
    return Array.from(set).sort((a, b) => {
      const ca = manufacturerCounts.get(a.toLowerCase()) ?? 0;
      const cb = manufacturerCounts.get(b.toLowerCase()) ?? 0;
      return cb - ca || a.localeCompare(b);
    });
  }, [manufacturers, products, manufacturerCounts]);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (selectedCategory !== 'ALL' && p.category !== selectedCategory) return false;
      if (
        selectedSubcategory !== 'ALL' &&
        (p.subcategory || '').trim().toLowerCase() !== selectedSubcategory.toLowerCase()
      ) {
        return false;
      }
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
        (p.sku || '').toLowerCase().includes(q) ||
        (p.subcategory || '').toLowerCase().includes(q) ||
        p.specification.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
      );
    });
  }, [products, search, selectedCategory, selectedSubcategory, selectedManufacturer]);

  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedProducts = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredProducts.slice(start, start + PAGE_SIZE);
  }, [filteredProducts, safePage]);

  const filteredDirectory = useMemo(() => {
    const q = directorySearch.trim().toLowerCase();
    return manufacturers
      .map((m) => ({
        ...m,
        liveCount: manufacturerCounts.get(m.name.toLowerCase()) ?? m.productCount ?? 0,
      }))
      .filter((m) => {
        if (!q) return true;
        return (
          m.name.toLowerCase().includes(q) ||
          m.notes.toLowerCase().includes(q) ||
          m.primaryCategories.some((c) => c.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => b.liveCount - a.liveCount || a.name.localeCompare(b.name));
  }, [manufacturers, manufacturerCounts, directorySearch]);

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
      subcategory: item.subcategory ?? '',
      manufacturer: item.manufacturer,
      brand: item.brand,
      productName: item.productName,
      modelNumber: item.modelNumber,
      sku: item.sku ?? '',
      specification: item.specification,
      rating: item.rating,
      wattageW: item.wattageW !== null ? String(item.wattageW) : '',
      cableSizeSqMm: item.cableSizeSqMm !== null ? String(item.cableSizeSqMm) : '',
      dimensions: item.dimensions,
      unit: item.unit,
      mrp: item.mrp !== undefined && item.mrp !== null ? String(item.mrp) : '',
      unitPrice: item.unitPrice !== null ? String(item.unitPrice) : '',
      discountPercent:
        item.discountPercent !== undefined && item.discountPercent !== null
          ? String(item.discountPercent)
          : '',
      gstPercent: item.gstPercent !== null ? String(item.gstPercent) : '',
      imageUrl: item.imageUrl ?? '',
      imageStoragePath: item.imageStoragePath ?? '',
      datasheetUrl: item.datasheetUrl ?? '',
      manufacturerUrl: item.manufacturerUrl ?? '',
    });
    setTab('admin');
  };

  const handleImageFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !isAdmin) return;
    setUploadingImage(true);
    try {
      const uploaded = await uploadCatalogueProductImage(file);
      if (!uploaded.ok || !uploaded.publicUrl) {
        throw new Error(uploaded.error || 'Image upload failed.');
      }
      setForm((prev) => ({
        ...prev,
        imageUrl: uploaded.publicUrl ?? '',
        imageStoragePath: uploaded.storagePath ?? '',
      }));
      setNotice({
        kind: 'ok',
        text: `Image stored in ${
          storageBackend === 'supabase' ? 'Supabase Storage' : 'Blue Space local storage'
        }.`,
      });
    } catch (err) {
      setNotice({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Image upload failed.',
      });
    } finally {
      setUploadingImage(false);
    }
  };

  const handleSaveForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    const name = form.productName.trim();
    if (!name) {
      setNotice({ kind: 'err', text: 'Product name is required.' });
      return;
    }

    const safeImg = sanitizeSafeCatalogueImageUrl(form.imageUrl);
    if (form.imageUrl.trim() && !safeImg) {
      setNotice({
        kind: 'err',
        text: 'Invalid image path. Upload an image to Supabase Storage or provide a valid https:// URL.',
      });
      return;
    }
    const datasheetCheck = validateSafeUrl(form.datasheetUrl, 'Datasheet URL');
    if (!datasheetCheck.valid) {
      setNotice({ kind: 'err', text: datasheetCheck.error ?? 'Invalid Datasheet URL.' });
      return;
    }
    const manufacturerCheck = validateSafeUrl(form.manufacturerUrl, 'Manufacturer Page URL');
    if (!manufacturerCheck.valid) {
      setNotice({
        kind: 'err',
        text: manufacturerCheck.error ?? 'Invalid Manufacturer Page URL.',
      });
      return;
    }

    const toNumOrNull = (val: string): number | null => {
      if (!val.trim()) return null;
      const n = Number(val);
      return Number.isFinite(n) ? n : null;
    };

    const mrpVal = toNumOrNull(form.mrp);
    const unitPriceVal = toNumOrNull(form.unitPrice);
    if (unitPriceVal !== null && unitPriceVal < 0) {
      setNotice({ kind: 'err', text: 'Unit price cannot be negative.' });
      return;
    }
    if (mrpVal !== null && mrpVal < 0) {
      setNotice({ kind: 'err', text: 'MRP cannot be negative.' });
      return;
    }
    let discountVal = toNumOrNull(form.discountPercent);
    if (
      discountVal === null &&
      mrpVal !== null &&
      unitPriceVal !== null &&
      mrpVal > unitPriceVal
    ) {
      discountVal = Number((((mrpVal - unitPriceVal) / mrpVal) * 100).toFixed(2));
    }
    const gstVal = toNumOrNull(form.gstPercent);
    if (gstVal !== null && (gstVal < 0 || gstVal > 100)) {
      setNotice({ kind: 'err', text: 'GST % must be between 0 and 100.' });
      return;
    }

    setSavingProduct(true);
    try {
      const existing = editingId ? products.find((p) => p.id === editingId) : undefined;
      const saved = await saveCentralCatalogueProduct({
        ...(existing ? { id: existing.id, sourceKey: existing.sourceKey, variants: existing.variants } : {}),
        category: form.category,
        subcategory: form.subcategory.trim() || undefined,
        manufacturer: form.manufacturer.trim() || 'Unspecified',
        brand: form.brand.trim() || form.manufacturer.trim() || 'Unspecified',
        productName: name,
        modelNumber: form.modelNumber.trim() || form.sku.trim() || 'Not specified',
        sku: form.sku.trim() || undefined,
        specification: form.specification.trim(),
        rating: form.rating.trim(),
        wattageW: toNumOrNull(form.wattageW),
        cableSizeSqMm: toNumOrNull(form.cableSizeSqMm),
        dimensions: form.dimensions.trim(),
        unit: form.unit.trim() || (form.category === 'Cables & Wires' ? 'm' : 'Nos'),
        mrp: mrpVal,
        unitPrice: unitPriceVal,
        discountPercent: discountVal,
        gstPercent: gstVal,
        imageUrl: safeImg,
        imageStoragePath: form.imageStoragePath.trim() || undefined,
        datasheetUrl: datasheetCheck.normalized,
        manufacturerUrl: manufacturerCheck.normalized,
        mappedItemType: inferMappedItemType(form.category, name),
        source: 'admin-entry',
      });

      if (!saved.ok) {
        throw new Error(saved.error || 'Failed to save product.');
      }
      const savedName = saved.product?.productName || name;
      setProducts(saved.products);
      setEditingId(null);
      setForm(EMPTY_FORM);
      setNotice({
        kind: 'ok',
        text: editingId
          ? `Updated central catalogue product "${savedName}". Existing saved project BOQs retain their historical prices.`
          : `Added "${savedName}" to central electrical catalogue.`,
      });
      setTab('browse');
    } catch (err) {
      setNotice({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to save product.',
      });
    } finally {
      setSavingProduct(false);
    }
  };

  const handleDeleteProduct = async (id: string) => {
    if (!isAdmin) return;
    try {
      await removeCentralCatalogueProduct(id);
      setProducts(loadCatalogueProducts());
      setCompareIds((prev) => prev.filter((x) => x !== id));
      setConfirmDeleteId(null);
      setNotice({ kind: 'ok', text: 'Removed product from central catalogue.' });
    } catch (err) {
      setNotice({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to delete product.',
      });
    }
  };

  const handleSaveManufacturer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    const name = mfgForm.name.trim();
    if (!name) {
      setNotice({ kind: 'err', text: 'Manufacturer name is required.' });
      return;
    }
    if (mfgForm.websiteUrl.trim()) {
      const check = validateSafeUrl(mfgForm.websiteUrl, 'Website URL');
      if (!check.valid) {
        setNotice({ kind: 'err', text: check.error ?? 'Invalid website URL.' });
        return;
      }
    }
    try {
      const slug =
        editingMfgSlug ||
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
      await saveCentralManufacturer({
        slug,
        name,
        websiteUrl: sanitizeSafeUrl(mfgForm.websiteUrl) ?? '',
        notes: mfgForm.notes.trim() || `${name} electrical product portfolio.`,
        primaryCategories:
          mfgForm.primaryCategories.length > 0 ? mfgForm.primaryCategories : ['Switches'],
        source: 'admin-entry',
      });
      setManufacturers(loadCatalogueManufacturers());
      setEditingMfgSlug(null);
      setMfgForm(EMPTY_MANUFACTURER_FORM);
      setShowMfgForm(false);
      setNotice({ kind: 'ok', text: `Saved manufacturer "${name}" in central directory.` });
    } catch (err) {
      setNotice({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to save manufacturer.',
      });
    }
  };

  const handleDeleteManufacturer = async (slug: string, name: string) => {
    if (!isAdmin) return;
    try {
      await removeCentralManufacturer(slug);
      setManufacturers(loadCatalogueManufacturers());
      setNotice({ kind: 'ok', text: `Removed manufacturer "${name}" from directory.` });
    } catch (err) {
      setNotice({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to remove manufacturer.',
      });
    }
  };

  const handleTriggerImport = async (resume: boolean) => {
    if (!isAdmin) return;
    setBusyImportAction(true);
    try {
      const res = await triggerCauveryImport(resume);
      if (!res.ok) {
        throw new Error(res.error || 'Could not start Cauvery Powers import.');
      }
      if (res.status) setImportStatus(res.status);
      setNotice({
        kind: 'ok',
        text: resume
          ? 'Resuming Cauvery Powers catalogue import from last saved page checkpoint...'
          : 'Started Cauvery Powers full catalogue import (products, variants, pricing, GST & hosted images)...',
      });
    } catch (err) {
      setNotice({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Could not start Cauvery Powers import.',
      });
    } finally {
      setBusyImportAction(false);
    }
  };

  const handlePauseImport = async () => {
    if (!isAdmin) return;
    setBusyImportAction(true);
    try {
      const res = await pauseCauveryImport();
      if (res.ok && res.status) setImportStatus(res.status);
      setNotice({
        kind: 'ok',
        text: 'Pause requested — checkpoint saved after current page. You can resume anytime.',
      });
    } catch (err) {
      setNotice({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to pause import.',
      });
    } finally {
      setBusyImportAction(false);
    }
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
      aria-label="Central Electrical Product Catalogue"
    >
      <div className="w-full max-w-6xl max-h-[90vh] flex flex-col bg-surface-container border border-outline shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-outline bg-surface-container-low">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-secondary">
              BLUE SPACE CENTRAL ELECTRICAL CATALOGUE ·{' '}
              {storageBackend === 'supabase' ? 'SUPABASE DB & STORAGE' : 'PERMANENT HOSTED STORE'}
            </p>
            <h2 className="font-headline text-lg font-semibold text-on-surface mt-0.5">
              Electrical Product Catalogue &amp; Manufacturer Directory
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
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-2 border-b border-outline bg-surface">
          <div className="flex flex-wrap items-center gap-1">
            {[
              {
                id: 'browse',
                label: `Catalogue Products (${products.length.toLocaleString('en-IN')})`,
                icon: 'inventory_2',
              },
              {
                id: 'directory',
                label: `Manufacturer Directory (${manufacturers.length})`,
                icon: 'factory',
              },
              { id: 'compare', label: `Compare (${compareIds.length}/3)`, icon: 'compare_arrows' },
              ...(isAdmin
                ? [
                    {
                      id: 'admin',
                      label: editingId ? 'Edit Product (Admin)' : 'Admin & Sync',
                      icon: 'admin_panel_settings',
                    },
                  ]
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
                <div className="md:col-span-4 relative">
                  <span className="material-symbols-outlined text-[16px] text-on-surface-variant absolute left-2.5 top-2.5">
                    search
                  </span>
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search product, SKU, brand, spec, subcategory..."
                    className="w-full pl-8 pr-3 py-2 text-xs bg-surface border border-outline text-on-surface placeholder:text-on-surface-variant/60"
                  />
                </div>
                <select
                  aria-label="Filter by category"
                  value={selectedCategory}
                  onChange={(e) => {
                    setSelectedCategory(e.target.value as CatalogueCategory | 'ALL');
                    setSelectedSubcategory('ALL');
                  }}
                  className="md:col-span-3 px-2.5 py-2 text-xs bg-surface border border-outline text-on-surface"
                >
                  <option value="ALL">All Categories ({CATALOGUE_CATEGORIES.length})</option>
                  {CATALOGUE_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat} ({categoryCounts.get(cat) ?? 0})
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter by subcategory"
                  value={selectedSubcategory}
                  onChange={(e) => setSelectedSubcategory(e.target.value)}
                  className="md:col-span-2 px-2.5 py-2 text-xs bg-surface border border-outline text-on-surface"
                >
                  <option value="ALL">
                    All Subcategories ({availableSubcategories.length})
                  </option>
                  {availableSubcategories.map(([sub, cnt]) => (
                    <option key={sub} value={sub}>
                      {sub} ({cnt})
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter by manufacturer"
                  value={selectedManufacturer}
                  onChange={(e) => setSelectedManufacturer(e.target.value)}
                  className="md:col-span-3 px-2.5 py-2 text-xs bg-surface border border-outline text-on-surface"
                >
                  <option value="ALL">All Manufacturers ({allManufacturerNames.length})</option>
                  {allManufacturerNames.map((m) => (
                    <option key={m} value={m}>
                      {m} ({manufacturerCounts.get(m.toLowerCase()) ?? 0})
                    </option>
                  ))}
                </select>
              </div>

              {/* Active Result Summary + Pagination Header */}
              {products.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-on-surface-variant border-b border-outline/60 pb-2">
                  <span>
                    Showing{' '}
                    <strong className="text-on-surface">
                      {filteredProducts.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1}–
                      {Math.min(safePage * PAGE_SIZE, filteredProducts.length)}
                    </strong>{' '}
                    of <strong className="text-on-surface">{filteredProducts.length}</strong>{' '}
                    matching products
                    {loadingCentral ? ' · Syncing...' : ''}
                  </span>
                  {(search ||
                    selectedCategory !== 'ALL' ||
                    selectedSubcategory !== 'ALL' ||
                    selectedManufacturer !== 'ALL') && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearch('');
                        setSelectedCategory('ALL');
                        setSelectedSubcategory('ALL');
                        setSelectedManufacturer('ALL');
                      }}
                      className="text-secondary hover:underline cursor-pointer"
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              )}

              {/* Empty state */}
              {products.length === 0 ? (
                <div className="border border-outline bg-surface p-6 text-center space-y-3">
                  <span className="material-symbols-outlined text-[36px] text-secondary">
                    verified
                  </span>
                  <h3 className="font-headline text-base text-on-surface">
                    {loadingCentral
                      ? 'Loading Central Electrical Catalogue...'
                      : 'No Catalogue Products Imported Yet'}
                  </h3>
                  <p className="text-xs text-on-surface-variant max-w-2xl mx-auto leading-relaxed">
                    Blue Space never fabricates manufacturer model numbers, specifications, or
                    prices.{' '}
                    {isAdmin
                      ? 'Use Admin & Sync to run the resumable Cauvery Powers catalogue import, add verified SKUs manually, or upload an Excel / CSV price list.'
                      : 'Ask an administrator to sync the central electrical product catalogue.'}
                  </p>
                  {isAdmin && !loadingCentral && (
                    <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                      <button
                        type="button"
                        onClick={() => setTab('admin')}
                        className="px-3.5 py-2 text-xs font-label bg-primary text-on-primary cursor-pointer"
                      >
                        Open Admin &amp; Catalogue Sync
                      </button>
                    </div>
                  )}
                </div>
              ) : filteredProducts.length === 0 ? (
                <div className="border border-outline bg-surface p-6 text-center text-xs text-on-surface-variant">
                  No catalogue items match your current search or filter criteria.
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {pagedProducts.map((rawItem) => {
                      const chosenVariantSku = selectedVariantByProduct[rawItem.id];
                      const item = resolveProductWithVariant(rawItem, chosenVariantSku);
                      const isCompared = compareIds.includes(rawItem.id);
                      const isCable = item.category === 'Cables & Wires';
                      const safeImageUrl = sanitizeSafeCatalogueImageUrl(item.imageUrl);
                      const safeDatasheetUrl = sanitizeSafeUrl(item.datasheetUrl);
                      const safeManufacturerUrl = sanitizeSafeUrl(item.manufacturerUrl);
                      const hasVariants = (rawItem.variants?.length ?? 0) > 1;

                      return (
                        <div
                          key={rawItem.id}
                          className="border border-outline bg-surface flex flex-col justify-between p-3.5 gap-3"
                        >
                          <div className="space-y-2">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-1">
                                  <span className="inline-block px-1.5 py-0.5 text-[10px] font-mono uppercase bg-surface-container-high text-secondary border border-outline">
                                    {item.category}
                                  </span>
                                  {item.subcategory && (
                                    <span className="inline-block px-1.5 py-0.5 text-[10px] font-mono bg-surface-container text-on-surface-variant border border-outline/60 truncate max-w-[140px]">
                                      {item.subcategory}
                                    </span>
                                  )}
                                </div>
                                <p className="text-[11px] font-mono text-on-surface-variant mt-1 truncate">
                                  {item.manufacturer}
                                  {item.brand && item.brand !== item.manufacturer
                                    ? ` · ${item.brand}`
                                    : ''}
                                </p>
                              </div>
                              {safeImageUrl ? (
                                <img
                                  src={safeImageUrl}
                                  alt={item.productName}
                                  loading="lazy"
                                  className="w-14 h-14 object-contain border border-outline bg-white p-0.5 shrink-0"
                                />
                              ) : (
                                <div className="w-14 h-14 border border-outline/60 bg-surface-container flex items-center justify-center text-on-surface-variant/40 shrink-0">
                                  <span className="material-symbols-outlined text-[20px]">
                                    electrical_services
                                  </span>
                                </div>
                              )}
                            </div>

                            <div>
                              <h4 className="text-sm font-medium text-on-surface leading-snug line-clamp-2">
                                {item.productName}
                              </h4>
                              <p className="text-[11px] font-mono text-on-surface-variant mt-0.5 truncate">
                                Model / SKU:{' '}
                                <span className="text-on-surface">{item.modelNumber}</span>
                              </p>
                            </div>

                            {hasVariants && (
                              <label className="block">
                                <span className="font-mono text-[10px] text-on-surface-variant uppercase">
                                  Variant ({rawItem.variants!.length} options)
                                </span>
                                <select
                                  value={
                                    chosenVariantSku ?? rawItem.variants![0]?.sku ?? ''
                                  }
                                  onChange={(e) =>
                                    setSelectedVariantByProduct((prev) => ({
                                      ...prev,
                                      [rawItem.id]: e.target.value,
                                    }))
                                  }
                                  className="mt-0.5 w-full bg-surface-container-low border border-outline px-2 py-1 text-[11px] font-mono text-on-surface"
                                >
                                  {rawItem.variants!.map((v) => (
                                    <option key={v.sku} value={v.sku}>
                                      {v.label}
                                      {v.unitPrice !== null
                                        ? ` — ${formatINR(v.unitPrice)}`
                                        : ''}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            )}

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
                                  Rate / {item.unit}
                                </span>
                                <div className="flex flex-wrap items-baseline gap-1">
                                  <span className="text-on-surface font-semibold">
                                    {item.unitPrice !== null
                                      ? formatINR(item.unitPrice)
                                      : 'Not configured'}
                                  </span>
                                  {item.mrp !== undefined &&
                                    item.mrp !== null &&
                                    item.unitPrice !== null &&
                                    item.mrp > item.unitPrice && (
                                      <span className="text-[10px] text-on-surface-variant line-through">
                                        {formatINR(item.mrp)}
                                      </span>
                                    )}
                                </div>
                                <div className="flex flex-wrap gap-1 mt-0.5 text-[9px]">
                                  {item.discountPercent !== undefined &&
                                    item.discountPercent !== null &&
                                    item.discountPercent > 0 && (
                                      <span className="text-emerald-400">
                                        {item.discountPercent}% off
                                      </span>
                                    )}
                                  {item.gstPercent !== null && (
                                    <span className="text-secondary">
                                      +{item.gstPercent}% GST
                                    </span>
                                  )}
                                </div>
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
                                    Reference
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
                                      item.cableSizeSqMm ?? 'spec'
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
                                    text: `Added "${item.productName}" to active floor design & Smart BOQ.`,
                                  });
                                }}
                                className="flex-1 px-2.5 py-1.5 text-[11px] font-label bg-primary text-on-primary cursor-pointer"
                              >
                                + Add to Project
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => toggleCompare(rawItem.id)}
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
                                  onClick={() => startEdit(rawItem)}
                                  className="p-1.5 border border-outline bg-surface-container text-on-surface-variant hover:text-on-surface cursor-pointer"
                                  title="Edit product"
                                >
                                  <span className="material-symbols-outlined text-[14px]">
                                    edit
                                  </span>
                                </button>
                                {confirmDeleteId === rawItem.id ? (
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteProduct(rawItem.id)}
                                    className="px-2 py-1 text-[10px] font-mono bg-red-700 text-white cursor-pointer"
                                  >
                                    Confirm
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteId(rawItem.id)}
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

                  {/* Pagination Footer */}
                  {totalPages > 1 && (
                    <div className="flex items-center justify-between pt-3 border-t border-outline">
                      <span className="font-mono text-xs text-on-surface-variant">
                        Page {safePage} of {totalPages}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={safePage <= 1}
                          onClick={() => setPage((p) => Math.max(1, p - 1))}
                          className="px-3 py-1.5 text-xs font-label border border-outline bg-surface text-on-surface disabled:opacity-40 cursor-pointer"
                        >
                          Previous
                        </button>
                        <button
                          type="button"
                          disabled={safePage >= totalPages}
                          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                          className="px-3 py-1.5 text-xs font-label border border-outline bg-surface text-on-surface disabled:opacity-40 cursor-pointer"
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {tab === 'directory' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border border-outline bg-surface p-3.5">
                <p className="text-xs text-on-surface-variant flex-1 min-w-[240px]">
                  Central directory of{' '}
                  <strong className="text-on-surface">{manufacturers.length}</strong> electrical
                  manufacturers &amp; brands integrated across Blue Space. Select any manufacturer
                  to browse its imported products.
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={directorySearch}
                    onChange={(e) => setDirectorySearch(e.target.value)}
                    placeholder="Filter manufacturers..."
                    className="px-2.5 py-1.5 text-xs bg-surface-container border border-outline text-on-surface"
                  />
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingMfgSlug(null);
                        setMfgForm(EMPTY_MANUFACTURER_FORM);
                        setShowMfgForm((v) => !v);
                      }}
                      className="px-3 py-1.5 text-xs font-label bg-primary text-on-primary cursor-pointer"
                    >
                      {showMfgForm ? 'Close Form' : '+ Add Manufacturer'}
                    </button>
                  )}
                </div>
              </div>

              {isAdmin && showMfgForm && (
                <form
                  onSubmit={handleSaveManufacturer}
                  className="border border-primary/60 bg-surface-container-low p-4 space-y-3 text-xs"
                >
                  <div className="font-mono text-[11px] uppercase text-primary">
                    {editingMfgSlug ? 'Edit Manufacturer' : 'Add Manufacturer to Central Directory'}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <label className="space-y-1">
                      <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                        Manufacturer Name *
                      </span>
                      <input
                        type="text"
                        required
                        value={mfgForm.name}
                        onChange={(e) => setMfgForm((f) => ({ ...f, name: e.target.value }))}
                        placeholder="e.g. Havells, Polycab, Legrand"
                        className="w-full px-2.5 py-1.5 bg-surface border border-outline text-on-surface"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                        Official Website URL
                      </span>
                      <input
                        type="url"
                        value={mfgForm.websiteUrl}
                        onChange={(e) => setMfgForm((f) => ({ ...f, websiteUrl: e.target.value }))}
                        placeholder="https://..."
                        className="w-full px-2.5 py-1.5 bg-surface border border-outline text-on-surface"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                        Notes / Description
                      </span>
                      <input
                        type="text"
                        value={mfgForm.notes}
                        onChange={(e) => setMfgForm((f) => ({ ...f, notes: e.target.value }))}
                        placeholder="Product lines & compliance notes"
                        className="w-full px-2.5 py-1.5 bg-surface border border-outline text-on-surface"
                      />
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      className="px-3.5 py-1.5 bg-primary text-on-primary font-label cursor-pointer"
                    >
                      Save Manufacturer
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowMfgForm(false);
                        setEditingMfgSlug(null);
                      }}
                      className="px-3 py-1.5 border border-outline bg-surface text-on-surface-variant cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {filteredDirectory.map((m) => {
                  const safeSite = sanitizeSafeUrl(m.websiteUrl);
                  return (
                    <div
                      key={m.slug || m.name}
                      className="border border-outline bg-surface p-3.5 flex flex-col justify-between gap-2.5"
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <h3 className="font-headline text-sm font-semibold text-on-surface truncate">
                              {m.name}
                            </h3>
                            <span className="px-1.5 py-0.5 text-[10px] font-mono bg-primary/15 text-primary border border-primary/40 shrink-0">
                              {m.liveCount} SKU{m.liveCount === 1 ? '' : 's'}
                            </span>
                          </div>
                          {safeSite && (
                            <a
                              href={safeSite}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[11px] font-mono text-secondary hover:underline flex items-center gap-0.5 shrink-0"
                            >
                              Site
                              <span className="material-symbols-outlined text-[13px]">
                                open_in_new
                              </span>
                            </a>
                          )}
                        </div>
                        <p className="text-[11px] text-on-surface-variant mt-1 leading-relaxed">
                          {m.notes}
                        </p>
                      </div>
                      <div className="space-y-2 pt-2 border-t border-outline/60">
                        <div className="flex flex-wrap gap-1">
                          {m.primaryCategories.slice(0, 5).map((cat) => (
                            <span
                              key={cat}
                              className="px-1.5 py-0.5 text-[10px] font-mono bg-surface-container text-on-surface-variant border border-outline/60"
                            >
                              {cat}
                            </span>
                          ))}
                        </div>
                        <div className="flex items-center justify-between gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedManufacturer(m.name);
                              setSelectedCategory('ALL');
                              setSelectedSubcategory('ALL');
                              setTab('browse');
                            }}
                            className="flex-1 px-2.5 py-1 text-[11px] font-label border border-primary/50 bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer"
                          >
                            View Products ({m.liveCount})
                          </button>
                          {isAdmin && (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingMfgSlug(m.slug || m.name.toLowerCase());
                                  setMfgForm({
                                    slug: m.slug || '',
                                    name: m.name,
                                    websiteUrl: m.websiteUrl || '',
                                    notes: m.notes || '',
                                    primaryCategories: m.primaryCategories,
                                  });
                                  setShowMfgForm(true);
                                }}
                                className="p-1 border border-outline text-on-surface-variant hover:text-on-surface cursor-pointer"
                                title="Edit manufacturer"
                              >
                                <span className="material-symbols-outlined text-[14px]">edit</span>
                              </button>
                              {m.slug && (
                                <button
                                  type="button"
                                  onClick={() => handleDeleteManufacturer(m.slug!, m.name)}
                                  className="p-1 border border-outline text-on-surface-variant hover:text-red-400 cursor-pointer"
                                  title="Delete manufacturer"
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
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === 'compare' && (
            <div className="space-y-4">
              {comparedItems.length === 0 ? (
                <div className="border border-outline bg-surface p-6 text-center text-xs text-on-surface-variant">
                  Select up to 3 products from the Catalogue Products tab using the{' '}
                  <strong className="text-on-surface">Compare</strong> button to inspect
                  specifications, variants, discounts, GST, and pricing side-by-side.
                </div>
              ) : (
                <div className="overflow-x-auto border border-outline bg-surface">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-outline bg-surface-container-low">
                        <th className="p-3 font-mono text-[11px] text-on-surface-variant w-44">
                          Attribute
                        </th>
                        {comparedItems.map((item) => {
                          const img = sanitizeSafeCatalogueImageUrl(item.imageUrl);
                          return (
                            <th key={item.id} className="p-3 font-headline text-on-surface">
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex items-center gap-2">
                                  {img && (
                                    <img
                                      src={img}
                                      alt={item.productName}
                                      className="w-10 h-10 object-contain bg-white border border-outline p-0.5 shrink-0"
                                    />
                                  )}
                                  <span>{item.productName}</span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => toggleCompare(item.id)}
                                  className="text-[11px] text-on-surface-variant hover:text-red-400 cursor-pointer shrink-0"
                                >
                                  Remove
                                </button>
                              </div>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline/60 font-mono text-[11px]">
                      {(
                        [
                          ['Category', (p: ProductCatalogueItem) => p.category],
                          ['Subcategory', (p: ProductCatalogueItem) => p.subcategory || '—'],
                          ['Manufacturer', (p: ProductCatalogueItem) => p.manufacturer],
                          ['Brand / Series', (p: ProductCatalogueItem) => p.brand],
                          ['Model / SKU', (p: ProductCatalogueItem) => p.modelNumber],
                          [
                            'Variants',
                            (p: ProductCatalogueItem) =>
                              p.variants?.length ? `${p.variants.length} option(s)` : 'Single SKU',
                          ],
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
                          ['Unit', (p: ProductCatalogueItem) => p.unit],
                          [
                            'MRP',
                            (p: ProductCatalogueItem) =>
                              p.mrp !== undefined && p.mrp !== null ? formatINR(p.mrp) : '—',
                          ],
                          [
                            'Discount %',
                            (p: ProductCatalogueItem) =>
                              p.discountPercent !== undefined && p.discountPercent !== null
                                ? `${p.discountPercent}%`
                                : '—',
                          ],
                          [
                            'Selling Price',
                            (p: ProductCatalogueItem) =>
                              p.unitPrice !== null ? formatINR(p.unitPrice) : 'Not configured',
                          ],
                          [
                            'GST %',
                            (p: ProductCatalogueItem) =>
                              p.gstPercent !== null ? `${p.gstPercent}%` : 'Not configured',
                          ],
                        ] as Array<[string, (p: ProductCatalogueItem) => string]>
                      ).map(([label, getter]) => (
                        <tr key={label}>
                          <td className="p-2.5 text-on-surface-variant bg-surface-container-low/40">
                            {label}
                          </td>
                          {comparedItems.map((item) => (
                            <td key={item.id} className="p-2.5 text-on-surface">
                              {getter(item)}
                            </td>
                          ))}
                        </tr>
                      ))}
                      <tr>
                        <td className="p-2.5 text-on-surface-variant bg-surface-container-low/40">
                          Action
                        </td>
                        {comparedItems.map((item) => (
                          <td key={item.id} className="p-2.5">
                            {item.category === 'Cables & Wires' && onAssignCableToCircuit ? (
                              <button
                                type="button"
                                onClick={() => onAssignCableToCircuit(item, targetCircuit)}
                                className="px-2.5 py-1 text-[11px] font-label bg-primary text-on-primary cursor-pointer"
                              >
                                Assign to {targetCircuit.split(' ')[0]}
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => onAddProductToProject(item)}
                                className="px-2.5 py-1 text-[11px] font-label bg-primary text-on-primary cursor-pointer"
                              >
                                + Add to Project
                              </button>
                            )}
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {tab === 'admin' && isAdmin && (
            <div className="space-y-6 max-w-4xl">
              {/* Resumable Cauvery Powers Catalogue Sync Panel */}
              <div className="border border-secondary/50 bg-surface p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-wider text-secondary">
                      RESUMABLE CENTRAL CATALOGUE IMPORT
                    </p>
                    <h3 className="font-headline text-sm font-semibold text-on-surface">
                      Cauvery Powers Official Catalogue Importer
                    </h3>
                  </div>
                  <div className="flex items-center gap-2">
                    {importStatus?.status === 'running' ? (
                      <button
                        type="button"
                        disabled={busyImportAction}
                        onClick={handlePauseImport}
                        className="px-3 py-1.5 text-xs font-label border border-amber-500 bg-amber-500/15 text-amber-200 cursor-pointer disabled:opacity-50"
                      >
                        Pause Import
                      </button>
                    ) : (
                      <>
                        {importStatus &&
                          importStatus.currentPage > 0 &&
                          importStatus.status !== 'completed' && (
                            <button
                              type="button"
                              disabled={busyImportAction}
                              onClick={() => handleTriggerImport(true)}
                              className="px-3 py-1.5 text-xs font-label bg-secondary text-on-secondary cursor-pointer disabled:opacity-50"
                            >
                              Resume from Page {importStatus.currentPage + 1}
                            </button>
                          )}
                        <button
                          type="button"
                          disabled={busyImportAction}
                          onClick={() => handleTriggerImport(false)}
                          className="px-3 py-1.5 text-xs font-label bg-primary text-on-primary cursor-pointer disabled:opacity-50"
                        >
                          Sync / Re-Import Full Catalogue
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {importStatus && (
                  <div className="space-y-2 text-xs font-mono">
                    <div className="flex items-center justify-between text-[11px] text-on-surface-variant">
                      <span>
                        Status:{' '}
                        <strong className="text-on-surface uppercase">{importStatus.status}</strong>{' '}
                        · Pages: {importStatus.currentPage}/{importStatus.totalPages || '?'}
                      </span>
                      <span>
                        Backend:{' '}
                        <strong className="text-secondary">
                          {storageBackend === 'supabase'
                            ? 'Supabase DB + Storage'
                            : 'Local Permanent Store'}
                        </strong>
                      </span>
                    </div>
                    {importStatus.totalPages > 0 && (
                      <div className="w-full h-2 bg-surface-container-high border border-outline overflow-hidden">
                        <div
                          className="h-full bg-primary transition-all duration-300"
                          style={{
                            width: `${Math.min(
                              100,
                              Math.round((importStatus.currentPage / importStatus.totalPages) * 100)
                            )}%`,
                          }}
                        />
                      </div>
                    )}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-[11px]">
                      <div className="p-2 bg-surface-container-low border border-outline/60">
                        <span className="text-on-surface-variant block text-[10px]">
                          Products Stored
                        </span>
                        <span className="text-on-surface font-semibold">
                          {products.length.toLocaleString('en-IN')}
                        </span>
                      </div>
                      <div className="p-2 bg-surface-container-low border border-outline/60">
                        <span className="text-on-surface-variant block text-[10px]">
                          Manufacturers
                        </span>
                        <span className="text-on-surface font-semibold">
                          {manufacturers.length}
                        </span>
                      </div>
                      <div className="p-2 bg-surface-container-low border border-outline/60">
                        <span className="text-on-surface-variant block text-[10px]">
                          Duplicates Skipped
                        </span>
                        <span className="text-on-surface font-semibold">
                          {importStatus.skippedDuplicatesCount}
                        </span>
                      </div>
                      <div className="p-2 bg-surface-container-low border border-outline/60">
                        <span className="text-on-surface-variant block text-[10px]">
                          Failures (Prod / Img)
                        </span>
                        <span
                          className={
                            importStatus.failedCount + importStatus.imagesFailedCount > 0
                              ? 'text-red-400 font-semibold'
                              : 'text-emerald-400 font-semibold'
                          }
                        >
                          {importStatus.failedCount} / {importStatus.imagesFailedCount}
                        </span>
                      </div>
                    </div>

                    {importStatus.errors.length > 0 && (
                      <div>
                        <button
                          type="button"
                          onClick={() => setShowImportErrors((v) => !v)}
                          className="text-[11px] text-red-300 underline cursor-pointer"
                        >
                          {showImportErrors ? 'Hide' : 'Show'} Error Report (
                          {importStatus.errors.length})
                        </button>
                        {showImportErrors && (
                          <div className="mt-1 max-h-36 overflow-y-auto bg-red-950/30 border border-red-800/50 p-2 space-y-1 text-[10px] text-red-200">
                            {importStatus.errors.slice(0, 50).map((err, i) => (
                              <div key={i}>
                                [{err.stage}] {err.ref || ''}: {err.message}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Add / Edit Product Form */}
              <form onSubmit={handleSaveForm} className="space-y-4">
                <div className="border border-outline bg-surface p-3 text-xs text-on-surface-variant">
                  {editingId
                    ? 'Editing an existing central catalogue product. Price updates apply to future selections while preserving historical prices already saved in project BOQs.'
                    : 'Add a verified product to the central Blue Space catalogue. Upload product images directly to Blue Space / Supabase Storage so no external image links are ever required.'}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  <label className="space-y-1">
                    <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                      Product Category *
                    </span>
                    <select
                      value={form.category}
                      onChange={(e) =>
                        handleFormCategoryChange(e.target.value as CatalogueCategory)
                      }
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
                      Subcategory
                    </span>
                    <input
                      type="text"
                      value={form.subcategory}
                      onChange={(e) => setForm((f) => ({ ...f, subcategory: e.target.value }))}
                      placeholder="e.g. Modular Switches, House Wires"
                      className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                    />
                  </label>

                  <label className="space-y-1">
                    <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                      Manufacturer *
                    </span>
                    <input
                      type="text"
                      list="central-manufacturers-datalist"
                      value={form.manufacturer}
                      onChange={(e) => setForm((f) => ({ ...f, manufacturer: e.target.value }))}
                      placeholder="Polycab, Havells, Legrand..."
                      className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                    />
                    <datalist id="central-manufacturers-datalist">
                      {allManufacturerNames.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
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
                      Brand / Series
                    </span>
                    <input
                      type="text"
                      value={form.brand}
                      onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
                      placeholder="e.g. Roma, Crabtree, FRLS"
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

                  <label className="space-y-1">
                    <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                      SKU Code
                    </span>
                    <input
                      type="text"
                      value={form.sku}
                      onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
                      placeholder="Optional internal SKU"
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
                      Wattage (W)
                    </span>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={form.wattageW}
                      onChange={(e) => setForm((f) => ({ ...f, wattageW: e.target.value }))}
                      placeholder="Optional"
                      className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                    />
                  </label>

                  <label className="space-y-1">
                    <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                      Cable Size (sq.mm)
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
                      MRP (₹)
                    </span>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={form.mrp}
                      onChange={(e) => setForm((f) => ({ ...f, mrp: e.target.value }))}
                      placeholder="List MRP"
                      className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                    />
                  </label>

                  <label className="space-y-1">
                    <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                      Selling Price (₹)
                    </span>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={form.unitPrice}
                      onChange={(e) => setForm((f) => ({ ...f, unitPrice: e.target.value }))}
                      placeholder="Ex-GST rate"
                      className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                    />
                  </label>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="font-mono text-[10px] uppercase text-on-surface-variant">
                        Discount %
                      </span>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        max="100"
                        value={form.discountPercent}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, discountPercent: e.target.value }))
                        }
                        placeholder="Auto"
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
                        placeholder="18"
                        className="w-full px-2.5 py-2 bg-surface border border-outline text-on-surface"
                      />
                    </label>
                  </div>

                  {/* Image Upload to Supabase Storage / Blue Space Hosted */}
                  <div className="space-y-1 md:col-span-3">
                    <span className="font-mono text-[10px] uppercase text-on-surface-variant block">
                      Product Image (Hosted in Supabase Storage / Blue Space)
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      {sanitizeSafeCatalogueImageUrl(form.imageUrl) && (
                        <img
                          src={sanitizeSafeCatalogueImageUrl(form.imageUrl)!}
                          alt="Product preview"
                          className="w-12 h-12 object-contain bg-white border border-outline p-0.5"
                        />
                      )}
                      <button
                        type="button"
                        disabled={uploadingImage}
                        onClick={() => imageUploadInputRef.current?.click()}
                        className="px-3 py-2 text-xs font-label border border-secondary/50 bg-secondary/10 text-secondary hover:bg-secondary/20 cursor-pointer disabled:opacity-50 flex items-center gap-1"
                      >
                        <span className="material-symbols-outlined text-[15px]">
                          cloud_upload
                        </span>
                        {uploadingImage ? 'Uploading...' : 'Upload Image File'}
                      </button>
                      <input
                        ref={imageUploadInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        onChange={handleImageFileUpload}
                        className="hidden"
                      />
                      <input
                        type="text"
                        value={form.imageUrl}
                        onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))}
                        placeholder="/api/catalogue/images/... or Supabase Storage URL"
                        className="flex-1 min-w-[220px] px-2.5 py-2 bg-surface border border-outline text-on-surface font-mono text-[11px]"
                      />
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-2">
                  <button
                    type="submit"
                    disabled={savingProduct}
                    className="px-4 py-2 text-xs font-label bg-primary text-on-primary cursor-pointer disabled:opacity-50"
                  >
                    {savingProduct
                      ? 'Saving...'
                      : editingId
                        ? 'Save Catalogue Changes'
                        : 'Add Product to Central Catalogue'}
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
