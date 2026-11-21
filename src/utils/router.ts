import { AppRoute } from '../types/auth';

const ROUTE_TO_PATH: Record<AppRoute, string> = {
  home: '/home',
  studio: '/studio',
  summary: '/summary',
  login: '/login',
  register: '/register',
  'forgot-password': '/forgot-password',
  'reset-password': '/reset-password',
  'employee-dashboard': '/employee-dashboard',
  admin: '/admin',
  'pending-approval': '/pending-approval',
  'account-rejected': '/account-rejected',
  'account-suspended': '/account-suspended',
  'profile-missing': '/profile-missing',
};

const PATH_TO_ROUTE: Record<string, AppRoute> = Object.fromEntries(
  Object.entries(ROUTE_TO_PATH).map(([route, path]) => [path, route as AppRoute])
);

export function routeToPath(route: AppRoute): string {
  return ROUTE_TO_PATH[route] ?? '/login';
}

export function isRecoveryUrl(
  search: string,
  hash: string,
  pathname = ''
): boolean {
  const normalizedHash = hash.toLowerCase();
  const normalizedSearch = search.toLowerCase();
  const cleanPath = pathname.replace(/\/+$/, '') || '/';

  if (
    normalizedHash.includes('type=recovery') ||
    normalizedSearch.includes('type=recovery')
  ) {
    return true;
  }

  if (cleanPath === '/reset-password') {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    const hashParams = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    if (params.has('code') || params.has('token_hash') || hashParams.has('access_token')) {
      return true;
    }
  }

  return false;
}

export function parseRecoveryTokenHash(search: string): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const type = params.get('type')?.toLowerCase();
  const tokenHash = params.get('token_hash')?.trim();
  if (type === 'recovery' && tokenHash) {
    return tokenHash;
  }
  return null;
}

export function parseRecoveryCode(pathname: string, search: string): string | null {
  const cleanPath = pathname.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const code = params.get('code')?.trim();
  const type = params.get('type')?.toLowerCase();
  if (code && (cleanPath === '/reset-password' || type === 'recovery')) {
    return code;
  }
  return null;
}

export function parseAuthErrorFromUrl(search: string, hash: string): string | null {
  const searchParams = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const hashParams = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);

  const errorCode = (
    hashParams.get('error_code') ||
    searchParams.get('error_code') ||
    ''
  ).toLowerCase();
  const errorDesc =
    hashParams.get('error_description') ||
    searchParams.get('error_description') ||
    hashParams.get('error') ||
    searchParams.get('error');

  if (!errorCode && !errorDesc) return null;

  if (
    errorCode === 'otp_expired' ||
    (errorDesc && errorDesc.toLowerCase().includes('expired'))
  ) {
    return 'This password reset link has expired or has already been used. Please request a new recovery link.';
  }

  if (errorDesc) {
    return errorDesc.replace(/\+/g, ' ');
  }

  return 'The password recovery link is invalid. Please request a new recovery link.';
}

export function clearAuthUrlParams(): void {
  if (typeof window === 'undefined') return;
  try {
    const cleanPath = window.location.pathname || '/reset-password';
    if (window.location.search || window.location.hash) {
      window.history.replaceState(window.history.state, '', cleanPath);
    }
  } catch {
    // Ignore history API restrictions in sandboxed environments
  }
}

export function parseRouteFromLocation(
  pathname: string,
  search = '',
  hash = ''
): AppRoute {
  if (isRecoveryUrl(search, hash, pathname)) {
    return 'reset-password';
  }
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === '/') {
    return 'login';
  }
  return PATH_TO_ROUTE[clean] ?? 'login';
}

export function syncBrowserPath(route: AppRoute, replace = false): void {
  if (typeof window === 'undefined') return;
  const targetPath = routeToPath(route);
  const currentPath = window.location.pathname.replace(/\/+$/, '') || '/';

  // Never strip recovery query/hash parameters while navigating into /reset-password
  const suffix =
    route === 'reset-password' &&
    isRecoveryUrl(window.location.search, window.location.hash, currentPath)
      ? `${window.location.search}${window.location.hash}`
      : '';

  if (currentPath === targetPath && (!suffix || `${currentPath}${suffix}` === `${targetPath}${suffix}`)) {
    return;
  }

  try {
    if (replace) {
      window.history.replaceState({ route }, '', `${targetPath}${suffix}`);
    } else {
      window.history.pushState({ route }, '', `${targetPath}${suffix}`);
    }
  } catch {
    // Ignore history API restrictions in sandboxed environments
  }
}
