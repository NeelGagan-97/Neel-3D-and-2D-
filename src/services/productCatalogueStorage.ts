import readXlsxFile from 'read-excel-file/universal';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import {
  CatalogueCategory,
  CatalogueImportJobStatus,
  ManufacturerName,
  ManufacturerReference,
  ProductCatalogueItem,
  ProductCatalogueVariant,
} from '../types/catalogue';
import { ElectricalItemType } from '../types/design';
import { formatSafeCsvRow, sanitizeCsvTextValue } from '../utils/csvSecurity';
import {
  sanitizeSafeCatalogueImageUrl,
  sanitizeSafeUrl,
  validateSafeUrl,
} from '../utils/urlSecurity';

const CATALOGUE_STORAGE_KEY = 'blue_space_product_catalogue_v1';
const MANUFACTURER_STORAGE_KEY = 'blue_space_manufacturer_directory_v1';
const SUPABASE_STORAGE_BUCKET = 'catalogue-images';

export const SPREADSHEET_LIMITS = {
  maxFileSizeBytes: 5 * 1024 * 1024, // 5 MB
  maxSheets: 10,
  maxRows: 5_000,
  maxColumns: 50,
  maxCellLength: 2_000,
} as const;

const FORBIDDEN_HEADER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const RECOGNIZED_PRODUCT_NAME_HEADERS = new Set([
  'productname',
  'name',
  'product',
  'description',
  'title',
]);

const RECOGNIZED_ANY_HEADERS = new Set([
  ...RECOGNIZED_PRODUCT_NAME_HEADERS,
  'category',
  'productcategory',
  'subcategory',
  'type',
  'manufacturer',
  'make',
  'vendor',
  'company',
  'brand',
  'series',
  'range',
  'modelnumber',
  'model',
  'sku',
  'partnumber',
  'catalogcode',
  'code',
  'specification',
  'specs',
  'technicalspecification',
  'details',
  'rating',
  'electricalrating',
  'voltagecurrent',
  'wattagew',
  'wattage',
  'watts',
  'powerw',
  'cablesizesqmm',
  'cablesize',
  'sqmm',
  'crosssection',
  'dimensions',
  'size',
  'dimension',
  'unit',
  'uom',
  'unitprice',
  'price',
  'rate',
  'mrp',
  'discount',
  'discountpercent',
  'cost',
  'gstpercent',
  'gst',
  'taxpercent',
  'tax',
  'imageurl',
  'image',
  'photo',
  'datasheeturl',
  'datasheet',
  'specsheet',
  'manufacturerurl',
  'producturl',
  'url',
  'website',
]);

export const CATALOGUE_CATEGORIES: CatalogueCategory[] = [
  'Cables & Wires',
  'Switches',
  'Sockets',
  'Distribution Boards',
  'MCBs',
  'RCCBs & RCBOs',
  'Earthing Accessories',
  'LED Bulbs',
  'LED Panels',
  'LED Downlights',
  'LED Strips',
  'LED Battens',
  'Fans',
  'Electrical Appliances',
  'Conduits & Accessories',
];

export const MANUFACTURER_REFERENCES: ManufacturerReference[] = [
  {
    slug: 'polycab',
    name: 'Polycab',
    websiteUrl: 'https://polycab.com/',
    primaryCategories: ['Cables & Wires', 'Switches', 'Distribution Boards', 'Fans', 'LED Bulbs'],
    notes: 'Official manufacturer directory for house wires, FRLS cables, switchgear, lighting & fans.',
    source: 'official-directory',
  },
  {
    slug: 'finolex',
    name: 'Finolex',
    websiteUrl: 'https://www.finolex.com/',
    primaryCategories: ['Cables & Wires', 'Switches', 'MCBs', 'Fans', 'LED Bulbs'],
    notes: 'Official manufacturer directory for Flame Retardant house wires, conduits, switchgear & lighting.',
    source: 'official-directory',
  },
  {
    slug: 'havells',
    name: 'Havells',
    websiteUrl: 'https://havells.com/',
    primaryCategories: [
      'Cables & Wires',
      'Switches',
      'Sockets',
      'Distribution Boards',
      'MCBs',
      'RCCBs & RCBOs',
      'Fans',
      'Electrical Appliances',
    ],
    notes: 'Official manufacturer directory for cables, Crabtree/Havells modular switchgear, DBs, fans & appliances.',
    source: 'official-directory',
  },
  {
    slug: 'rr-kabel',
    name: 'RR Kabel',
    websiteUrl: 'https://www.rrkabel.com/',
    primaryCategories: ['Cables & Wires', 'Switches', 'Fans', 'LED Panels', 'LED Downlights'],
    notes: 'Official manufacturer directory for FRLSH / LSZH building wires, fans and architectural LED luminaires.',
    source: 'official-directory',
  },
  {
    slug: 'kei',
    name: 'KEI',
    websiteUrl: 'https://www.kei-ind.com/',
    primaryCategories: ['Cables & Wires'],
    notes: 'Official manufacturer directory for residential house wires, multi-core flexible & armoured cables.',
    source: 'official-directory',
  },
  {
    slug: 'legrand',
    name: 'Legrand',
    websiteUrl: 'https://www.legrand.co.in/',
    primaryCategories: ['Switches', 'Sockets', 'Distribution Boards', 'MCBs', 'RCCBs & RCBOs'],
    notes: 'Official manufacturer directory for modular wiring accessories, Ekinoxe/DX3 DBs, MCBs & RCCBs.',
    source: 'official-directory',
  },
  {
    slug: 'schneider-electric',
    name: 'Schneider Electric',
    websiteUrl: 'https://www.se.com/in/en/',
    primaryCategories: ['Switches', 'Sockets', 'Distribution Boards', 'MCBs', 'RCCBs & RCBOs', 'Earthing Accessories'],
    notes: 'Official manufacturer directory for Acti9/Easy9 switchgear, distribution boards & modular switches.',
    source: 'official-directory',
  },
  {
    slug: 'anchor-panasonic',
    name: 'Anchor / Panasonic',
    websiteUrl: 'https://lsin.panasonic.com/',
    primaryCategories: ['Switches', 'Sockets', 'Cables & Wires', 'Distribution Boards', 'MCBs', 'Fans'],
    notes: 'Official manufacturer directory for Anchor Roma/Penta/Woods modular switches, wires & switchgear.',
    source: 'official-directory',
  },
  {
    slug: 'gm-modular',
    name: 'GM Modular',
    websiteUrl: 'https://www.gmmodular.com/',
    primaryCategories: ['Switches', 'Sockets', 'LED Panels', 'LED Strips', 'LED Downlights', 'Fans'],
    notes: 'Official manufacturer directory for modular switches, sockets, home automation & LED lighting.',
    source: 'official-directory',
  },
  {
    slug: 'philips-signify',
    name: 'Philips / Signify',
    websiteUrl: 'https://www.lighting.philips.co.in/',
    primaryCategories: ['LED Bulbs', 'LED Panels', 'LED Downlights', 'LED Strips', 'LED Battens'],
    notes: 'Official manufacturer directory for LED luminaires, downlights, recessed panels, strips & battens.',
    source: 'official-directory',
  },
  {
    slug: 'wipro',
    name: 'Wipro',
    websiteUrl: 'https://www.wiprolighting.com/',
    primaryCategories: ['LED Bulbs', 'LED Panels', 'LED Downlights', 'LED Strips', 'LED Battens', 'Switches'],
    notes: 'Official manufacturer directory for residential/commercial LED luminaires & Garnet/North-West accessories.',
    source: 'official-directory',
  },
  {
    slug: 'crompton',
    name: 'Crompton',
    websiteUrl: 'https://www.crompton.co.in/',
    primaryCategories: ['Fans', 'LED Bulbs', 'LED Panels', 'LED Battens', 'Electrical Appliances'],
    notes: 'Official manufacturer directory for BLDC/induction fans, water heaters & LED luminaires.',
    source: 'official-directory',
  },
  {
    slug: 'bajaj',
    name: 'Bajaj',
    websiteUrl: 'https://www.bajajelectricals.com/',
    primaryCategories: ['Fans', 'LED Bulbs', 'LED Battens', 'LED Downlights', 'Electrical Appliances'],
    notes: 'Official manufacturer directory for ceiling/exhaust fans, water heaters & LED lighting.',
    source: 'official-directory',
  },
];

export const MANUFACTURER_NAMES: ManufacturerName[] = MANUFACTURER_REFERENCES.map(
  (m) => m.name as ManufacturerName
);

export function inferMappedItemType(
  category: CatalogueCategory,
  productName = ''
): ElectricalItemType | undefined {
  const lower = productName.toLowerCase();
  switch (category) {
    case 'Cables & Wires':
      return undefined;
    case 'Switches':
      return lower.includes('board') || lower.includes('plate') || lower.includes('frame')
        ? 'switchboard'
        : 'switch';
    case 'Sockets':
      if (lower.includes('usb')) return 'usb_outlet';
      if (lower.includes('16a') || lower.includes('20a') || lower.includes('25a') || lower.includes('power')) {
        return 'socket_16a';
      }
      return 'socket_5a';
    case 'Distribution Boards':
    case 'MCBs':
    case 'RCCBs & RCBOs':
      return 'distribution_board';
    case 'Earthing Accessories':
      return 'earthing_point';
    case 'LED Bulbs':
    case 'LED Battens':
      return lower.includes('chandelier') ? 'chandelier' : 'led_light';
    case 'LED Panels':
      return 'panel_light';
    case 'LED Downlights':
      return 'spotlight';
    case 'LED Strips':
      return 'strip_light';
    case 'Fans':
      return lower.includes('exhaust') || lower.includes('ventilat') ? 'exhaust_fan' : 'ceiling_fan';
    case 'Electrical Appliances':
      if (lower.includes('ac') || lower.includes('air conditioner') || lower.includes('split')) return 'split_ac';
      if (lower.includes('geyser') || lower.includes('water heater')) return 'geyser';
      return 'appliance';
    case 'Conduits & Accessories':
      return 'switch';
    default:
      return undefined;
  }
}

function normalizeCategory(raw: string): CatalogueCategory {
  const cleaned = raw.trim().toLowerCase();
  const exact = CATALOGUE_CATEGORIES.find((c) => c.toLowerCase() === cleaned);
  if (exact) return exact;
  if (cleaned.includes('cable') || cleaned.includes('wire')) return 'Cables & Wires';
  if (cleaned.includes('rccb') || cleaned.includes('rcbo')) return 'RCCBs & RCBOs';
  if (cleaned.includes('mcb')) return 'MCBs';
  if (cleaned.includes('distribution') || cleaned === 'db') return 'Distribution Boards';
  if (cleaned.includes('earth')) return 'Earthing Accessories';
  if (cleaned.includes('socket') || cleaned.includes('outlet')) return 'Sockets';
  if (cleaned.includes('switch')) return 'Switches';
  if (cleaned.includes('panel')) return 'LED Panels';
  if (cleaned.includes('downlight') || cleaned.includes('spot')) return 'LED Downlights';
  if (cleaned.includes('strip')) return 'LED Strips';
  if (cleaned.includes('batten') || cleaned.includes('tube')) return 'LED Battens';
  if (cleaned.includes('bulb') || cleaned.includes('lamp') || cleaned.includes('led')) return 'LED Bulbs';
  if (cleaned.includes('fan')) return 'Fans';
  if (cleaned.includes('conduit') || cleaned.includes('pipe') || cleaned.includes('lug') || cleaned.includes('box') || cleaned.includes('accessor')) {
    return 'Conduits & Accessories';
  }
  return 'Electrical Appliances';
}

function parseOptionalNumber(val: unknown): { value: number | null; invalid: boolean } {
  if (val === null || val === undefined || val === '') return { value: null, invalid: false };
  if (typeof val === 'number') {
    return Number.isFinite(val) ? { value: val, invalid: false } : { value: null, invalid: true };
  }
  const str = String(val).replace(/[₹,\s%]/g, '').trim();
  if (!str) return { value: null, invalid: false };
  const n = Number(str);
  return Number.isFinite(n) ? { value: n, invalid: false } : { value: null, invalid: true };
}

function sanitizeStoredProductUrls(item: ProductCatalogueItem): ProductCatalogueItem {
  const safeImage = sanitizeSafeCatalogueImageUrl(item.imageUrl);
  const safeGallery = Array.isArray(item.galleryImages)
    ? item.galleryImages
        .map((u) => sanitizeSafeCatalogueImageUrl(u))
        .filter((u): u is string => Boolean(u))
    : undefined;
  const safeVariants = Array.isArray(item.variants)
    ? item.variants.map((v) => ({
        ...v,
        imageUrl: sanitizeSafeCatalogueImageUrl(v.imageUrl) ?? null,
      }))
    : undefined;
  return {
    ...item,
    imageUrl: safeImage,
    galleryImages: safeGallery && safeGallery.length > 0 ? safeGallery : undefined,
    variants: safeVariants,
    datasheetUrl: sanitizeSafeUrl(item.datasheetUrl),
    manufacturerUrl: sanitizeSafeUrl(item.manufacturerUrl),
    sourceUrl: sanitizeSafeUrl(item.sourceUrl),
  };
}

// ----------------------------------------------------------------------------
// Central In-Memory Reactive Store (Single Source Across All Studio Modules)
// ----------------------------------------------------------------------------
let centralProductsCache: ProductCatalogueItem[] | null = null;
let centralManufacturersCache: ManufacturerReference[] | null = null;
let centralStorageBackend: 'supabase' | 'local-store' = 'local-store';
let centralHydrationPromise: Promise<void> | null = null;
let centralHydratedOnce = false;
const catalogueListeners = new Set<() => void>();

function notifyCatalogueListeners(): void {
  catalogueListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      // ignore subscriber exceptions
    }
  });
}

export function subscribeCentralCatalogue(listener: () => void): () => void {
  catalogueListeners.add(listener);
  return () => {
    catalogueListeners.delete(listener);
  };
}

export function getCentralStorageBackend(): 'supabase' | 'local-store' {
  return centralStorageBackend;
}

function loadLocalBrowserProducts(): ProductCatalogueItem[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(CATALOGUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is ProductCatalogueItem =>
          Boolean(item && typeof item.id === 'string' && typeof item.productName === 'string')
      )
      .map(sanitizeStoredProductUrls);
  } catch {
    return [];
  }
}

function loadLocalBrowserManufacturers(): ManufacturerReference[] {
  if (typeof localStorage === 'undefined') return [...MANUFACTURER_REFERENCES];
  try {
    const raw = localStorage.getItem(MANUFACTURER_STORAGE_KEY);
    if (!raw) return [...MANUFACTURER_REFERENCES];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return [...MANUFACTURER_REFERENCES];
    return parsed;
  } catch {
    return [...MANUFACTURER_REFERENCES];
  }
}

function saveLocalBrowserManufacturers(mfrs: ManufacturerReference[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(MANUFACTURER_STORAGE_KEY, JSON.stringify(mfrs));
  } catch {
    // ignore storage quota errors
  }
}

function mergeProductLists(
  remote: ProductCatalogueItem[],
  local: ProductCatalogueItem[]
): ProductCatalogueItem[] {
  const byKey = new Map<string, ProductCatalogueItem>();
  for (const p of remote) {
    const clean = sanitizeStoredProductUrls(p);
    byKey.set(clean.sourceKey || clean.id, clean);
  }
  // Preserve any local-only manual or CSV items that haven't been synced to server yet
  for (const p of local) {
    const clean = sanitizeStoredProductUrls(p);
    const key = clean.sourceKey || clean.id;
    if (!byKey.has(key) && clean.source !== 'cauvery-import') {
      byKey.set(key, clean);
    }
  }
  return Array.from(byKey.values());
}

function computeManufacturerCounts(
  products: ProductCatalogueItem[],
  baseManufacturers: ManufacturerReference[]
): ManufacturerReference[] {
  const byKey = new Map<string, ManufacturerReference>();
  const makeKey = (name: string, slug?: string) =>
    (slug || name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')) ||
    'unspecified';

  for (const m of MANUFACTURER_REFERENCES) {
    const key = makeKey(m.name, m.slug);
    byKey.set(key, {
      ...m,
      slug: key,
      primaryCategories: [...m.primaryCategories],
      productCount: 0,
    });
  }
  for (const m of baseManufacturers) {
    const key = makeKey(m.name, m.slug);
    const prev = byKey.get(key);
    byKey.set(key, {
      ...(prev ?? {}),
      ...m,
      slug: key,
      primaryCategories: Array.from(
        new Set([...(prev?.primaryCategories ?? []), ...(m.primaryCategories ?? [])])
      ),
      productCount: 0,
    });
  }
  for (const p of products) {
    if (p.isActive === false) continue;
    const name = (p.manufacturer || '').trim();
    if (!name || name === 'Unspecified') continue;
    const key = makeKey(name);
    const existing = byKey.get(key);
    if (existing) {
      existing.productCount = (existing.productCount ?? 0) + 1;
      if (!existing.primaryCategories.includes(p.category)) {
        existing.primaryCategories.push(p.category);
      }
    } else {
      byKey.set(key, {
        id: `mfr-${key}`,
        slug: key,
        name,
        websiteUrl: p.manufacturerUrl || 'https://www.cauverypowers.com/',
        primaryCategories: [p.category],
        notes: `Electrical manufacturer (${p.category}).`,
        productCount: 1,
        source: p.source === 'cauvery-import' ? 'cauvery-import' : 'admin-entry',
      });
    }
  }

  return Array.from(byKey.values()).sort((a, b) => {
    const diff = (b.productCount ?? 0) - (a.productCount ?? 0);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  });
}

async function buildAdminHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-BlueSpace-Role': 'ADMIN',
  };
  if (supabase && isSupabaseConfigured) {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    } catch {
      // ignore session lookup failure
    }
  }
  return headers;
}

/**
 * Loads the central product catalogue and manufacturer directory from Supabase / server API
 * into memory and notifies all subscribed UI modules (Electrical Library, 2D/3D Inspector,
 * Cable Routing, Product Comparison, and Smart BOQ).
 */
export async function hydrateCentralCatalogue(force = false): Promise<{
  products: ProductCatalogueItem[];
  manufacturers: ManufacturerReference[];
  storageBackend: 'supabase' | 'local-store';
}> {
  if (centralHydrationPromise && !force) {
    await centralHydrationPromise;
    return {
      products: loadCatalogueProducts(),
      manufacturers: loadCatalogueManufacturers(),
      storageBackend: centralStorageBackend,
    };
  }

  if (centralHydratedOnce && !force && centralProductsCache) {
    return {
      products: centralProductsCache,
      manufacturers: centralManufacturersCache ?? loadCatalogueManufacturers(),
      storageBackend: centralStorageBackend,
    };
  }

  const run = async () => {
    const localItems = loadLocalBrowserProducts();
    let remoteProducts: ProductCatalogueItem[] = [];
    let remoteManufacturers: ManufacturerReference[] = [];
    let backend: 'supabase' | 'local-store' = 'local-store';

    // 1. Try direct Supabase read when browser Supabase is configured & user is signed in
    if (supabase && isSupabaseConfigured) {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        if (sessionData?.session?.access_token) {
          const collected: ProductCatalogueItem[] = [];
          const pageSize = 1000;
          let offset = 0;
          while (true) {
            const { data, error } = await supabase
              .from('catalogue_products')
              .select('*')
              .eq('is_active', true)
              .order('updated_at', { ascending: false })
              .range(offset, offset + pageSize - 1);
            if (error) break;
            const rows = data ?? [];
            for (const row of rows) {
              collected.push(
                sanitizeStoredProductUrls({
                  id: String(row.id),
                  sourceKey: typeof row.source_key === 'string' ? row.source_key : undefined,
                  sourceUrl: typeof row.source_url === 'string' ? row.source_url : null,
                  sourceCategory: typeof row.source_category === 'string' ? row.source_category : null,
                  category: normalizeCategory(String(row.category || '')),
                  subcategory: typeof row.subcategory === 'string' ? row.subcategory : null,
                  manufacturerId: typeof row.manufacturer_id === 'string' ? row.manufacturer_id : null,
                  manufacturer: String(row.manufacturer || 'Unspecified'),
                  brand: String(row.brand || row.manufacturer || 'Unspecified'),
                  productName: String(row.product_name || ''),
                  modelNumber: String(row.model_number || 'Not specified'),
                  sku: typeof row.sku === 'string' ? row.sku : null,
                  specification: String(row.specification || ''),
                  technicalSpecs:
                    row.technical_specs && typeof row.technical_specs === 'object'
                      ? (row.technical_specs as Record<string, string>)
                      : undefined,
                  variants: Array.isArray(row.variants)
                    ? (row.variants as ProductCatalogueVariant[])
                    : undefined,
                  rating: String(row.rating || ''),
                  wattageW: row.wattage_w !== null && row.wattage_w !== undefined ? Number(row.wattage_w) : null,
                  cableSizeSqMm:
                    row.cable_size_sq_mm !== null && row.cable_size_sq_mm !== undefined
                      ? Number(row.cable_size_sq_mm)
                      : null,
                  dimensions: String(row.dimensions || ''),
                  unit: String(row.unit || 'Nos'),
                  mrp: row.mrp !== null && row.mrp !== undefined ? Number(row.mrp) : null,
                  unitPrice:
                    row.unit_price !== null && row.unit_price !== undefined ? Number(row.unit_price) : null,
                  discountPercent:
                    row.discount_percent !== null && row.discount_percent !== undefined
                      ? Number(row.discount_percent)
                      : null,
                  gstPercent:
                    row.gst_percent !== null && row.gst_percent !== undefined
                      ? Number(row.gst_percent)
                      : null,
                  gstDetails:
                    row.gst_details && typeof row.gst_details === 'object'
                      ? (row.gst_details as ProductCatalogueItem['gstDetails'])
                      : null,
                  imageStoragePath:
                    typeof row.image_storage_path === 'string' ? row.image_storage_path : null,
                  imageUrl: typeof row.image_url === 'string' ? row.image_url : null,
                  galleryImages: Array.isArray(row.gallery_images)
                    ? (row.gallery_images as string[])
                    : undefined,
                  datasheetUrl: typeof row.datasheet_url === 'string' ? row.datasheet_url : null,
                  manufacturerUrl:
                    typeof row.manufacturer_url === 'string' ? row.manufacturer_url : null,
                  mappedItemType:
                    typeof row.mapped_item_type === 'string'
                      ? (row.mapped_item_type as ElectricalItemType)
                      : undefined,
                  source: (row.source as ProductCatalogueItem['source']) || 'admin-entry',
                  isActive: row.is_active !== false,
                  updatedAt: String(row.updated_at || new Date().toISOString()),
                })
              );
            }
            if (rows.length < pageSize) break;
            offset += pageSize;
          }

          const { data: mfrRows } = await supabase
            .from('catalogue_manufacturers')
            .select('*')
            .eq('is_active', true);

          if (collected.length > 0 || (mfrRows && mfrRows.length > 0)) {
            remoteProducts = collected;
            remoteManufacturers = (mfrRows ?? []).map((m) => ({
              id: String(m.id),
              slug: String(m.slug),
              name: String(m.name),
              websiteUrl: String(m.website_url || ''),
              logoStoragePath: typeof m.logo_storage_path === 'string' ? m.logo_storage_path : null,
              logoUrl: typeof m.logo_url === 'string' ? m.logo_url : null,
              primaryCategories: Array.isArray(m.primary_categories)
                ? (m.primary_categories as CatalogueCategory[])
                : [],
              notes: String(m.notes || ''),
              source: (m.source as ManufacturerReference['source']) || 'admin-entry',
              isActive: m.is_active !== false,
            }));
            backend = 'supabase';
          }
        }
      } catch {
        // Fall through to central API
      }
    }

    // 2. Fallback / primary preview source: Blue Space server central catalogue API
    if (remoteProducts.length === 0 && typeof fetch === 'function') {
      try {
        const resp = await fetch('/api/catalogue/central', {
          headers: { Accept: 'application/json' },
        });
        if (resp.ok) {
          const json = (await resp.json()) as {
            ok?: boolean;
            products?: ProductCatalogueItem[];
            manufacturers?: ManufacturerReference[];
            storageBackend?: 'supabase' | 'local-store';
          };
          if (json?.ok && Array.isArray(json.products)) {
            remoteProducts = json.products.map(sanitizeStoredProductUrls);
            remoteManufacturers = Array.isArray(json.manufacturers) ? json.manufacturers : [];
            backend = json.storageBackend || 'local-store';
          }
        }
      } catch {
        // Offline or unit test environment without server
      }
    }

    const mergedProducts = mergeProductLists(remoteProducts, localItems);
    const mergedManufacturers = computeManufacturerCounts(
      mergedProducts,
      remoteManufacturers.length > 0 ? remoteManufacturers : loadLocalBrowserManufacturers()
    );

    centralProductsCache = mergedProducts;
    centralManufacturersCache = mergedManufacturers;
    centralStorageBackend = backend;
    centralHydratedOnce = true;
    saveLocalBrowserManufacturers(mergedManufacturers);
    notifyCatalogueListeners();
  };

  centralHydrationPromise = run();
  try {
    await centralHydrationPromise;
  } finally {
    centralHydrationPromise = null;
  }

  return {
    products: centralProductsCache ?? [],
    manufacturers: centralManufacturersCache ?? [...MANUFACTURER_REFERENCES],
    storageBackend: centralStorageBackend,
  };
}

export function loadCatalogueProducts(): ProductCatalogueItem[] {
  if (centralProductsCache !== null) {
    return centralProductsCache;
  }
  return loadLocalBrowserProducts();
}

export function loadCatalogueManufacturers(): ManufacturerReference[] {
  if (centralManufacturersCache !== null) {
    return centralManufacturersCache;
  }
  return computeManufacturerCounts(loadCatalogueProducts(), loadLocalBrowserManufacturers());
}

export function saveCatalogueProducts(items: ProductCatalogueItem[]): void {
  const sanitized = items.map(sanitizeStoredProductUrls);
  centralProductsCache = sanitized;
  centralManufacturersCache = computeManufacturerCounts(
    sanitized,
    centralManufacturersCache ?? loadLocalBrowserManufacturers()
  );
  if (typeof localStorage !== 'undefined') {
    try {
      // Keep localStorage within browser quota by storing user-entered items locally
      // while full central catalogue lives in Supabase / server snapshot
      const localManualOnly = sanitized.filter((p) => p.source !== 'cauvery-import');
      localStorage.setItem(CATALOGUE_STORAGE_KEY, JSON.stringify(localManualOnly.slice(0, 500)));
    } catch {
      // ignore storage quota errors
    }
  }
  notifyCatalogueListeners();
}

export function addCatalogueProduct(
  item: Omit<ProductCatalogueItem, 'id' | 'updatedAt'>
): ProductCatalogueItem[] {
  const existing = loadCatalogueProducts();
  const created: ProductCatalogueItem = sanitizeStoredProductUrls({
    ...item,
    id: `cat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    mappedItemType: item.mappedItemType ?? inferMappedItemType(item.category, item.productName),
    updatedAt: new Date().toISOString(),
  });
  const next = [created, ...existing];
  saveCatalogueProducts(next);
  return next;
}

export function updateCatalogueProduct(
  id: string,
  patch: Partial<Omit<ProductCatalogueItem, 'id'>>
): ProductCatalogueItem[] {
  const existing = loadCatalogueProducts();
  const next = existing.map((item) =>
    item.id === id
      ? sanitizeStoredProductUrls({
          ...item,
          ...patch,
          updatedAt: new Date().toISOString(),
        })
      : item
  );
  saveCatalogueProducts(next);
  return next;
}

export function deleteCatalogueProduct(id: string): ProductCatalogueItem[] {
  const existing = loadCatalogueProducts();
  const next = existing.filter((item) => item.id !== id);
  saveCatalogueProducts(next);
  return next;
}

export async function saveCentralCatalogueProduct(
  payload: Omit<ProductCatalogueItem, 'id' | 'updatedAt'> & { id?: string }
): Promise<{ ok: boolean; product?: ProductCatalogueItem; products: ProductCatalogueItem[]; error?: string }> {
  try {
    const headers = await buildAdminHeaders();
    const resp = await fetch('/api/catalogue/products', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const json = (await resp.json()) as { ok?: boolean; product?: ProductCatalogueItem; error?: string };
    if (!resp.ok || !json.ok || !json.product) {
      throw new Error(json?.error || `HTTP ${resp.status}`);
    }
    const saved = sanitizeStoredProductUrls(json.product);
    const existing = loadCatalogueProducts();
    const idx = existing.findIndex((p) => p.id === saved.id);
    const next =
      idx >= 0
        ? existing.map((p, i) => (i === idx ? saved : p))
        : [saved, ...existing];
    saveCatalogueProducts(next);
    return { ok: true, product: saved, products: next };
  } catch (err) {
    // Fallback to local state if server route unavailable
    const next = payload.id
      ? updateCatalogueProduct(payload.id, payload)
      : addCatalogueProduct(payload);
    return {
      ok: true,
      products: next,
      error: err instanceof Error ? err.message : undefined,
    };
  }
}

export async function removeCentralCatalogueProduct(
  id: string
): Promise<{ ok: boolean; products: ProductCatalogueItem[]; error?: string }> {
  try {
    const headers = await buildAdminHeaders();
    const resp = await fetch(`/api/catalogue/products/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers,
    });
    if (!resp.ok) {
      const json = (await resp.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, products: loadCatalogueProducts(), error: json?.error || `HTTP ${resp.status}` };
    }
  } catch {
    // allow local fallback when offline
  }
  const next = deleteCatalogueProduct(id);
  return { ok: true, products: next };
}

export async function saveCentralManufacturer(
  mfr: Omit<ManufacturerReference, 'slug'> & { slug?: string }
): Promise<{ ok: boolean; manufacturers: ManufacturerReference[]; error?: string }> {
  try {
    const headers = await buildAdminHeaders();
    const resp = await fetch('/api/catalogue/manufacturers', {
      method: 'POST',
      headers,
      body: JSON.stringify(mfr),
    });
    const json = (await resp.json()) as {
      ok?: boolean;
      manufacturer?: ManufacturerReference;
      error?: string;
    };
    if (!resp.ok || !json.ok || !json.manufacturer) {
      return {
        ok: false,
        manufacturers: loadCatalogueManufacturers(),
        error: json?.error || `HTTP ${resp.status}`,
      };
    }
    const existing = loadCatalogueManufacturers();
    const saved = json.manufacturer;
    const idx = existing.findIndex((x) => x.slug === saved.slug);
    const merged =
      idx >= 0
        ? existing.map((x, i) => (i === idx ? { ...x, ...saved } : x))
        : [...existing, saved];
    centralManufacturersCache = computeManufacturerCounts(loadCatalogueProducts(), merged);
    saveLocalBrowserManufacturers(centralManufacturersCache);
    notifyCatalogueListeners();
    return { ok: true, manufacturers: centralManufacturersCache };
  } catch (err) {
    return {
      ok: false,
      manufacturers: loadCatalogueManufacturers(),
      error: err instanceof Error ? err.message : 'Failed to save manufacturer.',
    };
  }
}

export async function removeCentralManufacturer(
  slug: string
): Promise<{ ok: boolean; manufacturers: ManufacturerReference[]; error?: string }> {
  try {
    const headers = await buildAdminHeaders();
    const resp = await fetch(`/api/catalogue/manufacturers/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
      headers,
    });
    if (!resp.ok) {
      const json = (await resp.json().catch(() => null)) as { error?: string } | null;
      return {
        ok: false,
        manufacturers: loadCatalogueManufacturers(),
        error: json?.error || `HTTP ${resp.status}`,
      };
    }
    const next = loadCatalogueManufacturers().filter((m) => m.slug !== slug);
    centralManufacturersCache = next;
    saveLocalBrowserManufacturers(next);
    notifyCatalogueListeners();
    return { ok: true, manufacturers: next };
  } catch (err) {
    return {
      ok: false,
      manufacturers: loadCatalogueManufacturers(),
      error: err instanceof Error ? err.message : 'Failed to delete manufacturer.',
    };
  }
}

/**
 * Uploads an admin-selected image file directly to Supabase Storage (if configured)
 * or to Blue Space's permanent server image store — never storing external hotlinks.
 */
export async function uploadCatalogueProductImage(
  file: File
): Promise<{ ok: boolean; storagePath?: string; publicUrl?: string; error?: string }> {
  if (file.size === 0 || file.size > 5 * 1024 * 1024) {
    return { ok: false, error: 'Image must be between 1 byte and 5 MB.' };
  }
  const allowedMimes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  if (!allowedMimes.has(file.type)) {
    return { ok: false, error: 'Only JPEG, PNG, WebP, or GIF images are supported.' };
  }

  // Try direct Supabase Storage upload when configured & authenticated
  if (supabase && isSupabaseConfigured) {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      if (sessionData?.session?.access_token) {
        const ext =
          file.type === 'image/png'
            ? 'png'
            : file.type === 'image/webp'
              ? 'webp'
              : file.type === 'image/gif'
                ? 'gif'
                : 'jpg';
        const objectPath = `products/admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const up = await supabase.storage
          .from(SUPABASE_STORAGE_BUCKET)
          .upload(objectPath, file, { contentType: file.type, upsert: true });
        if (!up.error) {
          const pub = supabase.storage.from(SUPABASE_STORAGE_BUCKET).getPublicUrl(objectPath);
          if (pub?.data?.publicUrl) {
            return { ok: true, storagePath: objectPath, publicUrl: pub.data.publicUrl };
          }
        }
      }
    } catch {
      // Fall through to server upload endpoint
    }
  }

  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read selected image file.'));
      reader.readAsDataURL(file);
    });
    const headers = await buildAdminHeaders();
    const resp = await fetch('/api/catalogue/images/upload', {
      method: 'POST',
      headers,
      body: JSON.stringify({ dataUrl }),
    });
    const json = (await resp.json()) as {
      ok?: boolean;
      storagePath?: string;
      publicUrl?: string;
      error?: string;
    };
    if (!resp.ok || !json.ok || !json.publicUrl) {
      return { ok: false, error: json?.error || 'Failed to upload product image.' };
    }
    return { ok: true, storagePath: json.storagePath, publicUrl: json.publicUrl };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to upload product image.',
    };
  }
}

export async function fetchCauveryImportStatus(): Promise<{
  ok: boolean;
  status?: CatalogueImportJobStatus;
  supabaseServerConfigured?: boolean;
  error?: string;
}> {
  try {
    const resp = await fetch('/api/catalogue/import/cauvery/status');
    const json = (await resp.json()) as {
      ok?: boolean;
      status?: CatalogueImportJobStatus;
      supabaseServerConfigured?: boolean;
      error?: string;
    };
    if (!resp.ok || !json.ok) {
      return { ok: false, error: json?.error || `HTTP ${resp.status}` };
    }
    return {
      ok: true,
      status: json.status,
      supabaseServerConfigured: json.supabaseServerConfigured,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Status check failed.' };
  }
}

export async function triggerCauveryImport(
  resume = false
): Promise<{ ok: boolean; status?: CatalogueImportJobStatus; error?: string }> {
  try {
    const headers = await buildAdminHeaders();
    const resp = await fetch('/api/catalogue/import/cauvery/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ resume }),
    });
    const json = (await resp.json()) as {
      ok?: boolean;
      status?: CatalogueImportJobStatus;
      error?: string;
    };
    if (!resp.ok || !json.ok) {
      return { ok: false, error: json?.error || `HTTP ${resp.status}` };
    }
    return { ok: true, status: json.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to start import.' };
  }
}

export async function pauseCauveryImport(): Promise<{
  ok: boolean;
  status?: CatalogueImportJobStatus;
  error?: string;
}> {
  try {
    const headers = await buildAdminHeaders();
    const resp = await fetch('/api/catalogue/import/cauvery/pause', {
      method: 'POST',
      headers,
    });
    const json = (await resp.json()) as {
      ok?: boolean;
      status?: CatalogueImportJobStatus;
      error?: string;
    };
    if (!resp.ok || !json.ok) {
      return { ok: false, error: json?.error || `HTTP ${resp.status}` };
    }
    return { ok: true, status: json.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to pause import.' };
  }
}

/**
 * Resolves a ProductCatalogueItem with a specific variant's SKU, model number,
 * display name, MRP, selling price, discount %, and hosted image so every downstream
 * module (2D/3D placement, Cable Routing, Smart BOQ) snapshots exact variant pricing.
 */
export function resolveProductWithVariant(
  product: ProductCatalogueItem,
  variantSku?: string | null
): ProductCatalogueItem & { selectedVariant?: ProductCatalogueVariant } {
  if (!variantSku || !product.variants || product.variants.length === 0) {
    return product;
  }
  const variant = product.variants.find((v) => v.sku === variantSku || v.id === variantSku);
  if (!variant) return product;
  const specSuffix = variant.label && !product.specification.includes(variant.label)
    ? `${product.specification ? `${product.specification} · ` : ''}${variant.label}`
    : product.specification;
  return {
    ...product,
    productName: variant.displayName || product.productName,
    modelNumber: variant.modelNumber || variant.sku || product.modelNumber,
    sku: variant.sku || product.sku,
    specification: specSuffix,
    mrp: variant.mrp !== null ? variant.mrp : product.mrp,
    unitPrice: variant.unitPrice !== null ? variant.unitPrice : product.unitPrice,
    discountPercent:
      variant.discountPercent !== null ? variant.discountPercent : product.discountPercent,
    imageUrl: variant.imageUrl || product.imageUrl,
    imageStoragePath: variant.imageStoragePath || product.imageStoragePath,
    selectedVariant: variant,
  };
}

export interface CatalogueImportResult {
  items: ProductCatalogueItem[];
  errors: string[];
}

export interface SpreadsheetFileMeta {
  name?: string;
  type?: string;
  size?: number;
}

function isZipSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  );
}

function isLegacyOleSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  );
}

function looksLikeTextCsv(bytes: Uint8Array): boolean {
  const sampleLen = Math.min(bytes.length, 4096);
  let nullBytes = 0;
  for (let i = 0; i < sampleLen; i++) {
    if (bytes[i] === 0x00) {
      nullBytes += 1;
    }
  }
  return nullBytes === 0;
}

export function validateSpreadsheetUpload(
  bytes: Uint8Array,
  meta?: SpreadsheetFileMeta
): { ok: true; format: 'xlsx' | 'csv' } | { ok: false; error: string } {
  const byteSize = meta?.size ?? bytes.byteLength;
  if (bytes.byteLength === 0 || byteSize === 0) {
    return { ok: false, error: 'Uploaded spreadsheet file is empty.' };
  }
  if (byteSize > SPREADSHEET_LIMITS.maxFileSizeBytes || bytes.byteLength > SPREADSHEET_LIMITS.maxFileSizeBytes) {
    return {
      ok: false,
      error: `Spreadsheet exceeds maximum allowed size (${Math.round(SPREADSHEET_LIMITS.maxFileSizeBytes / (1024 * 1024))} MB).`,
    };
  }

  const rawName = (meta?.name ?? '').trim();
  const extMatch = rawName ? /\.([a-z0-9]+)$/i.exec(rawName) : null;
  const ext = extMatch ? extMatch[1].toLowerCase() : '';

  if (ext === 'xls') {
    return {
      ok: false,
      error: 'Legacy binary .xls files are not supported. Save the spreadsheet as .xlsx or .csv and upload again.',
    };
  }
  if (ext === 'xlsm' || ext === 'xlsb') {
    return {
      ok: false,
      error: 'Macro-enabled or binary Excel workbooks (.xlsm / .xlsb) are not permitted. Export as .xlsx or .csv.',
    };
  }
  if (ext && ext !== 'xlsx' && ext !== 'csv') {
    return {
      ok: false,
      error: `Unsupported file extension ".${ext}". Upload a .xlsx or .csv spreadsheet.`,
    };
  }

  if (isLegacyOleSignature(bytes)) {
    return {
      ok: false,
      error: 'Legacy binary .xls file detected. Convert to .xlsx or .csv before importing.',
    };
  }

  const mime = (meta?.type ?? '').trim().toLowerCase();
  const isZip = isZipSignature(bytes);

  if (ext === 'xlsx') {
    if (!isZip) {
      return {
        ok: false,
        error: 'Invalid .xlsx file: file signature does not match an OOXML workbook.',
      };
    }
    if (
      mime &&
      mime !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' &&
      mime !== 'application/octet-stream' &&
      mime !== 'application/zip'
    ) {
      return {
        ok: false,
        error: `Unexpected MIME type "${mime}" for .xlsx upload.`,
      };
    }
    return { ok: true, format: 'xlsx' };
  }

  if (ext === 'csv') {
    if (isZip || !looksLikeTextCsv(bytes)) {
      return {
        ok: false,
        error: 'Invalid .csv file: binary content detected.',
      };
    }
    if (
      mime &&
      mime !== 'text/csv' &&
      mime !== 'text/plain' &&
      mime !== 'application/vnd.ms-excel' &&
      mime !== 'application/csv' &&
      mime !== 'application/octet-stream'
    ) {
      return {
        ok: false,
        error: `Unexpected MIME type "${mime}" for .csv upload.`,
      };
    }
    return { ok: true, format: 'csv' };
  }

  if (isZip) {
    return { ok: true, format: 'xlsx' };
  }
  if (looksLikeTextCsv(bytes)) {
    return { ok: true, format: 'csv' };
  }
  return {
    ok: false,
    error: 'Unrecognized spreadsheet format. Upload a valid .xlsx or .csv file.',
  };
}

function parseCsvRows(text: string): { rows: string[][]; error?: string } {
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inQuotes) {
      if (ch === '"') {
        if (cleaned[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      if (field.length === 0) {
        inQuotes = true;
      } else {
        field += ch;
      }
    } else if (ch === ',') {
      row.push(field);
      field = '';
      if (row.length > SPREADSHEET_LIMITS.maxColumns) {
        return {
          rows: [],
          error: `Spreadsheet exceeds the maximum allowed column count (${SPREADSHEET_LIMITS.maxColumns}).`,
        };
      }
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && cleaned[i + 1] === '\n') {
        i += 1;
      }
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) {
        rows.push(row);
        if (rows.length > SPREADSHEET_LIMITS.maxRows + 1) {
          return {
            rows: [],
            error: `Spreadsheet exceeds the maximum allowed row count (${SPREADSHEET_LIMITS.maxRows} data rows).`,
          };
        }
      }
      row = [];
    } else {
      field += ch;
    }
  }

  if (inQuotes) {
    return { rows: [], error: 'Malformed CSV file: unterminated quoted value.' };
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.length > SPREADSHEET_LIMITS.maxColumns) {
      return {
        rows: [],
        error: `Spreadsheet exceeds the maximum allowed column count (${SPREADSHEET_LIMITS.maxColumns}).`,
      };
    }
    if (row.some((c) => c.trim() !== '')) {
      rows.push(row);
    }
  }

  return { rows };
}

function normalizeHeaderKey(rawHeader: unknown): string {
  const raw = String(rawHeader ?? '').trim().toLowerCase();
  if (FORBIDDEN_HEADER_KEYS.has(raw)) return '';
  const cleaned = raw.replace(/[^a-z0-9]/g, '');
  if (!cleaned || FORBIDDEN_HEADER_KEYS.has(cleaned)) return '';
  return cleaned;
}

function sanitizeImportedText(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val).replace(/\0/g, '').trim();
  if (!str) return '';
  const truncated =
    str.length > SPREADSHEET_LIMITS.maxCellLength
      ? str.slice(0, SPREADSHEET_LIMITS.maxCellLength)
      : str;
  return sanitizeCsvTextValue(truncated);
}

export async function parseCatalogueSpreadsheet(
  input: ArrayBuffer | Uint8Array,
  meta?: SpreadsheetFileMeta
): Promise<CatalogueImportResult> {
  const errors: string[] = [];
  const items: ProductCatalogueItem[] = [];

  try {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const validation = validateSpreadsheetUpload(bytes, meta);
    if (!validation.ok) {
      return { items: [], errors: [validation.error] };
    }

    let rawRows: unknown[][];

    if (validation.format === 'xlsx') {
      const sheets = await readXlsxFile(bytes);
      if (!Array.isArray(sheets) || sheets.length === 0) {
        return { items: [], errors: ['Spreadsheet contains no worksheets.'] };
      }
      if (sheets.length > SPREADSHEET_LIMITS.maxSheets) {
        return {
          items: [],
          errors: [
            `Spreadsheet has ${sheets.length} worksheets, exceeding the maximum allowed (${SPREADSHEET_LIMITS.maxSheets}).`,
          ],
        };
      }
      rawRows = sheets[0].data as unknown[][];
    } else {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const csvParsed = parseCsvRows(decoder.decode(bytes));
      if (csvParsed.error) {
        return { items: [], errors: [csvParsed.error] };
      }
      rawRows = csvParsed.rows;
    }

    if (!rawRows || rawRows.length === 0) {
      return { items: [], errors: ['Spreadsheet worksheet is empty.'] };
    }

    if (rawRows.length - 1 > SPREADSHEET_LIMITS.maxRows) {
      return {
        items: [],
        errors: [
          `Spreadsheet contains ${rawRows.length - 1} rows, exceeding the maximum allowed (${SPREADSHEET_LIMITS.maxRows}).`,
        ],
      };
    }

    const headerRow = rawRows[0];
    if (!Array.isArray(headerRow) || headerRow.length === 0) {
      return { items: [], errors: ['Spreadsheet is missing a header row.'] };
    }
    if (headerRow.length > SPREADSHEET_LIMITS.maxColumns) {
      return {
        items: [],
        errors: [
          `Spreadsheet contains ${headerRow.length} columns, exceeding the maximum allowed (${SPREADSHEET_LIMITS.maxColumns}).`,
        ],
      };
    }

    for (const rawCell of headerRow) {
      const rawKey = String(rawCell ?? '').trim().toLowerCase();
      if (FORBIDDEN_HEADER_KEYS.has(rawKey)) {
        return {
          items: [],
          errors: [`Spreadsheet contains a prohibited column header ("${rawKey}").`],
        };
      }
    }

    const normalizedHeaders = headerRow.map((h) => normalizeHeaderKey(h));
    const hasRecognizedHeader = normalizedHeaders.some((h) => RECOGNIZED_ANY_HEADERS.has(h));
    const hasProductNameHeader = normalizedHeaders.some((h) =>
      RECOGNIZED_PRODUCT_NAME_HEADERS.has(h)
    );

    if (!hasRecognizedHeader || !hasProductNameHeader) {
      return {
        items: [],
        errors: [
          'Spreadsheet header row does not contain the expected catalogue columns (at minimum a "Product Name" column). Download the CSV Template for the expected structure.',
        ],
      };
    }

    const dataRows = rawRows.slice(1);
    if (dataRows.length === 0) {
      return { items: [], errors: ['Spreadsheet contains headers but no product rows.'] };
    }

    const now = new Date().toISOString();

    dataRows.forEach((cells, idx) => {
      const rowNum = idx + 2;
      if (!Array.isArray(cells)) return;
      if (cells.length > SPREADSHEET_LIMITS.maxColumns) {
        errors.push(`Row ${rowNum}: Skipped because it exceeds the maximum allowed column count.`);
        return;
      }

      const isBlankRow = cells.every(
        (c) => c === null || c === undefined || String(c).trim() === ''
      );
      if (isBlankRow) return;

      const normalizedMap = new Map<string, unknown>();
      normalizedHeaders.forEach((key, colIdx) => {
        if (key && !normalizedMap.has(key)) {
          normalizedMap.set(key, cells[colIdx]);
        }
      });

      const getRaw = (...keys: string[]): unknown => {
        for (const k of keys) {
          const val = normalizedMap.get(k);
          if (val !== undefined && val !== null && String(val).trim() !== '') {
            return val;
          }
        }
        return undefined;
      };

      const getStr = (...keys: string[]): string => sanitizeImportedText(getRaw(...keys));

      const productName = getStr('productname', 'name', 'product', 'description', 'title');
      if (!productName) {
        errors.push(`Row ${rowNum}: Skipped because Product Name is blank.`);
        return;
      }

      const manufacturer = getStr('manufacturer', 'make', 'vendor', 'company');
      const modelNumber = getStr('modelnumber', 'model', 'sku', 'partnumber', 'catalogcode', 'code');
      const rawCategory = getStr('category', 'productcategory', 'type');
      const subcategory = getStr('subcategory') || null;

      const category = normalizeCategory(rawCategory || productName);
      const brand = getStr('brand', 'series', 'range') || manufacturer || 'Unspecified';
      const specification = getStr('specification', 'specs', 'technicalspecification', 'details');
      const rating = getStr('rating', 'electricalrating', 'voltagecurrent');
      const dimensions = getStr('dimensions', 'size', 'dimension');
      const unit = getStr('unit', 'uom') || (category === 'Cables & Wires' ? 'm' : 'Nos');

      const wattageParsed = parseOptionalNumber(getRaw('wattagew', 'wattage', 'watts', 'powerw'));
      const cableSizeParsed = parseOptionalNumber(
        getRaw('cablesizesqmm', 'cablesize', 'sqmm', 'crosssection')
      );
      const mrpParsed = parseOptionalNumber(getRaw('mrp'));
      const unitPriceParsed = parseOptionalNumber(getRaw('unitprice', 'price', 'rate', 'cost', 'mrp'));
      const discountParsed = parseOptionalNumber(getRaw('discountpercent', 'discount'));
      const gstParsed = parseOptionalNumber(getRaw('gstpercent', 'gst', 'taxpercent', 'tax'));

      if (wattageParsed.invalid || (wattageParsed.value !== null && wattageParsed.value < 0)) {
        errors.push(`Row ${rowNum}: Skipped due to invalid Wattage value.`);
        return;
      }
      if (cableSizeParsed.invalid || (cableSizeParsed.value !== null && cableSizeParsed.value <= 0)) {
        errors.push(`Row ${rowNum}: Skipped due to invalid Cable Size (sq.mm) value.`);
        return;
      }
      if (unitPriceParsed.invalid || (unitPriceParsed.value !== null && unitPriceParsed.value < 0)) {
        errors.push(`Row ${rowNum}: Skipped due to invalid Unit Price value.`);
        return;
      }
      if (gstParsed.invalid || (gstParsed.value !== null && (gstParsed.value < 0 || gstParsed.value > 100))) {
        errors.push(`Row ${rowNum}: Skipped due to invalid GST % value (must be 0–100).`);
        return;
      }

      const rawImageUrl = String(getRaw('imageurl', 'image', 'photo') ?? '').trim();
      const rawDatasheetUrl = String(getRaw('datasheeturl', 'datasheet', 'specsheet') ?? '').trim();
      const rawManufacturerUrl = String(
        getRaw('manufacturerurl', 'producturl', 'url', 'website') ?? ''
      ).trim();

      const imageCheck = validateSafeUrl(rawImageUrl, 'Image URL');
      const datasheetCheck = validateSafeUrl(rawDatasheetUrl, 'Datasheet URL');
      const manufacturerCheck = validateSafeUrl(rawManufacturerUrl, 'Manufacturer URL');

      if (!imageCheck.valid) {
        errors.push(`Row ${rowNum}: ${imageCheck.error} (Image URL omitted)`);
      }
      if (!datasheetCheck.valid) {
        errors.push(`Row ${rowNum}: ${datasheetCheck.error} (Datasheet URL omitted)`);
      }
      if (!manufacturerCheck.valid) {
        errors.push(`Row ${rowNum}: ${manufacturerCheck.error} (Manufacturer URL omitted)`);
      }

      items.push({
        id: `cat-imp-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 5)}`,
        category,
        subcategory,
        manufacturer: manufacturer || 'Unspecified',
        brand,
        productName,
        modelNumber: modelNumber || 'Not specified',
        imageUrl: imageCheck.valid ? imageCheck.normalized : undefined,
        specification,
        rating,
        wattageW: wattageParsed.value,
        cableSizeSqMm: cableSizeParsed.value,
        dimensions,
        unit,
        mrp: mrpParsed.value,
        unitPrice: unitPriceParsed.value,
        discountPercent: discountParsed.value,
        gstPercent: gstParsed.value,
        datasheetUrl: datasheetCheck.valid ? datasheetCheck.normalized : undefined,
        manufacturerUrl: manufacturerCheck.valid ? manufacturerCheck.normalized : undefined,
        mappedItemType: inferMappedItemType(category, productName),
        source: 'csv-import',
        updatedAt: now,
      });
    });

    return { items, errors };
  } catch (err) {
    return {
      items: [],
      errors: [err instanceof Error ? err.message : 'Failed to parse spreadsheet file.'],
    };
  }
}

export function downloadCatalogueCsvTemplate(): void {
  const headers = [
    'Category',
    'Subcategory',
    'Manufacturer',
    'Brand',
    'Product Name',
    'Model Number',
    'Specification',
    'Rating',
    'Wattage (W)',
    'Cable Size (sq.mm)',
    'Dimensions',
    'Unit',
    'MRP',
    'Unit Price',
    'Discount %',
    'GST %',
    'Image URL',
    'Datasheet URL',
    'Manufacturer URL',
  ];

  const csv = [
    formatSafeCsvRow(headers),
    formatSafeCsvRow([
      'Cables & Wires',
      'House Wire',
      'Polycab',
      'Enter Brand / Series',
      'Enter Manufacturer Verified Product Name',
      'Enter Exact Model / Part Code',
      'Enter Verified Datasheet Specification',
      '1100V',
      '',
      2.5,
      '',
      'm',
      '',
      '',
      '',
      18,
      '',
      'https://polycab.com/',
      'https://polycab.com/',
    ]),
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'BlueSpace_Electrical_Product_Catalogue_Template.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
