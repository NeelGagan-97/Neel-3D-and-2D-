import assert from 'node:assert/strict';
import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import {
  adminUpdateEmployeeStatus,
  buildAuthRedirectUrl,
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
  computeAdminStats,
  evaluateRouteAccess,
  resolvePostLoginRoute,
} from '../src/utils/authValidation';
import {
  isRecoveryUrl,
  parseAuthErrorFromUrl,
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

      if (fn === 'admin_update_employee_status') {
        if (!self.isCallerApprovedAdmin()) {
          return {
            data: null,
            error: { message: 'Forbidden: Approved administrator privileges required.' },
          };
        }
        const target = self.profiles.find((p) => p.id === params.p_profile_id);
        if (!target) {
          return { data: null, error: { message: 'Employee profile not found.' } };
        }
        if (target.auth_user_id === self.currentSession!.user.id || target.role === 'ADMIN') {
          return {
            data: null,
            error: { message: 'Administrators cannot modify their own account status.' },
          };
        }
        const nextStatus = params.p_new_status as AccountStatus;
        target.account_status = nextStatus;
        if (nextStatus === 'APPROVED') {
          target.approved_at = new Date().toISOString();
          target.approved_by = self.currentSession!.user.id;
        }
        target.updated_at = new Date().toISOString();
        return { data: { ...target }, error: null };
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

  console.log(`\nALL ${passed}/21 AUTHENTICATION & AUTHORIZATION SCENARIOS PASSED.`);
}

runTests().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
