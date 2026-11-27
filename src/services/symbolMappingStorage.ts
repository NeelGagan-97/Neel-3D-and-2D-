import {
  AiDrawingType,
  DrawingLayerState,
  SymbolMappingDefinition,
  SymbolTargetDomain,
  SymbolTemplate,
} from '../types/aiDrawing';
import { ElectricalCategory, ElectricalItemType } from '../types/design';

const MAPPINGS_STORAGE_KEY = 'bluespace_ai_drawing_symbol_mappings_v1';
const TEMPLATES_STORAGE_KEY = 'bluespace_ai_drawing_symbol_templates_v1';
const MAX_SAMPLE_DATA_URL_LENGTH = 2 * 1024 * 1024; // ~1.5MB raster image max

const ALLOWED_RASTER_DATA_URL_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=\s]+$/i;

export const SYMBOL_DOMAIN_OPTIONS: Array<{
  domain: SymbolTargetDomain;
  label: string;
  defaultColor: string;
  defaultElectricalCategory?: ElectricalCategory;
}> = [
  { domain: 'lighting', label: 'Lighting Fixture', defaultColor: '#f59e0b', defaultElectricalCategory: 'Lighting' },
  { domain: 'fan', label: 'Fan / Ventilation', defaultColor: '#38bdf8', defaultElectricalCategory: 'Fans' },
  { domain: 'switch', label: 'Switch / Switchboard', defaultColor: '#a855f7', defaultElectricalCategory: 'Switches' },
  { domain: 'socket', label: 'Socket / Outlet', defaultColor: '#22c55e', defaultElectricalCategory: 'Sockets' },
  { domain: 'appliance', label: 'Appliance / Heavy Load', defaultColor: '#fb7185', defaultElectricalCategory: 'Appliances' },
  { domain: 'distribution', label: 'DB / Panel / Earthing', defaultColor: '#ef4444', defaultElectricalCategory: 'Distribution' },
  { domain: 'architectural', label: 'Architectural Symbol', defaultColor: '#64748b' },
  { domain: 'custom', label: 'Custom / Other Symbol', defaultColor: '#14b8a6' },
];

export const ELECTRICAL_ITEM_OPTIONS_BY_DOMAIN: Record<
  SymbolTargetDomain,
  Array<{ itemType: ElectricalItemType; label: string; category: ElectricalCategory }>
> = {
  lighting: [
    { itemType: 'led_light', label: 'LED Downlight / Fixture', category: 'Lighting' },
    { itemType: 'spotlight', label: 'Spotlight', category: 'Lighting' },
    { itemType: 'panel_light', label: 'Panel Light', category: 'Lighting' },
    { itemType: 'strip_light', label: 'Strip / Cove Light', category: 'Lighting' },
    { itemType: 'chandelier', label: 'Chandelier / Pendant', category: 'Lighting' },
  ],
  fan: [
    { itemType: 'ceiling_fan', label: 'Ceiling Fan', category: 'Fans' },
    { itemType: 'exhaust_fan', label: 'Exhaust Fan', category: 'Fans' },
  ],
  switch: [
    { itemType: 'switch', label: 'Single / Modular Switch', category: 'Switches' },
    { itemType: 'switchboard', label: 'Switchboard / Gang Box', category: 'Switches' },
  ],
  socket: [
    { itemType: 'socket_5a', label: '5A / 6A General Socket', category: 'Sockets' },
    { itemType: 'socket_16a', label: '16A Power Socket', category: 'Sockets' },
    { itemType: 'usb_outlet', label: 'USB / Data Outlet', category: 'Sockets' },
  ],
  appliance: [
    { itemType: 'split_ac', label: 'Split AC Point', category: 'Appliances' },
    { itemType: 'geyser', label: 'Geyser / Water Heater', category: 'Appliances' },
    { itemType: 'appliance', label: 'General Appliance Point', category: 'Appliances' },
  ],
  distribution: [
    { itemType: 'distribution_board', label: 'Distribution Board (DB)', category: 'Distribution' },
    { itemType: 'earthing_point', label: 'Earthing Point', category: 'Distribution' },
  ],
  architectural: [],
  custom: [
    { itemType: 'appliance', label: 'Custom Electrical Point', category: 'Appliances' },
    { itemType: 'led_light', label: 'Custom Lighting Point', category: 'Lighting' },
    { itemType: 'socket_5a', label: 'Custom Socket Point', category: 'Sockets' },
  ],
};

/**
 * Validates that a symbol thumbnail/sample image is strictly a safe raster PNG or JPEG data-URL.
 * Rejects javascript:, data:text/html, data:image/svg+xml, external URLs, or oversized payloads.
 */
export function sanitizeSymbolSampleDataUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_SAMPLE_DATA_URL_LENGTH) return undefined;
  if (!ALLOWED_RASTER_DATA_URL_RE.test(trimmed)) return undefined;
  return trimmed;
}

function getSafeStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Ignore storage access errors in restricted environments
  }
  return null;
}

function sanitizeMapping(raw: unknown): SymbolMappingDefinition | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : '';
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 80) : '';
  if (!id || !name) return null;

  const domain = SYMBOL_DOMAIN_OPTIONS.some((d) => d.domain === obj.domain)
    ? (obj.domain as SymbolTargetDomain)
    : 'custom';
  const defaultColor =
    SYMBOL_DOMAIN_OPTIONS.find((d) => d.domain === domain)?.defaultColor ?? '#14b8a6';

  return {
    id,
    name,
    code:
      typeof obj.code === 'string' && obj.code.trim()
        ? obj.code.trim().toUpperCase().slice(0, 24)
        : name.slice(0, 6).toUpperCase(),
    domain,
    electricalItemType:
      typeof obj.electricalItemType === 'string' && obj.electricalItemType.trim()
        ? (obj.electricalItemType as ElectricalItemType)
        : undefined,
    electricalCategory:
      typeof obj.electricalCategory === 'string' && obj.electricalCategory.trim()
        ? (obj.electricalCategory as ElectricalCategory)
        : undefined,
    description: typeof obj.description === 'string' ? obj.description.trim().slice(0, 240) : '',
    visualNotes: typeof obj.visualNotes === 'string' ? obj.visualNotes.trim().slice(0, 240) : '',
    sampleImageDataUrl: sanitizeSymbolSampleDataUrl(obj.sampleImageDataUrl),
    markerColor:
      typeof obj.markerColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(obj.markerColor)
        ? obj.markerColor
        : defaultColor,
    enabled: obj.enabled !== false,
    sourceCrop:
      obj.sourceCrop && typeof obj.sourceCrop === 'object'
        ? (obj.sourceCrop as SymbolMappingDefinition['sourceCrop'])
        : undefined,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString(),
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
  };
}

export function loadSymbolMappings(): SymbolMappingDefinition[] {
  const storage = getSafeStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(MAPPINGS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(sanitizeMapping)
      .filter((item): item is SymbolMappingDefinition => item !== null);
  } catch {
    return [];
  }
}

export function saveSymbolMappings(mappings: SymbolMappingDefinition[]): SymbolMappingDefinition[] {
  const cleaned = mappings
    .map(sanitizeMapping)
    .filter((item): item is SymbolMappingDefinition => item !== null);
  const storage = getSafeStorage();
  if (storage) {
    try {
      storage.setItem(MAPPINGS_STORAGE_KEY, JSON.stringify(cleaned));
    } catch {
      // Ignore quota errors gracefully
    }
  }
  return cleaned;
}

export function createSymbolMapping(input: {
  name: string;
  code?: string;
  domain: SymbolTargetDomain;
  electricalItemType?: ElectricalItemType;
  electricalCategory?: ElectricalCategory;
  description?: string;
  visualNotes?: string;
  sampleImageDataUrl?: string;
  markerColor?: string;
  sourceCrop?: SymbolMappingDefinition['sourceCrop'];
}): SymbolMappingDefinition {
  const now = new Date().toISOString();
  const domainMeta = SYMBOL_DOMAIN_OPTIONS.find((d) => d.domain === input.domain);
  const name = input.name.trim().slice(0, 80);
  const code = (input.code?.trim() || name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || 'SYM')
    .toUpperCase()
    .slice(0, 24);

  return {
    id: `sym-map-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    code,
    domain: input.domain,
    electricalItemType: input.electricalItemType,
    electricalCategory: input.electricalCategory ?? domainMeta?.defaultElectricalCategory,
    description: (input.description ?? '').trim().slice(0, 240),
    visualNotes: (input.visualNotes ?? '').trim().slice(0, 240),
    sampleImageDataUrl: sanitizeSymbolSampleDataUrl(input.sampleImageDataUrl),
    markerColor:
      input.markerColor && /^#[0-9a-fA-F]{6}$/.test(input.markerColor)
        ? input.markerColor
        : (domainMeta?.defaultColor ?? '#14b8a6'),
    enabled: true,
    sourceCrop: input.sourceCrop,
    createdAt: now,
    updatedAt: now,
  };
}

export function loadSymbolTemplates(): SymbolTemplate[] {
  const storage = getSafeStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(TEMPLATES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === 'object'))
      .map((t) => ({
        id: String(t.id ?? ''),
        name: String(t.name ?? '').trim().slice(0, 80),
        description: String(t.description ?? '').trim().slice(0, 240),
        drawingType: (t.drawingType as AiDrawingType) || 'Architectural Floor Plan',
        symbols: Array.isArray(t.symbols)
          ? t.symbols
              .map(sanitizeMapping)
              .filter((s): s is SymbolMappingDefinition => s !== null)
          : [],
        createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
        updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : new Date().toISOString(),
      }))
      .filter((t) => Boolean(t.id && t.name));
  } catch {
    return [];
  }
}

export function saveSymbolTemplate(input: {
  name: string;
  description?: string;
  drawingType: AiDrawingType;
  symbols: SymbolMappingDefinition[];
}): SymbolTemplate[] {
  const existing = loadSymbolTemplates();
  const now = new Date().toISOString();
  const template: SymbolTemplate = {
    id: `sym-tpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: input.name.trim().slice(0, 80),
    description: (input.description ?? '').trim().slice(0, 240),
    drawingType: input.drawingType,
    symbols: input.symbols
      .map(sanitizeMapping)
      .filter((s): s is SymbolMappingDefinition => s !== null),
    createdAt: now,
    updatedAt: now,
  };
  const next = [template, ...existing];
  const storage = getSafeStorage();
  if (storage) {
    try {
      storage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore quota errors
    }
  }
  return next;
}

export function deleteSymbolTemplate(templateId: string): SymbolTemplate[] {
  const next = loadSymbolTemplates().filter((t) => t.id !== templateId);
  const storage = getSafeStorage();
  if (storage) {
    try {
      storage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore quota errors
    }
  }
  return next;
}

export function createDefaultDrawingLayers(): DrawingLayerState[] {
  return [
    { id: 'referenceImage', label: 'Reference Drawing', visible: true, locked: true, color: '#94a3b8' },
    { id: 'walls', label: 'Walls', visible: true, locked: false, color: '#38bdf8' },
    { id: 'rooms', label: 'Rooms & Spaces', visible: true, locked: false, color: '#6366f1' },
    { id: 'openings', label: 'Doors & Windows', visible: true, locked: false, color: '#f59e0b' },
    { id: 'columns', label: 'Columns / Structural', visible: true, locked: false, color: '#94a3b8' },
    { id: 'staircases', label: 'Staircases', visible: true, locked: false, color: '#ec4899' },
    { id: 'furniture', label: 'Furniture & Fixtures', visible: true, locked: false, color: '#a855f7' },
    { id: 'symbols', label: 'Electrical / Custom Symbols', visible: true, locked: false, color: '#22c55e' },
    { id: 'wiring', label: 'Wiring Paths', visible: true, locked: false, color: '#ef4444' },
    { id: 'dimensions', label: 'Dimensions', visible: true, locked: false, color: '#06b6d4' },
    { id: 'labels', label: 'Text Labels & Notes', visible: true, locked: false, color: '#cbd5e1' },
  ];
}
