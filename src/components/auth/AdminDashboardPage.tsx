import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import {
  adminUpdateEmployeeStatus,
  fetchAllEmployeeProfiles,
} from '../../services/authService';
import { AccountStatus, AppRoute, EmployeeProfile } from '../../types/auth';
import { ScreenId, ViewMode } from '../../types/design';
import { computeAdminStats } from '../../utils/authValidation';
import { Navbar } from '../Navbar';

interface AdminDashboardPageProps {
  onNavigate: (screen: ScreenId, initialView?: ViewMode) => void;
  onNavigateRoute: (route: AppRoute) => void;
}

type StatusFilter = 'ALL' | AccountStatus;
type AdminActionType = 'APPROVE' | 'REJECT' | 'SUSPEND' | 'REACTIVATE';

interface PendingConfirmation {
  employee: EmployeeProfile;
  action: AdminActionType;
  targetStatus: Extract<AccountStatus, 'APPROVED' | 'REJECTED' | 'SUSPENDED'>;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatFullTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusTextClass(status: AccountStatus): string {
  if (status === 'APPROVED') return 'text-success';
  if (status === 'PENDING') return 'text-warning';
  return 'text-error';
}

export const AdminDashboardPage: React.FC<AdminDashboardPageProps> = ({
  onNavigate,
  onNavigateRoute,
}) => {
  const { profile: currentAdmin, signOut } = useAuth();
  const [employees, setEmployees] = useState<EmployeeProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeProfile | null>(null);
  const [confirmAction, setConfirmAction] = useState<PendingConfirmation | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const loadEmployees = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await fetchAllEmployeeProfiles(currentAdmin);
    if (res.ok && res.data) {
      setEmployees(res.data);
    } else {
      setError(res.error ?? 'Failed to load employee records.');
    }
    setLoading(false);
  }, [currentAdmin]);

  useEffect(() => {
    void loadEmployees();
  }, [loadEmployees]);

  const stats = useMemo(() => computeAdminStats(employees), [employees]);

  const filteredEmployees = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return employees.filter((emp) => {
      if (statusFilter !== 'ALL' && emp.account_status !== statusFilter) {
        return false;
      }
      if (!q) return true;
      return (
        emp.full_name.toLowerCase().includes(q) ||
        emp.employee_id.toLowerCase().includes(q) ||
        emp.username.toLowerCase().includes(q) ||
        emp.email.toLowerCase().includes(q) ||
        (emp.mobile ?? '').toLowerCase().includes(q)
      );
    });
  }, [employees, searchQuery, statusFilter]);

  const openConfirmation = (employee: EmployeeProfile, action: AdminActionType) => {
    const targetStatus: PendingConfirmation['targetStatus'] =
      action === 'APPROVE' || action === 'REACTIVATE'
        ? 'APPROVED'
        : action === 'REJECT'
          ? 'REJECTED'
          : 'SUSPENDED';

    setConfirmAction({ employee, action, targetStatus });
  };

  const executeConfirmedAction = async () => {
    if (!confirmAction) return;
    setActionLoading(true);
    setToast(null);
    try {
      const res = await adminUpdateEmployeeStatus(
        confirmAction.employee,
        confirmAction.targetStatus,
        currentAdmin
      );

      if (!res.ok || !res.data) {
        setToast({
          kind: 'error',
          text: res.error ?? 'Failed to update employee status.',
        });
        return;
      }

      const updated = res.data;
      if (selectedEmployee?.id === updated.id) {
        setSelectedEmployee(updated);
      }

      const actionPastTense =
        confirmAction.action === 'APPROVE'
          ? 'approved'
          : confirmAction.action === 'REACTIVATE'
            ? 'reactivated'
            : confirmAction.action === 'REJECT'
              ? 'rejected'
              : 'suspended';

      setConfirmAction(null);
      await loadEmployees();

      setToast({
        kind: 'success',
        text: `${updated.full_name} (${updated.employee_id}) has been ${actionPastTense}.`,
      });
    } finally {
      setActionLoading(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    onNavigateRoute('login');
  };

  const filterTabs: { id: StatusFilter; label: string; count: number }[] = [
    { id: 'ALL', label: 'All', count: stats.total },
    { id: 'PENDING', label: 'Pending', count: stats.pending },
    { id: 'APPROVED', label: 'Approved', count: stats.approved },
    { id: 'REJECTED', label: 'Rejected', count: stats.rejected },
    { id: 'SUSPENDED', label: 'Suspended', count: stats.suspended },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-surface text-on-surface">
      <Navbar
        activeScreen="home"
        activeRoute="admin"
        onNavigate={(s) => onNavigate(s)}
        onNavigateRoute={onNavigateRoute}
        rightSlot={
          <button
            type="button"
            onClick={() => onNavigate('studio', '3d')}
            className="inline-flex items-center justify-center gap-gutter-sm bg-primary text-on-primary px-gutter-lg py-gutter-sm rounded-md font-label text-label-md transition-colors hover:bg-on-primary-container cursor-pointer whitespace-nowrap"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              view_in_ar
            </span>
            <span>Open 3D Studio</span>
          </button>
        }
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-gutter-lg lg:px-gutter-xl py-gutter-2xl flex flex-col gap-gutter-xl">
        {/* Top Header */}
        <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-gutter-lg pb-gutter-lg border-b border-outline-variant">
          <div className="flex flex-col gap-gutter-xs">
            <div className="flex items-center gap-gutter-sm font-mono text-mono-sm text-on-surface-variant">
              <span className="text-primary">ADMINISTRATION</span>
              <span aria-hidden="true">·</span>
              <span>Signed in as {currentAdmin?.full_name ?? 'Administrator'}</span>
            </div>
            <h1 className="font-headline text-headline-lg-mobile lg:text-headline-lg text-on-surface text-balance">
              Employee Management Dashboard
            </h1>
            <p className="font-body text-body-md text-on-surface-variant">
              Review employee registrations, approve or suspend workspace access, and audit account
              permissions for Neel 3D Space.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-gutter-sm">
            <button
              type="button"
              onClick={() => void loadEmployees()}
              disabled={loading}
              className="inline-flex items-center gap-gutter-xs px-gutter-md py-gutter-sm rounded-md bg-surface-container border border-outline text-on-surface hover:border-primary font-label text-label-md disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <span
                className={`material-symbols-outlined text-[18px] ${loading ? 'animate-spin' : ''}`}
                aria-hidden="true"
              >
                refresh
              </span>
              <span>Refresh</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('studio', '3d')}
              className="inline-flex items-center gap-gutter-xs px-gutter-lg py-gutter-sm rounded-md bg-primary text-on-primary hover:bg-on-primary-container font-label text-label-md cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                view_in_ar
              </span>
              <span>3D Design Studio</span>
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center gap-gutter-xs px-gutter-md py-gutter-sm rounded-md border border-outline-variant text-on-surface-variant hover:text-on-surface hover:border-outline font-label text-label-md cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                logout
              </span>
              <span>Sign Out</span>
            </button>
          </div>
        </section>

        {/* KPI Metrics Grid */}
        <section aria-label="Employee Statistics" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-gutter-md">
          <div className="bg-surface-container border border-outline-variant rounded-lg p-gutter-lg flex flex-col gap-1">
            <span className="font-body text-body-sm text-on-surface-variant">Total Employees</span>
            <span className="font-mono text-headline-md text-on-surface tabular-nums">
              {stats.total}
            </span>
          </div>
          <div className="bg-surface-container border border-outline-variant rounded-lg p-gutter-lg flex flex-col gap-1">
            <span className="font-body text-body-sm text-on-surface-variant">
              Pending Registrations
            </span>
            <span className="font-mono text-headline-md text-warning tabular-nums">
              {stats.pending}
            </span>
          </div>
          <div className="bg-surface-container border border-outline-variant rounded-lg p-gutter-lg flex flex-col gap-1">
            <span className="font-body text-body-sm text-on-surface-variant">
              Approved Employees
            </span>
            <span className="font-mono text-headline-md text-success tabular-nums">
              {stats.approved}
            </span>
          </div>
          <div className="bg-surface-container border border-outline-variant rounded-lg p-gutter-lg flex flex-col gap-1">
            <span className="font-body text-body-sm text-on-surface-variant">
              Rejected Employees
            </span>
            <span className="font-mono text-headline-md text-error tabular-nums">
              {stats.rejected}
            </span>
          </div>
          <div className="bg-surface-container border border-outline-variant rounded-lg p-gutter-lg flex flex-col gap-1 col-span-2 sm:col-span-1">
            <span className="font-body text-body-sm text-on-surface-variant">
              Suspended Employees
            </span>
            <span className="font-mono text-headline-md text-error tabular-nums">
              {stats.suspended}
            </span>
          </div>
        </section>

        {/* Feedback banners */}
        {toast && (
          <div
            role="status"
            className={`p-gutter-md rounded-md border text-body-sm flex items-center justify-between gap-gutter-md ${
              toast.kind === 'success'
                ? 'bg-success/15 border-success text-on-surface'
                : 'bg-error/15 border-error text-on-surface'
            }`}
          >
            <span>{toast.text}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="underline text-label-sm cursor-pointer shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="p-gutter-md rounded-md bg-error/15 border border-error text-on-surface text-body-sm flex items-center justify-between gap-gutter-md"
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={() => void loadEmployees()}
              className="underline text-label-sm cursor-pointer shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {/* Filter & Search Bar */}
        <section className="flex flex-col lg:flex-row lg:items-center justify-between gap-gutter-md">
          <div
            role="tablist"
            aria-label="Filter employees by account status"
            className="inline-flex flex-wrap items-center gap-1 p-1 rounded-md bg-surface-container border border-outline-variant"
          >
            {filterTabs.map((tab) => {
              const active = statusFilter === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setStatusFilter(tab.id)}
                  className={`px-gutter-md py-1.5 rounded-sm font-label text-label-sm transition-colors cursor-pointer whitespace-nowrap ${
                    active
                      ? 'bg-primary-container text-primary border border-primary'
                      : 'text-on-surface-variant hover:text-on-surface border border-transparent'
                  }`}
                >
                  <span>{tab.label}</span>{' '}
                  <span className="font-mono tabular-nums opacity-80">({tab.count})</span>
                </button>
              );
            })}
          </div>

          <div className="relative w-full lg:w-80">
            <span
              className="material-symbols-outlined text-[18px] text-on-surface-variant absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            >
              search
            </span>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search name, ID, username, email..."
              aria-label="Search employees"
              className="w-full pl-9 pr-gutter-md py-gutter-xs rounded-md bg-surface-container border border-outline text-body-sm text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary"
            />
          </div>
        </section>

        {/* Employee Management Table */}
        <section className="bg-surface-container border border-outline-variant rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[980px]">
              <thead>
                <tr className="border-b border-outline-variant bg-surface-container-low font-label text-label-sm text-on-surface-variant">
                  <th className="py-gutter-sm px-gutter-md">Full Name</th>
                  <th className="py-gutter-sm px-gutter-sm">Employee ID</th>
                  <th className="py-gutter-sm px-gutter-sm">Username</th>
                  <th className="py-gutter-sm px-gutter-sm">Email</th>
                  <th className="py-gutter-sm px-gutter-sm">Mobile</th>
                  <th className="py-gutter-sm px-gutter-sm">Registered</th>
                  <th className="py-gutter-sm px-gutter-sm">Account Status</th>
                  <th className="py-gutter-sm px-gutter-sm">Role</th>
                  <th className="py-gutter-sm px-gutter-md text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant text-body-sm">
                {loading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i}>
                      <td colSpan={9} className="py-gutter-md px-gutter-md">
                        <div className="h-5 rounded bg-surface-container-high animate-pulse" />
                      </td>
                    </tr>
                  ))
                ) : filteredEmployees.length === 0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      className="py-gutter-2xl px-gutter-lg text-center text-on-surface-variant"
                    >
                      {employees.length === 0
                        ? 'No employee records found in public.employee_profiles.'
                        : 'No employees match the active search or status filter.'}
                    </td>
                  </tr>
                ) : (
                  filteredEmployees.map((emp) => {
                    const isSelf = emp.auth_user_id === currentAdmin?.auth_user_id;
                    const isProtectedAdmin = isSelf || emp.role === 'ADMIN';

                    return (
                      <tr key={emp.id} className="hover:bg-surface-container-high/40">
                        <td className="py-gutter-sm px-gutter-md font-medium text-on-surface whitespace-nowrap">
                          {emp.full_name}
                          {isSelf && (
                            <span className="ml-2 font-mono text-mono-sm text-primary">(You)</span>
                          )}
                        </td>
                        <td className="py-gutter-sm px-gutter-sm font-mono tabular-nums text-on-surface whitespace-nowrap">
                          {emp.employee_id}
                        </td>
                        <td className="py-gutter-sm px-gutter-sm font-mono text-on-surface-variant whitespace-nowrap">
                          {emp.username}
                        </td>
                        <td className="py-gutter-sm px-gutter-sm font-mono text-on-surface-variant whitespace-nowrap">
                          {emp.email}
                        </td>
                        <td className="py-gutter-sm px-gutter-sm font-mono tabular-nums text-on-surface-variant whitespace-nowrap">
                          {emp.mobile || '—'}
                        </td>
                        <td className="py-gutter-sm px-gutter-sm font-mono tabular-nums text-on-surface-variant whitespace-nowrap">
                          {formatDateTime(emp.created_at)}
                        </td>
                        <td
                          className={`py-gutter-sm px-gutter-sm font-mono text-mono-sm font-semibold whitespace-nowrap ${statusTextClass(
                            emp.account_status
                          )}`}
                        >
                          {emp.account_status}
                        </td>
                        <td className="py-gutter-sm px-gutter-sm font-mono text-mono-sm text-on-surface whitespace-nowrap">
                          {emp.role}
                        </td>
                        <td className="py-gutter-sm px-gutter-md text-right whitespace-nowrap">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => setSelectedEmployee(emp)}
                              className="px-2.5 py-1 rounded-sm border border-outline text-on-surface-variant hover:text-on-surface hover:border-primary font-label text-label-sm cursor-pointer"
                            >
                              Details
                            </button>

                            {isProtectedAdmin ? (
                              <span className="px-2 py-1 font-mono text-mono-sm text-on-surface-variant">
                                Protected Admin
                              </span>
                            ) : (
                              <>
                                {emp.account_status === 'PENDING' && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => openConfirmation(emp, 'APPROVE')}
                                      className="px-2.5 py-1 rounded-sm bg-success/20 border border-success text-success hover:bg-success hover:text-on-success font-label text-label-sm cursor-pointer"
                                    >
                                      Approve
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => openConfirmation(emp, 'REJECT')}
                                      className="px-2.5 py-1 rounded-sm bg-error/15 border border-error text-error hover:bg-error hover:text-on-primary font-label text-label-sm cursor-pointer"
                                    >
                                      Reject
                                    </button>
                                  </>
                                )}

                                {emp.account_status === 'APPROVED' && (
                                  <button
                                    type="button"
                                    onClick={() => openConfirmation(emp, 'SUSPEND')}
                                    className="px-2.5 py-1 rounded-sm bg-error/15 border border-error text-error hover:bg-error hover:text-on-primary font-label text-label-sm cursor-pointer"
                                  >
                                    Suspend
                                  </button>
                                )}

                                {(emp.account_status === 'SUSPENDED' ||
                                  emp.account_status === 'REJECTED') && (
                                  <button
                                    type="button"
                                    onClick={() => openConfirmation(emp, 'REACTIVATE')}
                                    className="px-2.5 py-1 rounded-sm bg-primary-container border border-primary text-primary hover:bg-primary hover:text-on-primary font-label text-label-sm cursor-pointer"
                                  >
                                    Reactivate
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* Employee Details Modal */}
      {selectedEmployee && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="employee-details-title"
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-gutter-lg"
          onClick={() => setSelectedEmployee(null)}
        >
          <div
            className="w-full max-w-xl bg-surface-container border border-outline rounded-xl p-gutter-xl flex flex-col gap-gutter-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-gutter-md pb-gutter-md border-b border-outline-variant">
              <div>
                <h2
                  id="employee-details-title"
                  className="font-headline text-headline-sm text-on-surface"
                >
                  {selectedEmployee.full_name}
                </h2>
                <p className="font-mono text-mono-sm text-on-surface-variant">
                  {selectedEmployee.employee_id} · {selectedEmployee.role} ·{' '}
                  <span className={statusTextClass(selectedEmployee.account_status)}>
                    {selectedEmployee.account_status}
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedEmployee(null)}
                aria-label="Close details"
                className="p-1 text-on-surface-variant hover:text-on-surface cursor-pointer"
              >
                <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                  close
                </span>
              </button>
            </div>

            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-gutter-md text-body-sm">
              <div>
                <dt className="text-on-surface-variant">Username</dt>
                <dd className="font-mono text-on-surface mt-0.5">{selectedEmployee.username}</dd>
              </div>
              <div>
                <dt className="text-on-surface-variant">Email Address</dt>
                <dd className="font-mono text-on-surface break-all mt-0.5">
                  {selectedEmployee.email}
                </dd>
              </div>
              <div>
                <dt className="text-on-surface-variant">Mobile Number</dt>
                <dd className="font-mono text-on-surface mt-0.5">
                  {selectedEmployee.mobile || '—'}
                </dd>
              </div>
              <div>
                <dt className="text-on-surface-variant">Registered On</dt>
                <dd className="font-mono text-on-surface tabular-nums mt-0.5">
                  {formatFullTimestamp(selectedEmployee.created_at)}
                </dd>
              </div>
              <div>
                <dt className="text-on-surface-variant">Approved At</dt>
                <dd className="font-mono text-on-surface tabular-nums mt-0.5">
                  {formatFullTimestamp(selectedEmployee.approved_at)}
                </dd>
              </div>
              <div>
                <dt className="text-on-surface-variant">Approved By (Admin UUID)</dt>
                <dd className="font-mono text-mono-sm text-on-surface break-all mt-0.5">
                  {selectedEmployee.approved_by ?? '—'}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-on-surface-variant">Supabase Auth User ID</dt>
                <dd className="font-mono text-mono-sm text-on-surface-variant break-all mt-0.5">
                  {selectedEmployee.auth_user_id}
                </dd>
              </div>
            </dl>

            <div className="pt-gutter-md border-t border-outline-variant flex flex-wrap items-center justify-end gap-gutter-sm">
              {selectedEmployee.auth_user_id !== currentAdmin?.auth_user_id &&
                selectedEmployee.role !== 'ADMIN' && (
                  <>
                    {selectedEmployee.account_status === 'PENDING' && (
                      <>
                        <button
                          type="button"
                          onClick={() => openConfirmation(selectedEmployee, 'APPROVE')}
                          className="px-gutter-md py-gutter-xs rounded-md bg-success text-on-success font-label text-label-md cursor-pointer"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => openConfirmation(selectedEmployee, 'REJECT')}
                          className="px-gutter-md py-gutter-xs rounded-md bg-error/15 border border-error text-error font-label text-label-md cursor-pointer"
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {selectedEmployee.account_status === 'APPROVED' && (
                      <button
                        type="button"
                        onClick={() => openConfirmation(selectedEmployee, 'SUSPEND')}
                        className="px-gutter-md py-gutter-xs rounded-md bg-error/15 border border-error text-error font-label text-label-md cursor-pointer"
                      >
                        Suspend
                      </button>
                    )}
                    {(selectedEmployee.account_status === 'SUSPENDED' ||
                      selectedEmployee.account_status === 'REJECTED') && (
                      <button
                        type="button"
                        onClick={() => openConfirmation(selectedEmployee, 'REACTIVATE')}
                        className="px-gutter-md py-gutter-xs rounded-md bg-primary text-on-primary font-label text-label-md cursor-pointer"
                      >
                        Reactivate
                      </button>
                    )}
                  </>
                )}
              <button
                type="button"
                onClick={() => setSelectedEmployee(null)}
                className="px-gutter-md py-gutter-xs rounded-md border border-outline text-on-surface-variant hover:text-on-surface font-label text-label-md cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Dialog before any administrative action */}
      {confirmAction && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-admin-action-title"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-gutter-lg"
          onClick={() => !actionLoading && setConfirmAction(null)}
        >
          <div
            className="w-full max-w-md bg-surface-container border border-outline rounded-xl p-gutter-xl flex flex-col gap-gutter-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col gap-gutter-xs">
              <h2
                id="confirm-admin-action-title"
                className="font-headline text-headline-sm text-on-surface"
              >
                Confirm{' '}
                {confirmAction.action === 'APPROVE'
                  ? 'Employee Approval'
                  : confirmAction.action === 'REACTIVATE'
                    ? 'Account Reactivation'
                    : confirmAction.action === 'REJECT'
                      ? 'Registration Rejection'
                      : 'Account Suspension'}
              </h2>
              <p className="font-body text-body-md text-on-surface-variant">
                You are about to update{' '}
                <strong className="text-on-surface">{confirmAction.employee.full_name}</strong> (
                <span className="font-mono">{confirmAction.employee.employee_id}</span>) from{' '}
                <span className="font-mono">{confirmAction.employee.account_status}</span> to{' '}
                <span className={`font-mono font-semibold ${statusTextClass(confirmAction.targetStatus)}`}>
                  {confirmAction.targetStatus}
                </span>
                .
              </p>
              {confirmAction.targetStatus === 'APPROVED' && (
                <p className="font-body text-body-sm text-on-surface-variant">
                  This will record your administrator UUID as <code className="font-mono">approved_by</code>{' '}
                  and stamp the current timestamp in <code className="font-mono">approved_at</code>,
                  granting access to the 3D Design Studio.
                </p>
              )}
              {(confirmAction.targetStatus === 'REJECTED' ||
                confirmAction.targetStatus === 'SUSPENDED') && (
                <p className="font-body text-body-sm text-on-surface-variant">
                  This immediately restricts access to the 3D Design Studio and Project Summary.
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-gutter-sm pt-gutter-sm border-t border-outline-variant">
              <button
                type="button"
                disabled={actionLoading}
                onClick={() => setConfirmAction(null)}
                className="px-gutter-md py-gutter-xs rounded-md border border-outline text-on-surface-variant hover:text-on-surface font-label text-label-md disabled:opacity-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={actionLoading}
                onClick={() => void executeConfirmedAction()}
                className={`px-gutter-lg py-gutter-xs rounded-md font-label text-label-md disabled:opacity-50 cursor-pointer ${
                  confirmAction.targetStatus === 'APPROVED'
                    ? 'bg-primary text-on-primary hover:bg-on-primary-container'
                    : 'bg-error text-on-primary hover:opacity-90'
                }`}
              >
                {actionLoading ? 'Updating...' : 'Confirm Action'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
