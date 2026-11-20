import { INITIAL_PROJECTS } from '../data/presets';
import { ProjectData } from '../types/design';

const STORAGE_KEY = 'ananya_space_designer_projects_v2';
const LEGACY_STORAGE_KEY = 'ananya_space_designer_projects_v1';

/**
 * Storage repository abstraction backed by localStorage today,
 * structured so it can later connect cleanly to Cloudflare D1 (metadata/JSON) and R2 (exports).
 */
export interface ProjectRepository {
  loadAll(): ProjectData[];
  saveAll(projects: ProjectData[]): void;
  exportProjectJson(project: ProjectData): string;
  parseImportedJson(raw: string): ProjectData | null;
}

function normalizeProject(p: ProjectData): ProjectData {
  return {
    ...p,
    projectType: p.projectType ?? 'Residential',
    siteConfigured: p.siteConfigured ?? true,
    rooms: Array.isArray(p.rooms) ? p.rooms : [],
    customWalls: Array.isArray(p.customWalls) ? p.customWalls : [],
    openings: Array.isArray(p.openings) ? p.openings : [],
    dimensions: Array.isArray(p.dimensions) ? p.dimensions : [],
    furniture: Array.isArray(p.furniture) ? p.furniture : [],
    points: Array.isArray(p.points) ? p.points : [],
  };
}

export const projectStorage: ProjectRepository = {
  loadAll(): ProjectData[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) return INITIAL_PROJECTS.map(normalizeProject);
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((p) => normalizeProject(p as ProjectData));
      }
    } catch {
      // Fall back safely to initial presets
    }
    return INITIAL_PROJECTS.map(normalizeProject);
  },

  saveAll(projects: ProjectData[]): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
    } catch {
      // Ignore quota errors gracefully
    }
  },

  exportProjectJson(project: ProjectData): string {
    const payload = {
      schema: 'ananya-space-designer/v2',
      exportedAt: new Date().toISOString(),
      projectId: project.id,
      refCode: project.refCode,
      projectName: project.name,
      projectType: project.projectType ?? 'Residential',
      description: project.description,
      measurementUnits: project.site.units,
      siteDimensions: {
        length: project.site.length,
        width: project.site.width,
        ceilingHeight: project.site.ceilingHeight,
        wallThickness: project.site.wallThickness,
        floors: project.site.floors,
        units: project.site.units,
      },
      rooms: project.rooms,
      walls: project.customWalls,
      doorsAndWindows: project.openings,
      dimensionAnnotations: project.dimensions ?? [],
      furniture: project.furniture,
      electricalPoints: project.points,
      settings: {
        status: project.status,
        siteConfigured: project.siteConfigured ?? true,
      },
    };
    return JSON.stringify(payload, null, 2);
  },

  parseImportedJson(raw: string): ProjectData | null {
    try {
      const data = JSON.parse(raw);
      // Support both structured exported JSON and raw ProjectData format
      const name = String(data.projectName ?? data.name ?? '').trim();
      const site = data.siteDimensions ?? data.site;
      if (!name || !site || !Number(site.length) || !Number(site.width)) {
        return null;
      }

      const id = `proj-imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      return normalizeProject({
        id,
        refCode: data.refCode ?? `ASD-IMP-${String(Date.now()).slice(-4)}`,
        name,
        projectType: data.projectType ?? 'Residential',
        status: 'Saved',
        description: data.description ?? 'Imported architectural floor plan project.',
        siteConfigured: true,
        site: {
          length: Number(site.length),
          width: Number(site.width),
          ceilingHeight: Number(site.ceilingHeight ?? 10),
          wallThickness: Number(site.wallThickness ?? (site.units === 'm' ? 0.15 : 0.5)),
          units: site.units === 'm' ? 'm' : 'ft',
          floors: Number(site.floors ?? 1),
        },
        rooms: Array.isArray(data.rooms) ? data.rooms : [],
        customWalls: Array.isArray(data.walls ?? data.customWalls)
          ? (data.walls ?? data.customWalls)
          : [],
        openings: Array.isArray(data.doorsAndWindows ?? data.openings)
          ? (data.doorsAndWindows ?? data.openings)
          : [],
        dimensions: Array.isArray(data.dimensionAnnotations ?? data.dimensions)
          ? (data.dimensionAnnotations ?? data.dimensions)
          : [],
        furniture: Array.isArray(data.furniture) ? data.furniture : [],
        points: Array.isArray(data.electricalPoints ?? data.points)
          ? (data.electricalPoints ?? data.points)
          : [],
        updatedAt: new Date().toISOString(),
      });
    } catch {
      return null;
    }
  },
};
