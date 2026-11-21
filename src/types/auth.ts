export type EmployeeRole = 'ADMIN' | 'EMPLOYEE';

export type AccountStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

export type ProfileErrorKind = 'rls' | 'network' | 'auth' | 'database';

/**
 * Mirrors existing public.employee_profiles schema exactly.
 * Do not invent extra columns.
 */
export interface EmployeeProfile {
  id: string;
  auth_user_id: string;
  full_name: string;
  employee_id: string;
  username: string;
  email: string;
  mobile: string;
  role: EmployeeRole;
  account_status: AccountStatus;
  approved_at: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
  /** Read-only timestamp joined from auth.users when returned by Admin RPCs. */
  email_confirmed_at?: string | null;
}

export interface ProfileRecoveryInput {
  fullName?: string;
  employeeId?: string;
  username?: string;
  mobile?: string;
}

export interface EmployeeRegistrationInput {
  fullName: string;
  employeeId: string;
  username: string;
  email: string;
  mobile: string;
  password: string;
  confirmPassword: string;
}

export interface RegistrationAvailability {
  emailTaken: boolean;
  usernameTaken: boolean;
  employeeIdTaken: boolean;
}

export interface AuthValidationResult {
  valid: boolean;
  fieldErrors: Record<string, string>;
}

export type AppRoute =
  | 'home'
  | 'studio'
  | 'summary'
  | 'login'
  | 'register'
  | 'forgot-password'
  | 'reset-password'
  | 'employee-dashboard'
  | 'admin'
  | 'pending-approval'
  | 'account-rejected'
  | 'account-suspended'
  | 'profile-missing';

export interface AdminDashboardStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  suspended: number;
}
