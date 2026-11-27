import React, { useRef, useState } from 'react';
import {
  Check,
  Crop,
  Edit3,
  FolderOpen,
  ImagePlus,
  PenTool,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import {
  AiDrawingType,
  SymbolMappingDefinition,
  SymbolTargetDomain,
  SymbolTemplate,
} from '../../types/aiDrawing';
import { ElectricalItemType } from '../../types/design';
import {
  createSymbolMapping,
  ELECTRICAL_ITEM_OPTIONS_BY_DOMAIN,
  sanitizeSymbolSampleDataUrl,
  SYMBOL_DOMAIN_OPTIONS,
} from '../../services/symbolMappingStorage';
import {
  renderRasterImageFile,
  validateDrawingUploadBytes,
} from '../../utils/pdfImageRenderer';

interface SymbolMappingManagerProps {
  mappings: SymbolMappingDefinition[];
  templates: SymbolTemplate[];
  drawingType: AiDrawingType;
  hasUploadedDrawing: boolean;
  pendingCroppedSampleDataUrl?: string | null;
  onClearPendingCroppedSample?: () => void;
  onRequestLegendCrop?: () => void;
  onChangeMappings: (next: SymbolMappingDefinition[]) => void;
  onSaveTemplate: (name: string, description: string) => void;
  onLoadTemplate: (template: SymbolTemplate, mode: 'replace' | 'merge') => void;
  onDeleteTemplate: (templateId: string) => void;
  onNotify?: (type: 'success' | 'warning' | 'error' | 'info', message: string) => void;
}

export const SymbolMappingManager: React.FC<SymbolMappingManagerProps> = ({
  mappings,
  templates,
  drawingType,
  hasUploadedDrawing,
  pendingCroppedSampleDataUrl,
  onClearPendingCroppedSample,
  onRequestLegendCrop,
  onChangeMappings,
  onSaveTemplate,
  onLoadTemplate,
  onDeleteTemplate,
  onNotify,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [domain, setDomain] = useState<SymbolTargetDomain>('lighting');
  const [electricalItemType, setElectricalItemType] = useState<ElectricalItemType | ''>('led_light');
  const [description, setDescription] = useState('');
  const [visualNotes, setVisualNotes] = useState('');
  const [markerColor, setMarkerColor] = useState('#f59e0b');
  const [sampleImageDataUrl, setSampleImageDataUrl] = useState<string | undefined>(undefined);

  // Mini sketch pad state for drawing a sample symbol
  const [showSketchPad, setShowSketchPad] = useState(false);
  const sketchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);

  // Template saving UI
  const [showTemplatePanel, setShowTemplatePanel] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateDesc, setTemplateDesc] = useState('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Sync newly cropped sample from parent legend crop tool
  React.useEffect(() => {
    if (pendingCroppedSampleDataUrl) {
      const safe = sanitizeSymbolSampleDataUrl(pendingCroppedSampleDataUrl);
      if (safe) {
        setSampleImageDataUrl(safe);
      }
      onClearPendingCroppedSample?.();
    }
  }, [pendingCroppedSampleDataUrl, onClearPendingCroppedSample]);

  const domainItemOptions = ELECTRICAL_ITEM_OPTIONS_BY_DOMAIN[domain] ?? [];

  const handleDomainChange = (nextDomain: SymbolTargetDomain) => {
    setDomain(nextDomain);
    const domainMeta = SYMBOL_DOMAIN_OPTIONS.find((d) => d.domain === nextDomain);
    if (domainMeta) setMarkerColor(domainMeta.defaultColor);
    const nextOptions = ELECTRICAL_ITEM_OPTIONS_BY_DOMAIN[nextDomain] ?? [];
    setElectricalItemType(nextOptions[0]?.itemType ?? '');
  };

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setCode('');
    setDomain('lighting');
    setElectricalItemType('led_light');
    setDescription('');
    setVisualNotes('');
    setMarkerColor('#f59e0b');
    setSampleImageDataUrl(undefined);
    setShowSketchPad(false);
  };

  const handleSubmitSymbol = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      onNotify?.('warning', 'Enter a symbol name before saving.');
      return;
    }

    const selectedItemOption = domainItemOptions.find((o) => o.itemType === electricalItemType);

    if (editingId) {
      const updated = mappings.map((m) =>
        m.id === editingId
          ? {
              ...m,
              name: cleanName,
              code: (code.trim() || cleanName.slice(0, 6)).toUpperCase().slice(0, 24),
              domain,
              electricalItemType: electricalItemType || undefined,
              electricalCategory: selectedItemOption?.category,
              description: description.trim(),
              visualNotes: visualNotes.trim(),
              markerColor,
              sampleImageDataUrl: sanitizeSymbolSampleDataUrl(sampleImageDataUrl),
              updatedAt: new Date().toISOString(),
            }
          : m
      );
      onChangeMappings(updated);
      onNotify?.('success', `Updated symbol mapping "${cleanName}".`);
      resetForm();
      return;
    }

    const created = createSymbolMapping({
      name: cleanName,
      code: code.trim() || undefined,
      domain,
      electricalItemType: electricalItemType || undefined,
      electricalCategory: selectedItemOption?.category,
      description,
      visualNotes,
      markerColor,
      sampleImageDataUrl,
    });
    onChangeMappings([...mappings, created]);
    onNotify?.('success', `Added symbol mapping "${created.name}" (${created.code}).`);
    resetForm();
  };

  const startEdit = (item: SymbolMappingDefinition) => {
    setEditingId(item.id);
    setName(item.name);
    setCode(item.code);
    setDomain(item.domain);
    setElectricalItemType(item.electricalItemType ?? '');
    setDescription(item.description);
    setVisualNotes(item.visualNotes);
    setMarkerColor(item.markerColor);
    setSampleImageDataUrl(item.sampleImageDataUrl);
  };

  const handleUploadSampleImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const check = validateDrawingUploadBytes(bytes, {
        name: file.name,
        type: file.type,
        size: file.size,
      });
      if (!check.valid || (check.mimeType !== 'image/png' && check.mimeType !== 'image/jpeg')) {
        onNotify?.('error', check.error || 'Upload a valid PNG or JPG symbol image.');
        return;
      }
      const rendered = await renderRasterImageFile(file, 256);
      const safe = sanitizeSymbolSampleDataUrl(rendered.dataUrl);
      if (!safe) {
        onNotify?.('error', 'Symbol image could not be sanitized.');
        return;
      }
      setSampleImageDataUrl(safe);
      onNotify?.('success', 'Symbol reference image attached.');
    } catch {
      onNotify?.('error', 'Failed to read symbol image.');
    }
  };

  const getSketchPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = sketchCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const handleSketchStart = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = sketchCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    isDrawingRef.current = true;
    const { x, y } = getSketchPos(e);
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const handleSketchMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const canvas = sketchCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { x, y } = getSketchPos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const handleSketchEnd = () => {
    isDrawingRef.current = false;
  };

  const clearSketchPad = () => {
    const canvas = sketchCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };

  React.useEffect(() => {
    if (showSketchPad) {
      clearSketchPad();
    }
  }, [showSketchPad]);

  const captureSketchPad = () => {
    const canvas = sketchCanvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    const safe = sanitizeSymbolSampleDataUrl(dataUrl);
    if (safe) {
      setSampleImageDataUrl(safe);
      setShowSketchPad(false);
      onNotify?.('success', 'Hand-drawn symbol sample captured.');
    }
  };

  const handleSaveTemplateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!templateName.trim()) {
      onNotify?.('warning', 'Enter a template name.');
      return;
    }
    if (mappings.length === 0) {
      onNotify?.('warning', 'Define at least one symbol before saving a template.');
      return;
    }
    onSaveTemplate(templateName.trim(), templateDesc.trim());
    setTemplateName('');
    setTemplateDesc('');
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
      {/* Left: Add / Edit Symbol Form */}
      <form
        onSubmit={handleSubmitSymbol}
        className="lg:col-span-5 bg-[#11161f] border border-slate-800 rounded-xl p-4 space-y-3"
      >
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-white">
              {editingId ? 'Edit Symbol Mapping' : 'Define Drawing Symbol'}
            </h4>
            <p className="text-[11px] text-slate-400">
              AI uses your symbol definitions as the primary legend reference.
            </p>
          </div>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="text-xs text-slate-400 hover:text-white flex items-center gap-1"
            >
              <X className="w-3.5 h-3.5" /> Cancel
            </button>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2">
            <label className="block text-[11px] text-slate-400 mb-1">Symbol Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. 12W LED Downlight"
              maxLength={80}
              className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-[#0d1117] border border-slate-700 text-white focus:border-sky-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Legend Code</label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="DL-1"
              maxLength={24}
              className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-[#0d1117] border border-slate-700 text-white uppercase focus:border-sky-500 focus:outline-none"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Category</label>
            <select
              value={domain}
              onChange={(e) => handleDomainChange(e.target.value as SymbolTargetDomain)}
              className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-[#0d1117] border border-slate-700 text-white focus:border-sky-500 focus:outline-none"
            >
              {SYMBOL_DOMAIN_OPTIONS.map((opt) => (
                <option key={opt.domain} value={opt.domain}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Blue Space 2D Object</label>
            <select
              value={electricalItemType}
              onChange={(e) => setElectricalItemType(e.target.value as ElectricalItemType | '')}
              className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-[#0d1117] border border-slate-700 text-white focus:border-sky-500 focus:outline-none"
            >
              <option value="">Custom 2D Annotation Marker</option>
              {domainItemOptions.map((opt) => (
                <option key={opt.itemType} value={opt.itemType}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[11px] text-slate-400 mb-1">Meaning / Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this symbol represents in this drawing"
            maxLength={240}
            className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-[#0d1117] border border-slate-700 text-white focus:border-sky-500 focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-4 gap-2 items-end">
          <div className="col-span-3">
            <label className="block text-[11px] text-slate-400 mb-1">
              Visual Appearance / Variations
            </label>
            <input
              type="text"
              value={visualNotes}
              onChange={(e) => setVisualNotes(e.target.value)}
              placeholder="e.g. Circle with X inside, or labeled L1/DL"
              maxLength={240}
              className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-[#0d1117] border border-slate-700 text-white focus:border-sky-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Color</label>
            <input
              type="color"
              value={markerColor}
              onChange={(e) => setMarkerColor(e.target.value)}
              className="w-full h-8 rounded-lg bg-[#0d1117] border border-slate-700 cursor-pointer p-0.5"
            />
          </div>
        </div>

        {/* Symbol Sample Image: Crop from Legend, Upload PNG/JPG, or Draw Sample */}
        <div className="bg-[#0d1117] border border-slate-800 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-slate-300">
              Visual Symbol Sample (Optional)
            </span>
            {sampleImageDataUrl && (
              <button
                type="button"
                onClick={() => setSampleImageDataUrl(undefined)}
                className="text-[11px] text-rose-400 hover:text-rose-300"
              >
                Remove sample
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {onRequestLegendCrop && (
              <button
                type="button"
                disabled={!hasUploadedDrawing}
                onClick={onRequestLegendCrop}
                className="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-sky-500/15 text-sky-300 border border-sky-500/30 hover:bg-sky-500/25 disabled:opacity-40 flex items-center gap-1.5"
              >
                <Crop className="w-3.5 h-3.5" /> Crop from PDF Legend
              </button>
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700 flex items-center gap-1.5"
            >
              <ImagePlus className="w-3.5 h-3.5" /> Upload PNG/JPG
            </button>
            <button
              type="button"
              onClick={() => setShowSketchPad((v) => !v)}
              className="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700 flex items-center gap-1.5"
            >
              <PenTool className="w-3.5 h-3.5" /> Draw Sample
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".png,.jpg,.jpeg,image/png,image/jpeg"
              onChange={handleUploadSampleImage}
              className="hidden"
            />
          </div>

          {sampleImageDataUrl && (
            <div className="flex items-center gap-3 pt-1">
              <img
                src={sampleImageDataUrl}
                alt="Symbol sample"
                className="w-14 h-14 object-contain bg-white rounded border border-slate-700 p-1"
              />
              <span className="text-[11px] text-emerald-400">
                Sample image ready — will be sent alongside the drawing during AI vision analysis.
              </span>
            </div>
          )}

          {showSketchPad && (
            <div className="pt-2 space-y-2 border-t border-slate-800">
              <div className="flex items-center gap-3">
                <canvas
                  ref={sketchCanvasRef}
                  width={128}
                  height={128}
                  onPointerDown={handleSketchStart}
                  onPointerMove={handleSketchMove}
                  onPointerUp={handleSketchEnd}
                  onPointerLeave={handleSketchEnd}
                  className="w-28 h-28 bg-white rounded border border-slate-600 cursor-crosshair touch-none"
                />
                <div className="space-y-1.5">
                  <p className="text-[11px] text-slate-400">
                    Sketch the symbol shape as it appears in the drawing legend.
                  </p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={captureSketchPad}
                      className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-medium flex items-center gap-1"
                    >
                      <Check className="w-3 h-3" /> Use Sketch
                    </button>
                    <button
                      type="button"
                      onClick={clearSketchPad}
                      className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px]"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <button
          type="submit"
          className="w-full py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition"
        >
          <Plus className="w-4 h-4" />
          {editingId ? 'Save Symbol Changes' : 'Add Symbol Definition'}
        </button>
      </form>

      {/* Right: Defined Symbols List & Reusable Templates */}
      <div className="lg:col-span-7 flex flex-col gap-3">
        {/* Template Toolbar */}
        <div className="bg-[#11161f] border border-slate-800 rounded-xl p-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <span className="text-xs font-semibold text-white">
              Defined Symbols ({mappings.filter((m) => m.enabled).length} active / {mappings.length} total)
            </span>
            <p className="text-[11px] text-slate-400">
              No drawing symbols are assumed automatically. Add or load a saved template for this project.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowTemplatePanel((v) => !v)}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-200 flex items-center gap-1.5"
          >
            <FolderOpen className="w-3.5 h-3.5 text-sky-400" />
            Symbol Templates ({templates.length})
          </button>
        </div>

        {showTemplatePanel && (
          <div className="bg-[#11161f] border border-sky-500/30 rounded-xl p-3 space-y-3">
            <form onSubmit={handleSaveTemplateSubmit} className="grid grid-cols-1 sm:grid-cols-12 gap-2">
              <input
                type="text"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder={`Save current symbols as template (e.g. ${drawingType})`}
                className="sm:col-span-5 px-2.5 py-1.5 text-xs rounded-lg bg-[#0d1117] border border-slate-700 text-white focus:border-sky-500 focus:outline-none"
              />
              <input
                type="text"
                value={templateDesc}
                onChange={(e) => setTemplateDesc(e.target.value)}
                placeholder="Optional consultant / legend note"
                className="sm:col-span-4 px-2.5 py-1.5 text-xs rounded-lg bg-[#0d1117] border border-slate-700 text-white focus:border-sky-500 focus:outline-none"
              />
              <button
                type="submit"
                className="sm:col-span-3 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium flex items-center justify-center gap-1"
              >
                <Save className="w-3.5 h-3.5" /> Save Template
              </button>
            </form>

            {templates.length === 0 ? (
              <p className="text-[11px] text-slate-400">
                No saved symbol templates yet. Define symbols for a consultant or firm standard and save them here for instant reuse across future drawings.
              </p>
            ) : (
              <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                {templates.map((tpl) => (
                  <div
                    key={tpl.id}
                    className="flex items-center justify-between gap-2 bg-[#0d1117] border border-slate-800 rounded-lg px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-white truncate">
                        {tpl.name}{' '}
                        <span className="text-[10px] text-slate-400">
                          ({tpl.symbols.length} symbols)
                        </span>
                      </div>
                      {tpl.description && (
                        <div className="text-[11px] text-slate-400 truncate">{tpl.description}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => onLoadTemplate(tpl, 'merge')}
                        className="px-2 py-1 rounded bg-sky-500/15 text-sky-300 hover:bg-sky-500/25 text-[11px]"
                      >
                        Append
                      </button>
                      <button
                        type="button"
                        onClick={() => onLoadTemplate(tpl, 'replace')}
                        className="px-2 py-1 rounded bg-slate-800 text-slate-200 hover:bg-slate-700 text-[11px]"
                      >
                        Replace
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteTemplate(tpl.id)}
                        className="p-1 rounded text-slate-400 hover:text-rose-400"
                        title="Delete template"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Active Mappings Table / Cards */}
        <div className="bg-[#11161f] border border-slate-800 rounded-xl p-3 flex-1 min-h-[260px] max-h-[420px] overflow-y-auto space-y-2">
          {mappings.length === 0 ? (
            <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center px-4">
              <p className="text-sm font-medium text-slate-300">
                No custom drawing symbols defined yet
              </p>
              <p className="text-xs text-slate-500 mt-1 max-w-md">
                Use the form on the left to define symbols from your drawing legend (you can crop them directly from the uploaded PDF/image, upload a PNG/JPG, or sketch them). You can also continue directly to AI analysis for walls, rooms, doors, and windows.
              </p>
            </div>
          ) : (
            mappings.map((item) => (
              <div
                key={item.id}
                className={`flex items-center gap-3 p-2.5 rounded-lg border transition ${
                  item.enabled
                    ? 'bg-[#0d1117] border-slate-800'
                    : 'bg-[#0d1117]/50 border-slate-800/60 opacity-60'
                }`}
              >
                <div
                  className="w-10 h-10 rounded-lg border border-slate-700 shrink-0 flex items-center justify-center overflow-hidden bg-slate-900"
                  style={{ borderColor: item.markerColor }}
                >
                  {item.sampleImageDataUrl ? (
                    <img
                      src={item.sampleImageDataUrl}
                      alt={item.name}
                      className="w-full h-full object-contain bg-white p-0.5"
                    />
                  ) : (
                    <span
                      className="text-[10px] font-bold px-1 text-center leading-tight"
                      style={{ color: item.markerColor }}
                    >
                      {item.code}
                    </span>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-white truncate">{item.name}</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-sky-300">
                      {item.code}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-300 capitalize">
                      {item.domain}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 truncate mt-0.5">
                    {item.description || 'No description'}
                    {item.visualNotes ? ` · Visual: ${item.visualNotes}` : ''}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <label className="flex items-center gap-1 text-[11px] text-slate-400 mr-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      onChange={(e) =>
                        onChangeMappings(
                          mappings.map((m) =>
                            m.id === item.id ? { ...m, enabled: e.target.checked } : m
                          )
                        )
                      }
                      className="accent-sky-500"
                    />
                    On
                  </label>
                  <button
                    type="button"
                    onClick={() => startEdit(item)}
                    className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-sky-300"
                    title="Edit symbol"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onChangeMappings(mappings.filter((m) => m.id !== item.id))
                    }
                    className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-rose-400"
                    title="Delete symbol"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
