import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface SupabaseConfigStatus {
  configured: boolean;
  hasUrl: boolean;
  hasKey: boolean;
  keySource: 'VITE_SUPABASE_ANON_KEY' | 'VITE_SUPABASE_PUBLISHABLE_KEY' | 'none';
  missingVars: string[];
  validationError: string | null;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Rejects Supabase secret / service_role keys if mistakenly placed in a browser VITE_* variable.
 */
function isForbiddenSecretKey(key: string): boolean {
  if (/^sb_secret_/i.test(key)) {
    return true;
  }
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const decoded =
        typeof atob === 'function'
          ? atob(base64)
          : Buffer.from(base64, 'base64').toString('utf8');
      const payload = JSON.parse(decoded) as { role?: string };
      if (payload?.role === 'service_role') {
        return true;
      }
    } catch {
      // Not a decodable JWT payload; ignore
    }
  }
  return false;
}

export function validateSupabaseConfig(env: {
  url?: string;
  anonKey?: string;
  publishableKey?: string;
}): SupabaseConfigStatus {
  const url = env.url?.trim() ?? '';
  const anonKey = env.anonKey?.trim() ?? '';
  const publishableKey = env.publishableKey?.trim() ?? '';
  const key = anonKey || publishableKey || '';
  const keySource: SupabaseConfigStatus['keySource'] = anonKey
    ? 'VITE_SUPABASE_ANON_KEY'
    : publishableKey
      ? 'VITE_SUPABASE_PUBLISHABLE_KEY'
      : 'none';

  const hasUrl = Boolean(url);
  const hasKey = Boolean(key);
  const missingVars: string[] = [];

  if (!hasUrl) {
    missingVars.push('VITE_SUPABASE_URL');
  }
  if (!hasKey) {
    missingVars.push('VITE_SUPABASE_ANON_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY)');
  }

  if (missingVars.length > 0) {
    return {
      configured: false,
      hasUrl,
      hasKey,
      keySource,
      missingVars,
      validationError: `Missing required environment variable${missingVars.length > 1 ? 's' : ''}: ${missingVars.join(' and ')}. Add ${missingVars.length > 1 ? 'them' : 'it'} to your build environment and rebuild the frontend.`,
    };
  }

  if (!isValidHttpUrl(url)) {
    return {
      configured: false,
      hasUrl,
      hasKey,
      keySource,
      missingVars: [],
      validationError:
        'VITE_SUPABASE_URL is invalid. Expected a full Supabase project URL starting with https:// (for example, https://<project-ref>.supabase.co).',
    };
  }

  if (isForbiddenSecretKey(key)) {
    return {
      configured: false,
      hasUrl,
      hasKey,
      keySource,
      missingVars: [],
      validationError:
        'Invalid browser key detected: never use a Supabase service_role or secret key in frontend environment variables. Use the public anon/publishable key instead.',
    };
  }

  return {
    configured: true,
    hasUrl: true,
    hasKey: true,
    keySource,
    missingVars: [],
    validationError: null,
  };
}

const supabaseUrl =
  (typeof import.meta !== 'undefined' && import.meta.env
    ? import.meta.env.VITE_SUPABASE_URL
    : undefined
  )?.trim() ?? '';

const supabaseAnonKeyRaw =
  (typeof import.meta !== 'undefined' && import.meta.env
    ? import.meta.env.VITE_SUPABASE_ANON_KEY
    : undefined
  )?.trim() ?? '';

const supabasePublishableKeyRaw =
  (typeof import.meta !== 'undefined' && import.meta.env
    ? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
    : undefined
  )?.trim() ?? '';

const supabasePublicKey = supabaseAnonKeyRaw || supabasePublishableKeyRaw;

const configStatus: SupabaseConfigStatus = validateSupabaseConfig({
  url: supabaseUrl,
  anonKey: supabaseAnonKeyRaw,
  publishableKey: supabasePublishableKeyRaw,
});

export const isSupabaseConfigured: boolean = configStatus.configured;

export function getSupabaseConfigStatus(): SupabaseConfigStatus {
  return configStatus;
}

if (!configStatus.configured && typeof console !== 'undefined') {
  console.warn(`[Supabase Config] ${configStatus.validationError}`);
}

interface AuthStorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function createMemoryStorage(): AuthStorageLike {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

/**
 * Ensures session persistence never silently fails in sandboxed/iframe contexts
 * where window.localStorage may throw or discard writes (which would cause
 * getSession() to return null and PostgREST requests to fall back to the anon role).
 */
function resolveAuthStorage(): AuthStorageLike | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  try {
    const probeKey = '__neel_3d_space_storage_probe__';
    window.localStorage.setItem(probeKey, '1');
    const verified = window.localStorage.getItem(probeKey) === '1';
    window.localStorage.removeItem(probeKey);
    if (verified) {
      return window.localStorage;
    }
  } catch {
    // Fall through to in-memory storage when localStorage is blocked
  }
  return createMemoryStorage();
}

const SUPABASE_FETCH_TIMEOUT_MS = 12_000;

/**
 * Wraps browser fetch with a hard AbortController timeout so stalled Supabase Auth
 * or PostgREST HTTP requests fail cleanly instead of leaving unresolved promises.
 */
function createTimeoutFetch(timeoutMs = SUPABASE_FETCH_TIMEOUT_MS): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof AbortController === 'undefined') {
      return fetch(input, init);
    }

    const controller = new AbortController();
    const externalSignal = init?.signal;

    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    const timer = globalThis.setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted && !externalSignal?.aborted) {
        throw new Error(`Supabase network request timed out after ${Math.round(timeoutMs / 1000)}s.`);
      }
      throw err;
    } finally {
      globalThis.clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  };
}

const SINGLETON_KEY = '__neel3dSpaceSupabaseClient__';

function getOrCreateSupabaseClient(): SupabaseClient | null {
  if (!configStatus.configured) {
    return null;
  }

  const globalScope = globalThis as Record<string, unknown>;
  const existing = globalScope[SINGLETON_KEY] as SupabaseClient | undefined;
  if (existing) {
    return existing;
  }

  const created = createClient(supabaseUrl, supabasePublicKey, {
    db: {
      schema: 'public',
    },
    global: {
      fetch: createTimeoutFetch(SUPABASE_FETCH_TIMEOUT_MS),
    },
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: resolveAuthStorage(),
      storageKey: 'neel-3d-space-supabase-auth',
    },
  });

  globalScope[SINGLETON_KEY] = created;
  return created;
}

/**
 * Single browser-safe Supabase client instance using ONLY the public anon/publishable key.
 * Never expose or import the service-role key in frontend code.
 */
export const supabase: SupabaseClient | null = getOrCreateSupabaseClient();
