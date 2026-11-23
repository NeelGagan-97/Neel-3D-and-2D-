import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { AppRoute, ProfileErrorKind } from '../../types/auth';
import { resolvePostLoginRoute } from '../../utils/authValidation';
import { AuthLayout } from './AuthLayout';

interface AccountStatusPageProps {
  variant: 'pending-approval' | 'account-rejected' | 'account-suspended' | 'profile-missing';
  onNavigateRoute: (route: AppRoute) => void;
}

const VARIANT_CONFIG: Record<
  AccountStatusPageProps['variant'],
  {
    title: string;
    subtitle: string;
    icon: string;
    accentClass: string;
    statusLabel: string;
    description: string;
  }
> = {
  'pending-approval': {
    title: 'Account Awaiting Approval',
    subtitle: 'Your registration is under review by a Blue Space administrator.',
    icon: 'hourglass_top',
    accentClass: 'text-warning',
    statusLabel: 'PENDING APPROVAL',
    description:
      'Access to the 3D Design Studio and Project Summary is restricted until an administrator approves your employee account. You can re-check your status below or sign out and return later.',
  },
  'account-rejected': {
    title: 'Account Access Rejected',
    subtitle: 'Your employee registration request was not approved.',
    icon: 'block',
    accentClass: 'text-error',
    statusLabel: 'REJECTED',
    description:
      'Protected design tools and workspace features are unavailable for rejected accounts. If you believe this was in error, please contact your Blue Space administrator.',
  },
  'account-suspended': {
    title: 'Account Suspended',
    subtitle: 'Your employee access has been temporarily suspended by an administrator.',
    icon: 'pause_circle',
    accentClass: 'text-error',
    statusLabel: 'SUSPENDED',
    description:
      'You currently cannot access the 3D Design Studio or Project Summary. Please reach out to your administrator to review reactivation eligibility.',
  },
  'profile-missing': {
    title: 'Employee Profile Not Found',
    subtitle: 'Your login succeeded, but no matching employee profile record was found.',
    icon: 'person_alert',
    accentClass: 'text-warning',
    statusLabel: 'PROFILE MISSING',
    description:
      'For security, protected design tools and administrative panels remain locked until your account is linked to an approved employee profile. Contact your administrator if this persists.',
  },
};

export const AccountStatusPage: React.FC<AccountStatusPageProps> = ({
  variant,
  onNavigateRoute,
}) => {
  const {
    isAuthenticated,
    user,
    profile,
    profileError,
    profileErrorKind,
    emailVerified,
    isConfigured,
    refreshProfile,
    recoverProfile,
    signOut,
  } = useAuth();
  const [checking, setChecking] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryFieldErrors, setRecoveryFieldErrors] = useState<Record<string, string>>({});

  const cfg = VARIANT_CONFIG[variant];
  const isVerifiedPending = variant === 'pending-approval' && emailVerified;
  const userMeta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const displayFullName =
    profile?.full_name ||
    (typeof userMeta.full_name === 'string' && userMeta.full_name.trim() ? userMeta.full_name.trim() : null);
  const displayUsername =
    profile?.username ||
    (typeof userMeta.username === 'string' && userMeta.username.trim() ? userMeta.username.trim() : null);
  const displayEmployeeId =
    profile?.employee_id ||
    (typeof userMeta.employee_id === 'string' && userMeta.employee_id.trim()
      ? userMeta.employee_id.trim().toUpperCase()
      : null);
  const displayMobile =
    profile?.mobile ||
    (typeof userMeta.mobile === 'string' && userMeta.mobile.trim() ? userMeta.mobile.trim() : null);

  const [recoveryForm, setRecoveryForm] = useState({
    fullName: displayFullName ?? '',
    employeeId: displayEmployeeId ?? '',
    username: displayUsername ?? '',
    mobile: displayMobile ?? '',
  });

  const handleRecheck = async () => {
    setChecking(true);
    setFeedback(null);
    setRecoveryError(null);
    try {
      const updated = await refreshProfile();
      if (updated) {
        const destination = resolvePostLoginRoute(updated, user?.id ?? null, { emailVerified });
        if (destination !== variant) {
          onNavigateRoute(destination);
          return;
        }
      }
      setFeedback(
        variant === 'profile-missing'
          ? 'Status checked — no employee profile record was found yet. You can recover your pending profile below.'
          : 'Status checked — your account is still awaiting Admin approval.'
      );
    } finally {
      setChecking(false);
    }
  };

  const handleRecoverProfile = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setRecovering(true);
    setFeedback(null);
    setRecoveryError(null);
    setRecoveryFieldErrors({});
    try {
      const res = await recoverProfile(
        variant === 'profile-missing'
          ? {
              fullName: recoveryForm.fullName.trim() || undefined,
              employeeId: recoveryForm.employeeId.trim() || undefined,
              username: recoveryForm.username.trim() || undefined,
              mobile: recoveryForm.mobile.trim() || undefined,
            }
          : undefined
      );

      if (!res.ok) {
        setRecoveryFieldErrors(res.fieldErrors ?? {});
        setRecoveryError(res.error ?? 'Unable to create your pending employee profile.');
        return;
      }

      if (res.data) {
        const destination = resolvePostLoginRoute(res.data, user?.id ?? null, { emailVerified });
        if (destination !== variant) {
          onNavigateRoute(destination);
          return;
        }
        setFeedback('Your pending employee profile is linked and awaiting Admin approval.');
      } else {
        setRecoveryError(
          'No profile record was returned. Ensure migration 003_employee_registration_and_approval.sql has been applied in Supabase.'
        );
      }
    } finally {
      setRecovering(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    onNavigateRoute('login');
  };

  // Never disguise an RLS, network, auth, or database error as "Employee Profile Not Found"
  if (variant === 'profile-missing' && profileError) {
    return (
      <ProfileLoadErrorPage
        error={profileError}
        errorKind={profileErrorKind}
        onNavigateRoute={onNavigateRoute}
      />
    );
  }

  return (
    <AuthLayout
      title={isVerifiedPending ? 'Email Verified — Awaiting Approval' : cfg.title}
      subtitle={
        isVerifiedPending
          ? 'Your email has been verified. Your registration is awaiting Admin approval.'
          : cfg.subtitle
      }
      onNavigateRoute={onNavigateRoute}
      isConfigured={isConfigured}
    >
      <div className="flex flex-col gap-gutter-lg">
        {isVerifiedPending && (
          <div
            role="status"
            className="p-gutter-md rounded-lg bg-success/15 border border-success text-on-surface text-body-md flex items-start gap-gutter-sm"
          >
            <span className="material-symbols-outlined text-success text-[20px] shrink-0 mt-0.5" aria-hidden="true">
              verified
            </span>
            <span>Your email has been verified. Your registration is awaiting Admin approval.</span>
          </div>
        )}

        <div className="p-gutter-lg rounded-lg bg-surface-container-low border border-outline-variant flex flex-col gap-gutter-md">
          <div className="flex items-center justify-between gap-gutter-sm">
            <div className={`flex items-center gap-gutter-sm font-label text-label-lg ${cfg.accentClass}`}>
              <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
                {cfg.icon}
              </span>
              <span>{cfg.statusLabel}</span>
            </div>
            {displayEmployeeId && (
              <span className="font-mono text-mono-sm text-on-surface-variant">
                {displayEmployeeId}
              </span>
            )}
          </div>

          <p className="font-body text-body-md text-on-surface-variant">{cfg.description}</p>

          {(profile || user) && (
            <dl className="pt-gutter-md border-t border-outline-variant grid grid-cols-1 sm:grid-cols-2 gap-gutter-sm text-body-sm">
              {displayFullName && (
                <div>
                  <dt className="text-on-surface-variant">Full Name</dt>
                  <dd className="text-on-surface font-medium">{displayFullName}</dd>
                </div>
              )}
              <div>
                <dt className="text-on-surface-variant">Email</dt>
                <dd className="font-mono text-on-surface truncate">
                  {profile?.email ?? user?.email ?? '—'}
                </dd>
              </div>
              {displayUsername && (
                <div>
                  <dt className="text-on-surface-variant">Username</dt>
                  <dd className="font-mono text-on-surface">{displayUsername}</dd>
                </div>
              )}
              {(profile?.role || variant === 'pending-approval') && (
                <div>
                  <dt className="text-on-surface-variant">Role</dt>
                  <dd className="font-mono text-on-surface">{profile?.role ?? 'EMPLOYEE'}</dd>
                </div>
              )}
              {variant === 'profile-missing' && user && (
                <>
                  <div className="sm:col-span-2">
                    <dt className="text-on-surface-variant">Supabase Auth User ID</dt>
                    <dd className="font-mono text-mono-sm text-on-surface-variant break-all">
                      {user.id}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-on-surface-variant">Email Verification</dt>
                    <dd className="font-mono text-on-surface">
                      {user.email_confirmed_at ? 'Confirmed' : 'Pending confirmation'}
                    </dd>
                  </div>
                </>
              )}
            </dl>
          )}
        </div>

        {/* Safe server-side PENDING profile recovery for authenticated users missing an employee_profiles row */}
        {variant === 'profile-missing' && isAuthenticated && user && (
          <form
            onSubmit={(e) => void handleRecoverProfile(e)}
            noValidate
            className="p-gutter-lg rounded-lg bg-surface-container border border-outline flex flex-col gap-gutter-md"
          >
            <div className="flex flex-col gap-1">
              <h3 className="font-label text-label-lg text-on-surface">
                Recover Pending Employee Profile
              </h3>
              <p className="text-body-sm text-on-surface-variant">
                Verify your registration details below to create your linked{' '}
                <span className="font-mono text-on-surface">EMPLOYEE</span> profile with{' '}
                <span className="font-mono text-warning">PENDING</span> approval status.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-gutter-md">
              <div className="flex flex-col gap-1 sm:col-span-2">
                <label htmlFor="rec-fullname" className="font-label text-label-sm text-on-surface">
                  Full Name
                </label>
                <input
                  id="rec-fullname"
                  type="text"
                  value={recoveryForm.fullName}
                  onChange={(e) => setRecoveryForm((p) => ({ ...p, fullName: e.target.value }))}
                  placeholder="Enter your full name"
                  disabled={recovering}
                  className="w-full px-gutter-md py-gutter-xs rounded-md bg-surface-container-low border border-outline text-body-sm text-on-surface focus:outline-none focus:border-primary"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="rec-empid" className="font-label text-label-sm text-on-surface">
                  Employee ID
                </label>
                <input
                  id="rec-empid"
                  type="text"
                  value={recoveryForm.employeeId}
                  onChange={(e) => setRecoveryForm((p) => ({ ...p, employeeId: e.target.value }))}
                  placeholder="e.g. EMP-1042"
                  disabled={recovering}
                  className={`w-full px-gutter-md py-gutter-xs rounded-md bg-surface-container-low border font-mono text-body-sm text-on-surface focus:outline-none focus:border-primary ${
                    recoveryFieldErrors.employeeId ? 'border-error' : 'border-outline'
                  }`}
                />
                {recoveryFieldErrors.employeeId && (
                  <p className="text-body-sm text-error">{recoveryFieldErrors.employeeId}</p>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="rec-username" className="font-label text-label-sm text-on-surface">
                  Username
                </label>
                <input
                  id="rec-username"
                  type="text"
                  value={recoveryForm.username}
                  onChange={(e) => setRecoveryForm((p) => ({ ...p, username: e.target.value }))}
                  placeholder="e.g. first.last"
                  disabled={recovering}
                  className={`w-full px-gutter-md py-gutter-xs rounded-md bg-surface-container-low border font-mono text-body-sm text-on-surface focus:outline-none focus:border-primary ${
                    recoveryFieldErrors.username ? 'border-error' : 'border-outline'
                  }`}
                />
                {recoveryFieldErrors.username && (
                  <p className="text-body-sm text-error">{recoveryFieldErrors.username}</p>
                )}
              </div>

              <div className="flex flex-col gap-1 sm:col-span-2">
                <label htmlFor="rec-mobile" className="font-label text-label-sm text-on-surface">
                  Mobile Number
                </label>
                <input
                  id="rec-mobile"
                  type="tel"
                  value={recoveryForm.mobile}
                  onChange={(e) => setRecoveryForm((p) => ({ ...p, mobile: e.target.value }))}
                  placeholder="+91 98765 43210"
                  disabled={recovering}
                  className="w-full px-gutter-md py-gutter-xs rounded-md bg-surface-container-low border font-mono text-body-sm text-on-surface focus:outline-none focus:border-primary"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={recovering}
              className="w-full inline-flex items-center justify-center gap-gutter-xs px-gutter-lg py-gutter-sm rounded-md bg-primary text-on-primary hover:bg-on-primary-container font-label text-label-md disabled:opacity-50 cursor-pointer"
            >
              <span
                className={`material-symbols-outlined text-[18px] ${recovering ? 'animate-spin' : ''}`}
                aria-hidden="true"
              >
                {recovering ? 'progress_activity' : 'person_check'}
              </span>
              <span>
                {recovering ? 'Creating Pending Profile...' : 'Create Pending Employee Profile'}
              </span>
            </button>
          </form>
        )}

        {variant === 'pending-approval' && isAuthenticated && !profile && (
          <div className="p-gutter-md rounded-md bg-surface-container border border-outline flex flex-wrap items-center justify-between gap-gutter-sm text-body-sm">
            <span className="text-on-surface-variant">
              Your profile record is syncing with the approval queue.
            </span>
            <button
              type="button"
              onClick={() => void handleRecoverProfile()}
              disabled={recovering}
              className="inline-flex items-center gap-1 px-gutter-md py-1.5 rounded-sm bg-primary-container border border-primary text-primary font-label text-label-sm disabled:opacity-50 cursor-pointer"
            >
              <span>{recovering ? 'Syncing...' : 'Sync Profile Now'}</span>
            </button>
          </div>
        )}

        {(profileError || recoveryError) && (
          <div
            role="alert"
            className="p-gutter-md rounded-md bg-error/15 border border-error text-body-sm text-on-surface"
          >
            {recoveryError ?? profileError}
          </div>
        )}

        {feedback && (
          <div className="p-gutter-md rounded-md bg-surface-container-high border border-outline text-body-sm text-on-surface-variant">
            {feedback}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-gutter-sm">
          {isAuthenticated ? (
            <>
              <button
                type="button"
                onClick={handleRecheck}
                disabled={checking}
                className="inline-flex items-center gap-gutter-xs px-gutter-lg py-gutter-sm rounded-md bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-md disabled:opacity-50 cursor-pointer"
              >
                <span
                  className={`material-symbols-outlined text-[18px] ${checking ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                >
                  refresh
                </span>
                <span>{checking ? 'Checking...' : 'Check Status'}</span>
              </button>

              <button
                type="button"
                onClick={handleSignOut}
                className="inline-flex items-center gap-gutter-xs px-gutter-lg py-gutter-sm rounded-md bg-primary text-on-primary hover:bg-on-primary-container font-label text-label-md cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                  logout
                </span>
                <span>Sign Out</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => onNavigateRoute('login')}
              className="ml-auto inline-flex items-center gap-gutter-xs px-gutter-lg py-gutter-sm rounded-md bg-primary text-on-primary hover:bg-on-primary-container font-label text-label-md cursor-pointer"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                login
              </span>
              <span>Go to Sign In</span>
            </button>
          )}
        </div>
      </div>
    </AuthLayout>
  );
};

interface ProfileLoadErrorPageProps {
  error: string;
  errorKind: ProfileErrorKind | null;
  onNavigateRoute: (route: AppRoute) => void;
  onRetry?: () => void | Promise<void>;
}

const PROFILE_ERROR_META: Record<
  ProfileErrorKind,
  { title: string; statusLabel: string; icon: string }
> = {
  rls: {
    title: 'Profile Access Permission Error',
    statusLabel: 'RLS PERMISSION ERROR',
    icon: 'gpp_maybe',
  },
  network: {
    title: 'Unable to Reach Authentication Server',
    statusLabel: 'NETWORK ERROR',
    icon: 'wifi_off',
  },
  auth: {
    title: 'Session Verification Error',
    statusLabel: 'AUTHENTICATION ERROR',
    icon: 'key_off',
  },
  database: {
    title: 'Unable to Load Employee Profile',
    statusLabel: 'DATABASE ERROR',
    icon: 'database_off',
  },
};

export const ProfileLoadErrorPage: React.FC<ProfileLoadErrorPageProps> = ({
  error,
  errorKind,
  onNavigateRoute,
  onRetry,
}) => {
  const { user, isConfigured, refreshProfile, signOut } = useAuth();
  const [retrying, setRetrying] = useState(false);

  const meta = PROFILE_ERROR_META[errorKind ?? 'database'];

  const handleRetry = async () => {
    setRetrying(true);
    try {
      if (onRetry) {
        await onRetry();
        return;
      }
      const updated = await refreshProfile();
      if (updated) {
        onNavigateRoute(resolvePostLoginRoute(updated, user?.id ?? null));
      }
    } finally {
      setRetrying(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    onNavigateRoute('login');
  };

  return (
    <AuthLayout
      title={meta.title}
      onNavigateRoute={onNavigateRoute}
      isConfigured={isConfigured}
    >
      <div className="flex flex-col gap-gutter-lg">
        <div
          role="alert"
          className="p-gutter-lg rounded-lg bg-error/15 border border-error flex flex-col gap-gutter-md"
        >
          <div className="flex items-center gap-gutter-sm font-label text-label-lg text-error">
            <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
              {meta.icon}
            </span>
            <span>{meta.statusLabel}</span>
          </div>

          <p className="font-body text-body-md text-on-surface">{error}</p>

          {user && (
            <dl className="pt-gutter-md border-t border-error/30 grid grid-cols-1 gap-gutter-xs text-body-sm">
              <div>
                <dt className="text-on-surface-variant">Signed-in Email</dt>
                <dd className="font-mono text-on-surface truncate">{user.email ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-on-surface-variant">Auth User ID</dt>
                <dd className="font-mono text-on-surface truncate">{user.id}</dd>
              </div>
            </dl>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-gutter-sm">
          <button
            type="button"
            onClick={() => void handleRetry()}
            disabled={retrying}
            className="inline-flex items-center gap-gutter-xs px-gutter-lg py-gutter-sm rounded-md bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-md disabled:opacity-50 cursor-pointer"
          >
            <span
              className={`material-symbols-outlined text-[18px] ${retrying ? 'animate-spin' : ''}`}
              aria-hidden="true"
            >
              refresh
            </span>
            <span>{retrying ? 'Retrying...' : 'Retry Profile Load'}</span>
          </button>

          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="inline-flex items-center gap-gutter-xs px-gutter-lg py-gutter-sm rounded-md bg-primary text-on-primary hover:bg-on-primary-container font-label text-label-md cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              logout
            </span>
            <span>Sign Out</span>
          </button>
        </div>
      </div>
    </AuthLayout>
  );
};
