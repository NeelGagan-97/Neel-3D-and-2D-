import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { AccountStatusPage, ProfileLoadErrorPage } from './components/auth/AccountStatusPage';
import { AdminDashboardPage } from './components/auth/AdminDashboardPage';
import { AdminRouteGuard } from './components/auth/AdminRouteGuard';
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
import { INITIAL_PROJECTS, siteToMeters } from './data/presets';
import { projectStorage } from './services/projectStorage';
import { AppRoute } from './types/auth';
import { ProjectData, ScreenId, SiteConfig, ViewMode } from './types/design';
import { evaluateRouteAccess, isApprovedUser } from './utils/authValidation';
import {
  buildDefaultFloorConfigs,
  createDefaultDbAndEarthingPoints,
  createDefaultWiringConfig,
  DEFAULT_SLAB_THICKNESS_M,
  getProjectFloors,
  inferBuildingType,
} from './utils/buildingWiring';
import { parseRouteFromLocation, syncBrowserPath } from './utils/router';
import { cloneProject, MAX_HISTORY_ENTRIES } from './utils/studioEditor';

interface WorkspaceState {
  projects: ProjectData[];
  activeProjectId: string;
  undoStack: ProjectData[];
  redoStack: ProjectData[];
}

type WorkspaceAction =
  | { type: 'SWITCH_PROJECT'; projectId: string }
  | { type: 'UPDATE_PROJECT'; updater: (prev: ProjectData) => ProjectData; recordHistory: boolean }
  | { type: 'RECORD_SNAPSHOT' }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'CREATE_PROJECT'; project: ProjectData }
  | { type: 'COMPLETE_SITE_CONFIG'; site: SiteConfig }
  | { type: 'SAVE_AS_PROJECT'; project: ProjectData }
  | { type: 'IMPORT_PROJECT'; project: ProjectData }
  | { type: 'DELETE_PROJECT'; projectId: string };

function createInitialWorkspaceState(): WorkspaceState {
  const loaded = projectStorage.loadAll();
  const list = loaded.length > 0 ? loaded : INITIAL_PROJECTS;
  return {
    projects: list,
    activeProjectId: list[0]?.id ?? INITIAL_PROJECTS[0].id,
    undoStack: [],
    redoStack: [],
  };
}

function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'SWITCH_PROJECT': {
      if (action.projectId === state.activeProjectId) return state;
      return {
        ...state,
        activeProjectId: action.projectId,
        undoStack: [],
        redoStack: [],
      };
    }
    case 'RECORD_SNAPSHOT': {
      const current = state.projects.find((p) => p.id === state.activeProjectId);
      if (!current) return state;
      return {
        ...state,
        undoStack: [...state.undoStack.slice(-(MAX_HISTORY_ENTRIES - 1)), cloneProject(current)],
        redoStack: [],
      };
    }
    case 'UPDATE_PROJECT': {
      const current = state.projects.find((p) => p.id === state.activeProjectId);
      if (!current) return state;
      const nextRaw = action.updater(current);
      if (nextRaw === current) return state;
      const updated: ProjectData = {
        ...nextRaw,
        updatedAt: new Date().toISOString(),
      };
      return {
        ...state,
        projects: state.projects.map((p) => (p.id === state.activeProjectId ? updated : p)),
        undoStack: action.recordHistory
          ? [...state.undoStack.slice(-(MAX_HISTORY_ENTRIES - 1)), cloneProject(current)]
          : state.undoStack,
        redoStack: action.recordHistory ? [] : state.redoStack,
      };
    }
    case 'UNDO': {
      if (state.undoStack.length === 0) return state;
      const current = state.projects.find((p) => p.id === state.activeProjectId);
      const previous = cloneProject(state.undoStack[state.undoStack.length - 1]);
      return {
        ...state,
        projects: state.projects.map((p) => (p.id === state.activeProjectId ? previous : p)),
        undoStack: state.undoStack.slice(0, -1),
        redoStack: current
          ? [...state.redoStack.slice(-(MAX_HISTORY_ENTRIES - 1)), cloneProject(current)]
          : state.redoStack,
      };
    }
    case 'REDO': {
      if (state.redoStack.length === 0) return state;
      const current = state.projects.find((p) => p.id === state.activeProjectId);
      const next = cloneProject(state.redoStack[state.redoStack.length - 1]);
      return {
        ...state,
        projects: state.projects.map((p) => (p.id === state.activeProjectId ? next : p)),
        undoStack: current
          ? [...state.undoStack.slice(-(MAX_HISTORY_ENTRIES - 1)), cloneProject(current)]
          : state.undoStack,
        redoStack: state.redoStack.slice(0, -1),
      };
    }
    case 'CREATE_PROJECT':
    case 'SAVE_AS_PROJECT':
    case 'IMPORT_PROJECT': {
      return {
        projects: [action.project, ...state.projects],
        activeProjectId: action.project.id,
        undoStack: [],
        redoStack: [],
      };
    }
    case 'COMPLETE_SITE_CONFIG': {
      return {
        ...state,
        projects: state.projects.map((p) => {
          if (p.id !== state.activeProjectId) return p;
          const { ceilingM } = siteToMeters(action.site);
          const slabM = action.site.slabThicknessM ?? DEFAULT_SLAB_THICKNESS_M;
          const existingFloors = getProjectFloors(p);
          const hasBasement = existingFloors.some((f) => f.kind === 'basement');
          const hasTerrace = existingFloors.some((f) => f.kind === 'terrace');
          const bType = inferBuildingType(p);

          // Rebuild default elevations cleanly from finalized ceilingHeight + slabThickness
          // while preserving Basement / Terrace & matching requested floor count.
          const extraCount = (hasBasement ? 1 : 0) + (hasTerrace ? 1 : 0);
          const mainStoreys = Math.max(1, action.site.floors - extraCount);
          const rebuiltFloors = buildDefaultFloorConfigs({
            buildingType:
              hasBasement || hasTerrace || action.site.floors > 3
                ? 'custom'
                : action.site.floors === 1
                  ? 'single'
                  : action.site.floors === 2
                    ? 'duplex'
                    : action.site.floors === 3
                      ? 'triplex'
                      : bType,
            ceilingHeightM: ceilingM,
            slabThicknessM: slabM,
            customStoreys: mainStoreys,
            includeBasement: hasBasement,
            includeTerrace: hasTerrace,
          });

          // Never orphan existing elements on upper/lower floors if the user re-opens site config
          const rebuiltNums = new Set(rebuiltFloors.map((f) => f.floor));
          const preservedFloors = existingFloors.filter((ef) => {
            if (rebuiltNums.has(ef.floor)) return false;
            return (
              p.rooms.some((r) => (r.floor ?? 1) === ef.floor) ||
              p.points.some((pt) => (pt.floor ?? 1) === ef.floor) ||
              p.customWalls.some((w) => (w.floor ?? 1) === ef.floor)
            );
          });
          const mergedFloors = [...rebuiltFloors, ...preservedFloors].sort(
            (a, b) => a.elevationM - b.elevationM || a.floor - b.floor
          );

          const configuredProject: ProjectData = {
            ...p,
            buildingType:
              hasBasement || hasTerrace || mergedFloors.length > 3
                ? 'custom'
                : mergedFloors.length === 1
                  ? 'single'
                  : mergedFloors.length === 2
                    ? 'duplex'
                    : 'triplex',
            site: {
              ...action.site,
              slabThicknessM: slabM,
              floors: mergedFloors.length,
            },
            floorConfigs: mergedFloors,
            siteConfigured: true,
            updatedAt: new Date().toISOString(),
          };

          // Auto-initialize Main Distribution Board (DB-1) & Main Earthing Point (EP-1)
          // for newly configured designs (idempotent — never creates duplicates).
          if (p.siteConfigured === false) {
            const { nextPoints } = createDefaultDbAndEarthingPoints(configuredProject);
            configuredProject.points = nextPoints;
          }

          return configuredProject;
        }),
      };
    }
    case 'DELETE_PROJECT': {
      const next = state.projects.filter((p) => p.id !== action.projectId);
      const deletingActive = action.projectId === state.activeProjectId;
      return {
        projects: next,
        activeProjectId: deletingActive ? next[0]?.id ?? '' : state.activeProjectId,
        undoStack: deletingActive ? [] : state.undoStack,
        redoStack: deletingActive ? [] : state.redoStack,
      };
    }
    default:
      return state;
  }
}

export default function App() {
  const {
    isAuthenticated,
    user,
    authLoading,
    profileLoading,
    authError,
    authErrorKind,
    profile,
    profileError,
    profileErrorKind,
    isRecoveryMode,
    emailVerified,
  } = useAuth();

  const [workspace, dispatchWorkspace] = useReducer(
    workspaceReducer,
    undefined,
    createInitialWorkspaceState
  );
  const { projects, activeProjectId, undoStack, redoStack } = workspace;
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

  // Route freshly email-verified users onto the pending-approval screen when landing on entry pages
  useEffect(() => {
    if (isAuthBusy || isRecoveryMode || !emailVerified) return;
    if (
      !isAuthenticated &&
      (route === 'login' || route === 'register' || route === 'forgot-password')
    ) {
      navigateRoute('pending-approval', true);
    }
  }, [isAuthBusy, isRecoveryMode, emailVerified, isAuthenticated, route, navigateRoute]);

  // Enforce route guards reactively (covers direct URL visits, logout, expiry, and status changes)
  const accessDecision = useMemo(
    () =>
      evaluateRouteAccess(route, {
        isAuthenticated,
        isLoading: isAuthBusy,
        authUserId: user?.id ?? null,
        profile,
        profileError,
        isRecoveryMode,
        emailVerified,
      }),
    [
      route,
      isAuthenticated,
      isAuthBusy,
      user?.id,
      profile,
      profileError,
      isRecoveryMode,
      emailVerified,
    ]
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
            route === 'admin'
              ? 'Sign in with an approved administrator account to access the Admin Dashboard.'
              : 'Sign in with an approved Blue Space account to access protected design tools.'
          );
        }
      } else if (accessDecision.reason === 'unauthorized-admin') {
        setRouteNotice(
          'Access denied: Administrator privileges are required to view the Admin Dashboard.'
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
      dispatchWorkspace({ type: 'SWITCH_PROJECT', projectId });
      if (initialView) setStudioInitialView(initialView);
      navigateRoute(target);
    },
    [navigateRoute]
  );

  const handleSwitchProject = useCallback((projectId: string) => {
    dispatchWorkspace({ type: 'SWITCH_PROJECT', projectId });
  }, []);

  const handleUpdateProject = useCallback(
    (updater: (prev: ProjectData) => ProjectData, recordHistory = true) => {
      dispatchWorkspace({ type: 'UPDATE_PROJECT', updater, recordHistory });
    },
    []
  );

  const handleRecordSnapshot = useCallback(() => {
    dispatchWorkspace({ type: 'RECORD_SNAPSHOT' });
  }, []);

  const handleUndo = useCallback(() => {
    dispatchWorkspace({ type: 'UNDO' });
  }, []);

  const handleRedo = useCallback(() => {
    dispatchWorkspace({ type: 'REDO' });
  }, []);

  const handleSaveProject = useCallback(() => {
    projectStorage.saveAll(projects);
  }, [projects]);

  /**
   * Phase 1 -> Phase 2: Creates a new project with a unique ID and NO auto-generated rooms.
   * Requires an authenticated APPROVED account before entering Design Studio.
   */
  const handleCreateProject = useCallback(
    (input: ProjectCreationInput) => {
      if (!isAuthenticated || !isApprovedUser(profile, user?.id ?? null)) {
        setIntendedRoute('studio');
        setRouteNotice(
          'Sign in with an approved Blue Space account to create a new space in Design Studio.'
        );
        navigateRoute(isAuthenticated ? evaluateRouteAccess('studio', {
          isAuthenticated,
          isLoading: false,
          authUserId: user?.id ?? null,
          profile,
        }).redirectTo ?? 'login' : 'login');
        return;
      }

      const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const id = `proj-${uid}`;
      const isFeet = input.units === 'ft';
      const defaultCeilingM = isFeet ? 10 * 0.3048 : 3.0;
      const buildingType = input.buildingType ?? 'single';
      const initialFloors = buildDefaultFloorConfigs({
        buildingType,
        ceilingHeightM: defaultCeilingM,
        slabThicknessM: DEFAULT_SLAB_THICKNESS_M,
        customStoreys: input.customStoreys,
        includeBasement: input.includeBasement,
        includeTerrace: input.includeTerrace,
      });

      const newProject: ProjectData = {
        id,
        refCode: `N3D-2026-${String(projects.length + 1).padStart(3, '0')}`,
        name: input.name,
        projectType: input.projectType,
        buildingType,
        status: 'Active',
        description:
          input.description ||
          `${input.projectType} ${buildingType} architectural floor plan workspace.`,
        siteConfigured: false,
        site: {
          length: isFeet ? 40 : 12,
          width: isFeet ? 30 : 10,
          ceilingHeight: isFeet ? 10 : 3,
          wallThickness: isFeet ? 0.5 : 0.15,
          slabThicknessM: DEFAULT_SLAB_THICKNESS_M,
          units: input.units,
          floors: initialFloors.length,
        },
        floorConfigs: initialFloors,
        rooms: [],
        customWalls: [],
        openings: [],
        dimensions: [],
        furniture: [],
        staircases: [],
        points: [],
        wires: [],
        wiringConfig: createDefaultWiringConfig('IS-732'),
        updatedAt: new Date().toISOString(),
      };

      dispatchWorkspace({ type: 'CREATE_PROJECT', project: newProject });
      setStudioInitialView('2d');
      navigateRoute('studio');
    },
    [projects.length, isAuthenticated, user?.id, profile, navigateRoute]
  );

  const handleCompleteSiteConfig = useCallback((site: SiteConfig) => {
    dispatchWorkspace({ type: 'COMPLETE_SITE_CONFIG', site });
    setStudioInitialView('2d');
  }, []);

  const handleSaveAsProject = useCallback(
    (newName: string) => {
      const source = projects.find((p) => p.id === activeProjectId);
      if (!source) return;
      const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const cloned: ProjectData = {
        ...cloneProject(source),
        id,
        refCode: `N3D-2026-${String(projects.length + 1).padStart(3, '0')}`,
        name: newName,
        status: 'Saved',
        updatedAt: new Date().toISOString(),
      };
      dispatchWorkspace({ type: 'SAVE_AS_PROJECT', project: cloned });
    },
    [projects, activeProjectId]
  );

  const handleImportProject = useCallback(
    (rawJson: string): { ok: boolean; error?: string } => {
      if (!isAuthenticated || !isApprovedUser(profile, user?.id ?? null)) {
        setIntendedRoute('studio');
        setRouteNotice('Sign in with an approved account to import projects into Design Studio.');
        navigateRoute(
          isAuthenticated
            ? evaluateRouteAccess('studio', {
                isAuthenticated,
                isLoading: false,
                authUserId: user?.id ?? null,
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
            error: 'Invalid Blue Space project JSON file.',
          };
        }
        const collides = projects.some((p) => p.id === imported.id);
        const ready: ProjectData = collides
          ? { ...imported, id: `proj-imp-${Date.now()}` }
          : imported;

        dispatchWorkspace({ type: 'IMPORT_PROJECT', project: ready });
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
    [projects, isAuthenticated, user?.id, profile, navigateRoute]
  );

  const handleDeleteProject = useCallback((projectId: string) => {
    dispatchWorkspace({ type: 'DELETE_PROJECT', projectId });
  }, []);

  const isPublicRoute =
    route === 'login' ||
    route === 'register' ||
    route === 'forgot-password' ||
    route === 'reset-password';

  // Dedicated error screen for session restoration failures/timeouts on protected routes
  if (!isAuthBusy && !isPublicRoute && !isRecoveryMode && authError) {
    return (
      <RouteNavigationProvider
        activeRoute={route}
        navigateRoute={(target) => navigateRoute(target)}
      >
        <ProfileLoadErrorPage
          error={authError}
          errorKind={authErrorKind}
          onNavigateRoute={(r) => navigateRoute(r)}
          onRetry={() => {
            window.location.reload();
          }}
        />
      </RouteNavigationProvider>
    );
  }

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
      <AdminRouteGuard
        onNavigateRoute={(r) => navigateRoute(r)}
        onUnauthorized={(redirectTo, noticeMsg) => {
          if (redirectTo === 'login') {
            setIntendedRoute('admin');
          }
          if (noticeMsg) {
            setRouteNotice(noticeMsg);
          }
          navigateRoute(redirectTo, true);
        }}
      >
        <AdminDashboardPage
          onNavigate={handleNavigate}
          onNavigateRoute={(r) => navigateRoute(r)}
        />
      </AdminRouteGuard>
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
        onAiDrawingImport={(importedProject) => {
          handleImportProject(projectStorage.exportNativeBluespace(importedProject));
        }}
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
        onRecordSnapshot={handleRecordSnapshot}
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
