import type { SupabaseClient } from '@supabase/supabase-js';
import { computeProjectMetrics, INITIAL_PROJECTS } from '../data/presets';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import {
  LocalMigrationReport,
  ProjectAttachmentKind,
  ProjectAttachmentRecord,
  ProjectConflictInfo,
  ProjectData,
  ProjectVersionRecord,
} from '../types/design';
import { projectStorage, STORAGE_KEY } from './projectStorage';

export const PROJECT_ASSETS_BUCKET = 'project-assets';
export const MAX_ATTACHMENT_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

const CACHE_KEY_PREFIX = 'bluespace_projects_cache_v3:';
const DELETED_CACHE_KEY_PREFIX = 'bluespace_projects_deleted_cache_v3:';
const QUEUE_KEY_PREFIX = 'bluespace_projects_sync_queue_v3:';
const MIGRATION_KEY_PREFIX = 'bluespace_projects_migrated_v3:';

const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/json',
  'application/octet-stream',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/dxf',
  'image/vnd.dxf',
]);

const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.json',
  '.bluespace',
  '.txt',
  '.csv',
  '.xlsx',
  '.dxf',
]);

export interface CloudStorageDriverOptions {
  /** Optional custom Supabase client (used in unit/integration tests and server utilities) */
  client?: SupabaseClient;
  /** Optional storage override (defaults to window.localStorage when available) */
  storage?: Storage;
  /** Optional connectivity override for deterministic testing */
  isOnline?: () => boolean;
  /** Optional retry base delay in ms (defaults to 250ms) */
  retryBaseDelayMs?: number;
  /** Optional max retry attempts for transient failures (defaults to 3) */
  maxRetries?: number;
}

export type PendingSyncOpKind = 'upsert' | 'rename' | 'soft-delete' | 'restore';

export interface PendingSyncOperation {
  id: string;
  kind: PendingSyncOpKind;
  clientProjectId: string;
  cloudId?: string;
  expectedVersion?: number;
  projectSnapshot?: ProjectData;
  newName?: string;
  changeSummary?: string;
  createVersionSnapshot?: boolean;
  queuedAt: string;
  attempts: number;
  lastError?: string | null;
}

export interface UpsertCloudProjectResult {
  ok: boolean;
  project?: ProjectData;
  conflict?: ProjectConflictInfo;
  queuedOffline?: boolean;
  error?: string;
}

export interface FlushSyncQueueResult {
  processed: number;
  succeeded: number;
  conflicts: ProjectConflictInfo[];
  remaining: number;
  errors: string[];
  updatedProjects: ProjectData[];
}

interface DbProjectRow {
  id: string;
  client_project_id: string;
  owner_user_id: string;
  name: string;
  ref_code: string;
  project_type: string;
  building_type: string | null;
  status: 'Active' | 'Saved' | 'BOQ Ready';
  description: string;
  metadata: Record<string, unknown> | null;
  project_data: ProjectData;
  version: number;
  content_hash: string;
  last_modified_by: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DbVersionRow {
  id: string;
  project_id: string;
  owner_user_id: string;
  version_number: number;
  change_summary: string;
  project_data: ProjectData;
  metadata: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
}

interface DbAttachmentRow {
  id: string;
  project_id: string;
  owner_user_id: string;
  kind: ProjectAttachmentKind;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  storage_bucket: string;
  storage_path: string;
  sha256: string | null;
  deleted_at: string | null;
  created_at: string;
}

const memoryStorageFallback = new Map<string, string>();

function getStorage(options?: CloudStorageDriverOptions): Storage | null {
  if (options?.storage) return options.storage;
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  return null;
}

function readStorageItem(key: string, options?: CloudStorageDriverOptions): string | null {
  try {
    const store = getStorage(options);
    if (store) return store.getItem(key);
  } catch {
    // Fall back to memory map when sandbox blocks storage
  }
  return memoryStorageFallback.get(key) ?? null;
}

function writeStorageItem(key: string, value: string, options?: CloudStorageDriverOptions): void {
  try {
    const store = getStorage(options);
    if (store) {
      store.setItem(key, value);
      return;
    }
  } catch {
    // Fall back to memory map on quota or sandbox errors
  }
  memoryStorageFallback.set(key, value);
}

function removeStorageItem(key: string, options?: CloudStorageDriverOptions): void {
  try {
    const store = getStorage(options);
    if (store) {
      store.removeItem(key);
    }
  } catch {
    // ignore
  }
  memoryStorageFallback.delete(key);
}

function getClient(options?: CloudStorageDriverOptions): SupabaseClient | null {
  if (options?.client) return options.client;
  if (!isSupabaseConfigured || !supabase) return null;
  return supabase;
}

export function isDeviceOnline(options?: CloudStorageDriverOptions): boolean {
  if (options?.isOnline) return options.isOnline();
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  return true;
}

function generateId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function computeProjectContentHash(project: ProjectData): string {
  // Deterministic lightweight FNV-1a hash over semantic project fields (excluding transient sync flags)
  const payload = JSON.stringify({
    name: project.name,
    refCode: project.refCode,
    projectType: project.projectType ?? 'Residential',
    buildingType: project.buildingType ?? null,
    status: project.status,
    description: project.description,
    siteConfigured: project.siteConfigured ?? true,
    site: project.site,
    floorConfigs: project.floorConfigs ?? [],
    rooms: project.rooms,
    customWalls: project.customWalls,
    hiddenWallIds: project.hiddenWallIds ?? [],
    openings: project.openings,
    dimensions: project.dimensions ?? [],
    furniture: project.furniture,
    staircases: project.staircases ?? [],
    points: project.points,
    wires: project.wires ?? [],
    wiringConfig: project.wiringConfig ?? null,
    circuitCableConfigs: project.circuitCableConfigs ?? null,
    savedCameraViews: project.savedCameraViews ?? [],
    summaryOverrides: project.summaryOverrides ?? null,
    aiDrawingImport: project.aiDrawingImport
      ? {
          ...project.aiDrawingImport,
          referenceOverlay: project.aiDrawingImport.referenceOverlay
            ? {
                ...project.aiDrawingImport.referenceOverlay,
                dataUrl: project.aiDrawingImport.referenceOverlay.storagePath
                  ? ''
                  : project.aiDrawingImport.referenceOverlay.dataUrl,
              }
            : undefined,
        }
      : null,
  });

  let hash = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}-${payload.length}`;
}

export function extractProjectMetadata(project: ProjectData): Record<string, unknown> {
  const metrics = computeProjectMetrics(project);
  return {
    roomsCount: project.rooms.length,
    pointsCount: project.points.length,
    wiresCount: (project.wires ?? []).length,
    floorsCount: project.site?.floors ?? 1,
    totalWatts: metrics.totalWatts,
    totalKw: Number(metrics.totalKw.toFixed(2)),
    estimatedCost: Math.round(metrics.totalCost),
    areaDisplay: metrics.areaDisplay,
    dimensionsDisplay: metrics.dimensionsDisplay,
    units: project.site?.units ?? 'm',
    hasAiDrawingImport: Boolean(project.aiDrawingImport),
    hasSummaryOverrides: Boolean(project.summaryOverrides),
  };
}

export function stripTransientCloudFields(project: ProjectData): ProjectData {
  const {
    cloudId: _cId,
    ownerUserId: _owner,
    cloudVersion: _ver,
    deletedAt: _del,
    lastSyncedAt: _synced,
    syncStatus: _status,
    attachments: _att,
    ...rest
  } = project;
  return rest;
}

export function mapDbRowToProject(row: DbProjectRow): ProjectData {
  const baseData = (row.project_data && typeof row.project_data === 'object'
    ? row.project_data
    : {}) as ProjectData;

  return {
    ...baseData,
    id: row.client_project_id || baseData.id || row.id,
    name: row.name || baseData.name || 'Untitled Project',
    refCode: row.ref_code || baseData.refCode || '',
    projectType: (row.project_type as ProjectData['projectType']) || baseData.projectType || 'Residential',
    buildingType: (row.building_type as ProjectData['buildingType']) || baseData.buildingType,
    status: row.status || baseData.status || 'Active',
    description: row.description ?? baseData.description ?? '',
    updatedAt: row.updated_at || baseData.updatedAt || new Date().toISOString(),
    cloudId: row.id,
    ownerUserId: row.owner_user_id,
    cloudVersion: row.version,
    deletedAt: row.deleted_at,
    lastSyncedAt: row.updated_at || new Date().toISOString(),
    syncStatus: 'synced',
  };
}

function mapDbAttachmentRow(row: DbAttachmentRow): ProjectAttachmentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    kind: row.kind,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes || 0),
    storageBucket: row.storage_bucket || PROJECT_ASSETS_BUCKET,
    storagePath: row.storage_path,
    sha256: row.sha256,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
  };
}

function mapDbVersionRow(row: DbVersionRow): ProjectVersionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    versionNumber: row.version_number,
    changeSummary: row.change_summary,
    metadata: row.metadata ?? {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    projectData: row.project_data,
  };
}

function isTransientError(err: unknown): boolean {
  const msg = String(
    err && typeof err === 'object' && 'message' in err ? (err as { message?: unknown }).message : err ?? ''
  ).toLowerCase();
  return (
    msg.includes('network') ||
    msg.includes('failed to fetch') ||
    msg.includes('fetch') ||
    msg.includes('timeout') ||
    msg.includes('abort') ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('504') ||
    msg.includes('429') ||
    msg.includes('temporarily') ||
    msg.includes('econnreset')
  );
}

async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  options?: CloudStorageDriverOptions
): Promise<T> {
  const maxRetries = Math.max(1, options?.maxRetries ?? 3);
  const baseDelay = Math.max(0, options?.retryBaseDelayMs ?? 250);
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientError(err) || attempt === maxRetries - 1) {
        throw err;
      }
      const jitter = Math.floor(Math.random() * 60);
      const delayMs = baseDelay * Math.pow(2, attempt) + jitter;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

// ============================================================================
// PER-USER OFFLINE CACHE & DURABLE PENDING SYNC QUEUE
// ============================================================================
export function loadUserCachedProjects(
  userId: string,
  options?: CloudStorageDriverOptions
): ProjectData[] {
  const raw = readStorageItem(`${CACHE_KEY_PREFIX}${userId}`, options);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ProjectData[]) : [];
  } catch {
    return [];
  }
}

export function saveUserCachedProjects(
  userId: string,
  projects: ProjectData[],
  options?: CloudStorageDriverOptions
): void {
  writeStorageItem(`${CACHE_KEY_PREFIX}${userId}`, JSON.stringify(projects), options);
}

export function loadUserDeletedCachedProjects(
  userId: string,
  options?: CloudStorageDriverOptions
): ProjectData[] {
  const raw = readStorageItem(`${DELETED_CACHE_KEY_PREFIX}${userId}`, options);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ProjectData[]) : [];
  } catch {
    return [];
  }
}

export function saveUserDeletedCachedProjects(
  userId: string,
  projects: ProjectData[],
  options?: CloudStorageDriverOptions
): void {
  writeStorageItem(`${DELETED_CACHE_KEY_PREFIX}${userId}`, JSON.stringify(projects), options);
}

export function loadPendingSyncQueue(
  userId: string,
  options?: CloudStorageDriverOptions
): PendingSyncOperation[] {
  const raw = readStorageItem(`${QUEUE_KEY_PREFIX}${userId}`, options);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingSyncOperation[]) : [];
  } catch {
    return [];
  }
}

export function savePendingSyncQueue(
  userId: string,
  queue: PendingSyncOperation[],
  options?: CloudStorageDriverOptions
): void {
  writeStorageItem(`${QUEUE_KEY_PREFIX}${userId}`, JSON.stringify(queue), options);
}

export function enqueuePendingSyncOp(
  userId: string,
  op: Omit<PendingSyncOperation, 'id' | 'queuedAt' | 'attempts'> & {
    id?: string;
    queuedAt?: string;
    attempts?: number;
  },
  options?: CloudStorageDriverOptions
): PendingSyncOperation[] {
  const existing = loadPendingSyncQueue(userId, options);
  const nextOp: PendingSyncOperation = {
    ...op,
    id: op.id ?? generateId('syncop'),
    queuedAt: op.queuedAt ?? new Date().toISOString(),
    attempts: op.attempts ?? 0,
  };

  // Coalesce consecutive operations for the same project so offline edits stay compact
  const filtered = existing.filter((item) => {
    if (item.clientProjectId !== nextOp.clientProjectId) return true;
    if (nextOp.kind === 'soft-delete' || nextOp.kind === 'restore') return false;
    if (nextOp.kind === 'upsert' && (item.kind === 'upsert' || item.kind === 'rename')) return false;
    if (nextOp.kind === 'rename' && item.kind === 'rename') return false;
    return true;
  });

  // Preserve the earliest expectedVersion when coalescing offline edits so conflict protection holds!
  const prior = existing.find((item) => item.clientProjectId === nextOp.clientProjectId);
  if (prior?.expectedVersion !== undefined && nextOp.expectedVersion === undefined) {
    nextOp.expectedVersion = prior.expectedVersion;
  }
  if (prior?.cloudId && !nextOp.cloudId) {
    nextOp.cloudId = prior.cloudId;
  }

  const nextQueue = [...filtered, nextOp];
  savePendingSyncQueue(userId, nextQueue, options);
  return nextQueue;
}

export function clearPendingSyncOpsForProject(
  userId: string,
  clientProjectId: string,
  options?: CloudStorageDriverOptions
): void {
  const existing = loadPendingSyncQueue(userId, options);
  const next = existing.filter((op) => op.clientProjectId !== clientProjectId);
  if (next.length !== existing.length) {
    savePendingSyncQueue(userId, next, options);
  }
}

// ============================================================================
// SAFE FILENAME & ATTACHMENT VALIDATION + SUPABASE STORAGE (`project-assets`)
// ============================================================================
export function sanitizeAttachmentFilename(rawName: string): string {
  const base = rawName
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\0/g, '')
    .trim() || 'attachment.bin';
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || 'attachment.bin';
}

export function validateProjectStoragePath(storagePath: string, expectedOwnerId?: string): boolean {
  if (!storagePath || storagePath.length > 512) return false;
  if (storagePath.includes('..') || storagePath.includes('\\') || storagePath.includes('\0')) {
    return false;
  }
  if (storagePath.startsWith('/') || storagePath.endsWith('/')) return false;
  const parts = storagePath.split('/');
  if (parts.length < 3) return false;
  if (expectedOwnerId && parts[0] !== expectedOwnerId) return false;
  return true;
}

export function validateAttachmentInput(
  fileName: string,
  mimeType: string,
  sizeBytes: number
): { valid: boolean; error?: string; safeFileName: string; normalizedMime: string } {
  const safeFileName = sanitizeAttachmentFilename(fileName);
  const extMatch = safeFileName.toLowerCase().match(/(\.[a-z0-9]+)$/);
  const ext = extMatch ? extMatch[1] : '';

  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return { valid: false, error: 'Invalid file size.', safeFileName, normalizedMime: mimeType };
  }
  if (sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
    return {
      valid: false,
      error: `File exceeds the 50 MB cloud attachment limit (${(sizeBytes / (1024 * 1024)).toFixed(1)} MB).`,
      safeFileName,
      normalizedMime: mimeType,
    };
  }

  const normalizedMime = (mimeType || 'application/octet-stream').toLowerCase().trim();
  const mimeAllowed = ALLOWED_ATTACHMENT_MIME_TYPES.has(normalizedMime);
  const extAllowed = ext !== '' && ALLOWED_ATTACHMENT_EXTENSIONS.has(ext);
  if (!mimeAllowed && !extAllowed) {
    return {
      valid: false,
      error: `Unsupported file type (${ext || normalizedMime}). Allowed: PDF, PNG, JPG, WebP, GIF, DXF, JSON, XLSX, CSV, .bluespace.`,
      safeFileName,
      normalizedMime,
    };
  }

  return {
    valid: true,
    safeFileName,
    normalizedMime: mimeAllowed ? normalizedMime : 'application/octet-stream',
  };
}

export function inferAttachmentKind(fileName: string, mimeType: string): ProjectAttachmentKind {
  const lowerName = fileName.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  if (lowerName.endsWith('.bluespace')) return 'backup';
  if (lowerName.endsWith('.dxf')) return 'dxf';
  if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.csv')) return 'boq';
  if (lowerMime === 'application/pdf' || lowerName.endsWith('.pdf')) return 'pdf';
  if (lowerMime.startsWith('image/')) return 'image';
  return 'attachment';
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; mimeType: string; ext: string } | null {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const b64 = match[2].replace(/\s+/g, '');
  const binary =
    typeof atob === 'function'
      ? atob(b64)
      : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const ext =
    mimeType === 'image/png'
      ? 'png'
      : mimeType === 'image/webp'
        ? 'webp'
        : mimeType === 'image/gif'
          ? 'gif'
          : 'jpg';
  return { blob: new Blob([bytes], { type: mimeType }), mimeType, ext };
}

export async function uploadProjectAttachment(
  userId: string,
  cloudProjectId: string,
  file: Blob | File,
  input: {
    fileName?: string;
    mimeType?: string;
    kind?: ProjectAttachmentKind;
  } = {},
  options?: CloudStorageDriverOptions
): Promise<{ ok: boolean; attachment?: ProjectAttachmentRecord; error?: string }> {
  const sb = getClient(options);
  if (!sb) {
    return { ok: false, error: 'Supabase cloud storage is not configured.' };
  }
  if (!isDeviceOnline(options)) {
    return { ok: false, error: 'You are currently offline. Reconnect to upload cloud attachments.' };
  }

  const rawName = input.fileName || ('name' in file && typeof file.name === 'string' ? file.name : 'attachment.bin');
  const rawMime = input.mimeType || file.type || 'application/octet-stream';
  const validation = validateAttachmentInput(rawName, rawMime, file.size);
  if (!validation.valid) {
    return { ok: false, error: validation.error };
  }

  const attachmentId = generateId('att');
  const storagePath = `${userId}/${cloudProjectId}/${attachmentId}-${validation.safeFileName}`;
  if (!validateProjectStoragePath(storagePath, userId)) {
    return { ok: false, error: 'Invalid storage object path.' };
  }

  const kind = input.kind ?? inferAttachmentKind(validation.safeFileName, validation.normalizedMime);

  try {
    const uploadResult = await withExponentialBackoff(async () => {
      const { error } = await sb.storage
        .from(PROJECT_ASSETS_BUCKET)
        .upload(storagePath, file, {
          contentType: validation.normalizedMime,
          upsert: false,
        });
      if (error) throw new Error(error.message);
      return true;
    }, options);

    if (!uploadResult) {
      return { ok: false, error: 'Failed to upload file to Supabase Storage.' };
    }

    const { data, error: insertErr } = await sb
      .from('project_attachments')
      .insert({
        project_id: cloudProjectId,
        owner_user_id: userId,
        kind,
        file_name: validation.safeFileName,
        mime_type: validation.normalizedMime,
        size_bytes: file.size,
        storage_bucket: PROJECT_ASSETS_BUCKET,
        storage_path: storagePath,
      })
      .select('*')
      .single();

    if (insertErr || !data) {
      // Clean up orphaned storage object if metadata insert fails
      await sb.storage.from(PROJECT_ASSETS_BUCKET).remove([storagePath]).catch(() => {});
      return {
        ok: false,
        error: insertErr?.message || 'Could not record attachment metadata in database.',
      };
    }

    return { ok: true, attachment: mapDbAttachmentRow(data as DbAttachmentRow) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Attachment upload failed.',
    };
  }
}

export async function listProjectAttachments(
  cloudProjectId: string,
  options?: CloudStorageDriverOptions
): Promise<{ ok: boolean; attachments: ProjectAttachmentRecord[]; error?: string }> {
  const sb = getClient(options);
  if (!sb) return { ok: false, attachments: [], error: 'Supabase not configured.' };
  try {
    const { data, error } = await sb
      .from('project_attachments')
      .select('*')
      .eq('project_id', cloudProjectId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (error) return { ok: false, attachments: [], error: error.message };
    return {
      ok: true,
      attachments: (Array.isArray(data) ? data : []).map((row) =>
        mapDbAttachmentRow(row as DbAttachmentRow)
      ),
    };
  } catch (err) {
    return {
      ok: false,
      attachments: [],
      error: err instanceof Error ? err.message : 'Failed to list attachments.',
    };
  }
}

export async function getAttachmentSignedUrl(
  storagePath: string,
  expiresInSeconds = 3600,
  options?: CloudStorageDriverOptions
): Promise<{ ok: boolean; signedUrl?: string; error?: string }> {
  const sb = getClient(options);
  if (!sb) return { ok: false, error: 'Supabase not configured.' };
  if (!validateProjectStoragePath(storagePath)) {
    return { ok: false, error: 'Invalid storage path.' };
  }
  try {
    const { data, error } = await sb.storage
      .from(PROJECT_ASSETS_BUCKET)
      .createSignedUrl(storagePath, expiresInSeconds);
    if (error || !data?.signedUrl) {
      return { ok: false, error: error?.message || 'Unable to generate download URL.' };
    }
    return { ok: true, signedUrl: data.signedUrl };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unable to generate signed URL.',
    };
  }
}

export async function deleteProjectAttachment(
  attachment: Pick<ProjectAttachmentRecord, 'id' | 'storagePath'>,
  options?: CloudStorageDriverOptions
): Promise<{ ok: boolean; error?: string }> {
  const sb = getClient(options);
  if (!sb) return { ok: false, error: 'Supabase not configured.' };
  if (!validateProjectStoragePath(attachment.storagePath)) {
    return { ok: false, error: 'Invalid attachment storage path.' };
  }
  try {
    const { error: dbErr } = await sb
      .from('project_attachments')
      .delete()
      .eq('id', attachment.id);
    if (dbErr) return { ok: false, error: dbErr.message };

    await sb.storage.from(PROJECT_ASSETS_BUCKET).remove([attachment.storagePath]).catch(() => {});
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to delete attachment.',
    };
  }
}

async function offloadHeavyOverlayToStorage(
  userId: string,
  cloudProjectId: string,
  project: ProjectData,
  options?: CloudStorageDriverOptions
): Promise<ProjectData> {
  const overlay = project.aiDrawingImport?.referenceOverlay;
  if (!overlay || overlay.storagePath || !overlay.dataUrl?.startsWith('data:image/')) {
    return project;
  }
  // Offload overlays larger than 64 KB to Supabase Storage so PostgreSQL rows stay fast
  if (overlay.dataUrl.length < 64 * 1024) {
    return project;
  }
  const decoded = dataUrlToBlob(overlay.dataUrl);
  if (!decoded) return project;

  const uploaded = await uploadProjectAttachment(
    userId,
    cloudProjectId,
    decoded.blob,
    {
      fileName: `drawing-overlay-${project.id}.${decoded.ext}`,
      mimeType: decoded.mimeType,
      kind: 'drawing',
    },
    options
  );

  if (!uploaded.ok || !uploaded.attachment) {
    return project;
  }

  return {
    ...project,
    aiDrawingImport: {
      ...project.aiDrawingImport!,
      referenceOverlay: {
        ...overlay,
        storageBucket: uploaded.attachment.storageBucket,
        storagePath: uploaded.attachment.storagePath,
        dataUrl: '', // stored in Supabase Storage instead of bloating JSONB
      },
    },
  };
}

export async function hydrateProjectOverlayFromStorage(
  project: ProjectData,
  options?: CloudStorageDriverOptions
): Promise<ProjectData> {
  const overlay = project.aiDrawingImport?.referenceOverlay;
  if (!overlay?.storagePath || overlay.dataUrl) {
    return project;
  }
  const signed = await getAttachmentSignedUrl(overlay.storagePath, 3600, options);
  if (!signed.ok || !signed.signedUrl) return project;
  return {
    ...project,
    aiDrawingImport: {
      ...project.aiDrawingImport!,
      referenceOverlay: {
        ...overlay,
        dataUrl: signed.signedUrl,
      },
    },
  };
}

// ============================================================================
// CLOUD PROJECT CRUD, VERSIONING & OPTIMISTIC CONCURRENCY CONFLICT PROTECTION
// ============================================================================
export async function listCloudProjects(
  userId: string,
  params: { includeDeleted?: boolean; allOwnersForAdmin?: boolean } = {},
  options?: CloudStorageDriverOptions
): Promise<{
  ok: boolean;
  activeProjects: ProjectData[];
  deletedProjects: ProjectData[];
  error?: string;
}> {
  const sb = getClient(options);
  if (!sb) {
    return {
      ok: false,
      activeProjects: loadUserCachedProjects(userId, options),
      deletedProjects: loadUserDeletedCachedProjects(userId, options),
      error: 'Supabase cloud storage is not configured.',
    };
  }

  if (!isDeviceOnline(options)) {
    return {
      ok: false,
      activeProjects: loadUserCachedProjects(userId, options),
      deletedProjects: loadUserDeletedCachedProjects(userId, options),
      error: 'Offline — showing cached projects.',
    };
  }

  try {
    const rows = await withExponentialBackoff(async () => {
      let query = sb
        .from('user_projects')
        .select('*')
        .order('updated_at', { ascending: false });

      if (!params.allOwnersForAdmin) {
        query = query.eq('owner_user_id', userId);
      }
      if (!params.includeDeleted) {
        query = query.is('deleted_at', null);
      }

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (Array.isArray(data) ? data : []) as DbProjectRow[];
    }, options);

    const activeProjects: ProjectData[] = [];
    const deletedProjects: ProjectData[] = [];

    for (const row of rows) {
      const mapped = mapDbRowToProject(row);
      if (row.deleted_at) {
        deletedProjects.push(mapped);
      } else {
        activeProjects.push(mapped);
      }
    }

    if (!params.allOwnersForAdmin) {
      saveUserCachedProjects(userId, activeProjects, options);
      if (params.includeDeleted) {
        saveUserDeletedCachedProjects(userId, deletedProjects, options);
      }
    }

    return { ok: true, activeProjects, deletedProjects };
  } catch (err) {
    return {
      ok: false,
      activeProjects: loadUserCachedProjects(userId, options),
      deletedProjects: loadUserDeletedCachedProjects(userId, options),
      error: err instanceof Error ? err.message : 'Failed to load cloud projects.',
    };
  }
}

async function createVersionSnapshotRow(
  sb: SupabaseClient,
  row: DbProjectRow,
  userId: string,
  changeSummary: string
): Promise<void> {
  await sb
    .from('project_versions')
    .upsert(
      {
        project_id: row.id,
        owner_user_id: row.owner_user_id,
        version_number: row.version,
        change_summary: changeSummary,
        project_data: row.project_data,
        metadata: row.metadata ?? {},
        created_by: userId,
      },
      { onConflict: 'project_id,version_number' }
    );
}

export async function upsertCloudProject(
  userId: string,
  project: ProjectData,
  params: {
    expectedVersion?: number;
    changeSummary?: string;
    createVersionSnapshot?: boolean;
    forceOverwrite?: boolean;
    queueOnOffline?: boolean;
  } = {},
  options?: CloudStorageDriverOptions
): Promise<UpsertCloudProjectResult> {
  const sb = getClient(options);
  const queueOnOffline = params.queueOnOffline !== false;

  if (!sb || !isDeviceOnline(options)) {
    const offlineProject: ProjectData = {
      ...project,
      ownerUserId: project.ownerUserId ?? userId,
      syncStatus: !sb ? 'local-only' : 'offline',
    };
    if (sb && queueOnOffline) {
      enqueuePendingSyncOp(
        userId,
        {
          kind: 'upsert',
          clientProjectId: project.id,
          cloudId: project.cloudId,
          expectedVersion: params.expectedVersion ?? project.cloudVersion,
          projectSnapshot: offlineProject,
          changeSummary: params.changeSummary ?? 'Offline auto-save',
          createVersionSnapshot: params.createVersionSnapshot,
        },
        options
      );
    }
    return {
      ok: false,
      project: offlineProject,
      queuedOffline: Boolean(sb && queueOnOffline),
      error: !sb
        ? 'Supabase is not configured; saved to local cache.'
        : 'Device is offline; queued for automatic cloud sync when online.',
    };
  }

  try {
    const result = await withExponentialBackoff(async (): Promise<UpsertCloudProjectResult> => {
      // Check if project already exists in Supabase (by cloudId or owner + client_project_id)
      let existingRow: DbProjectRow | null = null;
      if (project.cloudId) {
        const { data, error } = await sb
          .from('user_projects')
          .select('*')
          .eq('id', project.cloudId)
          .maybeSingle();
        if (error) throw new Error(error.message);
        existingRow = (data as DbProjectRow | null) ?? null;
      }
      if (!existingRow) {
        const { data, error } = await sb
          .from('user_projects')
          .select('*')
          .eq('owner_user_id', userId)
          .eq('client_project_id', project.id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        existingRow = (data as DbProjectRow | null) ?? null;
      }

      const expectedVersion = params.expectedVersion ?? project.cloudVersion;

      // Optimistic Concurrency Conflict Detection
      if (
        existingRow &&
        !params.forceOverwrite &&
        expectedVersion !== undefined &&
        existingRow.version > expectedVersion
      ) {
        const remoteProject = mapDbRowToProject(existingRow);
        return {
          ok: false,
          conflict: {
            clientProjectId: project.id,
            cloudId: existingRow.id,
            projectName: project.name,
            localVersion: expectedVersion,
            remoteVersion: existingRow.version,
            localUpdatedAt: project.updatedAt,
            remoteUpdatedAt: existingRow.updated_at,
            localProject: { ...project, cloudId: existingRow.id, syncStatus: 'conflict' },
            remoteProject,
          },
          error: `Sync conflict detected: "${project.name}" was updated on another device (cloud v${existingRow.version} vs local v${expectedVersion}).`,
        };
      }

      const contentHash = computeProjectContentHash(project);

      // Skip redundant write if content is identical and not deleted/restored
      if (
        existingRow &&
        !existingRow.deleted_at &&
        existingRow.content_hash === contentHash &&
        existingRow.name === project.name &&
        !params.createVersionSnapshot
      ) {
        const synced = mapDbRowToProject(existingRow);
        clearPendingSyncOpsForProject(userId, project.id, options);
        return { ok: true, project: synced };
      }

      const metadata = extractProjectMetadata(project);

      if (!existingRow) {
        // Insert new cloud project
        const cleanData = stripTransientCloudFields(project);
        const { data: inserted, error: insertErr } = await sb
          .from('user_projects')
          .insert({
            client_project_id: project.id,
            owner_user_id: userId,
            name: project.name.trim() || 'Untitled Project',
            ref_code: project.refCode || '',
            project_type: project.projectType || 'Residential',
            building_type: project.buildingType || null,
            status: project.status || 'Active',
            description: project.description || '',
            metadata,
            project_data: cleanData,
            version: 1,
            content_hash: contentHash,
            last_modified_by: userId,
            deleted_at: null,
          })
          .select('*')
          .single();

        if (insertErr || !inserted) {
          throw new Error(insertErr?.message || 'Failed to create project in Supabase.');
        }

        let insertedRow = inserted as DbProjectRow;

        // Offload large base64 drawing underlay to Supabase Storage if present
        const offloaded = await offloadHeavyOverlayToStorage(
          userId,
          insertedRow.id,
          project,
          options
        );
        if (
          offloaded.aiDrawingImport?.referenceOverlay?.storagePath &&
          !project.aiDrawingImport?.referenceOverlay?.storagePath
        ) {
          const cleanOffloaded = stripTransientCloudFields(offloaded);
          const { data: updatedAfterOffload } = await sb
            .from('user_projects')
            .update({
              project_data: cleanOffloaded,
              content_hash: computeProjectContentHash(offloaded),
            })
            .eq('id', insertedRow.id)
            .select('*')
            .single();
          if (updatedAfterOffload) {
            insertedRow = updatedAfterOffload as DbProjectRow;
          }
        }

        // Always create version 1 snapshot on initial creation
        await createVersionSnapshotRow(
          sb,
          insertedRow,
          userId,
          params.changeSummary || 'Initial project creation'
        );

        clearPendingSyncOpsForProject(userId, project.id, options);
        return { ok: true, project: mapDbRowToProject(insertedRow) };
      }

      // Update existing cloud project with atomic optimistic version check
      const offloadedProject = await offloadHeavyOverlayToStorage(
        userId,
        existingRow.id,
        project,
        options
      );
      const cleanData = stripTransientCloudFields(offloadedProject);
      const nextVersion = existingRow.version + 1;
      const updateQuery = sb
        .from('user_projects')
        .update({
          name: offloadedProject.name.trim() || existingRow.name,
          ref_code: offloadedProject.refCode || existingRow.ref_code,
          project_type: offloadedProject.projectType || existingRow.project_type,
          building_type: offloadedProject.buildingType || null,
          status: offloadedProject.status || existingRow.status,
          description: offloadedProject.description ?? existingRow.description,
          metadata,
          project_data: cleanData,
          version: nextVersion,
          content_hash: computeProjectContentHash(offloadedProject),
          last_modified_by: userId,
          deleted_at: null,
        })
        .eq('id', existingRow.id);

      const scopedUpdate = params.forceOverwrite
        ? updateQuery
        : updateQuery.eq('version', existingRow.version);

      const { data: updatedRows, error: updateErr } = await scopedUpdate.select('*');
      if (updateErr) throw new Error(updateErr.message);

      const updatedRow = Array.isArray(updatedRows) ? (updatedRows[0] as DbProjectRow | undefined) : undefined;
      if (!updatedRow) {
        // Race condition: another device incremented version mid-flight
        const { data: latest } = await sb
          .from('user_projects')
          .select('*')
          .eq('id', existingRow.id)
          .maybeSingle();
        if (latest) {
          const latestRow = latest as DbProjectRow;
          return {
            ok: false,
            conflict: {
              clientProjectId: project.id,
              cloudId: latestRow.id,
              projectName: project.name,
              localVersion: expectedVersion ?? existingRow.version,
              remoteVersion: latestRow.version,
              localUpdatedAt: project.updatedAt,
              remoteUpdatedAt: latestRow.updated_at,
              localProject: { ...project, cloudId: latestRow.id, syncStatus: 'conflict' },
              remoteProject: mapDbRowToProject(latestRow),
            },
            error: `Sync conflict detected while saving "${project.name}".`,
          };
        }
        throw new Error('Could not confirm updated project row.');
      }

      if (params.createVersionSnapshot || nextVersion % 5 === 0) {
        await createVersionSnapshotRow(
          sb,
          updatedRow,
          userId,
          params.changeSummary || `Saved revision v${nextVersion}`
        );
      }

      clearPendingSyncOpsForProject(userId, project.id, options);
      return { ok: true, project: mapDbRowToProject(updatedRow) };
    }, options);

    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Cloud save failed.';
    if (queueOnOffline) {
      enqueuePendingSyncOp(
        userId,
        {
          kind: 'upsert',
          clientProjectId: project.id,
          cloudId: project.cloudId,
          expectedVersion: params.expectedVersion ?? project.cloudVersion,
          projectSnapshot: { ...project, syncStatus: 'pending' },
          changeSummary: params.changeSummary ?? 'Queued retry save',
          createVersionSnapshot: params.createVersionSnapshot,
          lastError: errMsg,
        },
        options
      );
    }
    return {
      ok: false,
      project: { ...project, syncStatus: 'pending' },
      queuedOffline: queueOnOffline,
      error: errMsg,
    };
  }
}

export async function renameCloudProject(
  userId: string,
  project: ProjectData,
  newName: string,
  options?: CloudStorageDriverOptions
): Promise<UpsertCloudProjectResult> {
  const trimmed = newName.trim();
  if (!trimmed) {
    return { ok: false, error: 'Project name cannot be empty.' };
  }
  const renamed: ProjectData = {
    ...project,
    name: trimmed,
    updatedAt: new Date().toISOString(),
  };
  return upsertCloudProject(
    userId,
    renamed,
    {
      expectedVersion: project.cloudVersion,
      changeSummary: `Renamed project to "${trimmed}"`,
      createVersionSnapshot: true,
    },
    options
  );
}

export async function duplicateCloudProject(
  userId: string,
  sourceProject: ProjectData,
  newName?: string,
  options?: CloudStorageDriverOptions
): Promise<UpsertCloudProjectResult> {
  const copyName = (newName || `${sourceProject.name} (Copy)`).trim();
  const baseClean = stripTransientCloudFields(sourceProject);
  const duplicated: ProjectData = {
    ...JSON.parse(JSON.stringify(baseClean)),
    id: generateId('proj'),
    refCode: `BS-${String(Math.floor(1000 + Math.random() * 9000))}`,
    name: copyName,
    status: 'Saved',
    updatedAt: new Date().toISOString(),
  };

  return upsertCloudProject(
    userId,
    duplicated,
    {
      changeSummary: `Duplicated from "${sourceProject.name}"`,
      createVersionSnapshot: true,
    },
    options
  );
}

export async function softDeleteCloudProject(
  userId: string,
  project: ProjectData,
  options?: CloudStorageDriverOptions
): Promise<{ ok: boolean; deletedAt?: string; queuedOffline?: boolean; error?: string }> {
  const deletedAt = new Date().toISOString();
  const sb = getClient(options);

  if (!sb || !isDeviceOnline(options)) {
    if (sb) {
      enqueuePendingSyncOp(
        userId,
        {
          kind: 'soft-delete',
          clientProjectId: project.id,
          cloudId: project.cloudId,
          projectSnapshot: { ...project, deletedAt },
        },
        options
      );
    }
    return { ok: true, deletedAt, queuedOffline: Boolean(sb) };
  }

  try {
    await withExponentialBackoff(async () => {
      let query = sb
        .from('user_projects')
        .update({ deleted_at: deletedAt, last_modified_by: userId });
      query = project.cloudId
        ? query.eq('id', project.cloudId)
        : query.eq('owner_user_id', userId).eq('client_project_id', project.id);
      const { error } = await query;
      if (error) throw new Error(error.message);
    }, options);

    clearPendingSyncOpsForProject(userId, project.id, options);
    return { ok: true, deletedAt };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Failed to delete project in cloud.';
    enqueuePendingSyncOp(
      userId,
      {
        kind: 'soft-delete',
        clientProjectId: project.id,
        cloudId: project.cloudId,
        projectSnapshot: { ...project, deletedAt },
        lastError: errMsg,
      },
      options
    );
    return { ok: false, deletedAt, queuedOffline: true, error: errMsg };
  }
}

export async function restoreCloudProject(
  userId: string,
  project: ProjectData,
  options?: CloudStorageDriverOptions
): Promise<{ ok: boolean; project?: ProjectData; queuedOffline?: boolean; error?: string }> {
  const sb = getClient(options);

  if (!sb || !isDeviceOnline(options)) {
    const restoredLocal: ProjectData = {
      ...project,
      deletedAt: null,
      updatedAt: new Date().toISOString(),
      syncStatus: sb ? 'offline' : 'local-only',
    };
    if (sb) {
      enqueuePendingSyncOp(
        userId,
        {
          kind: 'restore',
          clientProjectId: project.id,
          cloudId: project.cloudId,
          projectSnapshot: restoredLocal,
        },
        options
      );
    }
    return { ok: true, project: restoredLocal, queuedOffline: Boolean(sb) };
  }

  try {
    const restoredRow = await withExponentialBackoff(async () => {
      let query = sb
        .from('user_projects')
        .update({ deleted_at: null, last_modified_by: userId });
      query = project.cloudId
        ? query.eq('id', project.cloudId)
        : query.eq('owner_user_id', userId).eq('client_project_id', project.id);
      const { data, error } = await query.select('*').single();
      if (error || !data) throw new Error(error?.message || 'Project could not be restored.');
      return data as DbProjectRow;
    }, options);

    clearPendingSyncOpsForProject(userId, project.id, options);
    return { ok: true, project: mapDbRowToProject(restoredRow) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to restore project from cloud.',
    };
  }
}

export async function permanentlyDeleteCloudProject(
  userId: string,
  project: ProjectData,
  options?: CloudStorageDriverOptions
): Promise<{ ok: boolean; error?: string }> {
  const sb = getClient(options);
  if (!sb) return { ok: true };
  if (!isDeviceOnline(options)) {
    return { ok: false, error: 'Permanent deletion requires an active internet connection.' };
  }

  try {
    // Delete associated storage objects first
    if (project.cloudId) {
      const { attachments } = await listProjectAttachments(project.cloudId, options);
      const paths = attachments.map((a) => a.storagePath).filter((p) => validateProjectStoragePath(p));
      if (paths.length > 0) {
        await sb.storage.from(PROJECT_ASSETS_BUCKET).remove(paths).catch(() => {});
      }
    }

    let query = sb.from('user_projects').delete();
    query = project.cloudId
      ? query.eq('id', project.cloudId)
      : query.eq('owner_user_id', userId).eq('client_project_id', project.id);
    const { error } = await query;
    if (error) return { ok: false, error: error.message };

    clearPendingSyncOpsForProject(userId, project.id, options);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Permanent deletion failed.',
    };
  }
}

export async function listProjectVersions(
  cloudProjectId: string,
  options?: CloudStorageDriverOptions
): Promise<{ ok: boolean; versions: ProjectVersionRecord[]; error?: string }> {
  const sb = getClient(options);
  if (!sb) return { ok: false, versions: [], error: 'Supabase not configured.' };
  try {
    const { data, error } = await sb
      .from('project_versions')
      .select('*')
      .eq('project_id', cloudProjectId)
      .order('version_number', { ascending: false })
      .limit(50);

    if (error) return { ok: false, versions: [], error: error.message };
    return {
      ok: true,
      versions: (Array.isArray(data) ? data : []).map((row) =>
        mapDbVersionRow(row as DbVersionRow)
      ),
    };
  } catch (err) {
    return {
      ok: false,
      versions: [],
      error: err instanceof Error ? err.message : 'Failed to load version history.',
    };
  }
}

export async function restoreProjectVersion(
  userId: string,
  currentProject: ProjectData,
  versionId: string,
  options?: CloudStorageDriverOptions
): Promise<UpsertCloudProjectResult> {
  const sb = getClient(options);
  if (!sb) return { ok: false, error: 'Supabase not configured.' };
  try {
    const { data, error } = await sb
      .from('project_versions')
      .select('*')
      .eq('id', versionId)
      .single();
    if (error || !data) {
      return { ok: false, error: error?.message || 'Version snapshot not found.' };
    }
    const ver = mapDbVersionRow(data as DbVersionRow);
    if (!ver.projectData) {
      return { ok: false, error: 'Version snapshot contains no project data.' };
    }
    const restored: ProjectData = {
      ...ver.projectData,
      id: currentProject.id,
      cloudId: currentProject.cloudId,
      ownerUserId: userId,
      cloudVersion: currentProject.cloudVersion,
      updatedAt: new Date().toISOString(),
    };
    return upsertCloudProject(
      userId,
      restored,
      {
        expectedVersion: currentProject.cloudVersion,
        changeSummary: `Restored from version v${ver.versionNumber}`,
        createVersionSnapshot: true,
      },
      options
    );
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to restore project version.',
    };
  }
}

// ============================================================================
// SAFE, VERIFIED localStorage -> SUPABASE MIGRATION
// Never overwrites newer cloud projects; verifies read-back before removing local copies!
// ============================================================================
const INITIAL_PRESET_HASHES = new Map(
  INITIAL_PROJECTS.map((p) => [p.id, computeProjectContentHash(p)])
);

function isUnmodifiedSamplePreset(project: ProjectData): boolean {
  const presetHash = INITIAL_PRESET_HASHES.get(project.id);
  if (!presetHash) return false;
  return computeProjectContentHash(project) === presetHash;
}

export async function migrateLocalProjectsToSupabase(
  userId: string,
  options?: CloudStorageDriverOptions
): Promise<LocalMigrationReport> {
  const sb = getClient(options);
  if (!sb || !isDeviceOnline(options)) {
    return {
      attempted: false,
      migratedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      cleanedLegacyLocalStorage: false,
      errors: [],
    };
  }

  const migrationMarkerKey = `${MIGRATION_KEY_PREFIX}${userId}`;
  const rawLegacyV2 = readStorageItem(STORAGE_KEY, options);
  const rawLegacyV1 = readStorageItem('ananya_space_designer_projects_v1', options);

  if (!rawLegacyV2 && !rawLegacyV1) {
    return {
      attempted: false,
      migratedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      cleanedLegacyLocalStorage: false,
      errors: [],
    };
  }

  // Parse legacy projects safely
  let legacyProjects: ProjectData[] = [];
  try {
    const parsed = JSON.parse(rawLegacyV2 || rawLegacyV1 || '[]');
    if (Array.isArray(parsed)) {
      legacyProjects = parsed.filter(
        (p): p is ProjectData => Boolean(p && typeof p === 'object' && typeof p.id === 'string')
      );
    }
  } catch (err) {
    return {
      attempted: true,
      migratedCount: 0,
      skippedCount: 0,
      failedCount: 1,
      cleanedLegacyLocalStorage: false,
      errors: [err instanceof Error ? err.message : 'Legacy localStorage data could not be parsed.'],
    };
  }

  if (legacyProjects.length === 0) {
    return {
      attempted: false,
      migratedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      cleanedLegacyLocalStorage: false,
      errors: [],
    };
  }

  // Load existing cloud projects for this user to avoid overwriting newer cloud records
  const existingCloud = await listCloudProjects(userId, { includeDeleted: true }, options);
  if (!existingCloud.ok) {
    return {
      attempted: true,
      migratedCount: 0,
      skippedCount: 0,
      failedCount: legacyProjects.length,
      cleanedLegacyLocalStorage: false,
      errors: [existingCloud.error || 'Could not verify existing cloud projects prior to migration.'],
    };
  }

  const allCloudByClientId = new Map<string, ProjectData>();
  for (const p of [...existingCloud.activeProjects, ...existingCloud.deletedProjects]) {
    allCloudByClientId.set(p.id, p);
  }
  const userAlreadyHasCloudProjects = allCloudByClientId.size > 0;

  let migratedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  for (const localProj of legacyProjects) {
    const cloudMatch = allCloudByClientId.get(localProj.id);

    // If user already has cloud projects, skip unmodified built-in sample templates
    if (userAlreadyHasCloudProjects && !cloudMatch && isUnmodifiedSamplePreset(localProj)) {
      skippedCount += 1;
      continue;
    }

    if (cloudMatch) {
      // Never overwrite a matching cloud project! Only migrate as a safe copy if local has newer unsaved edits.
      const localHash = computeProjectContentHash(localProj);
      const cloudHash = computeProjectContentHash(cloudMatch);
      const localTs = Date.parse(localProj.updatedAt || '') || 0;
      const cloudTs = Date.parse(cloudMatch.updatedAt || '') || 0;

      if (localHash === cloudHash || localTs <= cloudTs) {
        skippedCount += 1;
        continue;
      }

      // Preserve both: create a safely named migrated copy so cloud data is NEVER overwritten
      const safeCopy: ProjectData = {
        ...stripTransientCloudFields(localProj),
        id: `${localProj.id}-local-${Date.now().toString(36)}`,
        name: `${localProj.name} (Migrated Local Copy)`,
      };
      const copyRes = await upsertCloudProject(
        userId,
        safeCopy,
        {
          changeSummary: 'Migrated newer localStorage copy without overwriting cloud version',
          createVersionSnapshot: true,
          queueOnOffline: false,
        },
        options
      );
      if (copyRes.ok && copyRes.project?.cloudId) {
        // Explicit read-back verification before counting as migrated
        const { data: verified } = await sb
          .from('user_projects')
          .select('id')
          .eq('id', copyRes.project.cloudId)
          .maybeSingle();
        if (verified?.id) {
          migratedCount += 1;
        } else {
          failedCount += 1;
          errors.push(`Read-back verification failed for "${safeCopy.name}".`);
        }
      } else {
        failedCount += 1;
        errors.push(copyRes.error || `Failed to migrate "${localProj.name}".`);
      }
      continue;
    }

    // Upload brand-new project from localStorage to Supabase
    const res = await upsertCloudProject(
      userId,
      stripTransientCloudFields(localProj),
      {
        changeSummary: 'Migrated from browser localStorage to Supabase cloud',
        createVersionSnapshot: true,
        queueOnOffline: false,
      },
      options
    );

    if (res.ok && res.project?.cloudId) {
      // Explicit read-back verification before removing legacy localStorage copy!
      const { data: verified, error: verifyErr } = await sb
        .from('user_projects')
        .select('id, version')
        .eq('id', res.project.cloudId)
        .maybeSingle();

      if (!verifyErr && verified?.id) {
        migratedCount += 1;
      } else {
        failedCount += 1;
        errors.push(`Cloud verification failed for "${localProj.name}".`);
      }
    } else {
      failedCount += 1;
      errors.push(res.error || `Failed to migrate "${localProj.name}".`);
    }
  }

  // ONLY remove legacy localStorage copies once 100% of candidate projects are verified in Supabase!
  let cleanedLegacyLocalStorage = false;
  if (failedCount === 0) {
    removeStorageItem(STORAGE_KEY, options);
    removeStorageItem('ananya_space_designer_projects_v1', options);
    writeStorageItem(
      migrationMarkerKey,
      JSON.stringify({
        completedAt: new Date().toISOString(),
        migratedCount,
        skippedCount,
      }),
      options
    );
    cleanedLegacyLocalStorage = true;
  }

  return {
    attempted: true,
    migratedCount,
    skippedCount,
    failedCount,
    cleanedLegacyLocalStorage,
    errors,
  };
}

// ============================================================================
// OFFLINE QUEUE FLUSHING & CONFLICT RESOLUTION
// ============================================================================
export async function flushPendingSyncQueue(
  userId: string,
  options?: CloudStorageDriverOptions
): Promise<FlushSyncQueueResult> {
  const queue = loadPendingSyncQueue(userId, options);
  if (queue.length === 0) {
    return {
      processed: 0,
      succeeded: 0,
      conflicts: [],
      remaining: 0,
      errors: [],
      updatedProjects: [],
    };
  }

  const sb = getClient(options);
  if (!sb || !isDeviceOnline(options)) {
    return {
      processed: 0,
      succeeded: 0,
      conflicts: [],
      remaining: queue.length,
      errors: [],
      updatedProjects: [],
    };
  }

  const remaining: PendingSyncOperation[] = [];
  const conflicts: ProjectConflictInfo[] = [];
  const errors: string[] = [];
  const updatedProjects: ProjectData[] = [];
  let succeeded = 0;

  for (const op of queue) {
    if (op.kind === 'upsert' && op.projectSnapshot) {
      const res = await upsertCloudProject(
        userId,
        op.projectSnapshot,
        {
          expectedVersion: op.expectedVersion,
          changeSummary: op.changeSummary || 'Synced offline changes',
          createVersionSnapshot: op.createVersionSnapshot,
          queueOnOffline: false,
        },
        options
      );
      if (res.ok && res.project) {
        succeeded += 1;
        updatedProjects.push(res.project);
      } else if (res.conflict) {
        conflicts.push(res.conflict);
      } else {
        remaining.push({ ...op, attempts: op.attempts + 1, lastError: res.error ?? null });
        if (res.error) errors.push(res.error);
      }
    } else if (op.kind === 'rename' && op.projectSnapshot && op.newName) {
      const res = await renameCloudProject(userId, op.projectSnapshot, op.newName, options);
      if (res.ok && res.project) {
        succeeded += 1;
        updatedProjects.push(res.project);
      } else if (res.conflict) {
        conflicts.push(res.conflict);
      } else {
        remaining.push({ ...op, attempts: op.attempts + 1, lastError: res.error ?? null });
        if (res.error) errors.push(res.error);
      }
    } else if (op.kind === 'soft-delete' && op.projectSnapshot) {
      const res = await softDeleteCloudProject(userId, op.projectSnapshot, options);
      if (res.ok && !res.queuedOffline) {
        succeeded += 1;
      } else {
        remaining.push({ ...op, attempts: op.attempts + 1, lastError: res.error ?? null });
        if (res.error) errors.push(res.error);
      }
    } else if (op.kind === 'restore' && op.projectSnapshot) {
      const res = await restoreCloudProject(userId, op.projectSnapshot, options);
      if (res.ok && res.project && !res.queuedOffline) {
        succeeded += 1;
        updatedProjects.push(res.project);
      } else {
        remaining.push({ ...op, attempts: op.attempts + 1, lastError: res.error ?? null });
        if (res.error) errors.push(res.error);
      }
    }
  }

  savePendingSyncQueue(userId, remaining, options);
  return {
    processed: queue.length,
    succeeded,
    conflicts,
    remaining: remaining.length,
    errors,
    updatedProjects,
  };
}

export async function resolveProjectConflict(
  userId: string,
  conflict: ProjectConflictInfo,
  strategy: 'use-cloud' | 'keep-local' | 'keep-both',
  options?: CloudStorageDriverOptions
): Promise<{ ok: boolean; resolvedProjects: ProjectData[]; error?: string }> {
  clearPendingSyncOpsForProject(userId, conflict.clientProjectId, options);

  if (strategy === 'use-cloud') {
    return { ok: true, resolvedProjects: [conflict.remoteProject] };
  }

  if (strategy === 'keep-local') {
    const res = await upsertCloudProject(
      userId,
      {
        ...conflict.localProject,
        cloudId: conflict.cloudId,
        cloudVersion: conflict.remoteVersion,
      },
      {
        forceOverwrite: true,
        changeSummary: `Conflict resolved: kept local version over cloud v${conflict.remoteVersion}`,
        createVersionSnapshot: true,
      },
      options
    );
    if (!res.ok || !res.project) {
      return { ok: false, resolvedProjects: [], error: res.error || 'Could not overwrite cloud copy.' };
    }
    return { ok: true, resolvedProjects: [res.project] };
  }

  // keep-both: preserve remote project untouched AND save local edits as a new duplicate project
  const dupRes = await duplicateCloudProject(
    userId,
    conflict.localProject,
    `${conflict.projectName} (Conflict Copy)`,
    options
  );
  if (!dupRes.ok || !dupRes.project) {
    return {
      ok: false,
      resolvedProjects: [conflict.remoteProject],
      error: dupRes.error || 'Could not save local copy.',
    };
  }
  return { ok: true, resolvedProjects: [conflict.remoteProject, dupRes.project] };
}

// ============================================================================
// CROSS-DEVICE REALTIME SUBSCRIPTION
// ============================================================================
export interface RealtimeProjectCallbacks {
  onUpsert: (project: ProjectData) => void;
  onSoftDelete: (project: ProjectData) => void;
  onHardDelete: (cloudId: string, clientProjectId?: string) => void;
}

export function subscribeToUserProjectsRealtime(
  userId: string,
  callbacks: RealtimeProjectCallbacks,
  options?: CloudStorageDriverOptions
): () => void {
  const sb = getClient(options);
  if (!sb || typeof sb.channel !== 'function') {
    return () => {};
  }

  const channel = sb
    .channel(`bluespace-projects-${userId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'user_projects',
        filter: `owner_user_id=eq.${userId}`,
      },
      (payload: {
        eventType: string;
        new?: Record<string, unknown>;
        old?: Record<string, unknown>;
      }) => {
        if (payload.eventType === 'DELETE') {
          const oldRow = payload.old as Partial<DbProjectRow> | undefined;
          if (oldRow?.id) {
            callbacks.onHardDelete(oldRow.id, oldRow.client_project_id);
          }
          return;
        }
        const newRow = payload.new as DbProjectRow | undefined;
        if (!newRow || !newRow.id) return;
        const mapped = mapDbRowToProject(newRow);
        if (newRow.deleted_at) {
          callbacks.onSoftDelete(mapped);
        } else {
          callbacks.onUpsert(mapped);
        }
      }
    )
    .subscribe();

  return () => {
    try {
      if (typeof sb.removeChannel === 'function') {
        void sb.removeChannel(channel);
      } else if (typeof channel?.unsubscribe === 'function') {
        void channel.unsubscribe();
      }
    } catch {
      // ignore teardown errors
    }
  };
}

/**
 * Helper used in offline / unauthenticated fallback mode so existing localStorage
 * projectStorage continues to behave identically.
 */
export function loadGuestLocalProjects(): ProjectData[] {
  return projectStorage.loadAll();
}
