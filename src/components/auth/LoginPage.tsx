import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { AppRoute } from '../../types/auth';
import { resolvePostLoginRoute, validateLoginInput } from '../../utils/authValidation';

interface LoginPageProps {
  onNavigateRoute: (route: AppRoute) => void;
  intendedRoute?: AppRoute | null;
  notice?: string | null;
  onClearNotice?: () => void;
}

const LOGIN_PREVIEW_IMAGE =
  '/assets/aistudio/RzZiKv9xT1og5t19AMydaa74VOh5lwtt9R8cSp0YKJ7_asIgIMQHEugMB-irmkmZjD5Vb2Gc1l48413n4wVduaWTyLMZ0NwG1zhzFy_kjaOVETDUnjkDdqboLQVoPBf2CVVRY-RaifFSuXRvU2EECjLUEJV67HkosAZzkD-5Px0dbQ6gVdXK1hNP7i06o9Sm_4f423635.jpg';

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

      const profile = res.data.profile;
      const defaultDestination = resolvePostLoginRoute(profile);

      // Only honor intendedRoute if the user is APPROVED and authorized for it
      if (
        intendedRoute &&
        profile?.account_status === 'APPROVED' &&
        (intendedRoute !== 'admin' || profile.role === 'ADMIN') &&
        (intendedRoute === 'studio' ||
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
    <div className="min-h-screen flex flex-col bg-[#08070E] text-on-surface">
      <header className="sticky top-0 z-30 bg-[#0C0A15]/95 backdrop-blur-md border-b border-white/[0.07]">
        <div className="max-w-7xl mx-auto px-gutter-lg lg:px-gutter-xl py-gutter-sm min-h-16 flex items-center justify-between gap-gutter-md">
          <button
            type="button"
            onClick={() => onNavigateRoute('home')}
            className="flex items-center gap-gutter-sm text-left cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#8B5CF6] rounded-sm"
          >
            <div className="w-9 h-9 rounded-md bg-gradient-to-br from-[#8B5CF6] to-[#6D28D9] border border-[#A78BFA]/40 shadow-[0_0_18px_rgba(139,92,246,0.45)] flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-white text-[20px]" aria-hidden="true">
                deployed_code
              </span>
            </div>
            <div className="flex flex-col min-w-0">
              <span className="font-headline text-title-sm text-white tracking-wide uppercase whitespace-nowrap">
                NEEL 3D SPACE
              </span>
              <span className="font-mono text-mono-sm text-[#A78BFA] tracking-wider uppercase whitespace-nowrap hidden sm:block">
                EMPLOYEE ACCESS PORTAL
              </span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => onNavigateRoute('home')}
            className="inline-flex items-center gap-gutter-xs px-gutter-md py-gutter-xs rounded-md border border-white/10 bg-white/[0.03] text-slate-300 hover:text-white hover:border-[#8B5CF6]/50 font-label text-label-md transition-colors cursor-pointer whitespace-nowrap"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              arrow_back
            </span>
            <span>Back to Home</span>
          </button>
        </div>
      </header>

      <main className="relative flex-1 grid grid-cols-1 lg:grid-cols-2 bg-[#08070E] overflow-hidden">
        {/* Ambient radial royal-purple lighting layers */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-28 -left-24 w-[520px] h-[520px] rounded-full bg-[#6D28D9]/22 blur-[130px]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-32 right-[-6%] w-[520px] h-[520px] rounded-full bg-[#7C3AED]/18 blur-[140px]"
        />

        {/* Left Showcase Column */}
        <section className="relative z-10 flex flex-col justify-between px-6 sm:px-10 lg:px-12 xl:px-16 py-8 lg:py-10 lg:border-r border-white/[0.07]">
          {/* Decorative wireframe isometric cube */}
          <svg
            aria-hidden="true"
            viewBox="0 0 120 136"
            fill="none"
            className="pointer-events-none hidden sm:block absolute top-10 right-10 w-24 h-28 text-white/[0.08]"
          >
            <polygon
              points="60,4 114,35 114,101 60,132 6,101 6,35"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <polyline points="6,35 60,67 114,35" stroke="currentColor" strokeWidth="1.2" />
            <line x1="60" y1="67" x2="60" y2="132" stroke="currentColor" strokeWidth="1.2" />
          </svg>

          {/* Brand Header */}
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#9333EA] via-[#8B5CF6] to-[#6D28D9] shadow-[0_0_28px_rgba(139,92,246,0.55)] flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-white text-[22px]" aria-hidden="true">
                deployed_code
              </span>
            </div>
            <div className="flex flex-col">
              <span className="font-headline text-base font-bold text-white leading-tight">
                Neel 3D Space
              </span>
              <span className="text-xs font-medium text-[#A78BFA]">
                3D Interior Studio
              </span>
            </div>
          </div>

          {/* Editorial Headline + 3D Architectural Preview Card */}
          <div className="my-8 lg:my-10 flex flex-col gap-6 max-w-xl">
            <div className="flex flex-col gap-3">
              <span className="font-mono text-[11px] font-semibold tracking-[0.2em] uppercase text-[#A78BFA]">
                DESIGN. VISUALIZE. EXPERIENCE.
              </span>
              <h1 className="font-headline text-3xl sm:text-4xl xl:text-[44px] font-bold tracking-tight leading-[1.12] text-white text-balance">
                Welcome Back
                <br />
                to Neel 3D Space
              </h1>
              <p className="font-body text-sm sm:text-[15px] leading-relaxed text-slate-400 max-w-md">
                Your creative space to design, customize and visualize extraordinary interiors.
              </p>
            </div>

            {/* Embedded 3D Architectural Visualization Card */}
            <div className="rounded-2xl overflow-hidden border border-white/[0.09] bg-[#110F1D] shadow-[0_24px_60px_rgba(0,0,0,0.55)]">
              <div className="relative aspect-[16/10] w-full overflow-hidden bg-[#0E0C18]">
                <img
                  src={LOGIN_PREVIEW_IMAGE}
                  alt="Abstract 3D architectural interior visualization with ambient royal purple and electric violet lighting"
                  className="w-full h-full object-cover object-center"
                />
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#110F1D] via-transparent to-transparent opacity-80"
                />
              </div>
              <div className="px-4 py-3 bg-[#110F1D] border-t border-white/[0.06] flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="material-symbols-outlined text-[#A78BFA] text-[16px] shrink-0" aria-hidden="true">
                    deployed_code
                  </span>
                  <span className="text-xs font-semibold text-slate-200 truncate">
                    Real-Time Raytraced Interior Engine
                  </span>
                </div>
                <span className="font-mono text-[11px] font-semibold text-[#A78BFA] shrink-0">
                  v4.2
                </span>
              </div>
            </div>
          </div>

          {/* Left Column Footer */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-white/[0.05] text-xs">
            <span className="text-slate-500">
              © 2026 Neel 3D Space. All rights reserved.
            </span>
            <span className="font-medium text-[#A78BFA]">
              Encrypted Workspace Session
            </span>
          </div>
        </section>

        {/* Right Sign-In Card Column */}
        <section className="relative z-10 flex items-center justify-center px-6 sm:px-10 py-10 lg:py-12 bg-[#07060C]/65">
          {/* Subtle violet aura behind sign-in card */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute w-80 h-80 rounded-full bg-[#7C3AED]/15 blur-[110px]"
          />

          <div className="relative z-10 w-full max-w-[430px] rounded-2xl bg-[#110F1D]/92 backdrop-blur-xl border border-white/[0.09] shadow-[0_24px_80px_rgba(0,0,0,0.7)] p-7 sm:p-9">
            <div className="flex flex-col gap-1.5 mb-7">
              <h2 className="font-headline text-2xl sm:text-[26px] font-bold tracking-tight text-white">
                Welcome Back
              </h2>
              <p className="font-body text-sm text-slate-400">
                Sign in to continue your creative journey.
              </p>
            </div>

            {!isConfigured && (
              <div
                role="alert"
                className="mb-5 p-3.5 rounded-lg bg-amber-500/10 border border-amber-400/35 text-amber-100 text-xs flex flex-col gap-1"
              >
                <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                    settings_alert
                  </span>
                  <span>Supabase Configuration Required</span>
                </div>
                <p className="text-slate-300 leading-relaxed">
                  Set <code className="font-mono text-white">VITE_SUPABASE_URL</code> and{' '}
                  <code className="font-mono text-white">VITE_SUPABASE_ANON_KEY</code> (or{' '}
                  <code className="font-mono text-white">VITE_SUPABASE_PUBLISHABLE_KEY</code>) in your environment settings to connect live authentication.
                </p>
              </div>
            )}

            {activeBanner && (
              <div
                role="status"
                className="mb-5 p-3.5 rounded-lg bg-[#7C3AED]/15 border border-[#8B5CF6]/45 text-purple-100 text-xs flex items-start justify-between gap-3"
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
                    className="material-symbols-outlined text-[18px] text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
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
                    placeholder="designer@neel3dspace.com"
                    disabled={submitting}
                    aria-invalid={Boolean(fieldErrors.email)}
                    className={`w-full pl-10 pr-3.5 py-2.5 rounded-lg bg-[#0A0814] border text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-[#8B5CF6] focus:ring-2 focus:ring-[#8B5CF6]/20 transition-colors ${
                      fieldErrors.email ? 'border-red-500' : 'border-white/10'
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
                    className="material-symbols-outlined text-[18px] text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
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
                    className={`w-full pl-10 pr-11 py-2.5 rounded-lg bg-[#0A0814] border text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-[#8B5CF6] focus:ring-2 focus:ring-[#8B5CF6]/20 transition-colors ${
                      fieldErrors.password ? 'border-red-500' : 'border-white/10'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-white cursor-pointer"
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
                <label className="inline-flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
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
                  className="font-label text-xs font-medium text-[#A78BFA] hover:text-[#C4B5FD] hover:underline cursor-pointer"
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
              <div className="flex-1 h-px bg-white/[0.08]" />
              <span className="text-[11px] text-slate-500 whitespace-nowrap">or new employee</span>
              <div className="flex-1 h-px bg-white/[0.08]" />
            </div>

            <button
              type="button"
              onClick={() => onNavigateRoute('register')}
              className="w-full inline-flex items-center justify-center gap-2.5 bg-[#181526] hover:bg-[#211D35] border border-white/10 text-slate-100 px-4 py-2.5 rounded-lg font-label text-xs font-semibold transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[17px] text-[#A78BFA]" aria-hidden="true">
                person_add
              </span>
              <span>Register Employee Account</span>
            </button>
          </div>
        </section>
      </main>
    </div>
  );
};
