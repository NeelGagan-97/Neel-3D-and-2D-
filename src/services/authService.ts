import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import { supabase as defaultSupabaseClient } from '../lib/supabase';
import {
  AccountStatus,
  EmployeeProfile,
  EmployeeRegistrationInput,
  EmployeeRole,
  ProfileErrorKind,
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
  path: '/login' | '/reset-password',
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
  };
}

function classifyProfileFetchError(err: unknown): {
  error: string;
  errorKind: ProfileErrorKind;
  errorCode?: string;
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

  if (
    code === '42P17' ||
    lower.includes('infinite recursion')
  ) {
    return {
      error: `Database RLS policy error (${code ?? '42P17'}): Infinite recursion detected while reading public.employee_profiles. Verify that SELECT RLS policies use auth.uid() = auth_user_id without recursive subqueries.`,
      errorKind: 'rls',
      errorCode: code,
    };
  }

  if (
    code === '42501' ||
    lower.includes('permission denied') ||
    lower.includes('row-level security') ||
    lower.includes('rls')
  ) {
    return {
      error: `Permission denied (${code ?? '42501'}) while reading public.employee_profiles. Ensure authenticated users have SELECT access with policy auth.uid() = auth_user_id.`,
      errorKind: 'rls',
      errorCode: code,
    };
  }

  if (
    code === 'PGRST301' ||
    lower.includes('jwt') ||
    lower.includes('unauthorized') ||
    lower.includes('not authenticated') ||
    lower.includes('invalid token')
  ) {
    return {
      error: `Authentication error while loading your employee profile (${code ?? 'AUTH'}): ${rawMessage}`,
      errorKind: 'auth',
      errorCode: code,
    };
  }

  if (
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('load failed') ||
    lower.includes('network') ||
    lower.includes('timeout')
  ) {
    return {
      error:
        'Network error while loading your employee profile from Supabase. Check your connection and retry.',
      errorKind: 'network',
      errorCode: code,
    };
  }

  return {
    error: code
      ? `Database error (${code}) while loading your employee profile: ${rawMessage}`
      : `Database error while loading your employee profile: ${rawMessage}`,
    errorKind: 'database',
    errorCode: code,
  };
}

/**
 * Fetches a single public.employee_profiles record by Supabase Auth user UUID
 * using `.eq('auth_user_id', authUserId)` (never `.eq('id', authUserId)`).
 * Distinguishes database/RLS/network errors from a genuinely missing profile row.
 * Never fabricates an admin or fallback profile.
 */
export async function fetchEmployeeProfile(
  authUserId: string,
  client?: SupabaseClient | null
): Promise<AuthActionResult<EmployeeProfile | null>> {
  const sb = getClient(client);
  if (!sb) {
    return {
      ok: false,
      error: 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
      errorKind: 'auth',
    };
  }

  try {
    const { data, error } = await sb
      .from('employee_profiles')
      .select('*')
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    if (error) {
      const classified = classifyProfileFetchError(error);
      if (isDevEnvironment()) {
        console.error('[Auth] fetchEmployeeProfile failed:', {
          authUserId,
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
          errorKind: classified.errorKind,
        });
      }
      return {
        ok: false,
        error: classified.error,
        errorKind: classified.errorKind,
        errorCode: classified.errorCode,
      };
    }

    if (!data) {
      return {
        ok: true,
        data: null,
      };
    }

    const normalized = normalizeEmployeeProfileRow(data);
    if (!normalized) {
      return {
        ok: false,
        error: 'Employee profile record returned incomplete identity data.',
        errorKind: 'database',
      };
    }

    return {
      ok: true,
      data: normalized,
    };
  } catch (err) {
    const classified = classifyProfileFetchError(err);
    if (isDevEnvironment()) {
      console.error('[Auth] fetchEmployeeProfile threw exception:', err);
    }
    return {
      ok: false,
      error: classified.error,
      errorKind: classified.errorKind,
      errorCode: classified.errorCode,
    };
  }
}

/**
 * Registers a new EMPLOYEE account via Supabase Auth signUp().
 * Relies exclusively on the database auth.users trigger to create the
 * public.employee_profiles record with role = 'EMPLOYEE' and account_status = 'PENDING'.
 * Never performs a client-side INSERT into employee_profiles.
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
      error: 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
    };
  }

  const normalizedEmail = normalizeEmail(input.email);
  const normalizedUsername = normalizeUsername(input.username);
  const normalizedEmployeeId = normalizeEmployeeId(input.employeeId);
  const trimmedFullName = input.fullName.trim();
  const trimmedMobile = input.mobile.trim();

  // Create Supabase Auth user with registration metadata consumed by the auth.users trigger
  const redirectUrl = buildAuthRedirectUrl('/login', emailRedirectTo);

  const { data: signUpData, error: signUpError } = await sb.auth.signUp({
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
  });

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

  if (!existing.data) {
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
      profile: existing.data,
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

  const { data, error } = await sb.auth.signInWithPassword({
    email: normalizeEmail(email),
    password,
  });

  if (error || !data.user || !data.session) {
    return {
      ok: false,
      error: mapAuthError(error?.message ?? 'Invalid login credentials'),
    };
  }

  const authenticatedUser = data.session.user ?? data.user;
  const profileRes = await fetchEmployeeProfile(authenticatedUser.id, sb);
  if (!profileRes.ok) {
    return {
      ok: true,
      data: {
        user: authenticatedUser,
        session: data.session,
        profile: null,
        profileError: profileRes.error ?? 'Unable to load your employee profile.',
        profileErrorKind: profileRes.errorKind ?? 'database',
      },
    };
  }

  return {
    ok: true,
    data: {
      user: authenticatedUser,
      session: data.session,
      profile: profileRes.data ?? null,
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

/**
 * Admin-only query for all employee profiles.
 * Protected at both application layer and PostgreSQL RLS layer.
 */
export async function fetchAllEmployeeProfiles(
  actingProfile: EmployeeProfile | null,
  client?: SupabaseClient | null
): Promise<AuthActionResult<EmployeeProfile[]>> {
  if (!isApprovedAdmin(actingProfile)) {
    return {
      ok: false,
      error: 'Forbidden: Approved administrator privileges are required.',
    };
  }

  const sb = getClient(client);
  if (!sb) {
    return {
      ok: false,
      error: 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
    };
  }

  const { data, error } = await sb
    .from('employee_profiles')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return {
      ok: false,
      error: error.message || 'Unable to load employee records.',
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
}

/**
 * Admin-only status update (APPROVE / REJECT / SUSPEND / REACTIVATE).
 * Enforces:
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
      error: 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
    };
  }

  const { data, error } = await sb.rpc('admin_update_employee_status', {
    p_profile_id: targetProfile.id,
    p_new_status: newStatus,
  });

  if (error) {
    const errMsg = error.message ?? '';
    const isMissingRpc =
      error.code === 'PGRST202' ||
      errMsg.toLowerCase().includes('could not find the function') ||
      errMsg.toLowerCase().includes('does not exist');

    if (isMissingRpc) {
      return {
        ok: false,
        error:
          'The admin_update_employee_status database function is unavailable. Please ensure the latest Supabase migration has been applied.',
      };
    }

    return {
      ok: false,
      error: errMsg || 'Administrative status update failed.',
    };
  }

  const updatedRow = Array.isArray(data) ? data[0] : data;
  if (!updatedRow) {
    return {
      ok: false,
      error: 'Administrative status update did not return an updated employee record.',
    };
  }

  return {
    ok: true,
    data: updatedRow as EmployeeProfile,
  };
}
