import {
  BoqRow,
  CircuitId,
  ElectricalCatalogItem,
  ElectricalCategory,
  ElectricalItemType,
  ElectricalPoint,
  ProjectData,
  ProjectMetrics,
  RoomBreakdownRow,
  RoomType,
  RoomZone,
  SiteConfig,
} from '../types/design';

export const FT_TO_M = 0.3048;
export const M_TO_FT = 1 / FT_TO_M;

export function siteToMeters(site: SiteConfig) {
  const factor = site.units === 'ft' ? FT_TO_M : 1;
  return {
    lengthM: Number((site.length * factor).toFixed(2)),
    widthM: Number((site.width * factor).toFixed(2)),
    ceilingM: Number((site.ceilingHeight * factor).toFixed(2)),
    wallThickM: Math.max(0.12, Number((site.wallThickness * factor).toFixed(2))),
  };
}

export const ELECTRICAL_CATALOG: ElectricalCatalogItem[] = [
  {
    itemType: 'ceiling_fan',
    label: 'Ceiling Fans',
    shortCode: 'FAN',
    productName: 'BLDC Smart Ceiling Fan 1200mm',
    category: 'Fans',
    boqCategory: 'Ceiling Fans',
    defaultWattage: 35,
    defaultMountHeight: 2.95,
    defaultCircuit: 'CKT-L1 (Lighting)',
    unitCost: 3850,
    icon: 'mode_fan',
  },
  {
    itemType: 'exhaust_fan',
    label: 'Exhaust Fans',
    shortCode: 'EXH',
    productName: 'Kitchen Ventilation Exhaust Fan 200mm',
    category: 'Fans',
    boqCategory: 'Exhaust Fans',
    defaultWattage: 45,
    defaultMountHeight: 2.45,
    defaultCircuit: 'CKT-P1 (Kitchen)',
    unitCost: 2150,
    icon: 'air',
  },
  {
    itemType: 'led_light',
    label: 'LED Lights',
    shortCode: 'LED',
    productName: 'Warm 15W Architectural LED Downlight',
    category: 'Lighting',
    boqCategory: 'Lighting',
    defaultWattage: 15,
    defaultMountHeight: 2.95,
    defaultCircuit: 'CKT-L1 (Lighting)',
    unitCost: 850,
    icon: 'lightbulb',
  },
  {
    itemType: 'spotlight',
    label: 'Spotlights',
    shortCode: 'SPT',
    productName: 'Architectural Gimbal Spotlight 18W',
    category: 'Lighting',
    boqCategory: 'Lighting',
    defaultWattage: 18,
    defaultMountHeight: 2.95,
    defaultCircuit: 'CKT-L1 (Lighting)',
    unitCost: 1400,
    icon: 'highlight',
  },
  {
    itemType: 'panel_light',
    label: 'Panel Lights',
    shortCode: 'PNL',
    productName: 'Recessed 15W LED Panel Light',
    category: 'Lighting',
    boqCategory: 'Lighting',
    defaultWattage: 15,
    defaultMountHeight: 2.95,
    defaultCircuit: 'CKT-L1 (Lighting)',
    unitCost: 850,
    icon: 'crop_square',
  },
  {
    itemType: 'strip_light',
    label: 'Strip Lights',
    shortCode: 'STR',
    productName: 'Architectural Cove LED Strip Set 24W',
    category: 'Lighting',
    boqCategory: 'Lighting',
    defaultWattage: 24,
    defaultMountHeight: 2.85,
    defaultCircuit: 'CKT-L1 (Lighting)',
    unitCost: 2000,
    icon: 'linear_scale',
  },
  {
    itemType: 'chandelier',
    label: 'Chandeliers',
    shortCode: 'CHN',
    productName: 'Modern Brass & Crystal Chandelier',
    category: 'Lighting',
    boqCategory: 'Lighting',
    defaultWattage: 60,
    defaultMountHeight: 2.6,
    defaultCircuit: 'CKT-L1 (Lighting)',
    unitCost: 14500,
    icon: 'light',
  },
  {
    itemType: 'switch',
    label: 'Switches',
    shortCode: 'SW',
    productName: '2-Way Modular Bell / Dimmer Switch',
    category: 'Switches',
    boqCategory: 'Switches',
    defaultWattage: 0,
    defaultMountHeight: 1.2,
    defaultCircuit: 'CKT-L1 (Lighting)',
    unitCost: 650,
    icon: 'toggle_on',
  },
  {
    itemType: 'switchboard',
    label: 'Switchboards',
    shortCode: 'SB',
    productName: '8-Module Glass Plate Switchboard',
    category: 'Switches',
    boqCategory: 'Switches',
    defaultWattage: 0,
    defaultMountHeight: 1.2,
    defaultCircuit: 'CKT-L1 (Lighting)',
    unitCost: 1600,
    icon: 'grid_view',
  },
  {
    itemType: 'socket_5a',
    label: '5A Sockets',
    shortCode: 'SKT-5A',
    productName: '5A Modular Universal Socket',
    category: 'Sockets',
    boqCategory: 'Sockets',
    defaultWattage: 100,
    defaultMountHeight: 0.45,
    defaultCircuit: 'CKT-L1 (Lighting)',
    unitCost: 650,
    icon: 'outlet',
  },
  {
    itemType: 'socket_16a',
    label: '16A Sockets',
    shortCode: 'SKT-16A',
    productName: '16A Heavy-Duty Power Socket',
    category: 'Sockets',
    boqCategory: 'Sockets',
    defaultWattage: 500,
    defaultMountHeight: 1.05,
    defaultCircuit: 'CKT-P1 (Kitchen)',
    unitCost: 1250,
    icon: 'power',
  },
  {
    itemType: 'usb_outlet',
    label: 'USB Outlets',
    shortCode: 'USB',
    productName: 'Modular USB-C Fast Charge Outlet',
    category: 'Sockets',
    boqCategory: 'Sockets',
    defaultWattage: 20,
    defaultMountHeight: 0.75,
    defaultCircuit: 'CKT-L2 (Bedrooms)',
    unitCost: 1000,
    icon: 'usb',
  },
  {
    itemType: 'split_ac',
    label: 'AC',
    shortCode: 'AC',
    productName: '1.5 Ton 5-Star Inverter Split AC',
    category: 'Appliances',
    boqCategory: 'Appliances',
    defaultWattage: 1500,
    defaultMountHeight: 2.4,
    defaultCircuit: 'CKT-P2 (Power 16A)',
    unitCost: 34000,
    icon: 'ac_unit',
  },
  {
    itemType: 'geyser',
    label: 'Geysers',
    shortCode: 'GYS',
    productName: '25L Storage Water Heater (Geyser)',
    category: 'Appliances',
    boqCategory: 'Appliances',
    defaultWattage: 1200,
    defaultMountHeight: 2.15,
    defaultCircuit: 'CKT-P2 (Power 16A)',
    unitCost: 9500,
    icon: 'water_heater',
  },
  {
    itemType: 'appliance',
    label: 'Appliances',
    shortCode: 'APP',
    productName: 'Modular Kitchen Chimney & Hob Point',
    category: 'Appliances',
    boqCategory: 'Appliances',
    defaultWattage: 485,
    defaultMountHeight: 1.5,
    defaultCircuit: 'CKT-P1 (Kitchen)',
    unitCost: 3500,
    icon: 'kitchen',
  },
  {
    itemType: 'distribution_board',
    label: 'Distribution Board',
    shortCode: 'DB',
    productName: 'Main Distribution Board (DB)',
    category: 'Distribution',
    boqCategory: 'Distribution Boards',
    defaultWattage: 0,
    defaultMountHeight: 1.5,
    defaultCircuit: 'CKT-L1 (Lighting)',
    unitCost: 0,
    icon: 'electrical_services',
  },
  {
    itemType: 'earthing_point',
    label: 'Earthing Point',
    shortCode: 'EP',
    productName: 'Main Earthing Point (PE Pit / Bus)',
    category: 'Distribution',
    boqCategory: 'Earthing Accessories',
    defaultWattage: 0,
    defaultMountHeight: 0.35,
    defaultCircuit: 'CKT-P2 (Power 16A)',
    unitCost: 0,
    icon: 'bolt',
  },
];

export const CATALOG_MAP: Record<ElectricalItemType, ElectricalCatalogItem> =
  ELECTRICAL_CATALOG.reduce((acc, item) => {
    acc[item.itemType] = item;
    return acc;
  }, {} as Record<ElectricalItemType, ElectricalCatalogItem>);

export const ROOM_LIBRARY: {
  type: RoomType;
  label: string;
  icon: string;
  defaultLengthFt: number;
  defaultWidthFt: number;
  defaultW: number;
  defaultH: number;
  finish: RoomZone['floorFinish'];
}[] = [
  { type: 'living', label: 'Living Room', icon: 'weekend', defaultLengthFt: 16, defaultWidthFt: 14, defaultW: 4.88, defaultH: 4.27, finish: 'wood' },
  { type: 'hall', label: 'Hall', icon: 'meeting_room', defaultLengthFt: 16, defaultWidthFt: 12, defaultW: 4.88, defaultH: 3.66, finish: 'terrazzo' },
  { type: 'kitchen', label: 'Kitchen', icon: 'countertops', defaultLengthFt: 12, defaultWidthFt: 10, defaultW: 3.66, defaultH: 3.05, finish: 'tile' },
  { type: 'master-bedroom', label: 'Master Bedroom', icon: 'bed', defaultLengthFt: 14, defaultWidthFt: 12, defaultW: 4.27, defaultH: 3.66, finish: 'wood' },
  { type: 'bedroom', label: 'Bedroom', icon: 'single_bed', defaultLengthFt: 12, defaultWidthFt: 10, defaultW: 3.66, defaultH: 3.05, finish: 'wood' },
  { type: 'guest-bedroom', label: 'Guest Bedroom', icon: 'bedroom_parent', defaultLengthFt: 12, defaultWidthFt: 10, defaultW: 3.66, defaultH: 3.05, finish: 'wood' },
  { type: 'bathroom', label: 'Bathroom', icon: 'shower', defaultLengthFt: 8, defaultWidthFt: 6, defaultW: 2.44, defaultH: 1.83, finish: 'stone' },
  { type: 'common-bathroom', label: 'Common Bathroom', icon: 'bathtub', defaultLengthFt: 7, defaultWidthFt: 5, defaultW: 2.13, defaultH: 1.52, finish: 'stone' },
  { type: 'dining', label: 'Dining Room', icon: 'dining', defaultLengthFt: 12, defaultWidthFt: 10, defaultW: 3.66, defaultH: 3.05, finish: 'terrazzo' },
  { type: 'pooja', label: 'Pooja Room', icon: 'temple_hindu', defaultLengthFt: 6, defaultWidthFt: 6, defaultW: 1.83, defaultH: 1.83, finish: 'terrazzo' },
  { type: 'balcony', label: 'Balcony', icon: 'balcony', defaultLengthFt: 10, defaultWidthFt: 5, defaultW: 3.05, defaultH: 1.52, finish: 'stone' },
  { type: 'utility', label: 'Utility Room', icon: 'local_laundry_service', defaultLengthFt: 8, defaultWidthFt: 6, defaultW: 2.44, defaultH: 1.83, finish: 'tile' },
  { type: 'store', label: 'Store Room', icon: 'inventory_2', defaultLengthFt: 8, defaultWidthFt: 6, defaultW: 2.44, defaultH: 1.83, finish: 'tile' },
  { type: 'study', label: 'Study Room', icon: 'menu_book', defaultLengthFt: 10, defaultWidthFt: 9, defaultW: 3.05, defaultH: 2.74, finish: 'wood' },
  { type: 'custom', label: 'Custom Room', icon: 'add_box', defaultLengthFt: 10, defaultWidthFt: 10, defaultW: 3.05, defaultH: 3.05, finish: 'terrazzo' },
];

export const CIRCUITS: CircuitId[] = [
  'CKT-L1 (Lighting)',
  'CKT-L2 (Bedrooms)',
  'CKT-P1 (Kitchen)',
  'CKT-P2 (Power 16A)',
];

function mkPt(
  id: string,
  code: string,
  name: string,
  itemType: ElectricalItemType,
  roomId: string,
  x: number,
  y: number,
  overrides?: Partial<ElectricalPoint>
): ElectricalPoint {
  const cat = CATALOG_MAP[itemType];
  return {
    id,
    floor: overrides?.floor ?? 1,
    code,
    name,
    itemType,
    category: cat.category,
    roomId,
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
    z: overrides?.z ?? cat.defaultMountHeight,
    rotation: overrides?.rotation ?? 0,
    wattage: overrides?.wattage ?? cat.defaultWattage,
    voltage: overrides?.voltage ?? 230,
    circuit: overrides?.circuit ?? cat.defaultCircuit,
    unitCost: overrides?.unitCost ?? cat.unitCost,
  };
}

function mkPresetDbAndEarthing(prefix: string, roomId: string, x: number, y: number): ElectricalPoint[] {
  const dbId = `${prefix}-db-1`;
  return [
    {
      id: dbId,
      floor: 1,
      code: 'DB-1',
      name: 'Main Distribution Board',
      itemType: 'distribution_board',
      category: 'Distribution',
      roomId,
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      z: 1.5,
      rotation: 0,
      wattage: 0,
      voltage: 230,
      circuit: '',
      unitCost: 4850,
      dbConfig: {
        incomingRatingAmps: 63,
        waysCount: 12,
        phaseType: 'Single Phase (1Φ)',
        rccbSensitivityMa: 30,
        associatedCircuits: [
          'CKT-L1 (Lighting)',
          'CKT-L2 (Bedrooms)',
          'CKT-P1 (Kitchen)',
          'CKT-P2 (Power 16A)',
        ],
        enclosureType: 'Double Door Flush Metal DB',
      },
    },
    {
      id: `${prefix}-ep-1`,
      floor: 1,
      code: 'EP-1',
      name: 'Main Earthing Point',
      itemType: 'earthing_point',
      category: 'Distribution',
      roomId,
      x: Number(x.toFixed(2)),
      y: Number((y + 0.65).toFixed(2)),
      z: 0.35,
      rotation: 0,
      wattage: 0,
      voltage: 0,
      circuit: '',
      unitCost: 2600,
      earthingConfig: {
        earthingType: 'Copper Plate',
        targetResistanceOhm: 2.0,
        earthConductorSizeSqMm: 4.0,
        connectedDbId: dbId,
        notes: 'Dedicated copper plate earthing pit bonded to Main DB earth bar.',
      },
    },
  ];
}

function defaultCircuitCableConfigs(): ProjectData['circuitCableConfigs'] {
  return {
    'CKT-L1 (Lighting)': { circuit: 'CKT-L1 (Lighting)', cableSizeSqMm: 1.5, cableMaterial: 'Copper' },
    'CKT-L2 (Bedrooms)': { circuit: 'CKT-L2 (Bedrooms)', cableSizeSqMm: 1.5, cableMaterial: 'Copper' },
    'CKT-P1 (Kitchen)': { circuit: 'CKT-P1 (Kitchen)', cableSizeSqMm: 2.5, cableMaterial: 'Copper' },
    'CKT-P2 (Power 16A)': { circuit: 'CKT-P2 (Power 16A)', cableSizeSqMm: 2.5, cableMaterial: 'Copper' },
  };
}

/**
 * Indiranagar 3BHK Residence (42 ft x 34 ft = 12.80 m x 10.36 m)
 * 7 rooms, 48 electrical points, 6.84 kW (6,840 W), ₹1,42,850
 */
function createIndiranagar3BHK(): ProjectData {
  const rooms: RoomZone[] = [
    { id: 'r-living', name: 'Living Room', type: 'living', x: 0, y: 0, width: 5.5, height: 5.6, floorFinish: 'wood' },
    { id: 'r-master', name: 'Master Bedroom', type: 'master-bedroom', x: 5.5, y: 0, width: 4.1, height: 5.2, floorFinish: 'wood' },
    { id: 'r-kitchen', name: 'Kitchen', type: 'kitchen', x: 9.6, y: 0, width: 3.2, height: 5.2, floorFinish: 'tile' },
    { id: 'r-dining', name: 'Dining', type: 'dining', x: 0, y: 5.6, width: 3.4, height: 4.76, floorFinish: 'terrazzo' },
    { id: 'r-balcony', name: 'Balcony', type: 'balcony', x: 3.4, y: 5.6, width: 2.1, height: 4.76, floorFinish: 'stone' },
    { id: 'r-bed2', name: 'Second Bedroom', type: 'second-bedroom', x: 5.5, y: 5.2, width: 4.5, height: 5.16, floorFinish: 'wood' },
    { id: 'r-bath', name: 'Bathroom', type: 'bathroom', x: 10.0, y: 5.2, width: 2.8, height: 5.16, floorFinish: 'stone' },
  ];

  const points: ElectricalPoint[] = [
    // LIVING ROOM (14 pts: 2 fans, 6 lights, 2 switchboards, 3 sockets, 1 AC)
    mkPt('p-fan-01', 'FAN-01', 'Ceiling Fan — Living North', 'ceiling_fan', 'r-living', 2.75, 2.0, { circuit: 'CKT-L1 (Lighting)' }),
    mkPt('p-fan-02', 'FAN-02', 'Ceiling Fan — Living South', 'ceiling_fan', 'r-living', 2.75, 4.1, { circuit: 'CKT-L1 (Lighting)' }),
    mkPt('p-pnl-01', 'PNL-01', 'LED Panel — Living NW', 'panel_light', 'r-living', 1.3, 1.3),
    mkPt('p-pnl-02', 'PNL-02', 'LED Panel — Living NE', 'panel_light', 'r-living', 4.2, 1.3),
    mkPt('p-pnl-03', 'PNL-03', 'LED Panel — Living SW', 'panel_light', 'r-living', 1.3, 4.4),
    mkPt('p-pnl-04', 'PNL-04', 'LED Panel — Living SE', 'panel_light', 'r-living', 4.2, 4.4),
    mkPt('p-spt-01', 'SPT-01', 'Accent Spotlight — TV Wall', 'spotlight', 'r-living', 0.9, 2.8),
    mkPt('p-str-01', 'STR-01', 'Cove Strip Light — Living Ceiling', 'strip_light', 'r-living', 2.75, 0.7),
    mkPt('p-sb-01', 'SB-01', 'Modular Switchboard 8M — Entry', 'switchboard', 'r-living', 0.45, 4.9, { rotation: 180 }),
    mkPt('p-sb-02', 'SB-02', 'Modular Switchboard 8M — Media', 'switchboard', 'r-living', 5.1, 2.4, { rotation: 90 }),
    mkPt('p-skt-01', 'SKT-01', '5A Socket — Media Console', 'socket_5a', 'r-living', 0.5, 2.5),
    mkPt('p-skt-02', 'SKT-02', '5A Socket — Sofa Side', 'socket_5a', 'r-living', 4.9, 3.6),
    mkPt('p-usb-01', 'USB-01', 'USB Fast Charge — Lounge', 'usb_outlet', 'r-living', 4.9, 1.6),
    mkPt('p-ac-01', 'AC-01', 'Split AC 1.5T — Living Room', 'split_ac', 'r-living', 2.8, 0.35, { rotation: 0 }),

    // MASTER BEDROOM (10 pts: 1 fan, 4 lights, 2 switchboards, 2 sockets, 1 AC)
    mkPt('p-fan-03', 'FAN-03', 'Ceiling Fan — Master Bed', 'ceiling_fan', 'r-master', 7.55, 2.6, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('p-pnl-05', 'PNL-05', 'LED Panel — Master NW', 'panel_light', 'r-master', 6.4, 1.2, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('p-pnl-06', 'PNL-06', 'LED Panel — Master NE', 'panel_light', 'r-master', 8.7, 1.2, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('p-spt-02', 'SPT-02', 'Reading Spotlight — Bed Left', 'spotlight', 'r-master', 6.8, 4.2, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('p-str-02', 'STR-02', 'Cove Strip — Master Pelmet', 'strip_light', 'r-master', 7.55, 0.6, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('p-sb-03', 'SB-03', 'Switchboard 8M — Master Entry', 'switchboard', 'r-master', 5.85, 4.7, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('p-sb-04', 'SB-04', 'Switchboard 8M — Bedside', 'switchboard', 'r-master', 9.25, 2.8, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('p-skt-03', 'SKT-03', '5A Socket — Master Study', 'socket_5a', 'r-master', 6.0, 1.8, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('p-usb-02', 'USB-02', 'USB Outlet — Bedside', 'usb_outlet', 'r-master', 9.15, 2.1, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('p-ac-02', 'AC-02', 'Split AC 1.5T — Master Bedroom', 'split_ac', 'r-master', 7.6, 0.35, { rotation: 90 }),

    // SECOND BEDROOM (7 pts: 1 fan, 3 lights, 1 switchboard, 2 sockets)
    mkPt('p-fan-04', 'FAN-04', 'Ceiling Fan — Bedroom 2', 'ceiling_fan', 'r-bed2', 7.7, 7.7, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('p-pnl-07', 'PNL-07', 'LED Panel — Bed 2 West', 'panel_light', 'r-bed2', 6.4, 6.4, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('p-pnl-08', 'PNL-08', 'LED Panel — Bed 2 East', 'panel_light', 'r-bed2', 8.9, 6.4, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('p-spt-03', 'SPT-03', 'Wardrobe Spotlight — Bed 2', 'spotlight', 'r-bed2', 7.7, 9.4, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('p-sb-05', 'SB-05', 'Switchboard 8M — Bed 2', 'switchboard', 'r-bed2', 5.85, 6.0, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('p-skt-04', 'SKT-04', '5A Socket — Bed 2 Desk', 'socket_5a', 'r-bed2', 6.1, 9.5, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('p-skt-05', 'SKT-05', '5A Socket — Bed 2 Bedside', 'socket_5a', 'r-bed2', 9.4, 8.2, { circuit: 'CKT-L2 (Bedrooms)' }),

    // KITCHEN (7 pts: 1 exhaust fan, 2 lights, 1 switchboard, 2 16A sockets, 1 chimney/appliance)
    mkPt('p-exh-01', 'EXH-01', 'Ventilation Exhaust Fan — Kitchen', 'exhaust_fan', 'r-kitchen', 12.35, 1.2, { rotation: 270 }),
    mkPt('p-pnl-09', 'PNL-09', 'LED Panel — Kitchen North', 'panel_light', 'r-kitchen', 11.1, 1.6, { circuit: 'CKT-P1 (Kitchen)' }),
    mkPt('p-pnl-10', 'PNL-10', 'LED Panel — Kitchen South', 'panel_light', 'r-kitchen', 11.1, 3.8, { circuit: 'CKT-P1 (Kitchen)' }),
    mkPt('p-sb-06', 'SB-06', 'Switchboard 8M — Kitchen Counter', 'switchboard', 'r-kitchen', 9.9, 4.4, { circuit: 'CKT-P1 (Kitchen)' }),
    mkPt('p-skt-16a-1', 'SKT-16A', '16A Kitchen Socket — Oven/Mixer', 'socket_16a', 'r-kitchen', 12.2, 2.5, { rotation: 270 }),
    mkPt('p-skt-16a-2', 'SKT-16B', '16A Kitchen Socket — Fridge', 'socket_16a', 'r-kitchen', 12.2, 4.1, { rotation: 270 }),
    mkPt('p-app-01', 'APP-01', 'Kitchen Chimney & Hob Point', 'appliance', 'r-kitchen', 11.2, 0.55),

    // DINING (4 pts: 2 panel lights, 1 switchboard, 1 5A socket)
    mkPt('p-pnl-11', 'PNL-11', 'LED Panel — Dining North', 'panel_light', 'r-dining', 1.7, 6.8),
    mkPt('p-pnl-12', 'PNL-12', 'LED Panel — Dining South', 'panel_light', 'r-dining', 1.7, 8.9),
    mkPt('p-sb-07', 'SB-07', 'Switchboard 8M — Dining', 'switchboard', 'r-dining', 0.45, 7.6),
    mkPt('p-skt-06', 'SKT-06', '5A Socket — Dining Crockery', 'socket_5a', 'r-dining', 0.5, 9.4),

    // BALCONY (2 pts: 1 spotlight, 1 switchboard)
    mkPt('p-spt-04', 'SPT-04', 'Weatherproof Spotlight — Balcony', 'spotlight', 'r-balcony', 4.45, 7.9),
    mkPt('p-sb-08', 'SB-08', 'Switchboard 8M — Balcony Door', 'switchboard', 'r-balcony', 3.75, 6.2),

    // BATHROOM (4 pts: 2 panel lights, 1 switchboard, 1 geyser)
    mkPt('p-pnl-13', 'PNL-13', 'LED Panel — Bath Vanity', 'panel_light', 'r-bath', 11.4, 6.6),
    mkPt('p-pnl-14', 'PNL-14', 'LED Panel — Bath Shower', 'panel_light', 'r-bath', 11.4, 8.8),
    mkPt('p-sb-09', 'SB-09', 'Switchboard 8M — Bath Exterior', 'switchboard', 'r-bath', 10.3, 5.7),
    mkPt('p-gys-01', 'GYS-01', '25L Storage Geyser — Bath', 'geyser', 'r-bath', 12.2, 8.2, { rotation: 270 }),
    // DISTRIBUTION BOARD & MAIN EARTHING (Ground Floor inside Living Room entry wall)
    ...mkPresetDbAndEarthing('ind', 'r-living', 0.45, 0.55),
  ];

  return {
    id: 'proj-indiranagar-3bhk',
    refCode: 'ASD-2026-IND-04',
    name: 'Indiranagar 3BHK Residence',
    buildingType: 'single',
    status: 'Active',
    description: '7 rooms, 50 electrical items (48 points + DB-1 + EP-1), complete circuit distribution.',
    site: {
      length: 42,
      width: 34,
      ceilingHeight: 10,
      wallThickness: 0.75,
      units: 'ft',
      floors: 1,
    },
    floorConfigs: [
      { floor: 1, name: 'Ground Floor', kind: 'ground', elevationM: 0, floorHeightM: 3.05, slabThicknessM: 0.22, visible: true },
    ],
    circuitCableConfigs: defaultCircuitCableConfigs(),
    rooms,
    customWalls: [],
    openings: [
      { id: 'op-1', kind: 'door', x: 0, y: 4.5, width: 1.05, rotation: 90 },
      { id: 'op-2', kind: 'door', x: 5.5, y: 4.3, width: 0.9, rotation: 90 },
      { id: 'op-3', kind: 'door', x: 9.6, y: 4.1, width: 0.9, rotation: 90 },
      { id: 'op-4', kind: 'door', x: 5.5, y: 6.2, width: 0.9, rotation: 90 },
      { id: 'op-5', kind: 'door', x: 10.0, y: 6.0, width: 0.8, rotation: 90 },
      { id: 'op-6', kind: 'window', x: 2.2, y: 0, width: 2.2, rotation: 0 },
      { id: 'op-7', kind: 'window', x: 7.4, y: 0, width: 1.8, rotation: 0 },
      { id: 'op-8', kind: 'window', x: 11.2, y: 0, width: 1.4, rotation: 0 },
      { id: 'op-9', kind: 'window', x: 4.4, y: 10.36, width: 1.7, rotation: 0 },
      { id: 'op-10', kind: 'window', x: 7.8, y: 10.36, width: 1.8, rotation: 0 },
    ],
    furniture: [
      { id: 'f-1', kind: 'sofa', roomId: 'r-living', x: 3.5, y: 2.6, width: 2.4, depth: 1.6, rotation: 0 },
      { id: 'f-2', kind: 'tv-unit', roomId: 'r-living', x: 0.55, y: 2.6, width: 0.5, depth: 2.0, rotation: 0 },
      { id: 'f-3', kind: 'bed', roomId: 'r-master', x: 7.6, y: 2.5, width: 2.0, depth: 2.2, rotation: 0 },
      { id: 'f-4', kind: 'kitchen-counter', roomId: 'r-kitchen', x: 11.9, y: 2.4, width: 0.85, depth: 3.6, rotation: 0 },
      { id: 'f-5', kind: 'dining-table', roomId: 'r-dining', x: 1.75, y: 7.9, width: 1.6, depth: 1.2, rotation: 0 },
      { id: 'f-6', kind: 'bed', roomId: 'r-bed2', x: 7.9, y: 8.1, width: 1.8, depth: 2.0, rotation: 90 },
      { id: 'f-7', kind: 'vanity', roomId: 'r-bath', x: 11.4, y: 6.3, width: 1.2, depth: 0.6, rotation: 0 },
    ],
    points,
    updatedAt: '2026-11-20T02:00:00Z',
  };
}

/**
 * Bandra West 2BHK Suite (36 ft x 28 ft = 10.97 m x 8.53 m)
 */
function createBandra2BHK(): ProjectData {
  const rooms: RoomZone[] = [
    { id: 'b-living', name: 'Living Room', type: 'living', x: 0, y: 0, width: 5.2, height: 4.8, floorFinish: 'wood' },
    { id: 'b-master', name: 'Master Bedroom', type: 'master-bedroom', x: 5.2, y: 0, width: 3.3, height: 4.8, floorFinish: 'wood' },
    { id: 'b-kitchen', name: 'Kitchen', type: 'kitchen', x: 8.5, y: 0, width: 2.47, height: 4.8, floorFinish: 'tile' },
    { id: 'b-bed2', name: 'Second Bedroom', type: 'second-bedroom', x: 0, y: 4.8, width: 5.2, height: 3.73, floorFinish: 'wood' },
    { id: 'b-bath', name: 'Bathroom', type: 'bathroom', x: 5.2, y: 4.8, width: 5.77, height: 3.73, floorFinish: 'stone' },
  ];

  const points: ElectricalPoint[] = [
    mkPt('bp-1', 'FAN-01', 'Ceiling Fan — Living', 'ceiling_fan', 'b-living', 2.6, 2.4),
    mkPt('bp-2', 'PNL-01', 'LED Panel — Living NW', 'panel_light', 'b-living', 1.2, 1.2),
    mkPt('bp-3', 'PNL-02', 'LED Panel — Living NE', 'panel_light', 'b-living', 4.0, 1.2),
    mkPt('bp-4', 'PNL-03', 'LED Panel — Living SW', 'panel_light', 'b-living', 1.2, 3.6),
    mkPt('bp-5', 'STR-01', 'Cove Strip — Living', 'strip_light', 'b-living', 2.6, 0.5),
    mkPt('bp-6', 'SB-01', 'Switchboard 8M — Living', 'switchboard', 'b-living', 0.4, 4.1),
    mkPt('bp-7', 'SKT-01', '5A Socket — Living Media', 'socket_5a', 'b-living', 0.4, 2.4),
    mkPt('bp-8', 'USB-01', 'USB Outlet — Sofa', 'usb_outlet', 'b-living', 4.6, 2.4),
    mkPt('bp-9', 'AC-01', 'Split AC 1.5T — Living', 'split_ac', 'b-living', 2.6, 0.35),

    mkPt('bp-10', 'FAN-02', 'Ceiling Fan — Master', 'ceiling_fan', 'b-master', 6.85, 2.4, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('bp-11', 'PNL-04', 'LED Panel — Master N', 'panel_light', 'b-master', 6.85, 1.1, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('bp-12', 'PNL-05', 'LED Panel — Master S', 'panel_light', 'b-master', 6.85, 3.7, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('bp-13', 'STR-02', 'Cove Strip — Master', 'strip_light', 'b-master', 6.85, 0.5, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('bp-14', 'SB-02', 'Switchboard — Master', 'switchboard', 'b-master', 5.6, 4.2, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('bp-15', 'USB-02', 'USB Outlet — Bedside', 'usb_outlet', 'b-master', 8.1, 2.2, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('bp-16', 'AC-02', 'Split AC 1.5T — Master', 'split_ac', 'b-master', 6.85, 0.35),

    mkPt('bp-17', 'EXH-01', 'Exhaust Fan — Kitchen', 'exhaust_fan', 'b-kitchen', 10.6, 1.2),
    mkPt('bp-18', 'PNL-06', 'LED Panel — Kitchen', 'panel_light', 'b-kitchen', 9.7, 2.4, { circuit: 'CKT-P1 (Kitchen)' }),
    mkPt('bp-19', 'SB-03', 'Switchboard — Kitchen', 'switchboard', 'b-kitchen', 8.8, 4.2, { circuit: 'CKT-P1 (Kitchen)' }),
    mkPt('bp-20', 'SKT-16A', '16A Socket — Kitchen', 'socket_16a', 'b-kitchen', 10.5, 2.8),

    mkPt('bp-21', 'FAN-03', 'Ceiling Fan — Bed 2', 'ceiling_fan', 'b-bed2', 2.6, 6.6, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('bp-22', 'PNL-07', 'LED Panel — Bed 2 W', 'panel_light', 'b-bed2', 1.3, 6.6, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('bp-23', 'PNL-08', 'LED Panel — Bed 2 E', 'panel_light', 'b-bed2', 3.9, 6.6, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('bp-24', 'SB-04', 'Switchboard — Bed 2', 'switchboard', 'b-bed2', 4.7, 5.2, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('bp-25', 'SKT-02', '5A Socket — Study', 'socket_5a', 'b-bed2', 0.5, 7.6, { circuit: 'CKT-L2 (Bedrooms)' }),

    mkPt('bp-26', 'PNL-09', 'LED Panel — Bath', 'panel_light', 'b-bath', 7.8, 6.6),
    mkPt('bp-27', 'SPT-01', 'Vanity Spotlight — Bath', 'spotlight', 'b-bath', 6.4, 6.6),
    mkPt('bp-28', 'SB-05', 'Switchboard — Bath', 'switchboard', 'b-bath', 5.6, 5.4),
    mkPt('bp-29', 'GYS-01', '25L Geyser — Bath', 'geyser', 'b-bath', 9.6, 6.6, { wattage: 1000 }),
    ...mkPresetDbAndEarthing('bnd', 'b-living', 0.42, 0.52),
  ];

  return {
    id: 'proj-bandra-2bhk',
    refCode: 'ASD-2026-BOM-12',
    name: 'Bandra West 2BHK Suite',
    buildingType: 'single',
    status: 'Saved',
    description: '5 rooms, 31 electrical items (29 points + DB-1 + EP-1), cove strip lighting & USB modular switches.',
    site: {
      length: 36,
      width: 28,
      ceilingHeight: 10,
      wallThickness: 0.75,
      units: 'ft',
      floors: 1,
    },
    floorConfigs: [
      { floor: 1, name: 'Ground Floor', kind: 'ground', elevationM: 0, floorHeightM: 3.05, slabThicknessM: 0.22, visible: true },
    ],
    circuitCableConfigs: defaultCircuitCableConfigs(),
    rooms,
    customWalls: [],
    openings: [
      { id: 'bo-1', kind: 'door', x: 0, y: 3.8, width: 1.0, rotation: 90 },
      { id: 'bo-2', kind: 'door', x: 5.2, y: 3.8, width: 0.9, rotation: 90 },
      { id: 'bo-3', kind: 'window', x: 2.5, y: 0, width: 2.0, rotation: 0 },
      { id: 'bo-4', kind: 'window', x: 6.8, y: 0, width: 1.6, rotation: 0 },
    ],
    furniture: [
      { id: 'bf-1', kind: 'sofa', roomId: 'b-living', x: 3.1, y: 2.4, width: 2.2, depth: 1.4, rotation: 0 },
      { id: 'bf-2', kind: 'bed', roomId: 'b-master', x: 6.8, y: 2.4, width: 1.8, depth: 2.0, rotation: 0 },
      { id: 'bf-3', kind: 'kitchen-counter', roomId: 'b-kitchen', x: 10.3, y: 2.4, width: 0.75, depth: 3.2, rotation: 0 },
      { id: 'bf-4', kind: 'bed', roomId: 'b-bed2', x: 2.4, y: 6.8, width: 1.7, depth: 1.9, rotation: 90 },
    ],
    points,
    updatedAt: '2026-11-18T14:30:00Z',
  };
}

/**
 * Jubilee Hills 4BHK Villa (55 ft x 44 ft = 16.76 m x 13.41 m)
 */
function createJubilee4BHK(): ProjectData {
  const rooms: RoomZone[] = [
    { id: 'j-living', name: 'Grand Living', type: 'living', x: 0, y: 0, width: 6.8, height: 6.6, floorFinish: 'wood' },
    { id: 'j-dining', name: 'Dining Hall', type: 'dining', x: 6.8, y: 0, width: 4.8, height: 6.6, floorFinish: 'terrazzo' },
    { id: 'j-kitchen', name: 'Modular Kitchen', type: 'kitchen', x: 11.6, y: 0, width: 5.16, height: 6.6, floorFinish: 'tile' },
    { id: 'j-master', name: 'Master Suite', type: 'master-bedroom', x: 0, y: 6.6, width: 5.6, height: 6.81, floorFinish: 'wood' },
    { id: 'j-bed2', name: 'Guest Bedroom', type: 'second-bedroom', x: 5.6, y: 6.6, width: 4.8, height: 6.81, floorFinish: 'wood' },
    { id: 'j-bath', name: 'Master Bath', type: 'bathroom', x: 10.4, y: 6.6, width: 3.2, height: 6.81, floorFinish: 'stone' },
    { id: 'j-balcony', name: 'Veranda Deck', type: 'balcony', x: 13.6, y: 6.6, width: 3.16, height: 6.81, floorFinish: 'stone' },
  ];

  const points: ElectricalPoint[] = [
    mkPt('jp-1', 'FAN-01', 'Ceiling Fan — Living W', 'ceiling_fan', 'j-living', 2.2, 3.2),
    mkPt('jp-2', 'FAN-02', 'Ceiling Fan — Living E', 'ceiling_fan', 'j-living', 4.8, 3.2),
    mkPt('jp-3', 'CHN-01', 'Brass Chandelier — Living', 'chandelier', 'j-living', 3.4, 3.2),
    mkPt('jp-4', 'PNL-01', 'LED Panel — Living NW', 'panel_light', 'j-living', 1.4, 1.4),
    mkPt('jp-5', 'PNL-02', 'LED Panel — Living NE', 'panel_light', 'j-living', 5.4, 1.4),
    mkPt('jp-6', 'PNL-03', 'LED Panel — Living SW', 'panel_light', 'j-living', 1.4, 5.2),
    mkPt('jp-7', 'PNL-04', 'LED Panel — Living SE', 'panel_light', 'j-living', 5.4, 5.2),
    mkPt('jp-8', 'STR-01', 'Cove Strip — Living', 'strip_light', 'j-living', 3.4, 0.7),
    mkPt('jp-9', 'SB-01', 'Switchboard — Living Entry', 'switchboard', 'j-living', 0.5, 5.6),
    mkPt('jp-10', 'SKT-01', '5A Socket — Home Theater', 'socket_5a', 'j-living', 0.5, 3.2),
    mkPt('jp-11', 'AC-01', 'Split AC 1.5T — Living W', 'split_ac', 'j-living', 2.2, 0.4),
    mkPt('jp-12', 'AC-02', 'Split AC 1.5T — Living E', 'split_ac', 'j-living', 4.8, 0.4),

    mkPt('jp-13', 'FAN-03', 'Ceiling Fan — Dining', 'ceiling_fan', 'j-dining', 9.2, 3.3),
    mkPt('jp-14', 'CHN-02', 'Dining Chandelier', 'chandelier', 'j-dining', 9.2, 2.0),
    mkPt('jp-15', 'PNL-05', 'LED Panel — Dining', 'panel_light', 'j-dining', 9.2, 5.0),
    mkPt('jp-16', 'SB-02', 'Switchboard — Dining', 'switchboard', 'j-dining', 7.2, 5.5),

    mkPt('jp-17', 'EXH-01', 'Exhaust Fan — Kitchen', 'exhaust_fan', 'j-kitchen', 16.2, 1.4),
    mkPt('jp-18', 'PNL-06', 'LED Panel — Kitchen N', 'panel_light', 'j-kitchen', 14.0, 2.0, { circuit: 'CKT-P1 (Kitchen)' }),
    mkPt('jp-19', 'PNL-07', 'LED Panel — Kitchen S', 'panel_light', 'j-kitchen', 14.0, 4.6, { circuit: 'CKT-P1 (Kitchen)' }),
    mkPt('jp-20', 'SB-03', 'Switchboard — Kitchen', 'switchboard', 'j-kitchen', 12.1, 5.4, { circuit: 'CKT-P1 (Kitchen)' }),
    mkPt('jp-21', 'SKT-16A', '16A Socket — Oven', 'socket_16a', 'j-kitchen', 16.0, 3.0),
    mkPt('jp-22', 'SKT-16B', '16A Socket — Dishwasher', 'socket_16a', 'j-kitchen', 16.0, 4.8),
    mkPt('jp-23', 'APP-01', 'Island Chimney Point', 'appliance', 'j-kitchen', 14.2, 0.7),

    mkPt('jp-24', 'FAN-04', 'Ceiling Fan — Master Suite', 'ceiling_fan', 'j-master', 2.8, 9.8, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('jp-25', 'PNL-08', 'LED Panel — Master N', 'panel_light', 'j-master', 2.8, 8.0, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('jp-26', 'SPT-01', 'Spotlight — Master Bed', 'spotlight', 'j-master', 2.8, 11.8, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('jp-27', 'SB-04', 'Switchboard — Master', 'switchboard', 'j-master', 5.0, 7.6, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('jp-28', 'USB-01', 'USB Outlet — Master', 'usb_outlet', 'j-master', 0.6, 9.8, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('jp-29', 'AC-03', 'Split AC 1.5T — Master', 'split_ac', 'j-master', 2.8, 12.9),

    mkPt('jp-30', 'FAN-05', 'Ceiling Fan — Guest Bed', 'ceiling_fan', 'j-bed2', 8.0, 9.8, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('jp-31', 'PNL-09', 'LED Panel — Guest Bed', 'panel_light', 'j-bed2', 8.0, 8.0, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('jp-32', 'SB-05', 'Switchboard — Guest Bed', 'switchboard', 'j-bed2', 6.1, 7.6, { circuit: 'CKT-L2 (Bedrooms)' }),
    mkPt('jp-33', 'AC-04', 'Split AC 1.5T — Guest Bed', 'split_ac', 'j-bed2', 8.0, 12.9),

    mkPt('jp-34', 'PNL-10', 'LED Panel — Master Bath', 'panel_light', 'j-bath', 12.0, 9.2),
    mkPt('jp-35', 'SB-06', 'Switchboard — Master Bath', 'switchboard', 'j-bath', 10.8, 7.3),
    mkPt('jp-36', 'GYS-01', '25L Geyser — Master Bath', 'geyser', 'j-bath', 13.0, 10.4, { wattage: 2000 }),

    mkPt('jp-37', 'SPT-02', 'Deck Spotlight — Veranda N', 'spotlight', 'j-balcony', 15.2, 8.6),
    mkPt('jp-38', 'SPT-03', 'Deck Spotlight — Veranda S', 'spotlight', 'j-balcony', 15.2, 11.4),
    ...mkPresetDbAndEarthing('jub', 'j-living', 0.5, 0.6),
  ];

  return {
    id: 'proj-jubilee-4bhk',
    refCode: 'ASD-2026-HYD-09',
    name: 'Jubilee Hills 4BHK Villa',
    buildingType: 'duplex',
    status: 'BOQ Ready',
    description: '2 floors, 7 primary zones, 40 electrical items (38 points + DB-1 + EP-1), HVAC & geyser sub-circuits.',
    site: {
      length: 55,
      width: 44,
      ceilingHeight: 11,
      wallThickness: 0.75,
      units: 'ft',
      floors: 2,
    },
    floorConfigs: [
      { floor: 1, name: 'Ground Floor', kind: 'ground', elevationM: 0, floorHeightM: 3.35, slabThicknessM: 0.22, visible: true },
      { floor: 2, name: 'First Floor', kind: 'upper', elevationM: 3.57, floorHeightM: 3.35, slabThicknessM: 0.22, visible: true },
    ],
    circuitCableConfigs: defaultCircuitCableConfigs(),
    rooms,
    customWalls: [],
    openings: [
      { id: 'jo-1', kind: 'door', x: 0, y: 5.2, width: 1.2, rotation: 90 },
      { id: 'jo-2', kind: 'window', x: 3.4, y: 0, width: 2.8, rotation: 0 },
      { id: 'jo-3', kind: 'window', x: 9.2, y: 0, width: 2.4, rotation: 0 },
      { id: 'jo-4', kind: 'window', x: 14.2, y: 0, width: 2.0, rotation: 0 },
    ],
    furniture: [
      { id: 'jf-1', kind: 'sofa', roomId: 'j-living', x: 3.6, y: 3.3, width: 2.8, depth: 1.8, rotation: 0 },
      { id: 'jf-2', kind: 'dining-table', roomId: 'j-dining', x: 9.2, y: 3.3, width: 2.0, depth: 1.3, rotation: 0 },
      { id: 'jf-3', kind: 'kitchen-counter', roomId: 'j-kitchen', x: 15.7, y: 3.3, width: 0.9, depth: 4.5, rotation: 0 },
      { id: 'jf-4', kind: 'bed', roomId: 'j-master', x: 2.8, y: 10.0, width: 2.2, depth: 2.3, rotation: 0 },
      { id: 'jf-5', kind: 'bed', roomId: 'j-bed2', x: 8.0, y: 10.0, width: 2.0, depth: 2.1, rotation: 0 },
    ],
    points,
    updatedAt: '2026-11-15T09:15:00Z',
  };
}

export const INITIAL_PROJECTS: ProjectData[] = [
  createIndiranagar3BHK(),
  createBandra2BHK(),
  createJubilee4BHK(),
];

export function formatINR(amount: number): string {
  return '₹' + Math.round(amount).toLocaleString('en-IN');
}

function ordinalFloorShort(floor: number): string {
  const n = Math.max(1, Math.round(floor || 1));
  if (n === 1) return '1st Floor';
  if (n === 2) return '2nd Floor';
  if (n === 3) return '3rd Floor';
  return `${n}th Floor`;
}

export function computeProjectMetrics(project: ProjectData): ProjectMetrics {
  const categoryCounts: Record<ElectricalCategory, number> = {
    Fans: 0,
    Lighting: 0,
    Switches: 0,
    Sockets: 0,
    Appliances: 0,
    Distribution: 0,
  };

  let totalWatts = 0;
  let totalCost = 0;
  const isMultiFloor = Math.max(1, Math.round(project.site.floors || 1)) > 1;

  const roomMap = new Map<string, RoomBreakdownRow>();
  project.rooms.forEach((r) => {
    const fl = Math.max(1, Math.round(r.floor ?? 1));
    roomMap.set(r.id, {
      roomId: r.id,
      roomName: isMultiFloor ? `${r.name} (${ordinalFloorShort(fl)})` : r.name,
      fans: 0,
      lights: 0,
      switches: 0,
      sockets: 0,
      appliances: 0,
      loadWatts: 0,
    });
  });

  const boqMap = new Map<ElectricalItemType, BoqRow>();

  project.points.forEach((pt) => {
    const effectivePtCost =
      typeof pt.manualPriceOverride === 'number' &&
      Number.isFinite(pt.manualPriceOverride) &&
      pt.manualPriceOverride >= 0
        ? pt.manualPriceOverride
        : pt.unitCost;

    categoryCounts[pt.category] = (categoryCounts[pt.category] || 0) + 1;
    totalWatts += pt.wattage;
    totalCost += effectivePtCost;

    const ptFloor = Math.max(1, Math.round(pt.floor ?? 1));
    let rRow = roomMap.get(pt.roomId);
    if (!rRow) {
      // Fallback: match geometrically to a room on the same floor
      const sameFloorRooms = project.rooms.filter(
        (r) => Math.max(1, Math.round(r.floor ?? 1)) === ptFloor
      );
      const geoMatch = findRoomAtPoint(sameFloorRooms, pt.x, pt.y);
      if (geoMatch) {
        rRow = roomMap.get(geoMatch.id);
      }
    }
    if (!rRow) {
      // Unassigned / site-level electrical library item placed outside rooms
      const openId = `open-site-f${ptFloor}`;
      rRow = roomMap.get(openId);
      if (!rRow) {
        rRow = {
          roomId: openId,
          roomName: isMultiFloor ? `Open Site (${ordinalFloorShort(ptFloor)})` : 'Open Site',
          fans: 0,
          lights: 0,
          switches: 0,
          sockets: 0,
          appliances: 0,
          loadWatts: 0,
        };
        roomMap.set(openId, rRow);
      }
    }

    if (pt.category === 'Fans') rRow.fans += 1;
    else if (pt.category === 'Lighting') rRow.lights += 1;
    else if (pt.category === 'Switches') rRow.switches += 1;
    else if (pt.category === 'Sockets') rRow.sockets += 1;
    else if (pt.category === 'Appliances') rRow.appliances += 1;
    rRow.loadWatts += pt.wattage;

    const cat = CATALOG_MAP[pt.itemType];
    const existingBoq = boqMap.get(pt.itemType);
    if (existingBoq) {
      existingBoq.quantity += 1;
      existingBoq.totalWattage += pt.wattage;
      existingBoq.estimatedCost = Number((existingBoq.estimatedCost + effectivePtCost).toFixed(2));
      existingBoq.unitPrice =
        existingBoq.quantity > 0
          ? Number((existingBoq.estimatedCost / existingBoq.quantity).toFixed(2))
          : 0;
    } else {
      const unitPrice = Number(effectivePtCost.toFixed(2));
      boqMap.set(pt.itemType, {
        id: pt.itemType,
        itemType: pt.itemType,
        productName: cat ? cat.productName : pt.name,
        category: cat ? cat.boqCategory : pt.category,
        quantity: 1,
        unitPrice,
        totalWattage: pt.wattage,
        estimatedCost: unitPrice,
      });
    }
  });

  const totalKw = Number((totalWatts / 1000).toFixed(2));
  const estimatedAmps = Number((totalWatts / 230).toFixed(1));

  const effectiveFloors =
    Array.isArray(project.floorConfigs) && project.floorConfigs.length > 0
      ? project.floorConfigs.length
      : Math.max(1, Math.round(project.site.floors || 1));

  const area = Math.round(project.site.length * project.site.width * effectiveFloors);
  const unitLabel = project.site.units === 'ft' ? 'ft' : 'm';
  const areaUnit = project.site.units === 'ft' ? 'sq.ft' : 'sq.m';
  const dimensionsDisplay = `${project.site.length} ${unitLabel} × ${project.site.width} ${unitLabel}`;
  const areaDisplay = `${area.toLocaleString('en-IN')} ${areaUnit}`;

  const { lengthM, widthM } = siteToMeters(project.site);
  const siteAreaSqM = lengthM * widthM;
  const builtUpAreaSqM = project.rooms.reduce((sum, r) => sum + r.width * r.height, 0);
  const remainingAreaSqM = Math.max(0, siteAreaSqM * effectiveFloors - builtUpAreaSqM);

  const order: Array<ElectricalItemType | 'custom'> = ELECTRICAL_CATALOG.map((c) => c.itemType);
  const boqRows = Array.from(boqMap.values()).sort(
    (a, b) => order.indexOf(a.itemType) - order.indexOf(b.itemType)
  );

  return {
    totalPoints: project.points.length,
    totalWatts,
    totalKw,
    estimatedAmps,
    totalCost,
    areaDisplay,
    dimensionsDisplay,
    builtUpAreaSqM,
    siteAreaSqM,
    remainingAreaSqM,
    categoryCounts,
    roomBreakdown: Array.from(roomMap.values()),
    boqRows,
  };
}

export function findRoomAtPoint(rooms: RoomZone[], x: number, y: number): RoomZone | undefined {
  return rooms.find(
    (r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height
  );
}
