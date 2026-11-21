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
import { isRecoveryUrl } from '../utils/router';

interface AuthContextValue {
  isConfigured: boolean;
  session: Session | null;
  user: User | null;
  profile: EmployeeProfile | null;
  authLoading: boolean;
  profileLoading: boolean;
  profileError: string | null;
  isRecoveryMode: boolean;
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
      ? isRecoveryUrl(window.location.search, window.location.hash)
      : false
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

  profileRef.current = profile;
  profileErrorRef.current = profileError;

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
        const { data, error } = await client.auth.getSession();
        if (!isMounted) return;

        if (error) {
          setSession(null);
          setUser(null);
          setProfile(null);
          setSessionNotice('Your session could not be verified. Please sign in again.');
          return;
        }

        const currentSession = data.session;
        if (currentSession && isSessionExpired(currentSession)) {
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
          await loadProfileForUser(currentSession.user.id);
        } else {
          loadedUserIdRef.current = null;
          setProfile(null);
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
        setIsRecoveryMode(true);
      }

      if (event === 'SIGNED_OUT') {
        const wasLoggedIn = hadActiveSessionRef.current;
        const wasManual = manualSignOutRef.current;
        manualSignOutRef.current = false;
        hadActiveSessionRef.current = false;
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

      if (nextSession && isSessionExpired(nextSession)) {
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
      } else {
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
      const res = await signInWithEmail(email, password);
      if (res.ok && res.data) {
        hadActiveSessionRef.current = true;
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
    loadedUserIdRef.current = null;
    inFlightProfileRef.current = null;
    await signOutUser();
    setSession(null);
    setUser(null);
    setProfile(null);
    setProfileError(null);
    setIsRecoveryMode(false);
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
        setIsRecoveryMode(false);
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
      exitRecoveryMode: () => setIsRecoveryMode(false),
    }),
    [
      session,
      user,
      profile,
      authLoading,
      profileLoading,
      profileError,
      isRecoveryMode,
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
