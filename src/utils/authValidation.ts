import {
  AdminDashboardStats,
  AppRoute,
  AuthValidationResult,
  EmployeeProfile,
  EmployeeRegistrationInput,
} from '../types/auth';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME_REGEX = /^[a-zA-Z0-9._-]{3,32}$/;
const EMPLOYEE_ID_REGEX = /^[A-Za-z0-9_-]{3,24}$/;
const MOBILE_REGEX = /^\+?[0-9\s\-()]{7,20}$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function normalizeEmployeeId(employeeId: string): string {
  return employeeId.trim().toUpperCase();
}

export function validatePasswordStrength(password: string): string | null {
  if (!password) return 'Password is required.';
  if (password.length < 8) return 'Password must be at least 8 characters long.';
  if (!/[A-Z]/.test(password)) return 'Password must include at least one uppercase letter.';
  if (!/[a-z]/.test(password)) return 'Password must include at least one lowercase letter.';
  if (!/[0-9]/.test(password)) return 'Password must include at least one number.';
  return null;
}

export function validateLoginInput(email: string, password: string): AuthValidationResult {
  const fieldErrors: Record<string, string> = {};
  const trimmedEmail = normalizeEmail(email);

  if (!trimmedEmail) {
    fieldErrors.email = 'Email address is required.';
  } else if (!EMAIL_REGEX.test(trimmedEmail)) {
    fieldErrors.email = 'Enter a valid email address.';
  }

  if (!password) {
    fieldErrors.password = 'Password is required.';
  }

  return {
    valid: Object.keys(fieldErrors).length === 0,
    fieldErrors,
  };
}

export function validateRegistrationInput(
  input: EmployeeRegistrationInput
): AuthValidationResult {
  const fieldErrors: Record<string, string> = {};

  const fullName = input.fullName.trim();
  const employeeId = input.employeeId.trim();
  const username = input.username.trim();
  const email = normalizeEmail(input.email);
  const mobile = input.mobile.trim();

  if (!fullName) {
    fieldErrors.fullName = 'Full name is required.';
  } else if (fullName.length < 2) {
    fieldErrors.fullName = 'Full name must be at least 2 characters.';
  } else if (fullName.length > 100) {
    fieldErrors.fullName = 'Full name must be 100 characters or fewer.';
  }

  if (!employeeId) {
    fieldErrors.employeeId = 'Employee ID is required.';
  } else if (!EMPLOYEE_ID_REGEX.test(employeeId)) {
    fieldErrors.employeeId =
      'Employee ID must be 3–24 characters using letters, numbers, hyphens, or underscores.';
  }

  if (!username) {
    fieldErrors.username = 'Username is required.';
  } else if (!USERNAME_REGEX.test(username)) {
    fieldErrors.username =
      'Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens.';
  }

  if (!email) {
    fieldErrors.email = 'Email address is required.';
  } else if (!EMAIL_REGEX.test(email)) {
    fieldErrors.email = 'Enter a valid email address.';
  }

  const digitsOnly = mobile.replace(/\D/g, '');
  if (!mobile) {
    fieldErrors.mobile = 'Mobile number is required.';
  } else if (!MOBILE_REGEX.test(mobile) || digitsOnly.length < 7 || digitsOnly.length > 15) {
    fieldErrors.mobile = 'Enter a valid mobile number (7–15 digits).';
  }

  const passwordErr = validatePasswordStrength(input.password);
  if (passwordErr) {
    fieldErrors.password = passwordErr;
  }

  if (!input.confirmPassword) {
    fieldErrors.confirmPassword = 'Please confirm your password.';
  } else if (input.password !== input.confirmPassword) {
    fieldErrors.confirmPassword = 'Passwords do not match.';
  }

  return {
    valid: Object.keys(fieldErrors).length === 0,
    fieldErrors,
  };
}

export function validateForgotPasswordEmail(email: string): AuthValidationResult {
  const fieldErrors: Record<string, string> = {};
  const trimmedEmail = normalizeEmail(email);

  if (!trimmedEmail) {
    fieldErrors.email = 'Email address is required.';
  } else if (!EMAIL_REGEX.test(trimmedEmail)) {
    fieldErrors.email = 'Enter a valid email address.';
  }

  return {
    valid: Object.keys(fieldErrors).length === 0,
    fieldErrors,
  };
}

export function validateResetPasswordInput(
  password: string,
  confirmPassword: string
): AuthValidationResult {
  const fieldErrors: Record<string, string> = {};

  if (!password) {
    fieldErrors.password = 'New password is required.';
  } else if (password.length < 8) {
    fieldErrors.password = 'Password must be at least 8 characters long.';
  }

  if (!confirmPassword) {
    fieldErrors.confirmPassword = 'Please confirm your new password.';
  } else if (password !== confirmPassword) {
    fieldErrors.confirmPassword = 'Passwords do not match.';
  }

  return {
    valid: Object.keys(fieldErrors).length === 0,
    fieldErrors,
  };
}

export function isApprovedAdmin(profile: EmployeeProfile | null): boolean {
  return Boolean(profile && profile.role === 'ADMIN' && profile.account_status === 'APPROVED');
}

export function isApprovedUser(profile: EmployeeProfile | null): boolean {
  return Boolean(
    profile &&
      (profile.role === 'ADMIN' || profile.role === 'EMPLOYEE') &&
      profile.account_status === 'APPROVED'
  );
}

/**
 * Determines the authoritative landing route for an authenticated user based on
 * their employee_profiles record. Never defaults to ADMIN when profile is missing.
 */
export function resolvePostLoginRoute(profile: EmployeeProfile | null): AppRoute {
  if (!profile) return 'profile-missing';

  if (profile.account_status === 'REJECTED') {
    return 'account-rejected';
  }
  if (profile.account_status === 'SUSPENDED') {
    return 'account-suspended';
  }
  if (profile.account_status === 'PENDING') {
    return 'pending-approval';
  }

  if (profile.role === 'ADMIN' && profile.account_status === 'APPROVED') {
    return 'admin';
  }
  if (profile.role === 'EMPLOYEE' && profile.account_status === 'APPROVED') {
    return 'employee-dashboard';
  }

  return 'profile-missing';
}

export interface RouteAccessContext {
  isAuthenticated: boolean;
  isLoading: boolean;
  profile: EmployeeProfile | null;
  profileError?: string | null;
  isRecoveryMode?: boolean;
}

export interface RouteAccessDecision {
  allowed: boolean;
  redirectTo?: AppRoute;
  reason?:
    | 'unauthenticated'
    | 'unauthorized-admin'
    | 'pending'
    | 'rejected'
    | 'suspended'
    | 'missing-profile'
    | 'profile-error'
    | 'already-authenticated';
}

const PUBLIC_ROUTES = new Set<AppRoute>([
  'login',
  'register',
  'forgot-password',
  'reset-password',
]);

const PROTECTED_DESIGN_ROUTES = new Set<AppRoute>([
  'home',
  'studio',
  'summary',
  'employee-dashboard',
]);

/**
 * Evaluates whether the current user may view a given route, including direct URL visits.
 */
export function evaluateRouteAccess(
  route: AppRoute,
  ctx: RouteAccessContext
): RouteAccessDecision {
  if (ctx.isLoading) {
    return { allowed: true };
  }

  // Always allow password reset page when in recovery mode or unauthenticated recovery link
  if (route === 'reset-password') {
    return { allowed: true };
  }

  // Authenticated user whose profile query failed (RLS, network, or DB error) — never treat as missing profile
  if (ctx.isAuthenticated && !ctx.isRecoveryMode && !ctx.profile && ctx.profileError) {
    return {
      allowed: false,
      reason: 'profile-error',
    };
  }

  // Auth entry routes (login, register, forgot-password)
  if (route === 'login' || route === 'register' || route === 'forgot-password') {
    if (ctx.isAuthenticated && !ctx.isRecoveryMode) {
      return {
        allowed: false,
        redirectTo: resolvePostLoginRoute(ctx.profile),
        reason: 'already-authenticated',
      };
    }
    return { allowed: true };
  }

  // Every other route requires an authenticated session
  if (!ctx.isAuthenticated) {
    if (!PUBLIC_ROUTES.has(route)) {
      return {
        allowed: false,
        redirectTo: 'login',
        reason: 'unauthenticated',
      };
    }
    return { allowed: true };
  }

  // Authenticated user genuinely without an employee_profiles row (no DB/RLS error)
  if (!ctx.profile) {
    if (route === 'profile-missing') {
      return { allowed: true };
    }
    return {
      allowed: false,
      redirectTo: 'profile-missing',
      reason: 'missing-profile',
    };
  }

  // Status-restricted users cannot access any protected studio, dashboard, or admin route
  if (ctx.profile.account_status === 'PENDING') {
    if (route === 'pending-approval') return { allowed: true };
    return { allowed: false, redirectTo: 'pending-approval', reason: 'pending' };
  }
  if (ctx.profile.account_status === 'REJECTED') {
    if (route === 'account-rejected') return { allowed: true };
    return { allowed: false, redirectTo: 'account-rejected', reason: 'rejected' };
  }
  if (ctx.profile.account_status === 'SUSPENDED') {
    if (route === 'account-suspended') return { allowed: true };
    return { allowed: false, redirectTo: 'account-suspended', reason: 'suspended' };
  }

  // Approved user visiting a non-approved status page -> send to their dashboard
  if (
    route === 'pending-approval' ||
    route === 'account-rejected' ||
    route === 'account-suspended' ||
    route === 'profile-missing'
  ) {
    return {
      allowed: false,
      redirectTo: resolvePostLoginRoute(ctx.profile),
    };
  }

  // Admin dashboard strictly requires ADMIN + APPROVED
  if (route === 'admin') {
    if (isApprovedAdmin(ctx.profile)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      redirectTo: 'employee-dashboard',
      reason: 'unauthorized-admin',
    };
  }

  // Protected Design Studio, Summary, and Employee Dashboard require APPROVED status
  if (PROTECTED_DESIGN_ROUTES.has(route)) {
    if (isApprovedUser(ctx.profile)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      redirectTo: resolvePostLoginRoute(ctx.profile),
      reason: 'missing-profile',
    };
  }

  return { allowed: true };
}

export function computeAdminStats(profiles: EmployeeProfile[]): AdminDashboardStats {
  let pending = 0;
  let approved = 0;
  let rejected = 0;
  let suspended = 0;

  for (const p of profiles) {
    if (p.account_status === 'PENDING') pending += 1;
    else if (p.account_status === 'APPROVED') approved += 1;
    else if (p.account_status === 'REJECTED') rejected += 1;
    else if (p.account_status === 'SUSPENDED') suspended += 1;
  }

  return {
    total: profiles.length,
    pending,
    approved,
    rejected,
    suspended,
  };
}
