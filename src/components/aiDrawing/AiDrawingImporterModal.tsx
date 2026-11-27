import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cpu,
  FileText,
  Layers,
  Loader2,
  RotateCw,
  Ruler,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import {
  AiDrawingProviderStatus,
  AiDrawingType,
  CadCapabilitiesResponse,
  CalibrationConfig,
  DrawingLayerState,
  DrawingMeasurementUnit,
  DrawingProjectMetadata,
  IntermediateDrawingModel,
  NormalizedPoint,
  NormalizedRect,
  PdfVectorExtractionResult,
  SymbolMappingDefinition,
  SymbolTemplate,
  UploadedDrawingSource,
} from '../../types/aiDrawing';
import { ProjectData } from '../../types/design';
import {
  createDefaultDrawingLayers,
  deleteSymbolTemplate,
  loadSymbolMappings,
  loadSymbolTemplates,
  saveSymbolMappings,
  saveSymbolTemplate,
} from '../../services/symbolMappingStorage';
import {
  AiDrawingApiError,
  analyzeDrawingWithAi,
  fetchAiDrawingStatus,
} from '../../services/aiDrawingClient';
import {
  createCompactReferenceOverlayDataUrl,
  cropLegendSymbolDataUrl,
  extractBase64FromDataUrl,
  optimizeDrawingForAiAnalysis,
  renderPdfFilePage,
  renderPreprocessedDrawing,
  renderRasterImageFile,
  validateDrawingUploadBytes,
} from '../../utils/pdfImageRenderer';
import {
  buildVectorSeedModel,
  computeTwoPointCalibration,
  ConvertTo2DResult,
  createEmptyIntermediateModel,
  createUncalibratedConfig,
  evaluateReconstructionCompleteness,
  generateEditable2DProjectFromModel,
  mergeVectorAndAiModels,
  normalizeAiAnalysisResponse,
} from '../../utils/aiDrawingConverter';
import {
  buildAiVectorContext,
  extractPdfVectorData,
} from '../../utils/pdfVectorExtractor';
import { detectRasterWallsFromDataUrl } from '../../utils/rasterWallDetector';
import { downloadValidatedProjectDxf } from '../../utils/dxfExporter';
import { SymbolMappingManager } from './SymbolMappingManager';
import { DrawingReviewCanvas, ReviewCanvasMode } from './DrawingReviewCanvas';

interface AiDrawingImporterModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeProject?: ProjectData | null;
  activeFloor?: number;
  onImportComplete: (result: ConvertTo2DResult) => void;
  onNotify?: (type: 'success' | 'warning' | 'error' | 'info', message: string) => void;
}

const STEPS = [
  { id: 1, title: '1. Project Info' },
  { id: 2, title: '2. Upload Drawing' },
  { id: 3, title: '3. Symbol Mapping' },
  { id: 4, title: '4. AI Analysis & Scale' },
  { id: 5, title: '5. Review & Generate 2D' },
] as const;

const DRAWING_TYPES: AiDrawingType[] = [
  'Architectural Floor Plan',
  'Electrical Layout',
  'Lighting Layout',
  'Combined Architectural & Electrical',
  'Technical Drawing',
];

const UNIT_OPTIONS: Array<{ value: DrawingMeasurementUnit; label: string }> = [
  { value: 'm', label: 'Meters (m)' },
  { value: 'mm', label: 'Millimeters (mm)' },
  { value: 'cm', label: 'Centimeters (cm)' },
  { value: 'ft', label: 'Feet (ft)' },
  { value: 'in', label: 'Inches (in)' },
];

export const AiDrawingImporterModal: React.FC<AiDrawingImporterModalProps> = ({
  isOpen,
  onClose,
  activeProject,
  activeFloor = 1,
  onImportComplete,
  onNotify,
}) => {
  const [step, setStep] = useState<number>(1);
  const [metadata, setMetadata] = useState<DrawingProjectMetadata>(() => ({
    projectName: activeProject ? `${activeProject.name} (2D Import)` : 'Imported 2D Floor Plan',
    drawingType: 'Combined Architectural & Electrical',
    measurementUnit: activeProject?.site.units === 'ft' ? 'ft' : 'm',
    scaleLabel: '',
    defaultCeilingHeightM: 3.0,
    defaultWallThicknessM: 0.15,
    targetFloor: activeFloor,
    importTarget: activeProject ? 'merge-active-floor' : 'new-project',
    notes: '',
  }));

  // Original uploaded File reference (preserved unmodified)
  const originalFileRef = useRef<File | null>(null);
  const [source, setSource] = useState<UploadedDrawingSource | null>(null);
  const [vectorExtraction, setVectorExtraction] = useState<PdfVectorExtractionResult | null>(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Symbol definitions & reusable templates
  const [symbolMappings, setSymbolMappings] = useState<SymbolMappingDefinition[]>(() =>
    loadSymbolMappings()
  );
  const [symbolTemplates, setSymbolTemplates] = useState<SymbolTemplate[]>(() =>
    loadSymbolTemplates()
  );
  const [isCroppingLegend, setIsCroppingLegend] = useState(false);
  const [pendingCroppedSample, setPendingCroppedSample] = useState<string | null>(null);

  // AI provider & CAD export capabilities
  const [providerStatus, setProviderStatus] = useState<AiDrawingProviderStatus | null>(null);
  const [cadCapabilities, setCadCapabilities] = useState<CadCapabilitiesResponse | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Calibration, intermediate model, layers, and review canvas state
  const [calibration, setCalibration] = useState<CalibrationConfig>(() =>
    createUncalibratedConfig(1000, 750, 'm')
  );
  const [pendingCalPoints, setPendingCalPoints] = useState<{
    pointA: NormalizedPoint;
    pointB: NormalizedPoint;
  } | null>(null);
  const [calDistanceInput, setCalDistanceInput] = useState('');
  const [calUnitInput, setCalUnitInput] = useState<DrawingMeasurementUnit>('m');
  const [calError, setCalError] = useState<string | null>(null);

  const [model, setModel] = useState<IntermediateDrawingModel>(() => createEmptyIntermediateModel(1));
  const [layers, setLayers] = useState<DrawingLayerState[]>(() => createDefaultDrawingLayers());
  const [reviewMode, setReviewMode] = useState<ReviewCanvasMode>('select');

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Fetch backend AI availability & CAD export capabilities when modal opens
  useEffect(() => {
    if (!isOpen) return;
    const ctrl = new AbortController();
    fetchAiDrawingStatus(ctrl.signal)
      .then((status) => setProviderStatus(status))
      .catch(() => {});
    fetch('/api/cad/capabilities', { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && typeof data.dxfReady === 'boolean') {
          setCadCapabilities(data as CadCapabilitiesResponse);
        }
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [isOpen]);

  // Keep target floor synced if modal re-opens on a different floor
  useEffect(() => {
    if (isOpen) {
      setMetadata((prev) => ({
        ...prev,
        targetFloor: activeFloor,
        importTarget: activeProject ? prev.importTarget : 'new-project',
      }));
    }
  }, [isOpen, activeFloor, activeProject]);

  // Keep calibration unit synced with metadata unit initially
  useEffect(() => {
    setCalUnitInput(metadata.measurementUnit);
  }, [metadata.measurementUnit]);

  const stats = useMemo(() => {
    const items = [
      ...model.walls,
      ...model.rooms,
      ...model.openings,
      ...model.columns,
      ...model.staircases,
      ...(model.furniture ?? []),
      ...model.symbols,
      ...model.wiringPaths,
      ...model.dimensions,
      ...model.textLabels,
    ];
    return {
      total: items.length,
      approved: items.filter((i) => i.status === 'approved').length,
      uncertain: items.filter((i) => i.status === 'uncertain').length,
      rejected: items.filter((i) => i.status === 'rejected').length,
    };
  }, [model]);

  const qualityReport = useMemo(
    () => evaluateReconstructionCompleteness(model, calibration, metadata.drawingType),
    [model, calibration, metadata.drawingType]
  );

  if (!isOpen) return null;

  const handleUpdateMappings = (next: SymbolMappingDefinition[]) => {
    const saved = saveSymbolMappings(next);
    setSymbolMappings(saved);
  };

  const handleSaveTemplate = (name: string, description: string) => {
    const nextTemplates = saveSymbolTemplate({
      name,
      description,
      drawingType: metadata.drawingType,
      symbols: symbolMappings,
    });
    setSymbolTemplates(nextTemplates);
    onNotify?.('success', `Saved symbol template "${name}".`);
  };

  const handleLoadTemplate = (template: SymbolTemplate, mode: 'replace' | 'merge') => {
    if (mode === 'replace') {
      handleUpdateMappings(template.symbols);
      onNotify?.('success', `Loaded symbol template "${template.name}".`);
      return;
    }
    const existingCodes = new Set(symbolMappings.map((s) => s.code.toLowerCase()));
    const toAppend = template.symbols
      .filter((s) => !existingCodes.has(s.code.toLowerCase()))
      .map((s) => ({
        ...s,
        id: `sym-map-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      }));
    handleUpdateMappings([...symbolMappings, ...toAppend]);
    onNotify?.('success', `Appended ${toAppend.length} symbols from "${template.name}".`);
  };

  const handleDeleteTemplate = (templateId: string) => {
    setSymbolTemplates(deleteSymbolTemplate(templateId));
    onNotify?.('info', 'Deleted symbol template.');
  };

  const handleSelectFile = async (file: File) => {
    setUploadError(null);
    setIsLoadingFile(true);
    try {
      const headBytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
      const validation = validateDrawingUploadBytes(headBytes, {
        name: file.name,
        type: file.type,
        size: file.size,
      });
      if (!validation.valid || !validation.mimeType) {
        setUploadError(validation.error || 'Unsupported file.');
        return;
      }

      // Preserve original File reference untouched
      originalFileRef.current = file;

      const rendered =
        validation.mimeType === 'application/pdf'
          ? await renderPdfFilePage(file, 1)
          : await renderRasterImageFile(file);

      let extractedVectors: PdfVectorExtractionResult | null = null;
      if (validation.mimeType === 'application/pdf') {
        try {
          extractedVectors = await extractPdfVectorData(file, rendered.pageNumber, {
            rotationDeg: 0,
            cropRect: null,
            defaultUnit: metadata.measurementUnit,
          });
        } catch {
          extractedVectors = null;
        }
      }
      // For scanned PDFs or raster PNG/JPG uploads, run pixel-level CV wall pre-detection
      if (!extractedVectors || extractedVectors.sourceKind !== 'vector-pdf') {
        try {
          const rasterWalls = await detectRasterWallsFromDataUrl(
            rendered.dataUrl,
            validation.mimeType === 'application/pdf' ? 'scanned-pdf' : 'raster-image',
            rendered.pageNumber
          );
          if (rasterWalls.wallSegments.length > 0) {
            extractedVectors = extractedVectors
              ? {
                  ...extractedVectors,
                  wallSegments: rasterWalls.wallSegments,
                  angledSegmentCount: rasterWalls.angledSegmentCount,
                  warnings: [
                    ...extractedVectors.warnings,
                    `${rasterWalls.wallSegments.length} raster CV candidate wall segments traced from scanned drawing (${rasterWalls.angledSegmentCount} angled).`,
                  ],
                }
              : rasterWalls;
          }
        } catch {
          // Keep null or scanned-pdf stub if raster CV fails
        }
      }
      setVectorExtraction(extractedVectors);

      const newSource: UploadedDrawingSource = {
        id: `src-${Date.now()}`,
        originalFileName: file.name,
        mimeType: validation.mimeType,
        fileSizeBytes: file.size,
        pageCount: rendered.pageCount,
        selectedPage: rendered.pageNumber,
        imageWidthPx: rendered.widthPx,
        imageHeightPx: rendered.heightPx,
        originalPageDataUrl: rendered.dataUrl,
        preparedImageDataUrl: rendered.dataUrl,
        rotationDeg: 0,
        brightness: 100,
        contrast: 100,
        cropRect: null,
        uploadedAt: new Date().toISOString(),
      };

      setSource(newSource);
      setCalibration(
        createUncalibratedConfig(rendered.widthPx, rendered.heightPx, metadata.measurementUnit)
      );
      setModel(
        extractedVectors && extractedVectors.wallSegments.length > 0
          ? buildVectorSeedModel(extractedVectors, symbolMappings)
          : createEmptyIntermediateModel(rendered.pageNumber)
      );
      setAnalysisError(null);

      // Update default project name & detected scale if untouched
      setMetadata((prev) => ({
        ...prev,
        projectName:
          prev.projectName === 'Imported 2D Floor Plan'
            ? file.name.replace(/\.(pdf|png|jpe?g)$/i, '')
            : prev.projectName,
        scaleLabel: prev.scaleLabel || extractedVectors?.titleBlock.scaleText || '',
      }));

      onNotify?.(
        'success',
        extractedVectors && extractedVectors.sourceKind === 'vector-pdf'
          ? `Loaded vector PDF "${file.name}": ${extractedVectors.wallSegments.length} vector wall segments (${extractedVectors.angledSegmentCount} angled, ${extractedVectors.curvedSegmentCount} curved), ${extractedVectors.columns?.length ?? 0} columns & ${extractedVectors.textItems.length} text annotations extracted.`
          : extractedVectors && extractedVectors.wallSegments.length > 0
            ? `Loaded "${file.name}": traced ${extractedVectors.wallSegments.length} candidate raster CV wall segments (${extractedVectors.angledSegmentCount} angled) ready for Vision AI & review.`
            : `Loaded "${file.name}" (${rendered.pageCount} page${rendered.pageCount > 1 ? 's' : ''}).`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load drawing file.';
      setUploadError(msg);
      onNotify?.('error', msg);
    } finally {
      setIsLoadingFile(false);
    }
  };

  const handleChangePdfPage = async (targetPage: number) => {
    const file = originalFileRef.current;
    if (!file || !source || source.mimeType !== 'application/pdf') return;
    const clamped = Math.max(1, Math.min(source.pageCount, targetPage));
    if (clamped === source.selectedPage) return;

    setIsLoadingFile(true);
    try {
      const rendered = await renderPdfFilePage(file, clamped);
      let extractedVectors: PdfVectorExtractionResult | null = null;
      try {
        extractedVectors = await extractPdfVectorData(file, rendered.pageNumber, {
          rotationDeg: 0,
          cropRect: null,
          defaultUnit: metadata.measurementUnit,
        });
      } catch {
        extractedVectors = null;
      }
      setVectorExtraction(extractedVectors);
      setSource({
        ...source,
        selectedPage: rendered.pageNumber,
        imageWidthPx: rendered.widthPx,
        imageHeightPx: rendered.heightPx,
        originalPageDataUrl: rendered.dataUrl,
        preparedImageDataUrl: rendered.dataUrl,
        rotationDeg: 0,
        brightness: 100,
        contrast: 100,
        cropRect: null,
      });
      setCalibration(
        createUncalibratedConfig(rendered.widthPx, rendered.heightPx, metadata.measurementUnit)
      );
      setModel(
        extractedVectors && extractedVectors.sourceKind === 'vector-pdf'
          ? buildVectorSeedModel(extractedVectors, symbolMappings)
          : createEmptyIntermediateModel(rendered.pageNumber)
      );
    } catch {
      onNotify?.('error', 'Could not render the selected PDF page.');
    } finally {
      setIsLoadingFile(false);
    }
  };

  const applyImagePreprocessing = async (next: {
    rotationDeg: 0 | 90 | 180 | 270;
    brightness: number;
    contrast: number;
    cropRect: NormalizedRect | null;
  }) => {
    if (!source) return;
    setIsLoadingFile(true);
    try {
      const processed = await renderPreprocessedDrawing(source.originalPageDataUrl, next);
      setSource({
        ...source,
        ...next,
        preparedImageDataUrl: processed.dataUrl,
        imageWidthPx: processed.widthPx,
        imageHeightPx: processed.heightPx,
      });
      // Re-align vector PDF extraction whenever rotation or crop changes
      const file = originalFileRef.current;
      if (file && source.mimeType === 'application/pdf') {
        try {
          const updatedVec = await extractPdfVectorData(file, source.selectedPage, {
            rotationDeg: next.rotationDeg,
            cropRect: next.cropRect,
            defaultUnit: metadata.measurementUnit,
          });
          setVectorExtraction(updatedVec);
          if (updatedVec.sourceKind === 'vector-pdf') {
            setModel(buildVectorSeedModel(updatedVec, symbolMappings));
          }
        } catch {
          // Keep previous vector extraction if re-extraction fails
        }
      }
    } catch {
      onNotify?.('error', 'Failed to apply drawing adjustments.');
    } finally {
      setIsLoadingFile(false);
    }
  };

  const handleLegendCropRect = async (rect: NormalizedRect) => {
    if (!source) return;
    try {
      const croppedUrl = await cropLegendSymbolDataUrl(source.preparedImageDataUrl, rect);
      setPendingCroppedSample(croppedUrl);
      setIsCroppingLegend(false);
      setReviewMode('select');
      onNotify?.('success', 'Symbol cropped from drawing legend. Fill in name & category to save.');
    } catch {
      onNotify?.('error', 'Could not crop symbol from drawing.');
    }
  };

  const handleExtractVectorPdfDirectly = () => {
    if (!vectorExtraction || vectorExtraction.sourceKind !== 'vector-pdf') {
      onNotify?.('warning', 'This file does not contain extractable vector PDF paths. Use Hybrid Vision AI analysis instead.');
      return;
    }
    const seed = buildVectorSeedModel(vectorExtraction, symbolMappings);
    setModel(seed);
    onNotify?.(
      'success',
      `Direct PDF vector extraction ready: ${seed.walls.length} wall segments (${vectorExtraction.angledSegmentCount} angled, ${vectorExtraction.curvedSegmentCount} curved), ${seed.textLabels.length} labels, ${seed.symbols.length} tagged symbols.`
    );
    setStep(5);
  };

  const handleRunAiAnalysis = async () => {
    if (!source) return;

    abortControllerRef.current?.abort();
    const ctrl = new AbortController();
    abortControllerRef.current = ctrl;

    setIsAnalyzing(true);
    setAnalysisError(null);

    try {
      const optimized = await optimizeDrawingForAiAnalysis(source.preparedImageDataUrl, 2400);
      const enabledSymbols = symbolMappings.filter((s) => s.enabled);
      const vectorContext = buildAiVectorContext(vectorExtraction);
      const response = await analyzeDrawingWithAi(
        {
          imageBase64: optimized.base64,
          mimeType: optimized.mimeType,
          imageWidthPx: optimized.widthPx,
          imageHeightPx: optimized.heightPx,
          pageNumber: source.selectedPage,
          metadata: {
            projectName: metadata.projectName,
            drawingType: metadata.drawingType,
            measurementUnit: metadata.measurementUnit,
            scaleLabel: metadata.scaleLabel,
            notes: metadata.notes,
          },
          vectorContext,
          symbolDefinitions: enabledSymbols.map((s) => {
            const sample = s.sampleImageDataUrl
              ? extractBase64FromDataUrl(s.sampleImageDataUrl)
              : null;
            return {
              id: s.id,
              name: s.name,
              code: s.code,
              domain: s.domain,
              electricalItemType: s.electricalItemType,
              description: s.description,
              visualNotes: s.visualNotes,
              sampleImageBase64: sample?.base64,
              sampleMimeType: sample?.mimeType,
            };
          }),
        },
        ctrl.signal
      );

      const normalized = normalizeAiAnalysisResponse(
        response.rawAnalysis,
        symbolMappings,
        source.selectedPage,
        response.model,
        response.analyzedAt
      );
      const fused = mergeVectorAndAiModels(vectorExtraction, normalized, symbolMappings);
      setModel(fused);

      if (fused.titleBlock.scaleText && !metadata.scaleLabel) {
        setMetadata((prev) => ({ ...prev, scaleLabel: fused.titleBlock.scaleText || '' }));
      }

      onNotify?.(
        'success',
        `Reconstruction complete: ${fused.walls.length} walls, ${fused.rooms.length} rooms, ${fused.openings.length} openings, ${(fused.furniture ?? []).length} furniture, ${fused.symbols.length} symbols detected.`
      );
      setStep(5);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setAnalysisError('AI analysis was cancelled.');
        return;
      }
      const message =
        err instanceof AiDrawingApiError
          ? err.message
          : err instanceof Error
          ? err.message
          : 'AI drawing analysis failed.';
      setAnalysisError(message);
      onNotify?.('error', message);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleCancelAiAnalysis = () => {
    abortControllerRef.current?.abort();
    setIsAnalyzing(false);
  };

  const handleApplyCalibration = (e: React.FormEvent) => {
    e.preventDefault();
    if (!source || !pendingCalPoints) return;
    setCalError(null);
    const val = Number(calDistanceInput);
    const result = computeTwoPointCalibration({
      pointA: pendingCalPoints.pointA,
      pointB: pendingCalPoints.pointB,
      knownDistanceValue: val,
      unit: calUnitInput,
      imageWidthPx: source.imageWidthPx,
      imageHeightPx: source.imageHeightPx,
    });
    if (!result.ok) {
      setCalError(result.error);
      return;
    }
    setCalibration(result.calibration);
    setPendingCalPoints(null);
    setCalDistanceInput('');
    setReviewMode('select');
    onNotify?.('success', result.calibration.note);
  };

  const handleBulkStatusForUncertain = (targetStatus: 'approved' | 'rejected') => {
    const update = <T extends { status: 'approved' | 'uncertain' | 'rejected' }>(arr: T[]): T[] =>
      arr.map((item) => (item.status === 'uncertain' ? { ...item, status: targetStatus } : item));
    setModel({
      ...model,
      walls: update(model.walls),
      rooms: update(model.rooms),
      openings: update(model.openings),
      columns: update(model.columns),
      staircases: update(model.staircases),
      furniture: update(model.furniture ?? []),
      symbols: update(model.symbols),
      wiringPaths: update(model.wiringPaths),
      dimensions: update(model.dimensions),
      textLabels: update(model.textLabels),
    });
  };

  const handleExportPreviewDxf = () => {
    if (!source) return;
    if (qualityReport.status !== 'ready') {
      onNotify?.(
        'warning',
        qualityReport.blockers[0] ||
          'Approve or trace complete wall geometry before exporting DXF.'
      );
      return;
    }
    const built = generateEditable2DProjectFromModel({
      model,
      calibration,
      metadata,
      source: {
        originalFileName: source.originalFileName,
        mimeType: source.mimeType,
        selectedPage: source.selectedPage,
      },
      symbolMappings,
      layers,
      existingProject: activeProject ?? undefined,
    });
    const res = downloadValidatedProjectDxf(built.project, metadata.targetFloor);
    if (!res.ok) {
      onNotify?.('error', res.error);
      return;
    }
    onNotify?.(
      'success',
      `Exported validated AutoCAD DXF (${res.bundle.validation.entityCount} CAD entities across ${res.bundle.validation.layerNames.length} layers).`
    );
  };

  const handleGenerate2DModel = async () => {
    if (!source || isGenerating) return;
    if (qualityReport.status !== 'ready') {
      onNotify?.(
        'warning',
        qualityReport.blockers[0] ||
          'Reconstruction is incomplete. Trace or extract the full building outline and internal walls before generating the 2D CAD model.'
      );
      return;
    }

    setIsGenerating(true);
    try {
      const compactOverlay = await createCompactReferenceOverlayDataUrl(source.preparedImageDataUrl, 1400);
      const result = generateEditable2DProjectFromModel({
        model,
        calibration,
        metadata,
        source: {
          originalFileName: source.originalFileName,
          mimeType: source.mimeType,
          selectedPage: source.selectedPage,
        },
        symbolMappings,
        layers,
        existingProject: activeProject ?? undefined,
        referenceOverlay: {
          dataUrl: compactOverlay.dataUrl,
          widthPx: compactOverlay.widthPx,
          heightPx: compactOverlay.heightPx,
          opacity: 0.45,
          visible: true,
        },
      });

      onImportComplete(result);
      onClose();
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-label="AI Drawing to 2D Importer"
    >
      <div className="bg-[#0d1117] border border-slate-700/80 rounded-2xl w-full max-w-6xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between gap-3 bg-[#11161f]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center shrink-0">
              <Sparkles className="w-4 h-4 text-sky-400" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-bold text-white truncate">
                AI Drawing to 2D — PDF / Image Importer
              </h2>
              <p className="text-[11px] text-slate-400 truncate">
                Convert architectural or electrical drawings into editable 2D Blue Space CAD objects
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              abortControllerRef.current?.abort();
              onClose();
            }}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
            aria-label="Close AI Drawing Importer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step Indicator */}
        <div className="px-5 py-2.5 border-b border-slate-800 bg-[#0b0f16] flex items-center gap-1.5 overflow-x-auto">
          {STEPS.map((s) => {
            const isActive = step === s.id;
            const isCompleted = step > s.id;
            const isLockedStep = s.id > 2 && !source;
            return (
              <button
                key={s.id}
                type="button"
                disabled={isLockedStep}
                onClick={() => setStep(s.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition flex items-center gap-1.5 ${
                  isActive
                    ? 'bg-sky-600 text-white'
                    : isCompleted
                    ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                    : 'bg-slate-900 text-slate-400 border border-slate-800 hover:text-slate-200 disabled:opacity-40'
                }`}
              >
                {isCompleted && <CheckCircle2 className="w-3.5 h-3.5" />}
                {s.title}
              </button>
            );
          })}
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* STEP 1: PROJECT & DRAWING METADATA */}
          {step === 1 && (
            <div className="max-w-3xl mx-auto space-y-4">
              <div className="bg-[#11161f] border border-slate-800 rounded-xl p-5 space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-white">Drawing & Target Project Info</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Define the project name, drawing type, measurement units, and whether to create a new Blue Space project or merge into the active floor.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">Project Name *</label>
                    <input
                      type="text"
                      value={metadata.projectName}
                      onChange={(e) => setMetadata({ ...metadata, projectName: e.target.value })}
                      maxLength={120}
                      className="w-full px-3 py-2 text-xs rounded-lg bg-[#0d1117] border border-slate-700 text-white focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">Drawing Type</label>
                    <select
                      value={metadata.drawingType}
                      onChange={(e) =>
                        setMetadata({ ...metadata, drawingType: e.target.value as AiDrawingType })
                      }
                      className="w-full px-3 py-2 text-xs rounded-lg bg-[#0d1117] border border-slate-700 text-white focus:border-sky-500 focus:outline-none"
                    >
                      {DRAWING_TYPES.map((dt) => (
                        <option key={dt} value={dt}>
                          {dt}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-300 mb-1">Measurement Unit</label>
                    <select
                      value={metadata.measurementUnit}
                      onChange={(e) =>
                        setMetadata({
                          ...metadata,
                          measurementUnit: e.target.value as DrawingMeasurementUnit,
                        })
                      }
                      className="w-full px-3 py-2 text-xs rounded-lg bg-[#0d1117] border border-slate-700 text-white focus:border-sky-500 focus:outline-none"
                    >
                      {UNIT_OPTIONS.map((u) => (
                        <option key={u.value} value={u.value}>
                          {u.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-300 mb-1">
                      Declared Drawing Scale (Optional)
                    </label>
                    <input
                      type="text"
                      value={metadata.scaleLabel}
                      onChange={(e) => setMetadata({ ...metadata, scaleLabel: e.target.value })}
                      placeholder='e.g. 1:100 or 1/4" = 1&apos;-0"'
                      maxLength={40}
                      className="w-full px-3 py-2 text-xs rounded-lg bg-[#0d1117] border border-slate-700 text-white focus:border-sky-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-slate-300 mb-1">
                      Default Wall Thickness (m)
                    </label>
                    <input
                      type="number"
                      step={0.01}
                      min={0.1}
                      max={0.5}
                      value={metadata.defaultWallThicknessM}
                      onChange={(e) =>
                        setMetadata({
                          ...metadata,
                          defaultWallThicknessM: Number(e.target.value) || 0.15,
                        })
                      }
                      className="w-full px-3 py-2 text-xs rounded-lg bg-[#0d1117] border border-slate-700 text-white focus:border-sky-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-slate-300 mb-1">
                      Target Destination
                    </label>
                    <select
                      value={metadata.importTarget}
                      onChange={(e) =>
                        setMetadata({
                          ...metadata,
                          importTarget: e.target.value as DrawingProjectMetadata['importTarget'],
                        })
                      }
                      className="w-full px-3 py-2 text-xs rounded-lg bg-[#0d1117] border border-slate-700 text-white focus:border-sky-500 focus:outline-none"
                    >
                      <option value="new-project">Create New Blue Space Project</option>
                      {activeProject && (
                        <option value="merge-active-floor">
                          Merge into Active Project ({activeProject.name} — Floor {metadata.targetFloor})
                        </option>
                      )}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-slate-300 mb-1">
                    Drawing Notes / Hints for AI (Optional)
                  </label>
                  <textarea
                    rows={2}
                    value={metadata.notes}
                    onChange={(e) => setMetadata({ ...metadata, notes: e.target.value })}
                    placeholder="Optional notes about title block, consultant conventions, or areas to focus on"
                    maxLength={500}
                    className="w-full px-3 py-2 text-xs rounded-lg bg-[#0d1117] border border-slate-700 text-white focus:border-sky-500 focus:outline-none"
                  />
                </div>
              </div>
            </div>
          )}

          {/* STEP 2: UPLOAD & PREPARE DRAWING */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                <div className="lg:col-span-4 space-y-3">
                  {/* Dropzone */}
                  <div
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const file = e.dataTransfer.files?.[0];
                      if (file) void handleSelectFile(file);
                    }}
                    className="bg-[#11161f] border-2 border-dashed border-slate-700 hover:border-sky-500/70 rounded-xl p-5 text-center space-y-2 transition"
                  >
                    <Upload className="w-8 h-8 text-sky-400 mx-auto" />
                    <div className="text-xs font-semibold text-white">
                      Upload PDF, PNG, or JPG Drawing
                    </div>
                    <p className="text-[11px] text-slate-400">
                      Max 25 MB. Original uploaded file is preserved untouched.
                    </p>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium"
                    >
                      Choose Drawing File
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) void handleSelectFile(file);
                      }}
                      className="hidden"
                    />
                  </div>

                  {uploadError && (
                    <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{uploadError}</span>
                    </div>
                  )}

                  {source && (
                    <div className="bg-[#11161f] border border-slate-800 rounded-xl p-4 space-y-3">
                      <div className="flex items-start gap-2">
                        <FileText className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-white truncate">
                            {source.originalFileName}
                          </div>
                          <div className="text-[11px] text-slate-400">
                            {(source.fileSizeBytes / 1024).toFixed(0)} KB · {source.imageWidthPx} ×{' '}
                            {source.imageHeightPx} px
                          </div>
                        </div>
                      </div>

                      {/* Multi-page PDF selector */}
                      {source.pageCount > 1 && (
                        <div className="pt-2 border-t border-slate-800 space-y-1.5">
                          <label className="block text-[11px] font-medium text-slate-300">
                            PDF Page Selection ({source.selectedPage} of {source.pageCount})
                          </label>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={source.selectedPage <= 1 || isLoadingFile}
                              onClick={() => void handleChangePdfPage(source.selectedPage - 1)}
                              className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40"
                            >
                              <ChevronLeft className="w-4 h-4" />
                            </button>
                            <input
                              type="number"
                              min={1}
                              max={source.pageCount}
                              value={source.selectedPage}
                              onChange={(e) =>
                                void handleChangePdfPage(Number(e.target.value) || 1)
                              }
                              className="w-16 text-center px-2 py-1 text-xs rounded bg-[#0d1117] border border-slate-700 text-white"
                            />
                            <button
                              type="button"
                              disabled={source.selectedPage >= source.pageCount || isLoadingFile}
                              onClick={() => void handleChangePdfPage(source.selectedPage + 1)}
                              className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40"
                            >
                              <ChevronRight className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Drawing preparation controls */}
                      <div className="pt-2 border-t border-slate-800 space-y-2.5">
                        <div className="text-[11px] font-medium text-slate-300">
                          Prepare Drawing (Non-Destructive)
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={isLoadingFile}
                            onClick={() =>
                              void applyImagePreprocessing({
                                rotationDeg: (((source.rotationDeg + 90) % 360) as 0 | 90 | 180 | 270),
                                brightness: source.brightness,
                                contrast: source.contrast,
                                cropRect: source.cropRect,
                              })
                            }
                            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 flex items-center gap-1.5"
                          >
                            <RotateCw className="w-3.5 h-3.5" /> Rotate 90° ({source.rotationDeg}°)
                          </button>
                          <button
                            type="button"
                            disabled={isLoadingFile}
                            onClick={() =>
                              void applyImagePreprocessing({
                                rotationDeg: 0,
                                brightness: 100,
                                contrast: 100,
                                cropRect: null,
                              })
                            }
                            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-300"
                          >
                            Reset
                          </button>
                        </div>

                        <label className="block text-[11px] text-slate-400">
                          Brightness: {source.brightness}%
                          <input
                            type="range"
                            min={60}
                            max={140}
                            value={source.brightness}
                            onChange={(e) =>
                              void applyImagePreprocessing({
                                rotationDeg: source.rotationDeg,
                                brightness: Number(e.target.value),
                                contrast: source.contrast,
                                cropRect: source.cropRect,
                              })
                            }
                            className="w-full accent-sky-500 mt-1"
                          />
                        </label>

                        <label className="block text-[11px] text-slate-400">
                          Contrast: {source.contrast}%
                          <input
                            type="range"
                            min={60}
                            max={150}
                            value={source.contrast}
                            onChange={(e) =>
                              void applyImagePreprocessing({
                                rotationDeg: source.rotationDeg,
                                brightness: source.brightness,
                                contrast: Number(e.target.value),
                                cropRect: source.cropRect,
                              })
                            }
                            className="w-full accent-sky-500 mt-1"
                          />
                        </label>
                      </div>
                    </div>
                  )}
                </div>

                {/* Live Drawing Preview */}
                <div className="lg:col-span-8 bg-[#090d14] border border-slate-800 rounded-xl p-3 flex items-center justify-center min-h-[380px] max-h-[500px] overflow-auto">
                  {isLoadingFile ? (
                    <div className="flex flex-col items-center gap-2 text-slate-300 text-xs">
                      <Loader2 className="w-6 h-6 animate-spin text-sky-400" />
                      Rendering drawing page...
                    </div>
                  ) : source ? (
                    <img
                      src={source.preparedImageDataUrl}
                      alt={source.originalFileName}
                      className="max-w-full max-h-[460px] object-contain rounded border border-slate-700 bg-white"
                    />
                  ) : (
                    <div className="text-center text-slate-500 text-xs space-y-1">
                      <p className="font-medium text-slate-400">Drawing Preview</p>
                      <p>Upload a PDF, PNG, or JPG file on the left to inspect and prepare it.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: SYMBOL DEFINITION & LEGEND MAPPING */}
          {step === 3 && (
            <div className="space-y-3">
              {isCroppingLegend && source ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between bg-sky-500/10 border border-sky-500/30 rounded-lg px-3 py-2 text-xs text-sky-200">
                    <span>
                      Drag a rectangle directly over a symbol in your uploaded drawing legend to capture it.
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setIsCroppingLegend(false);
                        setReviewMode('select');
                      }}
                      className="px-2.5 py-1 rounded bg-slate-800 text-white text-xs"
                    >
                      Back to Symbol Form
                    </button>
                  </div>
                  <DrawingReviewCanvas
                    source={source}
                    model={model}
                    calibration={calibration}
                    symbolMappings={symbolMappings}
                    layers={layers}
                    mode="crop-legend"
                    onChangeMode={() => {}}
                    onChangeModel={setModel}
                    onChangeLayers={setLayers}
                    onLegendCropRectPicked={(rect) => void handleLegendCropRect(rect)}
                    showInspector={false}
                  />
                </div>
              ) : (
                <SymbolMappingManager
                  mappings={symbolMappings}
                  templates={symbolTemplates}
                  drawingType={metadata.drawingType}
                  hasUploadedDrawing={Boolean(source)}
                  pendingCroppedSampleDataUrl={pendingCroppedSample}
                  onClearPendingCroppedSample={() => setPendingCroppedSample(null)}
                  onRequestLegendCrop={() => {
                    setIsCroppingLegend(true);
                    setReviewMode('crop-legend');
                  }}
                  onChangeMappings={handleUpdateMappings}
                  onSaveTemplate={handleSaveTemplate}
                  onLoadTemplate={handleLoadTemplate}
                  onDeleteTemplate={handleDeleteTemplate}
                  onNotify={onNotify}
                />
              )}
            </div>
          )}

          {/* STEP 4: AI ANALYSIS & SCALE CALIBRATION */}
          {step === 4 && source && (
            <div className="max-w-4xl mx-auto space-y-4">
              {/* Vector PDF / Raster CV Pre-Extraction Status Banner */}
              {vectorExtraction && (
                <div
                  className={`rounded-xl p-4 border text-xs flex flex-wrap items-center justify-between gap-3 ${
                    vectorExtraction.sourceKind === 'vector-pdf'
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                      : 'bg-sky-500/10 border-sky-500/30 text-sky-200'
                  }`}
                >
                  <div>
                    <div className="font-semibold">
                      {vectorExtraction.sourceKind === 'vector-pdf'
                        ? `Native Vector PDF Detected — ${vectorExtraction.wallSegments.length} wall segment(s) & ${vectorExtraction.columns?.length ?? 0} column(s) extracted directly`
                        : vectorExtraction.wallSegments.length > 0
                          ? `Scanned / Raster CV Pre-Detection Active — ${vectorExtraction.wallSegments.length} candidate wall segment(s) traced`
                          : 'Scanned / Raster Drawing Detected — High-Resolution Vision AI Mode'}
                    </div>
                    <div className="text-[11px] opacity-85 mt-0.5">
                      {vectorExtraction.sourceKind === 'vector-pdf'
                        ? `Includes ${vectorExtraction.angledSegmentCount} angled wall(s), ${vectorExtraction.curvedSegmentCount} curved chord(s), ${vectorExtraction.textItems.length} PDF text annotation(s), ${vectorExtraction.dimensions.length} dimension(s), ${vectorExtraction.legendEntries.length} legend entry(ies)${(vectorExtraction.filteredNoiseCount ?? 0) > 0 ? `, and ${vectorExtraction.filteredNoiseCount} legend/title-block stroke(s) filtered` : ''}.`
                        : vectorExtraction.wallSegments.length > 0
                          ? `Pixel-traced ${vectorExtraction.wallSegments.length} candidate walls (${vectorExtraction.angledSegmentCount} angled) marked Uncertain for review — run Vision AI to identify rooms, openings, dimensions, and mapped electrical symbols.`
                          : 'No native CAD vector strokes found; high-resolution (2400px) image + Vision AI will reconstruct geometry.'}
                    </div>
                  </div>
                  {vectorExtraction.sourceKind === 'vector-pdf' && (
                    <button
                      type="button"
                      onClick={handleExtractVectorPdfDirectly}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shrink-0"
                    >
                      Inspect Direct Vector CAD Now
                    </button>
                  )}
                </div>
              )}

              {/* Server Vision AI Panel */}
              <div className="bg-[#11161f] border border-slate-800 rounded-xl p-5 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-sky-400" />
                      Hybrid Vector PDF + Vision AI Reconstruction
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Preserves exact angled/curved PDF walls and fuses semantic rooms (polygons), doors, windows, columns, staircases, furniture, dimensions, and {symbolMappings.filter((s) => s.enabled).length} mapped symbol(s).
                    </p>
                  </div>
                  {providerStatus && (
                    <span
                      className={`px-2.5 py-1 rounded-md text-[11px] font-medium shrink-0 ${
                        providerStatus.configured
                          ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                          : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                      }`}
                    >
                      {providerStatus.configured ? 'Vision AI Ready' : 'Server AI Not Configured'}
                    </span>
                  )}
                </div>

                {providerStatus && !providerStatus.configured && (
                  <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
                    <div>
                      <div className="font-semibold">Automatic AI Analysis Requires Server Configuration</div>
                      <p className="text-amber-200/80 mt-0.5">{providerStatus.message}</p>
                    </div>
                  </div>
                )}

                {analysisError && (
                  <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-200 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
                    <span>{analysisError}</span>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2.5 pt-1">
                  <button
                    type="button"
                    disabled={isAnalyzing}
                    onClick={() => void handleRunAiAnalysis()}
                    className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-2"
                  >
                    {isAnalyzing ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Reconstructing CAD Geometry...
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4" />
                        {vectorExtraction?.sourceKind === 'vector-pdf'
                          ? 'Run Hybrid Vector + Vision AI Analysis'
                          : 'Run High-Res Vision AI Analysis'}
                      </>
                    )}
                  </button>

                  {isAnalyzing && (
                    <button
                      type="button"
                      onClick={handleCancelAiAnalysis}
                      className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium"
                    >
                      Cancel Analysis
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={isAnalyzing}
                    onClick={() => setStep(5)}
                    className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium"
                  >
                    Open Interactive Review & Calibration
                  </button>
                </div>
              </div>

              {/* Scale Calibration Summary Card */}
              <div className="bg-[#11161f] border border-slate-800 rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                      <Ruler className="w-4 h-4 text-emerald-400" />
                      Scale & Unit Calibration
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">{calibration.note}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setReviewMode('calibrate');
                      setStep(5);
                    }}
                    className="px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 text-xs font-medium shrink-0"
                  >
                    Open 2-Point Calibration Tool
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* STEP 5: INTERACTIVE REVIEW, CALIBRATION & GENERATE 2D */}
          {step === 5 && source && (
            <div className="space-y-3">
              {/* Top Status & Calibration Bar */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                <div className="md:col-span-7 bg-[#11161f] border border-slate-800 rounded-xl p-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <span className="text-emerald-400 font-semibold">
                      Approved: {stats.approved}
                    </span>
                    <span className="text-amber-400 font-semibold">
                      Uncertain: {stats.uncertain}
                    </span>
                    <span className="text-slate-400">Rejected: {stats.rejected}</span>
                  </div>
                  {stats.uncertain > 0 && (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleBulkStatusForUncertain('approved')}
                        className="px-2.5 py-1 rounded bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-emerald-300 text-[11px] font-medium"
                      >
                        Approve All Uncertain ({stats.uncertain})
                      </button>
                      <button
                        type="button"
                        onClick={() => handleBulkStatusForUncertain('rejected')}
                        className="px-2.5 py-1 rounded bg-rose-600/15 hover:bg-rose-600/25 border border-rose-500/30 text-rose-300 text-[11px] font-medium"
                      >
                        Reject Uncertain
                      </button>
                    </div>
                  )}
                </div>

                <div
                  className={`md:col-span-5 rounded-xl p-3 border text-xs flex items-center justify-between gap-2 ${
                    calibration.calibrated
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                      : 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="font-semibold">
                      {calibration.calibrated
                        ? `Calibrated: ${calibration.drawingWidthMeters} m × ${calibration.drawingHeightMeters} m`
                        : 'Uncalibrated (Estimated Span)'}
                    </div>
                    <div className="text-[11px] opacity-80 truncate">
                      {calibration.calibrated
                        ? `${calibration.knownDistanceValue} ${calibration.unit} reference`
                        : 'Use 2-Pt Scale tool for real dimensions'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setReviewMode('calibrate')}
                    className="px-2.5 py-1 rounded bg-[#0d1117] border border-slate-700 text-white text-[11px] shrink-0"
                  >
                    Calibrate
                  </button>
                </div>
              </div>

              {/* Inline 2-Point Calibration Distance Input Modal Strip */}
              {pendingCalPoints && (
                <form
                  onSubmit={handleApplyCalibration}
                  className="bg-emerald-500/10 border border-emerald-500/40 rounded-xl p-3 flex flex-wrap items-center justify-between gap-2"
                >
                  <div className="text-xs text-emerald-200 font-medium">
                    2 reference points selected! Enter the known real-world distance between Point A and Point B:
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="number"
                      step="any"
                      min="0.01"
                      required
                      value={calDistanceInput}
                      onChange={(e) => setCalDistanceInput(e.target.value)}
                      placeholder="e.g. 4.5"
                      className="w-28 px-2.5 py-1 text-xs rounded bg-[#0d1117] border border-slate-600 text-white"
                    />
                    <select
                      value={calUnitInput}
                      onChange={(e) => setCalUnitInput(e.target.value as DrawingMeasurementUnit)}
                      className="px-2 py-1 text-xs rounded bg-[#0d1117] border border-slate-600 text-white"
                    >
                      {UNIT_OPTIONS.map((u) => (
                        <option key={u.value} value={u.value}>
                          {u.value}
                        </option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold"
                    >
                      Apply Scale
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPendingCalPoints(null);
                        setCalError(null);
                      }}
                      className="px-2 py-1 rounded bg-slate-800 text-slate-300 text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                  {calError && (
                    <div className="w-full text-[11px] text-rose-300 mt-1">{calError}</div>
                  )}
                </form>
              )}

              {/* Reconstruction Fidelity & Completeness Gate */}
              <div
                className={`rounded-xl p-3 border text-xs space-y-2 ${
                  qualityReport.status === 'ready'
                    ? 'bg-[#11161f] border-slate-800 text-slate-200'
                    : 'bg-rose-500/10 border-rose-500/40 text-rose-200'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold flex items-center gap-2">
                    <span>
                      Reconstruction Fidelity: {qualityReport.score}% (
                      {qualityReport.status === 'ready'
                        ? 'Ready for 2D CAD'
                        : qualityReport.status === 'incomplete'
                        ? 'Incomplete — Correction Required'
                        : 'No Geometry Yet'}
                      )
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2.5 text-[11px] text-slate-300">
                    <span>
                      Walls: <strong>{qualityReport.metrics.approvedWalls}</strong> (
                      {qualityReport.metrics.externalWalls} ext / {qualityReport.metrics.internalWalls} int
                      {qualityReport.metrics.angledOrCurvedWalls > 0
                        ? ` / ${qualityReport.metrics.angledOrCurvedWalls} angled-curved`
                        : ''}
                      )
                    </span>
                    <span>
                      Rooms: <strong>{qualityReport.metrics.approvedRooms}</strong>
                      {qualityReport.metrics.polygonRooms > 0
                        ? ` (${qualityReport.metrics.polygonRooms} poly)`
                        : ''}
                    </span>
                    <span>Openings: <strong>{qualityReport.metrics.approvedOpenings}</strong></span>
                    <span>Furniture: <strong>{qualityReport.metrics.approvedFurniture}</strong></span>
                    <span>
                      Symbols: <strong>{qualityReport.metrics.approvedSymbols}</strong> (
                      {qualityReport.metrics.mappedSymbols} mapped)
                    </span>
                  </div>
                </div>
                {qualityReport.blockers.length > 0 && (
                  <div className="space-y-1">
                    {qualityReport.blockers.map((b, i) => (
                      <div key={i} className="flex items-start gap-1.5 text-[11px] text-rose-200 font-medium">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-rose-400" />
                        <span>{b}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Warnings from AI Analysis */}
              {model.warnings.length > 0 && (
                <div className="bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2 text-[11px] text-amber-200 space-y-0.5">
                  {model.warnings.map((w, idx) => (
                    <div key={idx} className="flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}

              <DrawingReviewCanvas
                source={source}
                model={model}
                calibration={calibration}
                symbolMappings={symbolMappings}
                layers={layers}
                mode={reviewMode}
                onChangeMode={setReviewMode}
                onChangeModel={setModel}
                onChangeLayers={setLayers}
                onCalibrationPairPicked={(pointA, pointB) => {
                  setPendingCalPoints({ pointA, pointB });
                  setCalError(null);
                }}
              />
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3 border-t border-slate-800 bg-[#11161f] flex items-center justify-between gap-3">
          <div className="text-[11px] text-slate-400 hidden sm:block">
            {qualityReport.status === 'ready' ? (
              <>
                Only <span className="text-emerald-400 font-medium">Approved</span> geometry converts to editable 2D Blue Space CAD with aligned reference PDF overlay.
              </>
            ) : (
              <span className="text-rose-300 font-medium">
                Incomplete detection blocked from generating — extract vector walls or trace missing geometry first.
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            {step > 1 && (
              <button
                type="button"
                onClick={() => setStep((s) => Math.max(1, s - 1))}
                className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Back
              </button>
            )}

            {step < 5 ? (
              <button
                type="button"
                disabled={step === 2 && !source}
                onClick={() => setStep((s) => Math.min(5, s + 1))}
                className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1"
              >
                Continue <ArrowRight className="w-3.5 h-3.5" />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={qualityReport.status !== 'ready' || isGenerating}
                  onClick={handleExportPreviewDxf}
                  className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 border border-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5"
                  title={
                    cadCapabilities?.dwgReady
                      ? 'Export validated editable AutoCAD DXF (native DWG also available from Studio Export menu)'
                      : 'Export validated editable AutoCAD DXF (opens in AutoCAD, LibreCAD, QCAD; DXF is never renamed as DWG)'
                  }
                >
                  <FileText className="w-3.5 h-3.5 text-sky-400" />
                  Export DXF (.dxf)
                </button>
                <button
                  type="button"
                  disabled={qualityReport.status !== 'ready' || isGenerating}
                  onClick={() => void handleGenerate2DModel()}
                  className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-emerald-900/30"
                  title={
                    qualityReport.status !== 'ready'
                      ? qualityReport.blockers[0]
                      : 'Generate editable 2D Blue Space CAD model (3D opens after your 2D approval)'
                  }
                >
                  {isGenerating ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Layers className="w-4 h-4" />
                  )}
                  Generate Editable 2D Model ({stats.approved})
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
