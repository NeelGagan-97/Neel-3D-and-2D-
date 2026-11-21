import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import { supabase as defaultSupabaseClient } from '../lib/supabase';
import {
  AccountStatus,
  EmployeeProfile,
  EmployeeRegistrationInput,
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

/**
 * Fetches a single employee_profiles record by Supabase Auth user UUID.
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
    };
  }

  const { data, error } = await sb
    .from('employee_profiles')
    .select(
      'id, auth_user_id, full_name, employee_id, username, email, mobile, role, account_status, approved_at, approved_by, created_at, updated_at'
    )
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      error: error.message || 'Unable to load your employee profile.',
    };
  }

  return {
    ok: true,
    data: (data as EmployeeProfile | null) ?? null,
  };
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

  const profileRes = await fetchEmployeeProfile(data.user.id, sb);
  if (!profileRes.ok) {
    return {
      ok: true,
      data: {
        user: data.user,
        session: data.session,
        profile: null,
      },
    };
  }

  return {
    ok: true,
    data: {
      user: data.user,
      session: data.session,
      profile: profileRes.data ?? null,
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
    .select(
      'id, auth_user_id, full_name, employee_id, username, email, mobile, role, account_status, approved_at, approved_by, created_at, updated_at'
    )
    .order('created_at', { ascending: false });

  if (error) {
    return {
      ok: false,
      error: error.message || 'Unable to load employee records.',
    };
  }

  return {
    ok: true,
    data: (data as EmployeeProfile[]) ?? [],
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
