import React, { useRef, useState } from 'react';
import { computeProjectMetrics, INITIAL_PROJECTS } from '../data/presets';
import { ParsedImportPreview, projectStorage } from '../services/projectStorage';
import { ProjectData, ScreenId, ViewMode } from '../types/design';
import { downloadProjectJson } from '../utils/exporters';
import { DrawingInstructionsModal } from './DrawingInstructionsModal';
import { FloorPlan2D } from './FloorPlan2D';
import { ImportProjectPreviewModal } from './ImportProjectPreviewModal';
import { Navbar } from './Navbar';
import { ProjectCreationInput, ProjectCreationModal } from './ProjectCreationModal';
import { Viewport3D } from './Viewport3D';

interface HomePageProps {
  projects: ProjectData[];
  activeProjectId: string;
  onNavigate: (screen: ScreenId, initialView?: ViewMode) => void;
  onOpenProject: (projectId: string, targetScreen: ScreenId, initialView?: ViewMode) => void;
  onCreateProject: (input: ProjectCreationInput) => void;
  onImportProject: (rawJson: string) => { ok: boolean; error?: string };
  onDeleteProject: (projectId: string) => void;
}

export const HomePage: React.FC<HomePageProps> = ({
  projects,
  activeProjectId,
  onNavigate,
  onOpenProject,
  onCreateProject,
  onImportProject,
  onDeleteProject,
}) => {
  const [showNewModal, setShowNewModal] = useState(false);
  const [showGuideModal, setShowGuideModal] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<ParsedImportPreview | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const heroProject =
    projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? INITIAL_PROJECTS[0];
  const heroMetrics = computeProjectMetrics(heroProject);
  const heroUnitSuffix = heroProject.site.units === 'ft' ? "'" : 'm';

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result ?? '');
      const preview = projectStorage.parseNativeProjectFile(raw);
      if (!preview) {
        setImportError('Could not parse project file. Please select a valid .bluespace or .json project.');
        return;
      }
      setImportError(null);
      setImportPreview(preview);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleConfirmSafeImport = (finalName: string) => {
    if (!importPreview) return;
    const renamed: ProjectData = {
      ...importPreview.project,
      name: finalName,
    };
    const res = onImportProject(projectStorage.exportNativeBluespace(renamed));
    setImportPreview(null);
    if (!res.ok) {
      setImportError(res.error ?? 'Could not import project file.');
    } else {
      setImportError(null);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-surface text-on-surface">
      <Navbar
        activeScreen="home"
        onNavigate={(s) => onNavigate(s)}
        rightSlot={
          <button
            type="button"
            onClick={() => onNavigate('studio', '3d')}
            className="inline-flex items-center justify-center gap-gutter-sm bg-primary text-on-primary px-gutter-lg py-gutter-sm rounded-md font-label text-label-md transition-colors duration-state-change hover:bg-on-primary-container cursor-pointer whitespace-nowrap"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              add_box
            </span>
            <span>Launch Studio</span>
          </button>
        }
      />

      <main className="flex-1">
        {/* Hero Section */}
        <section className="border-b border-outline-variant bg-surface-container-low overflow-x-clip">
          <div className="max-w-7xl mx-auto px-gutter-lg lg:px-gutter-xl py-section">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-gutter-2xl items-center">
              <div className="lg:col-span-5 flex flex-col gap-gutter-lg">
                <div className="inline-flex items-center gap-gutter-sm self-start px-gutter-md py-gutter-xs rounded-full bg-surface-container-high border border-outline">
                  <span className="material-symbols-outlined text-secondary text-[16px]" aria-hidden="true">
                    bolt
                  </span>
                  <span className="font-mono text-mono-sm text-on-surface-variant uppercase">
                    2D CAD • 3D BIM • Electrical BOQ
                  </span>
                </div>

                <h1 className="font-display text-display-lg-mobile lg:text-display-lg text-on-surface text-balance">
                  Design Your Home. Plan Every Electrical Detail.
                </h1>

                <p className="font-body text-body-lg text-on-surface-variant text-pretty max-w-prose">
                  Precision architectural floor planning paired with real-time 3D residential visualization, circuit-level electrical placement, connected load calculation, and automated Bill of Quantities.
                </p>

                <div className="flex flex-wrap items-center gap-gutter-md pt-gutter-sm">
                  <button
                    type="button"
                    onClick={() => setShowNewModal(true)}
                    className="inline-flex items-center justify-center gap-gutter-sm bg-primary text-on-primary px-gutter-xl py-gutter-md rounded-md font-label text-label-lg transition-colors duration-state-change hover:bg-on-primary-container focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary cursor-pointer whitespace-nowrap"
                  >
                    <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                      architecture
                    </span>
                    <span>CREATE YOUR OWN SPACE</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onNavigate('studio', '3d')}
                    className="inline-flex items-center justify-center gap-gutter-sm bg-surface-container-high text-on-surface border border-outline px-gutter-xl py-gutter-md rounded-md font-label text-label-lg transition-colors duration-state-change hover:border-primary hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary cursor-pointer whitespace-nowrap"
                  >
                    <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                      view_in_ar
                    </span>
                    <span>EXPLORE 3D DESIGN</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowGuideModal(true)}
                    className="inline-flex items-center justify-center gap-gutter-sm bg-surface-container text-primary border border-primary/60 px-gutter-lg py-gutter-sm rounded-md font-label text-label-md transition-colors duration-state-change hover:bg-primary-container/30 hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary cursor-pointer whitespace-nowrap"
                  >
                    <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                      menu_book
                    </span>
                    <span>HOW TO WORK ON DRAWINGS</span>
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-gutter-md pt-gutter-lg border-t border-outline-variant">
                  <div className="flex flex-col gap-gutter-xs">
                    <span className="font-mono text-headline-sm text-primary tabular-nums">0.1m</span>
                    <span className="font-body text-body-sm text-on-surface-variant">Snap Grid Accuracy</span>
                  </div>
                  <div className="flex flex-col gap-gutter-xs">
                    <span className="font-mono text-headline-sm text-secondary tabular-nums">230V</span>
                    <span className="font-body text-body-sm text-on-surface-variant">IS-Standard Circuits</span>
                  </div>
                  <div className="flex flex-col gap-gutter-xs">
                    <span className="font-mono text-headline-sm text-on-surface tabular-nums">Instant</span>
                    <span className="font-body text-body-sm text-on-surface-variant">Room-Wise BOQ</span>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-7">
                <div className="bg-surface-container border border-outline rounded-xl overflow-hidden lg:translate-x-4 xl:translate-x-6">
                  <div className="px-gutter-lg py-gutter-sm border-b border-outline-variant bg-surface-container-high flex items-center justify-between gap-gutter-sm">
                    <div className="flex items-center gap-gutter-sm min-w-0">
                      <span className="material-symbols-outlined text-primary text-[18px]" aria-hidden="true">
                        view_in_ar
                      </span>
                      <span className="font-mono text-mono-sm text-on-surface truncate uppercase">
                        3D VIEWPORT · {heroProject.name}
                      </span>
                    </div>
                    <span className="font-mono text-mono-sm text-secondary tabular-nums shrink-0">
                      {heroProject.site.length}{heroUnitSuffix} × {heroProject.site.width}{heroUnitSuffix} • {heroMetrics.totalKw.toFixed(2)} kW
                    </span>
                  </div>
                  <div className="relative aspect-video bg-surface">
                    <Viewport3D
                      project={heroProject}
                      previewOnly={true}
                      lightingMode="daylight"
                      showPins={false}
                    />
                    <div className="pointer-events-none absolute bottom-3 right-3 px-gutter-sm py-gutter-xs rounded-sm bg-surface-container border border-outline text-on-surface-variant font-mono text-mono-sm">
                      Drag to Orbit 3D Cutaway
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Core Capabilities: 4 Feature Cards */}
        <section className="max-w-7xl mx-auto px-gutter-lg lg:px-gutter-xl py-section">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-gutter-md mb-gutter-2xl">
            <div className="flex flex-col gap-gutter-xs">
              <h2 className="font-headline text-headline-lg-mobile lg:text-headline-lg text-on-surface">
                Engineering Capabilities
              </h2>
              <p className="font-body text-body-md text-on-surface-variant max-w-prose">
                Unified architectural drafting and electrical load estimation inside one browser workspace.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('studio', '3d')}
              className="font-label text-label-md text-primary hover:underline inline-flex items-center gap-gutter-xs cursor-pointer self-start md:self-auto"
            >
              <span>Open Design Studio</span>
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                arrow_forward
              </span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-gutter-lg items-stretch">
            <article className="bg-surface-container border border-outline-variant rounded-lg p-gutter-xl flex flex-col gap-gutter-md h-full">
              <header className="flex items-center justify-between gap-gutter-md">
                <div className="w-10 h-10 rounded-md bg-primary-container border border-primary flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-primary text-[22px]" aria-hidden="true">
                    floor_lamp
                  </span>
                </div>
                <span className="font-mono text-mono-sm text-on-surface-variant">2D CAD</span>
              </header>
              <div className="flex flex-col gap-gutter-xs">
                <h3 className="font-headline text-headline-sm text-on-surface">Custom Floor Plans</h3>
                <p className="font-body text-body-md text-on-surface-variant">
                  Configure exact site boundaries, wall thicknesses, and room zones with parametric doors and windows.
                </p>
              </div>
            </article>

            <article className="bg-surface-container border border-outline-variant rounded-lg p-gutter-xl flex flex-col gap-gutter-md h-full">
              <header className="flex items-center justify-between gap-gutter-md">
                <div className="w-10 h-10 rounded-md bg-primary-container border border-primary flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-primary text-[22px]" aria-hidden="true">
                    deployed_code
                  </span>
                </div>
                <span className="font-mono text-mono-sm text-on-surface-variant">3D BIM</span>
              </header>
              <div className="flex flex-col gap-gutter-xs">
                <h3 className="font-headline text-headline-sm text-on-surface">3D Home Designer</h3>
                <p className="font-body text-body-md text-on-surface-variant">
                  Switch instantaneously between 2D blueprints and 3D Orbit or First-Person views under Daylight and Evening lighting.
                </p>
              </div>
            </article>

            <article className="bg-surface-container border border-outline-variant rounded-lg p-gutter-xl flex flex-col gap-gutter-md h-full">
              <header className="flex items-center justify-between gap-gutter-md">
                <div className="w-10 h-10 rounded-md bg-secondary-container border border-secondary flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-secondary text-[22px]" aria-hidden="true">
                    electrical_services
                  </span>
                </div>
                <span className="font-mono text-mono-sm text-on-surface-variant">LOAD</span>
              </header>
              <div className="flex flex-col gap-gutter-xs">
                <h3 className="font-headline text-headline-sm text-on-surface">Electrical Planner</h3>
                <p className="font-body text-body-md text-on-surface-variant">
                  Place fans, LEDs, switchboards, 5A/16A sockets, ACs, and geysers with exact X/Y/Z mounting heights and circuits.
                </p>
              </div>
            </article>

            <article className="bg-surface-container border border-outline-variant rounded-lg p-gutter-xl flex flex-col gap-gutter-md h-full">
              <header className="flex items-center justify-between gap-gutter-md">
                <div className="w-10 h-10 rounded-md bg-secondary-container border border-secondary flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-secondary text-[22px]" aria-hidden="true">
                    receipt_long
                  </span>
                </div>
                <span className="font-mono text-mono-sm text-on-surface-variant">BOQ</span>
              </header>
              <div className="flex flex-col gap-gutter-xs">
                <h3 className="font-headline text-headline-sm text-on-surface">Smart BOQ</h3>
                <p className="font-body text-body-md text-on-surface-variant">
                  Generate room-wise electrical schedules, total connected load in kW, and exportable PDF/Excel cost estimates.
                </p>
              </div>
            </article>
          </div>
        </section>

        {/* How It Works */}
        <section className="border-y border-outline-variant bg-surface-container-low">
          <div className="max-w-7xl mx-auto px-gutter-lg lg:px-gutter-xl py-section">
            <div className="flex flex-col gap-gutter-xs mb-gutter-2xl">
              <h2 className="font-headline text-headline-lg-mobile lg:text-headline-lg text-on-surface">
                How It Works
              </h2>
              <p className="font-body text-body-md text-on-surface-variant">
                From empty plot dimensions to an engineering-ready electrical schedule in three steps.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-gutter-lg">
              <div className="bg-surface-container border border-outline-variant rounded-lg p-gutter-xl flex flex-col gap-gutter-md">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-mono-md text-primary">STEP 1</span>
                  <span className="material-symbols-outlined text-on-surface-variant text-[22px]" aria-hidden="true">
                    square_foot
                  </span>
                </div>
                <h3 className="font-headline text-headline-sm text-on-surface">Configure Site &amp; Rooms</h3>
                <p className="font-body text-body-md text-on-surface-variant">
                  Set site length, width, ceiling height, and wall thickness. Drop Living, Bedroom, Kitchen, and Balcony zones onto the 2D grid.
                </p>
              </div>

              <div className="bg-surface-container border border-outline-variant rounded-lg p-gutter-xl flex flex-col gap-gutter-md">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-mono-md text-primary">STEP 2</span>
                  <span className="material-symbols-outlined text-on-surface-variant text-[22px]" aria-hidden="true">
                    lightbulb
                  </span>
                </div>
                <h3 className="font-headline text-headline-sm text-on-surface">Place Electrical Points in 3D</h3>
                <p className="font-body text-body-md text-on-surface-variant">
                  Drag fans, lights, switches, sockets, and heavy appliances. Fine-tune X/Y/Z coordinates, rotation, and circuit assignment.
                </p>
              </div>

              <div className="bg-surface-container border border-outline-variant rounded-lg p-gutter-xl flex flex-col gap-gutter-md">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-mono-md text-secondary">STEP 3</span>
                  <span className="material-symbols-outlined text-on-surface-variant text-[22px]" aria-hidden="true">
                    analytics
                  </span>
                </div>
                <h3 className="font-headline text-headline-sm text-on-surface">Export Load &amp; Smart BOQ</h3>
                <p className="font-body text-body-md text-on-surface-variant">
                  Review room-wise breakdowns, total connected load, and itemized Bill of Quantities. Download PDF, Excel, or request a quote.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* My Saved Projects */}
        <section className="max-w-7xl mx-auto px-gutter-lg lg:px-gutter-xl py-section">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-gutter-md mb-gutter-2xl">
            <div className="flex flex-col gap-gutter-xs">
              <h2 className="font-headline text-headline-lg-mobile lg:text-headline-lg text-on-surface">
                My Saved Projects
              </h2>
              <p className="font-body text-body-md text-on-surface-variant">
                Resume active residential floor plans or inspect their engineering summaries.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-gutter-sm self-start sm:self-auto">
              <button
                type="button"
                onClick={() => importInputRef.current?.click()}
                className="inline-flex items-center gap-gutter-xs px-gutter-md py-gutter-sm rounded-md bg-surface-container border border-outline-variant text-on-surface-variant hover:text-on-surface hover:border-outline font-label text-label-md transition-colors duration-state-change cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                  upload_file
                </span>
                <span>Import (.bluespace / .json)</span>
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept=".bluespace,.json,application/json"
                className="hidden"
                onChange={handleImportFile}
              />
              <button
                type="button"
                onClick={() => setShowNewModal(true)}
                className="inline-flex items-center gap-gutter-xs px-gutter-lg py-gutter-sm rounded-md bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-md transition-colors duration-state-change cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                  add
                </span>
                <span>New Project</span>
              </button>
            </div>
          </div>

          {importError && (
            <div className="mb-gutter-lg px-gutter-md py-gutter-sm rounded-sm bg-error/15 border border-error text-error font-mono text-mono-sm flex items-center justify-between">
              <span>{importError}</span>
              <button
                type="button"
                onClick={() => setImportError(null)}
                className="underline cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-gutter-lg items-stretch">
            {projects.length === 0 ? (
              <div className="md:col-span-3 bg-surface-container border border-dashed border-outline rounded-lg p-gutter-2xl flex flex-col items-center justify-center text-center gap-gutter-md">
                <span className="material-symbols-outlined text-on-surface-variant text-[36px]" aria-hidden="true">
                  folder_off
                </span>
                <p className="font-body text-body-md text-on-surface-variant">
                  No saved projects yet. Create a new architectural space or import a project JSON file.
                </p>
                <button
                  type="button"
                  onClick={() => setShowNewModal(true)}
                  className="inline-flex items-center gap-gutter-xs px-gutter-lg py-gutter-sm rounded-md bg-primary text-on-primary font-label text-label-md hover:bg-on-primary-container cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[18px]" aria-hidden="true">add</span>
                  <span>Create New Project</span>
                </button>
              </div>
            ) : (
              projects.map((proj) => {
                const metrics = computeProjectMetrics(proj);
                const isCurrent = proj.id === activeProjectId;
                const isConfirmingDelete = confirmDeleteId === proj.id;
                const statusStyle =
                  proj.status === 'Active' || isCurrent
                    ? 'bg-primary-container text-on-primary-container'
                    : proj.status === 'BOQ Ready'
                      ? 'bg-secondary-container text-on-secondary-container'
                      : 'bg-surface-container-high text-on-surface-variant';

                return (
                  <article
                    key={proj.id}
                    className={`bg-surface-container border rounded-lg overflow-hidden flex flex-col h-full transition-colors duration-state-change ${
                      isCurrent ? 'border-primary' : 'border-outline-variant'
                    }`}
                  >
                    <div
                      onClick={() => onOpenProject(proj.id, 'studio', '2d')}
                      className="aspect-video bg-surface-container-low border-b border-outline-variant overflow-hidden cursor-pointer"
                      title={`Edit ${proj.name}`}
                    >
                      <FloorPlan2D project={proj} previewOnly={true} />
                    </div>
                    <div className="p-gutter-lg flex flex-col gap-gutter-sm flex-1">
                      <header className="flex items-start justify-between gap-gutter-sm">
                        <div>
                          <h3 className="font-headline text-headline-sm text-on-surface">
                            {proj.name}
                          </h3>
                          <p className="font-mono text-mono-sm text-on-surface-variant tabular-nums">
                            {metrics.dimensionsDisplay} • {metrics.totalKw.toFixed(2)} kW
                          </p>
                        </div>
                        <span
                          className={`px-gutter-sm py-gutter-xs rounded-full font-label text-label-sm shrink-0 ${statusStyle}`}
                        >
                          {isCurrent ? 'Active' : proj.status}
                        </span>
                      </header>
                      <p className="font-body text-body-sm text-on-surface-variant">
                        {proj.site.floors > 1 ? `${proj.site.floors} floors, ` : ''}
                        {proj.rooms.length} rooms, {metrics.totalPoints} electrical points. {proj.description}
                      </p>
                    </div>
                    <footer className="px-gutter-lg py-gutter-sm border-t border-outline-variant flex items-center justify-between gap-gutter-sm bg-surface-container-low">
                      <div className="flex items-center gap-gutter-xs">
                        {/* Edit Symbol */}
                        <button
                          type="button"
                          onClick={() => onOpenProject(proj.id, 'studio', '2d')}
                          title="Edit Project in Design Studio"
                          aria-label={`Edit ${proj.name}`}
                          className="w-9 h-9 inline-flex items-center justify-center rounded-sm bg-surface-container border border-outline-variant text-primary hover:bg-primary-container hover:border-primary transition-colors cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[19px]" aria-hidden="true">
                            edit
                          </span>
                        </button>

                        {/* Download Symbol */}
                        <button
                          type="button"
                          onClick={() => downloadProjectJson(proj)}
                          title="Download Project (.json)"
                          aria-label={`Download ${proj.name}`}
                          className="w-9 h-9 inline-flex items-center justify-center rounded-sm bg-surface-container border border-outline-variant text-secondary hover:bg-secondary-container/40 hover:border-secondary transition-colors cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[19px]" aria-hidden="true">
                            download
                          </span>
                        </button>

                        {/* Delete Symbol (with inline symbol confirmation — zero window.confirm) */}
                        {isConfirmingDelete ? (
                          <div className="inline-flex items-center gap-1 bg-error/15 border border-error rounded-sm p-0.5">
                            <button
                              type="button"
                              onClick={() => {
                                setConfirmDeleteId(null);
                                onDeleteProject(proj.id);
                              }}
                              title="Confirm Delete"
                              aria-label={`Confirm delete ${proj.name}`}
                              className="w-8 h-8 inline-flex items-center justify-center rounded-sm bg-error text-on-primary hover:opacity-90 cursor-pointer"
                            >
                              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                                check
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              title="Cancel Delete"
                              aria-label="Cancel delete"
                              className="w-8 h-8 inline-flex items-center justify-center rounded-sm bg-surface-container text-on-surface-variant hover:text-on-surface cursor-pointer"
                            >
                              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                                close
                              </span>
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(proj.id)}
                            title="Delete Project"
                            aria-label={`Delete ${proj.name}`}
                            className="w-9 h-9 inline-flex items-center justify-center rounded-sm bg-surface-container border border-outline-variant text-error hover:bg-error/15 hover:border-error transition-colors cursor-pointer"
                          >
                            <span className="material-symbols-outlined text-[19px]" aria-hidden="true">
                              delete
                            </span>
                          </button>
                        )}
                      </div>

                      {/* Project Summary Symbol */}
                      <button
                        type="button"
                        onClick={() => onOpenProject(proj.id, 'summary')}
                        title="View Project Summary & BOQ"
                        aria-label={`View summary for ${proj.name}`}
                        className="w-9 h-9 inline-flex items-center justify-center rounded-sm bg-surface-container border border-outline-variant text-on-surface-variant hover:text-primary hover:border-primary transition-colors cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-[19px]" aria-hidden="true">
                          summarize
                        </span>
                      </button>
                    </footer>
                  </article>
                );
              })
            )}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-surface-container border-t border-outline-variant">
        <div className="max-w-7xl mx-auto px-gutter-lg lg:px-gutter-xl py-gutter-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-gutter-lg">
          <div className="flex items-center gap-gutter-sm">
            <img
              src="/assets/aistudio/Create_favicon_and_transparent_p__21f5ae8d_2K_3f0575c9.png"
              alt="Blue Space logo"
              className="w-8 h-8 object-contain shrink-0"
            />
            <div className="flex flex-col gap-gutter-xs">
              <span className="font-headline text-title-sm text-on-surface uppercase tracking-wide">
                BLUE SPACE
              </span>
              <span className="font-mono text-mono-sm text-on-surface-variant uppercase">
                DESIGN YOUR SPACE. POWER YOUR WORLD.
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-gutter-xl">
            <button
              type="button"
              onClick={() => onNavigate('home')}
              className="font-label text-label-md text-on-surface-variant hover:text-primary cursor-pointer"
            >
              Home
            </button>
            <button
              type="button"
              onClick={() => onNavigate('studio')}
              className="font-label text-label-md text-on-surface-variant hover:text-primary cursor-pointer"
            >
              Design Studio
            </button>
            <button
              type="button"
              onClick={() => onNavigate('summary')}
              className="font-label text-label-md text-on-surface-variant hover:text-primary cursor-pointer"
            >
              Project Summary
            </button>
          </div>
          <span className="font-mono text-mono-sm text-on-surface-variant">
            IS 732 / NBC Residential Electrical Standard
          </span>
        </div>
      </footer>

      {/* Phase 1: Project Creation Modal */}
      {showNewModal && (
        <ProjectCreationModal
          onCancel={() => setShowNewModal(false)}
          onCreate={(input) => {
            setShowNewModal(false);
            onCreateProject(input);
          }}
        />
      )}

      {/* Drawing & Multi-Floor Instructions Modal */}
      {showGuideModal && (
        <DrawingInstructionsModal
          onClose={() => setShowGuideModal(false)}
          onStartDesigning={() => setShowNewModal(true)}
        />
      )}

      {/* Safe Native Project Import Preview Modal */}
      <ImportProjectPreviewModal
        preview={importPreview}
        onCancel={() => setImportPreview(null)}
        onConfirmImport={handleConfirmSafeImport}
      />
    </div>
  );
};
