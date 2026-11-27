import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  CatalogueCategory,
  CatalogueImportErrorRecord,
  CatalogueImportJobStatus,
  ManufacturerReference,
  ProductCatalogueItem,
  ProductCatalogueVariant,
} from '../types/catalogue';
import type { ElectricalItemType } from '../types/design';

const STORE_ID = 267900;
const ORG_ID = 262162;
const SOURCE_DOMAIN = 'www.cauverypowers.com';
const CATALOG_API_BASE = `https://api.shoopy.in/api/v1/web/store/${STORE_ID}/super-products`;
const SUPABASE_BUCKET = 'catalogue-images';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB strict cap
const FETCH_TIMEOUT_MS = 18_000;
const IMAGE_CONCURRENCY = 8;

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'catalogue-snapshot.json');
const IMPORT_STATE_FILE = path.join(DATA_DIR, 'cauvery-import-state.json');
const IMAGES_DIR = path.join(DATA_DIR, 'catalogue-images');

export const SAFE_IMAGE_FILENAME_RE = /^[a-f0-9]{16,64}\.(jpg|jpeg|png|webp|gif)$/i;

interface StoredSnapshot {
  version: number;
  updatedAt: string;
  sourceDomain: string;
  manufacturers: ManufacturerReference[];
  products: ProductCatalogueItem[];
}

interface RawExtraField {
  name?: string;
  slug?: string;
  val?: string | number | null;
}

interface RawVariant {
  prod_sku?: string;
  ssku?: string;
  prod_slug?: string;
  display_name?: string;
  name?: string;
  thumbnail?: string;
  next_img?: string;
  mrp?: number;
  sale_price?: number;
  qty?: number;
  product_id?: string;
  extra_product_fields?: RawExtraField[];
  show_online?: boolean;
}

interface RawTaxGroup {
  name?: string;
  cgst?: number;
  sgst?: number;
  igst?: number;
  total?: number;
}

interface RawSuperProduct {
  created_at?: string;
  updated_at?: string;
  super_prod_sku?: string;
  prod_sku?: string;
  prod_slug?: string;
  product_id?: string;
  brand?: string;
  display_name?: string;
  name?: string;
  summary?: string;
  description?: string;
  thumbnail?: string;
  next_img?: string;
  cat_slug?: string;
  cat_name?: string;
  categories?: Array<{ cat_slug?: string; cat_name?: string }>;
  mrp?: number;
  sale_price?: number;
  sp_tax_included?: boolean;
  tax_group?: RawTaxGroup;
  qty?: number;
  measuring_unit?: string;
  extra_product_fields?: RawExtraField[];
  product_variants?: RawVariant[];
}

interface RawCategoryFacetFilter {
  value: string;
  name: string;
  count?: number;
  sub_filters?: Array<{
    value: string;
    name: string;
    count?: number;
    relation?: string;
  }>;
}

interface RawSuperProductsResponse {
  payload?: {
    super_products?: {
      content?: RawSuperProduct[];
      totalElements?: number;
      totalPages?: number;
      number?: number;
      size?: number;
      last?: boolean;
    };
    facets?: Array<{
      name?: string;
      param?: string;
      filters?: RawCategoryFacetFilter[];
    }>;
  };
}

/** Official manufacturer directory baseline preserved alongside imported brands */
const OFFICIAL_MANUFACTURER_BASE: ManufacturerReference[] = [
  {
    slug: 'polycab',
    name: 'Polycab',
    websiteUrl: 'https://polycab.com/',
    primaryCategories: ['Cables & Wires', 'Switches', 'Distribution Boards', 'Fans', 'LED Bulbs', 'Conduits & Accessories'],
    notes: 'Cables, house wires, switchgear, fans, lighting, and conduits.',
    source: 'official-directory',
  },
  {
    slug: 'finolex',
    name: 'Finolex',
    websiteUrl: 'https://www.finolex.com/',
    primaryCategories: ['Cables & Wires', 'Switches', 'MCBs', 'Fans', 'LED Bulbs', 'Conduits & Accessories'],
    notes: 'FR/FRLS copper house wires, armoured power cables, switchgear, and conduits.',
    source: 'official-directory',
  },
  {
    slug: 'havells',
    name: 'Havells',
    websiteUrl: 'https://havells.com/',
    primaryCategories: ['Cables & Wires', 'Switches', 'Sockets', 'Distribution Boards', 'MCBs', 'RCCBs & RCBOs', 'Fans', 'Electrical Appliances'],
    notes: 'Complete residential & commercial electrical range including Crabtree & Standard.',
    source: 'official-directory',
  },
  {
    slug: 'rr-kabel',
    name: 'RR Kabel',
    websiteUrl: 'https://www.rrkabel.com/',
    primaryCategories: ['Cables & Wires', 'Switches', 'Fans', 'LED Panels', 'LED Downlights'],
    notes: 'Low-smoke halogen-free building wires, flexible cables, and consumer electricals.',
    source: 'official-directory',
  },
  {
    slug: 'kei',
    name: 'KEI',
    websiteUrl: 'https://www.kei-ind.com/',
    primaryCategories: ['Cables & Wires', 'Earthing Accessories'],
    notes: 'House wires, LT/HT power cables, control & instrumentation cables.',
    source: 'official-directory',
  },
  {
    slug: 'legrand',
    name: 'Legrand',
    websiteUrl: 'https://www.legrand.co.in/',
    primaryCategories: ['Switches', 'Sockets', 'Distribution Boards', 'MCBs', 'RCCBs & RCBOs'],
    notes: 'Modular wiring devices (Allzy, MyLinc, Arteor), DX3 switchgear, DBs, and automation.',
    source: 'official-directory',
  },
  {
    slug: 'schneider-electric',
    name: 'Schneider Electric',
    websiteUrl: 'https://www.se.com/in/en/',
    primaryCategories: ['Switches', 'Sockets', 'Distribution Boards', 'MCBs', 'RCCBs & RCBOs', 'Earthing Accessories'],
    notes: 'Livia, Opale & AvatarOn switches, Acti9/Easy9 switchgear, DBs, and EV/automation.',
    source: 'official-directory',
  },
  {
    slug: 'anchor-panasonic',
    name: 'Anchor / Panasonic',
    websiteUrl: 'https://lsin.panasonic.com/',
    primaryCategories: ['Switches', 'Sockets', 'Cables & Wires', 'Distribution Boards', 'MCBs', 'Fans', 'Conduits & Accessories'],
    notes: 'Anchor Roma, Roma Plus, Penta, Woods, Vision & Europa switches, switchgear, and boxes.',
    source: 'official-directory',
  },
  {
    slug: 'gm-modular',
    name: 'GM Modular',
    websiteUrl: 'https://www.gmmodular.com/',
    primaryCategories: ['Switches', 'Sockets', 'LED Panels', 'LED Strips', 'LED Downlights', 'Fans'],
    notes: 'G-Nine & FourFive modular switches, sockets, LED lighting, and electrical accessories.',
    source: 'official-directory',
  },
  {
    slug: 'philips-signify',
    name: 'Philips / Signify',
    websiteUrl: 'https://www.lighting.philips.co.in/',
    primaryCategories: ['LED Bulbs', 'LED Panels', 'LED Downlights', 'LED Strips', 'LED Battens'],
    notes: 'Architectural & residential LED luminaires, downlights, panels, and smart lighting.',
    source: 'official-directory',
  },
  {
    slug: 'wipro',
    name: 'Wipro',
    websiteUrl: 'https://www.wiprolighting.com/',
    primaryCategories: ['LED Bulbs', 'LED Panels', 'LED Downlights', 'LED Strips', 'LED Battens', 'Switches'],
    notes: 'Commercial & residential LED fixtures, smart lights, and modular switches.',
    source: 'official-directory',
  },
  {
    slug: 'crompton',
    name: 'Crompton',
    websiteUrl: 'https://www.crompton.co.in/',
    primaryCategories: ['Fans', 'LED Bulbs', 'LED Panels', 'LED Battens', 'Electrical Appliances'],
    notes: 'Ceiling & exhaust fans, LED battens/downlights/floodlights, and appliances.',
    source: 'official-directory',
  },
  {
    slug: 'bajaj',
    name: 'Bajaj',
    websiteUrl: 'https://www.bajajelectricals.com/',
    primaryCategories: ['Fans', 'LED Bulbs', 'LED Battens', 'LED Downlights', 'Electrical Appliances'],
    notes: 'Fans, indoor & outdoor LED luminaires, and domestic appliances.',
    source: 'official-directory',
  },
];

const EXTRA_MANUFACTURER_WEBSITES: Record<string, string> = {
  hager: 'https://www.hager.co.in/',
  crabtree: 'https://havells.com/crabtree',
  'great white': 'https://www.great-white.in/',
  lisha: 'https://www.lishaswitches.com/',
  dowells: 'https://dowells.com/',
  mk: 'https://www.mkelectric.com/',
  abb: 'https://new.abb.com/indian-subcontinent',
  lapp: 'https://www.lapp.com/in/en/',
  taparia: 'https://www.tapariatools.com/',
  elmeasure: 'https://www.elmeasure.com/',
  'd-link': 'https://www.dlink.co.in/',
  precision: 'https://www.precisionpipes.com/',
  'neptune bals': 'https://www.neptuneindia.com/',
  neptune: 'https://www.neptuneindia.com/',
  'neptune lights': 'https://www.neptuneindia.com/',
  venus: 'https://www.venushomeappliances.com/',
  inglow: 'https://www.cauverypowers.com/',
  innofitt: 'https://www.innofitt.com/',
};

/**
 * Strict outbound URL allowlist preventing SSRF and restricting fetches exclusively
 * to authorised Cauvery Powers storefront endpoints and product image assets.
 */
export function assertAllowedSourceUrl(
  rawUrl: string,
  kind: 'catalog-api' | 'storefront' | 'image'
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL blocked: ${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Non-HTTPS URL blocked: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL credentials are not permitted.');
  }
  const host = parsed.hostname.toLowerCase();
  // Explicitly reject IP literals and private/local domains
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.includes(':')
  ) {
    throw new Error(`Blocked local or IP host: ${host}`);
  }

  if (kind === 'catalog-api') {
    if (host !== 'api.shoopy.in') {
      throw new Error(`Disallowed catalog API host: ${host}`);
    }
    if (
      !parsed.pathname.startsWith(`/api/v1/web/store/${STORE_ID}/`) &&
      !parsed.pathname.startsWith('/api/v2/store/cauvery/')
    ) {
      throw new Error(`Disallowed catalog API path: ${parsed.pathname}`);
    }
    return parsed;
  }

  if (kind === 'storefront') {
    if (host !== 'www.cauverypowers.com' && host !== 'cauverypowers.com') {
      throw new Error(`Disallowed storefront host: ${host}`);
    }
    return parsed;
  }

  // kind === 'image'
  const allowedImageHost =
    (host === 'storage.googleapis.com' && parsed.pathname.startsWith(`/shy-pub/${ORG_ID}/`)) ||
    (host === 'cdn2.clevup.in' && parsed.pathname.startsWith(`/${ORG_ID}/`)) ||
    host === 'www.cauverypowers.com' ||
    host === 'cauverypowers.com';

  if (!allowedImageHost) {
    throw new Error(`Disallowed image source host/path: ${host}${parsed.pathname}`);
  }
  return parsed;
}

function detectImageExtensionFromMagicBytes(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { ext: 'png', mime: 'image/png' };
  }
  // GIF: GIF87a or GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { ext: 'gif', mime: 'image/gif' };
  }
  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unspecified';
}

export function normalizeManufacturerAndBrand(
  rawBrand?: string | null,
  productName?: string | null
): { manufacturer: string; brand: string; slug: string } {
  const cleanedBrand = (rawBrand ?? '').replace(/\s+/g, ' ').trim();
  const lower = cleanedBrand.toLowerCase();
  const titleLower = (productName ?? '').toLowerCase();

  if (!cleanedBrand) {
    if (titleLower.includes('anchor') || titleLower.includes('panasonic')) {
      return { manufacturer: 'Anchor / Panasonic', brand: 'Anchor', slug: 'anchor-panasonic' };
    }
    if (titleLower.includes('legrand')) {
      return { manufacturer: 'Legrand', brand: 'Legrand', slug: 'legrand' };
    }
    if (titleLower.includes('schneider')) {
      return { manufacturer: 'Schneider Electric', brand: 'Schneider Electric', slug: 'schneider-electric' };
    }
    if (titleLower.includes('havells')) {
      return { manufacturer: 'Havells', brand: 'Havells', slug: 'havells' };
    }
    if (titleLower.includes('polycab')) {
      return { manufacturer: 'Polycab', brand: 'Polycab', slug: 'polycab' };
    }
    if (titleLower.includes('finolex')) {
      return { manufacturer: 'Finolex', brand: 'Finolex', slug: 'finolex' };
    }
    if (titleLower.includes('crompton')) {
      return { manufacturer: 'Crompton', brand: 'Crompton', slug: 'crompton' };
    }
    if (titleLower.includes('hager')) {
      return { manufacturer: 'Hager', brand: 'Hager', slug: 'hager' };
    }
    return { manufacturer: 'Unspecified', brand: 'Unspecified', slug: 'unspecified' };
  }

  if (
    lower === 'anchor' ||
    lower === 'anchor by panasonic' ||
    lower === 'panasonic' ||
    lower === 'panasonic vision' ||
    lower === 'anchor / panasonic'
  ) {
    return {
      manufacturer: 'Anchor / Panasonic',
      brand: cleanedBrand,
      slug: 'anchor-panasonic',
    };
  }
  if (lower === 'schneider' || lower === 'schneider electric') {
    return {
      manufacturer: 'Schneider Electric',
      brand: 'Schneider Electric',
      slug: 'schneider-electric',
    };
  }
  if (lower === 'gm' || lower === 'gm modular') {
    return {
      manufacturer: 'GM Modular',
      brand: cleanedBrand === 'GM' ? 'GM Modular' : cleanedBrand,
      slug: 'gm-modular',
    };
  }
  if (lower.startsWith('legrand')) {
    return { manufacturer: 'Legrand', brand: cleanedBrand, slug: 'legrand' };
  }
  if (lower.startsWith('crabtree')) {
    return { manufacturer: 'Crabtree', brand: cleanedBrand, slug: 'crabtree' };
  }
  if (lower === 'crompton') {
    return { manufacturer: 'Crompton', brand: 'Crompton', slug: 'crompton' };
  }
  if (lower === 'venus') {
    return { manufacturer: 'Venus', brand: 'Venus', slug: 'venus' };
  }
  if (lower === 'stanly' || lower === 'stanley') {
    return { manufacturer: 'Stanley', brand: 'Stanley', slug: 'stanley' };
  }
  if (lower === 'philips' || lower === 'philips / signify' || lower === 'signify') {
    return { manufacturer: 'Philips / Signify', brand: cleanedBrand, slug: 'philips-signify' };
  }
  if (lower === 'neptune' || lower === 'neptune lights' || lower === 'neptune bals') {
    const canonical =
      lower === 'neptune bals'
        ? 'Neptune Bals'
        : lower === 'neptune lights'
          ? 'Neptune Lights'
          : 'Neptune';
    return { manufacturer: canonical, brand: canonical, slug: slugify(canonical) };
  }

  return {
    manufacturer: cleanedBrand,
    brand: cleanedBrand,
    slug: slugify(cleanedBrand),
  };
}

export function mapCauveryCategoryToBlueSpace(
  catName: string,
  subcatName: string | null,
  productName: string
): CatalogueCategory {
  const combined = `${catName} ${subcatName ?? ''} ${productName}`.toLowerCase();

  if (
    /\b(wire|wires|cable|cables|flex|frls|sqmm|sq\.mm|coaxial|cat6|lan cable|armoured|submersible|ug cable)\b/.test(
      combined
    ) &&
    !/\b(lug|lugs|gland|spike|extension|tie|clip)\b/.test(combined)
  ) {
    return 'Cables & Wires';
  }
  if (
    /\b(exhaust fan|ventilating fan|ventilation fan|ceiling fan|bldc fan|pedestal fan|wall fan|table fan|fan)\b/.test(
      combined
    ) &&
    !/\b(regulator|box|hook|capacitor)\b/.test(combined)
  ) {
    return 'Fans';
  }
  if (
    /\b(distribution board|db box|spn db|tpn db|vtpn|mcb box|enclosure box|enclosure)\b/.test(combined) ||
    (/\bdb\b/.test(combined) && /\b(way|door|double|single|spn|tpn)\b/.test(combined))
  ) {
    return 'Distribution Boards';
  }
  if (/\b(rccb|rcbo|elcb)\b/.test(combined)) {
    return 'RCCBs & RCBOs';
  }
  if (
    /\b(mcb|mccb|isolator|spd|surge protector|changeover|contactor|relay|breaker|tripper|switchgear)\b/.test(
      combined
    )
  ) {
    return 'MCBs';
  }
  if (/\b(earthing|earth rod|earth plate|chemical earth|copper strip|gi strip|lightning arrester)\b/.test(combined)) {
    return 'Earthing Accessories';
  }
  if (/\b(strip light|led strip|profile light|profile|rope light|smps|driver)\b/.test(combined)) {
    return 'LED Strips';
  }
  if (/\b(panel light|led panel|slim panel|backlit panel|recessed panel|surface panel)\b/.test(combined)) {
    return 'LED Panels';
  }
  if (/\b(downlight|spotlight|spot light|cob|concealed light|surface downlight|deep recessed)\b/.test(combined)) {
    return 'LED Downlights';
  }
  if (/\b(batten|tube light|tubelight|t5|t8)\b/.test(combined)) {
    return 'LED Battens';
  }
  if (/\b(led|light|lamp|flood light|street light|bulkhead|bulb|chandelier|luminaire|wall light)\b/.test(combined)) {
    return 'LED Bulbs';
  }
  if (
    /\b(stabilizer|inverter|ups|voltage protector|timer|energy meter|multimeter|geyser|water heater|heater|iron|kettle|mixer|appliance)\b/.test(
      combined
    )
  ) {
    return 'Electrical Appliances';
  }
  if (
    /\b(conduit|pvc pipe|casing|capping|metal box|pvc box|junction box|modular box|lug|lugs|gland|cable tie|tape|holder|batten holder|ceiling rose|clamp|saddle|bend|coupler|flexible pipe|tool|plier|stripper|tester|crimping)\b/.test(
      combined
    )
  ) {
    return 'Conduits & Accessories';
  }
  if (
    /\b(socket|plug top|multiplug|multi-plug|spike guard|extension|flex box|usb charger|tv socket|rj45|rj11|telephone socket|power unit|ac starter|ac box|industrial plug|industrial socket|cee|metal clad|ev charging|evso|20a|25a|16a|6a.*socket)\b/.test(
      combined
    )
  ) {
    return 'Sockets';
  }
  if (
    /\b(switch|regulator|dimmer|plate|frame|cover plate|bell push|indicator|blanking|dummy|modular|roma|allzy|mylinc|livia|opale|coral|europa|vision|penta|woods|verona|thames|myrah|g-nine|special 7)\b/.test(
      combined
    )
  ) {
    return 'Switches';
  }
  return 'Conduits & Accessories';
}

export function inferMappedItemTypeFromCatalogue(
  category: CatalogueCategory,
  productName: string
): ElectricalItemType | undefined {
  const n = productName.toLowerCase();
  switch (category) {
    case 'Cables & Wires':
      return undefined;
    case 'Fans':
      return n.includes('exhaust') || n.includes('ventilat') ? 'exhaust_fan' : 'ceiling_fan';
    case 'Distribution Boards':
    case 'MCBs':
    case 'RCCBs & RCBOs':
      return 'distribution_board';
    case 'Earthing Accessories':
      return 'earthing_point';
    case 'LED Panels':
      return 'panel_light';
    case 'LED Downlights':
      return 'spotlight';
    case 'LED Strips':
      return 'strip_light';
    case 'LED Bulbs':
    case 'LED Battens':
      return n.includes('chandelier') ? 'chandelier' : 'led_light';
    case 'Sockets':
      if (n.includes('usb')) return 'usb_outlet';
      if (n.includes('16a') || n.includes('20a') || n.includes('25a') || n.includes('32a') || n.includes('power')) {
        return 'socket_16a';
      }
      return 'socket_5a';
    case 'Switches':
      if (n.includes('plate') || n.includes('frame') || n.includes('box') || n.includes('board')) {
        return 'switchboard';
      }
      return 'switch';
    case 'Electrical Appliances':
      if (n.includes('ac') || n.includes('air conditioner') || n.includes('split')) return 'split_ac';
      if (n.includes('geyser') || n.includes('water heater')) return 'geyser';
      return 'appliance';
    default:
      return 'switch';
  }
}

function parseWattageFromText(text: string): number | null {
  const m = text.match(/\b(\d+(?:\.\d+)?)\s*(?:w|watt|watts)\b/i);
  if (!m) return null;
  const val = Number(m[1]);
  return Number.isFinite(val) && val > 0 && val <= 50000 ? val : null;
}

function parseCableSizeFromText(text: string, category: CatalogueCategory): number | null {
  if (category !== 'Cables & Wires') return null;
  const m = text.match(/\b(\d+(?:\.\d+)?)\s*(?:sq\.?\s*mm|sqmm|mm2|mm²)\b/i);
  if (!m) return null;
  const val = Number(m[1]);
  return Number.isFinite(val) && val > 0 && val <= 1000 ? val : null;
}

function parseRatingFromText(text: string): string {
  const parts: string[] = [];
  const ampMatch = text.match(/\b(\d+(?:\.\d+)?\s*(?:A|Amp|Amps)(?:\s*\/\s*\d+\s*A)?)\b/i);
  if (ampMatch) parts.push(ampMatch[1].replace(/\s+/g, ''));
  const maMatch = text.match(/\b(\d+\s*mA)\b/i);
  if (maMatch) parts.push(maMatch[1].replace(/\s+/g, ''));
  const vMatch = text.match(/\b(\d{2,4}\s*V(?:AC|DC)?)\b/i);
  if (vMatch) parts.push(vMatch[1].replace(/\s+/g, ''));
  const ipMatch = text.match(/\b(IP\d{2})\b/i);
  if (ipMatch) parts.push(ipMatch[1].toUpperCase());
  const kMatch = text.match(/\b(\d{4}\s*K)\b/i);
  if (kMatch) parts.push(kMatch[1].replace(/\s+/g, '').toUpperCase());
  return parts.join(' · ');
}

function inferUnit(raw: RawSuperProduct, category: CatalogueCategory): string {
  const rawUnit = (raw.measuring_unit ?? '').trim().toLowerCase();
  const title = `${raw.name ?? ''} ${raw.display_name ?? ''}`.toLowerCase();
  if (category === 'Cables & Wires') {
    const coilMatch = title.match(/\b(90|100|180|200|300)\s*(?:m|mtr|meter|metre)s?\b/i);
    if (coilMatch) return `Coil (${coilMatch[1]}m)`;
    if (rawUnit.includes('meter') || rawUnit.includes('metre') || rawUnit === 'm') return 'm';
    return 'm';
  }
  if (rawUnit.includes('meter') || rawUnit.includes('metre') || rawUnit === 'm') return 'm';
  if (rawUnit.includes('box')) return 'Box';
  if (rawUnit.includes('pack') || rawUnit.includes('pkt')) return 'Pack';
  if (rawUnit.includes('set')) return 'Set';
  if (rawUnit.includes('roll') || rawUnit.includes('coil')) return 'Coil';
  return 'Nos';
}

function stripHtmlToPlain(html?: string | null): string {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeDiscountPercent(mrp: number | null, unitPrice: number | null): number | null {
  if (mrp === null || unitPrice === null) return null;
  if (!Number.isFinite(mrp) || !Number.isFinite(unitPrice) || mrp <= 0 || unitPrice < 0) return null;
  if (unitPrice >= mrp) return null;
  return Number((((mrp - unitPrice) / mrp) * 100).toFixed(2));
}

function getServerSupabaseClient(): SupabaseClient | null {
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim();
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function isServerSupabaseConfigured(): boolean {
  return Boolean(
    (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim() &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  );
}

async function fetchWithTimeout(
  url: string,
  kind: 'catalog-api' | 'storefront' | 'image',
  init?: RequestInit
): Promise<Response> {
  const validated = assertAllowedSourceUrl(url, kind);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(validated.toString(), {
      ...init,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BlueSpaceCatalogueImporter/1.0)',
        ...(kind === 'catalog-api'
          ? {
              Origin: 'https://www.cauverypowers.com',
              Referer: 'https://www.cauverypowers.com/',
              Accept: 'application/json',
            }
          : {}),
        ...(init?.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function ensureDataDirs(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(IMAGES_DIR, { recursive: true });
}

/**
 * Downloads an authorised Cauvery Powers image, verifies magic bytes & size cap,
 * stores it permanently in Supabase Storage (if configured) and local server cache,
 * and returns ONLY Blue Space-hosted storage paths/URLs (never external URLs).
 */
async function ingestProductImage(
  sourceImageUrl: string,
  supabase: SupabaseClient | null,
  imageCache: Map<string, { storagePath: string; publicUrl: string } | null>
): Promise<{ storagePath: string; publicUrl: string; uploaded: boolean } | null> {
  const trimmed = sourceImageUrl.trim();
  if (!trimmed) return null;

  if (imageCache.has(trimmed)) {
    const cached = imageCache.get(trimmed);
    return cached ? { ...cached, uploaded: false } : null;
  }

  let validated: URL;
  try {
    validated = assertAllowedSourceUrl(trimmed, 'image');
  } catch {
    imageCache.set(trimmed, null);
    return null;
  }

  const hash = crypto.createHash('sha256').update(validated.toString()).digest('hex').slice(0, 28);

  // Check if already downloaded locally to avoid redundant network downloads on resume
  for (const ext of ['jpg', 'png', 'webp', 'gif']) {
    const candidateName = `${hash}.${ext}`;
    const localPath = path.join(IMAGES_DIR, candidateName);
    try {
      const stat = await fs.stat(localPath);
      if (stat.size > 0 && stat.size <= MAX_IMAGE_BYTES) {
        const storagePath = `products/${candidateName}`;
        let publicUrl = `/api/catalogue/images/${candidateName}`;
        if (supabase) {
          const buf = await fs.readFile(localPath);
          const mime =
            ext === 'png'
              ? 'image/png'
              : ext === 'webp'
                ? 'image/webp'
                : ext === 'gif'
                  ? 'image/gif'
                  : 'image/jpeg';
          const up = await supabase.storage
            .from(SUPABASE_BUCKET)
            .upload(storagePath, buf, { contentType: mime, upsert: true });
          if (!up.error) {
            const pub = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(storagePath);
            if (pub?.data?.publicUrl) {
              publicUrl = pub.data.publicUrl;
            }
          }
        }
        const entry = { storagePath, publicUrl };
        imageCache.set(trimmed, entry);
        return { ...entry, uploaded: false };
      }
    } catch {
      // Not yet cached under this extension
    }
  }

  // Download from authorised source host
  const resp = await fetchWithTimeout(validated.toString(), 'image');
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} downloading image`);
  }
  const contentLength = Number(resp.headers.get('content-length') || 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} byte limit`);
  }

  const arrayBuf = await resp.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image size invalid (${buf.length} bytes)`);
  }

  const detected = detectImageExtensionFromMagicBytes(buf);
  if (!detected) {
    throw new Error('Downloaded asset is not a valid JPEG, PNG, WebP, or GIF image');
  }

  const filename = `${hash}.${detected.ext}`;
  const storagePath = `products/${filename}`;
  await fs.writeFile(path.join(IMAGES_DIR, filename), buf);

  let publicUrl = `/api/catalogue/images/${filename}`;
  if (supabase) {
    const up = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(storagePath, buf, { contentType: detected.mime, upsert: true });
    if (up.error) {
      throw new Error(`Supabase Storage upload failed: ${up.error.message}`);
    }
    const pub = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(storagePath);
    if (pub?.data?.publicUrl) {
      publicUrl = pub.data.publicUrl;
    }
  }

  const entry = { storagePath, publicUrl };
  imageCache.set(trimmed, entry);
  return { ...entry, uploaded: true };
}

/**
 * Pure parser converting a raw Cauvery Powers super-product payload into a Blue Space
 * ProductCatalogueItem without ever fabricating missing specifications or prices.
 */
export function normalizeCauverySuperProduct(
  raw: RawSuperProduct,
  options: {
    parentCategoryMap?: Map<string, { parentName: string; subName?: string }>;
    resolvedImages?: Map<string, { storagePath: string; publicUrl: string }>;
  } = {}
): ProductCatalogueItem | null {
  const superSku = (raw.super_prod_sku || raw.prod_sku || '').trim();
  const baseName = (raw.name || raw.display_name || '').replace(/\s+/g, ' ').trim();
  if (!superSku || !baseName) return null;

  const sourceKey = `cauvery:${superSku}`;
  const { manufacturer, brand, slug: _mSlug } = normalizeManufacturerAndBrand(raw.brand, baseName);

  // Extract category and subcategory from facets map or raw categories array
  const rawCats = Array.isArray(raw.categories) ? raw.categories : [];
  const primaryCatSlug = (raw.cat_slug || rawCats[0]?.cat_slug || '').trim();
  const primaryCatName = (raw.cat_name || rawCats[0]?.cat_name || '').trim();
  const facetRel = primaryCatSlug ? options.parentCategoryMap?.get(primaryCatSlug) : undefined;

  let sourceCategory = facetRel?.parentName || primaryCatName || 'General Electrical';
  let subcategory: string | null = facetRel?.subName ?? null;
  if (!subcategory && rawCats.length > 1) {
    const second = (rawCats[1]?.cat_name || '').trim();
    if (second && second.toLowerCase() !== sourceCategory.toLowerCase()) {
      subcategory = second;
    }
  } else if (!subcategory && primaryCatName && primaryCatName.toLowerCase() !== sourceCategory.toLowerCase()) {
    subcategory = primaryCatName;
  }

  const category = mapCauveryCategoryToBlueSpace(sourceCategory, subcategory, baseName);
  const mappedItemType = inferMappedItemTypeFromCatalogue(category, baseName);

  // Pricing & GST strictly from source (never invented)
  const mrp =
    typeof raw.mrp === 'number' && Number.isFinite(raw.mrp) && raw.mrp > 0
      ? Number(raw.mrp.toFixed(2))
      : null;
  const unitPrice =
    typeof raw.sale_price === 'number' && Number.isFinite(raw.sale_price) && raw.sale_price > 0
      ? Number(raw.sale_price.toFixed(2))
      : null;
  const discountPercent = computeDiscountPercent(mrp, unitPrice);
  const gstPercent =
    typeof raw.tax_group?.total === 'number' &&
    Number.isFinite(raw.tax_group.total) &&
    raw.tax_group.total >= 0 &&
    raw.tax_group.total <= 100
      ? raw.tax_group.total
      : null;

  const gstDetails =
    raw.tax_group || typeof raw.sp_tax_included === 'boolean'
      ? {
          name: raw.tax_group?.name ?? null,
          cgst: typeof raw.tax_group?.cgst === 'number' ? raw.tax_group.cgst : null,
          sgst: typeof raw.tax_group?.sgst === 'number' ? raw.tax_group.sgst : null,
          igst: typeof raw.tax_group?.igst === 'number' ? raw.tax_group.igst : null,
          taxIncluded: Boolean(raw.sp_tax_included),
        }
      : null;

  // Build technical specifications strictly from source fields
  const technicalSpecs: Record<string, string> = {};
  if (sourceCategory) technicalSpecs['Source Category'] = sourceCategory;
  if (subcategory) technicalSpecs['Subcategory'] = subcategory;
  if (raw.tax_group?.name) technicalSpecs['Tax Group'] = raw.tax_group.name;
  if (raw.measuring_unit) technicalSpecs['Unit'] = raw.measuring_unit;

  const extraFields = Array.isArray(raw.extra_product_fields) ? raw.extra_product_fields : [];
  for (const ef of extraFields) {
    const k = (ef.name || ef.slug || '').trim();
    const v = ef.val !== null && ef.val !== undefined ? String(ef.val).trim() : '';
    if (k && v) {
      technicalSpecs[k] = v;
    }
  }

  // Normalize variants (deduplicated by SKU)
  const variantSeen = new Set<string>();
  const variants: ProductCatalogueVariant[] = [];
  const rawVariants = Array.isArray(raw.product_variants) ? raw.product_variants : [];

  for (const v of rawVariants) {
    const vSku = (v.prod_sku || '').trim();
    if (!vSku || variantSeen.has(vSku)) continue;
    variantSeen.add(vSku);

    const attrs: Record<string, string> = {};
    const labelParts: string[] = [];
    for (const ef of v.extra_product_fields ?? []) {
      const k = (ef.name || ef.slug || '').trim();
      const val = ef.val !== null && ef.val !== undefined ? String(ef.val).trim() : '';
      if (k && val) {
        attrs[k] = val;
        labelParts.push(val);
      }
    }

    const vMrp =
      typeof v.mrp === 'number' && Number.isFinite(v.mrp) && v.mrp > 0
        ? Number(v.mrp.toFixed(2))
        : null;
    const vPrice =
      typeof v.sale_price === 'number' && Number.isFinite(v.sale_price) && v.sale_price > 0
        ? Number(v.sale_price.toFixed(2))
        : null;
    const vImgInfo = v.thumbnail ? options.resolvedImages?.get(v.thumbnail.trim()) : undefined;

    variants.push({
      id: vSku,
      sku: vSku,
      modelNumber: (v.product_id || '').trim() || null,
      label: labelParts.join(' / ') || (v.name || v.display_name || vSku).trim(),
      displayName: (v.display_name || v.name || baseName).replace(/\s+/g, ' ').trim(),
      attributes: Object.keys(attrs).length > 0 ? attrs : undefined,
      mrp: vMrp,
      unitPrice: vPrice,
      discountPercent: computeDiscountPercent(vMrp, vPrice),
      imageStoragePath: vImgInfo?.storagePath ?? null,
      imageUrl: vImgInfo?.publicUrl ?? null,
      inStock: typeof v.qty === 'number' ? v.qty > 0 : undefined,
    });
  }

  // Choose primary model number from product_id, first variant product_id, or SKU
  const primaryModel =
    (raw.product_id || '').trim() ||
    variants.find((v) => v.modelNumber)?.modelNumber ||
    (raw.prod_sku || superSku).trim();

  // Resolve permanent Blue Space image URLs (NEVER external URLs)
  const rawImgCandidates = [
    raw.thumbnail?.trim(),
    raw.next_img?.trim(),
    ...rawVariants.map((v) => v.thumbnail?.trim()),
  ].filter((u): u is string => Boolean(u));

  const resolvedGallery: string[] = [];
  let primaryStoragePath: string | null = null;
  let primaryPublicUrl: string | null = null;

  for (const srcUrl of rawImgCandidates) {
    const resolved = options.resolvedImages?.get(srcUrl);
    if (resolved) {
      if (!primaryPublicUrl) {
        primaryPublicUrl = resolved.publicUrl;
        primaryStoragePath = resolved.storagePath;
      }
      if (!resolvedGallery.includes(resolved.publicUrl)) {
        resolvedGallery.push(resolved.publicUrl);
      }
    }
  }

  const combinedText = [
    baseName,
    raw.display_name || '',
    stripHtmlToPlain(raw.summary),
    stripHtmlToPlain(raw.description),
    ...Object.values(technicalSpecs),
    ...variants.slice(0, 3).map((v) => v.label),
  ].join(' ');

  const rating = parseRatingFromText(combinedText);
  const wattageW = parseWattageFromText(combinedText);
  const cableSizeSqMm = parseCableSizeFromText(combinedText, category);
  const unit = inferUnit(raw, category);

  const specParts: string[] = [];
  if (sourceCategory) specParts.push(sourceCategory);
  if (subcategory && subcategory !== sourceCategory) specParts.push(subcategory);
  if (rating) specParts.push(rating);
  if (wattageW !== null) specParts.push(`${wattageW}W`);
  if (cableSizeSqMm !== null) specParts.push(`${cableSizeSqMm} sq.mm`);
  if (variants.length > 1) specParts.push(`${variants.length} variants`);
  const summaryText = stripHtmlToPlain(raw.summary);
  if (summaryText) specParts.push(summaryText.slice(0, 180));

  const canonicalUrl = raw.prod_slug
    ? `https://${SOURCE_DOMAIN}/products/${encodeURIComponent(raw.prod_slug)}`
    : null;

  return {
    id: `cat-${slugify(superSku)}`,
    sourceKey,
    sourceUrl: canonicalUrl,
    sourceCategory,
    category,
    subcategory,
    manufacturer,
    brand,
    productName: baseName,
    modelNumber: primaryModel || 'Not specified',
    sku: (raw.prod_sku || superSku).trim(),
    specification: specParts.join(' · '),
    technicalSpecs,
    variants: variants.length > 0 ? variants : undefined,
    rating,
    wattageW,
    cableSizeSqMm,
    dimensions: '',
    unit,
    mrp,
    unitPrice,
    discountPercent,
    gstPercent,
    gstDetails,
    imageStoragePath: primaryStoragePath,
    imageUrl: primaryPublicUrl,
    galleryImages: resolvedGallery.length > 0 ? resolvedGallery : undefined,
    datasheetUrl: null,
    manufacturerUrl:
      OFFICIAL_MANUFACTURER_BASE.find(
        (m) => m.name.toLowerCase() === manufacturer.toLowerCase()
      )?.websiteUrl ??
      EXTRA_MANUFACTURER_WEBSITES[manufacturer.toLowerCase()] ??
      null,
    mappedItemType,
    source: 'cauvery-import',
    isActive: true,
    updatedAt: raw.updated_at || new Date().toISOString(),
  };
}

function buildManufacturersList(
  products: ProductCatalogueItem[],
  existingManufacturers: ManufacturerReference[] = []
): ManufacturerReference[] {
  const bySlug = new Map<string, ManufacturerReference>();

  // 1. Preserve official 13 manufacturer baseline
  for (const m of OFFICIAL_MANUFACTURER_BASE) {
    const slug = m.slug || slugify(m.name);
    bySlug.set(slug, {
      ...m,
      id: m.id || `mfr-${slug}`,
      slug,
      primaryCategories: [...m.primaryCategories],
      productCount: 0,
      isActive: true,
    });
  }

  // 2. Preserve existing admin-added / customized manufacturers
  for (const m of existingManufacturers) {
    const slug = m.slug || slugify(m.name);
    const prev = bySlug.get(slug);
    bySlug.set(slug, {
      ...(prev ?? {}),
      ...m,
      id: m.id || prev?.id || `mfr-${slug}`,
      slug,
      primaryCategories: Array.from(
        new Set([...(prev?.primaryCategories ?? []), ...(m.primaryCategories ?? [])])
      ),
      productCount: 0,
      isActive: m.isActive ?? true,
    });
  }

  // 3. Aggregate all products' manufacturers and categories
  for (const p of products) {
    if (p.isActive === false) continue;
    const name = (p.manufacturer || 'Unspecified').trim();
    if (!name || name === 'Unspecified') continue;
    const slug = slugify(name);
    const existing = bySlug.get(slug);
    if (existing) {
      existing.productCount = (existing.productCount ?? 0) + 1;
      if (!existing.primaryCategories.includes(p.category)) {
        existing.primaryCategories.push(p.category);
      }
    } else {
      bySlug.set(slug, {
        id: `mfr-${slug}`,
        slug,
        name,
        websiteUrl:
          EXTRA_MANUFACTURER_WEBSITES[name.toLowerCase()] ||
          `https://${SOURCE_DOMAIN}/`,
        primaryCategories: [p.category],
        notes: `Imported from Cauvery Powers electrical catalogue (${p.category}).`,
        productCount: 1,
        source: p.source === 'cauvery-import' ? 'cauvery-import' : 'admin-entry',
        isActive: true,
      });
    }
  }

  return Array.from(bySlug.values()).sort((a, b) => {
    const countDiff = (b.productCount ?? 0) - (a.productCount ?? 0);
    if (countDiff !== 0) return countDiff;
    return a.name.localeCompare(b.name);
  });
}

// ----------------------------------------------------------------------------
// Persistent Store Load / Save (Supabase Primary + Local Snapshot Cache)
// ----------------------------------------------------------------------------

async function readLocalSnapshot(): Promise<StoredSnapshot> {
  try {
    const raw = await fs.readFile(SNAPSHOT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredSnapshot>;
    const products = Array.isArray(parsed.products) ? parsed.products : [];
    const manufacturers = buildManufacturersList(
      products,
      Array.isArray(parsed.manufacturers) ? parsed.manufacturers : []
    );
    return {
      version: 1,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      sourceDomain: parsed.sourceDomain || SOURCE_DOMAIN,
      manufacturers,
      products,
    };
  } catch {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      sourceDomain: SOURCE_DOMAIN,
      manufacturers: buildManufacturersList([]),
      products: [],
    };
  }
}

async function writeLocalSnapshot(snapshot: StoredSnapshot): Promise<void> {
  await ensureDataDirs();
  const tmpFile = `${SNAPSHOT_FILE}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(snapshot, null, 2), 'utf8');
  await fs.rename(tmpFile, SNAPSHOT_FILE);
}

async function readLocalImportState(): Promise<CatalogueImportJobStatus> {
  try {
    const raw = await fs.readFile(IMPORT_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as CatalogueImportJobStatus;
    return {
      ...parsed,
      storageBackend: isServerSupabaseConfigured() ? 'supabase' : 'local-store',
    };
  } catch {
    return {
      id: 'cauvery-import-default',
      sourceDomain: SOURCE_DOMAIN,
      status: 'idle',
      currentPage: 0,
      totalPages: 0,
      pageSize: 50,
      discoveredCount: 0,
      importedCount: 0,
      updatedCount: 0,
      skippedDuplicatesCount: 0,
      failedCount: 0,
      manufacturersCount: 0,
      imagesUploadedCount: 0,
      imagesFailedCount: 0,
      storageBackend: isServerSupabaseConfigured() ? 'supabase' : 'local-store',
      errors: [],
      startedAt: null,
      updatedAt: null,
      completedAt: null,
    };
  }
}

async function writeLocalImportState(state: CatalogueImportJobStatus): Promise<void> {
  await ensureDataDirs();
  const tmpFile = `${IMPORT_STATE_FILE}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmpFile, IMPORT_STATE_FILE);
}

function mapSupabaseProductRow(row: Record<string, unknown>): ProductCatalogueItem {
  return {
    id: String(row.id),
    sourceKey: typeof row.source_key === 'string' ? row.source_key : undefined,
    sourceUrl: typeof row.source_url === 'string' ? row.source_url : null,
    sourceCategory: typeof row.source_category === 'string' ? row.source_category : null,
    category: (row.category as CatalogueCategory) || 'Conduits & Accessories',
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
    variants: Array.isArray(row.variants) ? (row.variants as ProductCatalogueVariant[]) : undefined,
    rating: String(row.rating || ''),
    wattageW: row.wattage_w !== null && row.wattage_w !== undefined ? Number(row.wattage_w) : null,
    cableSizeSqMm:
      row.cable_size_sq_mm !== null && row.cable_size_sq_mm !== undefined
        ? Number(row.cable_size_sq_mm)
        : null,
    dimensions: String(row.dimensions || ''),
    unit: String(row.unit || 'Nos'),
    mrp: row.mrp !== null && row.mrp !== undefined ? Number(row.mrp) : null,
    unitPrice: row.unit_price !== null && row.unit_price !== undefined ? Number(row.unit_price) : null,
    discountPercent:
      row.discount_percent !== null && row.discount_percent !== undefined
        ? Number(row.discount_percent)
        : null,
    gstPercent:
      row.gst_percent !== null && row.gst_percent !== undefined ? Number(row.gst_percent) : null,
    gstDetails:
      row.gst_details && typeof row.gst_details === 'object'
        ? (row.gst_details as ProductCatalogueItem['gstDetails'])
        : null,
    imageStoragePath: typeof row.image_storage_path === 'string' ? row.image_storage_path : null,
    imageUrl: typeof row.image_url === 'string' ? row.image_url : null,
    galleryImages: Array.isArray(row.gallery_images) ? (row.gallery_images as string[]) : undefined,
    datasheetUrl: typeof row.datasheet_url === 'string' ? row.datasheet_url : null,
    manufacturerUrl: typeof row.manufacturer_url === 'string' ? row.manufacturer_url : null,
    mappedItemType: typeof row.mapped_item_type === 'string'
      ? (row.mapped_item_type as ElectricalItemType)
      : undefined,
    source: (row.source as ProductCatalogueItem['source']) || 'admin-entry',
    isActive: row.is_active !== false,
    updatedAt: String(row.updated_at || new Date().toISOString()),
  };
}

function toSupabaseProductRow(
  item: ProductCatalogueItem,
  manufacturerIdBySlug?: Map<string, string>
): Record<string, unknown> {
  const mSlug = slugify(item.manufacturer || 'unspecified');
  return {
    source_key: item.sourceKey || `admin:${item.id}`,
    source: item.source || 'admin-entry',
    source_url: item.sourceUrl ?? null,
    source_category: item.sourceCategory ?? null,
    category: item.category,
    subcategory: item.subcategory ?? null,
    manufacturer_id: manufacturerIdBySlug?.get(mSlug) ?? item.manufacturerId ?? null,
    manufacturer: item.manufacturer,
    brand: item.brand || item.manufacturer,
    product_name: item.productName,
    model_number: item.modelNumber || 'Not specified',
    sku: item.sku ?? null,
    specification: item.specification || '',
    technical_specs: item.technicalSpecs ?? {},
    variants: item.variants ?? [],
    rating: item.rating || '',
    wattage_w: item.wattageW,
    cable_size_sq_mm: item.cableSizeSqMm,
    dimensions: item.dimensions || '',
    unit: item.unit || 'Nos',
    mrp: item.mrp ?? null,
    unit_price: item.unitPrice,
    discount_percent: item.discountPercent ?? null,
    gst_percent: item.gstPercent,
    gst_details: item.gstDetails ?? null,
    image_storage_path: item.imageStoragePath ?? null,
    image_url: item.imageUrl ?? null,
    gallery_images: item.galleryImages ?? [],
    datasheet_url: item.datasheetUrl ?? null,
    manufacturer_url: item.manufacturerUrl ?? null,
    mapped_item_type: item.mappedItemType ?? null,
    is_active: item.isActive !== false,
  };
}

export async function syncSnapshotToSupabase(
  products: ProductCatalogueItem[],
  manufacturers: ManufacturerReference[],
  supabaseOverride?: SupabaseClient | null
): Promise<{ synced: boolean; productsUpserted: number; manufacturersUpserted: number; error?: string }> {
  const sb = supabaseOverride ?? getServerSupabaseClient();
  if (!sb) {
    return { synced: false, productsUpserted: 0, manufacturersUpserted: 0 };
  }

  try {
    const mfrRows = manufacturers.map((m) => ({
      slug: m.slug || slugify(m.name),
      name: m.name,
      website_url: m.websiteUrl || null,
      logo_storage_path: m.logoStoragePath ?? null,
      logo_url: m.logoUrl ?? null,
      primary_categories: m.primaryCategories ?? [],
      notes: m.notes || '',
      source: m.source || 'admin-entry',
      is_active: m.isActive !== false,
    }));

    const { data: upsertedMfrs, error: mfrErr } = await sb
      .from('catalogue_manufacturers')
      .upsert(mfrRows, { onConflict: 'slug' })
      .select('id, slug');

    if (mfrErr) {
      return { synced: false, productsUpserted: 0, manufacturersUpserted: 0, error: mfrErr.message };
    }

    const mfrIdBySlug = new Map<string, string>();
    for (const row of upsertedMfrs ?? []) {
      if (row.slug && row.id) mfrIdBySlug.set(String(row.slug), String(row.id));
    }

    let upsertedCount = 0;
    const batchSize = 200;
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize).map((p) => toSupabaseProductRow(p, mfrIdBySlug));
      const { error: prodErr } = await sb
        .from('catalogue_products')
        .upsert(batch, { onConflict: 'source_key' });
      if (prodErr) {
        return {
          synced: false,
          productsUpserted: upsertedCount,
          manufacturersUpserted: mfrRows.length,
          error: prodErr.message,
        };
      }
      upsertedCount += batch.length;
    }

    return {
      synced: true,
      productsUpserted: upsertedCount,
      manufacturersUpserted: mfrRows.length,
    };
  } catch (err) {
    return {
      synced: false,
      productsUpserted: 0,
      manufacturersUpserted: 0,
      error: err instanceof Error ? err.message : 'Supabase sync error',
    };
  }
}

export async function getCentralCatalogueData(): Promise<{
  products: ProductCatalogueItem[];
  manufacturers: ManufacturerReference[];
  storageBackend: 'supabase' | 'local-store';
  updatedAt: string;
}> {
  const sb = getServerSupabaseClient();
  if (sb) {
    try {
      const allProducts: ProductCatalogueItem[] = [];
      const pageSize = 1000;
      let offset = 0;
      while (true) {
        const { data, error } = await sb
          .from('catalogue_products')
          .select('*')
          .eq('is_active', true)
          .order('updated_at', { ascending: false })
          .range(offset, offset + pageSize - 1);
        if (error) throw error;
        const rows = data ?? [];
        allProducts.push(...rows.map((r) => mapSupabaseProductRow(r as Record<string, unknown>)));
        if (rows.length < pageSize) break;
        offset += pageSize;
      }

      const { data: mfrData } = await sb
        .from('catalogue_manufacturers')
        .select('*')
        .eq('is_active', true);

      const dbMfrs: ManufacturerReference[] = (mfrData ?? []).map((m) => ({
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

      if (allProducts.length > 0 || dbMfrs.length > 0) {
        return {
          products: allProducts,
          manufacturers: buildManufacturersList(allProducts, dbMfrs),
          storageBackend: 'supabase',
          updatedAt: new Date().toISOString(),
        };
      }
    } catch (err) {
      console.warn('[Catalogue] Falling back to local snapshot after Supabase read error:', err);
    }
  }

  const snap = await readLocalSnapshot();
  return {
    products: snap.products.filter((p) => p.isActive !== false),
    manufacturers: buildManufacturersList(snap.products, snap.manufacturers),
    storageBackend: sb ? 'supabase' : 'local-store',
    updatedAt: snap.updatedAt,
  };
}

export async function upsertCentralProduct(
  product: Omit<ProductCatalogueItem, 'id' | 'updatedAt'> & { id?: string }
): Promise<ProductCatalogueItem> {
  const snap = await readLocalSnapshot();
  const now = new Date().toISOString();
  const id = product.id?.trim() || `cat-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const sourceKey = product.sourceKey?.trim() || `admin:${id}`;

  const saved: ProductCatalogueItem = {
    ...product,
    id,
    sourceKey,
    isActive: product.isActive !== false,
    updatedAt: now,
  };

  const idx = snap.products.findIndex((p) => p.id === id || (p.sourceKey && p.sourceKey === sourceKey));
  if (idx >= 0) {
    snap.products[idx] = saved;
  } else {
    snap.products.unshift(saved);
  }
  snap.manufacturers = buildManufacturersList(snap.products, snap.manufacturers);
  snap.updatedAt = now;
  await writeLocalSnapshot(snap);

  const sb = getServerSupabaseClient();
  if (sb) {
    await syncSnapshotToSupabase([saved], snap.manufacturers, sb);
  }
  return saved;
}

export async function deleteCentralProduct(id: string): Promise<boolean> {
  const snap = await readLocalSnapshot();
  const target = snap.products.find((p) => p.id === id);
  const next = snap.products.filter((p) => p.id !== id);
  if (next.length === snap.products.length && !isServerSupabaseConfigured()) {
    return false;
  }
  snap.products = next;
  snap.manufacturers = buildManufacturersList(snap.products, snap.manufacturers);
  snap.updatedAt = new Date().toISOString();
  await writeLocalSnapshot(snap);

  const sb = getServerSupabaseClient();
  if (sb) {
    if (target?.sourceKey) {
      await sb.from('catalogue_products').delete().eq('source_key', target.sourceKey);
    } else {
      await sb.from('catalogue_products').delete().eq('id', id);
    }
  }
  return true;
}

export async function upsertCentralManufacturer(
  mfr: Omit<ManufacturerReference, 'slug'> & { slug?: string }
): Promise<ManufacturerReference> {
  const snap = await readLocalSnapshot();
  const slug = mfr.slug?.trim() || slugify(mfr.name);
  const saved: ManufacturerReference = {
    ...mfr,
    id: mfr.id || `mfr-${slug}`,
    slug,
    name: mfr.name.trim(),
    websiteUrl: mfr.websiteUrl?.trim() || '',
    primaryCategories: Array.isArray(mfr.primaryCategories) ? mfr.primaryCategories : [],
    notes: mfr.notes?.trim() || '',
    source: mfr.source || 'admin-entry',
    isActive: mfr.isActive !== false,
  };

  const idx = snap.manufacturers.findIndex((x) => (x.slug || slugify(x.name)) === slug);
  if (idx >= 0) {
    snap.manufacturers[idx] = { ...snap.manufacturers[idx], ...saved };
  } else {
    snap.manufacturers.push(saved);
  }
  snap.manufacturers = buildManufacturersList(snap.products, snap.manufacturers);
  snap.updatedAt = new Date().toISOString();
  await writeLocalSnapshot(snap);

  const sb = getServerSupabaseClient();
  if (sb) {
    await sb.from('catalogue_manufacturers').upsert(
      {
        slug: saved.slug,
        name: saved.name,
        website_url: saved.websiteUrl || null,
        logo_storage_path: saved.logoStoragePath ?? null,
        logo_url: saved.logoUrl ?? null,
        primary_categories: saved.primaryCategories,
        notes: saved.notes,
        source: saved.source || 'admin-entry',
        is_active: saved.isActive !== false,
      },
      { onConflict: 'slug' }
    );
  }
  return snap.manufacturers.find((x) => x.slug === slug) ?? saved;
}

export async function deleteCentralManufacturer(slugOrId: string): Promise<boolean> {
  const snap = await readLocalSnapshot();
  const target = snap.manufacturers.find((m) => m.slug === slugOrId || m.id === slugOrId);
  const slug = target?.slug || slugify(slugOrId);
  snap.manufacturers = snap.manufacturers.filter((m) => m.slug !== slug && m.id !== slugOrId);
  snap.updatedAt = new Date().toISOString();
  await writeLocalSnapshot(snap);

  const sb = getServerSupabaseClient();
  if (sb) {
    await sb.from('catalogue_manufacturers').delete().eq('slug', slug);
  }
  return true;
}

export async function saveUploadedProductImage(
  buffer: Buffer
): Promise<{ storagePath: string; publicUrl: string }> {
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image must be between 1 byte and ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`);
  }
  const detected = detectImageExtensionFromMagicBytes(buffer);
  if (!detected) {
    throw new Error('Only valid JPEG, PNG, WebP, or GIF image files are permitted.');
  }
  await ensureDataDirs();
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 28);
  const filename = `${hash}.${detected.ext}`;
  const storagePath = `products/${filename}`;
  await fs.writeFile(path.join(IMAGES_DIR, filename), buffer);

  let publicUrl = `/api/catalogue/images/${filename}`;
  const sb = getServerSupabaseClient();
  if (sb) {
    const up = await sb.storage
      .from(SUPABASE_BUCKET)
      .upload(storagePath, buffer, { contentType: detected.mime, upsert: true });
    if (up.error) {
      throw new Error(`Supabase Storage upload failed: ${up.error.message}`);
    }
    const pub = sb.storage.from(SUPABASE_BUCKET).getPublicUrl(storagePath);
    if (pub?.data?.publicUrl) {
      publicUrl = pub.data.publicUrl;
    }
  }
  return { storagePath, publicUrl };
}

export function resolveLocalCatalogueImagePath(filename: string): string | null {
  if (!SAFE_IMAGE_FILENAME_RE.test(filename)) return null;
  const resolved = path.resolve(IMAGES_DIR, filename);
  if (!resolved.startsWith(IMAGES_DIR + path.sep)) return null;
  return resolved;
}

// ----------------------------------------------------------------------------
// Resumable, Paginated, Deduplicated Cauvery Powers Importer
// ----------------------------------------------------------------------------

let activeImportPromise: Promise<CatalogueImportJobStatus> | null = null;
let pauseRequested = false;

export async function getCauveryImportStatus(): Promise<CatalogueImportJobStatus> {
  return readLocalImportState();
}

export function requestPauseCauveryImport(): void {
  pauseRequested = true;
}

function buildCategoryHierarchyMap(
  facets?: RawSuperProductsResponse['payload'] extends infer P
    ? P extends { facets?: infer F }
      ? F
      : never
    : never
): Map<string, { parentName: string; subName?: string }> {
  const map = new Map<string, { parentName: string; subName?: string }>();
  const catFacet = facets?.find((f) => f.param === 'cat-slugs' || f.name === 'Category');
  for (const filter of catFacet?.filters ?? []) {
    if (filter.value && filter.name) {
      map.set(filter.value.trim(), { parentName: filter.name.trim() });
    }
    for (const sub of filter.sub_filters ?? []) {
      if (sub.value && sub.name) {
        map.set(sub.value.trim(), {
          parentName: filter.name.trim(),
          subName: sub.name.trim(),
        });
      }
    }
  }
  return map;
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const current = items[cursor++];
      await worker(current);
    }
  });
  await Promise.all(runners);
}

export interface RunCauveryImportOptions {
  resume?: boolean;
  pageSize?: number;
  maxPages?: number;
  downloadImages?: boolean;
  onProgress?: (status: CatalogueImportJobStatus) => void;
}

export async function runCauveryCatalogueImport(
  options: RunCauveryImportOptions = {}
): Promise<CatalogueImportJobStatus> {
  if (activeImportPromise) {
    return activeImportPromise;
  }

  pauseRequested = false;
  const task = executeImportLoop(options);
  activeImportPromise = task;
  try {
    return await task;
  } finally {
    activeImportPromise = null;
  }
}

async function executeImportLoop(
  options: RunCauveryImportOptions
): Promise<CatalogueImportJobStatus> {
  await ensureDataDirs();
  const sb = getServerSupabaseClient();
  const storageBackend: 'supabase' | 'local-store' = sb ? 'supabase' : 'local-store';
  const pageSize = Math.max(10, Math.min(100, options.pageSize ?? 50));
  const downloadImages = options.downloadImages !== false;

  const snapshot = await readLocalSnapshot();
  const prevState = await readLocalImportState();

  const isResuming =
    Boolean(options.resume) &&
    (prevState.status === 'paused' || prevState.status === 'failed') &&
    prevState.currentPage > 0;

  const state: CatalogueImportJobStatus = isResuming
    ? {
        ...prevState,
        status: 'running',
        storageBackend,
        updatedAt: new Date().toISOString(),
      }
    : {
        id: `cauvery-${Date.now()}`,
        sourceDomain: SOURCE_DOMAIN,
        status: 'running',
        currentPage: 0,
        totalPages: 0,
        pageSize,
        discoveredCount: 0,
        importedCount: 0,
        updatedCount: 0,
        skippedDuplicatesCount: 0,
        failedCount: 0,
        manufacturersCount: 0,
        imagesUploadedCount: 0,
        imagesFailedCount: 0,
        storageBackend,
        errors: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
      };

  const pushError = (
    stage: CatalogueImportErrorRecord['stage'],
    ref: string,
    message: string
  ) => {
    if (state.errors.length < 250) {
      state.errors.push({
        stage,
        ref,
        message: message.slice(0, 300),
        timestamp: new Date().toISOString(),
      });
    }
  };

  await writeLocalImportState(state);
  options.onProgress?.(state);

  const productsBySourceKey = new Map<string, ProductCatalogueItem>();
  for (const p of snapshot.products) {
    const key = p.sourceKey || `legacy:${p.id}`;
    productsBySourceKey.set(key, p);
  }

  const imageCache = new Map<string, { storagePath: string; publicUrl: string } | null>();
  const seenInRun = new Set<string>();
  let parentCategoryMap = new Map<string, { parentName: string; subName?: string }>();
  let pagesProcessedThisRun = 0;

  try {
    let page = state.currentPage;
    let totalPages = state.totalPages || 1;

    while (page < totalPages) {
      if (pauseRequested) {
        state.status = 'paused';
        state.updatedAt = new Date().toISOString();
        await writeLocalImportState(state);
        options.onProgress?.(state);
        return state;
      }

      if (options.maxPages && pagesProcessedThisRun >= options.maxPages) {
        state.status = 'paused';
        state.updatedAt = new Date().toISOString();
        await writeLocalImportState(state);
        options.onProgress?.(state);
        return state;
      }

      const apiUrl = `${CATALOG_API_BASE}?attributes=true&online-only=true&child-cat-products=true&page=${page}&size=${pageSize}`;
      let json: RawSuperProductsResponse;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const resp = await fetchWithTimeout(apiUrl, 'catalog-api');
          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} fetching page ${page}`);
          }
          json = (await resp.json()) as RawSuperProductsResponse;
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, attempt * 600));
        }
      }

      if (lastErr) {
        state.failedCount += 1;
        pushError(
          'fetch-page',
          `page=${page}`,
          lastErr instanceof Error ? lastErr.message : 'Failed to fetch catalog page'
        );
        state.status = 'failed';
        state.updatedAt = new Date().toISOString();
        await writeLocalImportState(state);
        options.onProgress?.(state);
        return state;
      }

      const sp = json!.payload?.super_products;
      const content = Array.isArray(sp?.content) ? sp.content : [];
      if (typeof sp?.totalPages === 'number' && sp.totalPages > 0) {
        totalPages = sp.totalPages;
        state.totalPages = totalPages;
      }
      if (typeof sp?.totalElements === 'number' && sp.totalElements > 0) {
        state.discoveredCount = sp.totalElements;
      }
      if (parentCategoryMap.size === 0 && json!.payload?.facets) {
        parentCategoryMap = buildCategoryHierarchyMap(json!.payload.facets);
      }

      // Collect unique image URLs on this page and ingest them cleanly with concurrency control
      const pageImageUrls = new Set<string>();
      if (downloadImages) {
        for (const raw of content) {
          if (raw.thumbnail?.trim()) pageImageUrls.add(raw.thumbnail.trim());
          if (raw.next_img?.trim()) pageImageUrls.add(raw.next_img.trim());
          for (const v of raw.product_variants ?? []) {
            if (v.thumbnail?.trim()) pageImageUrls.add(v.thumbnail.trim());
          }
        }
      }

      const resolvedImagesForPage = new Map<string, { storagePath: string; publicUrl: string }>();
      if (downloadImages && pageImageUrls.size > 0) {
        await runPool(Array.from(pageImageUrls), IMAGE_CONCURRENCY, async (imgUrl) => {
          try {
            const res = await ingestProductImage(imgUrl, sb, imageCache);
            if (res) {
              resolvedImagesForPage.set(imgUrl, {
                storagePath: res.storagePath,
                publicUrl: res.publicUrl,
              });
              if (res.uploaded) {
                state.imagesUploadedCount += 1;
              }
            }
          } catch (err) {
            state.imagesFailedCount += 1;
            pushError(
              'download-image',
              imgUrl,
              err instanceof Error ? err.message : 'Image download/upload failed'
            );
          }
        });
      }

      const pageProductsToSync: ProductCatalogueItem[] = [];
      for (const raw of content) {
        try {
          const item = normalizeCauverySuperProduct(raw, {
            parentCategoryMap,
            resolvedImages: resolvedImagesForPage,
          });
          if (!item || !item.sourceKey) {
            state.failedCount += 1;
            pushError('parse-product', raw.super_prod_sku || raw.name || 'unknown', 'Missing SKU or name');
            continue;
          }

          if (seenInRun.has(item.sourceKey)) {
            state.skippedDuplicatesCount += 1;
            continue;
          }
          seenInRun.add(item.sourceKey);

          const existing = productsBySourceKey.get(item.sourceKey);
          if (existing) {
            // Compare key commercial/spec fields to distinguish duplicate vs updated product
            const unchanged =
              existing.productName === item.productName &&
              existing.unitPrice === item.unitPrice &&
              existing.mrp === item.mrp &&
              existing.gstPercent === item.gstPercent &&
              existing.imageUrl === item.imageUrl &&
              (existing.variants?.length ?? 0) === (item.variants?.length ?? 0);
            if (unchanged) {
              state.skippedDuplicatesCount += 1;
            } else {
              productsBySourceKey.set(item.sourceKey, {
                ...item,
                id: existing.id,
              });
              pageProductsToSync.push({ ...item, id: existing.id });
              state.updatedCount += 1;
            }
          } else {
            productsBySourceKey.set(item.sourceKey, item);
            pageProductsToSync.push(item);
            state.importedCount += 1;
          }
        } catch (err) {
          state.failedCount += 1;
          pushError(
            'parse-product',
            raw.super_prod_sku || raw.name || 'unknown',
            err instanceof Error ? err.message : 'Failed to parse product'
          );
        }
      }

      // Persist incremental checkpoint after EVERY page for reliable resumability
      const allProducts = Array.from(productsBySourceKey.values());
      const allManufacturers = buildManufacturersList(allProducts, snapshot.manufacturers);
      state.manufacturersCount = allManufacturers.length;
      state.currentPage = page + 1;
      state.updatedAt = new Date().toISOString();

      await writeLocalSnapshot({
        version: 1,
        updatedAt: state.updatedAt,
        sourceDomain: SOURCE_DOMAIN,
        manufacturers: allManufacturers,
        products: allProducts,
      });

      if (sb && pageProductsToSync.length > 0) {
        const syncRes = await syncSnapshotToSupabase(pageProductsToSync, allManufacturers, sb);
        if (!syncRes.synced && syncRes.error) {
          pushError('persist', `page=${page}`, `Supabase upsert warning: ${syncRes.error}`);
        }
      }

      await writeLocalImportState(state);
      options.onProgress?.({ ...state });

      pagesProcessedThisRun += 1;
      page += 1;
      if (sp?.last || content.length === 0) {
        break;
      }
    }

    state.status = 'completed';
    state.completedAt = new Date().toISOString();
    state.updatedAt = state.completedAt;
    await writeLocalImportState(state);
    options.onProgress?.({ ...state });
    return state;
  } catch (err) {
    state.status = 'failed';
    state.updatedAt = new Date().toISOString();
    pushError(
      'persist',
      `page=${state.currentPage}`,
      err instanceof Error ? err.message : 'Unexpected importer failure'
    );
    await writeLocalImportState(state);
    options.onProgress?.({ ...state });
    return state;
  }
}
