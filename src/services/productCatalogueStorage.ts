import readXlsxFile from 'read-excel-file/universal';
import {
  CatalogueCategory,
  ManufacturerName,
  ManufacturerReference,
  ProductCatalogueItem,
} from '../types/catalogue';
import { ElectricalItemType } from '../types/design';
import { formatSafeCsvRow, sanitizeCsvTextValue } from '../utils/csvSecurity';
import { sanitizeSafeUrl, validateSafeUrl } from '../utils/urlSecurity';

const CATALOGUE_STORAGE_KEY = 'blue_space_product_catalogue_v1';

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
  return {
    ...item,
    imageUrl: sanitizeSafeUrl(item.imageUrl),
    datasheetUrl: sanitizeSafeUrl(item.datasheetUrl),
    manufacturerUrl: sanitizeSafeUrl(item.manufacturerUrl),
  };
}

export function loadCatalogueProducts(): ProductCatalogueItem[] {
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

export function saveCatalogueProducts(items: ProductCatalogueItem[]): void {
  try {
    const sanitized = items.map(sanitizeStoredProductUrls);
    localStorage.setItem(CATALOGUE_STORAGE_KEY, JSON.stringify(sanitized));
  } catch {
    // ignore storage quota errors
  }
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
    bytes[0] === 0x50 && // P
    bytes[1] === 0x4b && // K
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

/**
 * Validates file extension, MIME type, size, and magic bytes before parsing.
 * Accepts modern .xlsx (OOXML ZIP) and .csv files; rejects legacy binary .xls, macro .xlsm, and oversized/malformed uploads.
 */
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

  // Fallback when filename wasn't supplied (e.g., programmatic ArrayBuffer calls)
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

/**
 * Safe RFC-4180 CSV parser with strict row and column limits.
 */
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
  // Neutralize leading spreadsheet formula characters if present in imported text
  return sanitizeCsvTextValue(truncated);
}

/**
 * Parses an administrator-supplied Excel (.xlsx) or CSV spreadsheet into verified ProductCatalogueItems.
 * Enforces strict upload validation, structural limits, safe URL validation, and prototype-pollution protection.
 * Never fabricates missing prices, specs, or model numbers — leaves missing numeric fields as null.
 */
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

    // Reject prototype-pollution headers explicitly
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
      const unitPriceParsed = parseOptionalNumber(getRaw('unitprice', 'price', 'rate', 'mrp', 'cost'));
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
        unitPrice: unitPriceParsed.value,
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

  // Header-only template plus one clearly marked placeholder row that has no fake SKU/price
  const csv = [
    formatSafeCsvRow(headers),
    formatSafeCsvRow([
      'Cables & Wires',
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
