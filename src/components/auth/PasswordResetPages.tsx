import React, { useState } from 'react';
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const validation = validateForgotPasswordEmail(email);
    if (!validation.valid) {
      setError(validation.fieldErrors.email ?? 'Enter a valid email address.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await sendPasswordReset(email);
      if (!res.ok) {
        setError(res.error ?? 'Could not send password reset instructions.');
        return;
      }
      setSubmitted(true);
    } finally {
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
              password reset link has been sent to that inbox. Open the link to choose a new
              password.
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
}

export const ResetPasswordPage: React.FC<ResetPasswordPageProps> = ({
  onNavigateRoute,
}) => {
  const { resetPassword, isConfigured, isAuthenticated, isRecoveryMode, exitRecoveryMode } =
    useAuth();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [completed, setCompleted] = useState(false);

  const canUpdatePassword = isAuthenticated || isRecoveryMode;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    const validation = validateResetPasswordInput(password, confirmPassword);
    if (!validation.valid) {
      setFieldErrors(validation.fieldErrors);
      setError('Please correct your new password entries.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await resetPassword(password, confirmPassword);
      if (!res.ok) {
        setError(res.error ?? 'Unable to update password. Request a fresh recovery link.');
        return;
      }
      setCompleted(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      title="Set New Password"
      subtitle="Choose a strong password for your Neel 3D Space account."
      onNavigateRoute={onNavigateRoute}
      isConfigured={isConfigured}
    >
      {completed ? (
        <div className="flex flex-col gap-gutter-lg">
          <div className="p-gutter-lg rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-gutter-xs">
            <div className="flex items-center gap-gutter-xs text-success font-label text-label-md">
              <span className="material-symbols-outlined text-[19px]" aria-hidden="true">
                check_circle
              </span>
              <span>Password Updated</span>
            </div>
            <p className="text-body-md text-on-surface-variant">
              Your password has been successfully updated. You can now sign in with your new
              password.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              exitRecoveryMode();
              onNavigateRoute('login');
            }}
            className="w-full py-gutter-sm px-gutter-lg rounded-md bg-primary text-on-primary hover:bg-on-primary-container font-label text-label-md cursor-pointer"
          >
            Continue to Sign In
          </button>
        </div>
      ) : !canUpdatePassword ? (
        <div className="flex flex-col gap-gutter-lg">
          <div className="p-gutter-md rounded-md bg-secondary-container/30 border border-secondary text-body-sm text-on-surface-variant">
            No active password recovery session was detected. Open the password reset link directly
            from your email, or request a new recovery email.
          </div>
          <div className="flex items-center justify-end gap-gutter-sm">
            <button
              type="button"
              onClick={() => onNavigateRoute('forgot-password')}
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
                onChange={(e) => setPassword(e.target.value)}
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
              onChange={(e) => setConfirmPassword(e.target.value)}
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
            disabled={submitting || !isConfigured}
            className="w-full inline-flex items-center justify-center gap-gutter-sm bg-primary text-on-primary px-gutter-xl py-gutter-md rounded-md font-label text-label-lg hover:bg-on-primary-container disabled:opacity-50 cursor-pointer"
          >
            {submitting ? 'Updating Password...' : 'Update Password'}
          </button>
        </form>
      )}
    </AuthLayout>
  );
};
