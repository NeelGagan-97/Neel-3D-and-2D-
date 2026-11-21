import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { AppRoute } from '../../types/auth';
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
    subtitle: 'Your registration is under review by a Neel 3D Space administrator.',
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
      'Protected design tools and workspace features are unavailable for rejected accounts. If you believe this was in error, please contact your Neel 3D Space administrator.',
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
  const { user, profile, profileError, isConfigured, refreshProfile, signOut } = useAuth();
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const cfg = VARIANT_CONFIG[variant];

  const handleRecheck = async () => {
    setChecking(true);
    setFeedback(null);
    try {
      const updated = await refreshProfile();
      const destination = resolvePostLoginRoute(updated);
      if (destination !== variant) {
        onNavigateRoute(destination);
      } else {
        setFeedback('Status checked — your account state has not changed yet.');
      }
    } finally {
      setChecking(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    onNavigateRoute('login');
  };

  if (variant === 'profile-missing') {
    return (
      <AuthLayout
        title={cfg.title}
        onNavigateRoute={onNavigateRoute}
        isConfigured={isConfigured}
      />
    );
  }

  return (
    <AuthLayout
      title={cfg.title}
      subtitle={cfg.subtitle}
      onNavigateRoute={onNavigateRoute}
      isConfigured={isConfigured}
    >
      <div className="flex flex-col gap-gutter-lg">
        <div className="p-gutter-lg rounded-lg bg-surface-container-low border border-outline-variant flex flex-col gap-gutter-md">
          <div className="flex items-center justify-between gap-gutter-sm">
            <div className={`flex items-center gap-gutter-sm font-label text-label-lg ${cfg.accentClass}`}>
              <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
                {cfg.icon}
              </span>
              <span>{cfg.statusLabel}</span>
            </div>
            {profile && (
              <span className="font-mono text-mono-sm text-on-surface-variant">
                {profile.employee_id}
              </span>
            )}
          </div>

          <p className="font-body text-body-md text-on-surface-variant">{cfg.description}</p>

          {(profile || user) && (
            <dl className="pt-gutter-md border-t border-outline-variant grid grid-cols-1 sm:grid-cols-2 gap-gutter-sm text-body-sm">
              {profile?.full_name && (
                <div>
                  <dt className="text-on-surface-variant">Full Name</dt>
                  <dd className="text-on-surface font-medium">{profile.full_name}</dd>
                </div>
              )}
              <div>
                <dt className="text-on-surface-variant">Email</dt>
                <dd className="font-mono text-on-surface truncate">
                  {profile?.email ?? user?.email ?? '—'}
                </dd>
              </div>
              {profile?.username && (
                <div>
                  <dt className="text-on-surface-variant">Username</dt>
                  <dd className="font-mono text-on-surface">{profile.username}</dd>
                </div>
              )}
              {profile?.role && (
                <div>
                  <dt className="text-on-surface-variant">Role</dt>
                  <dd className="font-mono text-on-surface">{profile.role}</dd>
                </div>
              )}
            </dl>
          )}
        </div>

        {profileError && (
          <div
            role="alert"
            className="p-gutter-md rounded-md bg-error/15 border border-error text-body-sm text-on-surface"
          >
            {profileError}
          </div>
        )}

        {feedback && (
          <div className="p-gutter-md rounded-md bg-surface-container-high border border-outline text-body-sm text-on-surface-variant">
            {feedback}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-gutter-sm">
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
        </div>
      </div>
    </AuthLayout>
  );
};
