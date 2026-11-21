import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { AppRoute } from '../../types/auth';
import { resolvePostLoginRoute, validateLoginInput } from '../../utils/authValidation';
import { AuthLayout } from './AuthLayout';

interface LoginPageProps {
  onNavigateRoute: (route: AppRoute) => void;
  intendedRoute?: AppRoute | null;
  notice?: string | null;
  onClearNotice?: () => void;
}

const LOGIN_BACKGROUND_IMAGE =
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
    <AuthLayout
      title="Sign in to Neel 3D Space"
      subtitle="Use your registered employee or administrator credentials to access your workspace."
      onNavigateRoute={onNavigateRoute}
      isConfigured={isConfigured}
      backgroundImageSrc={LOGIN_BACKGROUND_IMAGE}
    >
      {activeBanner && (
        <div
          role="status"
          className="mb-gutter-lg p-gutter-md rounded-md bg-primary-container/50 border border-primary text-on-primary-container text-body-sm flex items-start justify-between gap-gutter-sm"
        >
          <span>{activeBanner}</span>
          <button
            type="button"
            onClick={() => {
              clearSessionNotice();
              onClearNotice?.();
            }}
            className="text-primary hover:underline text-label-sm shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {formError && (
        <div
          role="alert"
          className="mb-gutter-lg p-gutter-md rounded-md bg-error/15 border border-error text-on-surface text-body-sm flex items-start gap-gutter-sm"
        >
          <span className="material-symbols-outlined text-error text-[18px] shrink-0 mt-0.5" aria-hidden="true">
            error
          </span>
          <span>{formError}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-gutter-lg">
        <div className="flex flex-col gap-gutter-xs">
          <label htmlFor="login-email" className="font-label text-label-md text-on-surface">
            Work Email
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (fieldErrors.email) setFieldErrors((p) => ({ ...p, email: '' }));
            }}
            placeholder="name@company.com"
            disabled={submitting}
            aria-invalid={Boolean(fieldErrors.email)}
            className={`w-full px-gutter-md py-gutter-sm rounded-md bg-surface-container-low border text-body-md text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary ${
              fieldErrors.email ? 'border-error' : 'border-outline'
            }`}
          />
          {fieldErrors.email && (
            <p className="text-body-sm text-error">{fieldErrors.email}</p>
          )}
        </div>

        <div className="flex flex-col gap-gutter-xs">
          <div className="flex items-center justify-between gap-gutter-sm">
            <label htmlFor="login-password" className="font-label text-label-md text-on-surface">
              Password
            </label>
            <button
              type="button"
              onClick={() => onNavigateRoute('forgot-password')}
              className="font-label text-label-sm text-primary hover:underline cursor-pointer"
            >
              Forgot password?
            </button>
          </div>
          <div className="relative">
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
              className={`w-full pl-gutter-md pr-11 py-gutter-sm rounded-md bg-surface-container-low border text-body-md text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary ${
                fieldErrors.password ? 'border-error' : 'border-outline'
              }`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-on-surface-variant hover:text-on-surface cursor-pointer"
            >
              <span className="material-symbols-outlined text-[19px]" aria-hidden="true">
                {showPassword ? 'visibility_off' : 'visibility'}
              </span>
            </button>
          </div>
          {fieldErrors.password && (
            <p className="text-body-sm text-error">{fieldErrors.password}</p>
          )}
        </div>

        <button
          type="submit"
          disabled={submitting || !isConfigured}
          className="w-full inline-flex items-center justify-center gap-gutter-sm bg-primary text-on-primary px-gutter-xl py-gutter-md rounded-md font-label text-label-lg transition-colors hover:bg-on-primary-container disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {submitting ? (
            <>
              <span className="material-symbols-outlined text-[19px] animate-spin" aria-hidden="true">
                progress_activity
              </span>
              <span>Signing In...</span>
            </>
          ) : (
            <>
              <span className="material-symbols-outlined text-[19px]" aria-hidden="true">
                login
              </span>
              <span>Sign In</span>
            </>
          )}
        </button>
      </form>

      <div className="mt-gutter-xl pt-gutter-lg border-t border-outline-variant flex flex-col sm:flex-row items-center justify-between gap-gutter-sm text-body-sm text-on-surface-variant">
        <span>New employee joining Neel 3D Space?</span>
        <button
          type="button"
          onClick={() => onNavigateRoute('register')}
          className="font-label text-label-md text-primary hover:underline cursor-pointer whitespace-nowrap"
        >
          Register Employee Account
        </button>
      </div>
    </AuthLayout>
  );
};
