import * as XLSX from 'xlsx';
import {
  CatalogueCategory,
  ManufacturerName,
  ManufacturerReference,
  ProductCatalogueItem,
} from '../types/catalogue';
import { ElectricalItemType } from '../types/design';

const CATALOGUE_STORAGE_KEY = 'blue_space_product_catalogue_v1';

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
];

export const MANUFACTURER_REFERENCES: ManufacturerReference[] = [
  {
    name: 'Polycab',
    websiteUrl: 'https://polycab.com/',
    primaryCategories: ['Cables & Wires', 'Switches', 'Distribution Boards', 'Fans', 'LED Bulbs'],
    notes: 'Official manufacturer directory for house wires, FRLS cables, switchgear, lighting & fans.',
  },
  {
    name: 'Finolex',
    websiteUrl: 'https://www.finolex.com/',
    primaryCategories: ['Cables & Wires', 'Switches', 'MCBs', 'Fans', 'LED Bulbs'],
    notes: 'Official manufacturer directory for Flame Retardant house wires, conduits, switchgear & lighting.',
  },
  {
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
  },
  {
    name: 'RR Kabel',
    websiteUrl: 'https://www.rrkabel.com/',
    primaryCategories: ['Cables & Wires', 'Switches', 'Fans', 'LED Panels', 'LED Downlights'],
    notes: 'Official manufacturer directory for FRLSH / LSZH building wires, fans and architectural LED luminaires.',
  },
  {
    name: 'KEI',
    websiteUrl: 'https://www.kei-ind.com/',
    primaryCategories: ['Cables & Wires'],
    notes: 'Official manufacturer directory for residential house wires, multi-core flexible & armoured cables.',
  },
  {
    name: 'Legrand',
    websiteUrl: 'https://www.legrand.co.in/',
    primaryCategories: ['Switches', 'Sockets', 'Distribution Boards', 'MCBs', 'RCCBs & RCBOs'],
    notes: 'Official manufacturer directory for modular wiring accessories, Ekinoxe/DX3 DBs, MCBs & RCCBs.',
  },
  {
    name: 'Schneider Electric',
    websiteUrl: 'https://www.se.com/in/en/',
    primaryCategories: ['Switches', 'Sockets', 'Distribution Boards', 'MCBs', 'RCCBs & RCBOs', 'Earthing Accessories'],
    notes: 'Official manufacturer directory for Acti9/Easy9 switchgear, distribution boards & modular switches.',
  },
  {
    name: 'Anchor / Panasonic',
    websiteUrl: 'https://lsin.panasonic.com/',
    primaryCategories: ['Switches', 'Sockets', 'Cables & Wires', 'Distribution Boards', 'MCBs', 'Fans'],
    notes: 'Official manufacturer directory for Anchor Roma/Penta/Woods modular switches, wires & switchgear.',
  },
  {
    name: 'GM Modular',
    websiteUrl: 'https://www.gmmodular.com/',
    primaryCategories: ['Switches', 'Sockets', 'LED Panels', 'LED Strips', 'LED Downlights', 'Fans'],
    notes: 'Official manufacturer directory for modular switches, sockets, home automation & LED lighting.',
  },
  {
    name: 'Philips / Signify',
    websiteUrl: 'https://www.lighting.philips.co.in/',
    primaryCategories: ['LED Bulbs', 'LED Panels', 'LED Downlights', 'LED Strips', 'LED Battens'],
    notes: 'Official manufacturer directory for LED luminaires, downlights, recessed panels, strips & battens.',
  },
  {
    name: 'Wipro',
    websiteUrl: 'https://www.wiprolighting.com/',
    primaryCategories: ['LED Bulbs', 'LED Panels', 'LED Downlights', 'LED Strips', 'LED Battens', 'Switches'],
    notes: 'Official manufacturer directory for residential/commercial LED luminaires & Garnet/North-West accessories.',
  },
  {
    name: 'Crompton',
    websiteUrl: 'https://www.crompton.co.in/',
    primaryCategories: ['Fans', 'LED Bulbs', 'LED Panels', 'LED Battens', 'Electrical Appliances'],
    notes: 'Official manufacturer directory for BLDC/induction fans, water heaters & LED luminaires.',
  },
  {
    name: 'Bajaj',
    websiteUrl: 'https://www.bajajelectricals.com/',
    primaryCategories: ['Fans', 'LED Bulbs', 'LED Battens', 'LED Downlights', 'Electrical Appliances'],
    notes: 'Official manufacturer directory for ceiling/exhaust fans, water heaters & LED lighting.',
  },
];

export const MANUFACTURER_NAMES: ManufacturerName[] = MANUFACTURER_REFERENCES.map((m) => m.name);

export function inferMappedItemType(category: CatalogueCategory, productName = ''): ElectricalItemType | undefined {
  const lower = productName.toLowerCase();
  switch (category) {
    case 'Cables & Wires':
      return undefined;
    case 'Switches':
      return lower.includes('board') || lower.includes('plate') ? 'switchboard' : 'switch';
    case 'Sockets':
      if (lower.includes('usb')) return 'usb_outlet';
      if (lower.includes('16a') || lower.includes('20a') || lower.includes('power')) return 'socket_16a';
      return 'socket_5a';
    case 'Distribution Boards':
    case 'MCBs':
    case 'RCCBs & RCBOs':
      return 'distribution_board';
    case 'Earthing Accessories':
      return 'earthing_point';
    case 'LED Bulbs':
    case 'LED Battens':
      return 'led_light';
    case 'LED Panels':
      return 'panel_light';
    case 'LED Downlights':
      return 'spotlight';
    case 'LED Strips':
      return 'strip_light';
    case 'Fans':
      return lower.includes('exhaust') ? 'exhaust_fan' : 'ceiling_fan';
    case 'Electrical Appliances':
      if (lower.includes('ac') || lower.includes('air conditioner') || lower.includes('split')) return 'split_ac';
      if (lower.includes('geyser') || lower.includes('water heater')) return 'geyser';
      return 'appliance';
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
  return 'Electrical Appliances';
}

function parseOptionalNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(String(val).replace(/[₹,\s%]/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function sanitizeSafeUrl(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return undefined;
}

export function loadCatalogueProducts(): ProductCatalogueItem[] {
  try {
    const raw = localStorage.getItem(CATALOGUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ProductCatalogueItem =>
        Boolean(item && typeof item.id === 'string' && typeof item.productName === 'string')
    );
  } catch {
    return [];
  }
}

export function saveCatalogueProducts(items: ProductCatalogueItem[]): void {
  try {
    localStorage.setItem(CATALOGUE_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore storage quota errors
  }
}

export function addCatalogueProduct(
  item: Omit<ProductCatalogueItem, 'id' | 'updatedAt'>
): ProductCatalogueItem[] {
  const existing = loadCatalogueProducts();
  const created: ProductCatalogueItem = {
    ...item,
    id: `cat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    mappedItemType: item.mappedItemType ?? inferMappedItemType(item.category, item.productName),
    updatedAt: new Date().toISOString(),
  };
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
      ? {
          ...item,
          ...patch,
          updatedAt: new Date().toISOString(),
        }
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

export interface CatalogueImportResult {
  items: ProductCatalogueItem[];
  errors: string[];
}

/**
 * Parses an administrator-supplied Excel (.xlsx/.xls) or CSV spreadsheet into verified ProductCatalogueItems.
 * Never fabricates missing prices, specs, or model numbers — leaves missing numeric fields as null.
 */
export function parseCatalogueSpreadsheet(buffer: ArrayBuffer): CatalogueImportResult {
  const errors: string[] = [];
  const items: ProductCatalogueItem[] = [];

  try {
    const workbook = XLSX.read(buffer, { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      return { items: [], errors: ['Spreadsheet contains no worksheets.'] };
    }
    const sheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });

    if (rows.length === 0) {
      return { items: [], errors: ['Spreadsheet worksheet is empty.'] };
    }

    const now = new Date().toISOString();

    rows.forEach((rawRow, idx) => {
      // Case-insensitive header lookup
      const normalizedMap = new Map<string, unknown>();
      Object.entries(rawRow).forEach(([k, v]) => {
        normalizedMap.set(k.trim().toLowerCase().replace(/[^a-z0-9]/g, ''), v);
      });

      const getStr = (...keys: string[]): string => {
        for (const k of keys) {
          const val = normalizedMap.get(k);
          if (val !== undefined && val !== null && String(val).trim() !== '') {
            return String(val).trim();
          }
        }
        return '';
      };

      const productName = getStr('productname', 'name', 'product', 'description', 'title');
      const manufacturer = getStr('manufacturer', 'make', 'vendor', 'company');
      const modelNumber = getStr('modelnumber', 'model', 'sku', 'partnumber', 'catalogcode', 'code');
      const rawCategory = getStr('category', 'productcategory', 'type');

      if (!productName) {
        errors.push(`Row ${idx + 2}: Skipped because Product Name is blank.`);
        return;
      }

      const category = normalizeCategory(rawCategory || productName);
      const brand = getStr('brand', 'series', 'range') || manufacturer || 'Unspecified';
      const specification = getStr('specification', 'specs', 'technicalspecification', 'details');
      const rating = getStr('rating', 'electricalrating', 'voltagecurrent');
      const dimensions = getStr('dimensions', 'size', 'dimension');
      const unit = getStr('unit', 'uom') || (category === 'Cables & Wires' ? 'm' : 'Nos');

      const wattageW = parseOptionalNumber(getStr('wattagew', 'wattage', 'watts', 'powerw'));
      const cableSizeSqMm = parseOptionalNumber(
        getStr('cablesizesqmm', 'cablesize', 'sqmm', 'crosssection')
      );
      const unitPrice = parseOptionalNumber(getStr('unitprice', 'price', 'rate', 'mrp', 'cost'));
      const gstPercent = parseOptionalNumber(getStr('gstpercent', 'gst', 'taxpercent', 'tax'));

      const imageUrl = sanitizeSafeUrl(getStr('imageurl', 'image', 'photo'));
      const datasheetUrl = sanitizeSafeUrl(getStr('datasheeturl', 'datasheet', 'specsheet'));
      const manufacturerUrl = sanitizeSafeUrl(
        getStr('manufacturerurl', 'producturl', 'url', 'website')
      );

      items.push({
        id: `cat-imp-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 5)}`,
        category,
        manufacturer: manufacturer || 'Unspecified',
        brand,
        productName,
        modelNumber: modelNumber || 'Not specified',
        imageUrl,
        specification,
        rating,
        wattageW,
        cableSizeSqMm,
        dimensions,
        unit,
        unitPrice,
        gstPercent,
        datasheetUrl,
        manufacturerUrl,
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
    'Unit Price',
    'GST %',
    'Image URL',
    'Datasheet URL',
    'Manufacturer URL',
  ];

  // Header-only template plus one clearly marked placeholder comment row that has no fake SKU/price
  const csv = [
    headers.join(','),
    [
      'Cables & Wires',
      'Polycab',
      'Enter Brand / Series',
      'Enter Manufacturer Verified Product Name',
      'Enter Exact Model / Part Code',
      'Enter Verified Datasheet Specification',
      '1100V',
      '',
      '2.5',
      '',
      'm',
      '',
      '18',
      '',
      'https://polycab.com/',
      'https://polycab.com/',
    ]
      .map((cell) => `"${cell.replace(/"/g, '""')}"`)
      .join(','),
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
