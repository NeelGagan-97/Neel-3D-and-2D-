import { NormalizedRect } from '../types/aiDrawing';

export const MAX_DRAWING_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
export const ALLOWED_DRAWING_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg'] as const;

export type ValidatedDrawingMime = 'application/pdf' | 'image/png' | 'image/jpeg';

export interface DrawingFileValidationResult {
  valid: boolean;
  mimeType?: ValidatedDrawingMime;
  error?: string;
}

/**
 * Pure magic-byte + extension + size validation for uploaded drawings.
 * Rejects unsupported file types, empty files, oversized files, and mismatched headers.
 */
export function validateDrawingUploadBytes(
  bytes: Uint8Array,
  meta: { name: string; type?: string; size?: number }
): DrawingFileValidationResult {
  const fileName = (meta.name || '').trim();
  const lower = fileName.toLowerCase();
  const hasAllowedExt = ALLOWED_DRAWING_EXTENSIONS.some((ext) => lower.endsWith(ext));
  if (!hasAllowedExt) {
    return {
      valid: false,
      error: 'Unsupported file format. Please upload a PDF, PNG, or JPG/JPEG architectural or electrical drawing.',
    };
  }

  const size = typeof meta.size === 'number' ? meta.size : bytes.byteLength;
  if (size <= 0 || bytes.byteLength < 8) {
    return { valid: false, error: 'The selected file is empty or corrupted.' };
  }
  if (size > MAX_DRAWING_UPLOAD_BYTES) {
    return {
      valid: false,
      error: `File exceeds the maximum supported size of ${Math.round(MAX_DRAWING_UPLOAD_BYTES / (1024 * 1024))} MB.`,
    };
  }

  // Magic-byte signature checks
  const isPdf =
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d; // -
  const isPng =
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

  if (lower.endsWith('.pdf')) {
    if (!isPdf) {
      return {
        valid: false,
        error: 'The file has a .pdf extension but does not contain a valid PDF header.',
      };
    }
    return { valid: true, mimeType: 'application/pdf' };
  }

  if (lower.endsWith('.png')) {
    if (!isPng) {
      return {
        valid: false,
        error: 'The file has a .png extension but does not contain a valid PNG signature.',
      };
    }
    return { valid: true, mimeType: 'image/png' };
  }

  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    if (!isJpeg) {
      return {
        valid: false,
        error: 'The file has a .jpg/.jpeg extension but does not contain a valid JPEG signature.',
      };
    }
    return { valid: true, mimeType: 'image/jpeg' };
  }

  return { valid: false, error: 'Unsupported drawing file format.' };
}

export interface RenderedDrawingPage {
  dataUrl: string;
  widthPx: number;
  heightPx: number;
  pageCount: number;
  pageNumber: number;
}

let pdfJsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

async function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = (async () => {
      const [pdfjs, workerModule] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
      return pdfjs;
    })();
  }
  return pdfJsPromise;
}

/**
 * Renders a specific 1-based page from a PDF File into a high-resolution PNG data URL
 * while keeping the original uploaded File completely unmodified.
 */
export async function renderPdfFilePage(
  file: File,
  pageNumber = 1,
  maxDimensionPx = 2800
): Promise<RenderedDrawingPage> {
  const pdfjs = await loadPdfJs();
  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
  const pdfDoc = await loadingTask.promise;

  try {
    const pageCount = pdfDoc.numPages;
    const clampedPage = Math.max(1, Math.min(pageCount, Math.floor(pageNumber)));
    const page = await pdfDoc.getPage(clampedPage);
    const baseViewport = page.getViewport({ scale: 1 });
    const longestSide = Math.max(baseViewport.width, baseViewport.height, 1);
    const scale = Math.min(3, Math.max(1.2, maxDimensionPx / longestSide));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not acquire 2D canvas context for PDF rendering.');
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: ctx,
      viewport,
      canvas,
    }).promise;

    const dataUrl = canvas.toDataURL('image/png');
    return {
      dataUrl,
      widthPx: canvas.width,
      heightPx: canvas.height,
      pageCount,
      pageNumber: clampedPage,
    };
  } finally {
    const disposable = pdfDoc as unknown as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> };
    if (typeof disposable.destroy === 'function') {
      await disposable.destroy();
    } else if (typeof disposable.cleanup === 'function') {
      await disposable.cleanup();
    }
  }
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode drawing image.'));
    img.src = src;
  });
}

/**
 * Loads a PNG or JPEG File into a normalized PNG/JPEG data URL while preserving original file.
 */
export async function renderRasterImageFile(
  file: File,
  maxDimensionPx = 2400
): Promise<RenderedDrawingPage> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadHtmlImage(objectUrl);
    const longest = Math.max(img.naturalWidth, img.naturalHeight, 1);
    const ratio = longest > maxDimensionPx ? maxDimensionPx / longest : 1;
    const widthPx = Math.max(1, Math.round(img.naturalWidth * ratio));
    const heightPx = Math.max(1, Math.round(img.naturalHeight * ratio));

    const canvas = document.createElement('canvas');
    canvas.width = widthPx;
    canvas.height = heightPx;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not acquire 2D canvas context for image rendering.');
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, widthPx, heightPx);
    ctx.drawImage(img, 0, 0, widthPx, heightPx);

    const outMime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const dataUrl = canvas.toDataURL(outMime, 0.92);
    return {
      dataUrl,
      widthPx,
      heightPx,
      pageCount: 1,
      pageNumber: 1,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Applies optional rotation, crop, brightness, and contrast to a rendered drawing page
 * without modifying the original source data URL.
 */
export async function renderPreprocessedDrawing(
  originalPageDataUrl: string,
  options: {
    rotationDeg: 0 | 90 | 180 | 270;
    cropRect: NormalizedRect | null;
    brightness: number;
    contrast: number;
  }
): Promise<{ dataUrl: string; widthPx: number; heightPx: number }> {
  const img = await loadHtmlImage(originalPageDataUrl);

  // Step 1: Rotate into intermediate canvas
  const swapAxes = options.rotationDeg === 90 || options.rotationDeg === 270;
  const rotW = swapAxes ? img.naturalHeight : img.naturalWidth;
  const rotH = swapAxes ? img.naturalWidth : img.naturalHeight;

  const rotCanvas = document.createElement('canvas');
  rotCanvas.width = rotW;
  rotCanvas.height = rotH;
  const rotCtx = rotCanvas.getContext('2d');
  if (!rotCtx) {
    throw new Error('Could not acquire 2D canvas context for drawing preparation.');
  }

  rotCtx.fillStyle = '#ffffff';
  rotCtx.fillRect(0, 0, rotW, rotH);
  rotCtx.save();
  rotCtx.translate(rotW / 2, rotH / 2);
  rotCtx.rotate((options.rotationDeg * Math.PI) / 180);
  rotCtx.filter = `brightness(${Math.max(50, Math.min(150, options.brightness))}%) contrast(${Math.max(50, Math.min(150, options.contrast))}%)`;
  rotCtx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  rotCtx.restore();

  // Step 2: Optional crop
  if (!options.cropRect) {
    return {
      dataUrl: rotCanvas.toDataURL('image/png'),
      widthPx: rotW,
      heightPx: rotH,
    };
  }

  const cx = Math.max(0, Math.min(0.95, options.cropRect.x));
  const cy = Math.max(0, Math.min(0.95, options.cropRect.y));
  const cw = Math.max(0.05, Math.min(1 - cx, options.cropRect.width));
  const ch = Math.max(0.05, Math.min(1 - cy, options.cropRect.height));

  const sx = Math.round(cx * rotW);
  const sy = Math.round(cy * rotH);
  const sw = Math.max(16, Math.round(cw * rotW));
  const sh = Math.max(16, Math.round(ch * rotH));

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = sw;
  cropCanvas.height = sh;
  const cropCtx = cropCanvas.getContext('2d');
  if (!cropCtx) {
    throw new Error('Could not acquire 2D canvas context for cropping.');
  }
  cropCtx.fillStyle = '#ffffff';
  cropCtx.fillRect(0, 0, sw, sh);
  cropCtx.drawImage(rotCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

  return {
    dataUrl: cropCanvas.toDataURL('image/png'),
    widthPx: sw,
    heightPx: sh,
  };
}

/**
 * Crops a small region (such as a symbol inside a PDF legend) into a clean PNG data URL
 * suitable for storing in SymbolMappingDefinition.sampleImageDataUrl.
 */
export async function cropLegendSymbolDataUrl(
  sourceDataUrl: string,
  rect: NormalizedRect,
  maxEdgePx = 256
): Promise<string> {
  const img = await loadHtmlImage(sourceDataUrl);
  const x = Math.max(0, Math.min(0.98, rect.x));
  const y = Math.max(0, Math.min(0.98, rect.y));
  const w = Math.max(0.01, Math.min(1 - x, rect.width));
  const h = Math.max(0.01, Math.min(1 - y, rect.height));

  const sx = Math.round(x * img.naturalWidth);
  const sy = Math.round(y * img.naturalHeight);
  const sw = Math.max(8, Math.round(w * img.naturalWidth));
  const sh = Math.max(8, Math.round(h * img.naturalHeight));

  const scale = Math.min(1, maxEdgePx / Math.max(sw, sh));
  const outW = Math.max(24, Math.round(sw * scale));
  const outH = Math.max(24, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create canvas for symbol crop.');
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
  return canvas.toDataURL('image/png');
}

export function extractBase64FromDataUrl(dataUrl: string): {
  base64: string;
  mimeType: 'image/png' | 'image/jpeg';
} | null {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg));base64,(.+)$/i);
  if (!match) return null;
  return {
    mimeType: match[1].toLowerCase() as 'image/png' | 'image/jpeg',
    base64: match[2],
  };
}

/**
 * Produces a crisp, high-detail JPEG (max 2400px) specifically for the vision AI request
 * so fine wall geometry, curved arcs, small electrical symbols, and room labels stay sharp.
 */
export async function optimizeDrawingForAiAnalysis(
  preparedImageDataUrl: string,
  maxDimensionPx = 2400
): Promise<{ base64: string; mimeType: 'image/jpeg'; widthPx: number; heightPx: number }> {
  const img = await loadHtmlImage(preparedImageDataUrl);
  const longest = Math.max(img.naturalWidth, img.naturalHeight, 1);
  const ratio = longest > maxDimensionPx ? maxDimensionPx / longest : 1;
  const widthPx = Math.max(1, Math.round(img.naturalWidth * ratio));
  const heightPx = Math.max(1, Math.round(img.naturalHeight * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create canvas to prepare drawing for AI analysis.');
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, widthPx, heightPx);
  ctx.drawImage(img, 0, 0, widthPx, heightPx);

  const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.9);
  const extracted = extractBase64FromDataUrl(jpegDataUrl);
  if (!extracted || extracted.mimeType !== 'image/jpeg') {
    throw new Error('Failed to encode drawing image as JPEG for AI analysis.');
  }
  return {
    base64: extracted.base64,
    mimeType: 'image/jpeg',
    widthPx,
    heightPx,
  };
}

/**
 * Produces a compact yet sharp aligned reference underlay data URL (max 1400px JPEG)
 * for side-by-side / overlay visual comparison inside the main Blue Space 2D CAD editor.
 */
export async function createCompactReferenceOverlayDataUrl(
  preparedImageDataUrl: string,
  maxDimensionPx = 1400
): Promise<{ dataUrl: string; widthPx: number; heightPx: number }> {
  const img = await loadHtmlImage(preparedImageDataUrl);
  const longest = Math.max(img.naturalWidth, img.naturalHeight, 1);
  const ratio = longest > maxDimensionPx ? maxDimensionPx / longest : 1;
  const widthPx = Math.max(1, Math.round(img.naturalWidth * ratio));
  const heightPx = Math.max(1, Math.round(img.naturalHeight * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return {
      dataUrl: preparedImageDataUrl,
      widthPx: img.naturalWidth || 1,
      heightPx: img.naturalHeight || 1,
    };
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, widthPx, heightPx);
  ctx.drawImage(img, 0, 0, widthPx, heightPx);
  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.82),
    widthPx,
    heightPx,
  };
}
