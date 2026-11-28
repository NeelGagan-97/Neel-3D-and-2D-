import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { computeProjectMetrics } from '../../data/presets';
import { AppRoute } from '../../types/auth';
import { ProjectData, ScreenId, ViewMode } from '../../types/design';
import { canViewAdminNavigation } from '../../utils/authValidation';
import { downloadProjectJson } from '../../utils/exporters';
import { Navbar } from '../Navbar';
import { ProjectCreationInput, ProjectCreationModal } from '../ProjectCreationModal';
import { AiDrawingImporterModal } from '../aiDrawing/AiDrawingImporterModal';

interface EmployeeDashboardPageProps {
  projects: ProjectData[];
  deletedProjects?: ProjectData[];
  activeProjectId: string;
  notice?: string | null;
  onClearNotice?: () => void;
  onNavigate: (screen: ScreenId, initialView?: ViewMode) => void;
  onNavigateRoute: (route: AppRoute) => void;
  onOpenProject: (projectId: string, targetScreen: ScreenId, initialView?: ViewMode) => void;
  onCreateProject: (input: ProjectCreationInput) => void;
  onRenameProject?: (projectId: string, newName: string) => void;
  onDuplicateProject?: (projectId: string) => void;
  onDeleteProject?: (projectId: string) => void;
  onRestoreProject?: (projectId: string) => void;
  onPermanentlyDeleteProject?: (projectId: string) => void;
  onOpenCloudFiles?: (projectId: string) => void;
  onAiDrawingImport?: (project: ProjectData) => void;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export const EmployeeDashboardPage: React.FC<EmployeeDashboardPageProps> = ({
  projects,
  deletedProjects = [],
  activeProjectId,
  notice,
  onClearNotice,
  onNavigate,
  onNavigateRoute,
  onOpenProject,
  onCreateProject,
  onRenameProject,
  onDuplicateProject,
  onDeleteProject,
  onRestoreProject,
  onPermanentlyDeleteProject,
  onOpenCloudFiles,
  onAiDrawingImport,
}) => {
  const { isAuthenticated, authLoading, profileLoading, user, profile, signOut } = useAuth();
  const showAdminNav = canViewAdminNavigation({
    isAuthenticated,
    isLoading: authLoading || profileLoading,
    authUserId: user?.id ?? null,
    profile,
  });
  const [showNewModal, setShowNewModal] = useState(false);
  const [showAiDrawingModal, setShowAiDrawingModal] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleSignOut = async () => {
    await signOut();
    onNavigateRoute('login');
  };

  return (
    <div className="min-h-screen flex flex-col bg-surface text-on-surface">
      <Navbar
        activeScreen="home"
        activeRoute="employee-dashboard"
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

      <main className="flex-1 max-w-7xl w-full mx-auto px-gutter-lg lg:px-gutter-xl py-gutter-2xl flex flex-col gap-gutter-2xl">
        {notice && (
          <div
            role="status"
            className="p-gutter-md rounded-md bg-secondary-container/40 border border-secondary text-on-secondary-container text-body-sm flex items-center justify-between gap-gutter-md"
          >
            <span>{notice}</span>
            {onClearNotice && (
              <button
                type="button"
                onClick={onClearNotice}
                className="text-secondary hover:underline font-label text-label-sm cursor-pointer shrink-0"
              >
                Dismiss
              </button>
            )}
          </div>
        )}

        {/* Header + Primary Actions */}
        <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-gutter-lg pb-gutter-xl border-b border-outline-variant">
          <div className="flex flex-col gap-gutter-xs">
            <div className="flex items-center gap-gutter-sm text-body-sm text-on-surface-variant font-mono">
              <span>EMPLOYEE WORKSPACE</span>
              <span aria-hidden="true">·</span>
              <span className="text-success">APPROVED ACCESS</span>
            </div>
            <h1 className="font-headline text-headline-lg-mobile lg:text-headline-lg text-on-surface text-balance">
              Welcome, {profile?.full_name ?? 'Employee'}
            </h1>
            <p className="font-body text-body-md text-on-surface-variant">
              Launch the 2D CAD &amp; 3D Residential Design Studio, create new architectural floor
              plans, or review automated electrical BOQ schedules.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-gutter-sm">
            <button
              type="button"
              onClick={() => setShowNewModal(true)}
              className="inline-flex items-center gap-gutter-xs px-gutter-lg py-gutter-sm rounded-md bg-primary text-on-primary hover:bg-on-primary-container font-label text-label-md cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                architecture
              </span>
              <span>Create New Space</span>
            </button>
            <button
              type="button"
              onClick={() => setShowAiDrawingModal(true)}
              className="inline-flex items-center gap-gutter-xs px-gutter-lg py-gutter-sm rounded-md bg-primary-container/40 border border-primary/60 text-primary hover:bg-primary hover:text-on-primary font-label text-label-md cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                auto_awesome
              </span>
              <span>AI Drawing Import</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('studio', '3d')}
              className="inline-flex items-center gap-gutter-xs px-gutter-lg py-gutter-sm rounded-md bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-md cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                view_in_ar
              </span>
              <span>3D Design Studio</span>
            </button>
            {showAdminNav && (
              <button
                type="button"
                onClick={() => onNavigateRoute('admin')}
                className="inline-flex items-center gap-gutter-xs px-gutter-lg py-gutter-sm rounded-md bg-secondary-container/40 border border-secondary text-secondary hover:bg-secondary-container/70 font-label text-label-md cursor-pointer whitespace-nowrap"
              >
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                  admin_panel_settings
                </span>
                <span>Admin Dashboard</span>
              </button>
            )}
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

        {/* Verified Employee Profile Summary */}
        <section className="bg-surface-container border border-outline-variant rounded-lg p-gutter-xl">
          <h2 className="font-headline text-headline-sm text-on-surface mb-gutter-lg">
            Employee Account Details
          </h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-gutter-lg text-body-sm">
            <div>
              <dt className="text-on-surface-variant">Employee ID</dt>
              <dd className="font-mono text-body-md text-on-surface tabular-nums mt-0.5">
                {profile?.employee_id ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-on-surface-variant">Username</dt>
              <dd className="font-mono text-body-md text-on-surface mt-0.5">
                {profile?.username ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-on-surface-variant">Email Address</dt>
              <dd className="font-mono text-body-md text-on-surface truncate mt-0.5">
                {profile?.email ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-on-surface-variant">Mobile Number</dt>
              <dd className="font-mono text-body-md text-on-surface tabular-nums mt-0.5">
                {profile?.mobile || '—'}
              </dd>
            </div>
            <div>
              <dt className="text-on-surface-variant">Assigned Role</dt>
              <dd className="font-mono text-body-md text-primary mt-0.5">
                {profile?.role ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-on-surface-variant">Account Status</dt>
              <dd className="font-mono text-body-md text-success mt-0.5">
                {profile?.account_status ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-on-surface-variant">Registered On</dt>
              <dd className="font-mono text-body-md text-on-surface tabular-nums mt-0.5">
                {formatDate(profile?.created_at)}
              </dd>
            </div>
            <div>
              <dt className="text-on-surface-variant">Approved On</dt>
              <dd className="font-mono text-body-md text-on-surface tabular-nums mt-0.5">
                {formatDate(profile?.approved_at)}
              </dd>
            </div>
          </dl>
        </section>

        {/* Active Architectural Projects */}
        <section className="flex flex-col gap-gutter-lg">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-gutter-sm">
            <div>
              <h2 className="font-headline text-headline-sm text-on-surface">
                Design Projects
              </h2>
              <p className="font-body text-body-sm text-on-surface-variant">
                Open any saved architectural floor plan directly in the 2D/3D Design Studio or
                Project Summary.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('summary')}
              className="font-label text-label-md text-primary hover:underline cursor-pointer self-start sm:self-auto whitespace-nowrap"
            >
              View Active Project Summary →
            </button>
          </div>

          <div className="bg-surface-container border border-outline-variant rounded-lg overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-outline-variant bg-surface-container-low text-label-sm font-label text-on-surface-variant">
                  <th className="py-gutter-sm px-gutter-lg">Project Name</th>
                  <th className="py-gutter-sm px-gutter-md">Site Dimensions</th>
                  <th className="py-gutter-sm px-gutter-md text-right">Rooms</th>
                  <th className="py-gutter-sm px-gutter-md text-right">Load (kW)</th>
                  <th className="py-gutter-sm px-gutter-lg text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant text-body-sm">
                {projects.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-gutter-xl px-gutter-lg text-center text-on-surface-variant">
                      No projects saved yet. Click "Create New Space" to start your first floor plan.
                    </td>
                  </tr>
                ) : (
                  projects.map((proj) => {
                    const metrics = computeProjectMetrics(proj);
                    const isCurrent = proj.id === activeProjectId;
                    return (
                      <tr key={proj.id} className="hover:bg-surface-container-high/50">
                        <td className="py-gutter-sm px-gutter-lg">
                          <div className="font-medium text-on-surface">{proj.name}</div>
                          <div className="font-mono text-mono-sm text-on-surface-variant">
                            {proj.refCode} {isCurrent ? '· Active' : ''}
                          </div>
                        </td>
                        <td className="py-gutter-sm px-gutter-md font-mono tabular-nums text-on-surface-variant">
                          {metrics.dimensionsDisplay}
                        </td>
                        <td className="py-gutter-sm px-gutter-md font-mono tabular-nums text-right text-on-surface">
                          {proj.rooms.length}
                        </td>
                        <td className="py-gutter-sm px-gutter-md font-mono tabular-nums text-right text-secondary">
                          {metrics.totalKw.toFixed(2)}
                        </td>
                        <td className="py-gutter-sm px-gutter-lg text-right">
                          <div className="inline-flex items-center gap-gutter-xs">
                            <button
                              type="button"
                              onClick={() => onOpenProject(proj.id, 'studio', '2d')}
                              className="px-gutter-sm py-1 rounded-sm bg-primary-container border border-primary text-primary hover:bg-primary hover:text-on-primary font-label text-label-sm cursor-pointer whitespace-nowrap"
                            >
                              2D / 3D Studio
                            </button>
                            <button
                              type="button"
                              onClick={() => onOpenProject(proj.id, 'summary')}
                              className="px-gutter-sm py-1 rounded-sm bg-surface-container-low border border-outline text-on-surface-variant hover:text-on-surface hover:border-primary font-label text-label-sm cursor-pointer whitespace-nowrap"
                            >
                              Summary
                            </button>
                            <button
                              type="button"
                              onClick={() => downloadProjectJson(proj)}
                              title="Download Project JSON"
                              aria-label={`Download ${proj.name}`}
                              className="p-1.5 rounded-sm border border-outline-variant text-on-surface-variant hover:text-secondary hover:border-secondary cursor-pointer"
                            >
                              <span className="material-symbols-outlined text-[17px]" aria-hidden="true">
                                download
                              </span>
                            </button>
                            {onRenameProject && (
                              renamingId === proj.id ? (
                                <form
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    const trimmed = renameDraft.trim();
                                    if (trimmed) onRenameProject(proj.id, trimmed);
                                    setRenamingId(null);
                                  }}
                                  className="inline-flex items-center gap-1"
                                >
                                  <input
                                    type="text"
                                    value={renameDraft}
                                    onChange={(e) => setRenameDraft(e.target.value)}
                                    autoFocus
                                    aria-label="Rename project"
                                    className="w-36 px-2 py-1 rounded-sm bg-surface-container-low border border-primary text-on-surface text-label-sm"
                                  />
                                  <button
                                    type="submit"
                                    title="Save Name"
                                    className="p-1 rounded-sm bg-primary text-on-primary cursor-pointer"
                                  >
                                    <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
                                      check
                                    </span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setRenamingId(null)}
                                    title="Cancel"
                                    className="p-1 rounded-sm border border-outline-variant text-on-surface-variant cursor-pointer"
                                  >
                                    <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
                                      close
                                    </span>
                                  </button>
                                </form>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRenamingId(proj.id);
                                    setRenameDraft(proj.name);
                                  }}
                                  title="Rename Project"
                                  aria-label={`Rename ${proj.name}`}
                                  className="p-1.5 rounded-sm border border-outline-variant text-on-surface-variant hover:text-primary hover:border-primary cursor-pointer"
                                >
                                  <span className="material-symbols-outlined text-[17px]" aria-hidden="true">
                                    drive_file_rename_outline
                                  </span>
                                </button>
                              )
                            )}
                            {onDuplicateProject && (
                              <button
                                type="button"
                                onClick={() => onDuplicateProject(proj.id)}
                                title="Duplicate Project"
                                aria-label={`Duplicate ${proj.name}`}
                                className="p-1.5 rounded-sm border border-outline-variant text-on-surface-variant hover:text-primary hover:border-primary cursor-pointer"
                              >
                                <span className="material-symbols-outlined text-[17px]" aria-hidden="true">
                                  content_copy
                                </span>
                              </button>
                            )}
                            {onOpenCloudFiles && (
                              <button
                                type="button"
                                onClick={() => onOpenCloudFiles(proj.id)}
                                title="Cloud Attachments & Versions"
                                aria-label={`Cloud files for ${proj.name}`}
                                className="p-1.5 rounded-sm border border-outline-variant text-on-surface-variant hover:text-primary hover:border-primary cursor-pointer"
                              >
                                <span className="material-symbols-outlined text-[17px]" aria-hidden="true">
                                  cloud_queue
                                </span>
                              </button>
                            )}
                            {onDeleteProject && (
                              confirmDeleteId === proj.id ? (
                                <span className="inline-flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setConfirmDeleteId(null);
                                      onDeleteProject(proj.id);
                                    }}
                                    title="Confirm Delete"
                                    className="p-1 rounded-sm bg-error text-on-primary cursor-pointer"
                                  >
                                    <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
                                      check
                                    </span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteId(null)}
                                    title="Cancel"
                                    className="p-1 rounded-sm border border-outline-variant text-on-surface-variant cursor-pointer"
                                  >
                                    <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
                                      close
                                    </span>
                                  </button>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(proj.id)}
                                  title="Delete Project"
                                  aria-label={`Delete ${proj.name}`}
                                  className="p-1.5 rounded-sm border border-outline-variant text-error hover:border-error cursor-pointer"
                                >
                                  <span className="material-symbols-outlined text-[17px]" aria-hidden="true">
                                    delete
                                  </span>
                                </button>
                              )
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

          {deletedProjects.length > 0 && (
            <div className="p-gutter-md border-t border-outline-variant bg-surface-container-low flex flex-col gap-gutter-sm">
              <div className="font-title text-title-sm text-on-surface">
                Recently Deleted Projects ({deletedProjects.length})
              </div>
              <div className="flex flex-col gap-gutter-xs">
                {deletedProjects.map((delProj) => (
                  <div
                    key={delProj.id}
                    className="px-gutter-md py-gutter-sm rounded-sm bg-surface-container border border-outline-variant flex flex-wrap items-center justify-between gap-gutter-sm"
                  >
                    <div>
                      <span className="font-title text-title-sm text-on-surface">{delProj.name}</span>
                      <span className="ml-2 font-mono text-mono-sm text-on-surface-variant">
                        {delProj.refCode}
                      </span>
                    </div>
                    <div className="flex items-center gap-gutter-xs">
                      {onRestoreProject && (
                        <button
                          type="button"
                          onClick={() => onRestoreProject(delProj.id)}
                          className="px-gutter-sm py-1 rounded-sm bg-primary-container border border-primary text-primary hover:bg-primary hover:text-on-primary font-label text-label-sm cursor-pointer"
                        >
                          Restore
                        </button>
                      )}
                      {onPermanentlyDeleteProject && (
                        <button
                          type="button"
                          onClick={() => onPermanentlyDeleteProject(delProj.id)}
                          className="px-gutter-sm py-1 rounded-sm border border-outline-variant text-error hover:border-error font-label text-label-sm cursor-pointer"
                        >
                          Delete Permanently
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>

      {showNewModal && (
        <ProjectCreationModal
          onCancel={() => setShowNewModal(false)}
          onCreate={(input) => {
            setShowNewModal(false);
            onCreateProject(input);
          }}
        />
      )}

      <AiDrawingImporterModal
        isOpen={showAiDrawingModal}
        onClose={() => setShowAiDrawingModal(false)}
        onImportComplete={(result) => {
          onAiDrawingImport?.(result.project);
        }}
      />
    </div>
  );
};
