import React from 'react';
import { AppRoute } from '../../types/auth';

interface AuthLayoutProps {
  title: string;
  subtitle: string;
  onNavigateRoute: (route: AppRoute) => void;
  isConfigured: boolean;
  maxWidthClass?: string;
  backgroundImageSrc?: string;
  children: React.ReactNode;
}

export const AuthLayout: React.FC<AuthLayoutProps> = ({
  title,
  subtitle,
  onNavigateRoute,
  isConfigured,
  maxWidthClass = 'max-w-lg',
  backgroundImageSrc,
  children,
}) => {
  return (
    <div className="min-h-screen flex flex-col bg-surface text-on-surface">
      <header className="sticky top-0 z-30 bg-surface-container border-b border-outline-variant">
        <div className="max-w-7xl mx-auto px-gutter-lg lg:px-gutter-xl py-gutter-sm min-h-16 flex items-center justify-between gap-gutter-md">
          <button
            type="button"
            onClick={() => onNavigateRoute('home')}
            className="flex items-center gap-gutter-sm text-left cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary rounded-sm"
          >
            <div className="w-9 h-9 rounded-md bg-primary-container border border-primary flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-primary text-[20px]" aria-hidden="true">
                deployed_code
              </span>
            </div>
            <div className="flex flex-col min-w-0">
              <span className="font-headline text-title-sm text-on-surface tracking-wide uppercase whitespace-nowrap">
                NEEL 3D SPACE
              </span>
              <span className="font-mono text-mono-sm text-on-surface-variant tracking-wider uppercase whitespace-nowrap hidden sm:block">
                EMPLOYEE ACCESS PORTAL
              </span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => onNavigateRoute('home')}
            className="inline-flex items-center gap-gutter-xs px-gutter-md py-gutter-xs rounded-sm border border-outline-variant text-on-surface-variant hover:text-on-surface hover:border-outline font-label text-label-md transition-colors cursor-pointer whitespace-nowrap"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              arrow_back
            </span>
            <span>Back to Home</span>
          </button>
        </div>
      </header>

      <main
        className={`relative flex-1 flex items-center justify-center px-gutter-lg py-gutter-2xl overflow-hidden ${
          backgroundImageSrc ? '' : 'cad-grid'
        }`}
      >
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
              className="absolute inset-0 bg-gradient-to-b from-surface/55 via-surface/35 to-surface/65 pointer-events-none"
            />
          </>
        )}
        <div
          className={`relative z-10 w-full ${maxWidthClass} rounded-xl p-gutter-xl sm:p-gutter-2xl border ${
            backgroundImageSrc
              ? 'bg-surface-container/88 backdrop-blur-md border-outline/80 shadow-2xl'
              : 'bg-surface-container border-outline-variant'
          }`}
        >
          <div className="flex flex-col gap-gutter-xs mb-gutter-xl">
            <h1 className="font-headline text-headline-md text-on-surface text-balance">
              {title}
            </h1>
            <p className="font-body text-body-md text-on-surface-variant">
              {subtitle}
            </p>
          </div>

          {!isConfigured && (
            <div
              role="alert"
              className="mb-gutter-lg p-gutter-md rounded-md bg-secondary-container/40 border border-secondary text-on-secondary-container text-body-sm flex flex-col gap-1"
            >
              <div className="flex items-center gap-gutter-xs font-label text-label-md text-secondary">
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                  settings_alert
                </span>
                <span>Supabase Configuration Required</span>
              </div>
              <p className="text-on-surface-variant">
                Set <code className="font-mono text-on-surface">VITE_SUPABASE_URL</code> and{' '}
                <code className="font-mono text-on-surface">VITE_SUPABASE_ANON_KEY</code> (or{' '}
                <code className="font-mono text-on-surface">VITE_SUPABASE_PUBLISHABLE_KEY</code>) in your environment settings to connect live authentication.
              </p>
            </div>
          )}

          {children}
        </div>
      </main>
    </div>
  );
};
