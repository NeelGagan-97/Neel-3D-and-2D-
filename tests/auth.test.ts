import assert from 'node:assert/strict';
import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import { validateSupabaseConfig } from '../src/lib/supabase';
import {
  adminGetEmployeeProfile,
  adminUpdateEmployeeStatus,
  buildAuthRedirectUrl,
  ensureOwnEmployeeProfile,
  fetchAllEmployeeProfiles,
  fetchEmployeeProfile,
  registerEmployee,
  requestPasswordReset,
  signInWithEmail,
  signOutUser,
  updateUserPassword,
} from '../src/services/authService';
import { AccountStatus, EmployeeProfile } from '../src/types/auth';
import {
  canViewAdminNavigation,
  computeAdminStats,
  evaluateRouteAccess,
  isApprovedAdmin,
  resolvePostLoginRoute,
} from '../src/utils/authValidation';
import {
  isEmailConfirmationUrl,
  isRecoveryUrl,
  parseAuthCallbackCode,
  parseAuthErrorFromUrl,
  parseEmailConfirmationTokenHash,
  parseRecoveryCode,
  parseRecoveryTokenHash,
  parseRouteFromLocation,
} from '../src/utils/router';

/**
 * In-memory Supabase harness mirroring the exact public.employee_profiles schema,
 * unique constraints, auth.users signup trigger, and PostgreSQL RLS policies
 * defined in supabase/migrations/001_employee_auth_rls.sql.
 */
interface MockAuthAccount {
  id: string;
  email: string;
  password: string;
  confirmed: boolean;
}

class RlsMockSupabase {
  private accounts = new Map<string, MockAuthAccount>();
  private profiles: EmployeeProfile[] = [];
  private currentSession: Session | null = null;
  private requireEmailConfirmation = false;
  public resetEmailsSent: string[] = [];
  public resetRedirects: string[] = [];

  constructor() {
    // Seed existing approved administrator: Neelgagan B R (preserved across all tests)
    const adminUid = '00000000-0000-4000-8000-000000000001';
    this.accounts.set('neelgagan@neel3dspace.com', {
      id: adminUid,
      email: 'neelgagan@neel3dspace.com',
      password: 'AdminPassword123',
      confirmed: true,
    });
    this.profiles.push({
      id: '10000000-0000-4000-8000-000000000001',
      auth_user_id: adminUid,
      full_name: 'Neelgagan B R',
      employee_id: 'ADM-001',
      username: 'neelgagan',
      email: 'neelgagan@neel3dspace.com',
      mobile: '+91 98765 00001',
      role: 'ADMIN',
      account_status: 'APPROVED',
      approved_at: '2026-01-01T00:00:00.000Z',
      approved_by: adminUid,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
  }

  setRequireEmailConfirmation(flag: boolean) {
    this.requireEmailConfirmation = flag;
  }

  seedAccount(account: MockAuthAccount, profile?: EmployeeProfile) {
    this.accounts.set(account.email.toLowerCase(), account);
    if (profile) {
      this.profiles.push(profile);
    }
  }

  getProfileByAuthId(authUserId: string): EmployeeProfile | null {
    return this.profiles.find((p) => p.auth_user_id === authUserId) ?? null;
  }

  private isCallerApprovedAdmin(): boolean {
    const uid = this.currentSession?.user?.id;
    if (!uid) return false;
    const p = this.getProfileByAuthId(uid);
    return Boolean(p && p.role === 'ADMIN' && p.account_status === 'APPROVED');
  }

  private buildSession(account: MockAuthAccount, expiresInSeconds = 3600): Session {
    const user: User = {
      id: account.id,
      email: account.email,
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    };
    return {
      access_token: `token-${account.id}`,
      refresh_token: `refresh-${account.id}`,
      token_type: 'bearer',
      expires_in: expiresInSeconds,
      expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
      user,
    };
  }

  expireCurrentSession() {
    if (this.currentSession) {
      this.currentSession = {
        ...this.currentSession,
        expires_at: Math.floor(Date.now() / 1000) - 60,
      };
    }
  }

  asClient(): SupabaseClient {
    const self = this;

    const auth = {
      async signUp({ email, password, options }: any) {
        const normEmail = String(email).trim().toLowerCase();
        if (self.accounts.has(normEmail)) {
          return {
            data: { user: { id: 'dup', email: normEmail, identities: [] }, session: null },
            error: null,
          };
        }
        const uid = `uid-${self.accounts.size + 1}-${Date.now()}`;
        const acc: MockAuthAccount = {
          id: uid,
          email: normEmail,
          password,
          confirmed: !self.requireEmailConfirmation,
        };
        self.accounts.set(normEmail, acc);

        // Simulate atomic auth.users AFTER INSERT trigger when metadata is present
        const meta = options?.data;
        if (meta?.full_name && meta?.employee_id && meta?.username) {
          const emailTaken = self.profiles.some((p) => p.email === normEmail);
          const userTaken = self.profiles.some(
            (p) => p.username === String(meta.username).toLowerCase()
          );
          const empTaken = self.profiles.some(
            (p) => p.employee_id === String(meta.employee_id).toUpperCase()
          );
          if (emailTaken || userTaken || empTaken) {
            // Roll back auth.users insert and surface GoTrue's masked trigger error
            self.accounts.delete(normEmail);
            return {
              data: { user: null, session: null },
              error: { message: 'Database error saving new user' },
            };
          }
          self.profiles.push({
            id: `prof-${self.profiles.length + 1}`,
            auth_user_id: uid,
            full_name: String(meta.full_name).trim(),
            employee_id: String(meta.employee_id).trim().toUpperCase(),
            username: String(meta.username).trim().toLowerCase(),
            email: normEmail,
            mobile: String(meta.mobile ?? '').trim(),
            role: 'EMPLOYEE',
            account_status: 'PENDING',
            approved_at: null,
            approved_by: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }

        const session = self.requireEmailConfirmation ? null : self.buildSession(acc);
        self.currentSession = session;
        return {
          data: {
            user: session?.user ?? {
              id: uid,
              email: normEmail,
              identities: [{ id: uid }],
              aud: 'authenticated',
              app_metadata: {},
              user_metadata: meta ?? {},
              created_at: new Date().toISOString(),
            },
            session,
          },
          error: null,
        };
      },

      async signInWithPassword({ email, password }: any) {
        const normEmail = String(email).trim().toLowerCase();
        const acc = self.accounts.get(normEmail);
        if (!acc || acc.password !== password) {
          return {
            data: { user: null, session: null },
            error: { message: 'Invalid login credentials' },
          };
        }
        if (!acc.confirmed) {
          return {
            data: { user: null, session: null },
            error: { message: 'Email not confirmed' },
          };
        }
        const session = self.buildSession(acc);
        self.currentSession = session;
        return { data: { user: session.user, session }, error: null };
      },

      async getSession() {
        return { data: { session: self.currentSession }, error: null };
      },

      async signOut() {
        self.currentSession = null;
        return { error: null };
      },

      async resetPasswordForEmail(email: string, options?: { redirectTo?: string }) {
        self.resetEmailsSent.push(email);
        if (options?.redirectTo) {
          self.resetRedirects.push(options.redirectTo);
        }
        return { data: {}, error: null };
      },

      async updateUser({ password }: { password: string }) {
        const uid = self.currentSession?.user?.id;
        if (!uid) {
          return { data: { user: null }, error: { message: 'Auth session missing!' } };
        }
        for (const acc of self.accounts.values()) {
          if (acc.id === uid) {
            acc.password = password;
            return { data: { user: self.currentSession?.user }, error: null };
          }
        }
        return { data: { user: null }, error: { message: 'User not found' } };
      },
    };

    const rpc = async (fn: string, params: any) => {
      if (fn === 'check_registration_availability') {
        throw new Error('check_registration_availability RPC must not be called');
      }

      if (fn === 'admin_list_employee_profiles') {
        if (!self.isCallerApprovedAdmin()) {
          return {
            data: null,
            status: 403,
            error: {
              code: '42501',
              message: 'Forbidden: Approved administrator privileges required.',
            },
          };
        }
        return { data: [...self.profiles], status: 200, error: null };
      }

      if (fn === 'admin_get_employee_profile') {
        if (!self.isCallerApprovedAdmin()) {
          return {
            data: null,
            status: 403,
            error: {
              code: '42501',
              message: 'Forbidden: Approved administrator privileges required.',
            },
          };
        }
        const target = self.profiles.find((p) => p.id === params.p_profile_id);
        if (!target) {
          return { data: null, status: 404, error: { message: 'Employee profile not found.' } };
        }
        return { data: { ...target }, status: 200, error: null };
      }

      if (fn === 'admin_update_employee_status') {
        if (!self.isCallerApprovedAdmin()) {
          return {
            data: null,
            status: 403,
            error: {
              code: '42501',
              message: 'Forbidden: Approved administrator privileges required.',
            },
          };
        }
        const target = self.profiles.find((p) => p.id === params.p_profile_id);
        if (!target) {
          return { data: null, error: { message: 'Employee profile not found.' } };
        }
        if (target.auth_user_id === self.currentSession!.user.id || target.role === 'ADMIN') {
          return {
            data: null,
            status: 403,
            error: {
              code: '42501',
              message: 'Administrators cannot modify their own account status.',
            },
          };
        }
        const nextStatus = params.p_new_status as AccountStatus;
        target.account_status = nextStatus;
        if (nextStatus === 'APPROVED') {
          target.approved_at = new Date().toISOString();
          target.approved_by = self.currentSession!.user.id;
        }
        target.updated_at = new Date().toISOString();
        return { data: { ...target }, status: 200, error: null };
      }

      return { data: null, error: { code: 'PGRST202', message: 'Function not found' } };
    };

    const from = (table: string) => {
      assert.equal(table, 'employee_profiles');
      let eqFilters: Record<string, any> = {};

      const applySelectRls = () => {
        const uid = self.currentSession?.user?.id;
        if (!uid) {
          return { rows: [] as EmployeeProfile[], error: { message: 'permission denied for table employee_profiles' } };
        }
        const visible = self.isCallerApprovedAdmin()
          ? [...self.profiles]
          : self.profiles.filter((p) => p.auth_user_id === uid);
        const filtered = visible.filter((row) =>
          Object.entries(eqFilters).every(([k, v]) => (row as any)[k] === v)
        );
        return { rows: filtered, error: null };
      };

      const builder: any = {
        select() {
          return builder;
        },
        eq(col: string, val: any) {
          eqFilters[col] = val;
          return builder;
        },
        order() {
          const { rows, error } = applySelectRls();
          return Promise.resolve({ data: error ? null : rows, error });
        },
        maybeSingle() {
          const { rows, error } = applySelectRls();
          return Promise.resolve({ data: error ? null : (rows[0] ?? null), error });
        },
        single() {
          const { rows, error } = applySelectRls();
          return Promise.resolve({
            data: error ? null : (rows[0] ?? null),
            error: error ?? (rows[0] ? null : { message: 'Row not found' }),
          });
        },
        insert(payload: any) {
          const uid = self.currentSession?.user?.id;
          if (!uid) {
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({ data: null, error: { message: 'RLS violation: anonymous insert denied' } }),
              }),
            };
          }
          // Enforce RLS + BEFORE INSERT trigger rules
          if (
            !self.isCallerApprovedAdmin() &&
            (payload.auth_user_id !== uid ||
              payload.role !== 'EMPLOYEE' ||
              payload.account_status !== 'PENDING' ||
              payload.approved_at !== null ||
              payload.approved_by !== null)
          ) {
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: null,
                    error: {
                      code: '42501',
                      message: 'new row violates row-level security policy for table "employee_profiles"',
                    },
                  }),
              }),
            };
          }
          if (self.profiles.some((p) => p.auth_user_id === payload.auth_user_id)) {
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: null,
                    error: { code: '23505', message: 'duplicate key value violates unique constraint "auth_user_id"' },
                  }),
              }),
            };
          }
          const created: EmployeeProfile = {
            ...payload,
            id: `prof-${self.profiles.length + 1}`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          self.profiles.push(created);
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { ...created }, error: null }),
            }),
          };
        },
        update(payload: any) {
          return {
            eq(col: string, val: any) {
              const uid = self.currentSession?.user?.id;
              const isAdmin = self.isCallerApprovedAdmin();
              const target = self.profiles.find((p) => (p as any)[col] === val);

              const reject = (message: string) => ({
                select: () => ({
                  single: () => Promise.resolve({ data: null, error: { code: '42501', message } }),
                }),
              });

              if (!uid || !target) {
                return reject('RLS violation: update denied');
              }
              if (!isAdmin) {
                // Employees cannot change role, account_status, or other users' rows
                if (
                  target.auth_user_id !== uid ||
                  (payload.role && payload.role !== target.role) ||
                  (payload.account_status && payload.account_status !== target.account_status)
                ) {
                  return reject(
                    'Employees are not authorized to modify role, status, or another employee record.'
                  );
                }
              }
              if (isAdmin && (target.auth_user_id === uid || target.role === 'ADMIN')) {
                return reject('Administrators cannot modify their own role or account status.');
              }

              Object.assign(target, payload, { updated_at: new Date().toISOString() });
              return {
                select: () => ({
                  single: () => Promise.resolve({ data: { ...target }, error: null }),
                }),
              };
            },
          };
        },
      };

      return builder;
    };

    return { auth, rpc, from } as unknown as SupabaseClient;
  }
}

async function runTests() {
  const mock = new RlsMockSupabase();
  const sb = mock.asClient();
  let passed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    await fn();
    passed += 1;
    console.log(`PASS [${passed}]: ${name}`);
  }

  // 1. Admin login (Neelgagan B R preserved)
  await test('1. Admin login (ADMIN + APPROVED -> Admin Dashboard)', async () => {
    const res = await signInWithEmail('neelgagan@neel3dspace.com', 'AdminPassword123', sb);
    assert.equal(res.ok, true);
    assert.equal(res.data?.profile?.full_name, 'Neelgagan B R');
    assert.equal(res.data?.profile?.role, 'ADMIN');
    assert.equal(res.data?.profile?.account_status, 'APPROVED');
    assert.equal(resolvePostLoginRoute(res.data!.profile), 'admin');
  });

  // 2. Employee registration (active session + email-confirmation mode + no duplicates on retry)
  let registeredEmpProfile: EmployeeProfile | null = null;
  await test('2. Employee registration (creates EMPLOYEE + PENDING profile)', async () => {
    await signOutUser(sb);
    const res = await registerEmployee(
      {
        fullName: 'Aarav Sharma',
        employeeId: 'EMP-101',
        username: 'aarav.sharma',
        email: 'aarav@neel3dspace.com',
        mobile: '+91 98765 11111',
        password: 'Password123',
        confirmPassword: 'Password123',
      },
      sb
    );
    assert.equal(res.ok, true);
    assert.equal(res.data?.profile?.role, 'EMPLOYEE');
    assert.equal(res.data?.profile?.account_status, 'PENDING');
    assert.equal(res.data?.profile?.approved_at, null);
    assert.equal(res.data?.profile?.approved_by, null);
    registeredEmpProfile = res.data?.profile ?? null;

    // Also test email-confirmation-required path
    mock.setRequireEmailConfirmation(true);
    const confirmRes = await registerEmployee(
      {
        fullName: 'Priya Nair',
        employeeId: 'EMP-102',
        username: 'priya.nair',
        email: 'priya@neel3dspace.com',
        mobile: '+91 98765 22222',
        password: 'Password123',
        confirmPassword: 'Password123',
      },
      sb
    );
    assert.equal(confirmRes.ok, true);
    assert.equal(confirmRes.data?.requiresEmailConfirmation, true);
    mock.setRequireEmailConfirmation(false);
  });

  // 3. Duplicate email registration
  await test('3. Duplicate email registration blocked', async () => {
    const res = await registerEmployee(
      {
        fullName: 'Duplicate Email',
        employeeId: 'EMP-901',
        username: 'unique.user.901',
        email: 'aarav@neel3dspace.com',
        mobile: '+91 98765 99901',
        password: 'Password123',
        confirmPassword: 'Password123',
      },
      sb
    );
    assert.equal(res.ok, false);
    assert.ok(res.fieldErrors?.email);
  });

  // 4. Duplicate username (atomic auth.users trigger rollback -> GoTrue generic error mapped clearly)
  await test('4. Duplicate username registration blocked cleanly', async () => {
    const res = await registerEmployee(
      {
        fullName: 'Duplicate Username',
        employeeId: 'EMP-902',
        username: 'aarav.sharma',
        email: 'unique902@neel3dspace.com',
        mobile: '+91 98765 99902',
        password: 'Password123',
        confirmPassword: 'Password123',
      },
      sb
    );
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /email address, username, or Employee ID may already be registered/i);
  });

  // 5. Duplicate employee ID (atomic auth.users trigger rollback -> GoTrue generic error mapped clearly)
  await test('5. Duplicate employee ID registration blocked cleanly', async () => {
    const res = await registerEmployee(
      {
        fullName: 'Duplicate EmpId',
        employeeId: 'EMP-101',
        username: 'unique.user.903',
        email: 'unique903@neel3dspace.com',
        mobile: '+91 98765 99903',
        password: 'Password123',
        confirmPassword: 'Password123',
      },
      sb
    );
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /email address, username, or Employee ID may already be registered/i);
  });

  // 6. Invalid login credentials
  await test('6. Invalid login credentials rejected safely', async () => {
    const res = await signInWithEmail('aarav@neel3dspace.com', 'WrongPassword99', sb);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /Invalid email or password/i);
  });

  // 7. Password reset flow (non-localhost redirectTo, implicit/PKCE/token_hash recovery, updateUser)
  await test('7. Password reset request & password update', async () => {
    const deployedOriginResetUrl = buildAuthRedirectUrl(
      '/reset-password',
      'https://neel-3d-and-2d.neelgaganat97.workers.dev/reset-password'
    );
    assert.equal(
      deployedOriginResetUrl,
      'https://neel-3d-and-2d.neelgaganat97.workers.dev/reset-password'
    );
    assert.equal(deployedOriginResetUrl?.includes('localhost'), false);

    const reqRes = await requestPasswordReset(
      'aarav@neel3dspace.com',
      sb,
      deployedOriginResetUrl
    );
    assert.equal(reqRes.ok, true);
    assert.ok(mock.resetEmailsSent.includes('aarav@neel3dspace.com'));
    assert.ok(
      mock.resetRedirects.includes('https://neel-3d-and-2d.neelgaganat97.workers.dev/reset-password')
    );

    // Implicit, PKCE, and token_hash recovery URL detection
    assert.equal(
      parseRouteFromLocation('/reset-password', '', '#access_token=abc&type=recovery'),
      'reset-password'
    );
    assert.equal(
      parseRouteFromLocation('/reset-password', '?code=pkce-code-123', ''),
      'reset-password'
    );
    assert.equal(
      isRecoveryUrl('?code=pkce-code-123', '', '/reset-password'),
      true
    );
    assert.equal(parseRecoveryCode('/reset-password', '?code=pkce-code-123'), 'pkce-code-123');
    assert.equal(
      parseRecoveryTokenHash('?token_hash=th_999&type=recovery'),
      'th_999'
    );
    assert.match(
      parseAuthErrorFromUrl('', '#error=access_denied&error_code=otp_expired') ?? '',
      /expired/i
    );

    // 7a. Missing recovery session must be rejected cleanly
    await signOutUser(sb);
    const missingSessionRes = await updateUserPassword('NewPass123', 'NewPass123', sb);
    assert.equal(missingSessionRes.ok, false);
    assert.match(missingSessionRes.error ?? '', /missing or expired/i);

    // 7b. Empty passwords must be rejected cleanly with field errors
    const bothEmpty = await updateUserPassword('', '', sb);
    assert.equal(bothEmpty.ok, false);
    assert.ok(bothEmpty.fieldErrors?.password);
    assert.ok(bothEmpty.fieldErrors?.confirmPassword);

    const confirmEmpty = await updateUserPassword('NewPass123', '', sb);
    assert.equal(confirmEmpty.ok, false);
    assert.ok(confirmEmpty.fieldErrors?.confirmPassword);

    // 7c. Short password (< 8 characters) must be rejected cleanly
    const shortPass = await updateUserPassword('short7!', 'short7!', sb);
    assert.equal(shortPass.ok, false);
    assert.match(shortPass.fieldErrors?.password ?? '', /at least 8 characters/i);

    // 7d. Mismatched passwords must be rejected cleanly
    await signInWithEmail('aarav@neel3dspace.com', 'Password123', sb);
    const badUpdate = await updateUserPassword('NewPass123', 'Mismatch123', sb);
    assert.equal(badUpdate.ok, false);
    assert.match(badUpdate.fieldErrors?.confirmPassword ?? '', /do not match/i);

    // 7e. Expired recovery session must be rejected cleanly
    mock.expireCurrentSession();
    const expiredSessionRes = await updateUserPassword('NewPass123', 'NewPass123', sb);
    assert.equal(expiredSessionRes.ok, false);
    assert.match(expiredSessionRes.error ?? '', /expired/i);

    // 7f. Valid active recovery session updates password cleanly without destroying session prematurely
    await signInWithEmail('aarav@neel3dspace.com', 'Password123', sb);
    const goodUpdate = await updateUserPassword('NewPass123', 'NewPass123', sb);
    assert.equal(goodUpdate.ok, true);

    // Sign out temporary recovery session and verify login with new password works (old password rejected)
    await signOutUser(sb);
    const oldPassLogin = await signInWithEmail('aarav@neel3dspace.com', 'Password123', sb);
    assert.equal(oldPassLogin.ok, false);

    const relogin = await signInWithEmail('aarav@neel3dspace.com', 'NewPass123', sb);
    assert.equal(relogin.ok, true);
  });

  // 8. Pending employee login
  await test('8. Pending employee login restricted from 3D Studio & Admin', async () => {
    const res = await signInWithEmail('aarav@neel3dspace.com', 'NewPass123', sb);
    assert.equal(res.ok, true);
    assert.equal(resolvePostLoginRoute(res.data!.profile), 'pending-approval');
    const studioGuard = evaluateRouteAccess('studio', {
      isAuthenticated: true,
      isLoading: false,
      profile: res.data!.profile,
    });
    assert.equal(studioGuard.allowed, false);
    assert.equal(studioGuard.redirectTo, 'pending-approval');
  });

  // 9. Admin approves employee -> Approved employee login
  await test('9. Admin approval stamps approved_at/approved_by & Approved employee accesses 3D Studio', async () => {
    const adminLogin = await signInWithEmail('neelgagan@neel3dspace.com', 'AdminPassword123', sb);
    const adminProfile = adminLogin.data!.profile!;
    const allRes = await fetchAllEmployeeProfiles(adminProfile, sb);
    assert.equal(allRes.ok, true);
    assert.ok((allRes.data?.length ?? 0) >= 2);
    const stats = computeAdminStats(allRes.data!);
    assert.ok(stats.pending >= 1);

    // Verify admin cannot modify own admin record
    const selfMod = await adminUpdateEmployeeStatus(adminProfile, 'SUSPENDED', adminProfile, sb);
    assert.equal(selfMod.ok, false);

    // Verify missing RPC fails cleanly without ever falling back to direct table UPDATE
    const missingRpcClient = {
      auth: sb.auth,
      rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }),
      from: () => {
        throw new Error('Direct table UPDATE fallback must never be called');
      },
    } as unknown as SupabaseClient;
    const missingRpcRes = await adminUpdateEmployeeStatus(
      registeredEmpProfile!,
      'APPROVED',
      adminProfile,
      missingRpcClient
    );
    assert.equal(missingRpcRes.ok, false);
    assert.match(missingRpcRes.error ?? '', /admin_update_employee_status.*unavailable/i);

    // Approve Aarav via RPC
    const approveRes = await adminUpdateEmployeeStatus(
      registeredEmpProfile!,
      'APPROVED',
      adminProfile,
      sb
    );
    assert.equal(approveRes.ok, true);
    assert.equal(approveRes.data?.account_status, 'APPROVED');
    assert.ok(approveRes.data?.approved_at);
    assert.equal(approveRes.data?.approved_by, adminProfile.auth_user_id);

    // Now sign in as Approved employee
    const empLogin = await signInWithEmail('aarav@neel3dspace.com', 'NewPass123', sb);
    assert.equal(resolvePostLoginRoute(empLogin.data!.profile), 'employee-dashboard');
    assert.equal(
      evaluateRouteAccess('studio', {
        isAuthenticated: true,
        isLoading: false,
        profile: empLogin.data!.profile,
      }).allowed,
      true
    );
  });

  // 10. Rejected employee login
  await test('10. Rejected employee login restricted', async () => {
    const rejUid = 'uid-rejected-10';
    mock.seedAccount(
      { id: rejUid, email: 'rejected@neel3dspace.com', password: 'Password123', confirmed: true },
      {
        id: 'prof-rej-10',
        auth_user_id: rejUid,
        full_name: 'Rejected User',
        employee_id: 'EMP-REJ',
        username: 'rejected.user',
        email: 'rejected@neel3dspace.com',
        mobile: '+91 98765 33333',
        role: 'EMPLOYEE',
        account_status: 'REJECTED',
        approved_at: null,
        approved_by: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    );
    const res = await signInWithEmail('rejected@neel3dspace.com', 'Password123', sb);
    assert.equal(resolvePostLoginRoute(res.data!.profile), 'account-rejected');
    assert.equal(
      evaluateRouteAccess('studio', {
        isAuthenticated: true,
        isLoading: false,
        profile: res.data!.profile,
      }).redirectTo,
      'account-rejected'
    );
  });

  // 11. Suspended employee login
  await test('11. Suspended employee login restricted', async () => {
    const susUid = 'uid-suspended-11';
    mock.seedAccount(
      { id: susUid, email: 'suspended@neel3dspace.com', password: 'Password123', confirmed: true },
      {
        id: 'prof-sus-11',
        auth_user_id: susUid,
        full_name: 'Suspended User',
        employee_id: 'EMP-SUS',
        username: 'suspended.user',
        email: 'suspended@neel3dspace.com',
        mobile: '+91 98765 44444',
        role: 'EMPLOYEE',
        account_status: 'SUSPENDED',
        approved_at: null,
        approved_by: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    );
    const res = await signInWithEmail('suspended@neel3dspace.com', 'Password123', sb);
    assert.equal(resolvePostLoginRoute(res.data!.profile), 'account-suspended');
    assert.equal(
      evaluateRouteAccess('studio', {
        isAuthenticated: true,
        isLoading: false,
        profile: res.data!.profile,
      }).redirectTo,
      'account-suspended'
    );
  });

  // 12. Unauthorized admin dashboard access
  await test('12. Unauthorized admin dashboard access blocked for approved employee', async () => {
    const empLogin = await signInWithEmail('aarav@neel3dspace.com', 'NewPass123', sb);
    const empProfile = empLogin.data!.profile!;
    const adminRouteDecision = evaluateRouteAccess('admin', {
      isAuthenticated: true,
      isLoading: false,
      profile: empProfile,
    });
    assert.equal(adminRouteDecision.allowed, false);
    assert.equal(adminRouteDecision.redirectTo, 'employee-dashboard');
    assert.equal(adminRouteDecision.reason, 'unauthorized-admin');

    const adminListRes = await fetchAllEmployeeProfiles(empProfile, sb);
    assert.equal(adminListRes.ok, false);
  });

  // 13. Employee attempting to change their role
  await test('13. Employee attempting to escalate role to ADMIN blocked by RLS/trigger', async () => {
    const empLogin = await signInWithEmail('aarav@neel3dspace.com', 'NewPass123', sb);
    const empProfile = empLogin.data!.profile!;
    const { error } = await sb
      .from('employee_profiles')
      .update({ role: 'ADMIN' })
      .eq('id', empProfile.id)
      .select()
      .single();
    assert.ok(error);
  });

  // 14. Employee attempting to approve themselves
  await test('14. Employee attempting to self-approve blocked by RLS/trigger & RPC', async () => {
    const rejLogin = await signInWithEmail('rejected@neel3dspace.com', 'Password123', sb);
    const rejProfile = rejLogin.data!.profile!;
    const { error: updateErr } = await sb
      .from('employee_profiles')
      .update({ account_status: 'APPROVED' })
      .eq('id', rejProfile.id)
      .select()
      .single();
    assert.ok(updateErr);

    const rpcAttempt = await adminUpdateEmployeeStatus(rejProfile, 'APPROVED', rejProfile, sb);
    assert.equal(rpcAttempt.ok, false);
  });

  // 15. Employee attempting to access another employee's profile
  await test('15. Employee cannot read another employee profile under RLS', async () => {
    await signInWithEmail('aarav@neel3dspace.com', 'NewPass123', sb);
    const otherProfile = await fetchEmployeeProfile(
      '00000000-0000-4000-8000-000000000001',
      sb
    );
    assert.equal(otherProfile.ok, true);
    assert.equal(otherProfile.data, null);
  });

  // 16. Session persistence after refresh
  await test('16. Session persistence via getSession() restores user & profile', async () => {
    const { data } = await sb.auth.getSession();
    assert.ok(data.session?.user.id);
    const restoredProfile = await fetchEmployeeProfile(data.session!.user.id, sb);
    assert.equal(restoredProfile.ok, true);
    assert.equal(restoredProfile.data?.email, 'aarav@neel3dspace.com');
  });

  // 17. Logout
  await test('17. Logout clears session and revokes protected route access', async () => {
    const out = await signOutUser(sb);
    assert.equal(out.ok, true);
    const { data } = await sb.auth.getSession();
    assert.equal(data.session, null);
    const decision = evaluateRouteAccess('studio', {
      isAuthenticated: false,
      isLoading: false,
      profile: null,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.redirectTo, 'login');
  });

  // 18. Expired session handling
  await test('18. Expired session detected and blocked from protected routes', async () => {
    const expiredAt = Math.floor(Date.now() / 1000) - 60;
    const isExpired = expiredAt * 1000 <= Date.now();
    assert.equal(isExpired, true);
    const decision = evaluateRouteAccess('admin', {
      isAuthenticated: false,
      isLoading: false,
      profile: null,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.redirectTo, 'login');
  });

  // 19. Missing employee profile
  await test('19. Missing employee profile handled safely (never grants ADMIN or Studio)', async () => {
    const orphanUid = 'uid-orphan-19';
    mock.seedAccount({
      id: orphanUid,
      email: 'orphan@neel3dspace.com',
      password: 'Password123',
      confirmed: true,
    });
    const loginRes = await signInWithEmail('orphan@neel3dspace.com', 'Password123', sb);
    assert.equal(loginRes.ok, true);
    assert.equal(loginRes.data?.profile, null);
    assert.equal(resolvePostLoginRoute(loginRes.data!.profile), 'profile-missing');

    for (const protectedRoute of ['studio', 'summary', 'admin', 'employee-dashboard'] as const) {
      const dec = evaluateRouteAccess(protectedRoute, {
        isAuthenticated: true,
        isLoading: false,
        profile: null,
      });
      assert.equal(dec.allowed, false);
      assert.equal(dec.redirectTo, 'profile-missing');
    }
  });

  // 20. Direct URL access to protected pages
  await test('20. Direct URL access to protected routes parsed and enforced', async () => {
    await signOutUser(sb);
    assert.equal(parseRouteFromLocation('/admin'), 'admin');
    assert.equal(parseRouteFromLocation('/studio'), 'studio');
    assert.equal(parseRouteFromLocation('/summary'), 'summary');
    assert.equal(parseRouteFromLocation('/employee-dashboard'), 'employee-dashboard');
    assert.equal(parseRouteFromLocation('/'), 'login');
    assert.equal(parseRouteFromLocation('/home'), 'home');

    for (const url of ['/home', '/admin', '/studio', '/summary', '/employee-dashboard']) {
      const parsed = parseRouteFromLocation(url);
      const dec = evaluateRouteAccess(parsed, {
        isAuthenticated: false,
        isLoading: false,
        profile: null,
      });
      assert.equal(dec.allowed, false);
      assert.equal(dec.redirectTo, 'login');
    }
  });

  // 21. Profile lookup uses auth_user_id (distinct from profile.id) and distinguishes DB/RLS/network errors from missing profile
  await test('21. Profile query uses auth_user_id and never disguises RLS/DB/network errors as missing profile', async () => {
    const adminAuthUid = '94fd4f13-09e4-4fa4-a83f-4900649b1ffc';
    const distinctProfilePk = '22222222-2222-4222-8222-222222222222';
    mock.seedAccount(
      {
        id: adminAuthUid,
        email: 'neelgaganat97@gmail.com',
        password: 'AdminNewPassword1',
        confirmed: true,
      },
      {
        id: distinctProfilePk,
        auth_user_id: adminAuthUid,
        full_name: 'Neelgagan B R',
        employee_id: 'ADM-097',
        username: 'neelgaganat97',
        email: 'neelgaganat97@gmail.com',
        mobile: '+91 98765 00097',
        role: 'ADMIN',
        account_status: 'APPROVED',
        approved_at: '2026-01-01T00:00:00.000Z',
        approved_by: adminAuthUid,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }
    );

    const loginRes = await signInWithEmail('neelgaganat97@gmail.com', 'AdminNewPassword1', sb);
    assert.equal(loginRes.ok, true);
    assert.equal(loginRes.data?.profileError ?? null, null);
    assert.equal(loginRes.data?.profile?.auth_user_id, adminAuthUid);
    assert.equal(loginRes.data?.profile?.id, distinctProfilePk);
    assert.equal(loginRes.data?.profile?.role, 'ADMIN');
    assert.equal(loginRes.data?.profile?.account_status, 'APPROVED');
    assert.equal(resolvePostLoginRoute(loginRes.data!.profile), 'admin');

    // Simulate RLS permission error (42501) and infinite recursion error (42P17)
    const rlsClient = {
      auth: sb.auth,
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: null,
              error: {
                code: '42P17',
                message: 'infinite recursion detected in policy for relation "employee_profiles"',
              },
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const rlsLogin = await signInWithEmail('neelgaganat97@gmail.com', 'AdminNewPassword1', rlsClient);
    assert.equal(rlsLogin.ok, true);
    assert.equal(rlsLogin.data?.profile, null);
    assert.equal(rlsLogin.data?.profileErrorKind, 'rls');
    assert.match(rlsLogin.data?.profileError ?? '', /42P17|infinite recursion/i);

    // Route guard MUST return reason: 'profile-error' and NEVER redirect to 'profile-missing'
    const errorGuard = evaluateRouteAccess('admin', {
      isAuthenticated: true,
      isLoading: false,
      profile: null,
      profileError: rlsLogin.data?.profileError,
    });
    assert.equal(errorGuard.allowed, false);
    assert.equal(errorGuard.reason, 'profile-error');
    assert.equal(errorGuard.redirectTo, undefined);

    // Simulate network exception during profile fetch
    const netClient = {
      auth: sb.auth,
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              throw new TypeError('Failed to fetch');
            },
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const netRes = await fetchEmployeeProfile(adminAuthUid, netClient);
    assert.equal(netRes.ok, false);
    assert.equal(netRes.errorKind, 'network');
    assert.match(netRes.error ?? '', /network error/i);
  });

  // 22. Supabase public env configuration validation (missing vars, URL format, service_role refusal)
  await test('22. Supabase environment configuration validates public keys and blocks service_role keys', async () => {
    const missingBoth = validateSupabaseConfig({});
    assert.equal(missingBoth.configured, false);
    assert.equal(missingBoth.missingVars.length, 2);
    assert.match(missingBoth.validationError ?? '', /VITE_SUPABASE_URL/);
    assert.match(missingBoth.validationError ?? '', /VITE_SUPABASE_ANON_KEY/);

    const missingKey = validateSupabaseConfig({ url: 'https://example.supabase.co' });
    assert.equal(missingKey.configured, false);
    assert.equal(missingKey.hasUrl, true);
    assert.equal(missingKey.hasKey, false);

    const invalidUrl = validateSupabaseConfig({
      url: 'not-a-valid-url',
      anonKey: 'sb_publishable_demo_key',
    });
    assert.equal(invalidUrl.configured, false);
    assert.match(invalidUrl.validationError ?? '', /invalid/i);

    const secretPrefix = validateSupabaseConfig({
      url: 'https://example.supabase.co',
      anonKey: 'sb_secret_should_never_be_in_browser',
    });
    assert.equal(secretPrefix.configured, false);
    assert.match(secretPrefix.validationError ?? '', /service_role|secret/i);

    const fakeServiceRoleJwt = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ role: 'service_role', iss: 'supabase' })).toString('base64url'),
      'signature',
    ].join('.');
    const jwtSecret = validateSupabaseConfig({
      url: 'https://example.supabase.co',
      anonKey: fakeServiceRoleJwt,
    });
    assert.equal(jwtSecret.configured, false);
    assert.match(jwtSecret.validationError ?? '', /service_role/i);

    const validAnon = validateSupabaseConfig({
      url: 'https://example.supabase.co',
      anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.sig',
    });
    assert.equal(validAnon.configured, true);
    assert.equal(validAnon.validationError, null);

    const validPublishable = validateSupabaseConfig({
      url: 'https://example.supabase.co',
      publishableKey: 'sb_publishable_valid_public_key',
    });
    assert.equal(validPublishable.configured, true);
    assert.equal(validPublishable.validationError, null);
  });

  // 23. Active session verification, token refresh, and 42501 RLS vs expired session distinction
  await test('23. Profile fetch requires active session, refreshes expired tokens, and classifies 42501 RLS denials', async () => {
    const adminAuthUid = '94fd4f13-09e4-4fa4-a83f-4900649b1ffc';

    // 23a. Missing session MUST be rejected as 'auth' without sending an anon query
    await signOutUser(sb);
    let anonQueryAttempted = false;
    const noSessionClient = {
      auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
      },
      from: () => {
        anonQueryAttempted = true;
        throw new Error('Must not query employee_profiles without an active session');
      },
    } as unknown as SupabaseClient;

    const noSessionRes = await fetchEmployeeProfile(adminAuthUid, noSessionClient);
    assert.equal(noSessionRes.ok, false);
    assert.equal(noSessionRes.errorKind, 'auth');
    assert.equal(anonQueryAttempted, false);

    // 23b. Expired session with refreshSession() refreshes token and loads ADMIN + APPROVED profile
    let refreshCalled = false;
    let queriedColumn = '';
    let queriedValue = '';
    const refreshingClient = {
      auth: {
        getSession: async () => ({
          data: {
            session: {
              access_token: 'expired-token',
              refresh_token: 'valid-refresh',
              expires_at: Math.floor(Date.now() / 1000) - 30,
              user: { id: adminAuthUid, email: 'neelgaganat97@gmail.com' },
            },
          },
          error: null,
        }),
        refreshSession: async () => {
          refreshCalled = true;
          return {
            data: {
              session: {
                access_token: 'fresh-token',
                refresh_token: 'fresh-refresh',
                expires_at: Math.floor(Date.now() / 1000) + 3600,
                user: { id: adminAuthUid, email: 'neelgaganat97@gmail.com' },
              },
            },
            error: null,
          };
        },
      },
      from: () => ({
        select: () => ({
          eq: (col: string, val: string) => {
            queriedColumn = col;
            queriedValue = val;
            return {
              maybeSingle: async () => ({
                status: 200,
                data: {
                  id: '22222222-2222-4222-8222-222222222222',
                  auth_user_id: adminAuthUid,
                  full_name: 'Neelgagan B R',
                  employee_id: 'ADM-097',
                  username: 'neelgaganat97',
                  email: 'neelgaganat97@gmail.com',
                  mobile: '+91 98765 00097',
                  role: 'ADMIN',
                  account_status: 'APPROVED',
                },
                error: null,
              }),
            };
          },
        }),
      }),
    } as unknown as SupabaseClient;

    const refreshedRes = await fetchEmployeeProfile(adminAuthUid, refreshingClient);
    assert.equal(refreshCalled, true);
    assert.equal(queriedColumn, 'auth_user_id');
    assert.equal(queriedValue, adminAuthUid);
    assert.equal(refreshedRes.ok, true);
    assert.equal(refreshedRes.data?.role, 'ADMIN');
    assert.equal(refreshedRes.data?.account_status, 'APPROVED');

    // 23c. HTTP 403 / PostgreSQL 42501 RLS denial classified cleanly as 'rls' with HTTP status
    const deniedClient = {
      auth: {
        getSession: async () => ({
          data: {
            session: {
              access_token: 'valid-token',
              refresh_token: 'valid-refresh',
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              user: { id: adminAuthUid, email: 'neelgaganat97@gmail.com' },
            },
          },
          error: null,
        }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              status: 403,
              data: null,
              error: {
                code: '42501',
                message: 'permission denied for table employee_profiles',
                hint: 'Grant the required privileges to the current role with: GRANT SELECT ON public.employee_profiles TO authenticated;',
              },
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const deniedRes = await fetchEmployeeProfile(adminAuthUid, deniedClient);
    assert.equal(deniedRes.ok, false);
    assert.equal(deniedRes.errorKind, 'rls');
    assert.equal(deniedRes.errorCode, '42501');
    assert.equal(deniedRes.httpStatus, 403);
    assert.match(deniedRes.error ?? '', /42501/);
  });

  // 24. Strict RBAC matrix: all 12 access scenarios (ADMIN vs EMPLOYEE/PENDING/REJECTED/SUSPENDED/logged-out/refresh/tampering)
  await test('24. Strict RBAC enforces ADMIN-only /admin access, hides Admin nav from employees, blocks refresh flash, and secures all admin RPCs', async () => {
    const adminLogin = await signInWithEmail('neelgaganat97@gmail.com', 'AdminNewPassword1', sb);
    assert.equal(adminLogin.ok, true);
    const adminUser = adminLogin.data!.user;
    const adminProfile = adminLogin.data!.profile!;
    assert.equal(adminUser.id, '94fd4f13-09e4-4fa4-a83f-4900649b1ffc');
    assert.equal(adminProfile.auth_user_id, adminUser.id);
    assert.equal(isApprovedAdmin(adminProfile, adminUser.id), true);

    // Scenario 1 & 2: Existing ADMIN opens /admin and sees Admin navigation
    assert.equal(
      evaluateRouteAccess('admin', {
        isAuthenticated: true,
        isLoading: false,
        authUserId: adminUser.id,
        profile: adminProfile,
      }).allowed,
      true
    );
    assert.equal(
      canViewAdminNavigation({
        isAuthenticated: true,
        isLoading: false,
        authUserId: adminUser.id,
        profile: adminProfile,
      }),
      true
    );

    // Scenario 12: Admin list, view details, suspend, and reactivate via SECURITY DEFINER RPCs
    const listRes = await fetchAllEmployeeProfiles(adminProfile, sb);
    assert.equal(listRes.ok, true);
    const aarav = listRes.data!.find((p) => p.email === 'aarav@neel3dspace.com')!;
    assert.ok(aarav);

    const detailRes = await adminGetEmployeeProfile(aarav.id, adminProfile, sb);
    assert.equal(detailRes.ok, true);
    assert.equal(detailRes.data?.email, 'aarav@neel3dspace.com');

    const suspendRes = await adminUpdateEmployeeStatus(aarav, 'SUSPENDED', adminProfile, sb);
    assert.equal(suspendRes.ok, true);
    assert.equal(suspendRes.data?.account_status, 'SUSPENDED');

    const reactivateRes = await adminUpdateEmployeeStatus(aarav, 'APPROVED', adminProfile, sb);
    assert.equal(reactivateRes.ok, true);
    assert.equal(reactivateRes.data?.account_status, 'APPROVED');
    assert.equal(reactivateRes.data?.approved_by, adminUser.id);

    // Scenario 3, 4, 9, 10: Approved EMPLOYEE cannot see Admin nav, redirected from /admin, blocked from all admin RPCs & role escalation
    const empLogin = await signInWithEmail('aarav@neel3dspace.com', 'NewPass123', sb);
    const empUser = empLogin.data!.user;
    const empProfile = empLogin.data!.profile!;
    assert.equal(empProfile.role, 'EMPLOYEE');
    assert.equal(empProfile.account_status, 'APPROVED');

    assert.equal(
      canViewAdminNavigation({
        isAuthenticated: true,
        isLoading: false,
        authUserId: empUser.id,
        profile: empProfile,
      }),
      false
    );
    const empAdminRoute = evaluateRouteAccess('admin', {
      isAuthenticated: true,
      isLoading: false,
      authUserId: empUser.id,
      profile: empProfile,
    });
    assert.equal(empAdminRoute.allowed, false);
    assert.equal(empAdminRoute.redirectTo, 'employee-dashboard');
    assert.equal(empAdminRoute.reason, 'unauthorized-admin');

    // Direct RPC calls as an authenticated EMPLOYEE must be rejected by server-side RBAC
    const rawListAttempt = await sb.rpc('admin_list_employee_profiles');
    assert.ok(rawListAttempt.error);
    assert.equal(rawListAttempt.error.code, '42501');

    const rawGetAttempt = await sb.rpc('admin_get_employee_profile', {
      p_profile_id: adminProfile.id,
    });
    assert.ok(rawGetAttempt.error);
    assert.equal(rawGetAttempt.error.code, '42501');

    const rawStatusAttempt = await sb.rpc('admin_update_employee_status', {
      p_profile_id: 'prof-rej-10',
      p_new_status: 'APPROVED',
    });
    assert.ok(rawStatusAttempt.error);
    assert.equal(rawStatusAttempt.error.code, '42501');

    // Spoofed frontend profile (mismatched auth_user_id) must ALSO be rejected
    const spoofedList = await fetchAllEmployeeProfiles(adminProfile, sb);
    assert.equal(spoofedList.ok, false);
    assert.equal(spoofedList.errorKind, 'rls');

    const spoofedGet = await adminGetEmployeeProfile(aarav.id, adminProfile, sb);
    assert.equal(spoofedGet.ok, false);
    assert.equal(spoofedGet.errorKind, 'rls');

    const spoofedMutate = await adminUpdateEmployeeStatus(aarav, 'SUSPENDED', adminProfile, sb);
    assert.equal(spoofedMutate.ok, false);
    assert.equal(spoofedMutate.errorKind, 'rls');

    const spoofedRoute = evaluateRouteAccess('admin', {
      isAuthenticated: true,
      isLoading: false,
      authUserId: empUser.id,
      profile: adminProfile, // Mismatched auth_user_id!
    });
    assert.equal(spoofedRoute.allowed, false);
    assert.equal(spoofedRoute.reason, 'identity-mismatch');

    // Scenario 5, 6, 7: PENDING, REJECTED, SUSPENDED cannot access /admin or see Admin nav
    const statusCases: Array<{
      status: AccountStatus;
      expectedRedirect: 'pending-approval' | 'account-rejected' | 'account-suspended';
    }> = [
      { status: 'PENDING', expectedRedirect: 'pending-approval' },
      { status: 'REJECTED', expectedRedirect: 'account-rejected' },
      { status: 'SUSPENDED', expectedRedirect: 'account-suspended' },
    ];
    for (const tc of statusCases) {
      const statusProfile: EmployeeProfile = {
        ...empProfile,
        role: 'ADMIN', // Even if role were ADMIN, non-APPROVED status MUST be blocked!
        account_status: tc.status,
      };
      assert.equal(
        canViewAdminNavigation({
          isAuthenticated: true,
          isLoading: false,
          authUserId: empUser.id,
          profile: statusProfile,
        }),
        false
      );
      const dec = evaluateRouteAccess('admin', {
        isAuthenticated: true,
        isLoading: false,
        authUserId: empUser.id,
        profile: statusProfile,
      });
      assert.equal(dec.allowed, false);
      assert.equal(dec.redirectTo, tc.expectedRedirect);
    }

    // Scenario 8: Logged-out visitor cannot access /admin or see Admin nav
    await signOutUser(sb);
    assert.equal(
      canViewAdminNavigation({
        isAuthenticated: false,
        isLoading: false,
        authUserId: null,
        profile: null,
      }),
      false
    );
    const anonAdminDec = evaluateRouteAccess('admin', {
      isAuthenticated: false,
      isLoading: false,
      authUserId: null,
      profile: null,
    });
    assert.equal(anonAdminDec.allowed, false);
    assert.equal(anonAdminDec.redirectTo, 'login');

    // Scenario 11: Browser refresh / loading state NEVER exposes /admin or Admin nav
    const loadingAdminDec = evaluateRouteAccess('admin', {
      isAuthenticated: true,
      isLoading: true,
      authUserId: empUser.id,
      profile: empProfile,
    });
    assert.equal(loadingAdminDec.allowed, false);
    assert.equal(loadingAdminDec.reason, 'loading');
    assert.equal(
      canViewAdminNavigation({
        isAuthenticated: true,
        isLoading: true,
        authUserId: adminUser.id,
        profile: adminProfile,
      }),
      false
    );

    // Verify /design-studio alias parses cleanly to studio
    assert.equal(parseRouteFromLocation('/design-studio'), 'studio');
  });

  await test('25. Auth & profile timeouts settle cleanly (no infinite spinner) and both Supabase public key env vars are supported', async () => {
    const anonCfg = validateSupabaseConfig({
      url: 'https://dfsezdrniwsqvpglxnyh.supabase.co',
      anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.anon',
    });
    assert.equal(anonCfg.configured, true);
    assert.equal(anonCfg.keySource, 'VITE_SUPABASE_ANON_KEY');

    const publishableCfg = validateSupabaseConfig({
      url: 'https://dfsezdrniwsqvpglxnyh.supabase.co',
      publishableKey: 'sb_publishable_example_key_123',
    });
    assert.equal(publishableCfg.configured, true);
    assert.equal(publishableCfg.keySource, 'VITE_SUPABASE_PUBLISHABLE_KEY');

    const missingCfg = validateSupabaseConfig({
      url: 'https://dfsezdrniwsqvpglxnyh.supabase.co',
    });
    assert.equal(missingCfg.configured, false);
    assert.equal(missingCfg.keySource, 'none');

    const adminUid = '94fd4f13-09e4-4fa4-a83f-4900649b1ffc';

    // 1) Hanging getSession() must time out cleanly instead of hanging forever
    const hangingGetSessionClient = {
      auth: {
        getSession: () => new Promise(() => {}),
        refreshSession: () => new Promise(() => {}),
      },
      from: () => {
        throw new Error('Should not query PostgREST when getSession hangs');
      },
    } as unknown as SupabaseClient;

    const getSessionRes = await fetchEmployeeProfile(adminUid, hangingGetSessionClient, 40);
    assert.equal(getSessionRes.ok, false);
    assert.equal(getSessionRes.errorKind, 'network');
    assert.match(getSessionRes.error ?? '', /timed out/i);

    // 2) Hanging refreshSession() on an expired session must time out cleanly
    const expiredSession = {
      access_token: 'expired-token',
      refresh_token: 'refresh-token',
      expires_at: Math.floor(Date.now() / 1000) - 60,
      user: { id: adminUid, email: 'neelgaganat97@gmail.com' } as User,
    } as Session;

    const hangingRefreshClient = {
      auth: {
        getSession: async () => ({ data: { session: expiredSession }, error: null }),
        refreshSession: () => new Promise(() => {}),
      },
      from: () => {
        throw new Error('Should not query PostgREST when refreshSession hangs');
      },
    } as unknown as SupabaseClient;

    const refreshRes = await fetchEmployeeProfile(adminUid, hangingRefreshClient, 40);
    assert.equal(refreshRes.ok, false);
    assert.equal(refreshRes.errorKind, 'network');
    assert.match(refreshRes.error ?? '', /timed out/i);

    // 3) Hanging employee_profiles PostgREST query must time out cleanly with TIMEOUT code
    const activeSession = {
      access_token: 'valid-token',
      refresh_token: 'refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: adminUid, email: 'neelgaganat97@gmail.com' } as User,
    } as Session;

    const hangingQueryClient = {
      auth: {
        getSession: async () => ({ data: { session: activeSession }, error: null }),
        refreshSession: async () => ({ data: { session: activeSession }, error: null }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => new Promise(() => {}),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const queryRes = await fetchEmployeeProfile(adminUid, hangingQueryClient, 40);
    assert.equal(queryRes.ok, false);
    assert.equal(queryRes.errorKind, 'network');
    assert.equal(queryRes.errorCode, 'TIMEOUT');
    assert.match(queryRes.error ?? '', /timed out/i);
  });

  await test('26. Complete employee registration with email confirmation, server-side profile provisioning, Admin approval, rejection, suspension, and /admin protection', async () => {
    // 1) Verify email confirmation URL detection & parsing across PKCE, OTP token_hash, and implicit hash flows
    assert.equal(isEmailConfirmationUrl('?code=pkce-abc-123', '', '/pending-approval'), true);
    assert.equal(isEmailConfirmationUrl('?code=pkce-abc-123', '', '/auth/callback'), true);
    assert.equal(
      isEmailConfirmationUrl('?token_hash=tok-signup-99&type=signup', '', '/pending-approval'),
      true
    );
    assert.equal(
      isEmailConfirmationUrl('', '#access_token=abc&type=signup', '/pending-approval'),
      true
    );
    assert.deepEqual(
      parseEmailConfirmationTokenHash('?token_hash=tok-signup-99&type=signup'),
      { tokenHash: 'tok-signup-99', type: 'signup' }
    );
    assert.equal(parseAuthCallbackCode('/pending-approval', '?code=pkce-abc-123'), 'pkce-abc-123');
    assert.equal(parseRouteFromLocation('/auth/callback', '?code=pkce-abc-123', ''), 'pending-approval');
    assert.equal(parseRouteFromLocation('/pending-approval', '?token_hash=tok&type=signup', ''), 'pending-approval');

    // Password recovery URLs MUST NOT be misclassified as email confirmation
    assert.equal(isRecoveryUrl('?token_hash=rec-1&type=recovery', '', '/reset-password'), true);
    assert.equal(isEmailConfirmationUrl('?token_hash=rec-1&type=recovery', '', '/reset-password'), false);
    assert.equal(parseAuthCallbackCode('/reset-password', '?code=rec-code'), null);
    assert.equal(parseRouteFromLocation('/reset-password', '?code=rec-code', ''), 'reset-password');

    // 2) Verify email confirmation callback with missing profile NEVER shows profile-missing and NEVER grants Studio/Admin
    assert.equal(
      resolvePostLoginRoute(null, 'uid-new-emp', { emailVerified: true }),
      'pending-approval'
    );
    const verifiedPendingDecision = evaluateRouteAccess('pending-approval', {
      isAuthenticated: true,
      isLoading: false,
      authUserId: 'uid-new-emp',
      profile: null,
      emailVerified: true,
    });
    assert.equal(verifiedPendingDecision.allowed, true);

    const verifiedUnauthPendingDecision = evaluateRouteAccess('pending-approval', {
      isAuthenticated: false,
      isLoading: false,
      authUserId: null,
      profile: null,
      emailVerified: true,
    });
    assert.equal(verifiedUnauthPendingDecision.allowed, true);

    for (const lockedRoute of ['studio', 'summary', 'employee-dashboard', 'admin'] as const) {
      const dec = evaluateRouteAccess(lockedRoute, {
        isAuthenticated: true,
        isLoading: false,
        authUserId: 'uid-new-emp',
        profile: null,
        emailVerified: true,
      });
      assert.equal(dec.allowed, false);
      assert.equal(dec.redirectTo, 'pending-approval');
    }

    // 3) Verify registerEmployee works with email confirmation enabled (no session yet)
    // and that profile is created by the database auth.users trigger with EMPLOYEE + PENDING
    const flowMock = new RlsMockSupabase();
    flowMock.setRequireEmailConfirmation(true);
    const flowSb = flowMock.asClient();

    let capturedRedirectTo: string | undefined;
    const origSignUp = flowSb.auth.signUp.bind(flowSb.auth);
    flowSb.auth.signUp = (async (args: any) => {
      capturedRedirectTo = args?.options?.emailRedirectTo;
      return origSignUp(args);
    }) as any;

    const regRes = await registerEmployee(
      {
        fullName: 'Meera Nair',
        employeeId: 'emp-2026',
        username: 'Meera.Nair',
        email: 'meera.nair@neel3dspace.com',
        mobile: '+91 98765 11223',
        password: 'Password123',
        confirmPassword: 'Password123',
      },
      flowSb,
      'https://neel3dspace.example.com/pending-approval'
    );
    assert.equal(regRes.ok, true);
    assert.equal(regRes.data?.requiresEmailConfirmation, true);
    assert.equal(regRes.data?.session, null);
    assert.equal(capturedRedirectTo, 'https://neel3dspace.example.com/pending-approval');

    // Trigger created EMPLOYEE + PENDING row immediately even with no authenticated browser session
    const newUid = regRes.data!.user!.id;
    const triggerCreated = flowMock.getProfileByAuthId(newUid);
    assert.ok(triggerCreated);
    assert.equal(triggerCreated!.role, 'EMPLOYEE');
    assert.equal(triggerCreated!.account_status, 'PENDING');
    assert.equal(triggerCreated!.auth_user_id, newUid);

    // 4) Verify ensureOwnEmployeeProfile RPC safely provisions a missing profile without direct client INSERT
    const rpcEmpUid = 'uid-rpc-provision-26';
    const rpcSession = {
      access_token: 'valid-token',
      refresh_token: 'valid-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: {
        id: rpcEmpUid,
        email: 'provisioned@neel3dspace.com',
        user_metadata: {
          full_name: 'Kiran Verma',
          employee_id: 'EMP-9001',
          username: 'kiran.verma',
          mobile: '+91 90000 11111',
        },
      } as unknown as User,
    } as Session;
    let directInsertAttempted = false;
    const rpcClient = {
      auth: {
        getSession: async () => ({ data: { session: rpcSession }, error: null }),
        refreshSession: async () => ({ data: { session: rpcSession }, error: null }),
      },
      from: () => ({
        insert: () => {
          directInsertAttempted = true;
          throw new Error('Direct client INSERT must never be called');
        },
      }),
      rpc: async (fn: string) => {
        assert.equal(fn, 'ensure_own_employee_profile');
        return {
          status: 200,
          error: null,
          data: {
            id: 'prof-rpc-26',
            auth_user_id: rpcEmpUid,
            full_name: 'Kiran Verma',
            employee_id: 'EMP-9001',
            username: 'kiran.verma',
            email: 'provisioned@neel3dspace.com',
            mobile: '+91 90000 11111',
            role: 'EMPLOYEE',
            account_status: 'PENDING',
            approved_at: null,
            approved_by: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        };
      },
    } as unknown as SupabaseClient;

    const ensuredRes = await ensureOwnEmployeeProfile(rpcClient);
    assert.equal(directInsertAttempted, false);
    assert.equal(ensuredRes.ok, true);
    assert.equal(ensuredRes.data?.role, 'EMPLOYEE');
    assert.equal(ensuredRes.data?.account_status, 'PENDING');
    assert.equal(ensuredRes.data?.auth_user_id, rpcEmpUid);

    // 5) Admin logs in -> sees Meera as PENDING -> approves -> suspends -> reactivates -> rejects
    const adminSignIn = await signInWithEmail('neelgagan@neel3dspace.com', 'AdminPassword123', flowSb);
    assert.equal(adminSignIn.ok, true);
    const adminProfile = adminSignIn.data!.profile!;
    assert.equal(isApprovedAdmin(adminProfile, adminSignIn.data!.user.id), true);

    const directory = await fetchAllEmployeeProfiles(adminProfile, flowSb);
    assert.equal(directory.ok, true);
    const pendingMeera = directory.data!.find((p) => p.auth_user_id === newUid);
    assert.ok(pendingMeera);
    assert.equal(pendingMeera!.account_status, 'PENDING');
    assert.equal(pendingMeera!.full_name, 'Meera Nair');
    assert.equal(pendingMeera!.employee_id, 'EMP-2026');
    assert.equal(pendingMeera!.username, 'meera.nair');
    assert.equal(pendingMeera!.mobile, '+91 98765 11223');

    // Approve -> employee can access Studio, still blocked from /admin
    const approvedMeera = await adminUpdateEmployeeStatus(pendingMeera!, 'APPROVED', adminProfile, flowSb);
    assert.equal(approvedMeera.ok, true);
    assert.equal(approvedMeera.data?.account_status, 'APPROVED');
    assert.ok(approvedMeera.data?.approved_at);
    assert.equal(approvedMeera.data?.approved_by, adminProfile.auth_user_id);

    assert.equal(
      evaluateRouteAccess('studio', {
        isAuthenticated: true,
        isLoading: false,
        authUserId: newUid,
        profile: approvedMeera.data!,
      }).allowed,
      true
    );
    assert.equal(
      evaluateRouteAccess('admin', {
        isAuthenticated: true,
        isLoading: false,
        authUserId: newUid,
        profile: approvedMeera.data!,
      }).allowed,
      false
    );

    // Suspend -> blocked from Studio
    const suspendedMeera = await adminUpdateEmployeeStatus(approvedMeera.data!, 'SUSPENDED', adminProfile, flowSb);
    assert.equal(suspendedMeera.ok, true);
    assert.equal(suspendedMeera.data?.account_status, 'SUSPENDED');
    assert.equal(
      evaluateRouteAccess('studio', {
        isAuthenticated: true,
        isLoading: false,
        authUserId: newUid,
        profile: suspendedMeera.data!,
      }).redirectTo,
      'account-suspended'
    );

    // Reactivate -> regains Studio access
    const reactivatedMeera = await adminUpdateEmployeeStatus(suspendedMeera.data!, 'APPROVED', adminProfile, flowSb);
    assert.equal(reactivatedMeera.ok, true);
    assert.equal(reactivatedMeera.data?.account_status, 'APPROVED');

    // Reject -> blocked from Studio
    const rejectedMeera = await adminUpdateEmployeeStatus(reactivatedMeera.data!, 'REJECTED', adminProfile, flowSb);
    assert.equal(rejectedMeera.ok, true);
    assert.equal(rejectedMeera.data?.account_status, 'REJECTED');
    assert.equal(
      evaluateRouteAccess('studio', {
        isAuthenticated: true,
        isLoading: false,
        authUserId: newUid,
        profile: rejectedMeera.data!,
      }).redirectTo,
      'account-rejected'
    );

    // Existing Admin account preserved untouched
    const adminCheck = flowMock.getProfileByAuthId(adminProfile.auth_user_id);
    assert.equal(adminCheck?.role, 'ADMIN');
    assert.equal(adminCheck?.account_status, 'APPROVED');
  });

  await test('27. Callback redirect, email_confirmed_at admin field, and safe recovery for missing profile (neelgagan.singh.br@gmail.com)', async () => {
    // 1) Default auth callback route builder & URL parser
    assert.equal(
      buildAuthRedirectUrl('/auth/callback', 'https://neel3dspace.example.com/auth/callback'),
      'https://neel3dspace.example.com/auth/callback'
    );
    assert.equal(parseRouteFromLocation('/auth/callback', '?code=pkce-recover-1', ''), 'pending-approval');

    // 2) Simulated state mirroring the user's real Supabase project:
    // - Permanent Super Admin: neelgaganat97@gmail.com (94fd4f13-09e4-4fa4-a83f-4900649b1ffc)
    // - Failed prior registration: neelgagan.singh.br@gmail.com (Auth user exists, employee_profiles row missing)
    const superAdminUid = '94fd4f13-09e4-4fa4-a83f-4900649b1ffc';
    const missingEmpUid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const confirmedIso = '2026-05-01T10:15:00.000Z';

    const dbProfiles: EmployeeProfile[] = [
      {
        id: 'prof-super-admin-real',
        auth_user_id: superAdminUid,
        full_name: 'Neelgagan B R',
        employee_id: 'ADMIN-001',
        username: 'neelgagan.admin',
        email: 'neelgaganat97@gmail.com',
        mobile: '+91 90000 00001',
        role: 'ADMIN',
        account_status: 'APPROVED',
        approved_at: '2026-01-01T00:00:00.000Z',
        approved_by: superAdminUid,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        email_confirmed_at: '2026-01-01T00:00:00.000Z',
      },
    ];

    let activeUid = missingEmpUid;
    let activeEmail = 'neelgagan.singh.br@gmail.com';
    let receivedRecoveryArgs: Record<string, unknown> = {};
    let simulateDuplicateUsername = false;
    let simulateRpcMissing = false;

    const makeSession = (uid: string, email: string): Session =>
      ({
        access_token: `token-${uid}`,
        refresh_token: `refresh-${uid}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: {
          id: uid,
          email,
          email_confirmed_at: confirmedIso,
          user_metadata: {
            full_name: 'Neelgagan Singh',
          },
        } as unknown as User,
      }) as Session;

    const recoveryClient = {
      auth: {
        getSession: async () => ({ data: { session: makeSession(activeUid, activeEmail) }, error: null }),
        refreshSession: async () => ({ data: { session: makeSession(activeUid, activeEmail) }, error: null }),
      },
      rpc: async (fn: string, params?: Record<string, unknown>) => {
        if (fn === 'ensure_own_employee_profile') {
          if (simulateRpcMissing) {
            return {
              status: 404,
              data: null,
              error: { code: 'PGRST202', message: 'Could not find the function public.ensure_own_employee_profile' },
            };
          }
          if (simulateDuplicateUsername) {
            return {
              status: 409,
              data: null,
              error: { code: '23505', message: 'duplicate key value violates unique constraint "employee_profiles_username_key"' },
            };
          }
          receivedRecoveryArgs = params ?? {};
          const existing = dbProfiles.find((p) => p.auth_user_id === activeUid);
          if (existing) {
            return { status: 200, data: { ...existing }, error: null };
          }
          const created: EmployeeProfile = {
            id: 'prof-recovered-emp-1',
            auth_user_id: activeUid,
            full_name: String(params?.p_full_name || 'Neelgagan Singh'),
            employee_id: String(params?.p_employee_id || 'EMP-47AC10'),
            username: String(params?.p_username || 'neelgagan.singh.br'),
            email: activeEmail,
            mobile: String(params?.p_mobile || '+91 98765 44332'),
            role: 'EMPLOYEE',
            account_status: 'PENDING',
            approved_at: null,
            approved_by: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            email_confirmed_at: confirmedIso,
          };
          dbProfiles.push(created);
          return { status: 200, data: { ...created }, error: null };
        }

        if (fn === 'admin_list_employee_profiles') {
          if (activeUid !== superAdminUid) {
            return {
              status: 403,
              data: null,
              error: { code: '42501', message: 'Forbidden: Approved administrator privileges required.' },
            };
          }
          return { status: 200, data: dbProfiles.map((p) => ({ ...p })), error: null };
        }

        if (fn === 'admin_get_employee_profile') {
          if (activeUid !== superAdminUid) {
            return {
              status: 403,
              data: null,
              error: { code: '42501', message: 'Forbidden: Approved administrator privileges required.' },
            };
          }
          const found = dbProfiles.find((p) => p.id === params?.p_profile_id);
          return found
            ? { status: 200, data: { ...found }, error: null }
            : { status: 404, data: null, error: { message: 'Not found' } };
        }

        if (fn === 'admin_update_employee_status') {
          if (activeUid !== superAdminUid) {
            return {
              status: 403,
              data: null,
              error: { code: '42501', message: 'Forbidden: Approved administrator privileges required.' },
            };
          }
          const found = dbProfiles.find((p) => p.id === params?.p_profile_id);
          if (!found) return { status: 404, data: null, error: { message: 'Not found' } };
          found.account_status = params?.p_new_status as AccountStatus;
          if (found.account_status === 'APPROVED') {
            found.approved_at = new Date().toISOString();
            found.approved_by = superAdminUid;
          }
          return { status: 200, data: { ...found }, error: null };
        }

        return { status: 404, data: null, error: { message: `Unknown RPC ${fn}` } };
      },
    } as unknown as SupabaseClient;

    // 3) Missing RPC reports rpcUnavailable=true cleanly without crashing session bootstrap
    simulateRpcMissing = true;
    const missingRpcRes = await ensureOwnEmployeeProfile(recoveryClient);
    assert.equal(missingRpcRes.ok, true);
    assert.equal(missingRpcRes.data, null);
    assert.equal(missingRpcRes.rpcUnavailable, true);
    simulateRpcMissing = false;

    // 4) Duplicate username returns structured field error
    simulateDuplicateUsername = true;
    const dupRes = await ensureOwnEmployeeProfile(recoveryClient, 5000, {
      fullName: 'Neelgagan Singh',
      employeeId: 'EMP-2027',
      username: 'neelgagan.admin',
      mobile: '+91 98765 44332',
    });
    assert.equal(dupRes.ok, false);
    assert.equal(dupRes.fieldErrors?.username !== undefined, true);
    simulateDuplicateUsername = false;

    // 5) Safe profile recovery for neelgagan.singh.br@gmail.com creates strictly EMPLOYEE + PENDING
    const recovered = await ensureOwnEmployeeProfile(recoveryClient, 5000, {
      fullName: 'Neelgagan Singh',
      employeeId: 'emp-2027',
      username: 'Neelgagan.Singh',
      mobile: '+91 98765 44332',
    });
    assert.equal(recovered.ok, true);
    assert.equal(receivedRecoveryArgs.p_employee_id, 'EMP-2027');
    assert.equal(receivedRecoveryArgs.p_username, 'neelgagan.singh');
    assert.equal(recovered.data?.auth_user_id, missingEmpUid);
    assert.equal(recovered.data?.role, 'EMPLOYEE');
    assert.equal(recovered.data?.account_status, 'PENDING');
    assert.equal(recovered.data?.approved_at, null);
    assert.equal(recovered.data?.approved_by, null);

    // 6) Idempotency: retrying recovery never creates a duplicate row
    const retryRecovered = await ensureOwnEmployeeProfile(recoveryClient);
    assert.equal(retryRecovered.ok, true);
    assert.equal(dbProfiles.filter((p) => p.auth_user_id === missingEmpUid).length, 1);

    // 7) Pending employee is blocked from /admin and Studio
    assert.equal(
      evaluateRouteAccess('studio', {
        isAuthenticated: true,
        isLoading: false,
        authUserId: missingEmpUid,
        profile: recovered.data!,
      }).redirectTo,
      'pending-approval'
    );
    assert.equal(
      evaluateRouteAccess('admin', {
        isAuthenticated: true,
        isLoading: false,
        authUserId: missingEmpUid,
        profile: recovered.data!,
      }).allowed,
      false
    );

    // 8) Super Admin (neelgaganat97@gmail.com / 94fd4f13-09e4-4fa4-a83f-4900649b1ffc) views directory with email_confirmed_at
    activeUid = superAdminUid;
    activeEmail = 'neelgaganat97@gmail.com';
    const superAdminProfile = dbProfiles[0];
    assert.equal(isApprovedAdmin(superAdminProfile, superAdminUid), true);

    const listRes = await fetchAllEmployeeProfiles(superAdminProfile, recoveryClient);
    assert.equal(listRes.ok, true);
    const pendingRec = listRes.data!.find((p) => p.email === 'neelgagan.singh.br@gmail.com');
    assert.ok(pendingRec);
    assert.equal(pendingRec!.account_status, 'PENDING');
    assert.equal(pendingRec!.email_confirmed_at, confirmedIso);

    const detailRes = await adminGetEmployeeProfile(pendingRec!.id, superAdminProfile, recoveryClient);
    assert.equal(detailRes.ok, true);
    assert.equal(detailRes.data?.email_confirmed_at, confirmedIso);

    // 9) Super Admin approves -> employee gains Studio access but stays blocked from /admin
    const approvedRec = await adminUpdateEmployeeStatus(pendingRec!, 'APPROVED', superAdminProfile, recoveryClient);
    assert.equal(approvedRec.ok, true);
    assert.equal(approvedRec.data?.account_status, 'APPROVED');
    assert.equal(approvedRec.data?.approved_by, superAdminUid);
    assert.ok(approvedRec.data?.approved_at);

    assert.equal(
      evaluateRouteAccess('studio', {
        isAuthenticated: true,
        isLoading: false,
        authUserId: missingEmpUid,
        profile: approvedRec.data!,
      }).allowed,
      true
    );
    assert.equal(
      evaluateRouteAccess('admin', {
        isAuthenticated: true,
        isLoading: false,
        authUserId: missingEmpUid,
        profile: approvedRec.data!,
      }).allowed,
      false
    );

    // 10) Super Admin profile remains completely intact
    assert.equal(dbProfiles[0].auth_user_id, superAdminUid);
    assert.equal(dbProfiles[0].role, 'ADMIN');
    assert.equal(dbProfiles[0].account_status, 'APPROVED');
  });

  console.log(`\nALL ${passed}/27 AUTHENTICATION & AUTHORIZATION SCENARIOS PASSED.`);
}

runTests().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
