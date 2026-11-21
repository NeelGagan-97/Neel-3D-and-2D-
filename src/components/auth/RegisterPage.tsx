import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { AppRoute, EmployeeRegistrationInput } from '../../types/auth';
import { validateRegistrationInput } from '../../utils/authValidation';
import { AuthLayout } from './AuthLayout';

interface RegisterPageProps {
  onNavigateRoute: (route: AppRoute) => void;
}

const EMPTY_FORM: EmployeeRegistrationInput = {
  fullName: '',
  employeeId: '',
  username: '',
  email: '',
  mobile: '',
  password: '',
  confirmPassword: '',
};

export const RegisterPage: React.FC<RegisterPageProps> = ({ onNavigateRoute }) => {
  const { register, isConfigured } = useAuth();
  const [form, setForm] = useState<EmployeeRegistrationInput>(EMPTY_FORM);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [successState, setSuccessState] = useState<{
    email: string;
    requiresEmailConfirmation: boolean;
  } | null>(null);

  const updateField = (key: keyof EmployeeRegistrationInput, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (fieldErrors[key]) {
      setFieldErrors((prev) => ({ ...prev, [key]: '' }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFieldErrors({});

    const validation = validateRegistrationInput(form);
    if (!validation.valid) {
      setFieldErrors(validation.fieldErrors);
      setFormError('Please correct the highlighted fields below.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await register(form);
      if (!res.ok || !res.data) {
        setFieldErrors(res.fieldErrors ?? {});
        setFormError(res.error ?? 'Registration failed. Please try again.');
        return;
      }

      if (res.data.requiresEmailConfirmation) {
        setSuccessState({
          email: form.email.trim().toLowerCase(),
          requiresEmailConfirmation: true,
        });
      } else {
        setSuccessState({
          email: form.email.trim().toLowerCase(),
          requiresEmailConfirmation: false,
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (successState) {
    return (
      <AuthLayout
        title="Registration Submitted"
        subtitle="Your employee account has been created with Pending approval status."
        onNavigateRoute={onNavigateRoute}
        isConfigured={isConfigured}
      >
        <div className="flex flex-col gap-gutter-lg">
          <div className="p-gutter-lg rounded-lg bg-surface-container-low border border-outline-variant flex flex-col gap-gutter-sm">
            <div className="flex items-center gap-gutter-sm text-success font-label text-label-lg">
              <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
                check_circle
              </span>
              <span>Employee Profile Created</span>
            </div>
            <p className="font-body text-body-md text-on-surface-variant">
              {successState.requiresEmailConfirmation ? (
                <>
                  We sent a verification email to{' '}
                  <span className="font-mono text-on-surface">{successState.email}</span>. Please
                  confirm your email address first. Once verified, an approved Neel 3D Space
                  administrator will review and approve your access.
                </>
              ) : (
                <>
                  Your account for{' '}
                  <span className="font-mono text-on-surface">{successState.email}</span> is
                  registered as an <strong className="text-on-surface">Employee</strong> and is
                  currently awaiting administrator approval.
                </>
              )}
            </p>
            <div className="pt-gutter-sm border-t border-outline-variant flex flex-wrap items-center gap-gutter-md text-body-sm text-on-surface-variant font-mono">
              <span>Role: EMPLOYEE</span>
              <span aria-hidden="true">·</span>
              <span className="text-warning">Status: PENDING APPROVAL</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-gutter-sm">
            <button
              type="button"
              onClick={() => onNavigateRoute('home')}
              className="px-gutter-lg py-gutter-sm rounded-md border border-outline text-on-surface-variant hover:text-on-surface hover:border-primary font-label text-label-md cursor-pointer"
            >
              Return Home
            </button>
            <button
              type="button"
              onClick={() =>
                onNavigateRoute(
                  successState.requiresEmailConfirmation ? 'login' : 'pending-approval'
                )
              }
              className="inline-flex items-center gap-gutter-xs px-gutter-xl py-gutter-sm rounded-md bg-primary text-on-primary hover:bg-on-primary-container font-label text-label-md cursor-pointer"
            >
              <span>
                {successState.requiresEmailConfirmation ? 'Go to Sign In' : 'View Account Status'}
              </span>
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                arrow_forward
              </span>
            </button>
          </div>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Employee Registration"
      subtitle="Create your Neel 3D Space employee account. New registrations require administrator approval before accessing the 3D Design Studio."
      onNavigateRoute={onNavigateRoute}
      isConfigured={isConfigured}
      maxWidthClass="max-w-2xl"
    >
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-gutter-lg">
          <div className="flex flex-col gap-gutter-xs sm:col-span-2">
            <label htmlFor="reg-fullname" className="font-label text-label-md text-on-surface">
              Full Name
            </label>
            <input
              id="reg-fullname"
              type="text"
              autoComplete="name"
              value={form.fullName}
              onChange={(e) => updateField('fullName', e.target.value)}
              placeholder="e.g. Aarav Sharma"
              disabled={submitting}
              aria-invalid={Boolean(fieldErrors.fullName)}
              className={`w-full px-gutter-md py-gutter-sm rounded-md bg-surface-container-low border text-body-md text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary ${
                fieldErrors.fullName ? 'border-error' : 'border-outline'
              }`}
            />
            {fieldErrors.fullName && (
              <p className="text-body-sm text-error">{fieldErrors.fullName}</p>
            )}
          </div>

          <div className="flex flex-col gap-gutter-xs">
            <label htmlFor="reg-empid" className="font-label text-label-md text-on-surface">
              Employee ID
            </label>
            <input
              id="reg-empid"
              type="text"
              value={form.employeeId}
              onChange={(e) => updateField('employeeId', e.target.value)}
              placeholder="e.g. EMP-1042"
              disabled={submitting}
              aria-invalid={Boolean(fieldErrors.employeeId)}
              className={`w-full px-gutter-md py-gutter-sm rounded-md bg-surface-container-low border font-mono text-body-md text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary ${
                fieldErrors.employeeId ? 'border-error' : 'border-outline'
              }`}
            />
            {fieldErrors.employeeId && (
              <p className="text-body-sm text-error">{fieldErrors.employeeId}</p>
            )}
          </div>

          <div className="flex flex-col gap-gutter-xs">
            <label htmlFor="reg-username" className="font-label text-label-md text-on-surface">
              Username
            </label>
            <input
              id="reg-username"
              type="text"
              autoComplete="username"
              value={form.username}
              onChange={(e) => updateField('username', e.target.value)}
              placeholder="e.g. aarav.sharma"
              disabled={submitting}
              aria-invalid={Boolean(fieldErrors.username)}
              className={`w-full px-gutter-md py-gutter-sm rounded-md bg-surface-container-low border font-mono text-body-md text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary ${
                fieldErrors.username ? 'border-error' : 'border-outline'
              }`}
            />
            {fieldErrors.username && (
              <p className="text-body-sm text-error">{fieldErrors.username}</p>
            )}
          </div>

          <div className="flex flex-col gap-gutter-xs">
            <label htmlFor="reg-email" className="font-label text-label-md text-on-surface">
              Email Address
            </label>
            <input
              id="reg-email"
              type="email"
              autoComplete="email"
              value={form.email}
              onChange={(e) => updateField('email', e.target.value)}
              placeholder="aarav@company.com"
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
            <label htmlFor="reg-mobile" className="font-label text-label-md text-on-surface">
              Mobile Number
            </label>
            <input
              id="reg-mobile"
              type="tel"
              autoComplete="tel"
              value={form.mobile}
              onChange={(e) => updateField('mobile', e.target.value)}
              placeholder="+91 98765 43210"
              disabled={submitting}
              aria-invalid={Boolean(fieldErrors.mobile)}
              className={`w-full px-gutter-md py-gutter-sm rounded-md bg-surface-container-low border font-mono text-body-md text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary ${
                fieldErrors.mobile ? 'border-error' : 'border-outline'
              }`}
            />
            {fieldErrors.mobile && (
              <p className="text-body-sm text-error">{fieldErrors.mobile}</p>
            )}
          </div>

          <div className="flex flex-col gap-gutter-xs">
            <label htmlFor="reg-password" className="font-label text-label-md text-on-surface">
              Password
            </label>
            <div className="relative">
              <input
                id="reg-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => updateField('password', e.target.value)}
                placeholder="Min 8 chars, A-Z, a-z, 0-9"
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

          <div className="flex flex-col gap-gutter-xs">
            <label htmlFor="reg-confirm-password" className="font-label text-label-md text-on-surface">
              Confirm Password
            </label>
            <input
              id="reg-confirm-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              value={form.confirmPassword}
              onChange={(e) => updateField('confirmPassword', e.target.value)}
              placeholder="Re-enter password"
              disabled={submitting}
              aria-invalid={Boolean(fieldErrors.confirmPassword)}
              className={`w-full px-gutter-md py-gutter-sm rounded-md bg-surface-container-low border text-body-md text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary ${
                fieldErrors.confirmPassword ? 'border-error' : 'border-outline'
              }`}
            />
            {fieldErrors.confirmPassword && (
              <p className="text-body-sm text-error">{fieldErrors.confirmPassword}</p>
            )}
          </div>
        </div>

        <p className="text-body-sm text-on-surface-variant">
          All new accounts are created with <span className="font-mono text-on-surface">EMPLOYEE</span> role and{' '}
          <span className="font-mono text-warning">PENDING</span> approval status until reviewed by an administrator.
        </p>

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
              <span>Creating Account...</span>
            </>
          ) : (
            <>
              <span className="material-symbols-outlined text-[19px]" aria-hidden="true">
                person_add
              </span>
              <span>Submit Employee Registration</span>
            </>
          )}
        </button>
      </form>

      <div className="mt-gutter-xl pt-gutter-lg border-t border-outline-variant flex flex-col sm:flex-row items-center justify-between gap-gutter-sm text-body-sm text-on-surface-variant">
        <span>Already have an employee or admin account?</span>
        <button
          type="button"
          onClick={() => onNavigateRoute('login')}
          className="font-label text-label-md text-primary hover:underline cursor-pointer whitespace-nowrap"
        >
          Sign In
        </button>
      </div>
    </AuthLayout>
  );
};
