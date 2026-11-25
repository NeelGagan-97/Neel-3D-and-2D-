import writeXlsxFile, { type Cell, type Row, type Sheet } from 'write-excel-file/universal';
import { ProjectData } from '../types/design';
import {
  BoqPriceSource,
  BUILDING_TYPE_LABELS,
  computeReconciledBoq,
  computeReconciledElectricalSchedule,
  computeWireLengthMeters,
  getFloorLabel,
  getProjectFloors,
  inferBuildingType,
  validateCableSizeForCircuit,
  WIRE_CATEGORY_LABELS,
} from './buildingWiring';
import { sanitizeCsvTextValue } from './csvSecurity';
import { formatArea, formatLength, getItemFloor } from './geometry';

export interface ExcelBoqOptions {
  /** Optional configurable wastage / procurement allowance % for cables (0 by default so raw geometry length is unambiguous) */
  cableAllowancePercent?: number;
}

export interface ExcelBoqSheetDefinition {
  name: string;
  rows: (string | number)[][];
  columnWidths: number[];
}

const PRICE_SOURCE_LABEL: Record<BoqPriceSource, string> = {
  catalogue: 'Product Catalogue',
  project: 'Project Rate',
  override: 'Manual Override',
  missing: 'Not Configured',
};

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/^_+|_+$/g, '') || 'Blue_Space_Project';
}

function toSafeExcelCell(val: string | number | null | undefined): Cell {
  if (val === null || val === undefined || val === '') {
    return null;
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return null;
    return { value: val, type: Number };
  }
  const safeText = sanitizeCsvTextValue(String(val));
  return { value: safeText, type: String };
}

function toWriteExcelSheet(def: ExcelBoqSheetDefinition): Sheet<Blob> {
  const data: Row[] = def.rows.map((row) => row.map((cell) => toSafeExcelCell(cell)));
  return {
    sheet: def.name,
    data,
    columns: def.columnWidths.map((width) => ({ width })),
  };
}

/**
 * Pure, synchronous multi-sheet BOQ structure builder (6 reconciled sheets).
 * Preserves exact sheet names, column headers, column widths, and reconciled totals.
 */
export function buildExcelBoqSheets(
  project: ProjectData,
  options: ExcelBoqOptions = {}
): ExcelBoqSheetDefinition[] {
  const reconciled = computeReconciledElectricalSchedule(project);
  const boq = computeReconciledBoq(project, options);
  const floors = getProjectFloors(project);
  const wires = project.wires ?? [];
  const units = project.site.units;

  // SHEET 1: Consolidated BOQ (100% reconciled with PDF Sheet S-01 & Project Summary)
  const sheet1Header: (string | number)[][] = [
    ['BLUE SPACE — ELECTRICAL BILL OF QUANTITIES (CONSOLIDATED BOQ)'],
    [
      `Project: ${project.name}`,
      `Ref: ${project.refCode}`,
      `Building Type: ${BUILDING_TYPE_LABELS[inferBuildingType(project)]}`,
      `Floors: ${floors.length}`,
      `Site Area: ${formatArea(reconciled.siteFootprintAreaSqM, units)}`,
      `Building Footprint: ${formatArea(reconciled.buildingFootprintAreaSqM, units)}`,
      `Total Built-Up Area: ${formatArea(reconciled.totalBuiltUpAreaSqM, units)}`,
      `Electrical Items: ${reconciled.totalElectricalItems} (${reconciled.branchLoadPointsCount} Branch + ${reconciled.distributionEquipmentCount} DB/EP)`,
      `Connected Load: ${reconciled.totalConnectedLoadWatts} W (${reconciled.totalConnectedLoadKw} kW)`,
      `Routed Cables: ${reconciled.totalWireLengthM.toFixed(2)} m (${reconciled.totalWires} runs)`,
      `Generated: ${new Date().toLocaleDateString('en-IN')}`,
    ],
    [],
    [
      'Product Category',
      'Manufacturer',
      'Brand',
      'Product Name',
      'Model',
      'Specification',
      'Circuit(s)',
      'Rated Load (W)',
      'Total Load (W)',
      'Cable Size',
      'Unit',
      'Quantity',
      'Unit Price (INR)',
      'Price Source',
      'GST %',
      'GST Amount (INR)',
      'Total (INR)',
      'Notes / Override',
    ],
  ];

  const sheet1Rows: (string | number)[][] = boq.rows.map((r) => [
    r.productCategory,
    r.manufacturer,
    r.brand,
    r.productName,
    r.model,
    r.specification,
    r.circuits,
    r.ratedLoadW,
    r.totalLoadW,
    r.cableSize,
    r.unit,
    r.quantity,
    r.unitPrice !== null ? r.unitPrice : 'Not configured',
    PRICE_SOURCE_LABEL[r.priceSource],
    r.gstPercent !== null ? r.gstPercent : 'Not configured',
    r.gstAmount !== null ? r.gstAmount : '—',
    r.total !== null ? r.total : 'Pending rate',
    r.notes,
  ]);

  const sheet1Footer: (string | number)[][] = [
    [],
    [
      'CONFIGURED SUBTOTAL (EXCL. GST)',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      boq.totalLoadWatts,
      '',
      '',
      boq.totalComponentQty,
      '',
      '',
      '',
      '',
      boq.subtotalConfigured,
      boq.unpricedRowCount > 0
        ? `${boq.unpricedRowCount} line item(s) have unconfigured unit rates (never invented)`
        : 'All line items priced',
    ],
    [
      'CONFIGURED GST TOTAL',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      boq.totalGstConfigured,
      boq.totalGstConfigured,
      'GST calculated strictly where GST % is configured',
    ],
    [
      'GRAND TOTAL (CONFIGURED ITEMS)',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      boq.totalLoadWatts,
      '',
      '',
      '',
      '',
      '',
      '',
      boq.totalGstConfigured,
      boq.grandTotalConfigured,
      boq.allowancePercent > 0
        ? `Includes ${boq.allowancePercent}% estimated cable procurement allowance`
        : 'Exact routed cable lengths (0% extra allowance)',
    ],
  ];

  const sheet1: ExcelBoqSheetDefinition = {
    name: 'Consolidated BOQ',
    rows: [...sheet1Header, ...sheet1Rows, ...sheet1Footer],
    columnWidths: [22, 18, 16, 32, 18, 36, 22, 13, 13, 14, 8, 10, 16, 16, 12, 16, 16, 40],
  };

  // SHEET 2: Category Subtotals (100% reconciled with Consolidated BOQ)
  const sheet2: ExcelBoqSheetDefinition = {
    name: 'Category Subtotals',
    rows: [
      ['CATEGORY SUBTOTALS (RECONCILED WITH CONSOLIDATED BOQ)'],
      [
        'Product Category',
        'Line Items',
        'Total Quantity',
        'Unit',
        'Total Load (W)',
        'Subtotal (INR)',
        'GST Amount (INR)',
        'Total (INR)',
        'Unpriced Lines',
      ],
      ...boq.categorySubtotals.map((v) => [
        v.category,
        v.itemLines,
        v.totalQty,
        v.unit,
        v.totalLoadW,
        v.subtotal,
        v.gstAmount,
        v.total,
        v.unpricedLines,
      ]),
      [
        'RECONCILED TOTAL',
        boq.rows.length,
        '',
        '',
        boq.totalLoadWatts,
        boq.subtotalConfigured,
        boq.totalGstConfigured,
        boq.grandTotalConfigured,
        boq.unpricedRowCount,
      ],
    ],
    columnWidths: [24, 12, 14, 10, 14, 16, 16, 16, 14],
  };

  // SHEET 3: Floor-Wise BOQ (Independent per-floor components, routed cables, GST & explicit Floor Subtotals)
  const floorSheetRows: (string | number)[][] = [
    ['FLOOR-WISE ELECTRICAL BOQ (COMPONENTS, ROUTED CABLES & FLOOR SUBTOTALS)'],
    [
      'Floor',
      'Elevation (m)',
      'Product Category',
      'Manufacturer',
      'Product Name',
      'Model',
      'Circuit(s)',
      'Cable Size',
      'Unit',
      'Quantity',
      'Total Load (W)',
      'Unit Price (INR)',
      'Price Source',
      'GST %',
      'GST Amount (INR)',
      'Total (INR)',
    ],
  ];

  const allFloorBoqs = boq.orphanedFloorBoq
    ? [...boq.floorBoqs, boq.orphanedFloorBoq]
    : boq.floorBoqs;

  let floorWiseSubSum = 0;
  let floorWiseGstSum = 0;
  let floorWiseGrandSum = 0;
  let floorWiseCompQty = 0;
  let floorWiseLoadSum = 0;

  allFloorBoqs.forEach((fb) => {
    fb.rows.forEach((r) => {
      floorSheetRows.push([
        fb.floorName,
        fb.isOrphaned ? 'N/A' : fb.elevationM,
        r.productCategory,
        r.manufacturer,
        r.productName,
        r.model,
        r.circuits,
        r.cableSize,
        r.unit,
        r.quantity,
        r.totalLoadW,
        r.unitPrice !== null ? r.unitPrice : 'Not configured',
        PRICE_SOURCE_LABEL[r.priceSource],
        r.gstPercent !== null ? r.gstPercent : 'Not configured',
        r.gstAmount !== null ? r.gstAmount : '—',
        r.total !== null ? r.total : 'Pending rate',
      ]);
    });

    floorWiseSubSum += fb.subtotalConfigured;
    floorWiseGstSum += fb.gstConfigured;
    floorWiseGrandSum += fb.grandTotalConfigured;
    floorWiseCompQty += fb.componentQty;
    floorWiseLoadSum += fb.loadWatts;

    floorSheetRows.push([
      `SUBTOTAL — ${fb.floorName}`,
      fb.isOrphaned ? 'N/A' : fb.elevationM,
      `${fb.componentQty} Items | ${fb.cableLengthM.toFixed(2)} m Cables`,
      '',
      fb.unpricedRowCount > 0 ? `${fb.unpricedRowCount} line(s) pending rate` : 'All floor lines priced',
      '',
      '',
      '',
      '—',
      fb.componentQty,
      fb.loadWatts,
      fb.subtotalConfigured,
      'Excl. GST',
      '',
      fb.gstConfigured,
      fb.grandTotalConfigured,
    ]);
    floorSheetRows.push([]);
  });

  floorSheetRows.push([
    'CONSOLIDATED FLOOR-WISE TOTAL',
    `${boq.floorBoqs.length} Floor(s)`,
    `${floorWiseCompQty} Items | ${boq.totalCableLengthM.toFixed(2)} m Cables`,
    '',
    'Reconciles with Sheet 1 (excl. manual summary rows if any)',
    '',
    '',
    '',
    '—',
    floorWiseCompQty,
    floorWiseLoadSum,
    Number(floorWiseSubSum.toFixed(2)),
    'Excl. GST',
    '',
    Number(floorWiseGstSum.toFixed(2)),
    Number(floorWiseGrandSum.toFixed(2)),
  ]);

  const sheet3: ExcelBoqSheetDefinition = {
    name: 'Floor-Wise BOQ',
    rows: floorSheetRows,
    columnWidths: [24, 13, 24, 18, 32, 18, 20, 14, 8, 10, 14, 16, 16, 12, 16, 16],
  };

  // SHEET 4: Cable & Wiring Schedule
  const pointById = new Map(project.points.map((p) => [p.id, p]));
  const cableScheduleRows: (string | number)[][] = [
    ['CABLE & WIRING SCHEDULE (CALCULATED FROM ROUTED GEOMETRY)'],
    [
      'Wire Code',
      'From Component',
      'From Floor',
      'To Component',
      'To Floor',
      'Inter-Floor Riser',
      'Category',
      'Circuit',
      'Cable Size (sq.mm)',
      'Material',
      'Cores',
      'Manufacturer / Model',
      'Routed Length (m)',
      'Rate / m (INR)',
      'GST %',
      'Validation Status',
    ],
  ];

  wires.forEach((w) => {
    const fromPt = pointById.get(w.fromPointId);
    const toPt = pointById.get(w.toPointId);
    const lenM = computeWireLengthMeters(w, project);
    const sizeCheck = validateCableSizeForCircuit(w.circuit, w.cableSizeSqMm);
    const cktCfg = w.circuit ? project.circuitCableConfigs?.[w.circuit] : undefined;
    const effectiveRate =
      typeof w.unitPricePerM === 'number' && Number.isFinite(w.unitPricePerM) && w.unitPricePerM > 0
        ? w.unitPricePerM
        : typeof cktCfg?.unitPricePerM === 'number' &&
            Number.isFinite(cktCfg.unitPricePerM) &&
            cktCfg.unitPricePerM > 0
          ? cktCfg.unitPricePerM
          : null;
    const effectiveGst =
      typeof w.gstPercent === 'number' && Number.isFinite(w.gstPercent) && w.gstPercent >= 0
        ? w.gstPercent
        : typeof cktCfg?.gstPercent === 'number' &&
            Number.isFinite(cktCfg.gstPercent) &&
            cktCfg.gstPercent >= 0
          ? cktCfg.gstPercent
          : null;
    const mfr = w.manufacturer || cktCfg?.manufacturer;
    const mdl = w.modelNumber || cktCfg?.modelNumber;

    cableScheduleRows.push([
      w.code,
      fromPt ? `${fromPt.code} (${fromPt.name})` : w.fromPointId,
      getFloorLabel(project, w.fromFloor),
      toPt ? `${toPt.code} (${toPt.name})` : w.toPointId,
      getFloorLabel(project, w.toFloor),
      w.isInterFloor ? 'Yes' : 'No',
      WIRE_CATEGORY_LABELS[w.category],
      w.circuit || 'Unassigned',
      w.cableSizeSqMm !== null ? w.cableSizeSqMm : 'Not specified',
      w.cableMaterial,
      w.cores,
      mfr ? `${mfr} ${mdl ?? ''}`.trim() : 'Not linked',
      lenM,
      effectiveRate !== null ? effectiveRate : 'Not configured',
      effectiveGst !== null ? effectiveGst : 'Not configured',
      sizeCheck.status === 'ok' ? 'Within configured range' : sizeCheck.warning || 'Check sizing',
    ]);
  });

  if (wires.length === 0) {
    cableScheduleRows.push([
      'No routed wires placed yet (0.00 m) — use Route Cable Tool or Auto-Route DB in Design Studio.',
    ]);
  }

  const sheet4: ExcelBoqSheetDefinition = {
    name: 'Cable & Wiring Schedule',
    rows: cableScheduleRows,
    columnWidths: [12, 24, 14, 24, 14, 16, 18, 20, 18, 12, 8, 24, 16, 15, 10, 42],
  };

  // SHEET 5: Reconciled Area, Circuit, Distribution Board & Earthing Schedule
  const circuitSheetRows: (string | number)[][] = [
    ['RECONCILED FLOOR AREAS, CIRCUIT, DISTRIBUTION BOARD & EARTHING SCHEDULE'],
    [
      `Site Area: ${formatArea(reconciled.siteFootprintAreaSqM, units)} (${formatLength(reconciled.siteLengthM, units, 1)} × ${formatLength(reconciled.siteWidthM, units, 1)})`,
      `Building Footprint: ${formatArea(reconciled.buildingFootprintAreaSqM, units)}`,
      `Total Floor Footprint: ${formatArea(reconciled.totalFloorFootprintAreaSqM, units)}`,
      `Total Built-Up Room Area: ${formatArea(reconciled.totalBuiltUpAreaSqM, units)}`,
      `Excluded / Open Area: ${formatArea(reconciled.totalExcludedOpenAreaSqM, units)}`,
    ],
    [
      `Total Electrical Items: ${reconciled.totalElectricalItems}`,
      `Branch Points: ${reconciled.branchLoadPointsCount}`,
      `DB / Earthing Units: ${reconciled.distributionEquipmentCount}`,
      `Connected Load: ${reconciled.totalConnectedLoadWatts} W (${reconciled.totalConnectedLoadKw} kW / ${reconciled.estimatedCurrentAmps} A)`,
      `Total Routed Cable Length: ${reconciled.totalWireLengthM.toFixed(2)} m`,
    ],
    [],
    ['FLOOR-WISE AREA & ELECTRICAL RECONCILIATION'],
    [
      'Floor',
      'Elevation (m)',
      'Floor Boundary',
      'Floor Footprint',
      'Rooms',
      'Built-Up Room Area',
      'Open / Void Area',
      'Electrical Items',
      'Routed Cables (m)',
      'Connected Load (W)',
    ],
    ...(reconciled.orphanedFloorRow
      ? [...reconciled.floorRows, reconciled.orphanedFloorRow]
      : reconciled.floorRows
    ).map((fr) => [
      fr.name,
      fr.isOrphaned ? 'N/A' : fr.elevationM,
      fr.isOrphaned
        ? 'N/A'
        : `${formatLength(fr.floorLengthM, units, 1)} × ${formatLength(fr.floorWidthM, units, 1)}${fr.isCustomBoundary ? ' (Custom)' : ''}`,
      fr.isOrphaned ? 'N/A' : formatArea(fr.floorFootprintAreaSqM, units),
      fr.roomCount,
      formatArea(fr.builtUpAreaSqM, units),
      fr.isOrphaned ? 'N/A' : formatArea(fr.excludedOpenAreaSqM, units),
      fr.pointCount,
      fr.routedLengthM,
      fr.loadWatts,
    ]),
    [],
    [
      'Circuit / Equipment Group',
      'Type',
      'Item Count',
      'Connected Load (W)',
      'Load (kW)',
      'Est. Current (A)',
      'Configured Cable (sq.mm)',
      'Material',
      'Design Range',
      'Routed Runs',
      'Routed Length (m)',
      'Status',
    ],
    ...reconciled.circuitRows.map((row) => [
      row.circuit,
      row.kind.toUpperCase(),
      row.pointCount,
      row.loadWatts,
      row.loadKw,
      row.currentAmps,
      row.cableSizeSqMm !== null ? row.cableSizeSqMm : 'Unset',
      row.cableMaterial,
      row.rangeLabel,
      row.routedWireCount,
      row.routedLengthM,
      row.statusNote,
    ]),
    [
      'RECONCILED TOTAL',
      'ALL',
      reconciled.circuitRows.reduce((s, r) => s + r.pointCount, 0),
      reconciled.circuitRows.reduce((s, r) => s + r.loadWatts, 0),
      reconciled.totalConnectedLoadKw,
      reconciled.estimatedCurrentAmps,
      '—',
      '—',
      '—',
      reconciled.totalWires,
      reconciled.totalWireLengthM,
      reconciled.errorCount === 0 ? 'Reconciled' : `${reconciled.errorCount} Error(s)`,
    ],
    [],
    ['DISTRIBUTION BOARDS (DB)'],
    ['Code', 'Name', 'Floor', 'Coordinates (m)', 'Phase', 'Incomer (A)', 'Ways', 'RCCB (mA)', 'Enclosure'],
    ...(reconciled.dbPoints.length > 0
      ? reconciled.dbPoints.map((db) => [
          db.code,
          db.name,
          getFloorLabel(project, getItemFloor(db)),
          `${db.x.toFixed(2)}, ${db.y.toFixed(2)} (Z=${db.z.toFixed(2)})`,
          db.dbConfig?.phaseType ?? 'Single Phase (1Φ)',
          db.dbConfig?.incomingRatingAmps ?? 63,
          db.dbConfig?.waysCount ?? 12,
          db.dbConfig?.rccbSensitivityMa ?? 30,
          db.dbConfig?.enclosureType ?? 'Flush Metal DB',
        ])
      : [['MISSING', 'No Main Distribution Board placed in project', '', '', '', '', '', '', '']]),
    [],
    ['EARTHING POINTS (PE)'],
    ['Code', 'Name', 'Floor', 'Coordinates (m)', 'Earthing Type', 'Target Resistance (Ohm)', 'Earth Conductor (sq.mm)', 'Notes'],
    ...(reconciled.earthingPoints.length > 0
      ? reconciled.earthingPoints.map((ep) => [
          ep.code,
          ep.name,
          getFloorLabel(project, getItemFloor(ep)),
          `${ep.x.toFixed(2)}, ${ep.y.toFixed(2)} (Z=${ep.z.toFixed(2)})`,
          ep.earthingConfig?.earthingType ?? 'Copper Plate',
          ep.earthingConfig?.targetResistanceOhm ?? 2.0,
          ep.earthingConfig?.earthConductorSizeSqMm ?? 4.0,
          ep.earthingConfig?.notes ?? '',
        ])
      : [['MISSING', 'No Main Earthing Point placed in project', '', '', '', '', '', '']]),
  ];

  const sheet5: ExcelBoqSheetDefinition = {
    name: 'Circuit & DB Schedule',
    rows: circuitSheetRows,
    columnWidths: [28, 14, 22, 16, 12, 18, 20, 14, 16, 14, 16, 16],
  };

  // SHEET 6: Engineering Validation Diagnostics
  const sheet6: ExcelBoqSheetDefinition = {
    name: 'Diagnostics',
    rows: [
      ['ENGINEERING VALIDATION & DIAGNOSTICS'],
      [
        `Errors: ${reconciled.errorCount}`,
        `Warnings: ${reconciled.warningCount}`,
        `Info: ${reconciled.infoCount}`,
        `Total Checks Logged: ${reconciled.issues.length}`,
      ],
      [],
      ['Severity', 'Domain', 'Floor', 'Diagnostic Message'],
      ...reconciled.issues.map((iss) => [
        iss.severity.toUpperCase(),
        iss.domain.toUpperCase(),
        iss.floor !== undefined ? getFloorLabel(project, iss.floor) : 'Project-Wide',
        iss.message,
      ]),
    ],
    columnWidths: [12, 14, 18, 84],
  };

  return [sheet1, sheet2, sheet3, sheet4, sheet5, sheet6];
}

export async function buildExcelBoqBlob(
  project: ProjectData,
  options: ExcelBoqOptions = {}
): Promise<Blob> {
  const sheetDefs = buildExcelBoqSheets(project, options);
  const sheets = sheetDefs.map(toWriteExcelSheet);
  return writeXlsxFile(sheets).toBlob();
}

export async function downloadExcelBoq(
  project: ProjectData,
  options: ExcelBoqOptions = {}
): Promise<void> {
  const blob = await buildExcelBoqBlob(project, options);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeFileName(project.name)}_BOQ.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
