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
  AuthActionResult,
  fetchEmployeeProfile,
  LoginResult,
  registerEmployee,
  RegisterResult,
  requestPasswordReset,
  signInWithEmail,
  signOutUser,
  updateUserPassword,
} from '../services/authService';
import { EmployeeProfile, EmployeeRegistrationInput } from '../types/auth';
import { isApprovedAdmin, isApprovedUser } from '../utils/authValidation';
import {
  clearAuthUrlParams,
  isRecoveryUrl,
  parseAuthErrorFromUrl,
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
  profileError: string | null;
  isRecoveryMode: boolean;
  recoveryError: string | null;
  sessionNotice: string | null;
  isAuthenticated: boolean;
  isApproved: boolean;
  isAdmin: boolean;
  signIn: (email: string, password: string) => Promise<AuthActionResult<LoginResult>>;
  register: (input: EmployeeRegistrationInput) => Promise<AuthActionResult<RegisterResult>>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<EmployeeProfile | null>;
  sendPasswordReset: (email: string) => Promise<AuthActionResult>;
  resetPassword: (password: string, confirmPassword: string) => Promise<AuthActionResult>;
  clearSessionNotice: () => void;
  clearRecoveryError: () => void;
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
  const [profileError, setProfileError] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [isRecoveryMode, setIsRecoveryMode] = useState<boolean>(() =>
    typeof window !== 'undefined'
      ? isRecoveryUrl(
          window.location.search,
          window.location.hash,
          window.location.pathname
        )
      : false
  );
  const [recoveryError, setRecoveryError] = useState<string | null>(() =>
    typeof window !== 'undefined'
      ? parseAuthErrorFromUrl(window.location.search, window.location.hash)
      : null
  );

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
  const isRecoveryModeRef = useRef<boolean>(isRecoveryMode);
  const recoveryExchangeAttemptedRef = useRef<boolean>(false);

  profileRef.current = profile;
  profileErrorRef.current = profileError;
  isRecoveryModeRef.current = isRecoveryMode;

  const loadProfileForUser = useCallback(
    async (userId: string, force = false): Promise<EmployeeProfile | null> => {
      if (!force && loadedUserIdRef.current === userId && !profileErrorRef.current) {
        return profileRef.current;
      }

      if (inFlightProfileRef.current && inFlightProfileRef.current.userId === userId) {
        return inFlightProfileRef.current.promise;
      }

      setProfileLoading(true);
      setProfileError(null);

      const promise = (async () => {
        const res = await fetchEmployeeProfile(userId);
        if (res.ok) {
          loadedUserIdRef.current = userId;
          profileRef.current = res.data ?? null;
          profileErrorRef.current = null;
          setProfile(res.data ?? null);
          setProfileError(null);
          return res.data ?? null;
        }
        profileRef.current = null;
        profileErrorRef.current = res.error ?? 'Unable to load your employee profile.';
        setProfile(null);
        setProfileError(res.error ?? 'Unable to load your employee profile.');
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

    const initSession = async () => {
      try {
        const urlSearch = typeof window !== 'undefined' ? window.location.search : '';
        const urlHash = typeof window !== 'undefined' ? window.location.hash : '';
        const urlPath = typeof window !== 'undefined' ? window.location.pathname : '';

        const urlError = parseAuthErrorFromUrl(urlSearch, urlHash);
        if (urlError) {
          if (isMounted) {
            setRecoveryError(urlError);
            isRecoveryModeRef.current = false;
            setIsRecoveryMode(false);
          }
          clearAuthUrlParams();
        }

        // Handle token_hash recovery links (e.g. /reset-password?token_hash=...&type=recovery)
        const tokenHash = parseRecoveryTokenHash(urlSearch);
        if (tokenHash && !recoveryExchangeAttemptedRef.current) {
          recoveryExchangeAttemptedRef.current = true;
          const { data: otpData, error: otpError } = await client.auth.verifyOtp({
            token_hash: tokenHash,
            type: 'recovery',
          });
          if (!isMounted) return;
          if (otpError) {
            setRecoveryError(
              'This password reset link is invalid or has expired. Please request a new recovery link.'
            );
            isRecoveryModeRef.current = false;
            setIsRecoveryMode(false);
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

        const { data, error } = await client.auth.getSession();
        if (!isMounted) return;

        let currentSession = data.session;

        // Handle PKCE recovery callback (/reset-password?code=...) if not yet exchanged
        const recoveryCode = parseRecoveryCode(urlPath, urlSearch);
        if (!currentSession && recoveryCode && !recoveryExchangeAttemptedRef.current) {
          recoveryExchangeAttemptedRef.current = true;
          const { data: exchangeData, error: exchangeError } =
            await client.auth.exchangeCodeForSession(recoveryCode);
          if (!isMounted) return;
          if (exchangeError) {
            setRecoveryError(
              'This password reset link is invalid or has expired. Please request a new recovery link.'
            );
            isRecoveryModeRef.current = false;
            setIsRecoveryMode(false);
          } else if (exchangeData.session) {
            currentSession = exchangeData.session;
            isRecoveryModeRef.current = true;
            setIsRecoveryMode(true);
            setRecoveryError(null);
            clearAuthUrlParams();
          }
        }

        if (error && !currentSession) {
          if (!isRecoveryModeRef.current) {
            setSession(null);
            setUser(null);
            setProfile(null);
            setSessionNotice('Your session could not be verified. Please sign in again.');
          }
          return;
        }

        // Never destroy an active password recovery session during initialization
        if (currentSession && isSessionExpired(currentSession) && !isRecoveryModeRef.current) {
          await client.auth.signOut();
          if (!isMounted) return;
          setSession(null);
          setUser(null);
          setProfile(null);
          setSessionNotice('Your session has expired. Please sign in again.');
          return;
        }

        setSession(currentSession);
        setUser(currentSession?.user ?? null);

        if (currentSession?.user) {
          hadActiveSessionRef.current = true;
          if (isRecoveryUrl(urlSearch, urlHash, urlPath)) {
            isRecoveryModeRef.current = true;
            setIsRecoveryMode(true);
            setRecoveryError(null);
            clearAuthUrlParams();
          }
          await loadProfileForUser(currentSession.user.id);
        } else {
          loadedUserIdRef.current = null;
          setProfile(null);
          // If the URL looked like a recovery link but produced no session, clear stale flag
          if (isRecoveryModeRef.current && !isRecoveryUrl(urlSearch, urlHash, urlPath)) {
            isRecoveryModeRef.current = false;
            setIsRecoveryMode(false);
          }
        }
      } finally {
        if (isMounted) {
          setAuthLoading(false);
        }
      }
    };

    void initSession();

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
        setIsRecoveryMode(false);
        if (wasLoggedIn && !wasManual) {
          setSessionNotice('Your session has expired. Please sign in again.');
        }
        return;
      }

      if (nextSession && isSessionExpired(nextSession) && !isRecoveryModeRef.current) {
        hadActiveSessionRef.current = false;
        loadedUserIdRef.current = null;
        setSession(null);
        setUser(null);
        setProfile(null);
        setSessionNotice('Your session has expired. Please sign in again.');
        return;
      }

      setSession(nextSession);
      setUser(nextSession?.user ?? null);

      if (nextSession?.user) {
        hadActiveSessionRef.current = true;
        // Deduplicated load: skips if already loaded for this user ID
        if (loadedUserIdRef.current !== nextSession.user.id) {
          void loadProfileForUser(nextSession.user.id);
        }
      } else if (!isRecoveryModeRef.current) {
        loadedUserIdRef.current = null;
        setProfile(null);
      }
    });

    return () => {
      isMounted = false;
      listener.subscription.unsubscribe();
    };
  }, [loadProfileForUser]);

  const handleSignIn = useCallback(
    async (email: string, password: string): Promise<AuthActionResult<LoginResult>> => {
      setSessionNotice(null);
      setRecoveryError(null);
      const res = await signInWithEmail(email, password);
      if (res.ok && res.data) {
        hadActiveSessionRef.current = true;
        isRecoveryModeRef.current = false;
        setIsRecoveryMode(false);
        setSession(res.data.session);
        setUser(res.data.user);
        loadedUserIdRef.current = res.data.user.id;
        setProfile(res.data.profile);
        setProfileError(null);
      }
      return res;
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
    setProfileError(null);
    setIsRecoveryMode(false);
    setRecoveryError(null);
    setSessionNotice(null);
  }, []);

  const handleRefreshProfile = useCallback(async (): Promise<EmployeeProfile | null> => {
    if (!user) return null;
    return loadProfileForUser(user.id, true);
  }, [user, loadProfileForUser]);

  const handleSendPasswordReset = useCallback(async (email: string) => {
    return requestPasswordReset(email);
  }, []);

  const handleResetPassword = useCallback(
    async (password: string, confirmPassword: string) => {
      const res = await updateUserPassword(password, confirmPassword);
      if (res.ok) {
        clearAuthUrlParams();
        // End the temporary recovery session cleanly so the user can sign in fresh on /login
        manualSignOutRef.current = true;
        hadActiveSessionRef.current = false;
        isRecoveryModeRef.current = false;
        loadedUserIdRef.current = null;
        inFlightProfileRef.current = null;
        await signOutUser();
        setSession(null);
        setUser(null);
        setProfile(null);
        setProfileError(null);
        setIsRecoveryMode(false);
        setRecoveryError(null);
        setSessionNotice(null);
      }
      return res;
    },
    []
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      isConfigured: isSupabaseConfigured,
      session,
      user,
      profile,
      authLoading,
      profileLoading,
      profileError,
      isRecoveryMode,
      recoveryError,
      sessionNotice,
      isAuthenticated: Boolean(session && user),
      isApproved: isApprovedUser(profile),
      isAdmin: isApprovedAdmin(profile),
      signIn: handleSignIn,
      register: handleRegister,
      signOut: handleSignOut,
      refreshProfile: handleRefreshProfile,
      sendPasswordReset: handleSendPasswordReset,
      resetPassword: handleResetPassword,
      clearSessionNotice: () => setSessionNotice(null),
      clearRecoveryError: () => setRecoveryError(null),
      exitRecoveryMode: () => {
        isRecoveryModeRef.current = false;
        setIsRecoveryMode(false);
      },
    }),
    [
      session,
      user,
      profile,
      authLoading,
      profileLoading,
      profileError,
      isRecoveryMode,
      recoveryError,
      sessionNotice,
      handleSignIn,
      handleRegister,
      handleSignOut,
      handleRefreshProfile,
      handleSendPasswordReset,
      handleResetPassword,
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
