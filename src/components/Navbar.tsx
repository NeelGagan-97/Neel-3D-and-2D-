import React from 'react';
import { useAuth } from '../context/AuthContext';
import { useRouteNavigation } from '../context/RouteNavigationContext';
import { AppRoute } from '../types/auth';
import { ScreenId } from '../types/design';
import { canViewAdminNavigation, resolvePostLoginRoute } from '../utils/authValidation';

interface NavbarProps {
  activeScreen: ScreenId;
  activeRoute?: AppRoute;
  onNavigate: (screen: ScreenId) => void;
  onNavigateRoute?: (route: AppRoute) => void;
  compact?: boolean;
  rightSlot?: React.ReactNode;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeScreen,
  activeRoute,
  onNavigate,
  onNavigateRoute,
  compact = false,
  rightSlot,
}) => {
  const { isAuthenticated, isApproved, authLoading, profileLoading, user, profile, signOut } =
    useAuth();
  const showAdminNav = canViewAdminNavigation({
    isAuthenticated,
    isLoading: authLoading || profileLoading,
    authUserId: user?.id ?? null,
    profile,
  });
  const routeCtx = useRouteNavigation();

  const currentRoute: AppRoute = activeRoute ?? routeCtx?.activeRoute ?? activeScreen;
  const goRoute = (target: AppRoute) => {
    if (onNavigateRoute) {
      onNavigateRoute(target);
    } else if (routeCtx) {
      routeCtx.navigateRoute(target);
    } else if (target === 'home' || target === 'studio' || target === 'summary') {
      onNavigate(target);
    }
  };

  const navItems: { id: ScreenId; label: string }[] = [
    { id: 'home', label: 'Home' },
    { id: 'studio', label: 'Design Studio' },
    { id: 'summary', label: 'Project Summary' },
  ];

  const handleLogout = async () => {
    await signOut();
    goRoute('login');
  };

  const accountRoute: AppRoute = resolvePostLoginRoute(profile, user?.id ?? null);

  return (
    <header className="sticky top-0 z-30 bg-surface-container border-b border-outline-variant no-print">
      <div
        className={`${
          compact
            ? 'px-gutter-lg py-gutter-sm min-h-14'
            : 'max-w-7xl mx-auto px-gutter-lg lg:px-gutter-xl py-gutter-sm min-h-16'
        } flex flex-wrap items-center justify-between gap-gutter-sm`}
      >
        <button
          type="button"
          onClick={() => onNavigate('home')}
          className="flex items-center gap-gutter-sm min-w-0 text-left cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary rounded-sm"
        >
          <div
            className={`${
              compact ? 'w-8 h-8' : 'w-9 h-9'
            } rounded-md bg-primary-container border border-primary flex items-center justify-center shrink-0`}
          >
            <span
              className={`material-symbols-outlined text-primary ${compact ? 'text-[18px]' : 'text-[20px]'}`}
              aria-hidden="true"
            >
              deployed_code
            </span>
          </div>
          <div className={compact ? 'flex items-baseline gap-gutter-md min-w-0' : 'flex flex-col min-w-0'}>
            <span className="font-headline text-title-sm text-on-surface tracking-wide uppercase whitespace-nowrap">
              NEEL 3D SPACE
            </span>
            <span
              className={`font-mono text-mono-sm text-on-surface-variant tracking-wider uppercase whitespace-nowrap ${
                compact ? 'hidden xl:inline' : 'hidden sm:block'
              }`}
            >
              DESIGN YOUR SPACE. POWER YOUR WORLD.
            </span>
          </div>
        </button>

        <nav aria-label="Primary Navigation" className="flex items-center gap-gutter-xs min-w-0">
          {navItems.map((item) => {
            const isActive = currentRoute === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={isActive ? 'page' : undefined}
                onClick={() => onNavigate(item.id)}
                className={`px-gutter-sm sm:px-gutter-md py-gutter-xs rounded-sm font-label text-label-md transition-colors duration-state-change whitespace-nowrap shrink-0 cursor-pointer ${
                  isActive
                    ? 'bg-primary-container text-primary border border-primary'
                    : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high border border-transparent'
                }`}
              >
                {item.label}
              </button>
            );
          })}

          {showAdminNav && (
            <button
              type="button"
              aria-current={currentRoute === 'admin' ? 'page' : undefined}
              onClick={() => goRoute('admin')}
              className={`px-gutter-sm sm:px-gutter-md py-gutter-xs rounded-sm font-label text-label-md transition-colors duration-state-change whitespace-nowrap shrink-0 cursor-pointer ${
                currentRoute === 'admin'
                  ? 'bg-secondary-container text-secondary border border-secondary'
                  : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high border border-transparent'
              }`}
            >
              Admin
            </button>
          )}

          {isAuthenticated && isApproved && !showAdminNav && (
            <button
              type="button"
              aria-current={currentRoute === 'employee-dashboard' ? 'page' : undefined}
              onClick={() => goRoute('employee-dashboard')}
              className={`px-gutter-sm sm:px-gutter-md py-gutter-xs rounded-sm font-label text-label-md transition-colors duration-state-change whitespace-nowrap shrink-0 cursor-pointer ${
                currentRoute === 'employee-dashboard'
                  ? 'bg-primary-container text-primary border border-primary'
                  : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high border border-transparent'
              }`}
            >
              Dashboard
            </button>
          )}
        </nav>

        <div className="flex items-center gap-gutter-xs sm:gap-gutter-sm shrink-0">
          {isAuthenticated ? (
            <div className="flex items-center gap-gutter-xs sm:gap-gutter-sm">
              <button
                type="button"
                onClick={() => goRoute(accountRoute)}
                title={profile ? `${profile.full_name} (${profile.role} · ${profile.account_status})` : 'Account Status'}
                className="hidden sm:inline-flex items-center gap-1.5 px-gutter-sm py-gutter-xs rounded-sm border border-outline-variant text-on-surface-variant hover:text-on-surface hover:border-outline font-label text-label-sm cursor-pointer whitespace-nowrap max-w-[170px]"
              >
                <span className="material-symbols-outlined text-[16px] text-primary shrink-0" aria-hidden="true">
                  {showAdminNav ? 'admin_panel_settings' : 'account_circle'}
                </span>
                <span className="truncate">{profile?.full_name ?? 'Account'}</span>
              </button>
              <button
                type="button"
                onClick={() => void handleLogout()}
                title="Sign Out"
                className="inline-flex items-center gap-1 px-gutter-sm py-gutter-xs rounded-sm border border-outline-variant text-on-surface-variant hover:text-error hover:border-error font-label text-label-sm transition-colors cursor-pointer whitespace-nowrap"
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  logout
                </span>
                <span className={compact ? 'hidden xl:inline' : 'hidden sm:inline'}>Sign Out</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-gutter-xs">
              <button
                type="button"
                onClick={() => goRoute('login')}
                className="px-gutter-sm sm:px-gutter-md py-gutter-xs rounded-sm border border-outline text-on-surface hover:border-primary hover:text-primary font-label text-label-md transition-colors cursor-pointer whitespace-nowrap"
              >
                Sign In
              </button>
              {!compact && (
                <button
                  type="button"
                  onClick={() => goRoute('register')}
                  className="hidden sm:inline-flex px-gutter-md py-gutter-xs rounded-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high font-label text-label-md transition-colors cursor-pointer whitespace-nowrap"
                >
                  Register
                </button>
              )}
            </div>
          )}

          {rightSlot && (
            <div className={compact ? 'hidden lg:flex items-center gap-gutter-sm shrink-0' : 'hidden md:flex items-center gap-gutter-sm shrink-0'}>
              {rightSlot}
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

