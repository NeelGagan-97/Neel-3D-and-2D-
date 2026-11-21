import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import {
  AUTH_TIMEOUT_MS,
  AuthActionResult,
  AuthTimeoutError,
  ensureOwnEmployeeProfile,
  fetchEmployeeProfile,
  LoginResult,
  registerEmployee,
  RegisterResult,
  requestPasswordReset,
  signInWithEmail,
  signOutUser,
  updateUserPassword,
  withTimeout,
} from '../services/authService';
import {
  EmployeeProfile,
  EmployeeRegistrationInput,
  ProfileErrorKind,
  ProfileRecoveryInput,
} from '../types/auth';
import { isApprovedAdmin, isApprovedUser } from '../utils/authValidation';
import {
  clearAuthUrlParams,
  isEmailConfirmationUrl,
  isRecoveryUrl,
  parseAuthCallbackCode,
  parseAuthErrorFromUrl,
  parseEmailConfirmationTokenHash,
  parseRecoveryCode,
  parseRecoveryTokenHash,
} from '../utils/router';

interface AuthContextValue {
  isConfigured: boolean;
  session: Session | null;
  user: User | null;
  profile: EmployeeProfile | null;
  authLoading: boolean;
  profileLoading: boolean;
  authError: string | null;
  authErrorKind: ProfileErrorKind | null;
  profileError: string | null;
  profileErrorKind: ProfileErrorKind | null;
  isRecoveryMode: boolean;
  recoveryError: string | null;
  emailVerified: boolean;
  sessionNotice: string | null;
  isAuthenticated: boolean;
  isApproved: boolean;
  isAdmin: boolean;
  signIn: (email: string, password: string) => Promise<AuthActionResult<LoginResult>>;
  register: (input: EmployeeRegistrationInput) => Promise<AuthActionResult<RegisterResult>>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<EmployeeProfile | null>;
  verifyProfile: () => Promise<AuthActionResult<EmployeeProfile | null>>;
  recoverProfile: (
    input?: ProfileRecoveryInput
  ) => Promise<AuthActionResult<EmployeeProfile | null>>;
  sendPasswordReset: (email: string) => Promise<AuthActionResult>;
  resetPassword: (password: string, confirmPassword: string) => Promise<AuthActionResult>;
  completePasswordReset: () => Promise<void>;
  clearSessionNotice: () => void;
  clearRecoveryError: () => void;
  clearEmailVerified: () => void;
  exitRecoveryMode: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function isSessionExpired(session: Session | null): boolean {
  if (!session?.expires_at) return false;
  return session.expires_at * 1000 <= Date.now();
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(isSupabaseConfigured);
  const [profileLoading, setProfileLoading] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authErrorKind, setAuthErrorKind] = useState<ProfileErrorKind | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileErrorKind, setProfileErrorKind] = useState<ProfileErrorKind | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [emailVerified, setEmailVerified] = useState<boolean>(false);
  const [isRecoveryMode, setIsRecoveryMode] = useState<boolean>(() =>
    typeof window !== 'undefined'
      ? isRecoveryUrl(
          window.location.search,
          window.location.hash,
          window.location.pathname
        )
      : false
  );
  const [recoveryError, setRecoveryError] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    if (
      isEmailConfirmationUrl(
        window.location.search,
        window.location.hash,
        window.location.pathname
      )
    ) {
      return null;
    }
    return parseAuthErrorFromUrl(window.location.search, window.location.hash, 'recovery');
  });

  // Deduplication refs to prevent redundant profile queries and re-subscriptions
  const loadedUserIdRef = useRef<string | null>(null);
  const profileRef = useRef<EmployeeProfile | null>(null);
  const profileErrorRef = useRef<string | null>(null);
  const inFlightProfileRef = useRef<{
    userId: string;
    promise: Promise<EmployeeProfile | null>;
  } | null>(null);
  const manualSignOutRef = useRef<boolean>(false);
  const hadActiveSessionRef = useRef<boolean>(false);
  const signingInRef = useRef<boolean>(false);
  const isRecoveryModeRef = useRef<boolean>(isRecoveryMode);
  const recoveryExchangeAttemptedRef = useRef<boolean>(false);
  const emailConfirmationAttemptedRef = useRef<boolean>(false);

  profileRef.current = profile;
  profileErrorRef.current = profileError;
  isRecoveryModeRef.current = isRecoveryMode;

  const loadProfileForUser = useCallback(
    async (
      userId: string,
      force = false,
      ensureIfMissing = false
    ): Promise<EmployeeProfile | null> => {
      if (!force && loadedUserIdRef.current === userId && !profileErrorRef.current) {
        setProfileLoading(false);
        return profileRef.current;
      }

      if (inFlightProfileRef.current && inFlightProfileRef.current.userId === userId) {
        return inFlightProfileRef.current.promise;
      }

      setProfileLoading(true);
      setProfileError(null);
      setProfileErrorKind(null);

      const promise = (async () => {
        const res = await fetchEmployeeProfile(userId);
        if (res.ok) {
          let verifiedProfile =
            res.data && res.data.auth_user_id === userId ? res.data : null;

          if (!verifiedProfile && ensureIfMissing) {
            const ensured = await ensureOwnEmployeeProfile();
            if (!ensured.ok) {
              loadedUserIdRef.current = null;
              profileRef.current = null;
              profileErrorRef.current =
                ensured.error ?? 'Unable to provision your employee profile.';
              setProfile(null);
              setProfileError(ensured.error ?? 'Unable to provision your employee profile.');
              setProfileErrorKind(ensured.errorKind ?? 'database');
              return null;
            }
            if (ensured.data && ensured.data.auth_user_id === userId) {
              verifiedProfile = ensured.data;
            }
          }

          loadedUserIdRef.current = userId;
          profileRef.current = verifiedProfile;
          profileErrorRef.current = null;
          setProfile(verifiedProfile);
          setProfileError(null);
          setProfileErrorKind(null);
          return verifiedProfile;
        }
        loadedUserIdRef.current = null;
        profileRef.current = null;
        profileErrorRef.current = res.error ?? 'Unable to load your employee profile.';
        setProfile(null);
        setProfileError(res.error ?? 'Unable to load your employee profile.');
        setProfileErrorKind(res.errorKind ?? 'database');
        return null;
      })();

      inFlightProfileRef.current = { userId, promise };

      try {
        return await promise;
      } finally {
        if (inFlightProfileRef.current?.promise === promise) {
          inFlightProfileRef.current = null;
        }
        setProfileLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    const client = supabase;
    if (!client) {
      setAuthLoading(false);
      return;
    }

    let isMounted = true;
    const isDev = Boolean(typeof import.meta !== 'undefined' && import.meta.env?.DEV);

    // Subscribe BEFORE initSession so PASSWORD_RECOVERY events emitted during SDK init are never missed.
    // Never run Supabase DB queries synchronously inside onAuthStateChange (prevents Web Lock deadlock during updateUser).
    const { data: listener } = client.auth.onAuthStateChange((event, nextSession) => {
      if (!isMounted) return;

      if (event === 'PASSWORD_RECOVERY') {
        isRecoveryModeRef.current = true;
        setIsRecoveryMode(true);
        setRecoveryError(null);
        if (nextSession) {
          hadActiveSessionRef.current = true;
          setSession(nextSession);
          setUser(nextSession.user);
          clearAuthUrlParams();
        }
        return;
      }

      if (event === 'SIGNED_OUT') {
        const wasLoggedIn = hadActiveSessionRef.current;
        const wasManual = manualSignOutRef.current;
        manualSignOutRef.current = false;
        hadActiveSessionRef.current = false;
        isRecoveryModeRef.current = false;
        loadedUserIdRef.current = null;
        inFlightProfileRef.current = null;
        setSession(null);
        setUser(null);
        setProfile(null);
        setProfileError(null);
        setProfileErrorKind(null);
        setProfileLoading(false);
        setIsRecoveryMode(false);
        setEmailVerified(false);
        if (wasLoggedIn && !wasManual) {
          setSessionNotice('Your session has expired. Please sign in again.');
        }
        return;
      }

      if (event === 'USER_UPDATED') {
        if (nextSession) {
          setSession(nextSession);
          setUser(nextSession.user);
        }
        // Do not trigger profile queries during password recovery update
        if (isRecoveryModeRef.current) {
          return;
        }
        if (nextSession?.user && loadedUserIdRef.current !== nextSession.user.id) {
          const uid = nextSession.user.id;
          setProfileLoading(true);
          window.setTimeout(() => {
            if (isMounted) void loadProfileForUser(uid);
          }, 0);
        }
        return;
      }

      if (nextSession && isSessionExpired(nextSession) && !isRecoveryModeRef.current) {
        hadActiveSessionRef.current = false;
        loadedUserIdRef.current = null;
        setSession(null);
        setUser(null);
        setProfile(null);
        setProfileError(null);
        setProfileErrorKind(null);
        setProfileLoading(false);
        setSessionNotice('Your session has expired. Please sign in again.');
        return;
      }

      setSession(nextSession);
      setUser(nextSession?.user ?? null);

      if (nextSession?.user) {
        hadActiveSessionRef.current = true;
        // Let initSession() handle INITIAL_SESSION so it never races or leaves profileLoading stuck.
        if (event === 'INITIAL_SESSION') {
          return;
        }
        // Skip profile fetch during password recovery.
        const shouldReloadProfile =
          !isRecoveryModeRef.current &&
          (loadedUserIdRef.current !== nextSession.user.id ||
            (event === 'TOKEN_REFRESHED' && Boolean(profileErrorRef.current)));
        if (shouldReloadProfile) {
          // When handleSignIn is actively running, let handleSignIn complete its authoritative profile query
          if (!signingInRef.current) {
            setProfileLoading(true);
            const uid = nextSession.user.id;
            const forceReload = event === 'TOKEN_REFRESHED';
            const meta = nextSession.user.user_metadata as Record<string, unknown> | undefined;
            const shouldEnsure = Boolean(
              (typeof meta?.full_name === 'string' && meta.full_name.trim()) ||
                (typeof meta?.employee_id === 'string' && meta.employee_id.trim()) ||
                (typeof meta?.username === 'string' && meta.username.trim())
            );
            window.setTimeout(() => {
              if (isMounted) void loadProfileForUser(uid, forceReload, shouldEnsure);
            }, 0);
          }
        }
      } else if (!isRecoveryModeRef.current) {
        loadedUserIdRef.current = null;
        setProfile(null);
        setProfileError(null);
        setProfileErrorKind(null);
        setProfileLoading(false);
      }
    });

    const initSession = async () => {
      try {
        const urlSearch = typeof window !== 'undefined' ? window.location.search : '';
        const urlHash = typeof window !== 'undefined' ? window.location.hash : '';
        const urlPath = typeof window !== 'undefined' ? window.location.pathname : '';
        const lookedLikeRecoveryUrl = isRecoveryUrl(urlSearch, urlHash, urlPath);
        const lookedLikeEmailConfirmation = isEmailConfirmationUrl(urlSearch, urlHash, urlPath);

        const urlError = parseAuthErrorFromUrl(
          urlSearch,
          urlHash,
          lookedLikeEmailConfirmation ? 'confirmation' : 'recovery'
        );
        if (urlError) {
          if (isMounted) {
            if (lookedLikeEmailConfirmation) {
              setSessionNotice(urlError);
            } else {
              setRecoveryError(urlError);
              isRecoveryModeRef.current = false;
              setIsRecoveryMode(false);
            }
          }
          clearAuthUrlParams();
          return;
        }

        // Handle token_hash recovery links (e.g. /reset-password?token_hash=...&type=recovery)
        const tokenHash = parseRecoveryTokenHash(urlSearch);
        if (tokenHash && !recoveryExchangeAttemptedRef.current) {
          recoveryExchangeAttemptedRef.current = true;
          const { data: otpData, error: otpError } = await withTimeout(
            client.auth.verifyOtp({
              token_hash: tokenHash,
              type: 'recovery',
            }),
            AUTH_TIMEOUT_MS,
            'Recovery verification'
          );
          if (!isMounted) return;
          if (otpError) {
            if (isDev) {
              console.error('[Auth] Recovery verifyOtp failed:', otpError);
            }
            setRecoveryError(
              'This password reset link is invalid or has expired. Please request a new recovery link.'
            );
            isRecoveryModeRef.current = false;
            setIsRecoveryMode(false);
            clearAuthUrlParams();
            return;
          } else if (otpData.session) {
            isRecoveryModeRef.current = true;
            setIsRecoveryMode(true);
            setRecoveryError(null);
            setSession(otpData.session);
            setUser(otpData.session.user);
            hadActiveSessionRef.current = true;
            clearAuthUrlParams();
            return;
          }
        }

        // Handle token_hash email confirmation links (e.g. /pending-approval?token_hash=...&type=signup)
        const confirmOtp = parseEmailConfirmationTokenHash(urlSearch);
        if (confirmOtp && !emailConfirmationAttemptedRef.current) {
          emailConfirmationAttemptedRef.current = true;
          const { data: otpData, error: otpError } = await withTimeout(
            client.auth.verifyOtp({
              token_hash: confirmOtp.tokenHash,
              type: confirmOtp.type,
            }),
            AUTH_TIMEOUT_MS,
            'Email verification'
          );
          if (!isMounted) return;
          if (otpError) {
            console.error('[Auth] Email confirmation verifyOtp failed:', {
              errorCategory: 'auth',
              httpStatus: (otpError as { status?: number }).status ?? null,
              hasSession: false,
              message: otpError.message,
            });
            setSessionNotice(
              'This email verification link is invalid or has expired. Please sign in to check your approval status or register again.'
            );
            clearAuthUrlParams();
            return;
          }
          setEmailVerified(true);
          clearAuthUrlParams();
          if (otpData.session?.user) {
            hadActiveSessionRef.current = true;
            setSession(otpData.session);
            setUser(otpData.session.user);
            await loadProfileForUser(otpData.session.user.id, true, true);
          }
          return;
        }

        const { data, error } = await withTimeout(
          client.auth.getSession(),
          AUTH_TIMEOUT_MS,
          'Session restoration'
        );
        if (!isMounted) return;

        let currentSession = data.session;

        // Handle PKCE recovery callback (/reset-password?code=...) if not already exchanged by detectSessionInUrl
        const recoveryCode = parseRecoveryCode(urlPath, urlSearch);
        if (!currentSession && recoveryCode && !recoveryExchangeAttemptedRef.current) {
          recoveryExchangeAttemptedRef.current = true;
          const { data: exchangeData, error: exchangeError } = await withTimeout(
            client.auth.exchangeCodeForSession(recoveryCode),
            AUTH_TIMEOUT_MS,
            'Recovery code exchange'
          );
          if (!isMounted) return;
          if (exchangeError) {
            if (isDev) {
              console.error('[Auth] Recovery exchangeCodeForSession failed:', exchangeError);
            }
            setRecoveryError(
              'This password reset link is invalid or has expired. Please request a new recovery link.'
            );
            isRecoveryModeRef.current = false;
            setIsRecoveryMode(false);
            clearAuthUrlParams();
            return;
          } else if (exchangeData.session) {
            currentSession = exchangeData.session;
            isRecoveryModeRef.current = true;
            setIsRecoveryMode(true);
            setRecoveryError(null);
            clearAuthUrlParams();
          }
        }

        // Handle PKCE email confirmation callback (?code=...) if not already exchanged by detectSessionInUrl
        const confirmationCode = parseAuthCallbackCode(urlPath, urlSearch);
        if (
          !currentSession &&
          !lookedLikeRecoveryUrl &&
          confirmationCode &&
          !emailConfirmationAttemptedRef.current
        ) {
          emailConfirmationAttemptedRef.current = true;
          const { data: exchangeData, error: exchangeError } = await withTimeout(
            client.auth.exchangeCodeForSession(confirmationCode),
            AUTH_TIMEOUT_MS,
            'Email confirmation'
          );
          if (!isMounted) return;
          if (exchangeError) {
            console.error('[Auth] Email confirmation code exchange failed:', {
              errorCategory: 'auth',
              httpStatus: (exchangeError as { status?: number }).status ?? null,
              hasSession: false,
              message: exchangeError.message,
            });
            setSessionNotice(
              'This email verification link is invalid or has expired. Please sign in to check your approval status.'
            );
            clearAuthUrlParams();
            return;
          }
          setEmailVerified(true);
          if (exchangeData.session) {
            currentSession = exchangeData.session;
          }
          clearAuthUrlParams();
        } else if (lookedLikeEmailConfirmation && !lookedLikeRecoveryUrl) {
          // detectSessionInUrl already consumed the confirmation hash/code before getSession() resolved
          setEmailVerified(true);
          clearAuthUrlParams();
        }

        if (error && !currentSession) {
          console.error('[Auth] getSession failed during init:', {
            errorCategory: 'auth',
            httpStatus: (error as { status?: number }).status ?? null,
            hasSession: false,
            message: error.message,
          });
          if (lookedLikeRecoveryUrl || isRecoveryModeRef.current) {
            isRecoveryModeRef.current = false;
            setIsRecoveryMode(false);
            setRecoveryError(
              'Your password recovery session could not be verified. Please request a new reset link.'
            );
          } else {
            setSession(null);
            setUser(null);
            setProfile(null);
            setAuthError(`Unable to verify your authentication session: ${error.message}`);
            setAuthErrorKind('auth');
            setSessionNotice('Your session could not be verified. Please sign in again.');
          }
          return;
        }

        // Never destroy an active password recovery session during initialization.
        // For expired regular sessions, attempt a bounded token refresh before signing out.
        if (
          currentSession &&
          isSessionExpired(currentSession) &&
          !isRecoveryModeRef.current &&
          !lookedLikeRecoveryUrl
        ) {
          const { data: refreshData, error: refreshError } = await withTimeout(
            client.auth.refreshSession(),
            AUTH_TIMEOUT_MS,
            'Session refresh'
          );
          if (!isMounted) return;
          if (!refreshError && refreshData?.session?.access_token) {
            currentSession = refreshData.session;
          } else {
            console.warn('[Auth] Restored session expired and refresh failed:', {
              errorCategory: 'auth',
              httpStatus: (refreshError as { status?: number } | null)?.status ?? null,
              hasSession: true,
              hasAccessToken: false,
              userId: currentSession.user?.id ?? null,
              errorMessage: refreshError?.message ?? 'No refreshed session returned',
            });
            manualSignOutRef.current = true;
            try {
              await withTimeout(client.auth.signOut(), 5_000, 'Sign out');
            } catch {
              // Ignore signOut timeout on already-expired session
            }
            if (!isMounted) return;
            setSession(null);
            setUser(null);
            setProfile(null);
            setProfileError(null);
            setProfileErrorKind(null);
            setSessionNotice('Your session has expired. Please sign in again.');
            return;
          }
        }

        if (isDev) {
          console.info('[Auth] Session initialization complete:', {
            hasSession: Boolean(currentSession),
            hasAccessToken: Boolean(currentSession?.access_token),
            userId: currentSession?.user?.id ?? null,
            isRecovery: lookedLikeRecoveryUrl || isRecoveryModeRef.current,
          });
        }

        setAuthError(null);
        setAuthErrorKind(null);
        setSession(currentSession);
        setUser(currentSession?.user ?? null);

        if (currentSession?.user) {
          hadActiveSessionRef.current = true;
          if (lookedLikeRecoveryUrl || isRecoveryModeRef.current) {
            isRecoveryModeRef.current = true;
            setIsRecoveryMode(true);
            setRecoveryError(null);
            clearAuthUrlParams();
          } else {
            const meta = currentSession.user.user_metadata as Record<string, unknown> | undefined;
            const shouldEnsureProfile =
              lookedLikeEmailConfirmation ||
              Boolean(
                (typeof meta?.full_name === 'string' && meta.full_name.trim()) ||
                  (typeof meta?.employee_id === 'string' && meta.employee_id.trim()) ||
                  (typeof meta?.username === 'string' && meta.username.trim())
              );
            await loadProfileForUser(currentSession.user.id, false, shouldEnsureProfile);
          }
        } else {
          loadedUserIdRef.current = null;
          setProfile(null);
          if (isRecoveryModeRef.current || lookedLikeRecoveryUrl) {
            isRecoveryModeRef.current = false;
            setIsRecoveryMode(false);
            if (lookedLikeRecoveryUrl) {
              setRecoveryError(
                'This password reset link is invalid or has expired. Please request a new recovery link.'
              );
              clearAuthUrlParams();
            }
          }
        }
      } catch (err) {
        if (!isMounted) return;
        const isTimeout = err instanceof AuthTimeoutError;
        console.error('[Auth] Session initialization failed:', {
          errorCategory: isTimeout ? 'timeout' : 'network',
          httpStatus: null,
          hasSession: false,
          message: err instanceof Error ? err.message : 'Unknown error',
        });
        setAuthError(
          isTimeout
            ? 'Timed out while restoring your authentication session. Please retry or sign in again.'
            : 'Unable to restore your authentication session. Check your connection and retry.'
        );
        setAuthErrorKind('network');
      } finally {
        if (isMounted) {
          setAuthLoading(false);
          setProfileLoading(false);
        }
      }
    };

    void initSession();

    return () => {
      isMounted = false;
      listener.subscription.unsubscribe();
    };
  }, [loadProfileForUser]);

  const handleSignIn = useCallback(
    async (email: string, password: string): Promise<AuthActionResult<LoginResult>> => {
      setSessionNotice(null);
      setRecoveryError(null);
      setEmailVerified(false);
      setAuthError(null);
      setAuthErrorKind(null);
      setProfileError(null);
      setProfileErrorKind(null);
      signingInRef.current = true;
      setProfileLoading(true);
      try {
        const res = await signInWithEmail(email, password);
        if (res.ok && res.data) {
          hadActiveSessionRef.current = true;
          isRecoveryModeRef.current = false;
          setIsRecoveryMode(false);
          setSession(res.data.session);
          setUser(res.data.user);
          if (res.data.profileError) {
            loadedUserIdRef.current = null;
            profileRef.current = null;
            profileErrorRef.current = res.data.profileError;
            setProfile(null);
            setProfileError(res.data.profileError);
            setProfileErrorKind(res.data.profileErrorKind ?? 'database');
          } else {
            loadedUserIdRef.current = res.data.user.id;
            profileRef.current = res.data.profile;
            profileErrorRef.current = null;
            setProfile(res.data.profile);
            setProfileError(null);
            setProfileErrorKind(null);
          }
        }
        return res;
      } finally {
        signingInRef.current = false;
        setProfileLoading(false);
      }
    },
    []
  );

  const handleRegister = useCallback(
    async (input: EmployeeRegistrationInput): Promise<AuthActionResult<RegisterResult>> => {
      setSessionNotice(null);
      const res = await registerEmployee(input);
      if (res.ok && res.data) {
        if (res.data.session && res.data.user) {
          hadActiveSessionRef.current = true;
          setSession(res.data.session);
          setUser(res.data.user);
          loadedUserIdRef.current = res.data.user.id;
          setProfile(res.data.profile);
          setProfileError(null);
          setProfileErrorKind(null);
        }
      }
      return res;
    },
    []
  );

  const handleSignOut = useCallback(async () => {
    manualSignOutRef.current = true;
    hadActiveSessionRef.current = false;
    isRecoveryModeRef.current = false;
    loadedUserIdRef.current = null;
    inFlightProfileRef.current = null;
    await signOutUser();
    setSession(null);
    setUser(null);
    setProfile(null);
    setAuthError(null);
    setAuthErrorKind(null);
    setProfileError(null);
    setProfileErrorKind(null);
    setProfileLoading(false);
    setIsRecoveryMode(false);
    setRecoveryError(null);
    setEmailVerified(false);
    setSessionNotice(null);
  }, []);

  const handleRefreshProfile = useCallback(async (): Promise<EmployeeProfile | null> => {
    if (!user) return null;
    const meta = user.user_metadata as Record<string, unknown> | undefined;
    const shouldEnsure =
      emailVerified ||
      Boolean(
        (typeof meta?.full_name === 'string' && meta.full_name.trim()) ||
          (typeof meta?.employee_id === 'string' && meta.employee_id.trim()) ||
          (typeof meta?.username === 'string' && meta.username.trim())
      );
    return loadProfileForUser(user.id, true, shouldEnsure);
  }, [user, emailVerified, loadProfileForUser]);

  /**
   * Re-verifies the authenticated user's profile directly against Supabase with a bounded
   * timeout and updates context state WITHOUT flipping global `profileLoading`, so route
   * guards like AdminRouteGuard can perform entry checks without triggering an unmount loop.
   */
  const handleVerifyProfile = useCallback(async (): Promise<
    AuthActionResult<EmployeeProfile | null>
  > => {
    if (!user) {
      return {
        ok: false,
        error: 'Your authentication session is missing or expired. Please sign in again.',
        errorKind: 'auth',
      };
    }

    const res = await fetchEmployeeProfile(user.id);
    if (res.ok) {
      const verifiedProfile =
        res.data && res.data.auth_user_id === user.id ? res.data : null;
      loadedUserIdRef.current = user.id;
      profileRef.current = verifiedProfile;
      profileErrorRef.current = null;
      setProfile(verifiedProfile);
      setProfileError(null);
      setProfileErrorKind(null);
      return { ...res, data: verifiedProfile };
    }

    loadedUserIdRef.current = null;
    profileRef.current = null;
    profileErrorRef.current = res.error ?? 'Unable to verify your employee profile.';
    setProfile(null);
    setProfileError(res.error ?? 'Unable to verify your employee profile.');
    setProfileErrorKind(res.errorKind ?? 'database');
    return res;
  }, [user]);

  /**
   * Securely provisions or recovers the authenticated user's own EMPLOYEE + PENDING
   * profile via the server-side SECURITY DEFINER RPC `ensure_own_employee_profile(...)`.
   * Never modifies existing profiles (including Super Admin) and never performs a direct table INSERT.
   */
  const handleRecoverProfile = useCallback(
    async (
      input?: ProfileRecoveryInput
    ): Promise<AuthActionResult<EmployeeProfile | null>> => {
      if (!user) {
        return {
          ok: false,
          error: 'Your authentication session is missing or expired. Please sign in again.',
          errorKind: 'auth',
        };
      }

      const res = await ensureOwnEmployeeProfile(undefined, AUTH_TIMEOUT_MS, input);
      if (res.ok && res.data && res.data.auth_user_id === user.id) {
        loadedUserIdRef.current = user.id;
        profileRef.current = res.data;
        profileErrorRef.current = null;
        setProfile(res.data);
        setProfileError(null);
        setProfileErrorKind(null);
        return res;
      }

      if (res.ok && res.rpcUnavailable) {
        return {
          ok: false,
          rpcUnavailable: true,
          error:
            'Automatic profile recovery RPC (ensure_own_employee_profile) is not installed in Supabase yet. Apply migration 003_employee_registration_and_approval.sql in Supabase SQL Editor and retry.',
          errorKind: 'database',
        };
      }

      return res;
    },
    [user]
  );

  const handleSendPasswordReset = useCallback(async (email: string) => {
    return requestPasswordReset(email);
  }, []);

  const handleResetPassword = useCallback(
    async (password: string, confirmPassword: string): Promise<AuthActionResult> => {
      try {
        const res = await updateUserPassword(password, confirmPassword);
        if (res.ok) {
          clearAuthUrlParams();
        }
        return res;
      } catch (err) {
        if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
          console.error('[Auth] handleResetPassword threw unexpectedly:', err);
        }
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Unable to update your password. Please try again.',
        };
      }
    },
    []
  );

  const handleCompletePasswordReset = useCallback(async () => {
    manualSignOutRef.current = true;
    hadActiveSessionRef.current = false;
    isRecoveryModeRef.current = false;
    loadedUserIdRef.current = null;
    inFlightProfileRef.current = null;
    try {
      await signOutUser();
    } catch (err) {
      if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
        console.error('[Auth] Error clearing temporary recovery session:', err);
      }
    }
    setSession(null);
    setUser(null);
    setProfile(null);
    setProfileError(null);
    setProfileErrorKind(null);
    setIsRecoveryMode(false);
    setRecoveryError(null);
    setSessionNotice(null);
  }, []);

  const handleClearSessionNotice = useCallback(() => {
    setSessionNotice(null);
  }, []);

  const handleClearRecoveryError = useCallback(() => {
    setRecoveryError(null);
  }, []);

  const handleClearEmailVerified = useCallback(() => {
    setEmailVerified(false);
  }, []);

  const handleExitRecoveryMode = useCallback(() => {
    isRecoveryModeRef.current = false;
    setIsRecoveryMode(false);
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const isAuthenticated = Boolean(session && user && session.user?.id === user.id);
    const isBusy = authLoading || profileLoading;
    const verifiedUserId = isAuthenticated ? user!.id : null;
    return {
      isConfigured: isSupabaseConfigured,
      session,
      user,
      profile,
      authLoading,
      profileLoading,
      authError,
      authErrorKind,
      profileError,
      profileErrorKind,
      isRecoveryMode,
      recoveryError,
      emailVerified,
      sessionNotice,
      isAuthenticated,
      isApproved: isAuthenticated && !isBusy && isApprovedUser(profile, verifiedUserId),
      isAdmin: isAuthenticated && !isBusy && isApprovedAdmin(profile, verifiedUserId),
      signIn: handleSignIn,
      register: handleRegister,
      signOut: handleSignOut,
      refreshProfile: handleRefreshProfile,
      verifyProfile: handleVerifyProfile,
      recoverProfile: handleRecoverProfile,
      sendPasswordReset: handleSendPasswordReset,
      resetPassword: handleResetPassword,
      completePasswordReset: handleCompletePasswordReset,
      clearSessionNotice: handleClearSessionNotice,
      clearRecoveryError: handleClearRecoveryError,
      clearEmailVerified: handleClearEmailVerified,
      exitRecoveryMode: handleExitRecoveryMode,
    };
  }, [
      session,
      user,
      profile,
      authLoading,
      profileLoading,
      authError,
      authErrorKind,
      profileError,
      profileErrorKind,
      isRecoveryMode,
      recoveryError,
      emailVerified,
      sessionNotice,
      handleSignIn,
      handleRegister,
      handleSignOut,
      handleRefreshProfile,
      handleVerifyProfile,
      handleRecoverProfile,
      handleSendPasswordReset,
      handleResetPassword,
      handleCompletePasswordReset,
      handleClearSessionNotice,
      handleClearRecoveryError,
      handleClearEmailVerified,
      handleExitRecoveryMode,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
