import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
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
import {
  ProjectCloudDrawerModal,
  ProjectConflictModal,
} from './components/ProjectCloudDrawerModal';
import { ProjectCreationInput } from './components/ProjectCreationModal';
import { ProjectSummaryPage } from './components/ProjectSummaryPage';
import { useAuth } from './context/AuthContext';
import { RouteNavigationProvider } from './context/RouteNavigationContext';
import { INITIAL_PROJECTS, siteToMeters } from './data/presets';
import { isSupabaseConfigured } from './lib/supabase';
import {
  computeProjectContentHash,
  duplicateCloudProject,
  flushPendingSyncQueue,
  hydrateProjectOverlayFromStorage,
  listCloudProjects,
  loadUserCachedProjects,
  loadUserDeletedCachedProjects,
  migrateLocalProjectsToSupabase,
  permanentlyDeleteCloudProject,
  renameCloudProject,
  resolveProjectConflict,
  restoreCloudProject,
  saveUserCachedProjects,
  saveUserDeletedCachedProjects,
  softDeleteCloudProject,
  stripTransientCloudFields,
  subscribeToUserProjectsRealtime,
  upsertCloudProject,
} from './services/cloudProjectStorage';
import { projectStorage } from './services/projectStorage';
import { AppRoute } from './types/auth';
import {
  ProjectConflictInfo,
  ProjectData,
  ScreenId,
  SiteConfig,
  ViewMode,
} from './types/design';
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
  deletedProjects: ProjectData[];
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
  | { type: 'RENAME_PROJECT'; projectId: string; newName: string }
  | { type: 'DUPLICATE_PROJECT'; project: ProjectData }
  | { type: 'DELETE_PROJECT'; projectId: string; deletedAt: string }
  | { type: 'RESTORE_PROJECT'; projectId: string; restoredProject?: ProjectData }
  | { type: 'PERMANENT_DELETE_PROJECT'; projectId: string }
  | { type: 'HYDRATE_CLOUD_PROJECTS'; activeProjects: ProjectData[]; deletedProjects: ProjectData[] }
  | { type: 'UPDATE_PROJECT_SYNC_META'; project: ProjectData }
  | { type: 'REPLACE_PROJECT_FROM_CLOUD'; project: ProjectData }
  | {
      type: 'APPLY_REMOTE_CHANGE';
      change:
        | { kind: 'upsert'; project: ProjectData }
        | { kind: 'soft-delete'; project: ProjectData }
        | { kind: 'hard-delete'; cloudId: string; clientProjectId?: string };
    };

function createInitialWorkspaceState(): WorkspaceState {
  const loaded = projectStorage.loadAll();
  const list = loaded.length > 0 ? loaded : INITIAL_PROJECTS;
  return {
    projects: list,
    deletedProjects: [],
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
        syncStatus: current.cloudId ? 'pending' : current.syncStatus,
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
      const mergedPrev: ProjectData = {
        ...previous,
        cloudId: current?.cloudId ?? previous.cloudId,
        cloudVersion: current?.cloudVersion ?? previous.cloudVersion,
        ownerUserId: current?.ownerUserId ?? previous.ownerUserId,
        updatedAt: new Date().toISOString(),
      };
      return {
        ...state,
        projects: state.projects.map((p) => (p.id === state.activeProjectId ? mergedPrev : p)),
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
      const mergedNext: ProjectData = {
        ...next,
        cloudId: current?.cloudId ?? next.cloudId,
        cloudVersion: current?.cloudVersion ?? next.cloudVersion,
        ownerUserId: current?.ownerUserId ?? next.ownerUserId,
        updatedAt: new Date().toISOString(),
      };
      return {
        ...state,
        projects: state.projects.map((p) => (p.id === state.activeProjectId ? mergedNext : p)),
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
        ...state,
        projects: [action.project, ...state.projects],
        activeProjectId: action.project.id,
        undoStack: [],
        redoStack: [],
      };
    }
    case 'DUPLICATE_PROJECT': {
      return {
        ...state,
        projects: [action.project, ...state.projects],
      };
    }
    case 'RENAME_PROJECT': {
      const trimmed = action.newName.trim();
      if (!trimmed) return state;
      return {
        ...state,
        projects: state.projects.map((p) =>
          p.id === action.projectId
            ? { ...p, name: trimmed, updatedAt: new Date().toISOString() }
            : p
        ),
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

          if (p.siteConfigured === false) {
            const { nextPoints } = createDefaultDbAndEarthingPoints(configuredProject);
            configuredProject.points = nextPoints;
          }

          return configuredProject;
        }),
      };
    }
    case 'DELETE_PROJECT': {
      const target = state.projects.find((p) => p.id === action.projectId);
      const next = state.projects.filter((p) => p.id !== action.projectId);
      const deletingActive = action.projectId === state.activeProjectId;
      const nextDeleted = target
        ? [
            { ...target, deletedAt: action.deletedAt },
            ...state.deletedProjects.filter((d) => d.id !== target.id),
          ]
        : state.deletedProjects;
      return {
        ...state,
        projects: next,
        deletedProjects: nextDeleted,
        activeProjectId: deletingActive ? next[0]?.id ?? '' : state.activeProjectId,
        undoStack: deletingActive ? [] : state.undoStack,
        redoStack: deletingActive ? [] : state.redoStack,
      };
    }
    case 'RESTORE_PROJECT': {
      const found =
        action.restoredProject ?? state.deletedProjects.find((p) => p.id === action.projectId);
      if (!found) return state;
      const restored: ProjectData = {
        ...found,
        deletedAt: null,
        updatedAt: found.updatedAt || new Date().toISOString(),
      };
      return {
        ...state,
        projects: [restored, ...state.projects.filter((p) => p.id !== restored.id)],
        deletedProjects: state.deletedProjects.filter((p) => p.id !== action.projectId),
        activeProjectId: state.activeProjectId || restored.id,
      };
    }
    case 'PERMANENT_DELETE_PROJECT': {
      return {
        ...state,
        deletedProjects: state.deletedProjects.filter((p) => p.id !== action.projectId),
      };
    }
    case 'HYDRATE_CLOUD_PROJECTS': {
      const nextActive = action.activeProjects;
      const activeStillExists = nextActive.some((p) => p.id === state.activeProjectId);
      return {
        ...state,
        projects: nextActive,
        deletedProjects: action.deletedProjects,
        activeProjectId: activeStillExists
          ? state.activeProjectId
          : nextActive[0]?.id ?? state.activeProjectId,
      };
    }
    case 'UPDATE_PROJECT_SYNC_META': {
      return {
        ...state,
        projects: state.projects.map((p) =>
          p.id === action.project.id
            ? {
                ...p,
                cloudId: action.project.cloudId ?? p.cloudId,
                ownerUserId: action.project.ownerUserId ?? p.ownerUserId,
                cloudVersion: action.project.cloudVersion ?? p.cloudVersion,
                lastSyncedAt: action.project.lastSyncedAt ?? p.lastSyncedAt,
                syncStatus: action.project.syncStatus ?? p.syncStatus,
              }
            : p
        ),
      };
    }
    case 'REPLACE_PROJECT_FROM_CLOUD': {
      const exists = state.projects.some((p) => p.id === action.project.id);
      return {
        ...state,
        projects: exists
          ? state.projects.map((p) => (p.id === action.project.id ? action.project : p))
          : [action.project, ...state.projects],
        deletedProjects: state.deletedProjects.filter((p) => p.id !== action.project.id),
      };
    }
    case 'APPLY_REMOTE_CHANGE': {
      if (action.change.kind === 'hard-delete') {
        const { cloudId, clientProjectId } = action.change;
        const match = (p: ProjectData) =>
          (cloudId && p.cloudId === cloudId) || (clientProjectId && p.id === clientProjectId);
        const nextActive = state.projects.filter((p) => !match(p));
        const nextDeleted = state.deletedProjects.filter((p) => !match(p));
        const activeRemoved = !nextActive.some((p) => p.id === state.activeProjectId);
        return {
          ...state,
          projects: nextActive,
          deletedProjects: nextDeleted,
          activeProjectId: activeRemoved ? nextActive[0]?.id ?? '' : state.activeProjectId,
        };
      }
      if (action.change.kind === 'soft-delete') {
        const remote = action.change.project;
        const nextActive = state.projects.filter(
          (p) => p.id !== remote.id && (!remote.cloudId || p.cloudId !== remote.cloudId)
        );
        const nextDeleted = [
          remote,
          ...state.deletedProjects.filter(
            (p) => p.id !== remote.id && (!remote.cloudId || p.cloudId !== remote.cloudId)
          ),
        ];
        const activeRemoved = !nextActive.some((p) => p.id === state.activeProjectId);
        return {
          ...state,
          projects: nextActive,
          deletedProjects: nextDeleted,
          activeProjectId: activeRemoved ? nextActive[0]?.id ?? '' : state.activeProjectId,
        };
      }
      // Remote upsert
      const remote = action.change.project;
      const existing = state.projects.find(
        (p) => p.id === remote.id || (remote.cloudId && p.cloudId === remote.cloudId)
      );
      if (
        existing &&
        existing.cloudVersion !== undefined &&
        remote.cloudVersion !== undefined &&
        remote.cloudVersion < existing.cloudVersion
      ) {
        return state;
      }
      const nextActive = existing
        ? state.projects.map((p) =>
            p.id === existing.id ? { ...remote, id: existing.id } : p
          )
        : [remote, ...state.projects];
      const nextDeleted = state.deletedProjects.filter(
        (p) => p.id !== remote.id && (!remote.cloudId || p.cloudId !== remote.cloudId)
      );
      return {
        ...state,
        projects: nextActive,
        deletedProjects: nextDeleted,
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
  const { projects, deletedProjects, activeProjectId, undoStack, redoStack } = workspace;
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
  const [activeConflict, setActiveConflict] = useState<ProjectConflictInfo | null>(null);
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const [cloudModalProject, setCloudModalProject] = useState<{
    projectId: string;
    tab: 'attachments' | 'versions';
  } | null>(null);

  const cloudUserId =
    isAuthenticated && user?.id && isApprovedUser(profile, user.id) ? user.id : null;
  const cloudEnabled = Boolean(cloudUserId && isSupabaseConfigured);

  const lastSyncedHashRef = useRef<Map<string, string>>(new Map());
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cloudHydratedForUserRef = useRef<string | null>(null);
  const projectsRef = useRef<ProjectData[]>(projects);
  projectsRef.current = projects;

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? INITIAL_PROJECTS[0],
    [projects, activeProjectId]
  );

  // Save offline cache (per-user when signed in; legacy localStorage when not using Supabase)
  useEffect(() => {
    if (cloudUserId && isSupabaseConfigured) {
      saveUserCachedProjects(cloudUserId, projects);
      saveUserDeletedCachedProjects(cloudUserId, deletedProjects);
    } else {
      projectStorage.saveAll(projects);
    }
  }, [projects, deletedProjects, cloudUserId]);

  const syncSingleProjectToCloud = useCallback(
    async (
      projectToSync: ProjectData,
      opts?: { changeSummary?: string; createVersionSnapshot?: boolean }
    ) => {
      if (!cloudUserId || !isSupabaseConfigured) return;
      const hash = computeProjectContentHash(projectToSync);
      if (
        !opts?.createVersionSnapshot &&
        projectToSync.cloudId &&
        lastSyncedHashRef.current.get(projectToSync.id) === hash
      ) {
        return;
      }

      const res = await upsertCloudProject(cloudUserId, projectToSync, {
        expectedVersion: projectToSync.cloudVersion,
        changeSummary: opts?.changeSummary,
        createVersionSnapshot: opts?.createVersionSnapshot,
      });

      if (res.ok && res.project) {
        lastSyncedHashRef.current.set(res.project.id, computeProjectContentHash(res.project));
        dispatchWorkspace({ type: 'UPDATE_PROJECT_SYNC_META', project: res.project });
      } else if (res.conflict) {
        setActiveConflict(res.conflict);
      } else if (res.project) {
        dispatchWorkspace({ type: 'UPDATE_PROJECT_SYNC_META', project: res.project });
      }
    },
    [cloudUserId]
  );

  // Automatic Cloud Hydration, Verified localStorage Migration, Queue Flush & Realtime Cross-Device Sync
  useEffect(() => {
    if (!cloudUserId || !isSupabaseConfigured) {
      cloudHydratedForUserRef.current = null;
      return;
    }

    let cancelled = false;

    // 1. Immediately hydrate per-user offline cache for instant startup
    const cachedActive = loadUserCachedProjects(cloudUserId);
    const cachedDeleted = loadUserDeletedCachedProjects(cloudUserId);
    if (cachedActive.length > 0 || cachedDeleted.length > 0) {
      dispatchWorkspace({
        type: 'HYDRATE_CLOUD_PROJECTS',
        activeProjects: cachedActive,
        deletedProjects: cachedDeleted,
      });
    }

    const runCloudBootstrap = async () => {
      // 2. Migrate any existing browser localStorage projects safely (verified before cleanup)
      const migration = await migrateLocalProjectsToSupabase(cloudUserId);
      if (!cancelled && migration.migratedCount > 0) {
        setRouteNotice(
          `Migrated ${migration.migratedCount} local project${migration.migratedCount === 1 ? '' : 's'} securely to Supabase cloud storage.`
        );
      }

      // 3. Flush any pending offline queue items from earlier offline edits
      const flushRes = await flushPendingSyncQueue(cloudUserId);
      if (!cancelled && flushRes.conflicts.length > 0) {
        setActiveConflict(flushRes.conflicts[0]);
      }

      // 4. Load authoritative projects from Supabase PostgreSQL
      const listRes = await listCloudProjects(cloudUserId, { includeDeleted: true });
      if (cancelled) return;

      if (listRes.ok) {
        const hydratedActive = await Promise.all(
          listRes.activeProjects.map((p) => hydrateProjectOverlayFromStorage(p))
        );
        if (cancelled) return;
        for (const p of hydratedActive) {
          lastSyncedHashRef.current.set(p.id, computeProjectContentHash(p));
        }
        cloudHydratedForUserRef.current = cloudUserId;
        dispatchWorkspace({
          type: 'HYDRATE_CLOUD_PROJECTS',
          activeProjects: hydratedActive,
          deletedProjects: listRes.deletedProjects,
        });
      }
    };

    void runCloudBootstrap();

    // 5. Subscribe to Supabase Realtime for instant cross-device sync
    const unsubscribeRealtime = subscribeToUserProjectsRealtime(cloudUserId, {
      onUpsert: (remoteProj) => {
        if (cancelled) return;
        void hydrateProjectOverlayFromStorage(remoteProj).then((ready) => {
          if (cancelled) return;
          lastSyncedHashRef.current.set(ready.id, computeProjectContentHash(ready));
          dispatchWorkspace({
            type: 'APPLY_REMOTE_CHANGE',
            change: { kind: 'upsert', project: ready },
          });
        });
      },
      onSoftDelete: (remoteProj) => {
        if (cancelled) return;
        dispatchWorkspace({
          type: 'APPLY_REMOTE_CHANGE',
          change: { kind: 'soft-delete', project: remoteProj },
        });
      },
      onHardDelete: (cloudId, clientProjectId) => {
        if (cancelled) return;
        dispatchWorkspace({
          type: 'APPLY_REMOTE_CHANGE',
          change: { kind: 'hard-delete', cloudId, clientProjectId },
        });
      },
    });

    // 6. Reconnect & tab-focus sync (flush offline queue + revalidate latest cloud state)
    const handleReconnect = () => {
      if (cancelled) return;
      void (async () => {
        const flushed = await flushPendingSyncQueue(cloudUserId);
        if (flushed.conflicts.length > 0) {
          setActiveConflict(flushed.conflicts[0]);
        }
        const refreshed = await listCloudProjects(cloudUserId, { includeDeleted: true });
        if (!cancelled && refreshed.ok) {
          for (const p of refreshed.activeProjects) {
            lastSyncedHashRef.current.set(p.id, computeProjectContentHash(p));
          }
          dispatchWorkspace({
            type: 'HYDRATE_CLOUD_PROJECTS',
            activeProjects: refreshed.activeProjects,
            deletedProjects: refreshed.deletedProjects,
          });
        }
      })();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        handleReconnect();
      }
    };

    window.addEventListener('online', handleReconnect);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      unsubscribeRealtime();
      window.removeEventListener('online', handleReconnect);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [cloudUserId]);

  // Debounced automatic cloud save for active project edits (1.5s)
  useEffect(() => {
    if (!cloudEnabled || cloudHydratedForUserRef.current !== cloudUserId) return;
    const current = projects.find((p) => p.id === activeProjectId);
    if (!current) return;
    const currentHash = computeProjectContentHash(current);
    if (current.cloudId && lastSyncedHashRef.current.get(current.id) === currentHash) {
      return;
    }

    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = setTimeout(() => {
      void syncSingleProjectToCloud(current, { changeSummary: 'Auto-save update' });
    }, 1500);

    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
      }
    };
  }, [projects, activeProjectId, cloudEnabled, cloudUserId, syncSingleProjectToCloud]);

  const navigateRoute = useCallback((target: AppRoute, replace = false) => {
    setRoute(target);
    syncBrowserPath(target, replace);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

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

  useEffect(() => {
    if (isRecoveryMode && route !== 'reset-password') {
      navigateRoute('reset-password', true);
    }
  }, [isRecoveryMode, route, navigateRoute]);

  const isAuthBusy = authLoading || profileLoading;

  useEffect(() => {
    if (isAuthBusy || isRecoveryMode || !emailVerified) return;
    if (
      !isAuthenticated &&
      (route === 'login' || route === 'register' || route === 'forgot-password')
    ) {
      navigateRoute('pending-approval', true);
    }
  }, [isAuthBusy, isRecoveryMode, emailVerified, isAuthenticated, route, navigateRoute]);

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
    if (cloudUserId && isSupabaseConfigured) {
      saveUserCachedProjects(cloudUserId, projectsRef.current);
      const current = projectsRef.current.find((p) => p.id === activeProjectId);
      if (current) {
        void syncSingleProjectToCloud(current, {
          changeSummary: 'Manual save snapshot',
          createVersionSnapshot: true,
        });
      }
    } else {
      projectStorage.saveAll(projectsRef.current);
    }
  }, [cloudUserId, activeProjectId, syncSingleProjectToCloud]);

  const handleCreateProject = useCallback(
    (input: ProjectCreationInput) => {
      if (!isAuthenticated || !isApprovedUser(profile, user?.id ?? null)) {
        setIntendedRoute('studio');
        setRouteNotice(
          'Sign in with an approved Blue Space account to create a new space in Design Studio.'
        );
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
        ownerUserId: user?.id ?? undefined,
        updatedAt: new Date().toISOString(),
      };

      dispatchWorkspace({ type: 'CREATE_PROJECT', project: newProject });
      void syncSingleProjectToCloud(newProject, {
        changeSummary: 'Created new project',
        createVersionSnapshot: true,
      });
      setStudioInitialView('2d');
      navigateRoute('studio');
    },
    [projects.length, isAuthenticated, user?.id, profile, navigateRoute, syncSingleProjectToCloud]
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
        ...stripTransientCloudFields(cloneProject(source)),
        id,
        refCode: `N3D-2026-${String(projects.length + 1).padStart(3, '0')}`,
        name: newName,
        status: 'Saved',
        ownerUserId: cloudUserId ?? undefined,
        updatedAt: new Date().toISOString(),
      };
      dispatchWorkspace({ type: 'SAVE_AS_PROJECT', project: cloned });
      void syncSingleProjectToCloud(cloned, {
        changeSummary: `Saved copy from "${source.name}"`,
        createVersionSnapshot: true,
      });
    },
    [projects, activeProjectId, cloudUserId, syncSingleProjectToCloud]
  );

  const handleRenameProject = useCallback(
    (projectId: string, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed) return;
      const target = projects.find((p) => p.id === projectId);
      if (!target) return;
      dispatchWorkspace({ type: 'RENAME_PROJECT', projectId, newName: trimmed });
      if (cloudUserId && isSupabaseConfigured) {
        void renameCloudProject(cloudUserId, target, trimmed).then((res) => {
          if (res.ok && res.project) {
            lastSyncedHashRef.current.set(res.project.id, computeProjectContentHash(res.project));
            dispatchWorkspace({ type: 'UPDATE_PROJECT_SYNC_META', project: res.project });
          } else if (res.conflict) {
            setActiveConflict(res.conflict);
          }
        });
      }
    },
    [projects, cloudUserId]
  );

  const handleDuplicateProject = useCallback(
    (projectId: string) => {
      const source = projects.find((p) => p.id === projectId);
      if (!source) return;
      const copyName = `${source.name} (Copy)`;
      const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const duplicated: ProjectData = {
        ...stripTransientCloudFields(cloneProject(source)),
        id,
        refCode: `N3D-2026-${String(projects.length + 1).padStart(3, '0')}`,
        name: copyName,
        status: 'Saved',
        ownerUserId: cloudUserId ?? undefined,
        updatedAt: new Date().toISOString(),
      };
      dispatchWorkspace({ type: 'DUPLICATE_PROJECT', project: duplicated });
      if (cloudUserId && isSupabaseConfigured) {
        void duplicateCloudProject(cloudUserId, source, copyName).then((res) => {
          if (res.ok && res.project) {
            const aligned: ProjectData = { ...res.project, id: duplicated.id };
            lastSyncedHashRef.current.set(aligned.id, computeProjectContentHash(aligned));
            dispatchWorkspace({ type: 'UPDATE_PROJECT_SYNC_META', project: aligned });
          }
        });
      }
    },
    [projects, cloudUserId]
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
        const ready: ProjectData = {
          ...stripTransientCloudFields(imported),
          id: collides ? `proj-imp-${Date.now()}` : imported.id,
          ownerUserId: user?.id ?? undefined,
          updatedAt: new Date().toISOString(),
        };

        dispatchWorkspace({ type: 'IMPORT_PROJECT', project: ready });
        void syncSingleProjectToCloud(ready, {
          changeSummary: 'Imported project file',
          createVersionSnapshot: true,
        });
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
    [projects, isAuthenticated, user?.id, profile, navigateRoute, syncSingleProjectToCloud]
  );

  const handleDeleteProject = useCallback(
    (projectId: string) => {
      const target = projects.find((p) => p.id === projectId);
      const deletedAt = new Date().toISOString();
      dispatchWorkspace({ type: 'DELETE_PROJECT', projectId, deletedAt });
      if (target && cloudUserId && isSupabaseConfigured) {
        void softDeleteCloudProject(cloudUserId, target);
      }
    },
    [projects, cloudUserId]
  );

  const handleRestoreProject = useCallback(
    (projectId: string) => {
      const target = deletedProjects.find((p) => p.id === projectId);
      if (!target) return;
      dispatchWorkspace({ type: 'RESTORE_PROJECT', projectId });
      if (cloudUserId && isSupabaseConfigured) {
        void restoreCloudProject(cloudUserId, target).then((res) => {
          if (res.ok && res.project) {
            lastSyncedHashRef.current.set(res.project.id, computeProjectContentHash(res.project));
            dispatchWorkspace({ type: 'UPDATE_PROJECT_SYNC_META', project: res.project });
          }
        });
      }
    },
    [deletedProjects, cloudUserId]
  );

  const handlePermanentlyDeleteProject = useCallback(
    (projectId: string) => {
      const target = deletedProjects.find((p) => p.id === projectId);
      dispatchWorkspace({ type: 'PERMANENT_DELETE_PROJECT', projectId });
      if (target && cloudUserId && isSupabaseConfigured) {
        void permanentlyDeleteCloudProject(cloudUserId, target);
      }
    },
    [deletedProjects, cloudUserId]
  );

  const handleResolveConflict = useCallback(
    async (strategy: 'use-cloud' | 'keep-local' | 'keep-both') => {
      if (!activeConflict || !cloudUserId) return;
      setResolvingConflict(true);
      try {
        const res = await resolveProjectConflict(cloudUserId, activeConflict, strategy);
        if (res.ok) {
          for (const resolvedProj of res.resolvedProjects) {
            lastSyncedHashRef.current.set(
              resolvedProj.id,
              computeProjectContentHash(resolvedProj)
            );
            dispatchWorkspace({ type: 'REPLACE_PROJECT_FROM_CLOUD', project: resolvedProj });
          }
          setActiveConflict(null);
        }
      } finally {
        setResolvingConflict(false);
      }
    },
    [activeConflict, cloudUserId]
  );

  const openCloudModal = useCallback((projectId: string, tab: 'attachments' | 'versions' = 'attachments') => {
    setCloudModalProject({ projectId, tab });
  }, []);

  const cloudModalTargetProject = useMemo(() => {
    if (!cloudModalProject) return null;
    return projects.find((p) => p.id === cloudModalProject.projectId) ?? null;
  }, [cloudModalProject, projects]);

  const isPublicRoute =
    route === 'login' ||
    route === 'register' ||
    route === 'forgot-password' ||
    route === 'reset-password';

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
        deletedProjects={deletedProjects}
        activeProjectId={activeProject.id}
        notice={routeNotice}
        onClearNotice={() => setRouteNotice(null)}
        onNavigate={handleNavigate}
        onNavigateRoute={(r) => navigateRoute(r)}
        onOpenProject={handleOpenProject}
        onCreateProject={handleCreateProject}
        onRenameProject={handleRenameProject}
        onDuplicateProject={handleDuplicateProject}
        onDeleteProject={handleDeleteProject}
        onRestoreProject={handleRestoreProject}
        onPermanentlyDeleteProject={handlePermanentlyDeleteProject}
        onOpenCloudFiles={(pid) => openCloudModal(pid, 'attachments')}
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
        onOpenCloudFiles={() => openCloudModal(activeProject.id, 'attachments')}
        onOpenVersionHistory={() => openCloudModal(activeProject.id, 'versions')}
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
        deletedProjects={deletedProjects}
        activeProjectId={activeProject.id}
        onNavigate={handleNavigate}
        onOpenProject={handleOpenProject}
        onCreateProject={handleCreateProject}
        onImportProject={handleImportProject}
        onRenameProject={handleRenameProject}
        onDuplicateProject={handleDuplicateProject}
        onDeleteProject={handleDeleteProject}
        onRestoreProject={handleRestoreProject}
        onPermanentlyDeleteProject={handlePermanentlyDeleteProject}
        onOpenCloudFiles={(pid) => openCloudModal(pid, 'attachments')}
      />
    );
  }

  return (
    <RouteNavigationProvider
      activeRoute={route}
      navigateRoute={(target) => navigateRoute(target)}
    >
      {content}
      {cloudModalTargetProject && (
        <ProjectCloudDrawerModal
          isOpen={Boolean(cloudModalProject)}
          project={cloudModalTargetProject}
          userId={cloudUserId}
          initialTab={cloudModalProject?.tab ?? 'attachments'}
          onClose={() => setCloudModalProject(null)}
          onVersionRestored={(restoredProj) => {
            lastSyncedHashRef.current.set(
              restoredProj.id,
              computeProjectContentHash(restoredProj)
            );
            dispatchWorkspace({ type: 'REPLACE_PROJECT_FROM_CLOUD', project: restoredProj });
          }}
        />
      )}
      <ProjectConflictModal
        conflict={activeConflict}
        resolving={resolvingConflict}
        onResolve={(strategy) => void handleResolveConflict(strategy)}
        onDismiss={() => setActiveConflict(null)}
      />
    </RouteNavigationProvider>
  );
}
