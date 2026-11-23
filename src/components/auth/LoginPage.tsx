import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getSupabaseConfigStatus } from '../../lib/supabase';
import { AppRoute } from '../../types/auth';
import {
  isApprovedAdmin,
  isApprovedUser,
  resolvePostLoginRoute,
  validateLoginInput,
} from '../../utils/authValidation';

interface LoginPageProps {
  onNavigateRoute: (route: AppRoute) => void;
  intendedRoute?: AppRoute | null;
  notice?: string | null;
  onClearNotice?: () => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({
  onNavigateRoute,
  intendedRoute,
  notice,
  onClearNotice,
}) => {
  const { signIn, isConfigured, sessionNotice, clearSessionNotice } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const activeBanner = sessionNotice || notice;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFieldErrors({});
    clearSessionNotice();
    onClearNotice?.();

    const validation = validateLoginInput(email, password);
    if (!validation.valid) {
      setFieldErrors(validation.fieldErrors);
      setFormError('Please enter your registered email address and password.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await signIn(email, password);
      if (!res.ok || !res.data) {
        setFieldErrors(res.fieldErrors ?? {});
        setFormError(res.error ?? 'Sign in failed. Please check your credentials.');
        return;
      }

      if (res.data.profileError) {
        // Profile query failed (RLS, network, or DB error) — let the dedicated error screen render instead of misrouting to profile-missing
        setFormError(res.data.profileError);
        return;
      }

      const profile = res.data.profile;
      const authUserId = res.data.user.id;
      const defaultDestination = resolvePostLoginRoute(profile, authUserId);

      // Only honor intendedRoute if the user is APPROVED and authorized for it
      if (
        intendedRoute &&
        isApprovedUser(profile, authUserId) &&
        (intendedRoute !== 'admin' || isApprovedAdmin(profile, authUserId)) &&
        (intendedRoute === 'home' ||
          intendedRoute === 'studio' ||
          intendedRoute === 'summary' ||
          intendedRoute === 'employee-dashboard' ||
          intendedRoute === 'admin')
      ) {
        onNavigateRoute(intendedRoute);
        return;
      }

      onNavigateRoute(defaultDestination);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative min-h-screen flex flex-col bg-[#08070E] text-on-surface overflow-x-hidden">
      {/* Full-bleed luxury interior background image spanning header and main */}
      <img
        src="/assets/aistudio/Luxury_Double-Height_Living_Interior_14b21919.png"
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        className="pointer-events-none select-none absolute inset-0 w-full h-full object-cover object-center"
      />

      {/* Measured architectural scrim for crisp legibility across header and main */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#08070E]/82 via-[#08070E]/54 to-[#08070E]/74"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#08070E]/86 via-[#08070E]/18 to-[#08070E]/55"
      />

      <header className="relative z-30 bg-transparent">
        <div className="max-w-7xl mx-auto px-6 sm:px-10 lg:px-12 xl:px-16 pt-6 pb-2 flex items-center justify-between gap-gutter-md">
          {/* Brand Header */}
          <div className="flex items-center gap-3.5">
            <img
              src="/assets/aistudio/Create_favicon_and_transparent_p__21f5ae8d_2K_3f0575c9.png"
              alt="Blue Space logo"
              className="w-10 h-10 object-contain shrink-0 drop-shadow-[0_2px_12px_rgba(59,130,246,0.45)]"
            />
            <div className="flex flex-col">
              <span className="font-headline text-base font-bold text-white leading-tight drop-shadow-sm">
                Blue Space
              </span>
              <span className="text-xs font-medium text-[#C4B5FD]">
                3D Interior Studio
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="relative z-10 flex-1 flex flex-col overflow-hidden">
        <section className="relative flex-1 w-full flex flex-col justify-between overflow-hidden">
          {/* Unified foreground container combining brand showcase and sign-in form */}
          <div className="relative z-10 flex-1 w-full max-w-7xl mx-auto px-6 sm:px-10 lg:px-12 xl:px-16 py-8 lg:py-10 flex flex-col justify-between gap-8">
            {/* Combined Showcase + Sign-In Row */}
            <div className="my-auto grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-center">
              {/* Editorial Headline & Engine Info */}
              <div className="lg:col-span-7 flex flex-col gap-6 max-w-xl">
                <div className="flex flex-col gap-3">
                  <span className="font-mono text-[11px] font-semibold tracking-[0.2em] uppercase text-[#C4B5FD]">
                    DESIGN. VISUALIZE. EXPERIENCE.
                  </span>
                  <h1 className="font-headline text-3xl sm:text-4xl xl:text-[46px] font-bold tracking-tight leading-[1.1] text-white text-balance drop-shadow-[0_2px_18px_rgba(0,0,0,0.55)]">
                    Welcome to Blue Space
                  </h1>
                  <p className="font-body text-sm sm:text-[15px] leading-relaxed text-slate-200 max-w-md drop-shadow-[0_1px_8px_rgba(0,0,0,0.65)]">
                    Your creative space to design, customize and visualize extraordinary interiors.
                  </p>
                </div>
              </div>

              {/* Frosted Glass Sign-In Card */}
              <div className="lg:col-span-5 flex items-center justify-center lg:justify-end">
                <div className="relative w-full max-w-[430px] lg:translate-x-6 xl:translate-x-8 rounded-2xl bg-[#0D0B18]/82 backdrop-blur-xl border border-white/15 shadow-[0_24px_80px_rgba(0,0,0,0.68)] p-7 sm:p-9">
                  <div className="flex flex-col gap-1.5 mb-7">
                    <h2 className="font-headline text-2xl sm:text-[26px] font-bold tracking-tight text-white">
                      Welcome Back
                    </h2>
                    <p className="font-body text-sm text-slate-300">
                      Sign in to continue your creative journey.
                    </p>
                  </div>

                  {!isConfigured && (
                    <div
                      role="alert"
                      className="mb-5 p-3.5 rounded-lg bg-amber-500/15 border border-amber-400/40 text-amber-100 text-xs flex flex-col gap-1.5"
                    >
                      <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                          settings_alert
                        </span>
                        <span>Supabase Configuration Required</span>
                      </div>
                      <p className="text-slate-200 leading-relaxed">
                        {getSupabaseConfigStatus().validationError ?? (
                          <>
                            Set <code className="font-mono text-white">VITE_SUPABASE_URL</code> and{' '}
                            <code className="font-mono text-white">VITE_SUPABASE_ANON_KEY</code> (or{' '}
                            <code className="font-mono text-white">VITE_SUPABASE_PUBLISHABLE_KEY</code>) in
                            your build environment settings and rebuild the frontend to connect live
                            authentication.
                          </>
                        )}
                      </p>
                    </div>
                  )}

                  {activeBanner && (
                    <div
                      role="status"
                      className="mb-5 p-3.5 rounded-lg bg-[#7C3AED]/20 border border-[#8B5CF6]/50 text-purple-100 text-xs flex items-start justify-between gap-3"
                    >
                      <span className="leading-relaxed">{activeBanner}</span>
                      <button
                        type="button"
                        onClick={() => {
                          clearSessionNotice();
                          onClearNotice?.();
                        }}
                        className="text-[#C4B5FD] hover:text-white hover:underline font-semibold shrink-0 cursor-pointer"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}

                  {formError && (
                    <div
                      role="alert"
                      className="mb-5 p-3.5 rounded-lg bg-red-500/15 border border-red-500/45 text-red-100 text-xs flex items-start gap-2"
                    >
                      <span className="material-symbols-outlined text-red-400 text-[17px] shrink-0 mt-0.5" aria-hidden="true">
                        error
                      </span>
                      <span className="leading-relaxed">{formError}</span>
                    </div>
                  )}

                  <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="login-email" className="font-label text-xs font-semibold text-slate-200">
                        Email Address
                      </label>
                      <div className="relative">
                        <span
                          className="material-symbols-outlined text-[18px] text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                          aria-hidden="true"
                        >
                          mail
                        </span>
                        <input
                          id="login-email"
                          type="email"
                          autoComplete="email"
                          value={email}
                          onChange={(e) => {
                            setEmail(e.target.value);
                            if (fieldErrors.email) setFieldErrors((p) => ({ ...p, email: '' }));
                          }}
                          placeholder="designer@bluespace.com"
                          disabled={submitting}
                          aria-invalid={Boolean(fieldErrors.email)}
                          className={`w-full pl-10 pr-3.5 py-2.5 rounded-lg bg-[#0A0814]/90 border text-sm text-white placeholder:text-slate-400 focus:outline-none focus:border-[#8B5CF6] focus:ring-2 focus:ring-[#8B5CF6]/25 transition-colors ${
                            fieldErrors.email ? 'border-red-500' : 'border-white/15'
                          }`}
                        />
                      </div>
                      {fieldErrors.email && (
                        <p className="text-xs text-red-400">{fieldErrors.email}</p>
                      )}
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="login-password" className="font-label text-xs font-semibold text-slate-200">
                        Password
                      </label>
                      <div className="relative">
                        <span
                          className="material-symbols-outlined text-[18px] text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                          aria-hidden="true"
                        >
                          lock
                        </span>
                        <input
                          id="login-password"
                          type={showPassword ? 'text' : 'password'}
                          autoComplete="current-password"
                          value={password}
                          onChange={(e) => {
                            setPassword(e.target.value);
                            if (fieldErrors.password) setFieldErrors((p) => ({ ...p, password: '' }));
                          }}
                          placeholder="Enter your password"
                          disabled={submitting}
                          aria-invalid={Boolean(fieldErrors.password)}
                          className={`w-full pl-10 pr-11 py-2.5 rounded-lg bg-[#0A0814]/90 border text-sm text-white placeholder:text-slate-400 focus:outline-none focus:border-[#8B5CF6] focus:ring-2 focus:ring-[#8B5CF6]/25 transition-colors ${
                            fieldErrors.password ? 'border-red-500' : 'border-white/15'
                          }`}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-300 hover:text-white cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                            {showPassword ? 'visibility_off' : 'visibility'}
                          </span>
                        </button>
                      </div>
                      {fieldErrors.password && (
                        <p className="text-xs text-red-400">{fieldErrors.password}</p>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={rememberMe}
                          onChange={(e) => setRememberMe(e.target.checked)}
                          className="w-3.5 h-3.5 rounded-full accent-[#8B5CF6] bg-[#0A0814] border border-white/20 cursor-pointer"
                        />
                        <span>Remember Me</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => onNavigateRoute('forgot-password')}
                        className="font-label text-xs font-medium text-[#C4B5FD] hover:text-white hover:underline cursor-pointer"
                      >
                        Forgot Password?
                      </button>
                    </div>

                    <button
                      type="submit"
                      disabled={submitting || !isConfigured}
                      className="w-full inline-flex items-center justify-center gap-2 bg-gradient-to-r from-[#7C3AED] via-[#8B5CF6] to-[#7E22CE] hover:from-[#8B5CF6] hover:to-[#9333EA] text-white px-5 py-3 rounded-lg font-label text-sm font-semibold shadow-[0_0_28px_rgba(139,92,246,0.45)] transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {submitting ? (
                        <>
                          <span className="material-symbols-outlined text-[18px] animate-spin" aria-hidden="true">
                            progress_activity
                          </span>
                          <span>Signing In...</span>
                        </>
                      ) : (
                        <span>Sign In to Workspace</span>
                      )}
                    </button>
                  </form>

                  <div className="my-5 flex items-center gap-3">
                    <div className="flex-1 h-px bg-white/12" />
                    <span className="text-[11px] text-slate-300 whitespace-nowrap">or new employee</span>
                    <div className="flex-1 h-px bg-white/12" />
                  </div>

                  <button
                    type="button"
                    onClick={() => onNavigateRoute('register')}
                    className="w-full inline-flex items-center justify-center gap-2.5 bg-white/[0.07] hover:bg-white/[0.12] border border-white/15 text-slate-100 px-4 py-2.5 rounded-lg font-label text-xs font-semibold transition-colors cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[17px] text-[#C4B5FD]" aria-hidden="true">
                      person_add
                    </span>
                    <span>Register Employee Account</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Unified Section Footer */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-white/12 text-xs">
              <span className="text-slate-300">
                © 2026 Blue Space. All rights reserved.
              </span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};
