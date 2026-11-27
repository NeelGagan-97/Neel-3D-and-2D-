import React, { useEffect, useMemo, useState } from 'react';
import {
  computeProjectMetrics,
  ELECTRICAL_CATALOG,
  formatINR,
  ROOM_LIBRARY,
} from '../data/presets';
import {
  hydrateCentralCatalogue,
  loadCatalogueProducts,
  resolveProductWithVariant,
  subscribeCentralCatalogue,
} from '../services/productCatalogueStorage';
import { ProductCatalogueItem } from '../types/catalogue';
import {
  BoqRow,
  BoqRowOverride,
  ElectricalItemType,
  ProjectData,
  ProjectSummaryOverrides,
  RoomBreakdownRow,
  RoomRowOverride,
  ScreenId,
  WireCategory,
} from '../types/design';
import {
  computeBuildingElectricalSummary,
  computeReconciledBoq,
  computeWireConsumptionSummary,
  DEFAULT_INSTALLATION_ALLOWANCE_PCT,
  getFloorLabel,
  WIRE_CATEGORY_LABELS,
} from '../utils/buildingWiring';
import { formatSafeCsvRow } from '../utils/csvSecurity';
import { downloadExcelBoq } from '../utils/excelBoqExporter';
import { downloadFloorPlanPdf } from '../utils/exporters';
import { FloorPlan2D } from './FloorPlan2D';
import { Navbar } from './Navbar';
import { PdfExportModal } from './PdfExportModal';
import { Viewport3D } from './Viewport3D';

interface ProjectSummaryPageProps {
  project: ProjectData;
  onNavigate: (screen: ScreenId) => void;
  onSaveProject: () => void;
  onUpdateProject: (updater: (prev: ProjectData) => ProjectData, recordHistory?: boolean) => void;
}

interface MergedRoomRow extends RoomBreakdownRow {
  isCustom?: boolean;
  live?: RoomBreakdownRow;
}

interface MergedBoqRow extends BoqRow {
  key: string;
  unitPrice: number;
  isCustom?: boolean;
  live?: BoqRow;
}

export const ProjectSummaryPage: React.FC<ProjectSummaryPageProps> = ({
  project,
  onNavigate,
  onSaveProject,
  onUpdateProject,
}) => {
  const metrics = useMemo(() => computeProjectMetrics(project), [project]);
  const buildingSummary = useMemo(
    () => computeBuildingElectricalSummary(project),
    [project]
  );
  const reconciledBoq = useMemo(() => computeReconciledBoq(project), [project]);
  const [wireAllowancePct, setWireAllowancePct] = useState<number>(
    DEFAULT_INSTALLATION_ALLOWANCE_PCT
  );
  const wireConsumption = useMemo(
    () =>
      computeWireConsumptionSummary(project, {
        procurementAllowancePct: wireAllowancePct,
      }),
    [project, wireAllowancePct]
  );
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [showQuoteModal, setShowQuoteModal] = useState(false);
  const [quoteSubmitted, setQuoteSubmitted] = useState(false);
  const [clientName, setClientName] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [clientCity, setClientCity] = useState('Bengaluru');
  const [centralCatalogueProducts, setCentralCatalogueProducts] = useState<ProductCatalogueItem[]>(
    () => loadCatalogueProducts()
  );
  const [boqCatalogueOpen, setBoqCatalogueOpen] = useState(false);
  const [boqCatalogueQuery, setBoqCatalogueQuery] = useState('');
  const [boqVariantByProduct, setBoqVariantByProduct] = useState<Record<string, string>>({});

  useEffect(() => {
    const unsub = subscribeCentralCatalogue(() => {
      setCentralCatalogueProducts(loadCatalogueProducts());
    });
    hydrateCentralCatalogue().then((res) => {
      setCentralCatalogueProducts(res.products);
    });
    return unsub;
  }, []);

  const filteredBoqCatalogueProducts = useMemo(() => {
    const q = boqCatalogueQuery.trim().toLowerCase();
    if (!q) return centralCatalogueProducts.slice(0, 18);
    return centralCatalogueProducts
      .filter(
        (p) =>
          p.productName.toLowerCase().includes(q) ||
          p.manufacturer.toLowerCase().includes(q) ||
          p.brand.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q) ||
          (p.subcategory || '').toLowerCase().includes(q) ||
          p.modelNumber.toLowerCase().includes(q) ||
          p.specification.toLowerCase().includes(q)
      )
      .slice(0, 24);
  }, [centralCatalogueProducts, boqCatalogueQuery]);

  const overrides: ProjectSummaryOverrides = project.summaryOverrides ?? {};

  // Live-reconciled Room-Wise Electrical Breakdown: always reflects 2D/3D Room & Electrical Libraries + user edits/deletions
  const roomRows: MergedRoomRow[] = useMemo(() => {
    const deleted = new Set(overrides.deletedRoomIds ?? []);
    const edits = overrides.roomEdits ?? {};
    const liveMerged: MergedRoomRow[] = metrics.roomBreakdown
      .filter((r) => !deleted.has(r.roomId))
      .map((live) => {
        const ed = edits[live.roomId];
        return {
          roomId: live.roomId,
          roomName: ed?.roomName ?? live.roomName,
          fans: Math.max(0, live.fans + (ed?.fansDelta ?? 0)),
          lights: Math.max(0, live.lights + (ed?.lightsDelta ?? 0)),
          switches: Math.max(0, live.switches + (ed?.switchesDelta ?? 0)),
          sockets: Math.max(0, live.sockets + (ed?.socketsDelta ?? 0)),
          appliances: Math.max(0, live.appliances + (ed?.appliancesDelta ?? 0)),
          loadWatts: Math.max(0, live.loadWatts + (ed?.loadWattsDelta ?? 0)),
          live,
        };
      });
    const added: MergedRoomRow[] = (overrides.addedRooms ?? []).map((r) => ({
      ...r,
      isCustom: true,
    }));
    return [...liveMerged, ...added];
  }, [metrics.roomBreakdown, overrides.deletedRoomIds, overrides.roomEdits, overrides.addedRooms]);

  // Live-reconciled Bill of Quantities (BOQ): always reflects 2D/3D Electrical Library items + user edits/deletions
  const boqRows: MergedBoqRow[] = useMemo(() => {
    const deleted = new Set(overrides.deletedBoqKeys ?? []);
    const edits = overrides.boqEdits ?? {};
    const liveMerged: MergedBoqRow[] = metrics.boqRows
      .filter((b) => !deleted.has(b.id ?? b.itemType))
      .map((live) => {
        const key = live.id ?? live.itemType;
        const ed = edits[key];
        const quantity = Math.max(0, live.quantity + (ed?.quantityDelta ?? 0));
        const liveUnitPrice =
          typeof live.unitPrice === 'number' && Number.isFinite(live.unitPrice)
            ? live.unitPrice
            : live.quantity > 0
              ? Number((live.estimatedCost / live.quantity).toFixed(2))
              : 0;
        const unitPrice =
          ed?.unitPrice !== undefined && Number.isFinite(ed.unitPrice)
            ? Math.max(0, Number(ed.unitPrice.toFixed(2)))
            : ed?.costDelta !== undefined
              ? quantity > 0
                ? Number((Math.max(0, live.estimatedCost + ed.costDelta) / quantity).toFixed(2))
                : liveUnitPrice
              : liveUnitPrice;
        const estimatedCost = Number((quantity * unitPrice).toFixed(2));
        return {
          ...live,
          id: key,
          key,
          productName: ed?.productName ?? live.productName,
          category: ed?.category ?? live.category,
          quantity,
          unitPrice,
          totalWattage: Math.max(0, live.totalWattage + (ed?.wattageDelta ?? 0)),
          estimatedCost,
          live,
        };
      });
    const added: MergedBoqRow[] = (overrides.addedBoqRows ?? []).map((b, idx) => {
      const quantity = Math.max(0, Number(b.quantity) || 0);
      const unitPrice =
        typeof b.unitPrice === 'number' && Number.isFinite(b.unitPrice)
          ? Math.max(0, Number(b.unitPrice.toFixed(2)))
          : quantity > 0
            ? Number((Math.max(0, Number(b.estimatedCost) || 0) / quantity).toFixed(2))
            : 0;
      const estimatedCost = Number((quantity * unitPrice).toFixed(2));
      return {
        ...b,
        id: b.id ?? `custom-boq-${idx}`,
        key: b.id ?? `custom-boq-${idx}`,
        quantity,
        unitPrice,
        estimatedCost,
        isCustom: true,
      };
    });
    return [...liveMerged, ...added];
  }, [metrics.boqRows, overrides.deletedBoqKeys, overrides.boqEdits, overrides.addedBoqRows]);

  const isRoomCustomized = Boolean(
    (overrides.deletedRoomIds && overrides.deletedRoomIds.length > 0) ||
      (overrides.addedRooms && overrides.addedRooms.length > 0) ||
      (overrides.roomEdits && Object.keys(overrides.roomEdits).length > 0)
  );

  const isBoqCustomized = Boolean(
    (overrides.deletedBoqKeys && overrides.deletedBoqKeys.length > 0) ||
      (overrides.addedBoqRows && overrides.addedBoqRows.length > 0) ||
      (overrides.boqEdits && Object.keys(overrides.boqEdits).length > 0)
  );

  // Live aggregated totals reflecting both 2D/3D libraries and any user table edits/deletions
  const roomTotals = useMemo(
    () =>
      roomRows.reduce(
        (acc, r) => ({
          fans: acc.fans + (Number(r.fans) || 0),
          lights: acc.lights + (Number(r.lights) || 0),
          switches: acc.switches + (Number(r.switches) || 0),
          sockets: acc.sockets + (Number(r.sockets) || 0),
          appliances: acc.appliances + (Number(r.appliances) || 0),
          loadWatts: acc.loadWatts + (Number(r.loadWatts) || 0),
        }),
        { fans: 0, lights: 0, switches: 0, sockets: 0, appliances: 0, loadWatts: 0 }
      ),
    [roomRows]
  );

  const boqTotals = useMemo(() => {
    const totalPoints = boqRows.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
    const totalWatts = boqRows.reduce((s, r) => s + (Number(r.totalWattage) || 0), 0);
    const totalCost = boqRows.reduce((s, r) => s + (Number(r.estimatedCost) || 0), 0);
    const totalKw = Number((totalWatts / 1000).toFixed(2));
    const estimatedAmps = Number((totalWatts / 230).toFixed(1));
    return { totalPoints, totalWatts, totalCost, totalKw, estimatedAmps };
  }, [boqRows]);

  const effectiveTotalPoints = boqTotals.totalPoints;
  const effectiveTotalWatts = boqTotals.totalWatts;
  const effectiveTotalKw = boqTotals.totalKw;
  const effectiveEstimatedAmps = boqTotals.estimatedAmps;
  const effectiveTotalCost = boqTotals.totalCost;

  const effectiveCategoryCounts = {
    Fans: roomTotals.fans,
    Lighting: roomTotals.lights,
    Switches: roomTotals.switches,
    Sockets: roomTotals.sockets,
    Appliances: roomTotals.appliances,
  };

  const uniqueBoqCategories = useMemo(
    () => Array.from(new Set(ELECTRICAL_CATALOG.map((c) => c.boqCategory))),
    []
  );

  const notify = (msg: string) => {
    setFeedback(msg);
    window.setTimeout(() => setFeedback(null), 3500);
  };

  // --- Room-Wise Electrical Breakdown Row Handlers (live delta-synced with 2D/3D) ---
  const handleUpdateRoomRow = (
    row: MergedRoomRow,
    field: keyof RoomBreakdownRow,
    value: string | number
  ) => {
    const safeNum = Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
    onUpdateProject(
      (prev) => {
        const cur: ProjectSummaryOverrides = prev.summaryOverrides ?? {};
        if (row.isCustom) {
          return {
            ...prev,
            summaryOverrides: {
              ...cur,
              addedRooms: (cur.addedRooms ?? []).map((r) =>
                r.roomId === row.roomId
                  ? { ...r, [field]: field === 'roomName' ? String(value) : safeNum }
                  : r
              ),
            },
          };
        }
        const live = row.live;
        if (!live) return prev;
        const prevEdit: RoomRowOverride = cur.roomEdits?.[row.roomId] ?? {};
        const nextEdit: RoomRowOverride = { ...prevEdit };
        if (field === 'roomName') {
          nextEdit.roomName = String(value);
        } else if (field === 'fans') {
          nextEdit.fansDelta = safeNum - live.fans;
        } else if (field === 'lights') {
          nextEdit.lightsDelta = safeNum - live.lights;
        } else if (field === 'switches') {
          nextEdit.switchesDelta = safeNum - live.switches;
        } else if (field === 'sockets') {
          nextEdit.socketsDelta = safeNum - live.sockets;
        } else if (field === 'appliances') {
          nextEdit.appliancesDelta = safeNum - live.appliances;
        } else if (field === 'loadWatts') {
          nextEdit.loadWattsDelta = safeNum - live.loadWatts;
        }
        return {
          ...prev,
          summaryOverrides: {
            ...cur,
            roomEdits: { ...(cur.roomEdits ?? {}), [row.roomId]: nextEdit },
          },
        };
      },
      false
    );
  };

  const handleDeleteRoomRow = (row: MergedRoomRow) => {
    onUpdateProject(
      (prev) => {
        const cur: ProjectSummaryOverrides = prev.summaryOverrides ?? {};
        if (row.isCustom) {
          return {
            ...prev,
            summaryOverrides: {
              ...cur,
              addedRooms: (cur.addedRooms ?? []).filter((r) => r.roomId !== row.roomId),
            },
          };
        }
        const nextDeleted = Array.from(new Set([...(cur.deletedRoomIds ?? []), row.roomId]));
        return {
          ...prev,
          summaryOverrides: {
            ...cur,
            deletedRoomIds: nextDeleted,
          },
        };
      },
      true
    );
    notify(`Removed "${row.roomName}" from Room-Wise Electrical Breakdown.`);
  };

  const handleAddRoomRow = (presetName?: string) => {
    const label = presetName || `Room ${roomRows.length + 1}`;
    onUpdateProject(
      (prev) => {
        const cur: ProjectSummaryOverrides = prev.summaryOverrides ?? {};
        const newRow: RoomBreakdownRow = {
          roomId: `custom-room-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          roomName: label,
          fans: 0,
          lights: 0,
          switches: 0,
          sockets: 0,
          appliances: 0,
          loadWatts: 0,
        };
        return {
          ...prev,
          summaryOverrides: {
            ...cur,
            addedRooms: [...(cur.addedRooms ?? []), newRow],
          },
        };
      },
      true
    );
    notify(`Added "${label}" to Room-Wise Electrical Breakdown.`);
  };

  const handleResetRoomRows = () => {
    onUpdateProject((prev) => {
      const cur: ProjectSummaryOverrides = prev.summaryOverrides ?? {};
      const { roomEdits: _e, deletedRoomIds: _d, addedRooms: _a, ...restOv } = cur;
      return {
        ...prev,
        summaryOverrides: restOv,
      };
    }, true);
    notify('Synced Room-Wise Electrical Breakdown directly from 2D/3D libraries.');
  };

  // --- Bill of Quantities (BOQ) Row Handlers (live delta-synced with 2D/3D) ---
  const handleUpdateBoqRow = (
    row: MergedBoqRow,
    field: 'productName' | 'category' | 'quantity' | 'unitPrice' | 'totalWattage',
    value: string | number
  ) => {
    const safeNum = Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
    onUpdateProject(
      (prev) => {
        const cur: ProjectSummaryOverrides = prev.summaryOverrides ?? {};
        if (row.isCustom) {
          return {
            ...prev,
            summaryOverrides: {
              ...cur,
              addedBoqRows: (cur.addedBoqRows ?? []).map((b) => {
                if ((b.id ?? b.itemType) !== row.key) return b;
                if (field === 'productName' || field === 'category') {
                  return { ...b, [field]: String(value) };
                }
                if (field === 'quantity') {
                  const nextQty = safeNum;
                  const unitPrice = row.unitPrice;
                  return {
                    ...b,
                    quantity: nextQty,
                    unitPrice,
                    estimatedCost: Number((nextQty * unitPrice).toFixed(2)),
                  };
                }
                if (field === 'unitPrice') {
                  const nextUnitPrice = Number(safeNum.toFixed(2));
                  return {
                    ...b,
                    unitPrice: nextUnitPrice,
                    estimatedCost: Number((row.quantity * nextUnitPrice).toFixed(2)),
                  };
                }
                return { ...b, totalWattage: safeNum };
              }),
            },
          };
        }
        const live = row.live;
        if (!live) return prev;
        const prevEdit: BoqRowOverride = cur.boqEdits?.[row.key] ?? {};
        const nextEdit: BoqRowOverride = { ...prevEdit };
        if (field === 'productName') {
          nextEdit.productName = String(value);
        } else if (field === 'category') {
          nextEdit.category = String(value);
        } else if (field === 'quantity') {
          nextEdit.quantityDelta = safeNum - live.quantity;
          if (nextEdit.costDelta !== undefined && nextEdit.unitPrice === undefined) {
            nextEdit.unitPrice = row.unitPrice;
            delete nextEdit.costDelta;
          }
        } else if (field === 'unitPrice') {
          nextEdit.unitPrice = Number(safeNum.toFixed(2));
          delete nextEdit.costDelta;
        } else if (field === 'totalWattage') {
          nextEdit.wattageDelta = safeNum - live.totalWattage;
        }
        return {
          ...prev,
          summaryOverrides: {
            ...cur,
            boqEdits: { ...(cur.boqEdits ?? {}), [row.key]: nextEdit },
          },
        };
      },
      false
    );
  };

  const handleDeleteBoqRow = (row: MergedBoqRow) => {
    onUpdateProject(
      (prev) => {
        const cur: ProjectSummaryOverrides = prev.summaryOverrides ?? {};
        if (row.isCustom) {
          return {
            ...prev,
            summaryOverrides: {
              ...cur,
              addedBoqRows: (cur.addedBoqRows ?? []).filter((b) => (b.id ?? b.itemType) !== row.key),
            },
          };
        }
        const nextDeleted = Array.from(new Set([...(cur.deletedBoqKeys ?? []), row.key]));
        return {
          ...prev,
          summaryOverrides: {
            ...cur,
            deletedBoqKeys: nextDeleted,
          },
        };
      },
      true
    );
    notify(`Removed "${row.productName}" from Bill of Quantities (BOQ).`);
  };

  const handleAddBoqRow = (libraryItemType?: ElectricalItemType) => {
    const cat = libraryItemType
      ? ELECTRICAL_CATALOG.find((c) => c.itemType === libraryItemType)
      : undefined;
    onUpdateProject(
      (prev) => {
        const cur: ProjectSummaryOverrides = prev.summaryOverrides ?? {};
        const initialUnitPrice = cat ? cat.unitCost : 0;
        const newRow: BoqRow = {
          id: `custom-boq-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          itemType: cat ? cat.itemType : 'custom',
          productName: cat ? cat.productName : 'New Electrical Item',
          category: cat ? cat.boqCategory : 'Lighting',
          quantity: 1,
          unitPrice: initialUnitPrice,
          totalWattage: cat ? cat.defaultWattage : 0,
          estimatedCost: initialUnitPrice,
        };
        return {
          ...prev,
          summaryOverrides: {
            ...cur,
            addedBoqRows: [...(cur.addedBoqRows ?? []), newRow],
          },
        };
      },
      true
    );
    notify(
      cat
        ? `Added "${cat.productName}" from Electrical Library to BOQ.`
        : 'Added new editable row to Bill of Quantities (BOQ).'
    );
  };

  const handleAddCentralCatalogueBoqRow = (
    rawProduct: ProductCatalogueItem,
    variantSku?: string
  ) => {
    const resolved = resolveProductWithVariant(rawProduct, variantSku);
    const chosenVariant = variantSku
      ? rawProduct.variants?.find((v) => v.sku === variantSku)
      : rawProduct.variants?.[0];
    const unitPrice = resolved.unitPrice !== null ? Number(resolved.unitPrice.toFixed(2)) : 0;
    onUpdateProject(
      (prev) => {
        const cur: ProjectSummaryOverrides = prev.summaryOverrides ?? {};
        const newRow: BoqRow = {
          id: `cat-boq-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          itemType: resolved.mappedItemType ?? 'custom',
          productId: resolved.id,
          manufacturer: resolved.manufacturer,
          brand: resolved.brand || resolved.manufacturer,
          modelNumber: resolved.modelNumber,
          specification: resolved.specification,
          productName: `${resolved.brand || resolved.manufacturer} ${resolved.productName}`.trim(),
          category: resolved.category,
          unit: resolved.unit || 'Nos',
          quantity: 1,
          unitPrice,
          mrp: resolved.mrp ?? null,
          discountPercent: resolved.discountPercent ?? null,
          gstPercent: resolved.gstPercent ?? null,
          variantSku: resolved.sku || undefined,
          variantLabel: chosenVariant?.label,
          priceCapturedAt: new Date().toISOString(),
          totalWattage: resolved.wattageW ?? 0,
          estimatedCost: unitPrice,
        };
        return {
          ...prev,
          summaryOverrides: {
            ...cur,
            addedBoqRows: [...(cur.addedBoqRows ?? []), newRow],
          },
        };
      },
      true
    );
    notify(
      `Added "${resolved.productName}" to BOQ with locked snapshot price (${
        resolved.unitPrice !== null ? formatINR(resolved.unitPrice) : 'Rate pending'
      }${resolved.gstPercent !== null ? ` + ${resolved.gstPercent}% GST` : ''}).`
    );
  };

  const handleResetBoqRows = () => {
    onUpdateProject((prev) => {
      const cur: ProjectSummaryOverrides = prev.summaryOverrides ?? {};
      const { boqEdits: _e, deletedBoqKeys: _d, addedBoqRows: _a, ...restOv } = cur;
      return {
        ...prev,
        summaryOverrides: restOv,
      };
    }, true);
    notify('Synced Bill of Quantities (BOQ) directly from 2D/3D libraries.');
  };

  const handleSave = () => {
    onSaveProject();
    notify('Project & BOQ snapshot saved to local workspace.');
  };

  const handleDownloadPdf = () => {
    downloadFloorPlanPdf(project);
    notify(`Downloaded architectural floor plan PDF for "${project.name}".`);
  };

  const handleExportExcel = () => {
    const lines: string[] = [];
    lines.push(formatSafeCsvRow(['Blue Space — Engineering BOQ Report']));
    lines.push(formatSafeCsvRow(['Project', project.name, 'Reference', project.refCode]));
    lines.push(
      formatSafeCsvRow(['Site Dimensions', metrics.dimensionsDisplay, 'Area', metrics.areaDisplay])
    );
    lines.push(
      formatSafeCsvRow([
        'Total Electrical Points',
        effectiveTotalPoints,
        'Connected Load (kW)',
        Number(effectiveTotalKw.toFixed(2)),
      ])
    );
    lines.push('');
    lines.push(formatSafeCsvRow(['ROOM-WISE ELECTRICAL BREAKDOWN']));
    lines.push(
      formatSafeCsvRow([
        'Room',
        'Fans',
        'Lights',
        'Switches',
        'Sockets',
        'Appliances',
        'Room Load (W)',
      ])
    );
    roomRows.forEach((r) => {
      lines.push(
        formatSafeCsvRow([
          r.roomName,
          r.fans,
          r.lights,
          r.switches,
          r.sockets,
          r.appliances,
          r.loadWatts,
        ])
      );
    });
    lines.push('');
    lines.push(formatSafeCsvRow(['BILL OF QUANTITIES (BOQ)']));
    lines.push(
      formatSafeCsvRow([
        'Product Name',
        'Category',
        'Quantity',
        'Price/Unit (INR)',
        'Total Wattage (W)',
        'Estimated Cost (INR)',
      ])
    );
    boqRows.forEach((b) => {
      lines.push(
        formatSafeCsvRow([
          b.productName,
          b.category,
          b.quantity,
          b.unitPrice,
          b.totalWattage,
          b.estimatedCost,
        ])
      );
    });
    lines.push(
      formatSafeCsvRow([
        'TOTAL CONNECTED SYSTEM SUMMARY',
        '',
        effectiveTotalPoints,
        '',
        effectiveTotalWatts,
        effectiveTotalCost,
      ])
    );
    if (reconciledBoq.totalGstConfigured > 0) {
      lines.push(
        formatSafeCsvRow([
          'CONFIGURED GST TOTAL',
          '',
          '',
          '',
          '',
          reconciledBoq.totalGstConfigured,
        ])
      );
      lines.push(
        formatSafeCsvRow([
          'GRAND TOTAL (INCL. CONFIGURED GST)',
          '',
          '',
          '',
          '',
          Number((effectiveTotalCost + reconciledBoq.totalGstConfigured).toFixed(2)),
        ])
      );
    }
    lines.push('');
    lines.push(formatSafeCsvRow(['WIRE CONSUMPTION SUMMARY (ALL FLOORS, UNIQUE ROUTES)']));
    lines.push(
      formatSafeCsvRow([
        'Wire Type',
        'Cable Size',
        'Unique Routes',
        'Installed Length (m)',
        `Procurement Allowance (${wireConsumption.procurementAllowancePct}% — Separate, m)`,
      ])
    );
    if (wireConsumption.rows.length === 0) {
      lines.push(
        formatSafeCsvRow([
          'No saved wiring routes',
          '—',
          0,
          'Not calculated',
          'Not calculated',
        ])
      );
    } else {
      wireConsumption.rows.forEach((wr) => {
        lines.push(
          formatSafeCsvRow([
            wr.wireType,
            wr.cableSizeLabel,
            wr.routeCount,
            wr.installedLengthM !== null ? wr.installedLengthM : 'Not calculated',
            wr.procurementAllowanceM !== null ? wr.procurementAllowanceM : 'Not calculated',
          ])
        );
      });
    }
    lines.push(
      formatSafeCsvRow([
        'OVERALL TOTAL WIRE LENGTH (INSTALLED)',
        '',
        wireConsumption.uniqueRouteCount,
        wireConsumption.overallInstalledLengthM !== null
          ? wireConsumption.overallInstalledLengthM
          : 'Not calculated',
        '',
      ])
    );
    lines.push(
      formatSafeCsvRow([
        `PROCUREMENT ALLOWANCE (${wireConsumption.procurementAllowancePct}% — SEPARATE)`,
        '',
        '',
        '',
        wireConsumption.overallProcurementAllowanceM !== null
          ? wireConsumption.overallProcurementAllowanceM
          : 'Not calculated',
      ])
    );

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.refCode}_${project.name.replace(/[^a-zA-Z0-9-_]+/g, '_')}_BOQ.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    notify('Exported Excel-compatible CSV Bill of Quantities.');
  };

  const handleQuoteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setQuoteSubmitted(true);
  };

  const unitShort = project.site.units === 'ft' ? "'" : 'm';

  return (
    <div className="min-h-screen flex flex-col bg-surface text-on-surface">
      <Navbar
        activeScreen="summary"
        onNavigate={onNavigate}
        rightSlot={
          <button
            type="button"
            onClick={() => onNavigate('studio')}
            className="inline-flex items-center justify-center gap-gutter-sm bg-primary text-on-primary px-gutter-lg py-gutter-sm rounded-md font-label text-label-md transition-colors duration-state-change hover:bg-on-primary-container cursor-pointer whitespace-nowrap"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              edit
            </span>
            <span>Edit Design</span>
          </button>
        }
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-gutter-lg lg:px-gutter-xl py-gutter-2xl flex flex-col gap-gutter-2xl">
        {/* Feedback Banner */}
        {feedback && (
          <div className="px-gutter-lg py-gutter-sm rounded-md bg-primary-container border border-primary text-on-primary-container font-mono text-mono-sm flex items-center justify-between no-print">
            <span>{feedback}</span>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              className="text-primary hover:underline cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Report Header & Actions */}
        <section className="flex flex-col lg:flex-row lg:items-center justify-between gap-gutter-lg pb-gutter-xl border-b border-outline-variant">
          <div className="flex flex-col gap-gutter-xs">
            <div className="flex items-center gap-gutter-sm">
              <span className="px-gutter-sm py-0.5 rounded-full bg-primary-container text-primary font-mono text-mono-sm">
                PROJECT REPORT
              </span>
              <span className="font-mono text-mono-sm text-on-surface-variant">
                REF: {project.refCode}
              </span>
            </div>
            <h1 className="font-headline text-headline-lg-mobile lg:text-headline-lg text-on-surface">
              {project.name}
            </h1>
            <p className="font-body text-body-md text-on-surface-variant">
              Complete architectural dimensions, room-wise electrical schedule, and Bill of Quantities (BOQ).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-gutter-sm no-print">
            <button
              type="button"
              onClick={() => onNavigate('studio')}
              className="inline-flex items-center gap-gutter-xs px-gutter-md py-gutter-sm rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-md transition-colors duration-state-change cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                edit
              </span>
              <span>Edit Design</span>
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="inline-flex items-center gap-gutter-xs px-gutter-md py-gutter-sm rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-md transition-colors duration-state-change cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                save
              </span>
              <span>Save Project</span>
            </button>
            <button
              type="button"
              onClick={handleDownloadPdf}
              className="inline-flex items-center justify-center gap-gutter-xs bg-surface-container-high text-on-surface border border-outline px-gutter-md py-gutter-sm rounded-sm font-label text-label-md hover:border-primary hover:text-primary transition-colors duration-state-change cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                picture_as_pdf
              </span>
              <span>Download PDF</span>
            </button>
            <button
              type="button"
              onClick={() => setPdfModalOpen(true)}
              className="inline-flex items-center justify-center gap-gutter-xs bg-surface-container-high text-primary border border-primary/70 px-gutter-md py-gutter-sm rounded-sm font-label text-label-md hover:bg-primary-container/30 transition-colors duration-state-change cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                auto_stories
              </span>
              <span>Drawing Package (PDF)</span>
            </button>
            <button
              type="button"
              onClick={() => {
                void downloadExcelBoq(project, {
                  wireProcurementAllowancePct: wireAllowancePct,
                })
                  .then(() => {
                    notify(`Exported multi-sheet Excel BOQ workbook (.xlsx) for "${project.name}".`);
                  })
                  .catch((err) => {
                    notify(
                      err instanceof Error
                        ? `Excel BOQ export failed: ${err.message}`
                        : 'Excel BOQ export failed.'
                    );
                  });
              }}
              className="inline-flex items-center gap-gutter-xs px-gutter-md py-gutter-sm rounded-sm bg-surface-container-high border border-primary/70 text-primary hover:bg-primary-container/30 font-label text-label-md transition-colors duration-state-change cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                dataset
              </span>
              <span>Export BOQ (.xlsx)</span>
            </button>
            <button
              type="button"
              onClick={handleExportExcel}
              className="inline-flex items-center gap-gutter-xs px-gutter-md py-gutter-sm rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-md transition-colors duration-state-change cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                table_view
              </span>
              <span>Export CSV</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setQuoteSubmitted(false);
                setShowQuoteModal(true);
              }}
              className="inline-flex items-center gap-gutter-xs px-gutter-lg py-gutter-sm rounded-sm bg-secondary text-on-secondary font-label text-label-md hover:bg-on-secondary-container transition-colors duration-state-change cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                request_quote
              </span>
              <span>Request Quotation</span>
            </button>
          </div>
        </section>

        {/* Visual Previews + Core Engineering KPIs */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-gutter-lg">
          <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-gutter-lg">
            <div className="bg-surface-container border border-outline-variant rounded-lg overflow-hidden flex flex-col">
              <div className="px-gutter-md py-gutter-sm border-b border-outline-variant bg-surface-container-high flex items-center justify-between">
                <span className="font-label text-label-sm text-on-surface-variant uppercase">
                  Project Thumbnail
                </span>
                <span className="font-mono text-mono-sm text-primary">2D BLUEPRINT</span>
              </div>
              <div className="aspect-video bg-surface">
                <FloorPlan2D project={project} previewOnly={true} />
              </div>
            </div>

            <div className="bg-surface-container border border-outline-variant rounded-lg overflow-hidden flex flex-col">
              <div className="px-gutter-md py-gutter-sm border-b border-outline-variant bg-surface-container-high flex items-center justify-between">
                <span className="font-label text-label-sm text-on-surface-variant uppercase">
                  3D Preview
                </span>
                <span className="font-mono text-mono-sm text-secondary">ELECTRICAL BIM</span>
              </div>
              <div className="aspect-video bg-surface">
                <Viewport3D
                  project={project}
                  floorViewMode="all"
                  previewOnly={true}
                  lightingMode="daylight"
                  showPins={false}
                />
              </div>
            </div>
          </div>

          <div className="lg:col-span-5 grid grid-cols-2 gap-gutter-md">
            <div className="bg-surface-container border border-outline-variant rounded-lg p-gutter-lg flex flex-col justify-between gap-gutter-sm">
              <span className="font-label text-label-sm text-on-surface-variant uppercase">
                Site Dimensions
              </span>
              <span className="font-mono text-headline-sm text-on-surface tabular-nums">
                {project.site.length}{unitShort} × {project.site.width}{unitShort}
              </span>
              <span className="font-mono text-mono-sm text-on-surface-variant tabular-nums">
                {metrics.areaDisplay} • {project.site.ceilingHeight}{unitShort} Ceiling
              </span>
            </div>

            <div className="bg-surface-container border border-outline-variant rounded-lg p-gutter-lg flex flex-col justify-between gap-gutter-sm">
              <span className="font-label text-label-sm text-on-surface-variant uppercase">
                Number of Rooms
              </span>
              <span className="font-mono text-headline-sm text-primary tabular-nums">
                {roomRows.length} Rooms
              </span>
              <span className="font-mono text-mono-sm text-on-surface-variant">
                {project.site.floors === 1 ? 'Single Floor Plan' : `${project.site.floors} Floor Residence`}
              </span>
            </div>

            <div className="bg-surface-container border border-outline-variant rounded-lg p-gutter-lg flex flex-col justify-between gap-gutter-sm">
              <span className="font-label text-label-sm text-on-surface-variant uppercase">
                Total Electrical Points
              </span>
              <span className="font-mono text-headline-sm text-on-surface tabular-nums">
                {effectiveTotalPoints} Points
              </span>
              <span className="font-mono text-mono-sm text-on-surface-variant">
                {effectiveTotalPoints - metrics.categoryCounts.Distribution} Branch + {metrics.categoryCounts.Distribution} DB/PE · {buildingSummary.activeCircuitCount} Circuits
              </span>
            </div>

            <div className="bg-surface-container border border-secondary rounded-lg p-gutter-lg flex flex-col justify-between gap-gutter-sm">
              <span className="font-label text-label-sm text-secondary uppercase">
                Total Connected Load
              </span>
              <span className="font-mono text-headline-sm text-secondary tabular-nums">
                {effectiveTotalKw.toFixed(2)} kW
              </span>
              <span className="font-mono text-mono-sm text-on-surface-variant tabular-nums">
                Est. Demand: {effectiveEstimatedAmps.toFixed(1)} A
              </span>
            </div>
          </div>
        </section>

        {/* Category Quantity Strip */}
        <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-gutter-md">
          <div className="bg-surface-container border border-outline-variant rounded-md p-gutter-lg flex items-center justify-between">
            <div className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-sm text-on-surface-variant">Fan Quantities</span>
              <span className="font-mono text-headline-md text-on-surface tabular-nums">
                {effectiveCategoryCounts.Fans}
              </span>
            </div>
            <span className="material-symbols-outlined text-primary text-[24px]" aria-hidden="true">
              mode_fan
            </span>
          </div>

          <div className="bg-surface-container border border-outline-variant rounded-md p-gutter-lg flex items-center justify-between">
            <div className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-sm text-on-surface-variant">Lighting Quantities</span>
              <span className="font-mono text-headline-md text-on-surface tabular-nums">
                {effectiveCategoryCounts.Lighting}
              </span>
            </div>
            <span className="material-symbols-outlined text-secondary text-[24px]" aria-hidden="true">
              lightbulb
            </span>
          </div>

          <div className="bg-surface-container border border-outline-variant rounded-md p-gutter-lg flex items-center justify-between">
            <div className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-sm text-on-surface-variant">Switch Quantities</span>
              <span className="font-mono text-headline-md text-on-surface tabular-nums">
                {effectiveCategoryCounts.Switches}
              </span>
            </div>
            <span className="material-symbols-outlined text-primary text-[24px]" aria-hidden="true">
              toggle_on
            </span>
          </div>

          <div className="bg-surface-container border border-outline-variant rounded-md p-gutter-lg flex items-center justify-between">
            <div className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-sm text-on-surface-variant">Socket Quantities</span>
              <span className="font-mono text-headline-md text-on-surface tabular-nums">
                {effectiveCategoryCounts.Sockets}
              </span>
            </div>
            <span className="material-symbols-outlined text-primary text-[24px]" aria-hidden="true">
              power
            </span>
          </div>

          <div className="bg-surface-container border border-outline-variant rounded-md p-gutter-lg flex items-center justify-between col-span-2 sm:col-span-1">
            <div className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-sm text-on-surface-variant">Appliance Quantities</span>
              <span className="font-mono text-headline-md text-secondary tabular-nums">
                {effectiveCategoryCounts.Appliances}
              </span>
            </div>
            <span className="material-symbols-outlined text-secondary text-[24px]" aria-hidden="true">
              ac_unit
            </span>
          </div>
        </section>

        {/* Room-Wise Electrical Breakdown (Live-synced with 2D/3D Room & Electrical Libraries + Editable) */}
        <section className="flex flex-col gap-gutter-md">
          <div className="flex flex-wrap items-center justify-between gap-gutter-sm">
            <h2 className="font-headline text-headline-md text-on-surface">
              Room-Wise Electrical Breakdown
            </h2>
            <div className="flex flex-wrap items-center gap-gutter-sm no-print">
              <span className="font-mono text-mono-sm text-on-surface-variant tabular-nums">
                {roomRows.length} ZONES · LIVE 2D/3D SYNC
              </span>
              <select
                aria-label="Add room from Room Library"
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  handleAddRoomRow(e.target.value);
                }}
                className="bg-surface-container-high border border-outline rounded-sm px-2 py-1 font-label text-label-sm text-on-surface hover:border-primary focus:border-primary focus:outline-none cursor-pointer"
              >
                <option value="">+ From Room Library</option>
                {ROOM_LIBRARY.map((rm) => (
                  <option key={rm.type} value={rm.label} className="bg-surface-container text-on-surface">
                    {rm.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => handleAddRoomRow()}
                className="inline-flex items-center gap-1 px-gutter-sm py-1 rounded-sm bg-surface-container-high border border-outline text-primary hover:border-primary font-label text-label-sm cursor-pointer transition-colors"
              >
                <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
                  add
                </span>
                <span>Add Row</span>
              </button>
              {isRoomCustomized && (
                <button
                  type="button"
                  onClick={handleResetRoomRows}
                  title="Restore all rows directly from 2D/3D floor plan libraries"
                  className="inline-flex items-center gap-1 px-gutter-sm py-1 rounded-sm bg-surface-container border border-outline-variant text-on-surface-variant hover:text-on-surface hover:border-outline font-label text-label-sm cursor-pointer transition-colors"
                >
                  <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
                    restart_alt
                  </span>
                  <span>Reset</span>
                </button>
              )}
            </div>
          </div>

          <datalist id="room-library-suggestions">
            {ROOM_LIBRARY.map((rm) => (
              <option key={rm.type} value={rm.label} />
            ))}
          </datalist>

          <div className="w-full overflow-x-auto bg-surface-container border border-outline-variant rounded-lg">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-outline bg-surface-container-high">
                  <th scope="col" className="px-gutter-md py-gutter-md font-label text-label-md text-on-surface-variant">Room</th>
                  <th scope="col" className="px-gutter-sm py-gutter-md font-label text-label-md text-on-surface-variant text-right">Fans</th>
                  <th scope="col" className="px-gutter-sm py-gutter-md font-label text-label-md text-on-surface-variant text-right">Lights</th>
                  <th scope="col" className="px-gutter-sm py-gutter-md font-label text-label-md text-on-surface-variant text-right">Switches</th>
                  <th scope="col" className="px-gutter-sm py-gutter-md font-label text-label-md text-on-surface-variant text-right">Sockets</th>
                  <th scope="col" className="px-gutter-sm py-gutter-md font-label text-label-md text-on-surface-variant text-right">Appliances</th>
                  <th scope="col" className="px-gutter-md py-gutter-md font-label text-label-md text-on-surface-variant text-right">Room Load (W)</th>
                  <th scope="col" className="px-gutter-sm py-gutter-md font-label text-label-md text-on-surface-variant text-center w-12 no-print">
                    <span className="sr-only">Delete</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {roomRows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-gutter-lg py-gutter-xl text-center font-body text-body-md text-on-surface-variant">
                      No rooms or electrical library items placed in 2D/3D yet. Add rooms in Design Studio or pick from <span className="text-primary font-label">+ From Room Library</span> above.
                    </td>
                  </tr>
                ) : (
                  roomRows.map((row, idx) => (
                    <tr key={row.roomId} className="hover:bg-surface-container-high/70 transition-colors duration-state-change">
                      <td className="px-gutter-md py-2">
                        <input
                          type="text"
                          list="room-library-suggestions"
                          aria-label={`Room name row ${idx + 1}`}
                          value={row.roomName}
                          onChange={(e) => handleUpdateRoomRow(row, 'roomName', e.target.value)}
                          className="w-full min-w-[160px] bg-surface/70 border border-outline-variant/60 hover:border-outline focus:border-primary focus:outline-none rounded-sm px-2 py-1 font-body text-body-md text-on-surface"
                        />
                      </td>
                      <td className="px-gutter-sm py-2">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          aria-label={`Fans for ${row.roomName}`}
                          value={row.fans}
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) =>
                            handleUpdateRoomRow(row, 'fans', e.target.value === '' ? 0 : Number(e.target.value))
                          }
                          className="w-20 ml-auto block bg-surface/70 border border-outline-variant/60 hover:border-outline focus:border-primary focus:outline-none rounded-sm px-2 py-1 font-mono text-mono-md text-on-surface text-right tabular-nums"
                        />
                      </td>
                      <td className="px-gutter-sm py-2">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          aria-label={`Lights for ${row.roomName}`}
                          value={row.lights}
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) =>
                            handleUpdateRoomRow(row, 'lights', e.target.value === '' ? 0 : Number(e.target.value))
                          }
                          className="w-20 ml-auto block bg-surface/70 border border-outline-variant/60 hover:border-outline focus:border-primary focus:outline-none rounded-sm px-2 py-1 font-mono text-mono-md text-on-surface text-right tabular-nums"
                        />
                      </td>
                      <td className="px-gutter-sm py-2">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          aria-label={`Switches for ${row.roomName}`}
                          value={row.switches}
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) =>
                            handleUpdateRoomRow(row, 'switches', e.target.value === '' ? 0 : Number(e.target.value))
                          }
                          className="w-20 ml-auto block bg-surface/70 border border-outline-variant/60 hover:border-outline focus:border-primary focus:outline-none rounded-sm px-2 py-1 font-mono text-mono-md text-on-surface text-right tabular-nums"
                        />
                      </td>
                      <td className="px-gutter-sm py-2">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          aria-label={`Sockets for ${row.roomName}`}
                          value={row.sockets}
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) =>
                            handleUpdateRoomRow(row, 'sockets', e.target.value === '' ? 0 : Number(e.target.value))
                          }
                          className="w-20 ml-auto block bg-surface/70 border border-outline-variant/60 hover:border-outline focus:border-primary focus:outline-none rounded-sm px-2 py-1 font-mono text-mono-md text-on-surface text-right tabular-nums"
                        />
                      </td>
                      <td className="px-gutter-sm py-2">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          aria-label={`Appliances for ${row.roomName}`}
                          value={row.appliances}
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) =>
                            handleUpdateRoomRow(row, 'appliances', e.target.value === '' ? 0 : Number(e.target.value))
                          }
                          className="w-20 ml-auto block bg-surface/70 border border-outline-variant/60 hover:border-outline focus:border-primary focus:outline-none rounded-sm px-2 py-1 font-mono text-mono-md text-on-surface text-right tabular-nums"
                        />
                      </td>
                      <td className="px-gutter-md py-2">
                        <div className="flex items-center justify-end gap-1">
                          <input
                            type="number"
                            min={0}
                            step={10}
                            aria-label={`Room load watts for ${row.roomName}`}
                            value={row.loadWatts}
                            onFocus={(e) => e.currentTarget.select()}
                            onChange={(e) =>
                              handleUpdateRoomRow(row, 'loadWatts', e.target.value === '' ? 0 : Number(e.target.value))
                            }
                            className="w-24 bg-surface/70 border border-outline-variant/60 hover:border-outline focus:border-secondary focus:outline-none rounded-sm px-2 py-1 font-mono text-mono-md text-secondary text-right tabular-nums"
                          />
                          <span className="font-mono text-mono-sm text-on-surface-variant">W</span>
                        </div>
                      </td>
                      <td className="px-gutter-sm py-2 text-center no-print">
                        <button
                          type="button"
                          onClick={() => handleDeleteRoomRow(row)}
                          title={`Delete ${row.roomName} row`}
                          aria-label={`Delete ${row.roomName} row`}
                          className="inline-flex items-center justify-center w-8 h-8 rounded-sm border border-transparent text-on-surface-variant hover:text-error hover:border-error/60 hover:bg-error/10 transition-colors cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                            delete
                          </span>
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {roomRows.length > 0 && (
                <tfoot>
                  <tr className="border-t border-outline bg-surface-container-high">
                    <td className="px-gutter-md py-gutter-sm font-label text-label-md text-on-surface">
                      Room Schedule Totals
                    </td>
                    <td className="px-gutter-sm py-gutter-sm font-mono text-mono-md text-primary text-right tabular-nums">
                      {roomTotals.fans}
                    </td>
                    <td className="px-gutter-sm py-gutter-sm font-mono text-mono-md text-primary text-right tabular-nums">
                      {roomTotals.lights}
                    </td>
                    <td className="px-gutter-sm py-gutter-sm font-mono text-mono-md text-primary text-right tabular-nums">
                      {roomTotals.switches}
                    </td>
                    <td className="px-gutter-sm py-gutter-sm font-mono text-mono-md text-primary text-right tabular-nums">
                      {roomTotals.sockets}
                    </td>
                    <td className="px-gutter-sm py-gutter-sm font-mono text-mono-md text-primary text-right tabular-nums">
                      {roomTotals.appliances}
                    </td>
                    <td className="px-gutter-md py-gutter-sm font-mono text-mono-md text-secondary text-right tabular-nums">
                      {roomTotals.loadWatts.toLocaleString('en-IN')} W
                    </td>
                    <td className="no-print" />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </section>

        {/* Bill of Quantities (BOQ) Table (Live-synced with 2D/3D Electrical Library + Editable) */}
        <section className="flex flex-col gap-gutter-md">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-gutter-sm">
            <h2 className="font-headline text-headline-md text-on-surface">
              Bill of Quantities (BOQ)
            </h2>
            <div className="flex flex-wrap items-center gap-gutter-sm">
              <span className="font-mono text-mono-md text-primary tabular-nums">
                Total Estimated Cost: {formatINR(effectiveTotalCost)}
              </span>
              <select
                aria-label="Add item from Electrical Library"
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  handleAddBoqRow(e.target.value as ElectricalItemType);
                }}
                className="bg-surface-container-high border border-outline rounded-sm px-2 py-1 font-label text-label-sm text-on-surface hover:border-primary focus:border-primary focus:outline-none cursor-pointer no-print"
              >
                <option value="">+ From Electrical Library</option>
                {ELECTRICAL_CATALOG.map((item) => (
                  <option key={item.itemType} value={item.itemType} className="bg-surface-container text-on-surface">
                    {item.label} — {item.productName} ({item.defaultWattage}W)
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setBoqCatalogueOpen((v) => !v)}
                className="inline-flex items-center gap-1 px-gutter-sm py-1 rounded-sm bg-primary/15 border border-primary text-primary hover:bg-primary/25 font-label text-label-sm cursor-pointer transition-colors no-print"
              >
                <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
                  inventory_2
                </span>
                <span>
                  + From Central Catalogue ({centralCatalogueProducts.length.toLocaleString('en-IN')})
                </span>
              </button>
              <button
                type="button"
                onClick={() => handleAddBoqRow()}
                className="inline-flex items-center gap-1 px-gutter-sm py-1 rounded-sm bg-surface-container-high border border-outline text-primary hover:border-primary font-label text-label-sm cursor-pointer transition-colors no-print"
              >
                <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
                  add
                </span>
                <span>Add Row</span>
              </button>
              {isBoqCustomized && (
                <button
                  type="button"
                  onClick={handleResetBoqRows}
                  title="Restore BOQ directly from 2D/3D Electrical Library placements"
                  className="inline-flex items-center gap-1 px-gutter-sm py-1 rounded-sm bg-surface-container border border-outline-variant text-on-surface-variant hover:text-on-surface hover:border-outline font-label text-label-sm cursor-pointer transition-colors no-print"
                >
                  <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
                    restart_alt
                  </span>
                  <span>Reset</span>
                </button>
              )}
            </div>
          </div>

          {boqCatalogueOpen && (
            <div className="bg-surface-container border border-primary/60 rounded-lg p-3 space-y-2.5 no-print">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-1 min-w-[240px]">
                  <span className="material-symbols-outlined text-primary text-[18px]">
                    search
                  </span>
                  <input
                    type="text"
                    value={boqCatalogueQuery}
                    onChange={(e) => setBoqCatalogueQuery(e.target.value)}
                    placeholder="Search central catalogue by brand, product, SKU, category, or spec..."
                    className="flex-1 bg-surface border border-outline rounded-sm px-2.5 py-1.5 font-body text-xs text-on-surface"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setBoqCatalogueOpen(false)}
                  className="px-2.5 py-1 text-xs font-label border border-outline bg-surface text-on-surface-variant hover:text-on-surface cursor-pointer"
                >
                  Close Picker
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 max-h-72 overflow-y-auto">
                {filteredBoqCatalogueProducts.map((rawProd) => {
                  const chosenSku = boqVariantByProduct[rawProd.id];
                  const prod = resolveProductWithVariant(rawProd, chosenSku);
                  return (
                    <div
                      key={rawProd.id}
                      className="border border-outline-variant bg-surface p-2.5 rounded-sm flex flex-col justify-between gap-2"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-1 text-[10px] font-mono text-secondary">
                          <span className="truncate">{prod.manufacturer}</span>
                          <span className="truncate text-on-surface-variant">{prod.category}</span>
                        </div>
                        <div className="font-body text-xs text-on-surface font-medium line-clamp-2">
                          {prod.productName}
                        </div>
                        {rawProd.variants && rawProd.variants.length > 1 && (
                          <select
                            aria-label={`Select variant for ${rawProd.productName}`}
                            value={chosenSku ?? rawProd.variants[0]?.sku ?? ''}
                            onChange={(e) =>
                              setBoqVariantByProduct((prev) => ({
                                ...prev,
                                [rawProd.id]: e.target.value,
                              }))
                            }
                            className="w-full bg-surface-container-low border border-outline px-1.5 py-0.5 text-[10px] font-mono text-on-surface"
                          >
                            {rawProd.variants.map((v) => (
                              <option key={v.sku} value={v.sku}>
                                {v.label}
                                {v.unitPrice !== null ? ` — ${formatINR(v.unitPrice)}` : ''}
                              </option>
                            ))}
                          </select>
                        )}
                        <div className="font-mono text-[10px] text-on-surface-variant flex flex-wrap gap-1.5">
                          <span className="text-on-surface font-semibold">
                            {prod.unitPrice !== null ? formatINR(prod.unitPrice) : 'Rate pending'}/
                            {prod.unit}
                          </span>
                          {prod.discountPercent ? (
                            <span className="text-emerald-400">{prod.discountPercent}% off</span>
                          ) : null}
                          {prod.gstPercent !== null ? (
                            <span className="text-secondary">+{prod.gstPercent}% GST</span>
                          ) : null}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleAddCentralCatalogueBoqRow(rawProd, chosenSku)}
                        className="w-full py-1 text-[11px] font-label bg-primary text-on-primary rounded-sm cursor-pointer"
                      >
                        + Add to BOQ (Lock Snapshot Price)
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <datalist id="boq-product-suggestions">
            {ELECTRICAL_CATALOG.map((item) => (
              <option key={item.itemType} value={item.productName} />
            ))}
          </datalist>

          <datalist id="boq-category-suggestions">
            {uniqueBoqCategories.map((cat) => (
              <option key={cat} value={cat} />
            ))}
            <option value="Wiring & Conduits" />
          </datalist>

          <div className="w-full overflow-x-auto bg-surface-container border border-outline-variant rounded-lg">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-outline bg-surface-container-high">
                  <th scope="col" className="px-gutter-md py-gutter-md font-label text-label-md text-on-surface-variant">Product Name</th>
                  <th scope="col" className="px-gutter-md py-gutter-md font-label text-label-md text-on-surface-variant">Category</th>
                  <th scope="col" className="px-gutter-sm py-gutter-md font-label text-label-md text-on-surface-variant text-right">Quantity</th>
                  <th scope="col" className="px-gutter-sm py-gutter-md font-label text-label-md text-on-surface-variant text-right">Price/Unit (₹)</th>
                  <th scope="col" className="px-gutter-sm py-gutter-md font-label text-label-md text-on-surface-variant text-right">Wattage (W)</th>
                  <th scope="col" className="px-gutter-md py-gutter-md font-label text-label-md text-on-surface-variant text-right">Estimated Cost (₹)</th>
                  <th scope="col" className="px-gutter-sm py-gutter-md font-label text-label-md text-on-surface-variant text-center w-12 no-print">
                    <span className="sr-only">Delete</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {boqRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-gutter-lg py-gutter-xl text-center font-body text-body-md text-on-surface-variant">
                      No electrical library items placed in 2D/3D yet. Place items from D. Electrical Library in Design Studio or pick from <span className="text-primary font-label">+ From Electrical Library</span> above.
                    </td>
                  </tr>
                ) : (
                  boqRows.map((row, idx) => (
                    <tr key={row.key} className="hover:bg-surface-container-high/70 transition-colors duration-state-change">
                      <td className="px-gutter-md py-2">
                        <input
                          type="text"
                          list="boq-product-suggestions"
                          aria-label={`Product name row ${idx + 1}`}
                          value={row.productName}
                          onChange={(e) => handleUpdateBoqRow(row, 'productName', e.target.value)}
                          className="w-full min-w-[180px] bg-surface/70 border border-outline-variant/60 hover:border-outline focus:border-primary focus:outline-none rounded-sm px-2 py-1 font-body text-body-md text-on-surface"
                        />
                        {(row.manufacturer ||
                          row.specification ||
                          row.unit ||
                          row.discountPercent ||
                          row.gstPercent !== undefined) && (
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-on-surface-variant">
                            {row.manufacturer && (
                              <span className="text-primary">{row.manufacturer}</span>
                            )}
                            {row.modelNumber && <span>SKU: {row.modelNumber}</span>}
                            {row.unit && <span>Unit: {row.unit}</span>}
                            {row.discountPercent ? (
                              <span className="text-emerald-400">
                                Disc: {row.discountPercent}%
                              </span>
                            ) : null}
                            {row.gstPercent !== undefined && row.gstPercent !== null && (
                              <span className="text-secondary">GST: {row.gstPercent}%</span>
                            )}
                            {row.specification && (
                              <span className="truncate max-w-[260px]" title={row.specification}>
                                {row.specification}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-gutter-md py-2">
                        <input
                          type="text"
                          list="boq-category-suggestions"
                          aria-label={`Category for ${row.productName}`}
                          value={row.category}
                          onChange={(e) => handleUpdateBoqRow(row, 'category', e.target.value)}
                          className="w-full min-w-[140px] bg-surface/70 border border-outline-variant/60 hover:border-outline focus:border-primary focus:outline-none rounded-sm px-2 py-1 font-body text-body-sm text-on-surface-variant focus:text-on-surface"
                        />
                      </td>
                      <td className="px-gutter-sm py-2">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          aria-label={`Quantity for ${row.productName}`}
                          value={row.quantity}
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) =>
                            handleUpdateBoqRow(row, 'quantity', e.target.value === '' ? 0 : Number(e.target.value))
                          }
                          className="w-20 ml-auto block bg-surface/70 border border-outline-variant/60 hover:border-outline focus:border-primary focus:outline-none rounded-sm px-2 py-1 font-mono text-mono-md text-on-surface text-right tabular-nums"
                        />
                      </td>
                      <td className="px-gutter-sm py-2">
                        <div className="flex items-center justify-end gap-1">
                          <span className="font-mono text-mono-sm text-on-surface-variant">₹</span>
                          <input
                            type="number"
                            min={0}
                            step={50}
                            aria-label={`Price per unit for ${row.productName}`}
                            value={row.unitPrice}
                            onFocus={(e) => e.currentTarget.select()}
                            onChange={(e) =>
                              handleUpdateBoqRow(row, 'unitPrice', e.target.value === '' ? 0 : Number(e.target.value))
                            }
                            className="w-24 bg-surface/70 border border-outline-variant/60 hover:border-outline focus:border-primary focus:outline-none rounded-sm px-2 py-1 font-mono text-mono-md text-on-surface text-right tabular-nums"
                          />
                        </div>
                      </td>
                      <td className="px-gutter-sm py-2">
                        <div className="flex items-center justify-end gap-1">
                          <input
                            type="number"
                            min={0}
                            step={10}
                            aria-label={`Wattage for ${row.productName}`}
                            value={row.totalWattage}
                            onFocus={(e) => e.currentTarget.select()}
                            onChange={(e) =>
                              handleUpdateBoqRow(row, 'totalWattage', e.target.value === '' ? 0 : Number(e.target.value))
                            }
                            className={`w-24 bg-surface/70 border border-outline-variant/60 hover:border-outline focus:border-secondary focus:outline-none rounded-sm px-2 py-1 font-mono text-mono-md text-right tabular-nums ${
                              row.totalWattage > 0 ? 'text-secondary' : 'text-on-surface-variant'
                            }`}
                          />
                          <span className="font-mono text-mono-sm text-on-surface-variant">W</span>
                        </div>
                      </td>
                      <td
                        className="px-gutter-md py-2 font-mono text-mono-md text-on-surface text-right tabular-nums whitespace-nowrap"
                        title={`${row.quantity} × ${formatINR(row.unitPrice)}`}
                      >
                        {formatINR(row.estimatedCost)}
                      </td>
                      <td className="px-gutter-sm py-2 text-center no-print">
                        <button
                          type="button"
                          onClick={() => handleDeleteBoqRow(row)}
                          title={`Delete ${row.productName} row`}
                          aria-label={`Delete ${row.productName} row`}
                          className="inline-flex items-center justify-center w-8 h-8 rounded-sm border border-transparent text-on-surface-variant hover:text-error hover:border-error/60 hover:bg-error/10 transition-colors cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                            delete
                          </span>
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="border-t border-outline bg-surface-container-high">
                  <td colSpan={2} className="px-gutter-md py-gutter-md font-label text-label-md text-on-surface">
                    Total Connected System Summary
                  </td>
                  <td className="px-gutter-sm py-gutter-md font-mono text-mono-md text-primary text-right tabular-nums">
                    {effectiveTotalPoints}
                  </td>
                  <td className="px-gutter-sm py-gutter-md font-mono text-mono-sm text-on-surface-variant text-right">
                    —
                  </td>
                  <td className="px-gutter-sm py-gutter-md font-mono text-mono-md text-secondary text-right tabular-nums">
                    {effectiveTotalKw.toFixed(2)} kW
                  </td>
                  <td className="px-gutter-md py-gutter-md font-mono text-mono-md text-on-surface text-right tabular-nums">
                    {formatINR(effectiveTotalCost)}
                  </td>
                  <td className="no-print" />
                </tr>
                {reconciledBoq.totalGstConfigured > 0 && (
                  <>
                    <tr className="border-t border-outline-variant bg-surface-container-low">
                      <td colSpan={5} className="px-gutter-md py-gutter-sm font-label text-label-sm text-on-surface-variant">
                        Configured GST Total
                      </td>
                      <td className="px-gutter-md py-gutter-sm font-mono text-mono-md text-on-surface-variant text-right tabular-nums">
                        {formatINR(reconciledBoq.totalGstConfigured)}
                      </td>
                      <td className="no-print" />
                    </tr>
                    <tr className="border-t border-outline bg-surface-container-high">
                      <td colSpan={5} className="px-gutter-md py-gutter-sm font-label text-label-md text-on-surface">
                        Grand Total (Incl. Configured GST)
                      </td>
                      <td className="px-gutter-md py-gutter-sm font-mono text-mono-md text-primary text-right tabular-nums">
                        {formatINR(effectiveTotalCost + reconciledBoq.totalGstConfigured)}
                      </td>
                      <td className="no-print" />
                    </tr>
                  </>
                )}
              </tfoot>
            </table>
          </div>

          {/* Wire Consumption Summary (at the end of the BOQ — all floors, deduplicated routes) */}
          <div className="w-full overflow-x-auto bg-surface-container border border-outline-variant rounded-lg">
            <div className="px-gutter-md py-gutter-sm border-b border-outline-variant bg-surface-container-high flex flex-wrap items-center justify-between gap-gutter-sm">
              <div className="flex flex-col gap-0.5">
                <h3 className="font-headline text-headline-sm text-on-surface">
                  Wire Consumption Summary
                </h3>
                <p className="font-mono text-mono-sm text-on-surface-variant">
                  Actual saved wiring routes across all floors
                  {wireConsumption.uniqueRouteCount > 0
                    ? ` · ${wireConsumption.uniqueRouteCount} unique route${wireConsumption.uniqueRouteCount === 1 ? '' : 's'} (${wireConsumption.floorsCovered.length} floor${wireConsumption.floorsCovered.length === 1 ? '' : 's'})`
                    : ''}
                  {wireConsumption.duplicateRoutesExcluded > 0
                    ? ` · ${wireConsumption.duplicateRoutesExcluded} duplicate${wireConsumption.duplicateRoutesExcluded === 1 ? '' : 's'} excluded`
                    : ''}
                </p>
              </div>
              <label className="inline-flex items-center gap-gutter-xs font-label text-label-sm text-on-surface-variant no-print">
                <span>Procurement Allowance (Separate):</span>
                <input
                  type="number"
                  min={0}
                  max={50}
                  step={1}
                  aria-label="Wire procurement allowance percentage"
                  value={wireAllowancePct}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setWireAllowancePct(
                      Number.isFinite(next) ? Math.max(0, Math.min(50, next)) : 0
                    );
                  }}
                  className="w-16 bg-surface/70 border border-outline-variant/60 hover:border-outline focus:border-primary focus:outline-none rounded-sm px-2 py-0.5 font-mono text-mono-sm text-on-surface text-right tabular-nums"
                />
                <span className="font-mono text-mono-sm">%</span>
              </label>
            </div>
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-outline bg-surface-container-low">
                  <th scope="col" className="px-gutter-md py-gutter-sm font-label text-label-sm text-on-surface-variant">
                    Wire Type
                  </th>
                  <th scope="col" className="px-gutter-md py-gutter-sm font-label text-label-sm text-on-surface-variant">
                    Cable Size
                  </th>
                  <th scope="col" className="px-gutter-sm py-gutter-sm font-label text-label-sm text-on-surface-variant text-right">
                    Routes
                  </th>
                  <th scope="col" className="px-gutter-md py-gutter-sm font-label text-label-sm text-on-surface-variant text-right">
                    Installed Length (m)
                  </th>
                  <th scope="col" className="px-gutter-md py-gutter-sm font-label text-label-sm text-on-surface-variant text-right">
                    Procurement Allowance (+{wireConsumption.procurementAllowancePct}%)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {wireConsumption.rows.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-gutter-md py-gutter-md font-body text-body-sm text-on-surface-variant">
                      No saved wiring routes found across project floors. Route cables in Design Studio to calculate wire lengths.
                    </td>
                    <td className="px-gutter-md py-gutter-md font-mono text-mono-sm text-on-surface-variant text-right">
                      Not calculated
                    </td>
                    <td className="px-gutter-md py-gutter-md font-mono text-mono-sm text-on-surface-variant text-right">
                      Not calculated
                    </td>
                  </tr>
                ) : (
                  wireConsumption.rows.map((wr) => (
                    <tr key={wr.key} className="hover:bg-surface-container-high/70 transition-colors duration-state-change">
                      <td className="px-gutter-md py-2">
                        <div className="font-body text-body-sm text-on-surface">{wr.wireType}</div>
                        <div className="font-mono text-[11px] text-on-surface-variant">
                          {wr.cableMaterial}
                          {wr.floors.length > 0
                            ? ` · ${wr.floors.map((f) => getFloorLabel(project, f)).join(', ')}`
                            : ''}
                          {wr.uncalculatedRouteCount > 0
                            ? ` · ${wr.uncalculatedRouteCount} route${wr.uncalculatedRouteCount === 1 ? '' : 's'} not calculated`
                            : ''}
                        </div>
                      </td>
                      <td className="px-gutter-md py-2 font-mono text-mono-sm text-on-surface-variant whitespace-nowrap">
                        {wr.cableSizeLabel}
                      </td>
                      <td className="px-gutter-sm py-2 font-mono text-mono-sm text-on-surface text-right tabular-nums">
                        {wr.routeCount}
                      </td>
                      <td className="px-gutter-md py-2 font-mono text-mono-md text-primary text-right tabular-nums whitespace-nowrap">
                        {wr.installedLengthM !== null
                          ? `${wr.installedLengthM.toFixed(2)} m`
                          : 'Not calculated'}
                      </td>
                      <td className="px-gutter-md py-2 font-mono text-mono-sm text-on-surface-variant text-right tabular-nums whitespace-nowrap">
                        {wr.procurementAllowanceM !== null
                          ? `+${wr.procurementAllowanceM.toFixed(2)} m`
                          : 'Not calculated'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="border-t border-outline bg-surface-container-high">
                  <td colSpan={2} className="px-gutter-md py-gutter-sm font-label text-label-md text-on-surface">
                    Overall Total Wire Length (Installed)
                  </td>
                  <td className="px-gutter-sm py-gutter-sm font-mono text-mono-sm text-on-surface text-right tabular-nums">
                    {wireConsumption.uniqueRouteCount}
                  </td>
                  <td className="px-gutter-md py-gutter-sm font-mono text-mono-md text-primary text-right tabular-nums whitespace-nowrap">
                    {wireConsumption.overallInstalledLengthM !== null
                      ? `${wireConsumption.overallInstalledLengthM.toFixed(2)} m`
                      : 'Not calculated'}
                  </td>
                  <td className="px-gutter-md py-gutter-sm font-mono text-mono-sm text-on-surface-variant text-right">
                    —
                  </td>
                </tr>
                <tr className="border-t border-outline-variant bg-surface-container-low">
                  <td colSpan={4} className="px-gutter-md py-gutter-sm font-label text-label-sm text-on-surface-variant">
                    Procurement Allowance ({wireConsumption.procurementAllowancePct}% — kept separate from installed length)
                  </td>
                  <td className="px-gutter-md py-gutter-sm font-mono text-mono-md text-secondary text-right tabular-nums whitespace-nowrap">
                    {wireConsumption.overallProcurementAllowanceM !== null
                      ? `+${wireConsumption.overallProcurementAllowanceM.toFixed(2)} m`
                      : 'Not calculated'}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        {/* Multi-Storey Building, Distribution & Electrical Wiring Schedule (Additive) */}
        <section className="flex flex-col gap-gutter-md">
          <div className="flex flex-wrap items-center justify-between gap-gutter-sm">
            <div>
              <h2 className="font-headline text-headline-md text-on-surface">
                Multi-Storey Floor, Distribution &amp; Wiring Schedule
              </h2>
              <p className="font-body text-body-sm text-on-surface-variant">
                {buildingSummary.buildingTypeLabel} · {buildingSummary.floorCount} floor
                {buildingSummary.floorCount === 1 ? '' : 's'} · {buildingSummary.totalWires} routed cable
                {buildingSummary.totalWires === 1 ? '' : 's'} ({buildingSummary.totalWireLengthM.toFixed(1)} m total)
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 font-mono text-mono-sm">
              <span className="px-2.5 py-1 rounded-sm bg-surface-container border border-outline-variant text-on-surface">
                DB Boards: {project.points.filter((p) => p.itemType === 'distribution_board').length}
              </span>
              <span className="px-2.5 py-1 rounded-sm bg-surface-container border border-outline-variant text-on-surface">
                Earthing Points: {project.points.filter((p) => p.itemType === 'earthing_point').length}
              </span>
              <span className="px-2.5 py-1 rounded-sm bg-surface-container border border-outline-variant text-secondary">
                Inter-Floor Risers: {buildingSummary.interFloorWireCount}
              </span>
            </div>
          </div>

          {/* Floor-Wise Schedule */}
          <div className="w-full overflow-x-auto bg-surface-container border border-outline-variant rounded-lg">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-outline bg-surface-container-high">
                  <th scope="col" className="px-gutter-md py-gutter-sm font-label text-label-sm text-on-surface-variant">Floor</th>
                  <th scope="col" className="px-gutter-sm py-gutter-sm font-label text-label-sm text-on-surface-variant text-right">Elevation (m)</th>
                  <th scope="col" className="px-gutter-sm py-gutter-sm font-label text-label-sm text-on-surface-variant text-right">Height (m)</th>
                  <th scope="col" className="px-gutter-sm py-gutter-sm font-label text-label-sm text-on-surface-variant text-right">Rooms</th>
                  <th scope="col" className="px-gutter-sm py-gutter-sm font-label text-label-sm text-on-surface-variant text-right">Built-up (m²)</th>
                  <th scope="col" className="px-gutter-sm py-gutter-sm font-label text-label-sm text-on-surface-variant text-right">Points</th>
                  <th scope="col" className="px-gutter-sm py-gutter-sm font-label text-label-sm text-on-surface-variant text-right">Wires</th>
                  <th scope="col" className="px-gutter-md py-gutter-sm font-label text-label-sm text-on-surface-variant text-right">Floor Load (W)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {buildingSummary.floorRows.map((fr) => (
                  <tr key={fr.floor} className="hover:bg-surface-container-high/70">
                    <td className="px-gutter-md py-2 font-body text-body-sm text-on-surface">
                      {fr.name}
                    </td>
                    <td className="px-gutter-sm py-2 font-mono text-mono-sm text-on-surface-variant text-right tabular-nums">
                      {fr.elevationM >= 0 ? `+${fr.elevationM.toFixed(2)}` : fr.elevationM.toFixed(2)}
                    </td>
                    <td className="px-gutter-sm py-2 font-mono text-mono-sm text-on-surface-variant text-right tabular-nums">
                      {fr.floorHeightM.toFixed(2)}
                    </td>
                    <td className="px-gutter-sm py-2 font-mono text-mono-sm text-on-surface text-right tabular-nums">
                      {fr.roomCount}
                    </td>
                    <td className="px-gutter-sm py-2 font-mono text-mono-sm text-primary text-right tabular-nums">
                      {fr.builtUpAreaSqM.toFixed(1)}
                    </td>
                    <td className="px-gutter-sm py-2 font-mono text-mono-sm text-on-surface text-right tabular-nums">
                      {fr.pointCount}
                    </td>
                    <td className="px-gutter-sm py-2 font-mono text-mono-sm text-on-surface text-right tabular-nums">
                      {fr.wireCount}
                    </td>
                    <td className="px-gutter-md py-2 font-mono text-mono-sm text-secondary text-right tabular-nums">
                      {fr.loadWatts.toLocaleString('en-IN')} W
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Wire Length by Category Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-gutter-sm">
            {(Object.keys(WIRE_CATEGORY_LABELS) as WireCategory[]).map((cat) => (
              <div
                key={cat}
                className="bg-surface-container border border-outline-variant rounded-md px-gutter-md py-gutter-sm flex flex-col gap-0.5"
              >
                <span className="font-label text-[11px] text-on-surface-variant">
                  {WIRE_CATEGORY_LABELS[cat]}
                </span>
                <span className="font-mono text-mono-md text-primary tabular-nums">
                  {buildingSummary.wireLengthByCategory[cat].toFixed(1)} m
                </span>
              </div>
            ))}
          </div>

          {buildingSummary.issues.length > 0 && (
            <div className="bg-surface-container border border-outline-variant rounded-md p-gutter-md flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase text-secondary">
                Engineering Verification Notes ({buildingSummary.issues.length})
              </span>
              <ul className="space-y-1">
                {buildingSummary.issues.map((iss) => (
                  <li
                    key={iss.id}
                    className={`font-body text-body-sm ${
                      iss.severity === 'error' ? 'text-error' : 'text-on-surface-variant'
                    }`}
                  >
                    • {iss.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-surface-container border-t border-outline-variant">
        <div className="max-w-7xl mx-auto px-gutter-lg lg:px-gutter-xl py-gutter-lg flex flex-col sm:flex-row items-start sm:items-center justify-between gap-gutter-md">
          <div className="flex items-center gap-gutter-sm">
            <img
              src="/assets/aistudio/Create_favicon_and_transparent_p__21f5ae8d_2K_3f0575c9.png"
              alt="Blue Space logo"
              className="w-6 h-6 object-contain shrink-0"
            />
            <span className="font-mono text-mono-sm text-on-surface-variant uppercase">
              BLUE SPACE • DESIGN YOUR SPACE. POWER YOUR WORLD.
            </span>
          </div>
          <span className="font-mono text-mono-sm text-on-surface-variant">
            BOQ Estimates Exclusive of Civil Conduit Labor
          </span>
        </div>
      </footer>

      {/* Request Quotation Modal */}
      {showQuoteModal && (
        <div
          className="fixed inset-0 z-50 bg-deep-navy/80 flex items-center justify-center p-gutter-lg no-print"
          role="dialog"
          aria-modal="true"
          aria-labelledby="quote-modal-title"
        >
          <div className="w-full max-w-md bg-surface-container border border-outline rounded-lg overflow-hidden">
            <div className="px-gutter-xl py-gutter-lg border-b border-outline-variant flex items-center justify-between">
              <h3 id="quote-modal-title" className="font-headline text-headline-sm text-on-surface">
                Request Contractor Quotation
              </h3>
              <button
                type="button"
                onClick={() => setShowQuoteModal(false)}
                aria-label="Close modal"
                className="text-on-surface-variant hover:text-on-surface cursor-pointer"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            {quoteSubmitted ? (
              <div className="p-gutter-xl flex flex-col gap-gutter-md">
                <div className="flex items-center gap-gutter-sm text-success">
                  <span className="material-symbols-outlined text-[24px]">check_circle</span>
                  <span className="font-headline text-headline-sm text-on-surface">
                    Quotation Request Logged
                  </span>
                </div>
                <p className="font-body text-body-md text-on-surface-variant">
                  Engineering BOQ package <span className="font-mono text-primary">{project.refCode}</span> ({effectiveTotalPoints} points · {effectiveTotalKw.toFixed(2)} kW · {formatINR(effectiveTotalCost)}) has been queued for {clientName || 'your project'} in {clientCity}.
                </p>
                <div className="flex justify-end pt-gutter-sm">
                  <button
                    type="button"
                    onClick={() => setShowQuoteModal(false)}
                    className="px-gutter-lg py-gutter-sm rounded-sm bg-primary text-on-primary font-label text-label-md cursor-pointer"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleQuoteSubmit}>
                <div className="p-gutter-xl flex flex-col gap-gutter-md">
                  <div className="px-gutter-md py-gutter-sm rounded-sm bg-surface-container-low border border-outline-variant flex items-center justify-between">
                    <span className="font-body text-body-sm text-on-surface-variant">
                      {project.name} ({effectiveTotalPoints} pts)
                    </span>
                    <span className="font-mono text-mono-md text-secondary tabular-nums">
                      {formatINR(effectiveTotalCost)}
                    </span>
                  </div>
                  <label className="flex flex-col gap-gutter-xs">
                    <span className="font-label text-label-sm text-on-surface-variant">Full Name</span>
                    <input
                      type="text"
                      required
                      placeholder="Ananya Sharma"
                      value={clientName}
                      onChange={(e) => setClientName(e.target.value)}
                      className="w-full bg-surface border border-outline rounded-sm px-gutter-md py-gutter-sm font-body text-body-md text-on-surface focus:border-primary focus:outline-none"
                    />
                  </label>
                  <label className="flex flex-col gap-gutter-xs">
                    <span className="font-label text-label-sm text-on-surface-variant">Email Address</span>
                    <input
                      type="email"
                      required
                      placeholder="architect@studio.in"
                      value={clientEmail}
                      onChange={(e) => setClientEmail(e.target.value)}
                      className="w-full bg-surface border border-outline rounded-sm px-gutter-md py-gutter-sm font-body text-body-md text-on-surface focus:border-primary focus:outline-none"
                    />
                  </label>
                  <label className="flex flex-col gap-gutter-xs">
                    <span className="font-label text-label-sm text-on-surface-variant">Project City</span>
                    <input
                      type="text"
                      required
                      value={clientCity}
                      onChange={(e) => setClientCity(e.target.value)}
                      className="w-full bg-surface border border-outline rounded-sm px-gutter-md py-gutter-sm font-body text-body-md text-on-surface focus:border-primary focus:outline-none"
                    />
                  </label>
                </div>
                <div className="px-gutter-xl py-gutter-md border-t border-outline-variant bg-surface-container-low flex items-center justify-end gap-gutter-sm">
                  <button
                    type="button"
                    onClick={() => setShowQuoteModal(false)}
                    className="px-gutter-lg py-gutter-sm rounded-sm border border-outline text-on-surface-variant hover:text-on-surface font-label text-label-md cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-gutter-lg py-gutter-sm rounded-sm bg-secondary text-on-secondary font-label text-label-md hover:bg-on-secondary-container cursor-pointer"
                  >
                    Submit BOQ Request
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
      {/* Multi-Page PDF Drawing Package Export Modal */}
      <PdfExportModal
        open={pdfModalOpen}
        project={project}
        wireProcurementAllowancePct={wireAllowancePct}
        onClose={() => setPdfModalOpen(false)}
        onExported={(count) =>
          notify(`Exported ${count}-page Architectural & Electrical PDF Drawing Package.`)
        }
      />
    </div>
  );
};
