import { ElectricalItemType } from './design';

export type CatalogueCategory =
  | 'Cables & Wires'
  | 'Switches'
  | 'Sockets'
  | 'Distribution Boards'
  | 'MCBs'
  | 'RCCBs & RCBOs'
  | 'Earthing Accessories'
  | 'LED Bulbs'
  | 'LED Panels'
  | 'LED Downlights'
  | 'LED Strips'
  | 'LED Battens'
  | 'Fans'
  | 'Electrical Appliances'
  | 'Conduits & Accessories';

export type ManufacturerName =
  | 'Polycab'
  | 'Finolex'
  | 'Havells'
  | 'RR Kabel'
  | 'KEI'
  | 'Legrand'
  | 'Schneider Electric'
  | 'Anchor / Panasonic'
  | 'GM Modular'
  | 'Philips / Signify'
  | 'Wipro'
  | 'Crompton'
  | 'Bajaj';

export interface ManufacturerReference {
  id?: string;
  slug?: string;
  name: string;
  websiteUrl: string;
  logoUrl?: string | null;
  logoStoragePath?: string | null;
  primaryCategories: CatalogueCategory[];
  notes: string;
  productCount?: number;
  source?: 'official-directory' | 'cauvery-import' | 'admin-entry';
  isActive?: boolean;
}

export interface ProductCatalogueVariant {
  id: string;
  sku: string;
  modelNumber?: string | null;
  label: string;
  displayName: string;
  attributes?: Record<string, string>;
  mrp: number | null;
  unitPrice: number | null;
  discountPercent: number | null;
  imageStoragePath?: string | null;
  imageUrl?: string | null;
  inStock?: boolean;
}

export interface ProductGstDetails {
  name?: string | null;
  cgst?: number | null;
  sgst?: number | null;
  igst?: number | null;
  taxIncluded?: boolean;
}

export interface ProductCatalogueItem {
  id: string;
  sourceKey?: string;
  sourceUrl?: string | null;
  sourceCategory?: string | null;
  category: CatalogueCategory;
  subcategory?: string | null;
  manufacturerId?: string | null;
  manufacturer: string;
  brand: string;
  productName: string;
  modelNumber: string;
  sku?: string | null;
  specification: string;
  technicalSpecs?: Record<string, string>;
  variants?: ProductCatalogueVariant[];
  rating: string;
  wattageW: number | null;
  cableSizeSqMm: number | null;
  dimensions: string;
  unit: string;
  /** Maximum Retail Price (INR); strictly null when unavailable */
  mrp?: number | null;
  /** Selling / net unit price (INR, ex-GST when taxIncluded is false); strictly null if unavailable */
  unitPrice: number | null;
  /** Discount percentage relative to MRP; strictly null when unavailable */
  discountPercent?: number | null;
  /** GST percentage (e.g., 18); strictly null if not provided */
  gstPercent: number | null;
  gstDetails?: ProductGstDetails | null;
  /** Permanent Supabase Storage / local storage object path (never external runtime URL) */
  imageStoragePath?: string | null;
  /** Blue Space-hosted image URL (Supabase Storage public URL or /api/catalogue/images/...) */
  imageUrl?: string | null;
  galleryImages?: string[];
  datasheetUrl?: string | null;
  manufacturerUrl?: string | null;
  /** Optional mapping to Blue Space 2D/3D electrical symbol type */
  mappedItemType?: ElectricalItemType;
  source: 'admin-entry' | 'csv-import' | 'cauvery-import';
  isActive?: boolean;
  updatedAt: string;
}

export interface CatalogueImportErrorRecord {
  stage: 'fetch-page' | 'parse-product' | 'download-image' | 'upload-image' | 'persist';
  ref: string;
  message: string;
  timestamp: string;
}

export interface CatalogueImportJobStatus {
  id: string;
  sourceDomain: string;
  status: 'idle' | 'queued' | 'running' | 'paused' | 'completed' | 'failed';
  currentPage: number;
  totalPages: number;
  pageSize: number;
  discoveredCount: number;
  importedCount: number;
  updatedCount: number;
  skippedDuplicatesCount: number;
  failedCount: number;
  manufacturersCount: number;
  imagesUploadedCount: number;
  imagesFailedCount: number;
  storageBackend: 'supabase' | 'local-store';
  errors: CatalogueImportErrorRecord[];
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}
