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

export function isRecoveryUrl(search: string, hash: string): boolean {
  const normalizedHash = hash.toLowerCase();
  const normalizedSearch = search.toLowerCase();
  return (
    normalizedHash.includes('type=recovery') ||
    normalizedSearch.includes('type=recovery')
  );
}

export function parseRouteFromLocation(
  pathname: string,
  search = '',
  hash = ''
): AppRoute {
  if (isRecoveryUrl(search, hash)) {
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
  if (currentPath === targetPath) return;

  try {
    if (replace) {
      window.history.replaceState({ route }, '', targetPath);
    } else {
      window.history.pushState({ route }, '', targetPath);
    }
  } catch {
    // Ignore history API restrictions in sandboxed environments
  }
}
