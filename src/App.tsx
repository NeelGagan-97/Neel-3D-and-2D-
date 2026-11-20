import { useCallback, useEffect, useMemo, useState } from 'react';
import { DesignStudioPage } from './components/DesignStudioPage';
import { HomePage } from './components/HomePage';
import { ProjectCreationInput } from './components/ProjectCreationModal';
import { ProjectSummaryPage } from './components/ProjectSummaryPage';
import { INITIAL_PROJECTS } from './data/presets';
import { projectStorage } from './services/projectStorage';
import { ProjectData, ScreenId, SiteConfig, ViewMode } from './types/design';

export default function App() {
  const [projects, setProjects] = useState<ProjectData[]>(() => projectStorage.loadAll());
  const [activeProjectId, setActiveProjectId] = useState<string>(
    () => projectStorage.loadAll()[0]?.id ?? INITIAL_PROJECTS[0].id
  );
  const [screen, setScreen] = useState<ScreenId>('home');
  const [studioInitialView, setStudioInitialView] = useState<ViewMode>('3d');

  // Undo / Redo stacks for the active project
  const [undoStack, setUndoStack] = useState<ProjectData[]>([]);
  const [redoStack, setRedoStack] = useState<ProjectData[]>([]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? INITIAL_PROJECTS[0],
    [projects, activeProjectId]
  );

  // Autosave through repository (ready for Cloudflare D1/R2 sync later)
  useEffect(() => {
    projectStorage.saveAll(projects);
  }, [projects]);

  const handleNavigate = useCallback((target: ScreenId, initialView?: ViewMode) => {
    if (initialView) setStudioInitialView(initialView);
    setScreen(target);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  const handleOpenProject = useCallback(
    (projectId: string, target: ScreenId, initialView?: ViewMode) => {
      if (projectId !== activeProjectId) {
        setActiveProjectId(projectId);
        setUndoStack([]);
        setRedoStack([]);
      }
      if (initialView) setStudioInitialView(initialView);
      setScreen(target);
      window.scrollTo({ top: 0, behavior: 'instant' });
    },
    [activeProjectId]
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
   * Opens Design Studio directly at Site Dimension Configuration (siteConfigured: false).
   */
  const handleCreateProject = useCallback(
    (input: ProjectCreationInput) => {
      const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const id = `proj-${uid}`;
      const isFeet = input.units === 'ft';

      const newProject: ProjectData = {
        id,
        refCode: `ASD-2026-${String(projects.length + 1).padStart(3, '0')}`,
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
          wallThickness: isFeet ? 0.5 : 0.15, // 6 inches or 0.15m
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
      setScreen('studio');
      window.scrollTo({ top: 0, behavior: 'instant' });
    },
    [projects.length]
  );

  /**
   * Phase 2 Completion: Locks exact site dimensions and reveals the completely blank 2D canvas.
   */
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

  /**
   * Phase 8: Save As — creates an independent cloned project with a unique ID and new name.
   */
  const handleSaveAsProject = useCallback(
    (newName: string) => {
      const source = projects.find((p) => p.id === activeProjectId);
      if (!source) return;
      const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const cloned: ProjectData = {
        ...JSON.parse(JSON.stringify(source)),
        id,
        refCode: `ASD-2026-${String(projects.length + 1).padStart(3, '0')}`,
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

  /**
   * Phase 8: Import Project JSON — restores a previously downloaded project file into the workspace.
   */
  const handleImportProject = useCallback(
    (rawJson: string): { ok: boolean; error?: string } => {
      try {
        const imported = projectStorage.parseImportedJson(rawJson);
        if (!imported) {
          return {
            ok: false,
            error: 'Invalid Ananya Space Designer project JSON file.',
          };
        }
        // Ensure imported project gets a fresh unique ID if it collides
        const collides = projects.some((p) => p.id === imported.id);
        const ready: ProjectData = collides
          ? { ...imported, id: `proj-imp-${Date.now()}` }
          : imported;

        setProjects((prev) => [ready, ...prev]);
        setActiveProjectId(ready.id);
        setUndoStack([]);
        setRedoStack([]);
        setStudioInitialView('2d');
        setScreen('studio');
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Invalid project JSON file.',
        };
      }
    },
    [projects]
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

  if (screen === 'studio') {
    return (
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
  }

  if (screen === 'summary') {
    return (
      <ProjectSummaryPage
        project={activeProject}
        onNavigate={(s) => handleNavigate(s)}
        onSaveProject={handleSaveProject}
        onUpdateProject={handleUpdateProject}
      />
    );
  }

  return (
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
