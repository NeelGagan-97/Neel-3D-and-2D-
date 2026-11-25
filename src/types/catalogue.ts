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
  | 'Electrical Appliances';

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
  name: ManufacturerName;
  websiteUrl: string;
  primaryCategories: CatalogueCategory[];
  notes: string;
}

export interface ProductCatalogueItem {
  id: string;
  category: CatalogueCategory;
  manufacturer: ManufacturerName | string;
  brand: string;
  productName: string;
  modelNumber: string;
  /** Optional product image URL provided by administrator/import */
  imageUrl?: string;
  /** Freeform verified technical specification from manufacturer datasheet */
  specification: string;
  /** Rated voltage / current / wattage string (e.g. "240V AC, 16A" or "1100V FRLS") */
  rating: string;
  /** Rated wattage in Watts if applicable (null if not specified) */
  wattageW: number | null;
  /** Conductor cross-section in sq.mm for cables & wires (null for non-cable items) */
  cableSizeSqMm: number | null;
  /** Physical dimensions text from datasheet */
  dimensions: string;
  /** Unit of measurement (e.g. "Nos", "m", "Coil (90m)") */
  unit: string;
  /** Verified unit price in INR (null when not yet configured — never invented) */
  unitPrice: number | null;
  /** Applicable GST percentage (null when not yet configured) */
  gstPercent: number | null;
  /** Manufacturer datasheet URL */
  datasheetUrl?: string;
  /** Manufacturer product page URL */
  manufacturerUrl?: string;
  /** Optional mapping to a Design Studio electrical component type for 1-click placement */
  mappedItemType?: ElectricalItemType;
  /** Tracks origin of record (admin manual entry or spreadsheet import) */
  source: 'admin-entry' | 'csv-import';
  updatedAt: string;
}
