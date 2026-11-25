import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { AppRoute } from '../../types/auth';
import {
  validateForgotPasswordEmail,
  validateResetPasswordInput,
} from '../../utils/authValidation';
import { AuthLayout } from './AuthLayout';

interface ForgotPasswordPageProps {
  onNavigateRoute: (route: AppRoute) => void;
}

export const ForgotPasswordPage: React.FC<ForgotPasswordPageProps> = ({
  onNavigateRoute,
}) => {
  const { sendPasswordReset, isConfigured } = useAuth();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const submittingRef = React.useRef(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current || submitting) {
      return;
    }
    setError(null);

    const validation = validateForgotPasswordEmail(email);
    if (!validation.valid) {
      setError(validation.fieldErrors.email ?? 'Enter a valid email address.');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const res = await sendPasswordReset(email);
      if (!res.ok) {
        setError(res.error ?? 'Could not send password reset instructions.');
        return;
      }
      setSubmitted(true);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      title="Reset Your Password"
      subtitle="Enter your registered work email and we will send a secure password recovery link."
      onNavigateRoute={onNavigateRoute}
      isConfigured={isConfigured}
    >
      {submitted ? (
        <div className="flex flex-col gap-gutter-lg">
          <div className="p-gutter-lg rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-gutter-xs">
            <div className="flex items-center gap-gutter-xs text-success font-label text-label-md">
              <span className="material-symbols-outlined text-[19px]" aria-hidden="true">
                mark_email_read
              </span>
              <span>Recovery Email Sent</span>
            </div>
            <p className="text-body-md text-on-surface-variant">
              If an account exists for{' '}
              <span className="font-mono text-on-surface">{email.trim().toLowerCase()}</span>, a
              password reset link has been sent to that inbox. Open the link from your email to
              choose a new password.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigateRoute('login')}
            className="w-full py-gutter-sm px-gutter-lg rounded-md bg-primary text-on-primary hover:bg-on-primary-container font-label text-label-md cursor-pointer"
          >
            Back to Sign In
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-gutter-lg">
          {error && (
            <div
              role="alert"
              className="p-gutter-md rounded-md bg-error/15 border border-error text-on-surface text-body-sm"
            >
              {error}
            </div>
          )}

          <div className="flex flex-col gap-gutter-xs">
            <label htmlFor="forgot-email" className="font-label text-label-md text-on-surface">
              Work Email
            </label>
            <input
              id="forgot-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              disabled={submitting}
              className="w-full px-gutter-md py-gutter-sm rounded-md bg-surface-container-low border border-outline text-body-md text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary"
            />
          </div>

          <button
            type="submit"
            disabled={submitting || !isConfigured}
            className="w-full inline-flex items-center justify-center gap-gutter-sm bg-primary text-on-primary px-gutter-xl py-gutter-md rounded-md font-label text-label-lg hover:bg-on-primary-container disabled:opacity-50 cursor-pointer"
          >
            {submitting ? 'Sending Reset Link...' : 'Send Recovery Link'}
          </button>

          <button
            type="button"
            onClick={() => onNavigateRoute('login')}
            className="font-label text-label-md text-on-surface-variant hover:text-primary self-center cursor-pointer"
          >
            Return to Sign In
          </button>
        </form>
      )}
    </AuthLayout>
  );
};

interface ResetPasswordPageProps {
  onNavigateRoute: (route: AppRoute) => void;
  onResetSuccess?: () => void;
}

export const ResetPasswordPage: React.FC<ResetPasswordPageProps> = ({
  onNavigateRoute,
  onResetSuccess,
}) => {
  const {
    resetPassword,
    completePasswordReset,
    isConfigured,
    isAuthenticated,
    isRecoveryMode,
    authLoading,
    recoveryError,
    clearRecoveryError,
  } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [completed, setCompleted] = useState(false);

  const submittingRef = React.useRef(false);
  const redirectingRef = React.useRef(false);
  const onNavigateRouteRef = React.useRef(onNavigateRoute);
  const onResetSuccessRef = React.useRef(onResetSuccess);
  onNavigateRouteRef.current = onNavigateRoute;
  onResetSuccessRef.current = onResetSuccess;

  const hasValidRecoverySession = !recoveryError && isAuthenticated && isRecoveryMode;

  const finishAndRedirectToLogin = React.useCallback(async () => {
    if (redirectingRef.current) return;
    redirectingRef.current = true;
    setRedirecting(true);
    try {
      await completePasswordReset();
    } finally {
      onResetSuccessRef.current?.();
      onNavigateRouteRef.current('login');
    }
  }, [completePasswordReset]);

  // Automatically redirect to the login page after a successful password update
  useEffect(() => {
    if (!completed) return;
    const timer = window.setTimeout(() => {
      void finishAndRedirectToLogin();
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [completed, finishAndRedirectToLogin]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submittingRef.current || submitting) {
      return;
    }

    setError(null);
    setFieldErrors({});
    clearRecoveryError();

    if (!isConfigured) {
      setError(
        'Supabase authentication is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
      );
      return;
    }

    const validation = validateResetPasswordInput(password, confirmPassword);
    if (!validation.valid) {
      setFieldErrors(validation.fieldErrors);
      const firstMessage =
        validation.fieldErrors.password ||
        validation.fieldErrors.confirmPassword ||
        'Please correct your new password entries.';
      setError(firstMessage);
      return;
    }

    if (!hasValidRecoverySession) {
      setError(
        'Your password recovery session is missing or expired. Please request a new password reset link.'
      );
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const res = await resetPassword(password, confirmPassword);
      if (!res.ok) {
        if (res.fieldErrors) {
          setFieldErrors(res.fieldErrors);
        }
        setError(res.error ?? 'Unable to update password. Please request a fresh recovery link.');
        return;
      }
      setPassword('');
      setConfirmPassword('');
      setCompleted(true);
    } catch (err) {
      if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
        console.error('[ResetPasswordPage] Password update failed unexpectedly:', err);
      }
      setError(
        err instanceof Error
          ? err.message
          : 'An unexpected error occurred while updating your password. Please try again.'
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      title="Set New Password"
      subtitle="Choose a strong password for your Blue Space account."
      onNavigateRoute={onNavigateRoute}
      isConfigured={isConfigured}
    >
      {completed ? (
        <div className="flex flex-col gap-gutter-lg">
          <div
            role="status"
            className="p-gutter-lg rounded-md bg-surface-container-low border border-success/50 flex flex-col gap-gutter-xs"
          >
            <div className="flex items-center gap-gutter-xs text-success font-label text-label-md">
              <span className="material-symbols-outlined text-[19px]" aria-hidden="true">
                check_circle
              </span>
              <span>Password updated successfully.</span>
            </div>
            <p className="text-body-md text-on-surface-variant">
              Redirecting you to the Sign In page so you can sign in with your new password...
            </p>
          </div>
          <button
            type="button"
            disabled={redirecting}
            onClick={() => void finishAndRedirectToLogin()}
            className="w-full py-gutter-sm px-gutter-lg rounded-md bg-primary text-on-primary hover:bg-on-primary-container disabled:opacity-50 font-label text-label-md cursor-pointer"
          >
            {redirecting ? 'Redirecting to Sign In...' : 'Continue to Sign In'}
          </button>
        </div>
      ) : authLoading ? (
        <div className="flex flex-col items-center justify-center gap-gutter-md py-gutter-xl text-center">
          <span
            className="material-symbols-outlined text-primary text-[28px] animate-spin"
            aria-hidden="true"
          >
            progress_activity
          </span>
          <p className="font-body text-body-md text-on-surface-variant">
            Verifying your password recovery link...
          </p>
        </div>
      ) : !hasValidRecoverySession ? (
        <div className="flex flex-col gap-gutter-lg">
          <div
            role="alert"
            className="p-gutter-md rounded-md bg-error/15 border border-error text-body-sm text-on-surface"
          >
            {recoveryError ??
              'No active password recovery session was detected. Open the password reset link directly from your email, or request a new recovery email.'}
          </div>
          <div className="flex items-center justify-between gap-gutter-sm">
            <button
              type="button"
              onClick={() => {
                clearRecoveryError();
                onNavigateRoute('login');
              }}
              className="px-gutter-md py-gutter-sm rounded-md border border-outline text-on-surface-variant hover:text-on-surface font-label text-label-md cursor-pointer"
            >
              Back to Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                clearRecoveryError();
                onNavigateRoute('forgot-password');
              }}
              className="px-gutter-lg py-gutter-sm rounded-md bg-primary text-on-primary hover:bg-on-primary-container font-label text-label-md cursor-pointer"
            >
              Request Reset Link
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-gutter-lg">
          {error && (
            <div
              role="alert"
              className="p-gutter-md rounded-md bg-error/15 border border-error text-on-surface text-body-sm"
            >
              {error}
            </div>
          )}

          <div className="flex flex-col gap-gutter-xs">
            <label htmlFor="reset-password" className="font-label text-label-md text-on-surface">
              New Password
            </label>
            <div className="relative">
              <input
                id="reset-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (fieldErrors.password) setFieldErrors((p) => ({ ...p, password: '' }));
                  if (error) setError(null);
                }}
                placeholder="Min 8 chars, A-Z, a-z, 0-9"
                disabled={submitting}
                className={`w-full pl-gutter-md pr-11 py-gutter-sm rounded-md bg-surface-container-low border text-body-md text-on-surface focus:outline-none focus:border-primary ${
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

          <div className="flex flex-col gap-gutter-xs">
            <label
              htmlFor="reset-confirm-password"
              className="font-label text-label-md text-on-surface"
            >
              Confirm New Password
            </label>
            <input
              id="reset-confirm-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                if (fieldErrors.confirmPassword) {
                  setFieldErrors((p) => ({ ...p, confirmPassword: '' }));
                }
                if (error) setError(null);
              }}
              placeholder="Re-enter new password"
              disabled={submitting}
              className={`w-full px-gutter-md py-gutter-sm rounded-md bg-surface-container-low border text-body-md text-on-surface focus:outline-none focus:border-primary ${
                fieldErrors.confirmPassword ? 'border-error' : 'border-outline'
              }`}
            />
            {fieldErrors.confirmPassword && (
              <p className="text-body-sm text-error">{fieldErrors.confirmPassword}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full inline-flex items-center justify-center gap-gutter-sm bg-primary text-on-primary px-gutter-xl py-gutter-md rounded-md font-label text-label-lg hover:bg-on-primary-container disabled:opacity-50 cursor-pointer"
          >
            {submitting && (
              <span
                className="material-symbols-outlined text-[18px] animate-spin"
                aria-hidden="true"
              >
                progress_activity
              </span>
            )}
            <span>{submitting ? 'Updating Password...' : 'Update Password'}</span>
          </button>
        </form>
      )}
    </AuthLayout>
  );
};
