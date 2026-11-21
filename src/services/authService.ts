import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import { supabase as defaultSupabaseClient } from '../lib/supabase';
import {
  AccountStatus,
  EmployeeProfile,
  EmployeeRegistrationInput,
  EmployeeRole,
  ProfileErrorKind,
  ProfileRecoveryInput,
} from '../types/auth';
import {
  isApprovedAdmin,
  normalizeEmail,
  normalizeEmployeeId,
  normalizeUsername,
  validateForgotPasswordEmail,
  validateLoginInput,
  validateRegistrationInput,
  validateResetPasswordInput,
} from '../utils/authValidation';

export interface AuthActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
  errorKind?: ProfileErrorKind;
  errorCode?: string;
  httpStatus?: number;
  rpcUnavailable?: boolean;
  fieldErrors?: Record<string, string>;
}

export interface RegisterResult {
  user: User | null;
  session: Session | null;
  profile: EmployeeProfile | null;
  requiresEmailConfirmation: boolean;
}

export interface LoginResult {
  user: User;
  session: Session;
  profile: EmployeeProfile | null;
  profileError?: string | null;
  profileErrorKind?: ProfileErrorKind | null;
}

function getClient(client?: SupabaseClient | null): SupabaseClient | null {
  return client ?? defaultSupabaseClient;
}

function isDevEnvironment(): boolean {
  return Boolean(typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV);
}

/**
 * Resolves a valid redirect URL for Supabase Auth emails (password reset, email confirmation).
 * Prefers explicit override, then optional VITE_APP_URL, then the live browser origin.
 * Never hardcodes localhost.
 */
export function buildAuthRedirectUrl(
  path: '/login' | '/reset-password' | '/pending-approval' | '/auth/callback',
  explicitRedirectTo?: string
): string | undefined {
  if (explicitRedirectTo?.trim()) {
    return explicitRedirectTo.trim();
  }

  const configuredOrigin =
    typeof import.meta !== 'undefined' && import.meta.env
      ? (import.meta.env.VITE_APP_URL as string | undefined)?.trim()
      : undefined;

  if (configuredOrigin && /^https?:\/\//i.test(configuredOrigin)) {
    return `${configuredOrigin.replace(/\/+$/, '')}${path}`;
  }

  if (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null') {
    return `${window.location.origin.replace(/\/+$/, '')}${path}`;
  }

  return undefined;
}

function mapSignUpError(message: string): {
  error: string;
  fieldErrors: Record<string, string>;
} {
  const lower = message.toLowerCase();

  if (
    lower.includes('user already registered') ||
    lower.includes('already been registered')
  ) {
    return {
      error: 'An account with this email address already exists.',
      fieldErrors: { email: 'This email address is already registered.' },
    };
  }

  if (lower.includes('username')) {
    return {
      error: 'This username is already taken.',
      fieldErrors: { username: 'This username is already in use. Choose another.' },
    };
  }

  if (lower.includes('employee_id') || lower.includes('employee id')) {
    return {
      error: 'This Employee ID is already registered.',
      fieldErrors: { employeeId: 'This Employee ID is already registered.' },
    };
  }

  if (
    lower.includes('database error saving new user') ||
    lower.includes('duplicate key') ||
    lower.includes('unique constraint')
  ) {
    return {
      error:
        'Registration could not be completed because the email address, username, or Employee ID may already be registered. Please check your details and try again.',
      fieldErrors: {},
    };
  }

  return {
    error: mapAuthError(message),
    fieldErrors: {},
  };
}

function mapAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes('invalid login credentials') ||
    lower.includes('invalid credentials')
  ) {
    return 'Invalid email or password. Please verify your credentials and try again.';
  }
  if (lower.includes('email not confirmed')) {
    return 'Please verify your email address using the confirmation link sent to your inbox before signing in.';
  }
  if (lower.includes('user already registered') || lower.includes('already been registered')) {
    return 'An account with this email address already exists.';
  }
  if (lower.includes('database error saving new user')) {
    return 'Registration could not be completed because the email address, username, or Employee ID may already be registered. Please check your details and try again.';
  }
  if (
    lower.includes('different from the old password') ||
    lower.includes('same password') ||
    lower.includes('same_password')
  ) {
    return 'Your new password must be different from your previous password.';
  }
  if (
    lower.includes('weak password') ||
    lower.includes('weak_password') ||
    lower.includes('password should be at least') ||
    lower.includes('password is too weak')
  ) {
    return 'Your password is too weak. Choose a stronger password with at least 8 characters.';
  }
  if (lower.includes('auth session missing') || lower.includes('session missing')) {
    return 'Your password recovery session is missing or expired. Please request a new password reset link.';
  }
  if (lower.includes('otp_expired') || lower.includes('expired')) {
    return 'Your recovery link or session has expired. Please request a new reset link or sign in again.';
  }
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return 'Too many attempts. Please wait a moment before trying again.';
  }
  if (lower.includes('jwt expired') || lower.includes('session')) {
    return 'Your session has expired. Please sign in again.';
  }
  if (lower.includes('failed to fetch') || lower.includes('network')) {
    return 'Network error while contacting authentication server. Please check your connection and try again.';
  }
  return message || 'Authentication request failed. Please try again.';
}

function normalizeEmployeeProfileRow(raw: unknown): EmployeeProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const authUserId = typeof row.auth_user_id === 'string' ? row.auth_user_id.trim() : '';
  if (!authUserId) return null;

  const rawRole = typeof row.role === 'string' ? row.role.trim().toUpperCase() : '';
  const rawStatus =
    typeof row.account_status === 'string' ? row.account_status.trim().toUpperCase() : '';

  const role: EmployeeRole =
    rawRole === 'ADMIN' || rawRole === 'EMPLOYEE' ? rawRole : 'EMPLOYEE';
  const accountStatus: AccountStatus =
    rawStatus === 'APPROVED' ||
    rawStatus === 'PENDING' ||
    rawStatus === 'REJECTED' ||
    rawStatus === 'SUSPENDED'
      ? rawStatus
      : 'PENDING';

  const hasEmailConfirmedField = Object.prototype.hasOwnProperty.call(row, 'email_confirmed_at');

  return {
    id: typeof row.id === 'string' ? row.id : authUserId,
    auth_user_id: authUserId,
    full_name: typeof row.full_name === 'string' ? row.full_name : '',
    employee_id: typeof row.employee_id === 'string' ? row.employee_id : '',
    username: typeof row.username === 'string' ? row.username : '',
    email: typeof row.email === 'string' ? row.email : '',
    mobile: typeof row.mobile === 'string' ? row.mobile : '',
    role,
    account_status: accountStatus,
    approved_at: typeof row.approved_at === 'string' ? row.approved_at : null,
    approved_by: typeof row.approved_by === 'string' ? row.approved_by : null,
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : '',
    ...(hasEmailConfirmedField
      ? {
          email_confirmed_at:
            typeof row.email_confirmed_at === 'string' ? row.email_confirmed_at : null,
        }
      : {}),
  };
}

const SESSION_REFRESH_BUFFER_MS = 30_000;
export const AUTH_TIMEOUT_MS = 10_000;

export class AuthTimeoutError extends Error {
  public readonly operation: string;
  public readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${Math.round(timeoutMs / 1000)}s.`);
    this.name = 'AuthTimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Guarantees that any Supabase Auth or PostgREST promise settles within `timeoutMs`
 * so route guards and session checks can never stall indefinitely.
 */
export async function withTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs: number = AUTH_TIMEOUT_MS,
  label = 'Authentication request'
): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = globalThis.setTimeout(() => {
      reject(new AuthTimeoutError(label, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([Promise.resolve(operation), timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
    }
  }
}

function isSessionExpiredOrExpiring(session: Session | null): boolean {
  if (!session?.expires_at) return false;
  return session.expires_at * 1000 <= Date.now() + SESSION_REFRESH_BUFFER_MS;
}

/**
 * Verifies the Supabase client currently holds a valid authenticated session with an
 * access token before issuing PostgREST queries against RLS-protected tables.
 * Enforces a bounded timeout on getSession() and refreshSession(); never logs tokens or passwords.
 */
async function ensureActiveSession(
  sb: SupabaseClient,
  timeoutMs: number = AUTH_TIMEOUT_MS
): Promise<{
  session: Session | null;
  error?: string;
  errorKind?: ProfileErrorKind;
  httpStatus?: number;
}> {
  let sessionData: { session: Session | null } | null = null;
  let sessionError: { message: string; status?: number } | null = null;

  try {
    const res = await withTimeout(sb.auth.getSession(), timeoutMs, 'Session lookup');
    sessionData = res.data;
    sessionError = res.error;
  } catch (err) {
    const isTimeout = err instanceof AuthTimeoutError;
    console.error('[Auth] getSession timed out or threw before profile request:', {
      errorCategory: isTimeout ? 'timeout' : 'network',
      httpStatus: null,
      hasSession: false,
      hasAccessToken: false,
      message: err instanceof Error ? err.message : 'Unknown getSession failure',
    });
    return {
      session: null,
      error: isTimeout
        ? 'Timed out while verifying your authentication session. Check your connection and retry.'
        : 'Unable to verify your authentication session due to a network error. Please retry.',
      errorKind: 'network',
    };
  }

  if (sessionError) {
    console.warn('[Auth] getSession failed before profile request:', {
      errorCategory: 'auth',
      httpStatus: sessionError.status ?? null,
      hasSession: false,
      hasAccessToken: false,
      errorMessage: sessionError.message,
    });
    return {
      session: null,
      error: `Authentication session could not be verified: ${sessionError.message}`,
      errorKind: 'auth',
      httpStatus: sessionError.status,
    };
  }

  let activeSession = sessionData?.session ?? null;

  if (!activeSession || !activeSession.access_token) {
    console.warn('[Auth] Active session unavailable before profile request:', {
      errorCategory: 'auth',
      httpStatus: null,
      hasSession: Boolean(activeSession),
      hasAccessToken: Boolean(activeSession?.access_token),
    });
    return {
      session: null,
      error: 'Your authentication session is missing or expired. Please sign in again.',
      errorKind: 'auth',
    };
  }

  if (isSessionExpiredOrExpiring(activeSession)) {
    if (typeof sb.auth.refreshSession === 'function') {
      try {
        const { data: refreshData, error: refreshError } = await withTimeout(
          sb.auth.refreshSession(),
          timeoutMs,
          'Session refresh'
        );
        if (!refreshError && refreshData?.session?.access_token) {
          activeSession = refreshData.session;
        } else {
          console.warn('[Auth] Session refresh failed before profile request:', {
            errorCategory: 'auth',
            httpStatus: (refreshError as { status?: number } | null)?.status ?? null,
            hasSession: true,
            hasAccessToken: false,
            userId: activeSession.user?.id ?? null,
            errorMessage: refreshError?.message ?? 'No refreshed session returned',
          });
          return {
            session: null,
            error: 'Your authentication session has expired. Please sign in again.',
            errorKind: 'auth',
            httpStatus: (refreshError as { status?: number } | null)?.status,
          };
        }
      } catch (err) {
        const isTimeout = err instanceof AuthTimeoutError;
        console.error('[Auth] Session refresh timed out or threw before profile request:', {
          errorCategory: isTimeout ? 'timeout' : 'network',
          httpStatus: null,
          hasSession: true,
          hasAccessToken: false,
          userId: activeSession.user?.id ?? null,
          message: err instanceof Error ? err.message : 'Unknown refreshSession failure',
        });
        return {
          session: null,
          error: isTimeout
            ? 'Timed out while refreshing your authentication session. Please retry or sign in again.'
            : 'Unable to refresh your authentication session. Please check your connection and retry.',
          errorKind: 'network',
        };
      }
    } else if (activeSession.expires_at && activeSession.expires_at * 1000 <= Date.now()) {
      return {
        session: null,
        error: 'Your authentication session has expired. Please sign in again.',
        errorKind: 'auth',
      };
    }
  }

  return { session: activeSession };
}

function classifyProfileFetchError(
  err: unknown,
  httpStatus?: number
): {
  error: string;
  errorKind: ProfileErrorKind;
  errorCode?: string;
  httpStatus?: number;
} {
  const errObj =
    err && typeof err === 'object'
      ? (err as { code?: string; message?: string; details?: string; hint?: string })
      : null;
  const code = typeof errObj?.code === 'string' ? errObj.code.trim() : undefined;
  const rawMessage =
    typeof errObj?.message === 'string'
      ? errObj.message
      : err instanceof Error
        ? err.message
        : 'Unable to load your employee profile.';
  const lower = rawMessage.toLowerCase();
  const statusSuffix = httpStatus ? ` [HTTP ${httpStatus}]` : '';

  if (code === '42P17' || lower.includes('infinite recursion')) {
    return {
      error: `Database RLS policy error (${code ?? '42P17'}${statusSuffix}): Infinite recursion detected while reading public.employee_profiles. Verify that SELECT RLS policies use auth.uid() = auth_user_id without recursive subqueries.`,
      errorKind: 'rls',
      errorCode: code,
      httpStatus,
    };
  }

  if (
    httpStatus === 401 ||
    code === 'PGRST301' ||
    lower.includes('jwt') ||
    lower.includes('unauthorized') ||
    lower.includes('not authenticated') ||
    lower.includes('invalid token')
  ) {
    return {
      error: `Your authentication session expired or could not be verified (${code ?? 'AUTH'}${statusSuffix}). Please sign in again.`,
      errorKind: 'auth',
      errorCode: code,
      httpStatus,
    };
  }

  if (
    code === '42501' ||
    httpStatus === 403 ||
    lower.includes('permission denied') ||
    lower.includes('row-level security') ||
    lower.includes('rls')
  ) {
    return {
      error: `Permission denied (${code ?? '42501'}${statusSuffix}) while reading public.employee_profiles. Verify the authenticated session is active and the authenticated role has SELECT access under RLS policy auth.uid() = auth_user_id.`,
      errorKind: 'rls',
      errorCode: code,
      httpStatus,
    };
  }

  if (
    err instanceof AuthTimeoutError ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('aborted') ||
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('load failed') ||
    lower.includes('network')
  ) {
    const isTimeout = err instanceof AuthTimeoutError || lower.includes('timed out') || lower.includes('timeout');
    return {
      error: isTimeout
        ? 'Timed out while loading your employee profile from Supabase. Please check your connection and retry.'
        : 'Network error while loading your employee profile from Supabase. Check your connection and retry.',
      errorKind: 'network',
      errorCode: code ?? (isTimeout ? 'TIMEOUT' : undefined),
      httpStatus,
    };
  }

  return {
    error: code
      ? `Database error (${code}${statusSuffix}) while loading your employee profile: ${rawMessage}`
      : `Database error${statusSuffix} while loading your employee profile: ${rawMessage}`,
    errorKind: 'database',
    errorCode: code,
    httpStatus,
  };
}

/**
 * Fetches a single public.employee_profiles record by Supabase Auth user UUID
 * using `.eq('auth_user_id', targetUserId)` (never `.eq('id', ...)`).
 * Always verifies an active authenticated session via `supabase.auth.getSession()` first
 * so PostgREST receives `Authorization: Bearer <access_token>` and never falls back to `anon`.
 * Distinguishes expired sessions, RLS denials, network errors, and genuinely missing profiles.
 * Never fabricates an admin or fallback profile. Never logs passwords or access tokens.
 */
export async function fetchEmployeeProfile(
  authUserId: string,
  client?: SupabaseClient | null,
  timeoutMs: number = AUTH_TIMEOUT_MS
): Promise<AuthActionResult<EmployeeProfile | null>> {
  const sb = getClient(client);
  if (!sb) {
    return {
      ok: false,
      error:
        'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY).',
      errorKind: 'auth',
    };
  }

  try {
    const sessionCheck = await ensureActiveSession(sb, timeoutMs);
    if (!sessionCheck.session) {
      return {
        ok: false,
        error:
          sessionCheck.error ??
          'Your authentication session is missing or expired. Please sign in again.',
        errorKind: sessionCheck.errorKind ?? 'auth',
        httpStatus: sessionCheck.httpStatus,
      };
    }

    const activeSession = sessionCheck.session;
    const targetUserId = authUserId?.trim() || activeSession.user.id;

    const executeProfileQuery = () =>
      withTimeout(
        sb
          .from('employee_profiles')
          .select('*')
          .eq('auth_user_id', targetUserId)
          .maybeSingle(),
        timeoutMs,
        'Employee profile lookup'
      );

    let queryRes = await executeProfileQuery();

    // If PostgREST returned 401 / JWT error, attempt one bounded token refresh and retry cleanly
    if (
      queryRes.error &&
      (queryRes.status === 401 ||
        queryRes.error.code === 'PGRST301' ||
        queryRes.error.message?.toLowerCase().includes('jwt')) &&
      typeof sb.auth.refreshSession === 'function'
    ) {
      const { data: refreshed, error: refreshErr } = await withTimeout(
        sb.auth.refreshSession(),
        timeoutMs,
        'Session refresh'
      );
      if (!refreshErr && refreshed?.session?.access_token) {
        queryRes = await executeProfileQuery();
      }
    }

    const { data, error, status } = queryRes;

    if (error) {
      const classified = classifyProfileFetchError(error, status);
      console.error('[Auth] fetchEmployeeProfile failed:', {
        errorCategory: classified.errorKind,
        httpStatus: status ?? null,
        hasSession: true,
        hasAccessToken: Boolean(activeSession.access_token),
        sessionUserId: activeSession.user.id,
        targetUserId,
        code: error.code ?? null,
        message: error.message ?? null,
        details: error.details ?? null,
        hint: error.hint ?? null,
        errorKind: classified.errorKind,
      });
      return {
        ok: false,
        error: classified.error,
        errorKind: classified.errorKind,
        errorCode: classified.errorCode,
        httpStatus: status,
      };
    }

    if (!data) {
      if (isDevEnvironment()) {
        console.info('[Auth] fetchEmployeeProfile returned no matching row:', {
          hasSession: true,
          sessionUserId: activeSession.user.id,
          targetUserId,
          httpStatus: status ?? 200,
        });
      }
      return {
        ok: true,
        data: null,
        httpStatus: status,
      };
    }

    const normalized = normalizeEmployeeProfileRow(data);
    if (!normalized) {
      return {
        ok: false,
        error: 'Employee profile record returned incomplete identity data.',
        errorKind: 'database',
        httpStatus: status,
      };
    }

    if (normalized.auth_user_id !== targetUserId) {
      console.error('[Auth] fetchEmployeeProfile identity mismatch:', {
        errorCategory: 'database',
        httpStatus: status ?? null,
        hasSession: true,
        sessionUserId: activeSession.user.id,
        targetUserId,
        returnedAuthUserId: normalized.auth_user_id,
      });
      return {
        ok: false,
        error: 'Employee profile identity verification failed.',
        errorKind: 'database',
        httpStatus: status,
      };
    }

    if (isDevEnvironment()) {
      console.info('[Auth] fetchEmployeeProfile succeeded:', {
        hasSession: true,
        sessionUserId: activeSession.user.id,
        targetUserId,
        httpStatus: status ?? 200,
        role: normalized.role,
        accountStatus: normalized.account_status,
      });
    }

    return {
      ok: true,
      data: normalized,
      httpStatus: status,
    };
  } catch (err) {
    const classified = classifyProfileFetchError(err);
    console.error('[Auth] fetchEmployeeProfile threw exception:', {
      errorCategory: classified.errorKind,
      httpStatus: null,
      targetUserId: authUserId,
      errorKind: classified.errorKind,
      errorCode: classified.errorCode ?? null,
      message: err instanceof Error ? err.message : 'Unknown error',
    });
    return {
      ok: false,
      error: classified.error,
      errorKind: classified.errorKind,
      errorCode: classified.errorCode,
    };
  }
}

/**
 * Calls the hardened server-side SECURITY DEFINER RPC `ensure_own_employee_profile(...)`
 * to guarantee an authenticated user has their EMPLOYEE + PENDING profile row
 * without ever performing a direct client-side INSERT into public.employee_profiles.
 * Existing profiles (including the approved Super Admin account) are returned untouched.
 */
export async function ensureOwnEmployeeProfile(
  client?: SupabaseClient | null,
  timeoutMs: number = AUTH_TIMEOUT_MS,
  recoveryInput?: ProfileRecoveryInput
): Promise<AuthActionResult<EmployeeProfile | null>> {
  const sb = getClient(client);
  if (!sb) {
    return {
      ok: false,
      error:
        'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY).',
      errorKind: 'auth',
    };
  }

  const sessionCheck = await ensureActiveSession(sb, timeoutMs);
  if (!sessionCheck.session) {
    return {
      ok: false,
      error:
        sessionCheck.error ??
        'Your authentication session is missing or expired. Please sign in again.',
      errorKind: sessionCheck.errorKind ?? 'auth',
      httpStatus: sessionCheck.httpStatus,
    };
  }

  const sessionUserId = sessionCheck.session.user.id;
  if (typeof sb.rpc !== 'function') {
    return { ok: true, data: null, rpcUnavailable: true };
  }

  const rpcParams = recoveryInput
    ? {
        p_full_name: recoveryInput.fullName?.trim() || null,
        p_employee_id: recoveryInput.employeeId?.trim()
          ? normalizeEmployeeId(recoveryInput.employeeId)
          : null,
        p_username: recoveryInput.username?.trim()
          ? normalizeUsername(recoveryInput.username)
          : null,
        p_mobile: recoveryInput.mobile?.trim() || null,
      }
    : undefined;

  try {
    const rpcRes = await withTimeout(
      rpcParams
        ? sb.rpc('ensure_own_employee_profile', rpcParams)
        : sb.rpc('ensure_own_employee_profile'),
      timeoutMs,
      'Employee profile provisioning'
    );

    if (rpcRes.error) {
      if (isMissingRpcError(rpcRes.error)) {
        return { ok: true, data: null, rpcUnavailable: true };
      }

      const rawMsg = rpcRes.error.message ?? '';
      if (rpcRes.error.code === '23505' || rawMsg.toLowerCase().includes('already')) {
        const mapped = mapSignUpError(rawMsg);
        return {
          ok: false,
          error: mapped.error,
          fieldErrors: mapped.fieldErrors,
          errorCode: rpcRes.error.code,
          errorKind: 'database',
          httpStatus: rpcRes.status,
        };
      }

      const classified = classifyProfileFetchError(rpcRes.error, rpcRes.status);
      console.error('[Auth] ensure_own_employee_profile RPC failed:', {
        errorCategory: classified.errorKind,
        httpStatus: rpcRes.status ?? null,
        hasSession: true,
        sessionUserId,
        code: rpcRes.error.code ?? null,
        message: rpcRes.error.message ?? null,
      });
      return {
        ok: false,
        error: classified.error,
        errorKind: classified.errorKind,
        errorCode: classified.errorCode,
        httpStatus: rpcRes.status,
      };
    }

    const row = Array.isArray(rpcRes.data) ? rpcRes.data[0] : rpcRes.data;
    if (!row) {
      return { ok: true, data: null, httpStatus: rpcRes.status };
    }

    const normalized = normalizeEmployeeProfileRow(row);
    if (!normalized || normalized.auth_user_id !== sessionUserId) {
      return {
        ok: false,
        error: 'Employee profile identity verification failed.',
        errorKind: 'database',
        httpStatus: rpcRes.status,
      };
    }

    return { ok: true, data: normalized, httpStatus: rpcRes.status };
  } catch (err) {
    const classified = classifyProfileFetchError(err);
    console.error('[Auth] ensure_own_employee_profile threw exception:', {
      errorCategory: classified.errorKind,
      httpStatus: null,
      hasSession: true,
      sessionUserId,
      message: err instanceof Error ? err.message : 'Unknown error',
    });
    return {
      ok: false,
      error: classified.error,
      errorKind: classified.errorKind,
      errorCode: classified.errorCode,
    };
  }
}

function hasRegistrationMetadata(user: User | null | undefined): boolean {
  const meta = user?.user_metadata as Record<string, unknown> | undefined;
  if (!meta) return false;
  return Boolean(
    (typeof meta.full_name === 'string' && meta.full_name.trim()) ||
      (typeof meta.employee_id === 'string' && meta.employee_id.trim()) ||
      (typeof meta.username === 'string' && meta.username.trim())
  );
}

/**
 * Registers a new EMPLOYEE account via Supabase Auth signUp().
 * Relies exclusively on the database auth.users trigger (and secure server-side
 * RPC fallback) to create public.employee_profiles with role = 'EMPLOYEE' and
 * account_status = 'PENDING'. Never performs a client-side INSERT.
 */
export async function registerEmployee(
  input: EmployeeRegistrationInput,
  client?: SupabaseClient | null,
  emailRedirectTo?: string
): Promise<AuthActionResult<RegisterResult>> {
  const validation = validateRegistrationInput(input);
  if (!validation.valid) {
    return {
      ok: false,
      error: 'Please correct the highlighted fields before submitting.',
      fieldErrors: validation.fieldErrors,
    };
  }

  const sb = getClient(client);
  if (!sb) {
    return {
      ok: false,
      error:
        'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY).',
    };
  }

  const normalizedEmail = normalizeEmail(input.email);
  const normalizedUsername = normalizeUsername(input.username);
  const normalizedEmployeeId = normalizeEmployeeId(input.employeeId);
  const trimmedFullName = input.fullName.trim();
  const trimmedMobile = input.mobile.trim();

  // Redirect email confirmation links to /auth/callback on the active app origin (never localhost)
  const redirectUrl = buildAuthRedirectUrl('/auth/callback', emailRedirectTo);

  let signUpData: { user: User | null; session: Session | null };
  let signUpError: { message: string } | null;
  try {
    const res = await withTimeout(
      sb.auth.signUp({
        email: normalizedEmail,
        password: input.password,
        options: {
          emailRedirectTo: redirectUrl,
          data: {
            full_name: trimmedFullName,
            employee_id: normalizedEmployeeId,
            username: normalizedUsername,
            mobile: trimmedMobile,
          },
        },
      }),
      AUTH_TIMEOUT_MS,
      'Employee registration'
    );
    signUpData = res.data;
    signUpError = res.error;
  } catch (err) {
    const isTimeout = err instanceof AuthTimeoutError;
    return {
      ok: false,
      error: isTimeout
        ? 'Registration timed out while contacting the authentication server. Please try again.'
        : mapAuthError(err instanceof Error ? err.message : 'Registration failed'),
    };
  }

  if (signUpError) {
    const mapped = mapSignUpError(signUpError.message);
    return {
      ok: false,
      error: mapped.error,
      fieldErrors: mapped.fieldErrors,
    };
  }

  const user = signUpData.user;
  const session = signUpData.session;

  // Supabase returns a user with empty identities array when email already exists and confirmations are on
  if (user && Array.isArray(user.identities) && user.identities.length === 0) {
    return {
      ok: false,
      error: 'An account with this email address already exists.',
      fieldErrors: { email: 'This email address is already registered.' },
    };
  }

  if (!user) {
    return {
      ok: false,
      error: 'Registration could not be completed. Please try again.',
    };
  }

  // Email confirmation required: no session yet -> DB auth.users trigger creates the PENDING profile
  if (!session) {
    return {
      ok: true,
      data: {
        user,
        session: null,
        profile: null,
        requiresEmailConfirmation: true,
      },
    };
  }

  // Session is active immediately: read the trigger-created employee profile (no client-side INSERT)
  const existing = await fetchEmployeeProfile(user.id, sb);
  if (!existing.ok) {
    return {
      ok: false,
      error:
        existing.error ||
        'Your account was created, but your employee profile could not be verified. Please sign in or contact your administrator.',
    };
  }

  let resolvedProfile = existing.data ?? null;
  if (!resolvedProfile) {
    const ensured = await ensureOwnEmployeeProfile(sb);
    if (ensured.ok && ensured.data) {
      resolvedProfile = ensured.data;
    }
  }

  if (!resolvedProfile) {
    return {
      ok: false,
      error:
        'Your account was created, but your employee profile was not provisioned automatically. Please contact your administrator.',
    };
  }

  return {
    ok: true,
    data: {
      user,
      session,
      profile: resolvedProfile,
      requiresEmailConfirmation: false,
    },
  };
}

/**
 * Signs in with email & password and fetches the associated employee_profiles record.
 */
export async function signInWithEmail(
  email: string,
  password: string,
  client?: SupabaseClient | null
): Promise<AuthActionResult<LoginResult>> {
  const validation = validateLoginInput(email, password);
  if (!validation.valid) {
    return {
      ok: false,
      error: 'Please enter a valid email and password.',
      fieldErrors: validation.fieldErrors,
    };
  }

  const sb = getClient(client);
  if (!sb) {
    return {
      ok: false,
      error: 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
    };
  }

  let signInResult: { data: { user: User | null; session: Session | null }; error: { message: string } | null };
  try {
    signInResult = await withTimeout(
      sb.auth.signInWithPassword({
        email: normalizeEmail(email),
        password,
      }),
      AUTH_TIMEOUT_MS,
      'Sign in'
    );
  } catch (err) {
    const isTimeout = err instanceof AuthTimeoutError;
    return {
      ok: false,
      error: isTimeout
        ? 'Sign-in request timed out. Please check your connection and try again.'
        : mapAuthError(err instanceof Error ? err.message : 'Sign in failed'),
    };
  }

  const { data, error } = signInResult;

  if (error || !data.user || !data.session) {
    return {
      ok: false,
      error: mapAuthError(error?.message ?? 'Invalid login credentials'),
    };
  }

  let activeSession = data.session;

  // Ensure the authenticated session is persisted on the client before querying PostgREST
  // so Authorization: Bearer <access_token> is attached instead of falling back to anon.
  try {
    const { data: currentSessionData } = await withTimeout(
      sb.auth.getSession(),
      AUTH_TIMEOUT_MS,
      'Session verification'
    );
    if (
      !currentSessionData?.session?.access_token &&
      activeSession.access_token &&
      activeSession.refresh_token &&
      typeof sb.auth.setSession === 'function'
    ) {
      const { data: syncedData, error: syncError } = await withTimeout(
        sb.auth.setSession({
          access_token: activeSession.access_token,
          refresh_token: activeSession.refresh_token,
        }),
        AUTH_TIMEOUT_MS,
        'Session persistence'
      );
      if (!syncError && syncedData?.session) {
        activeSession = syncedData.session;
      } else if (syncError) {
        console.warn('[Auth] setSession sync after signInWithPassword failed:', {
          errorCategory: 'auth',
          userId: data.user.id,
          errorMessage: syncError.message,
        });
      }
    } else if (currentSessionData?.session) {
      activeSession = currentSessionData.session;
    }
  } catch (err) {
    console.warn('[Auth] Post-login session check timed out or failed:', {
      errorCategory: err instanceof AuthTimeoutError ? 'timeout' : 'network',
      userId: data.user.id,
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }

  const authenticatedUser = activeSession.user ?? data.user;
  const profileRes = await fetchEmployeeProfile(authenticatedUser.id, sb);
  if (!profileRes.ok) {
    return {
      ok: true,
      data: {
        user: authenticatedUser,
        session: activeSession,
        profile: null,
        profileError: profileRes.error ?? 'Unable to load your employee profile.',
        profileErrorKind: profileRes.errorKind ?? 'database',
      },
    };
  }

  let resolvedProfile = profileRes.data ?? null;
  if (!resolvedProfile && hasRegistrationMetadata(authenticatedUser)) {
    const ensured = await ensureOwnEmployeeProfile(sb);
    if (ensured.ok && ensured.data) {
      resolvedProfile = ensured.data;
    }
  }

  return {
    ok: true,
    data: {
      user: authenticatedUser,
      session: activeSession,
      profile: resolvedProfile,
      profileError: null,
      profileErrorKind: null,
    },
  };
}

export async function signOutUser(
  client?: SupabaseClient | null
): Promise<AuthActionResult> {
  const sb = getClient(client);
  if (!sb) return { ok: true };

  const { error } = await sb.auth.signOut();
  if (error) {
    return { ok: false, error: error.message || 'Sign out failed.' };
  }
  return { ok: true };
}

export async function requestPasswordReset(
  email: string,
  client?: SupabaseClient | null,
  redirectTo?: string
): Promise<AuthActionResult> {
  const validation = validateForgotPasswordEmail(email);
  if (!validation.valid) {
    return {
      ok: false,
      error: validation.fieldErrors.email ?? 'Enter a valid email address.',
      fieldErrors: validation.fieldErrors,
    };
  }

  const sb = getClient(client);
  if (!sb) {
    return {
      ok: false,
      error: 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
    };
  }

  const targetRedirect = buildAuthRedirectUrl('/reset-password', redirectTo);

  const { error } = await sb.auth.resetPasswordForEmail(
    normalizeEmail(email),
    targetRedirect ? { redirectTo: targetRedirect } : undefined
  );

  if (error) {
    return { ok: false, error: mapAuthError(error.message) };
  }

  return { ok: true };
}

export async function updateUserPassword(
  password: string,
  confirmPassword: string,
  client?: SupabaseClient | null
): Promise<AuthActionResult> {
  const validation = validateResetPasswordInput(password, confirmPassword);
  if (!validation.valid) {
    const firstError =
      validation.fieldErrors.password ||
      validation.fieldErrors.confirmPassword ||
      'Please check your new password entries.';
    return {
      ok: false,
      error: firstError,
      fieldErrors: validation.fieldErrors,
    };
  }

  const sb = getClient(client);
  if (!sb) {
    return {
      ok: false,
      error: 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
    };
  }

  try {
    const { data: sessionData, error: sessionError } = await sb.auth.getSession();
    if (sessionError) {
      if (isDevEnvironment()) {
        console.error('[Auth] getSession failed before password update:', sessionError);
      }
      return {
        ok: false,
        error: mapAuthError(sessionError.message),
      };
    }

    const activeSession = sessionData?.session ?? null;
    if (!activeSession) {
      if (isDevEnvironment()) {
        console.warn('[Auth] Password update aborted: no active Supabase recovery session.');
      }
      return {
        ok: false,
        error:
          'Your password recovery session is missing or expired. Please request a new password reset link.',
      };
    }

    if (activeSession.expires_at && activeSession.expires_at * 1000 <= Date.now()) {
      if (isDevEnvironment()) {
        console.warn('[Auth] Password update aborted: recovery session has expired.');
      }
      return {
        ok: false,
        error:
          'Your password recovery session has expired. Please request a new password reset link.',
      };
    }

    const { error } = await sb.auth.updateUser({ password });
    if (error) {
      if (isDevEnvironment()) {
        console.error('[Auth] supabase.auth.updateUser failed:', {
          status: (error as { status?: number }).status,
          code: (error as { code?: string }).code,
          message: error.message,
        });
      }
      return { ok: false, error: mapAuthError(error.message) };
    }

    return { ok: true };
  } catch (err) {
    if (isDevEnvironment()) {
      console.error('[Auth] Unexpected exception during password update:', err);
    }
    const message =
      err instanceof Error
        ? err.message
        : 'Unable to update your password due to an unexpected error.';
    return { ok: false, error: mapAuthError(message) };
  }
}

function isMissingRpcError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const msg = (error.message ?? '').toLowerCase();
  return (
    error.code === 'PGRST202' ||
    msg.includes('could not find the function') ||
    (msg.includes('function') && msg.includes('does not exist'))
  );
}

/**
 * Admin-only query for all employee profiles.
 * Verifies active Supabase session, auth_user_id match, and ADMIN + APPROVED role/status.
 * Prefers the non-recursive SECURITY DEFINER RPC `admin_list_employee_profiles`, falling back
 * to the RLS-protected table SELECT ONLY if the RPC has not yet been deployed (PGRST202).
 */
export async function fetchAllEmployeeProfiles(
  actingProfile: EmployeeProfile | null,
  client?: SupabaseClient | null
): Promise<AuthActionResult<EmployeeProfile[]>> {
  if (!isApprovedAdmin(actingProfile)) {
    return {
      ok: false,
      error: 'Forbidden: Approved administrator privileges are required.',
      errorKind: 'rls',
    };
  }

  const sb = getClient(client);
  if (!sb) {
    return {
      ok: false,
      error: 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
    };
  }

  const sessionCheck = await ensureActiveSession(sb);
  if (!sessionCheck.session) {
    return {
      ok: false,
      error:
        sessionCheck.error ??
        'Your authentication session is missing or expired. Please sign in again.',
      errorKind: sessionCheck.errorKind ?? 'auth',
    };
  }

  const sessionUserId = sessionCheck.session.user.id;
  if (!isApprovedAdmin(actingProfile, sessionUserId)) {
    return {
      ok: false,
      error: 'Forbidden: Active session does not match an approved administrator profile.',
      errorKind: 'rls',
    };
  }

  // Primary server-enforced path: SECURITY DEFINER RPC (non-recursive)
  if (typeof sb.rpc === 'function') {
    try {
      const rpcRes = await withTimeout(
        sb.rpc('admin_list_employee_profiles'),
        AUTH_TIMEOUT_MS,
        'Admin employee directory lookup'
      );
      if (!rpcRes.error) {
        const normalizedRows = Array.isArray(rpcRes.data)
          ? rpcRes.data
              .map((row) => normalizeEmployeeProfileRow(row))
              .filter((row): row is EmployeeProfile => row !== null)
          : [];
        return {
          ok: true,
          data: normalizedRows,
        };
      }

      if (!isMissingRpcError(rpcRes.error)) {
        const classified = classifyProfileFetchError(rpcRes.error, rpcRes.status);
        console.error('[Auth] admin_list_employee_profiles RPC failed:', {
          errorCategory: classified.errorKind,
          hasSession: true,
          sessionUserId,
          httpStatus: rpcRes.status ?? null,
          code: rpcRes.error.code ?? null,
          message: rpcRes.error.message ?? null,
          errorKind: classified.errorKind,
        });
        return {
          ok: false,
          error: classified.error,
          errorKind: classified.errorKind,
          errorCode: classified.errorCode,
          httpStatus: rpcRes.status,
        };
      }
    } catch (err) {
      const classified = classifyProfileFetchError(err);
      console.error('[Auth] admin_list_employee_profiles RPC threw:', {
        errorCategory: classified.errorKind,
        hasSession: true,
        sessionUserId,
        httpStatus: null,
        message: err instanceof Error ? err.message : 'Unknown error',
      });
      return {
        ok: false,
        error: classified.error,
        errorKind: classified.errorKind,
        errorCode: classified.errorCode,
      };
    }
  }

  // Backwards-compatible fallback ONLY when admin_list_employee_profiles RPC is not yet installed
  try {
    const { data, error, status } = await withTimeout(
      sb.from('employee_profiles').select('*').order('created_at', { ascending: false }),
      AUTH_TIMEOUT_MS,
      'Employee directory lookup'
    );

    if (error) {
      const classified = classifyProfileFetchError(error, status);
      console.error('[Auth] fetchAllEmployeeProfiles failed:', {
        errorCategory: classified.errorKind,
        hasSession: true,
        sessionUserId,
        httpStatus: status ?? null,
        code: error.code ?? null,
        message: error.message ?? null,
        errorKind: classified.errorKind,
      });
      return {
        ok: false,
        error: classified.error,
        errorKind: classified.errorKind,
        errorCode: classified.errorCode,
        httpStatus: status,
      };
    }

    const normalizedRows = Array.isArray(data)
      ? data
          .map((row) => normalizeEmployeeProfileRow(row))
          .filter((row): row is EmployeeProfile => row !== null)
      : [];

    return {
      ok: true,
      data: normalizedRows,
    };
  } catch (err) {
    const classified = classifyProfileFetchError(err);
    return {
      ok: false,
      error: classified.error,
      errorKind: classified.errorKind,
      errorCode: classified.errorCode,
    };
  }
}

/**
 * Admin-only detail lookup for a single employee profile.
 * Enforces active session + ADMIN + APPROVED + auth_user_id verification and uses
 * the SECURITY DEFINER RPC `admin_get_employee_profile` when available.
 */
export async function adminGetEmployeeProfile(
  profileId: string,
  actingAdmin: EmployeeProfile | null,
  client?: SupabaseClient | null
): Promise<AuthActionResult<EmployeeProfile>> {
  if (!isApprovedAdmin(actingAdmin) || !actingAdmin) {
    return {
      ok: false,
      error: 'Forbidden: Only an approved administrator can view employee details.',
      errorKind: 'rls',
    };
  }

  const sb = getClient(client);
  if (!sb) {
    return {
      ok: false,
      error: 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
    };
  }

  const sessionCheck = await ensureActiveSession(sb);
  if (!sessionCheck.session) {
    return {
      ok: false,
      error:
        sessionCheck.error ??
        'Your authentication session is missing or expired. Please sign in again.',
      errorKind: sessionCheck.errorKind ?? 'auth',
    };
  }

  const sessionUserId = sessionCheck.session.user.id;
  if (!isApprovedAdmin(actingAdmin, sessionUserId)) {
    return {
      ok: false,
      error: 'Forbidden: Active session does not match an approved administrator profile.',
      errorKind: 'rls',
    };
  }

  if (typeof sb.rpc === 'function') {
    try {
      const rpcRes = await withTimeout(
        sb.rpc('admin_get_employee_profile', {
          p_profile_id: profileId,
        }),
        AUTH_TIMEOUT_MS,
        'Employee detail lookup'
      );

      if (!rpcRes.error) {
        const row = Array.isArray(rpcRes.data) ? rpcRes.data[0] : rpcRes.data;
        const normalized = normalizeEmployeeProfileRow(row);
        if (!normalized) {
          return {
            ok: false,
            error: 'Employee profile not found.',
            errorKind: 'database',
          };
        }
        return { ok: true, data: normalized };
      }

      if (!isMissingRpcError(rpcRes.error)) {
        const classified = classifyProfileFetchError(rpcRes.error, rpcRes.status);
        return {
          ok: false,
          error: classified.error,
          errorKind: classified.errorKind,
          errorCode: classified.errorCode,
          httpStatus: rpcRes.status,
        };
      }
    } catch (err) {
      const classified = classifyProfileFetchError(err);
      return {
        ok: false,
        error: classified.error,
        errorKind: classified.errorKind,
        errorCode: classified.errorCode,
      };
    }
  }

  try {
    const { data, error, status } = await withTimeout(
      sb.from('employee_profiles').select('*').eq('id', profileId).maybeSingle(),
      AUTH_TIMEOUT_MS,
      'Employee detail lookup'
    );

    if (error) {
      const classified = classifyProfileFetchError(error, status);
      return {
        ok: false,
        error: classified.error,
        errorKind: classified.errorKind,
        errorCode: classified.errorCode,
        httpStatus: status,
      };
    }

    const normalized = normalizeEmployeeProfileRow(data);
    if (!normalized) {
      return {
        ok: false,
        error: 'Employee profile not found.',
      };
    }

    return { ok: true, data: normalized };
  } catch (err) {
    const classified = classifyProfileFetchError(err);
    return {
      ok: false,
      error: classified.error,
      errorKind: classified.errorKind,
      errorCode: classified.errorCode,
    };
  }
}

/**
 * Admin-only status update (APPROVE / REJECT / SUSPEND / REACTIVATE).
 * Enforces:
 * - Active authenticated Supabase session with matching auth_user_id
 * - Acting user must be ADMIN + APPROVED
 * - Admin cannot modify their own account or any ADMIN account
 * - Uses ONLY the SECURITY DEFINER RPC `admin_update_employee_status`
 * - Never falls back to a direct client-side table UPDATE
 */
export async function adminUpdateEmployeeStatus(
  targetProfile: EmployeeProfile,
  newStatus: Extract<AccountStatus, 'APPROVED' | 'REJECTED' | 'SUSPENDED'>,
  actingAdmin: EmployeeProfile | null,
  client?: SupabaseClient | null
): Promise<AuthActionResult<EmployeeProfile>> {
  if (!isApprovedAdmin(actingAdmin) || !actingAdmin) {
    return {
      ok: false,
      error: 'Forbidden: Only an approved administrator can perform this action.',
      errorKind: 'rls',
    };
  }

  if (targetProfile.auth_user_id === actingAdmin.auth_user_id) {
    return {
      ok: false,
      error: 'Administrators cannot modify their own account status or role.',
    };
  }

  if (targetProfile.role === 'ADMIN') {
    return {
      ok: false,
      error: 'Administrator accounts cannot be modified through employee management actions.',
    };
  }

  const sb = getClient(client);
  if (!sb) {
    return {
      ok: false,
      error:
        'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY).',
    };
  }

  const sessionCheck = await ensureActiveSession(sb);
  if (!sessionCheck.session) {
    return {
      ok: false,
      error:
        sessionCheck.error ??
        'Your authentication session is missing or expired. Please sign in again.',
      errorKind: sessionCheck.errorKind ?? 'auth',
    };
  }

  const sessionUserId = sessionCheck.session.user.id;
  if (!isApprovedAdmin(actingAdmin, sessionUserId)) {
    return {
      ok: false,
      error: 'Forbidden: Active session does not match an approved administrator profile.',
      errorKind: 'rls',
    };
  }

  if (targetProfile.auth_user_id === sessionUserId) {
    return {
      ok: false,
      error: 'Administrators cannot modify their own account status or role.',
    };
  }

  let data: unknown;
  let error: { code?: string; message?: string } | null = null;
  let status: number | undefined;
  try {
    const res = await withTimeout(
      sb.rpc('admin_update_employee_status', {
        p_profile_id: targetProfile.id,
        p_new_status: newStatus,
      }),
      AUTH_TIMEOUT_MS,
      'Admin status update'
    );
    data = res.data;
    error = res.error;
    status = res.status;
  } catch (err) {
    const classified = classifyProfileFetchError(err);
    return {
      ok: false,
      error: classified.error,
      errorKind: classified.errorKind,
      errorCode: classified.errorCode,
    };
  }

  if (error) {
    if (isMissingRpcError(error)) {
      return {
        ok: false,
        error:
          'The admin_update_employee_status database function is unavailable. Please ensure the latest Supabase migration has been applied.',
      };
    }

    return {
      ok: false,
      error: error.message || 'Administrative status update failed.',
      errorCode: error.code,
      httpStatus: status,
    };
  }

  const updatedRow = Array.isArray(data) ? data[0] : data;
  const normalized = normalizeEmployeeProfileRow(updatedRow);
  if (!normalized) {
    return {
      ok: false,
      error: 'Administrative status update did not return an updated employee record.',
    };
  }

  return {
    ok: true,
    data: normalized,
  };
}
