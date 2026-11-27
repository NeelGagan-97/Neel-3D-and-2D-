import 'dotenv/config';
import express, { Request, Response } from 'express';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GoogleGenAI, ThinkingLevel, Type, type Part } from '@google/genai';
import { generateValidatedProjectDxf } from './src/utils/dxfExporter';
import type { ProjectData } from './src/types/design';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const AI_DRAWING_MODEL = 'gemini-4-hydrogen';
const AI_FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB decoded raster limit
const MAX_SAMPLE_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB per symbol sample
const MAX_SYMBOLS_PER_REQUEST = 80;
const MAX_SAMPLE_IMAGES_TO_SEND = 12;

function extractProviderErrorStatus(err: unknown): number {
  if (err && typeof err === 'object') {
    const maybeStatus = (err as { status?: unknown }).status;
    if (typeof maybeStatus === 'number' && Number.isFinite(maybeStatus)) {
      return maybeStatus;
    }
    const maybeCode = (err as { code?: unknown }).code;
    if (typeof maybeCode === 'number' && Number.isFinite(maybeCode)) {
      return maybeCode;
    }
    const msg = typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message
      : '';
    if (/\b503\b|UNAVAILABLE|overloaded|high demand/i.test(msg)) return 503;
    if (/\b429\b|RESOURCE_EXHAUSTED|rate limit/i.test(msg)) return 429;
    if (/\b403\b|PERMISSION_DENIED/i.test(msg)) return 403;
    if (/\b400\b|INVALID_ARGUMENT|API_KEY_INVALID/i.test(msg)) return 400;
  }
  return 502;
}

function isRetryableProviderStatus(status: number): boolean {
  return status === 503 || status === 500 || status === 502 || status === 504 || status === 429;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWithTransientRetry<T>(
  attempts: Array<{ label: string; run: () => Promise<T> }>,
  baseDelayMs = 900
): Promise<{ result: T; label: string }> {
  let lastError: unknown;
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    try {
      const result = await attempt.run();
      return { result, label: attempt.label };
    } catch (err) {
      lastError = err;
      const status = extractProviderErrorStatus(err);
      const isLast = i === attempts.length - 1;
      if (isLast || !isRetryableProviderStatus(status)) {
        throw err;
      }
      const jitter = Math.floor(Math.random() * 250);
      const delay = baseDelayMs * Math.pow(2, Math.min(i, 2)) + jitter;
      await sleep(delay);
    }
  }
  throw lastError;
}

function getConfiguredGeminiApiKey(): string | null {
  const raw = process.env.GEMINI_API_KEY?.trim();
  if (!raw || raw === 'MY_GEMINI_API_KEY' || raw.length < 10) {
    return null;
  }
  return raw;
}

function isAllowedRasterMime(mime: unknown): mime is 'image/png' | 'image/jpeg' {
  return mime === 'image/png' || mime === 'image/jpeg';
}

function validateBase64Raster(
  base64: unknown,
  mimeType: 'image/png' | 'image/jpeg',
  maxBytes: number
): { valid: true; cleanBase64: string; bytes: number } | { valid: false; error: string } {
  if (typeof base64 !== 'string' || base64.length < 32) {
    return { valid: false, error: 'Missing or invalid base64 image payload.' };
  }
  const clean = base64.replace(/^data:image\/(?:png|jpeg);base64,/i, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(clean)) {
    return { valid: false, error: 'Image payload contains invalid base64 characters.' };
  }
  const approxBytes = Math.floor((clean.length * 3) / 4);
  if (approxBytes > maxBytes) {
    return {
      valid: false,
      error: `Image payload exceeds maximum allowed size of ${Math.round(maxBytes / (1024 * 1024))} MB.`,
    };
  }
  const headerBuf = Buffer.from(clean.slice(0, 24), 'base64');
  if (mimeType === 'image/png') {
    const isPng =
      headerBuf.length >= 8 &&
      headerBuf[0] === 0x89 &&
      headerBuf[1] === 0x50 &&
      headerBuf[2] === 0x4e &&
      headerBuf[3] === 0x47;
    if (!isPng) {
      return { valid: false, error: 'Uploaded PNG image header does not match PNG signature.' };
    }
  } else {
    const isJpeg =
      headerBuf.length >= 3 &&
      headerBuf[0] === 0xff &&
      headerBuf[1] === 0xd8 &&
      headerBuf[2] === 0xff;
    if (!isJpeg) {
      return { valid: false, error: 'Uploaded JPEG image header does not match JPEG signature.' };
    }
  }
  return { valid: true, cleanBase64: clean, bytes: approxBytes };
}

function sanitizeText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, maxLen);
}

const ANALYSIS_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    warnings: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    titleBlock: {
      type: Type.OBJECT,
      properties: {
        drawingTitle: { type: Type.STRING },
        drawingNumber: { type: Type.STRING },
        scaleText: { type: Type.STRING },
        unitText: { type: Type.STRING },
        revision: { type: Type.STRING },
        projectTitle: { type: Type.STRING },
      },
    },
    legendEntries: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          code: { type: Type.STRING },
          label: { type: Type.STRING },
          description: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
        },
        required: ['code', 'label', 'confidence'],
      },
    },
    walls: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          x1: { type: Type.NUMBER },
          y1: { type: Type.NUMBER },
          x2: { type: Type.NUMBER },
          y2: { type: Type.NUMBER },
          wallKind: { type: Type.STRING },
          isCurvedSegment: { type: Type.BOOLEAN },
          confidence: { type: Type.NUMBER },
          note: { type: Type.STRING },
        },
        required: ['x1', 'y1', 'x2', 'y2', 'wallKind', 'confidence'],
      },
    },
    rooms: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          roomType: { type: Type.STRING },
          x: { type: Type.NUMBER },
          y: { type: Type.NUMBER },
          width: { type: Type.NUMBER },
          height: { type: Type.NUMBER },
          polygon: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                x: { type: Type.NUMBER },
                y: { type: Type.NUMBER },
              },
              required: ['x', 'y'],
            },
          },
          confidence: { type: Type.NUMBER },
          note: { type: Type.STRING },
        },
        required: ['name', 'roomType', 'x', 'y', 'width', 'height', 'confidence'],
      },
    },
    openings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          kind: { type: Type.STRING },
          x: { type: Type.NUMBER },
          y: { type: Type.NUMBER },
          widthNorm: { type: Type.NUMBER },
          rotationDeg: { type: Type.NUMBER },
          confidence: { type: Type.NUMBER },
          note: { type: Type.STRING },
        },
        required: ['kind', 'x', 'y', 'widthNorm', 'rotationDeg', 'confidence'],
      },
    },
    columns: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          x: { type: Type.NUMBER },
          y: { type: Type.NUMBER },
          widthNorm: { type: Type.NUMBER },
          heightNorm: { type: Type.NUMBER },
          confidence: { type: Type.NUMBER },
        },
        required: ['label', 'x', 'y', 'widthNorm', 'heightNorm', 'confidence'],
      },
    },
    staircases: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          x: { type: Type.NUMBER },
          y: { type: Type.NUMBER },
          widthNorm: { type: Type.NUMBER },
          heightNorm: { type: Type.NUMBER },
          rotationDeg: { type: Type.NUMBER },
          steps: { type: Type.NUMBER },
          confidence: { type: Type.NUMBER },
        },
        required: ['label', 'x', 'y', 'widthNorm', 'heightNorm', 'rotationDeg', 'confidence'],
      },
    },
    furniture: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          kind: { type: Type.STRING },
          label: { type: Type.STRING },
          x: { type: Type.NUMBER },
          y: { type: Type.NUMBER },
          widthNorm: { type: Type.NUMBER },
          heightNorm: { type: Type.NUMBER },
          rotationDeg: { type: Type.NUMBER },
          confidence: { type: Type.NUMBER },
          note: { type: Type.STRING },
        },
        required: ['kind', 'label', 'x', 'y', 'widthNorm', 'heightNorm', 'rotationDeg', 'confidence'],
      },
    },
    symbols: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          symbolMappingId: { type: Type.STRING },
          symbolName: { type: Type.STRING },
          symbolCode: { type: Type.STRING },
          domain: { type: Type.STRING },
          x: { type: Type.NUMBER },
          y: { type: Type.NUMBER },
          rotationDeg: { type: Type.NUMBER },
          confidence: { type: Type.NUMBER },
          note: { type: Type.STRING },
        },
        required: ['symbolName', 'symbolCode', 'domain', 'x', 'y', 'rotationDeg', 'confidence'],
      },
    },
    wiringPaths: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          circuitHint: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
          points: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                x: { type: Type.NUMBER },
                y: { type: Type.NUMBER },
              },
              required: ['x', 'y'],
            },
          },
        },
        required: ['label', 'points', 'confidence'],
      },
    },
    dimensions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          x1: { type: Type.NUMBER },
          y1: { type: Type.NUMBER },
          x2: { type: Type.NUMBER },
          y2: { type: Type.NUMBER },
          labelText: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
        },
        required: ['x1', 'y1', 'x2', 'y2', 'labelText', 'confidence'],
      },
    },
    textLabels: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING },
          x: { type: Type.NUMBER },
          y: { type: Type.NUMBER },
          kind: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
        },
        required: ['text', 'x', 'y', 'kind', 'confidence'],
      },
    },
  },
  required: [
    'summary',
    'warnings',
    'titleBlock',
    'legendEntries',
    'walls',
    'rooms',
    'openings',
    'columns',
    'staircases',
    'furniture',
    'symbols',
    'wiringPaths',
    'dimensions',
    'textLabels',
  ],
};

interface SanitizedVectorContext {
  sourceKind: string;
  totalVectorSegments: number;
  curvedSegmentCount: number;
  angledSegmentCount: number;
  wallAnchors: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    wallKind: string;
    isCurved?: boolean;
  }>;
  textLabels: Array<{ text: string; x: number; y: number; kind: string }>;
  dimensions: Array<{ text: string; x: number; y: number; meters: number }>;
  legendEntries: Array<{ code: string; label: string; description: string }>;
}

function sanitizeVectorContext(raw: unknown): SanitizedVectorContext | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const clampNum = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, Math.round(n * 10000) / 10000)) : 0;
  };
  const wallAnchors = Array.isArray(obj.wallAnchors)
    ? obj.wallAnchors
        .slice(0, 220)
        .filter((w): w is Record<string, unknown> => Boolean(w && typeof w === 'object'))
        .map((w) => ({
          x1: clampNum(w.x1),
          y1: clampNum(w.y1),
          x2: clampNum(w.x2),
          y2: clampNum(w.y2),
          wallKind: w.wallKind === 'external' ? 'external' : 'internal',
          isCurved: Boolean(w.isCurved),
        }))
    : [];
  const textLabels = Array.isArray(obj.textLabels)
    ? obj.textLabels
        .slice(0, 160)
        .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === 'object'))
        .map((t) => ({
          text: sanitizeText(t.text, 100),
          x: clampNum(t.x),
          y: clampNum(t.y),
          kind: sanitizeText(t.kind, 24) || 'annotation',
        }))
        .filter((t) => Boolean(t.text))
    : [];
  const dimensions = Array.isArray(obj.dimensions)
    ? obj.dimensions
        .slice(0, 60)
        .filter((d): d is Record<string, unknown> => Boolean(d && typeof d === 'object'))
        .map((d) => ({
          text: sanitizeText(d.text, 32),
          x: clampNum(d.x),
          y: clampNum(d.y),
          meters: Number.isFinite(Number(d.meters)) ? Math.round(Number(d.meters) * 1000) / 1000 : 0,
        }))
        .filter((d) => Boolean(d.text) && d.meters > 0)
    : [];
  const legendEntries = Array.isArray(obj.legendEntries)
    ? obj.legendEntries
        .slice(0, 40)
        .filter((l): l is Record<string, unknown> => Boolean(l && typeof l === 'object'))
        .map((l) => ({
          code: sanitizeText(l.code, 20),
          label: sanitizeText(l.label, 60),
          description: sanitizeText(l.description, 120),
        }))
        .filter((l) => Boolean(l.code || l.label))
    : [];

  return {
    sourceKind: sanitizeText(obj.sourceKind, 24) || 'vector-pdf',
    totalVectorSegments: Math.max(0, Math.min(20000, Number(obj.totalVectorSegments) || 0)),
    curvedSegmentCount: Math.max(0, Math.min(10000, Number(obj.curvedSegmentCount) || 0)),
    angledSegmentCount: Math.max(0, Math.min(10000, Number(obj.angledSegmentCount) || 0)),
    wallAnchors,
    textLabels,
    dimensions,
    legendEntries,
  };
}

function buildAnalysisPrompt(
  metadata: {
    projectName: string;
    drawingType: string;
    measurementUnit: string;
    scaleLabel: string;
    notes: string;
  },
  symbolDefinitions: Array<{
    id: string;
    name: string;
    code: string;
    domain: string;
    electricalItemType?: string;
    description: string;
    visualNotes: string;
    hasSampleImage: boolean;
  }>,
  vectorContext: SanitizedVectorContext | null
): string {
  const symbolCatalogText =
    symbolDefinitions.length > 0
      ? symbolDefinitions
          .map(
            (s, idx) =>
              `${idx + 1}. id="${s.id}" | code="${s.code}" | name="${s.name}" | domain="${s.domain}"` +
              (s.electricalItemType ? ` | blueSpaceType="${s.electricalItemType}"` : '') +
              ` | description="${s.description}"` +
              (s.visualNotes ? ` | visualNotes="${s.visualNotes}"` : '') +
              (s.hasSampleImage ? ' | [sample image attached below]' : '')
          )
          .join('\n')
      : 'No user-defined symbols were provided. Read the drawing legend carefully and report EVERY visible electrical/lighting symbol with its legend code, exact coordinates, and realistic confidence (< 0.68 if unmapped).';

  const vectorContextBlock =
    vectorContext && (vectorContext.wallAnchors.length > 0 || vectorContext.textLabels.length > 0)
      ? [
          '',
          `DIRECT PDF VECTOR & TEXT EXTRACTION GROUND TRUTH (${vectorContext.sourceKind}):`,
          `- Total native PDF wall-candidate segments: ${vectorContext.totalVectorSegments} (${vectorContext.angledSegmentCount} angled, ${vectorContext.curvedSegmentCount} curved chords).`,
          vectorContext.textLabels.length > 0
            ? `- Extracted PDF Text Coordinates (exact normalized [x,y]): ${vectorContext.textLabels
                .slice(0, 80)
                .map((t) => `"${t.text}"@(${t.x},${t.y})`)
                .join('; ')}`
            : '',
          vectorContext.dimensions.length > 0
            ? `- Extracted PDF Dimensions: ${vectorContext.dimensions
                .slice(0, 35)
                .map((d) => `"${d.text}"=${d.meters}m@(${d.x},${d.y})`)
                .join('; ')}`
            : '',
          vectorContext.legendEntries.length > 0
            ? `- Extracted PDF Legend Entries: ${vectorContext.legendEntries
                .map((l) => `${l.code}: ${l.label}`)
                .join('; ')}`
            : '',
          vectorContext.wallAnchors.length > 0
            ? `- Reference Vector Wall Anchors (sample of ${Math.min(90, vectorContext.wallAnchors.length)}): ${vectorContext.wallAnchors
                .slice(0, 90)
                .map(
                  (w) =>
                    `[${w.wallKind}${w.isCurved ? ',curved' : ''}:(${w.x1},${w.y1})->(${w.x2},${w.y2})]`
                )
                .join(' ')}`
            : '',
          'USE THESE EXACT PDF COORDINATES AS YOUR SPATIAL ANCHOR. Do NOT shift, square off, or replace irregular/angled/curved walls with rectangular bounding boxes.',
        ]
          .filter(Boolean)
          .join('\n')
      : '';

  return [
    'You are a precision architectural & MEP CAD-to-2D digitization engine for Blue Space.',
    'YOUR CORE MISSION: Reproduce the uploaded architectural/electrical/lighting PDF drawing as FAITHFULLY as possible in editable 2D CAD geometry in STRICT normalized coordinates [0.0, 1.0] where (0,0) is top-left and (1,1) is bottom-right.',
    'CRITICAL ANTI-SIMPLIFICATION MANDATE: NEVER invent a simplified schematic floor plan and NEVER replace angled, chamfered, L-shaped, curved, or irregular building outlines/rooms with crude bounding rectangles!',
    '',
    'PROJECT CONTEXT:',
    `- Project Name: ${metadata.projectName || 'Untitled Drawing'}`,
    `- Drawing Type: ${metadata.drawingType}`,
    `- Declared Measurement Unit: ${metadata.measurementUnit}`,
    `- Declared Scale: ${metadata.scaleLabel || 'Not specified'}`,
    metadata.notes ? `- User Notes: ${metadata.notes}` : '',
    '',
    'USER-DEFINED SYMBOL LIBRARY (PRIMARY SOURCE OF TRUTH):',
    symbolCatalogText,
    vectorContextBlock,
    '',
    'STRICT CAD RECONSTRUCTION & HONESTY RULES:',
    '1. COMPLETE BUILDING OUTLINE & WALLS: Trace the COMPLETE exterior building envelope (every straight, angled, diagonal, chamfered, and curved wall segment) AND all internal partition walls, corridors, shafts, and room boundaries as wall segments (x1, y1)->(x2, y2). For curved walls/arcs, emit a sequence of connected short segments along the curve with isCurvedSegment=true so the arc shape is faithfully preserved. Exclude sheet border frames, title block borders, and dimension extension lines.',
    '2. FAITHFUL ROOM GEOMETRY (POLYGONS): For EVERY enclosed room, corridor, lobby, office, bay, or zone, provide BOTH its bounding box (x, y, width, height) AND an accurate ordered polygon[] of normalized vertices tracing its real shape (especially for L-shaped, angled, trapezoidal, or curved rooms). Match exact room names from the drawing labels.',
    '3. OPENINGS, STRUCTURAL & FURNITURE: Detect every identifiable door ("door") and window/glazing ("window") along walls with accurate center (x, y), widthNorm, and rotationDeg (matching wall angle). Detect structural columns in columns[], staircases in staircases[], and identifiable architectural furniture (desks, conference/dining tables, sofas, beds, counters, vanities, tv-units) in furniture[] using kind from: sofa, bed, dining-table, kitchen-counter, vanity, tv-unit, desk.',
    '4. EXHAUSTIVE ELECTRICAL & LIGHTING SYMBOL DETECTION: Inspect EVERY room, corridor, and ceiling grid systematically. Detect EVERY visible lighting fixture, downlight, linear/tube/panel light, emergency light, exit sign, fan, AC, switch, switchboard, socket, and distribution board. Match against the USER-DEFINED SYMBOL LIBRARY and the drawing legend, preserving exact (x, y) positions and rotationDeg. Copy the exact symbolMappingId when matched; if visible on the drawing/legend but unmapped, omit symbolMappingId and set confidence <= 0.65.',
    '5. WIRING / CIRCUIT PATHS: Where circuit lines, home-runs, or switch-to-fixture links are drawn, trace their polyline vertices in wiringPaths[].',
    '6. DIMENSIONS, LEGEND & ANNOTATIONS: Extract ALL visible dimension lines with exact endpoints (x1,y1)->(x2,y2) and verbatim labelText in dimensions[], ALL legend entries in legendEntries[], ALL room names/annotations/title-block text in textLabels[], and title-block fields in titleBlock.',
    '7. ZERO HALLUCINATION & HONEST CONFIDENCE: Never invent missing dimensions, rooms, or symbols. Assign realistic confidence in [0.0, 1.0] (< 0.70 for faint, occluded, ambiguous, or unmapped items) and report any incomplete, cropped, or illegible areas in warnings[].',
  ]
    .filter(Boolean)
    .join('\n');
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '25mb' }));

  app.get('/api/ai-drawing/status', (_req: Request, res: Response) => {
    const apiKey = getConfiguredGeminiApiKey();
    res.json({
      configured: Boolean(apiKey),
      model: AI_DRAWING_MODEL,
      message: apiKey
        ? 'Vision AI analysis is configured and ready.'
        : 'Server GEMINI_API_KEY is not configured. Upload, PDF preview, symbol mapping, manual review, and calibration remain available; configure GEMINI_API_KEY on the server to run automatic AI drawing analysis.',
    });
  });

  app.post('/api/ai-drawing/analyze', async (req: Request, res: Response) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object') {
        res.status(400).json({ ok: false, code: 'INVALID_REQUEST', error: 'Request body must be a JSON object.' });
        return;
      }

      const mimeType = body.mimeType;
      if (!isAllowedRasterMime(mimeType)) {
        res.status(400).json({
          ok: false,
          code: 'UNSUPPORTED_IMAGE_TYPE',
          error: 'Only PNG and JPEG prepared drawing images are supported for vision analysis.',
        });
        return;
      }

      const mainImgCheck = validateBase64Raster(body.imageBase64, mimeType, MAX_IMAGE_BYTES);
      if (!mainImgCheck.valid) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_IMAGE_PAYLOAD',
          error: mainImgCheck.error,
        });
        return;
      }

      const rawMeta = (body.metadata && typeof body.metadata === 'object'
        ? body.metadata
        : {}) as Record<string, unknown>;
      const metadata = {
        projectName: sanitizeText(rawMeta.projectName, 120),
        drawingType: sanitizeText(rawMeta.drawingType, 60) || 'Architectural Floor Plan',
        measurementUnit: sanitizeText(rawMeta.measurementUnit, 12) || 'm',
        scaleLabel: sanitizeText(rawMeta.scaleLabel, 40),
        notes: sanitizeText(rawMeta.notes, 500),
      };

      const rawSymbols = Array.isArray(body.symbolDefinitions) ? body.symbolDefinitions : [];
      if (rawSymbols.length > MAX_SYMBOLS_PER_REQUEST) {
        res.status(400).json({
          ok: false,
          code: 'TOO_MANY_SYMBOLS',
          error: `At most ${MAX_SYMBOLS_PER_REQUEST} symbol definitions may be sent in a single analysis request.`,
        });
        return;
      }

      const sanitizedSymbols: Array<{
        id: string;
        name: string;
        code: string;
        domain: string;
        electricalItemType?: string;
        description: string;
        visualNotes: string;
        hasSampleImage: boolean;
        sampleBase64?: string;
        sampleMime?: 'image/png' | 'image/jpeg';
      }> = [];

      let sampleImageCount = 0;
      for (const item of rawSymbols) {
        if (!item || typeof item !== 'object') continue;
        const sym = item as Record<string, unknown>;
        const id = sanitizeText(sym.id, 80);
        const name = sanitizeText(sym.name, 80);
        const code = sanitizeText(sym.code, 24);
        if (!id || !name) continue;

        let sampleBase64: string | undefined;
        let sampleMime: 'image/png' | 'image/jpeg' | undefined;
        if (
          sampleImageCount < MAX_SAMPLE_IMAGES_TO_SEND &&
          typeof sym.sampleImageBase64 === 'string' &&
          isAllowedRasterMime(sym.sampleMimeType)
        ) {
          const sampleCheck = validateBase64Raster(
            sym.sampleImageBase64,
            sym.sampleMimeType,
            MAX_SAMPLE_IMAGE_BYTES
          );
          if (sampleCheck.valid) {
            sampleBase64 = sampleCheck.cleanBase64;
            sampleMime = sym.sampleMimeType;
            sampleImageCount += 1;
          }
        }

        sanitizedSymbols.push({
          id,
          name,
          code: code || name.slice(0, 6).toUpperCase(),
          domain: sanitizeText(sym.domain, 30) || 'custom',
          electricalItemType: sanitizeText(sym.electricalItemType, 40) || undefined,
          description: sanitizeText(sym.description, 240),
          visualNotes: sanitizeText(sym.visualNotes, 240),
          hasSampleImage: Boolean(sampleBase64),
          sampleBase64,
          sampleMime,
        });
      }

      // Check API key ONLY after validating inputs so bad payloads return 400 cleanly
      // and missing server configuration returns a truthful 503 (never fake AI data).
      const apiKey = getConfiguredGeminiApiKey();
      if (!apiKey) {
        res.status(503).json({
          ok: false,
          code: 'AI_NOT_CONFIGURED',
          error:
            'Automatic AI drawing analysis requires GEMINI_API_KEY to be configured on the server environment. You can still calibrate scale and trace or place objects manually in the review editor.',
        });
        return;
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: { 'User-Agent': 'aistudio-build' },
        },
      });

      const sanitizedVectorContext = sanitizeVectorContext(body.vectorContext);

      const parts: Part[] = [
        { text: buildAnalysisPrompt(metadata, sanitizedSymbols, sanitizedVectorContext) },
        {
          inlineData: {
            mimeType,
            data: mainImgCheck.cleanBase64,
          },
        },
      ];

      for (const sym of sanitizedSymbols) {
        if (sym.sampleBase64 && sym.sampleMime) {
          parts.push({
            text: `Reference symbol image for id="${sym.id}", code="${sym.code}", name="${sym.name}":`,
          });
          parts.push({
            inlineData: {
              mimeType: sym.sampleMime,
              data: sym.sampleBase64,
            },
          });
        }
      }

      const invokeModel = (modelName: string, thinkingLevel?: ThinkingLevel) =>
        ai.models.generateContent({
          model: modelName,
          contents: [{ role: 'user', parts }],
          config: {
            responseMimeType: 'application/json',
            responseSchema: ANALYSIS_RESPONSE_SCHEMA,
            ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
          },
        });

      const { result: response, label: usedModel } = await runWithTransientRetry([
        { label: AI_DRAWING_MODEL, run: () => invokeModel(AI_DRAWING_MODEL, ThinkingLevel.HIGH) },
        { label: AI_DRAWING_MODEL, run: () => invokeModel(AI_DRAWING_MODEL, ThinkingLevel.MEDIUM) },
        { label: AI_FALLBACK_MODEL, run: () => invokeModel(AI_FALLBACK_MODEL) },
      ]);

      const rawText = response.text;
      if (!rawText) {
        res.status(502).json({
          ok: false,
          code: 'AI_EMPTY_RESPONSE',
          error: 'The vision model returned an empty response. Please retry or crop the drawing region more tightly.',
        });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        res.status(502).json({
          ok: false,
          code: 'AI_INVALID_JSON',
          error: 'The vision model returned malformed JSON. Please retry the analysis.',
        });
        return;
      }

      res.json({
        ok: true,
        model: usedModel,
        analyzedAt: new Date().toISOString(),
        rawAnalysis: parsed,
      });
    } catch (err: unknown) {
      const status = extractProviderErrorStatus(err);
      const safeStatus =
        status === 503
          ? 503
          : status === 429
            ? 429
            : status === 403
              ? 403
              : status >= 400 && status < 500
                ? 400
                : 502;
      const code =
        safeStatus === 503
          ? 'AI_SERVICE_UNAVAILABLE'
          : safeStatus === 429
            ? 'AI_RATE_LIMITED'
            : safeStatus === 403
              ? 'AI_PERMISSION_DENIED'
              : 'AI_PROVIDER_ERROR';
      const errMessage =
        safeStatus === 503
          ? 'The AI vision service is temporarily experiencing high demand (503). Automatic retries were attempted — please wait a few seconds and try again, or proceed to manual calibration and tracing.'
          : safeStatus === 429
            ? 'AI vision provider rate limit reached (429). Please wait a moment and try again.'
            : safeStatus === 403
              ? 'AI vision API key permission denied (403). Please verify your API key in Settings > Secrets.'
              : 'AI drawing analysis failed while contacting the vision provider. Please retry or crop the drawing region and try again.';
      console.error('[ai-drawing/analyze] provider error status:', status);
      res.status(safeStatus).json({
        ok: false,
        code,
        error: errMessage,
      });
    }
  });

  // Catch oversized JSON body errors cleanly as JSON instead of HTML stack trace
  // ─── CAD Export Capabilities & Validated DXF / Native DWG Endpoints ───────────────────
  async function resolveNativeDwgEngine(): Promise<{
    ready: boolean;
    engine: string | null;
    binaryPath: string | null;
    mode: 'oda' | 'libredwg' | null;
  }> {
    const candidates: Array<{ envKey: string; mode: 'oda' | 'libredwg'; label: string }> = [
      { envKey: 'ODA_FILE_CONVERTER_PATH', mode: 'oda', label: 'ODA File Converter' },
      { envKey: 'LIBREDWG_DXF2DWG_PATH', mode: 'libredwg', label: 'LibreDWG (dxf2dwg)' },
    ];
    for (const c of candidates) {
      const configured = process.env[c.envKey]?.trim();
      if (!configured) continue;
      // Reject relative path traversal or shell metacharacters
      if (!path.isAbsolute(configured) || /[;&|`$<>]/.test(configured)) continue;
      try {
        await fs.access(configured);
        return { ready: true, engine: c.label, binaryPath: configured, mode: c.mode };
      } catch {
        // Not accessible on disk
      }
    }
    return { ready: false, engine: null, binaryPath: null, mode: null };
  }

  function sanitizeExportFilename(raw: unknown, ext: '.dxf' | '.dwg'): string {
    const base = String(raw || 'bluespace-cad-plan')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
    return `${base || 'bluespace-cad-plan'}${ext}`;
  }

  function validateIncomingProjectPayload(body: unknown): {
    project: ProjectData;
    activeFloor: number;
  } | null {
    if (!body || typeof body !== 'object') return null;
    const raw = body as { project?: unknown; activeFloor?: unknown };
    if (!raw.project || typeof raw.project !== 'object') return null;
    const p = raw.project as Partial<ProjectData>;
    if (!p.site || typeof p.site !== 'object' || !Array.isArray(p.rooms) || !Array.isArray(p.points)) {
      return null;
    }
    const activeFloor =
      typeof raw.activeFloor === 'number' && Number.isFinite(raw.activeFloor)
        ? Math.max(-5, Math.min(200, Math.round(raw.activeFloor)))
        : 1;
    return { project: p as ProjectData, activeFloor };
  }

  app.get('/api/cad/capabilities', async (_req: Request, res: Response) => {
    const dwg = await resolveNativeDwgEngine();
    res.json({
      ok: true,
      dxfReady: true,
      dxfEngine: '@tarikjabiri/dxf + dxf-parser',
      dwgReady: dwg.ready,
      dwgEngine: dwg.engine,
      dwgReason: dwg.ready
        ? undefined
        : 'No native DWG converter binary (ODA File Converter or LibreDWG dxf2dwg) is installed on this server. Validated AutoCAD DXF export is ready and opens directly in AutoCAD, BricsCAD, LibreCAD, and QCAD; Blue Space never renames DXF as DWG.',
    });
  });

  app.post('/api/cad/export-dxf', (req: Request, res: Response) => {
    const parsed = validateIncomingProjectPayload(req.body);
    if (!parsed) {
      res.status(400).json({
        ok: false,
        error: 'Invalid project payload. Expected { project, activeFloor }.',
      });
      return;
    }
    try {
      const { dxfContent, validation } = generateValidatedProjectDxf(
        parsed.project,
        parsed.activeFloor
      );
      if (!validation.valid) {
        res.status(422).json({
          ok: false,
          error: `DXF validation failed: ${validation.errors.join('; ')}`,
          validation,
        });
        return;
      }
      const filename = sanitizeExportFilename(parsed.project.name, '.dxf');
      res.setHeader('Content-Type', 'application/dxf; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-CAD-Validation-Entities', String(validation.entityCount));
      res.setHeader('X-CAD-Validation-Layers', String(validation.layerNames.length));
      res.status(200).send(dxfContent);
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to generate validated DXF.',
      });
    }
  });

  app.post('/api/cad/export-dwg', async (req: Request, res: Response) => {
    const dwg = await resolveNativeDwgEngine();
    if (!dwg.ready || !dwg.binaryPath || !dwg.mode) {
      res.status(501).json({
        ok: false,
        code: 'DWG_ENGINE_UNAVAILABLE',
        error:
          'Native binary DWG export requires an installed licensed CAD converter (ODA File Converter or LibreDWG dxf2dwg). Configure ODA_FILE_CONVERTER_PATH or LIBREDWG_DXF2DWG_PATH on the server, or export validated AutoCAD DXF instead. Blue Space never renames DXF as DWG.',
      });
      return;
    }

    const parsed = validateIncomingProjectPayload(req.body);
    if (!parsed) {
      res.status(400).json({
        ok: false,
        error: 'Invalid project payload. Expected { project, activeFloor }.',
      });
      return;
    }

    const { dxfContent, validation } = generateValidatedProjectDxf(
      parsed.project,
      parsed.activeFloor
    );
    if (!validation.valid) {
      res.status(422).json({
        ok: false,
        error: `Intermediate DXF validation failed before DWG conversion: ${validation.errors.join('; ')}`,
        validation,
      });
      return;
    }

    let tmpDir: string | null = null;
    try {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bluespace-dwg-'));
      const inDir = path.join(tmpDir, 'in');
      const outDir = path.join(tmpDir, 'out');
      await fs.mkdir(inDir, { recursive: true });
      await fs.mkdir(outDir, { recursive: true });
      const dxfFile = path.join(inDir, 'plan.dxf');
      const dwgFile = path.join(outDir, 'plan.dwg');
      await fs.writeFile(dxfFile, dxfContent, 'utf8');

      if (dwg.mode === 'oda') {
        await execFileAsync(
          dwg.binaryPath,
          [inDir, outDir, 'ACAD2018', 'DWG', '0', '1', '*.dxf'],
          { timeout: 30_000, windowsHide: true }
        );
      } else {
        await execFileAsync(dwg.binaryPath, ['-y', '-o', dwgFile, dxfFile], {
          timeout: 30_000,
          windowsHide: true,
        });
      }

      const dwgBuffer = await fs.readFile(dwgFile);
      // Verify authentic AutoCAD binary DWG magic header ("AC10xx")
      const headerMagic = dwgBuffer.subarray(0, 4).toString('ascii');
      if (dwgBuffer.length < 32 || headerMagic !== 'AC10') {
        res.status(502).json({
          ok: false,
          error: 'DWG converter did not produce a valid binary AC10 DWG file.',
        });
        return;
      }

      const filename = sanitizeExportFilename(parsed.project.name, '.dwg');
      res.setHeader('Content-Type', 'application/acad');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.status(200).send(dwgBuffer);
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Native DWG conversion failed.',
      });
    } finally {
      if (tmpDir) {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  app.use((err: unknown, _req: Request, res: Response, next: (err?: unknown) => void) => {
    if (err && typeof err === 'object' && 'type' in err && (err as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({
        ok: false,
        code: 'PAYLOAD_TOO_LARGE',
        error: 'Drawing payload is too large. Please crop or reduce the page resolution and try again.',
      });
      return;
    }
    next(err);
  });

  return app;
}

async function startServer() {
  const app = createApp();
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Blue Space server running on http://0.0.0.0:${PORT}`);
  });
}

// Only bind port when run directly (allows importing createApp() in unit/integration tests)
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectRun) {
  startServer().catch((err) => {
    console.error('Failed to start Blue Space server:', err);
    process.exit(1);
  });
}
