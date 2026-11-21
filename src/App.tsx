import { useCallback, useEffect, useMemo, useState } from 'react';
import { AccountStatusPage, ProfileLoadErrorPage } from './components/auth/AccountStatusPage';
import { AdminDashboardPage } from './components/auth/AdminDashboardPage';
import { EmployeeDashboardPage } from './components/auth/EmployeeDashboardPage';
import { LoginPage } from './components/auth/LoginPage';
import {
  ForgotPasswordPage,
  ResetPasswordPage,
} from './components/auth/PasswordResetPages';
import { RegisterPage } from './components/auth/RegisterPage';
import { DesignStudioPage } from './components/DesignStudioPage';
import { HomePage } from './components/HomePage';
import { ProjectCreationInput } from './components/ProjectCreationModal';
import { ProjectSummaryPage } from './components/ProjectSummaryPage';
import { useAuth } from './context/AuthContext';
import { RouteNavigationProvider } from './context/RouteNavigationContext';
import { INITIAL_PROJECTS } from './data/presets';
import { projectStorage } from './services/projectStorage';
import { AppRoute } from './types/auth';
import { ProjectData, ScreenId, SiteConfig, ViewMode } from './types/design';
import { evaluateRouteAccess, isApprovedUser } from './utils/authValidation';
import { parseRouteFromLocation, syncBrowserPath } from './utils/router';

export default function App() {
  const {
    isAuthenticated,
    authLoading,
    profileLoading,
    profile,
    profileError,
    profileErrorKind,
    isRecoveryMode,
  } = useAuth();

  const [projects, setProjects] = useState<ProjectData[]>(() => projectStorage.loadAll());
  const [activeProjectId, setActiveProjectId] = useState<string>(
    () => projectStorage.loadAll()[0]?.id ?? INITIAL_PROJECTS[0].id
  );
  const [route, setRoute] = useState<AppRoute>(() =>
    typeof window !== 'undefined'
      ? parseRouteFromLocation(
          window.location.pathname,
          window.location.search,
          window.location.hash
        )
      : 'login'
  );
  const [intendedRoute, setIntendedRoute] = useState<AppRoute | null>(null);
  const [routeNotice, setRouteNotice] = useState<string | null>(null);
  const [studioInitialView, setStudioInitialView] = useState<ViewMode>('3d');

  // Undo / Redo stacks for the active project
  const [undoStack, setUndoStack] = useState<ProjectData[]>([]);
  const [redoStack, setRedoStack] = useState<ProjectData[]>([]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? INITIAL_PROJECTS[0],
    [projects, activeProjectId]
  );

  // Autosave through repository
  useEffect(() => {
    projectStorage.saveAll(projects);
  }, [projects]);

  const navigateRoute = useCallback((target: AppRoute, replace = false) => {
    setRoute(target);
    syncBrowserPath(target, replace);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  // Listen to browser Back / Forward navigation (direct URL access)
  useEffect(() => {
    const onPopState = () => {
      const next = parseRouteFromLocation(
        window.location.pathname,
        window.location.search,
        window.location.hash
      );
      setRoute(next);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Route into password reset screen when Supabase emits PASSWORD_RECOVERY
  useEffect(() => {
    if (isRecoveryMode && route !== 'reset-password') {
      navigateRoute('reset-password', true);
    }
  }, [isRecoveryMode, route, navigateRoute]);

  const isAuthBusy = authLoading || profileLoading;

  // Enforce route guards reactively (covers direct URL visits, logout, expiry, and status changes)
  const accessDecision = useMemo(
    () =>
      evaluateRouteAccess(route, {
        isAuthenticated,
        isLoading: isAuthBusy,
        profile,
        profileError,
        isRecoveryMode,
      }),
    [route, isAuthenticated, isAuthBusy, profile, profileError, isRecoveryMode]
  );

  useEffect(() => {
    if (isAuthBusy) return;
    if (!accessDecision.allowed && accessDecision.redirectTo) {
      if (accessDecision.reason === 'unauthenticated') {
        if (route === 'home') {
          setIntendedRoute('home');
        } else if (
          route === 'studio' ||
          route === 'summary' ||
          route === 'employee-dashboard' ||
          route === 'admin'
        ) {
          setIntendedRoute(route);
          setRouteNotice(
            'Sign in with an approved Neel 3D Space account to access protected design tools.'
          );
        }
      } else if (accessDecision.reason === 'unauthorized-admin') {
        setRouteNotice(
          'Administrator privileges are required to view the Admin Dashboard.'
        );
      }
      navigateRoute(accessDecision.redirectTo, true);
    }
  }, [isAuthBusy, accessDecision, route, navigateRoute]);

  const handleNavigate = useCallback(
    (target: ScreenId, initialView?: ViewMode) => {
      if (initialView) setStudioInitialView(initialView);
      navigateRoute(target);
    },
    [navigateRoute]
  );

  const handleOpenProject = useCallback(
    (projectId: string, target: ScreenId, initialView?: ViewMode) => {
      if (projectId !== activeProjectId) {
        setActiveProjectId(projectId);
        setUndoStack([]);
        setRedoStack([]);
      }
      if (initialView) setStudioInitialView(initialView);
      navigateRoute(target);
    },
    [activeProjectId, navigateRoute]
  );

  const handleSwitchProject = useCallback((projectId: string) => {
    setActiveProjectId(projectId);
    setUndoStack([]);
    setRedoStack([]);
  }, []);

  const handleUpdateProject = useCallback(
    (updater: (prev: ProjectData) => ProjectData, recordHistory = true) => {
      setProjects((prevList) => {
        const current = prevList.find((p) => p.id === activeProjectId);
        if (!current) return prevList;
        if (recordHistory) {
          setUndoStack((u) => [...u.slice(-24), current]);
          setRedoStack([]);
        }
        const updated = {
          ...updater(current),
          updatedAt: new Date().toISOString(),
        };
        return prevList.map((p) => (p.id === activeProjectId ? updated : p));
      });
    },
    [activeProjectId]
  );

  const handleUndo = useCallback(() => {
    setUndoStack((prevUndo) => {
      if (prevUndo.length === 0) return prevUndo;
      const previous = prevUndo[prevUndo.length - 1];
      setProjects((prevList) => {
        const current = prevList.find((p) => p.id === activeProjectId);
        if (current) setRedoStack((r) => [...r, current]);
        return prevList.map((p) => (p.id === activeProjectId ? previous : p));
      });
      return prevUndo.slice(0, -1);
    });
  }, [activeProjectId]);

  const handleRedo = useCallback(() => {
    setRedoStack((prevRedo) => {
      if (prevRedo.length === 0) return prevRedo;
      const next = prevRedo[prevRedo.length - 1];
      setProjects((prevList) => {
        const current = prevList.find((p) => p.id === activeProjectId);
        if (current) setUndoStack((u) => [...u, current]);
        return prevList.map((p) => (p.id === activeProjectId ? next : p));
      });
      return prevRedo.slice(0, -1);
    });
  }, [activeProjectId]);

  const handleSaveProject = useCallback(() => {
    projectStorage.saveAll(projects);
  }, [projects]);

  /**
   * Phase 1 -> Phase 2: Creates a new project with a unique ID and NO auto-generated rooms.
   * Requires an authenticated APPROVED account before entering Design Studio.
   */
  const handleCreateProject = useCallback(
    (input: ProjectCreationInput) => {
      if (!isAuthenticated || !isApprovedUser(profile)) {
        setIntendedRoute('studio');
        setRouteNotice(
          'Sign in with an approved Neel 3D Space account to create a new space in Design Studio.'
        );
        navigateRoute(isAuthenticated ? evaluateRouteAccess('studio', {
          isAuthenticated,
          isLoading: false,
          profile,
        }).redirectTo ?? 'login' : 'login');
        return;
      }

      const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const id = `proj-${uid}`;
      const isFeet = input.units === 'ft';

      const newProject: ProjectData = {
        id,
        refCode: `N3D-2026-${String(projects.length + 1).padStart(3, '0')}`,
        name: input.name,
        projectType: input.projectType,
        status: 'Active',
        description:
          input.description ||
          `${input.projectType} architectural floor plan workspace.`,
        siteConfigured: false,
        site: {
          length: isFeet ? 40 : 12,
          width: isFeet ? 30 : 10,
          ceilingHeight: isFeet ? 10 : 3,
          wallThickness: isFeet ? 0.5 : 0.15,
          units: input.units,
          floors: 1,
        },
        rooms: [],
        customWalls: [],
        openings: [],
        dimensions: [],
        furniture: [],
        points: [],
        updatedAt: new Date().toISOString(),
      };

      setProjects((prev) => [newProject, ...prev]);
      setActiveProjectId(id);
      setUndoStack([]);
      setRedoStack([]);
      setStudioInitialView('2d');
      navigateRoute('studio');
    },
    [projects.length, isAuthenticated, profile, navigateRoute]
  );

  const handleCompleteSiteConfig = useCallback(
    (site: SiteConfig) => {
      setProjects((prev) =>
        prev.map((p) =>
          p.id === activeProjectId
            ? {
                ...p,
                site,
                siteConfigured: true,
                updatedAt: new Date().toISOString(),
              }
            : p
        )
      );
      setStudioInitialView('2d');
    },
    [activeProjectId]
  );

  const handleSaveAsProject = useCallback(
    (newName: string) => {
      const source = projects.find((p) => p.id === activeProjectId);
      if (!source) return;
      const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const cloned: ProjectData = {
        ...JSON.parse(JSON.stringify(source)),
        id,
        refCode: `N3D-2026-${String(projects.length + 1).padStart(3, '0')}`,
        name: newName,
        status: 'Saved',
        updatedAt: new Date().toISOString(),
      };
      setProjects((prev) => [cloned, ...prev]);
      setActiveProjectId(id);
      setUndoStack([]);
      setRedoStack([]);
    },
    [projects, activeProjectId]
  );

  const handleImportProject = useCallback(
    (rawJson: string): { ok: boolean; error?: string } => {
      if (!isAuthenticated || !isApprovedUser(profile)) {
        setIntendedRoute('studio');
        setRouteNotice('Sign in with an approved account to import projects into Design Studio.');
        navigateRoute(
          isAuthenticated
            ? evaluateRouteAccess('studio', {
                isAuthenticated,
                isLoading: false,
                profile,
              }).redirectTo ?? 'login'
            : 'login'
        );
        return { ok: false, error: 'Approved employee sign-in is required to import projects.' };
      }

      try {
        const imported = projectStorage.parseImportedJson(rawJson);
        if (!imported) {
          return {
            ok: false,
            error: 'Invalid Neel 3D Space project JSON file.',
          };
        }
        const collides = projects.some((p) => p.id === imported.id);
        const ready: ProjectData = collides
          ? { ...imported, id: `proj-imp-${Date.now()}` }
          : imported;

        setProjects((prev) => [ready, ...prev]);
        setActiveProjectId(ready.id);
        setUndoStack([]);
        setRedoStack([]);
        setStudioInitialView('2d');
        navigateRoute('studio');
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Invalid project JSON file.',
        };
      }
    },
    [projects, isAuthenticated, profile, navigateRoute]
  );

  const handleDeleteProject = useCallback(
    (projectId: string) => {
      setProjects((prev) => {
        const next = prev.filter((p) => p.id !== projectId);
        if (projectId === activeProjectId) {
          setActiveProjectId(next[0]?.id ?? '');
          setUndoStack([]);
          setRedoStack([]);
        }
        return next;
      });
    },
    [activeProjectId]
  );

  const isPublicRoute =
    route === 'login' ||
    route === 'register' ||
    route === 'forgot-password' ||
    route === 'reset-password';

  // Dedicated error screen for RLS / network / database / auth errors while fetching employee_profiles
  // Never mislabels a database or permission failure as "Employee Profile Not Found"
  if (!isAuthBusy && isAuthenticated && !isRecoveryMode && !profile && profileError) {
    return (
      <RouteNavigationProvider
        activeRoute={route}
        navigateRoute={(target) => navigateRoute(target)}
      >
        <ProfileLoadErrorPage
          error={profileError}
          errorKind={profileErrorKind}
          onNavigateRoute={(r) => navigateRoute(r)}
        />
      </RouteNavigationProvider>
    );
  }

  // Show loading screen when verifying session/profile for protected routes (prevents unauthorized flash)
  if ((isAuthBusy && !isPublicRoute) || (!isAuthBusy && !accessDecision.allowed)) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-surface text-on-surface gap-gutter-md p-gutter-xl">
        <span className="material-symbols-outlined text-primary text-[32px] animate-spin" aria-hidden="true">
          progress_activity
        </span>
        <p className="font-mono text-mono-md text-on-surface-variant">
          {isAuthBusy ? 'Verifying session and employee permissions...' : 'Redirecting...'}
        </p>
      </div>
    );
  }

  let content: React.ReactNode;

  if (route === 'login') {
    content = (
      <LoginPage
        onNavigateRoute={(r) => {
          setIntendedRoute(null);
          navigateRoute(r);
        }}
        intendedRoute={intendedRoute}
        notice={routeNotice}
        onClearNotice={() => setRouteNotice(null)}
      />
    );
  } else if (route === 'register') {
    content = <RegisterPage onNavigateRoute={(r) => navigateRoute(r)} />;
  } else if (route === 'forgot-password') {
    content = <ForgotPasswordPage onNavigateRoute={(r) => navigateRoute(r)} />;
  } else if (route === 'reset-password') {
    content = (
      <ResetPasswordPage
        onNavigateRoute={(r) => navigateRoute(r)}
        onResetSuccess={() =>
          setRouteNotice('Password updated successfully. Sign in with your new password.')
        }
      />
    );
  } else if (
    route === 'pending-approval' ||
    route === 'account-rejected' ||
    route === 'account-suspended' ||
    route === 'profile-missing'
  ) {
    content = <AccountStatusPage variant={route} onNavigateRoute={(r) => navigateRoute(r)} />;
  } else if (route === 'admin') {
    content = (
      <AdminDashboardPage
        onNavigate={handleNavigate}
        onNavigateRoute={(r) => navigateRoute(r)}
      />
    );
  } else if (route === 'employee-dashboard') {
    content = (
      <EmployeeDashboardPage
        projects={projects}
        activeProjectId={activeProject.id}
        notice={routeNotice}
        onClearNotice={() => setRouteNotice(null)}
        onNavigate={handleNavigate}
        onNavigateRoute={(r) => navigateRoute(r)}
        onOpenProject={handleOpenProject}
        onCreateProject={handleCreateProject}
      />
    );
  } else if (route === 'studio') {
    content = (
      <DesignStudioPage
        key={`${activeProject.id}-${activeProject.siteConfigured ? 'ready' : 'setup'}`}
        projects={projects.length > 0 ? projects : [activeProject]}
        project={activeProject}
        initialViewMode={studioInitialView}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        onNavigate={(s) => handleNavigate(s)}
        onSwitchProject={handleSwitchProject}
        onUpdateProject={handleUpdateProject}
        onCompleteSiteConfig={handleCompleteSiteConfig}
        onSaveAsProject={handleSaveAsProject}
        onImportProject={handleImportProject}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onSaveProject={handleSaveProject}
      />
    );
  } else if (route === 'summary') {
    content = (
      <ProjectSummaryPage
        project={activeProject}
        onNavigate={(s) => handleNavigate(s)}
        onSaveProject={handleSaveProject}
        onUpdateProject={handleUpdateProject}
      />
    );
  } else {
    content = (
      <HomePage
        projects={projects}
        activeProjectId={activeProject.id}
        onNavigate={handleNavigate}
        onOpenProject={handleOpenProject}
        onCreateProject={handleCreateProject}
        onImportProject={handleImportProject}
        onDeleteProject={handleDeleteProject}
      />
    );
  }

  return (
    <RouteNavigationProvider
      activeRoute={route}
      navigateRoute={(target) => navigateRoute(target)}
    >
      {content}
    </RouteNavigationProvider>
  );
}
