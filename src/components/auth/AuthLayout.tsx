import React from 'react';
import { useAuth } from '../../context/AuthContext';
import { getSupabaseConfigStatus } from '../../lib/supabase';
import { AppRoute } from '../../types/auth';

interface AuthLayoutProps {
  title: string;
  subtitle?: string;
  onNavigateRoute: (route: AppRoute) => void;
  isConfigured?: boolean;
  maxWidthClass?: string;
  backgroundImageSrc?: string;
  children?: React.ReactNode;
}

const DEFAULT_AUTH_BACKGROUND_IMAGE =
  '/assets/aistudio/give_more_pictures_like_this_347a3638_2K_0d4ccf75.png';

export const AuthLayout: React.FC<AuthLayoutProps> = ({
  title,
  onNavigateRoute,
  isConfigured = true,
  maxWidthClass = 'max-w-lg',
  backgroundImageSrc = DEFAULT_AUTH_BACKGROUND_IMAGE,
  children,
}) => {
  const { isAuthenticated, isApproved, signOut } = useAuth();
  const configStatus = getSupabaseConfigStatus();
  const backLabel = isAuthenticated && isApproved ? 'Back to Home' : 'Back to Sign In';

  const handleBackAction = async () => {
    if (isAuthenticated && isApproved) {
      onNavigateRoute('home');
      return;
    }
    if (isAuthenticated) {
      await signOut();
    }
    onNavigateRoute('login');
  };

  return (
    <div className="min-h-screen flex flex-col bg-surface text-on-surface">
      <header className="sticky top-0 z-30 bg-surface-container border-b border-outline-variant">
        <div className="max-w-7xl mx-auto px-gutter-lg lg:px-gutter-xl py-gutter-sm min-h-16 flex items-center justify-between gap-gutter-md">
          <button
            type="button"
            onClick={() => void handleBackAction()}
            className="flex items-center gap-gutter-sm text-left cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary rounded-sm"
          >
            <img
              src="/assets/aistudio/Create_favicon_and_transparent_p__21f5ae8d_2K_3f0575c9.png"
              alt="Blue Space logo"
              className="w-9 h-9 object-contain shrink-0"
            />
            <div className="flex flex-col min-w-0">
              <span className="font-headline text-title-sm text-on-surface tracking-wide uppercase whitespace-nowrap">
                BLUE SPACE
              </span>
              <span className="font-mono text-mono-sm text-on-surface-variant tracking-wider uppercase whitespace-nowrap hidden sm:block">
                EMPLOYEE ACCESS PORTAL
              </span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => void handleBackAction()}
            className="inline-flex items-center gap-gutter-xs px-gutter-md py-gutter-xs rounded-sm border border-outline-variant text-on-surface-variant hover:text-on-surface hover:border-outline font-label text-label-md transition-colors cursor-pointer whitespace-nowrap"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              arrow_back
            </span>
            <span>{backLabel}</span>
          </button>
        </div>
      </header>

      <main className="relative flex-1 flex items-center justify-center px-gutter-lg py-gutter-2xl overflow-hidden bg-[#08070E]">
        {backgroundImageSrc && (
          <>
            <img
              src={backgroundImageSrc}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 w-full h-full object-cover object-center pointer-events-none select-none"
            />
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-gradient-to-b from-[#08070E]/55 via-[#08070E]/35 to-[#08070E]/68 pointer-events-none"
            />
          </>
        )}
        <div
          className={`relative z-10 w-full ${maxWidthClass} rounded-xl p-gutter-xl sm:p-gutter-2xl border bg-[#110F1D]/88 backdrop-blur-xl border-white/[0.1] shadow-[0_24px_80px_rgba(0,0,0,0.7)]`}
        >
          <div className={`flex flex-col gap-gutter-xs ${children ? 'mb-gutter-xl' : 'items-center text-center'}`}>
            <h1 className="font-headline text-headline-md text-on-surface text-balance">
              {title}
            </h1>
          </div>

          {!isConfigured && (
            <div
              role="alert"
              className="mb-gutter-lg p-gutter-md rounded-md bg-warning/15 border border-warning text-on-surface text-body-sm flex flex-col gap-gutter-xs"
            >
              <div className="flex items-center gap-gutter-xs font-label text-label-md text-warning">
                <span className="material-symbols-outlined text-[17px]" aria-hidden="true">
                  settings_alert
                </span>
                <span>Supabase Configuration Required</span>
              </div>
              <p className="text-on-surface-variant">
                {configStatus.validationError ??
                  'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY) in your build environment and rebuild the frontend.'}
              </p>
            </div>
          )}

          {children}
        </div>
      </main>
    </div>
  );
};
