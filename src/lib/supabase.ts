import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl =
  (typeof import.meta.env !== 'undefined'
    ? (import.meta.env.VITE_SUPABASE_URL as string | undefined)
    : undefined
  )?.trim() ?? '';

const supabaseAnonKey =
  (typeof import.meta.env !== 'undefined'
    ? (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)
    : undefined
  )?.trim() ||
  (typeof import.meta.env !== 'undefined'
    ? (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)
    : undefined
  )?.trim() ||
  '';

export const isSupabaseConfigured: boolean = Boolean(supabaseUrl && supabaseAnonKey);

export function getSupabaseConfigStatus(): {
  configured: boolean;
  hasUrl: boolean;
  hasKey: boolean;
} {
  return {
    configured: isSupabaseConfigured,
    hasUrl: Boolean(supabaseUrl),
    hasKey: Boolean(supabaseAnonKey),
  };
}

/**
 * Browser-safe Supabase client using ONLY the public anon/publishable key.
 * Never expose or import the service-role key in frontend code.
 */
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'neel-3d-space-supabase-auth',
      },
    })
  : null;
