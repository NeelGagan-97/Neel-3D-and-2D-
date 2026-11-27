import {
  AiDrawingAnalyzeRequest,
  AiDrawingAnalyzeResponse,
  AiDrawingProviderStatus,
} from '../types/aiDrawing';

export class AiDrawingApiError extends Error {
  code: string;
  httpStatus: number;

  constructor(message: string, code: string, httpStatus: number) {
    super(message);
    this.name = 'AiDrawingApiError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export async function fetchAiDrawingStatus(signal?: AbortSignal): Promise<AiDrawingProviderStatus> {
  try {
    const res = await fetch('/api/ai-drawing/status', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!res.ok) {
      return {
        configured: false,
        model: 'gemini-4-hydrogen',
        message: 'AI analysis backend endpoint is unreachable. Manual review and calibration remain available.',
      };
    }
    const data = (await res.json()) as Partial<AiDrawingProviderStatus>;
    return {
      configured: Boolean(data.configured),
      model: typeof data.model === 'string' ? data.model : 'gemini-4-hydrogen',
      message:
        typeof data.message === 'string'
          ? data.message
          : 'AI analysis status checked.',
    };
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return {
      configured: false,
      model: 'gemini-4-hydrogen',
      message: 'Could not reach the Blue Space backend service for AI status.',
    };
  }
}

export async function analyzeDrawingWithAi(
  payload: AiDrawingAnalyzeRequest,
  signal?: AbortSignal
): Promise<AiDrawingAnalyzeResponse> {
  const res = await fetch('/api/ai-drawing/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  });

  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }

  if (!res.ok || !json || json.ok !== true) {
    const code = typeof json?.code === 'string' ? json.code : 'AI_ANALYSIS_FAILED';
    const message =
      typeof json?.error === 'string'
        ? json.error
        : `AI drawing analysis failed with HTTP ${res.status}.`;
    throw new AiDrawingApiError(message, code, res.status);
  }

  return json as unknown as AiDrawingAnalyzeResponse;
}
