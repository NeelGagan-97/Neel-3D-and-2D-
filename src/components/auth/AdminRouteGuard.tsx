import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { AUTH_TIMEOUT_MS, AuthTimeoutError, withTimeout } from '../../services/authService';
import { AppRoute, ProfileErrorKind } from '../../types/auth';
import { isApprovedAdmin } from '../../utils/authValidation';
import { ProfileLoadErrorPage } from './AccountStatusPage';

interface AdminRouteGuardProps {
  onUnauthorized: (redirectTo: AppRoute, notice?: string) => void;
  onNavigateRoute: (route: AppRoute) => void;
  children: React.ReactNode;
}

/**
 * Dedicated protected route guard for `/admin`.
 * - Uses `verifyProfile()` (which does NOT flip global `profileLoading`) so verifying
 *   entry to `/admin` never causes `App.tsx` to unmount/remount this guard in a loop.
 * - Enforces a bounded timeout so an infinite loading spinner can never occur.
 * - Displays an actionable error screen on session, RLS, database, or network failures.
 * - Grants access ONLY when `auth_user_id === user.id`, `role === 'ADMIN'`, and
 *   `account_status === 'APPROVED'`.
 */
export const AdminRouteGuard: React.FC<AdminRouteGuardProps> = ({
  onUnauthorized,
  onNavigateRoute,
  children,
}) => {
  const {
    isAuthenticated,
    user,
    profile,
    authLoading,
    profileLoading,
    verifyProfile,
  } = useAuth();

  const [verifiedUserId, setVerifiedUserId] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<boolean>(true);
  const [verificationError, setVerificationError] = useState<{
    message: string;
    kind: ProfileErrorKind;
  } | null>(null);
  const [retryCount, setRetryCount] = useState<number>(0);

  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;
  const verifyProfileRef = useRef(verifyProfile);
  verifyProfileRef.current = verifyProfile;

  const handleRetry = useCallback(() => {
    setVerificationError(null);
    setVerifiedUserId(null);
    setVerifying(true);
    setRetryCount((c) => c + 1);
  }, []);

  useEffect(() => {
    let active = true;

    if (authLoading) {
      setVerifying(true);
      setVerifiedUserId(null);
      setVerificationError(null);
      return;
    }

    if (!isAuthenticated || !user) {
      setVerifiedUserId(null);
      setVerifying(false);
      setVerificationError(null);
      onUnauthorizedRef.current(
        'login',
        'Sign in with an approved administrator account to access the Admin Dashboard.'
      );
      return;
    }

    const uid = user.id;
    setVerifying(true);
    setVerificationError(null);

    const verifyAdminAccess = async () => {
      try {
        const res = await withTimeout(
          verifyProfileRef.current(),
          AUTH_TIMEOUT_MS + 1_000,
          'Administrator permission verification'
        );
        if (!active) return;

        if (!res.ok) {
          console.error('[Auth] AdminRouteGuard verification failed:', {
            errorCategory: res.errorKind ?? 'database',
            httpStatus: res.httpStatus ?? null,
            hasSession: true,
            userId: uid,
            errorCode: res.errorCode ?? null,
            message: res.error ?? 'Unknown error',
          });
          setVerifiedUserId(null);
          setVerifying(false);
          setVerificationError({
            message:
              res.error ??
              'Unable to verify your administrator permissions. Please retry or sign in again.',
            kind: res.errorKind ?? 'database',
          });
          return;
        }

        const freshProfile = res.data ?? null;

        if (freshProfile && isApprovedAdmin(freshProfile, uid)) {
          setVerifiedUserId(uid);
          setVerificationError(null);
          setVerifying(false);
          return;
        }

        setVerifiedUserId(null);
        setVerifying(false);

        if (!freshProfile) {
          onUnauthorizedRef.current('profile-missing');
          return;
        }

        if (freshProfile.account_status === 'PENDING') {
          onUnauthorizedRef.current('pending-approval');
          return;
        }
        if (freshProfile.account_status === 'REJECTED') {
          onUnauthorizedRef.current('account-rejected');
          return;
        }
        if (freshProfile.account_status === 'SUSPENDED') {
          onUnauthorizedRef.current('account-suspended');
          return;
        }

        onUnauthorizedRef.current(
          'employee-dashboard',
          'Access denied: Administrator privileges are required to view the Admin Dashboard.'
        );
      } catch (err) {
        if (!active) return;
        const isTimeout = err instanceof AuthTimeoutError;
        console.error('[Auth] AdminRouteGuard verification threw:', {
          errorCategory: isTimeout ? 'timeout' : 'network',
          httpStatus: null,
          hasSession: true,
          userId: uid,
          message: err instanceof Error ? err.message : 'Unknown error',
        });
        setVerifiedUserId(null);
        setVerifying(false);
        setVerificationError({
          message: isTimeout
            ? 'Timed out while verifying administrator permissions with Supabase. Check your connection and retry.'
            : 'An unexpected error occurred while verifying administrator permissions. Please retry.',
          kind: 'network',
        });
      }
    };

    void verifyAdminAccess();

    return () => {
      active = false;
    };
  }, [authLoading, isAuthenticated, user?.id, retryCount]);

  if (verificationError) {
    return (
      <ProfileLoadErrorPage
        error={verificationError.message}
        errorKind={verificationError.kind}
        onNavigateRoute={onNavigateRoute}
        onRetry={handleRetry}
      />
    );
  }

  const isStrictlyAuthorized =
    !authLoading &&
    !profileLoading &&
    !verifying &&
    isAuthenticated &&
    Boolean(user) &&
    verifiedUserId === user?.id &&
    isApprovedAdmin(profile, user?.id ?? null);

  if (!isStrictlyAuthorized) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-surface text-on-surface gap-gutter-md p-gutter-xl">
        <span
          className="material-symbols-outlined text-primary text-[32px] animate-spin"
          aria-hidden="true"
        >
          progress_activity
        </span>
        <p className="font-mono text-mono-md text-on-surface-variant">
          {authLoading || profileLoading || verifying
            ? 'Verifying administrator permissions...'
            : 'Redirecting...'}
        </p>
      </div>
    );
  }

  return <>{children}</>;
};
