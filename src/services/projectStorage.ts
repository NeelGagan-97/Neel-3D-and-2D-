import { INITIAL_PROJECTS } from '../data/presets';
import { ProjectData } from '../types/design';
import {
  autoRouteUnwiredCables,
  migrateProjectFloorSchema,
} from '../utils/buildingWiring';

const STORAGE_KEY = 'ananya_space_designer_projects_v2';
const LEGACY_STORAGE_KEY = 'ananya_space_designer_projects_v1';

/**
 * Storage repository abstraction backed by localStorage today,
 * structured so it can later connect cleanly to Cloudflare D1 (metadata/JSON) and R2 (exports).
 */
export interface ParsedImportPreview {
  project: ProjectData;
  formatLabel: string;
  schemaVersion: string;
  exportedAt?: string;
}

export interface ProjectRepository {
  loadAll(): ProjectData[];
  saveAll(projects: ProjectData[]): void;
  exportProjectJson(project: ProjectData): string;
  exportNativeBluespace(project: ProjectData): string;
  parseImportedJson(raw: string): ProjectData | null;
  parseNativeProjectFile(raw: string): ParsedImportPreview | null;
}

function normalizeProject(p: ProjectData): ProjectData {
  const base: ProjectData = {
    ...p,
    projectType: p.projectType ?? 'Residential',
    buildingType: p.buildingType,
    siteConfigured: p.siteConfigured ?? true,
    floorConfigs: Array.isArray(p.floorConfigs) ? p.floorConfigs : undefined,
    rooms: Array.isArray(p.rooms) ? p.rooms : [],
    customWalls: Array.isArray(p.customWalls) ? p.customWalls : [],
    openings: Array.isArray(p.openings) ? p.openings : [],
    dimensions: Array.isArray(p.dimensions) ? p.dimensions : [],
    furniture: Array.isArray(p.furniture) ? p.furniture : [],
    staircases: Array.isArray(p.staircases) ? p.staircases : [],
    points: Array.isArray(p.points) ? p.points : [],
    wires: Array.isArray(p.wires) ? p.wires : [],
    wiringConfig: p.wiringConfig,
    circuitCableConfigs:
      p.circuitCableConfigs && typeof p.circuitCableConfigs === 'object'
        ? p.circuitCableConfigs
        : undefined,
    savedCameraViews: Array.isArray(p.savedCameraViews) ? p.savedCameraViews : undefined,
  };
  return migrateProjectFloorSchema(base);
}

function buildSeedPresets(): ProjectData[] {
  return INITIAL_PROJECTS.map((preset) => {
    const normalized = normalizeProject(preset);
    if ((normalized.wires ?? []).length === 0) {
      const routed = autoRouteUnwiredCables(normalized);
      return { ...normalized, wires: routed.nextWires };
    }
    return normalized;
  });
}

export const projectStorage: ProjectRepository = {
  loadAll(): ProjectData[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) return buildSeedPresets();
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((p) => normalizeProject(p as ProjectData));
      }
    } catch {
      // Fall back safely to initial presets
    }
    return buildSeedPresets();
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
      schema: 'ananya-space-designer/v3',
      exportedAt: new Date().toISOString(),
      projectId: project.id,
      refCode: project.refCode,
      projectName: project.name,
      projectType: project.projectType ?? 'Residential',
      buildingType: project.buildingType,
      description: project.description,
      measurementUnits: project.site.units,
      siteDimensions: {
        length: project.site.length,
        width: project.site.width,
        ceilingHeight: project.site.ceilingHeight,
        wallThickness: project.site.wallThickness,
        slabThicknessM: project.site.slabThicknessM,
        floors: project.site.floors,
        units: project.site.units,
        ...(project.site.allowFloorExceedSite !== undefined
          ? { allowFloorExceedSite: project.site.allowFloorExceedSite }
          : {}),
      },
      floorConfigs: project.floorConfigs,
      rooms: project.rooms,
      walls: project.customWalls,
      doorsAndWindows: project.openings,
      dimensionAnnotations: project.dimensions ?? [],
      furniture: project.furniture,
      staircases: project.staircases ?? [],
      electricalPoints: project.points,
      electricalWires: project.wires ?? [],
      wiringConfig: project.wiringConfig,
      ...(project.circuitCableConfigs !== undefined
        ? { circuitCableConfigs: project.circuitCableConfigs }
        : {}),
      ...(project.savedCameraViews !== undefined
        ? { savedCameraViews: project.savedCameraViews }
        : {}),
      ...(project.summaryOverrides !== undefined
        ? { summaryOverrides: project.summaryOverrides }
        : {}),
      settings: {
        status: project.status,
        siteConfigured: project.siteConfigured ?? true,
      },
    };
    return JSON.stringify(payload, null, 2);
  },

  exportNativeBluespace(project: ProjectData): string {
    const nativeEnvelope = {
      format: 'bluespace-native',
      schemaVersion: 4,
      exportedAt: new Date().toISOString(),
      application: 'Blue Space Architectural & Electrical CAD',
      project: normalizeProject(project),
    };
    return JSON.stringify(nativeEnvelope, null, 2);
  },

  parseNativeProjectFile(raw: string): ParsedImportPreview | null {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;

      // Native .bluespace v4 envelope
      if (parsed.format === 'bluespace-native' && parsed.project && typeof parsed.project === 'object') {
        const inner = parsed.project;
        const name = String(inner.name ?? '').trim();
        const site = inner.site;
        if (!name || !site || !Number(site.length) || !Number(site.width)) return null;

        const id = `proj-imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        return {
          formatLabel: 'Blue Space Native (.bluespace)',
          schemaVersion: `v${parsed.schemaVersion ?? 4}`,
          exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : undefined,
          project: normalizeProject({
            ...inner,
            id,
            status: 'Saved',
            siteConfigured: true,
            updatedAt: new Date().toISOString(),
          }),
        };
      }

      // Legacy / JSON v1–v3 format
      const fallbackProject = projectStorage.parseImportedJson(raw);
      if (!fallbackProject) return null;
      return {
        formatLabel: 'Blue Space JSON (.json)',
        schemaVersion: String(parsed.schema ?? 'legacy-json'),
        exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : undefined,
        project: fallbackProject,
      };
    } catch {
      return null;
    }
  },

  parseImportedJson(raw: string): ProjectData | null {
    try {
      const data = JSON.parse(raw);
      // Also seamlessly accept native .bluespace files through parseImportedJson
      if (data?.format === 'bluespace-native' && data?.project) {
        const inner = data.project;
        const name = String(inner.name ?? '').trim();
        const site = inner.site;
        if (!name || !site || !Number(site.length) || !Number(site.width)) return null;
        return normalizeProject({
          ...inner,
          id: `proj-imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          status: 'Saved',
          siteConfigured: true,
          updatedAt: new Date().toISOString(),
        });
      }

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
        buildingType: data.buildingType,
        status: 'Saved',
        description: data.description ?? 'Imported architectural floor plan project.',
        siteConfigured: true,
        site: {
          length: Number(site.length),
          width: Number(site.width),
          ceilingHeight: Number(site.ceilingHeight ?? 10),
          wallThickness: Number(site.wallThickness ?? (site.units === 'm' ? 0.15 : 0.5)),
          ...(site.slabThicknessM ? { slabThicknessM: Number(site.slabThicknessM) } : {}),
          units: site.units === 'm' ? 'm' : 'ft',
          floors: Number(site.floors ?? 1),
          ...(site.allowFloorExceedSite !== undefined
            ? { allowFloorExceedSite: Boolean(site.allowFloorExceedSite) }
            : {}),
        },
        floorConfigs: Array.isArray(data.floorConfigs) ? data.floorConfigs : undefined,
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
        staircases: Array.isArray(data.staircases) ? data.staircases : [],
        points: Array.isArray(data.electricalPoints ?? data.points)
          ? (data.electricalPoints ?? data.points)
          : [],
        wires: Array.isArray(data.electricalWires ?? data.wires)
          ? (data.electricalWires ?? data.wires)
          : [],
        wiringConfig: data.wiringConfig && typeof data.wiringConfig === 'object' ? data.wiringConfig : undefined,
        ...(data.circuitCableConfigs && typeof data.circuitCableConfigs === 'object'
          ? { circuitCableConfigs: data.circuitCableConfigs }
          : {}),
        ...(Array.isArray(data.savedCameraViews)
          ? { savedCameraViews: data.savedCameraViews }
          : {}),
        ...(data.summaryOverrides && typeof data.summaryOverrides === 'object'
          ? { summaryOverrides: data.summaryOverrides }
          : {}),
        updatedAt: new Date().toISOString(),
      });
    } catch {
      return null;
    }
  },
};
