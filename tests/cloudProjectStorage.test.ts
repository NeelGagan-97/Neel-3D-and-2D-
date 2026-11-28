import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { INITIAL_PROJECTS } from '../src/data/presets';
import {
  ensureCloudProjectStorageProvisioned,
  extractSupabaseProjectRef,
  getCloudProjectEnvDiagnostics,
} from '../src/server/supabaseProjectProvisioner';
import {
  deleteProjectAttachment,
  duplicateCloudProject,
  flushPendingSyncQueue,
  getAttachmentSignedUrl,
  listCloudProjects,
  listProjectAttachments,
  listProjectVersions,
  loadPendingSyncQueue,
  MAX_ATTACHMENT_SIZE_BYTES,
  migrateLocalProjectsToSupabase,
  permanentlyDeleteCloudProject,
  renameCloudProject,
  resolveProjectConflict,
  restoreCloudProject,
  restoreProjectVersion,
  sanitizeAttachmentFilename,
  softDeleteCloudProject,
  subscribeToUserProjectsRealtime,
  uploadProjectAttachment,
  upsertCloudProject,
  validateAttachmentInput,
  validateProjectStoragePath,
} from '../src/services/cloudProjectStorage';
import { STORAGE_KEY } from '../src/services/projectStorage';
import type { ProjectData } from '../src/types/design';

// ============================================================================
// IN-MEMORY RLS-ENFORCING SUPABASE CLIENT DOUBLE (POSTGREST + STORAGE + REALTIME)
// ============================================================================
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

interface TableRow {
  id: string;
  owner_user_id?: string;
  [key: string]: unknown;
}

class InMemorySupabaseBackend {
  tables: Record<string, TableRow[]> = {
    user_projects: [],
    project_versions: [],
    project_attachments: [],
  };
  storageObjects = new Map<string, { bucket: string; contentType: string; size: number }>();
  realtimeListeners: Array<{
    ownerFilter: string | null;
    cb: (payload: { eventType: string; new?: TableRow; old?: TableRow }) => void;
  }> = [];
  private idSeq = 1;
  failNextWrites = 0;
  permanentFailureMessage: string | null = null;

  nextUuid(prefix = 'uuid'): string {
    return `${prefix}-${String(this.idSeq++).padStart(6, '0')}`;
  }

  emitRealtime(eventType: 'INSERT' | 'UPDATE' | 'DELETE', newRow?: TableRow, oldRow?: TableRow) {
    const owner = (newRow?.owner_user_id ?? oldRow?.owner_user_id ?? '') as string;
    for (const listener of this.realtimeListeners) {
      if (!listener.ownerFilter || listener.ownerFilter === `owner_user_id=eq.${owner}`) {
        listener.cb({
          eventType,
          new: newRow ? structuredClone(newRow) : undefined,
          old: oldRow ? structuredClone(oldRow) : undefined,
        });
      }
    }
  }

  createClientFor(actingUserId: string, isApprovedAdmin = false): SupabaseClient {
    const backend = this;

    const canAccessRow = (row: TableRow): boolean =>
      isApprovedAdmin || row.owner_user_id === actingUserId;

    const makeQueryBuilder = (table: string) => {
      const filters: Array<(r: TableRow) => boolean> = [];
      let orderCol: string | null = null;
      let orderAsc = true;
      let limitN: number | null = null;
      let operation: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
      let payload: Record<string, unknown> | null = null;
      let upsertConflictCols: string[] = [];

      const applyFilters = (rows: TableRow[]) => {
        let res = rows.filter((r) => canAccessRow(r) && filters.every((f) => f(r)));
        if (orderCol) {
          const col = orderCol;
          res = [...res].sort((a, b) => {
            const av = a[col];
            const bv = b[col];
            if (av === bv) return 0;
            if (av === undefined || av === null) return 1;
            if (bv === undefined || bv === null) return -1;
            const cmp = av < bv ? -1 : 1;
            return orderAsc ? cmp : -cmp;
          });
        }
        if (limitN !== null) {
          res = res.slice(0, limitN);
        }
        return res.map((r) => structuredClone(r));
      };

      const execute = async (): Promise<{ data: unknown; error: { message: string } | null }> => {
        if (backend.permanentFailureMessage) {
          return { data: null, error: { message: backend.permanentFailureMessage } };
        }
        if (operation !== 'select' && backend.failNextWrites > 0) {
          backend.failNextWrites -= 1;
          return { data: null, error: { message: 'Temporary network 503 timeout' } };
        }

        const rows = backend.tables[table];
        if (!rows) {
          return { data: null, error: { message: `Table ${table} does not exist` } };
        }

        if (operation === 'select') {
          return { data: applyFilters(rows), error: null };
        }

        if (operation === 'insert') {
          const rec = structuredClone(payload!) as TableRow;
          if (!isApprovedAdmin && rec.owner_user_id !== actingUserId) {
            return { data: null, error: { message: 'RLS policy violation on INSERT' } };
          }
          const now = new Date().toISOString();
          rec.id = rec.id || backend.nextUuid(table.slice(0, 4));
          rec.created_at = rec.created_at || now;
          rec.updated_at = rec.updated_at || now;
          rows.push(rec);
          if (table === 'user_projects') backend.emitRealtime('INSERT', rec);
          return { data: [structuredClone(rec)], error: null };
        }

        if (operation === 'upsert') {
          const rec = structuredClone(payload!) as TableRow;
          if (!isApprovedAdmin && rec.owner_user_id !== actingUserId) {
            return { data: null, error: { message: 'RLS policy violation on UPSERT' } };
          }
          const matchIdx =
            upsertConflictCols.length > 0
              ? rows.findIndex((existing) =>
                  upsertConflictCols.every((c) => existing[c] === rec[c])
                )
              : -1;
          const now = new Date().toISOString();
          if (matchIdx >= 0) {
            const updated = { ...rows[matchIdx], ...rec, updated_at: now };
            rows[matchIdx] = updated;
            return { data: [structuredClone(updated)], error: null };
          }
          rec.id = rec.id || backend.nextUuid(table.slice(0, 4));
          rec.created_at = rec.created_at || now;
          rec.updated_at = rec.updated_at || now;
          rows.push(rec);
          return { data: [structuredClone(rec)], error: null };
        }

        if (operation === 'update') {
          const matched: TableRow[] = [];
          const now = new Date().toISOString();
          for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            if (canAccessRow(r) && filters.every((f) => f(r))) {
              const updated = { ...r, ...structuredClone(payload!), updated_at: now };
              rows[i] = updated;
              matched.push(structuredClone(updated));
              if (table === 'user_projects') backend.emitRealtime('UPDATE', updated, r);
            }
          }
          return { data: matched, error: null };
        }

        if (operation === 'delete') {
          const removed: TableRow[] = [];
          for (let i = rows.length - 1; i >= 0; i--) {
            const r = rows[i];
            if (canAccessRow(r) && filters.every((f) => f(r))) {
              rows.splice(i, 1);
              removed.push(structuredClone(r));
              if (table === 'user_projects') backend.emitRealtime('DELETE', undefined, r);
            }
          }
          return { data: removed, error: null };
        }

        return { data: [], error: null };
      };

      const builder: Record<string, unknown> = {
        select() {
          return builder;
        },
        insert(data: Record<string, unknown>) {
          operation = 'insert';
          payload = data;
          return builder;
        },
        upsert(data: Record<string, unknown>, opts?: { onConflict?: string }) {
          operation = 'upsert';
          payload = data;
          upsertConflictCols = opts?.onConflict ? opts.onConflict.split(',').map((s) => s.trim()) : [];
          return builder;
        },
        update(data: Record<string, unknown>) {
          operation = 'update';
          payload = data;
          return builder;
        },
        delete() {
          operation = 'delete';
          return builder;
        },
        eq(col: string, val: unknown) {
          filters.push((r) => r[col] === val);
          return builder;
        },
        is(col: string, val: unknown) {
          filters.push((r) => (r[col] ?? null) === val);
          return builder;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          orderCol = col;
          orderAsc = opts?.ascending !== false;
          return builder;
        },
        limit(n: number) {
          limitN = n;
          return builder;
        },
        async single() {
          const res = await execute();
          if (res.error) return { data: null, error: res.error };
          const arr = Array.isArray(res.data) ? res.data : [];
          if (arr.length === 0) return { data: null, error: { message: 'Row not found' } };
          return { data: arr[0], error: null };
        },
        async maybeSingle() {
          const res = await execute();
          if (res.error) return { data: null, error: res.error };
          const arr = Array.isArray(res.data) ? res.data : [];
          return { data: arr[0] ?? null, error: null };
        },
        then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
          return execute().then(onFulfilled, onRejected);
        },
      };

      return builder;
    };

    const client = {
      from: (table: string) => makeQueryBuilder(table),
      storage: {
        from: (bucket: string) => ({
          async upload(storagePath: string, file: Blob, opts?: { contentType?: string }) {
            const ownerFolder = storagePath.split('/')[0];
            if (!isApprovedAdmin && ownerFolder !== actingUserId) {
              return { data: null, error: { message: 'Storage RLS violation' } };
            }
            if (backend.failNextWrites > 0) {
              backend.failNextWrites -= 1;
              return { data: null, error: { message: 'Temporary network 503 timeout' } };
            }
            backend.storageObjects.set(storagePath, {
              bucket,
              contentType: opts?.contentType || file.type || 'application/octet-stream',
              size: file.size,
            });
            return { data: { path: storagePath }, error: null };
          },
          async createSignedUrl(storagePath: string, expiresIn: number) {
            const ownerFolder = storagePath.split('/')[0];
            if (!isApprovedAdmin && ownerFolder !== actingUserId) {
              return { data: null, error: { message: 'Storage RLS violation' } };
            }
            if (!backend.storageObjects.has(storagePath)) {
              return { data: null, error: { message: 'Object not found' } };
            }
            return {
              data: {
                signedUrl: `https://example.supabase.co/storage/v1/object/sign/${bucket}/${storagePath}?expires=${expiresIn}`,
              },
              error: null,
            };
          },
          async remove(paths: string[]) {
            for (const p of paths) {
              const ownerFolder = p.split('/')[0];
              if (isApprovedAdmin || ownerFolder === actingUserId) {
                backend.storageObjects.delete(p);
              }
            }
            return { data: paths, error: null };
          },
        }),
      },
      channel: () => {
        let listenerRef: (typeof backend.realtimeListeners)[number] | null = null;
        const ch = {
          on(
            _type: string,
            cfg: { filter?: string },
            cb: (payload: { eventType: string; new?: TableRow; old?: TableRow }) => void
          ) {
            listenerRef = { ownerFilter: cfg.filter ?? null, cb };
            backend.realtimeListeners.push(listenerRef);
            return ch;
          },
          subscribe() {
            return ch;
          },
          unsubscribe() {
            if (listenerRef) {
              backend.realtimeListeners = backend.realtimeListeners.filter((l) => l !== listenerRef);
            }
          },
        };
        return ch;
      },
      removeChannel(ch: { unsubscribe?: () => void }) {
        ch?.unsubscribe?.();
      },
    };

    return client as unknown as SupabaseClient;
  }
}

function makeSampleProject(overrides: Partial<ProjectData> = {}): ProjectData {
  const base = structuredClone(INITIAL_PROJECTS[0]);
  return {
    ...base,
    id: overrides.id ?? `proj-test-${Math.random().toString(36).slice(2, 8)}`,
    name: overrides.name ?? 'Villa Cloud Design',
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// 1. SCHEMA MIGRATION & AUTOMATIC PROVISIONER VERIFICATION
// ============================================================================
test('005_cloud_project_storage.sql defines required tables, indexes, RLS, private bucket, and realtime', async () => {
  const sqlPath = path.resolve(process.cwd(), 'supabase', 'migrations', '005_cloud_project_storage.sql');
  const sql = await fs.readFile(sqlPath, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.user_projects/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.project_versions/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.project_attachments/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /owner_user_id\s*=\s*auth\.uid\(\)\s*OR\s*public\.is_approved_admin\(\)/i);
  assert.match(sql, /bluespace_guard_project_owner/i);
  assert.match(sql, /INSERT INTO storage\.buckets[\s\S]*'project-assets'/i);
  assert.match(sql, /ALTER PUBLICATION supabase_realtime ADD TABLE public\.user_projects/i);
});

test('Auto-provisioner honestly reports missing env vars and parses Supabase project refs safely', async () => {
  assert.equal(
    extractSupabaseProjectRef('https://abcdefgh12345.supabase.co'),
    'abcdefgh12345'
  );
  assert.equal(extractSupabaseProjectRef('https://evil.example.com'), null);

  const diag = getCloudProjectEnvDiagnostics();
  if (!diag.serverSupabaseConfigured) {
    const status = await ensureCloudProjectStorageProvisioned();
    assert.equal(status.provisioned, false);
    assert.ok(status.missingEnvVars.includes('SUPABASE_SERVICE_ROLE_KEY'));
  }
});

// ============================================================================
// 2. FULL PROJECT LIFECYCLE: CREATE, REOPEN, UPDATE, RENAME, DUPLICATE, DELETE, RESTORE
// ============================================================================
test('Project lifecycle: create, reopen, update, version restore, rename, duplicate, soft-delete, restore, permanent delete', async () => {
  const backend = new InMemorySupabaseBackend();
  const userId = 'user-alice';
  const client = backend.createClientFor(userId);
  const storage = new MemoryStorage();
  const opts = { client, storage, retryBaseDelayMs: 0 };

  // 1. Create & save automatically to cloud
  const createdInput = makeSampleProject({ id: 'proj-villa-1', name: 'Oakwood Residence' });
  const createRes = await upsertCloudProject(
    userId,
    createdInput,
    { changeSummary: 'Initial design', createVersionSnapshot: true },
    opts
  );
  assert.equal(createRes.ok, true);
  assert.ok(createRes.project?.cloudId);
  assert.equal(createRes.project?.cloudVersion, 1);
  assert.equal(createRes.project?.ownerUserId, userId);

  // 2. Reopen from cloud & verify full 2D/3D/Electrical/BOQ fields preserved
  const listed1 = await listCloudProjects(userId, { includeDeleted: true }, opts);
  assert.equal(listed1.ok, true);
  assert.equal(listed1.activeProjects.length, 1);
  assert.equal(listed1.activeProjects[0].name, 'Oakwood Residence');
  assert.equal(listed1.activeProjects[0].rooms.length, createdInput.rooms.length);
  assert.equal(listed1.activeProjects[0].points.length, createdInput.points.length);

  // 3. Update project (modify description & add BOQ override) -> version increments to 2
  const edited: ProjectData = {
    ...listed1.activeProjects[0],
    description: 'Updated with EV charger circuit',
    status: 'BOQ Ready',
  };
  const updateRes = await upsertCloudProject(
    userId,
    edited,
    { expectedVersion: 1, changeSummary: 'Added EV circuit', createVersionSnapshot: true },
    opts
  );
  assert.equal(updateRes.ok, true);
  assert.equal(updateRes.project?.cloudVersion, 2);

  // 4. Version history list & restore v1
  const versionsRes = await listProjectVersions(updateRes.project!.cloudId!, opts);
  assert.equal(versionsRes.ok, true);
  assert.equal(versionsRes.versions.length, 2);
  const v1 = versionsRes.versions.find((v) => v.versionNumber === 1)!;
  const restoredVerRes = await restoreProjectVersion(userId, updateRes.project!, v1.id, opts);
  assert.equal(restoredVerRes.ok, true);
  assert.equal(restoredVerRes.project?.cloudVersion, 3);
  assert.equal(restoredVerRes.project?.description, createdInput.description);

  // 5. Rename project
  const renameRes = await renameCloudProject(userId, restoredVerRes.project!, 'Oakwood Smart Villa', opts);
  assert.equal(renameRes.ok, true);
  assert.equal(renameRes.project?.name, 'Oakwood Smart Villa');
  assert.equal(renameRes.project?.cloudVersion, 4);

  // 6. Duplicate project -> gets independent ID and version 1
  const dupRes = await duplicateCloudProject(userId, renameRes.project!, 'Oakwood Option B', opts);
  assert.equal(dupRes.ok, true);
  assert.notEqual(dupRes.project?.cloudId, renameRes.project?.cloudId);
  assert.notEqual(dupRes.project?.id, renameRes.project?.id);
  assert.equal(dupRes.project?.name, 'Oakwood Option B');
  assert.equal(dupRes.project?.cloudVersion, 1);

  // 7. Soft-delete original -> moves from activeProjects to deletedProjects
  const delRes = await softDeleteCloudProject(userId, renameRes.project!, opts);
  assert.equal(delRes.ok, true);
  const listedAfterDel = await listCloudProjects(userId, { includeDeleted: true }, opts);
  assert.equal(listedAfterDel.activeProjects.length, 1);
  assert.equal(listedAfterDel.deletedProjects.length, 1);
  assert.equal(listedAfterDel.deletedProjects[0].name, 'Oakwood Smart Villa');

  // 8. Restore soft-deleted project -> back in activeProjects
  const restoreRes = await restoreCloudProject(userId, listedAfterDel.deletedProjects[0], opts);
  assert.equal(restoreRes.ok, true);
  const listedAfterRestore = await listCloudProjects(userId, { includeDeleted: true }, opts);
  assert.equal(listedAfterRestore.activeProjects.length, 2);
  assert.equal(listedAfterRestore.deletedProjects.length, 0);

  // 9. Permanent delete cleans up record completely
  const permRes = await permanentlyDeleteCloudProject(userId, dupRes.project!, opts);
  assert.equal(permRes.ok, true);
  const finalListed = await listCloudProjects(userId, { includeDeleted: true }, opts);
  assert.equal(finalListed.activeProjects.length, 1);
});

// ============================================================================
// 3. OWNERSHIP ISOLATION & APPROVED ADMIN ACCESS
// ============================================================================
test('User isolation prevents cross-user access while approved admins retain oversight', async () => {
  const backend = new InMemorySupabaseBackend();
  const aliceClient = backend.createClientFor('user-alice', false);
  const bobClient = backend.createClientFor('user-bob', false);
  const adminClient = backend.createClientFor('admin-root', true);
  const storage = new MemoryStorage();

  await upsertCloudProject('user-alice', makeSampleProject({ name: 'Alice Private Plan' }), {}, {
    client: aliceClient,
    storage,
    retryBaseDelayMs: 0,
  });

  const bobList = await listCloudProjects('user-bob', { includeDeleted: true }, {
    client: bobClient,
    storage,
  });
  assert.equal(bobList.ok, true);
  assert.equal(bobList.activeProjects.length, 0);

  const adminList = await listCloudProjects(
    'admin-root',
    { includeDeleted: true, allOwnersForAdmin: true },
    { client: adminClient, storage }
  );
  assert.equal(adminList.ok, true);
  assert.equal(adminList.activeProjects.length, 1);
  assert.equal(adminList.activeProjects[0].name, 'Alice Private Plan');
});

// ============================================================================
// 4. SAFE, VERIFIED localStorage -> SUPABASE MIGRATION
// ============================================================================
test('localStorage migration verifies cloud read-back before cleanup and never overwrites newer cloud projects', async () => {
  const backend = new InMemorySupabaseBackend();
  const userId = 'user-migrate';
  const client = backend.createClientFor(userId);
  const storage = new MemoryStorage();
  const opts = { client, storage, retryBaseDelayMs: 0 };

  // Seed a cloud project already present
  const cloudExisting = makeSampleProject({
    id: 'proj-shared',
    name: 'Cloud Original',
  });
  await upsertCloudProject(userId, cloudExisting, {}, opts);

  // Seed legacy localStorage with:
  // (a) a brand new local-only project
  // (b) a genuinely newer local edit of 'proj-shared' (must NOT overwrite cloud original — saved as migrated copy!)
  const localOnly = makeSampleProject({
    id: 'proj-local-custom',
    name: 'Legacy Local Bungalow',
    updatedAt: new Date(Date.now() + 30_000).toISOString(),
  });
  const localNewerConflict = makeSampleProject({
    id: 'proj-shared',
    name: 'Cloud Original',
    description: 'Local edited offline before migration',
    updatedAt: new Date(Date.now() + 120_000).toISOString(),
  });
  storage.setItem(STORAGE_KEY, JSON.stringify([localOnly, localNewerConflict]));

  // First simulate total cloud outage -> migration must fail safely and KEEP localStorage intact!
  backend.permanentFailureMessage = 'Database unreachable';
  const failedReport = await migrateLocalProjectsToSupabase(userId, opts);
  assert.equal(failedReport.cleanedLegacyLocalStorage, false);
  assert.ok(storage.getItem(STORAGE_KEY), 'Legacy localStorage MUST NOT be removed when migration fails');

  // Restore connectivity -> migration succeeds, verifies read-back, preserves cloud original, cleans legacy key!
  backend.permanentFailureMessage = null;
  const okReport = await migrateLocalProjectsToSupabase(userId, opts);
  assert.equal(okReport.failedCount, 0);
  assert.equal(okReport.migratedCount, 2);
  assert.equal(okReport.cleanedLegacyLocalStorage, true);
  assert.equal(storage.getItem(STORAGE_KEY), null);

  const cloudAfter = await listCloudProjects(userId, { includeDeleted: true }, opts);
  assert.equal(cloudAfter.activeProjects.length, 3);
  assert.ok(cloudAfter.activeProjects.some((p) => p.name === 'Legacy Local Bungalow'));
  assert.ok(cloudAfter.activeProjects.some((p) => p.name === 'Cloud Original'));
  assert.ok(cloudAfter.activeProjects.some((p) => p.name === 'Cloud Original (Migrated Local Copy)'));
});

// ============================================================================
// 5. OFFLINE QUEUE, EXPONENTIAL BACKOFF RETRY & RECONNECT SYNC
// ============================================================================
test('Offline edits queue safely and sync automatically when online, with transient failure retries', async () => {
  const backend = new InMemorySupabaseBackend();
  const userId = 'user-offline';
  const client = backend.createClientFor(userId);
  const storage = new MemoryStorage();
  let online = false;

  const opts = {
    client,
    storage,
    isOnline: () => online,
    retryBaseDelayMs: 0,
    maxRetries: 3,
  };

  // Edit while offline -> enqueued in durable pending queue
  const offlineProj = makeSampleProject({ id: 'proj-off-1', name: 'Offline Cabin' });
  const offRes = await upsertCloudProject(userId, offlineProj, {}, opts);
  assert.equal(offRes.ok, false);
  assert.equal(offRes.queuedOffline, true);
  assert.equal(loadPendingSyncQueue(userId, opts).length, 1);

  // Come back online with 2 transient 503 failures -> retry mechanism succeeds on 3rd attempt!
  online = true;
  backend.failNextWrites = 2;
  const flushRes = await flushPendingSyncQueue(userId, opts);
  assert.equal(flushRes.succeeded, 1);
  assert.equal(flushRes.remaining, 0);
  assert.equal(loadPendingSyncQueue(userId, opts).length, 0);

  const listed = await listCloudProjects(userId, {}, opts);
  assert.equal(listed.activeProjects.length, 1);
  assert.equal(listed.activeProjects[0].name, 'Offline Cabin');
});

// ============================================================================
// 6. OPTIMISTIC CONCURRENCY CONFLICT PROTECTION & RESOLUTION
// ============================================================================
test('Optimistic concurrency detects cross-device conflicts and resolves safely via keep-both, use-cloud, or keep-local', async () => {
  const backend = new InMemorySupabaseBackend();
  const userId = 'user-conflict';
  const client = backend.createClientFor(userId);
  const storage = new MemoryStorage();
  const opts = { client, storage, retryBaseDelayMs: 0 };

  const initial = await upsertCloudProject(
    userId,
    makeSampleProject({ id: 'proj-sync', name: 'Studio Plan' }),
    {},
    opts
  );
  const v1Proj = initial.project!;

  // Device B updates to v2
  const devBRes = await upsertCloudProject(
    userId,
    { ...v1Proj, description: 'Device B updated wiring' },
    { expectedVersion: 1 },
    opts
  );
  assert.equal(devBRes.ok, true);
  assert.equal(devBRes.project?.cloudVersion, 2);

  // Device A tries to save stale base v1 -> conflict detected, cloud NOT overwritten!
  const devAConflict = await upsertCloudProject(
    userId,
    { ...v1Proj, description: 'Device A offline rooms' },
    { expectedVersion: 1, queueOnOffline: false },
    opts
  );
  assert.equal(devAConflict.ok, false);
  assert.ok(devAConflict.conflict);
  assert.equal(devAConflict.conflict?.localVersion, 1);
  assert.equal(devAConflict.conflict?.remoteVersion, 2);

  // Resolve with keep-both -> preserves cloud v2 AND saves Device A edits as conflict copy
  const resolvedBoth = await resolveProjectConflict(userId, devAConflict.conflict!, 'keep-both', opts);
  assert.equal(resolvedBoth.ok, true);
  assert.equal(resolvedBoth.resolvedProjects.length, 2);

  const afterBoth = await listCloudProjects(userId, {}, opts);
  assert.equal(afterBoth.activeProjects.length, 2);
  assert.ok(afterBoth.activeProjects.some((p) => p.name === 'Studio Plan (Conflict Copy)'));
  assert.ok(afterBoth.activeProjects.some((p) => p.description === 'Device B updated wiring'));

  // Resolve with keep-local -> explicitly overwrites cloud with incremented version v3
  const resolvedLocal = await resolveProjectConflict(userId, devAConflict.conflict!, 'keep-local', opts);
  assert.equal(resolvedLocal.ok, true);
  assert.equal(resolvedLocal.resolvedProjects[0].cloudVersion, 3);
  assert.equal(resolvedLocal.resolvedProjects[0].description, 'Device A offline rooms');
});

// ============================================================================
// 7. CROSS-DEVICE REALTIME SYNCHRONIZATION
// ============================================================================
test('Cross-device realtime sync delivers updates and soft-deletes from Device A to Device B', async () => {
  const backend = new InMemorySupabaseBackend();
  const userId = 'user-cross-device';
  const deviceAClient = backend.createClientFor(userId);
  const deviceBClient = backend.createClientFor(userId);
  const storageA = new MemoryStorage();
  const storageB = new MemoryStorage();

  const receivedUpserts: ProjectData[] = [];
  const receivedSoftDeletes: ProjectData[] = [];

  const unsubscribe = subscribeToUserProjectsRealtime(
    userId,
    {
      onUpsert: (proj) => receivedUpserts.push(proj),
      onSoftDelete: (proj) => receivedSoftDeletes.push(proj),
      onHardDelete: () => {},
    },
    { client: deviceBClient, storage: storageB }
  );

  const created = await upsertCloudProject(
    userId,
    makeSampleProject({ id: 'proj-rt-1', name: 'Cross-Device Duplex' }),
    {},
    { client: deviceAClient, storage: storageA, retryBaseDelayMs: 0 }
  );
  assert.equal(receivedUpserts.length, 1);
  assert.equal(receivedUpserts[0].name, 'Cross-Device Duplex');

  await softDeleteCloudProject(userId, created.project!, {
    client: deviceAClient,
    storage: storageA,
    retryBaseDelayMs: 0,
  });
  assert.equal(receivedSoftDeletes.length, 1);
  assert.ok(receivedSoftDeletes[0].deletedAt);

  unsubscribe();
});

// ============================================================================
// 8. SUPABASE STORAGE ATTACHMENTS & SECURITY VALIDATION
// ============================================================================
test('Supabase Storage attachments validate file safety, upload, create signed URLs, and delete cleanly', async () => {
  assert.equal(sanitizeAttachmentFilename('../../etc/passwd'), 'passwd');
  assert.equal(validateProjectStoragePath('../secret/file.pdf'), false);
  assert.equal(validateProjectStoragePath('user-1/proj-1/att-1-plan.pdf', 'user-1'), true);
  assert.equal(validateProjectStoragePath('user-2/proj-1/att-1-plan.pdf', 'user-1'), false);

  const oversize = validateAttachmentInput('huge.pdf', 'application/pdf', MAX_ATTACHMENT_SIZE_BYTES + 1);
  assert.equal(oversize.valid, false);
  const badExt = validateAttachmentInput('script.exe', 'application/x-msdownload', 1024);
  assert.equal(badExt.valid, false);

  const backend = new InMemorySupabaseBackend();
  const userId = 'user-files';
  const client = backend.createClientFor(userId);
  const storage = new MemoryStorage();
  const opts = { client, storage, retryBaseDelayMs: 0 };

  const created = await upsertCloudProject(userId, makeSampleProject({ name: 'PDF Attached Villa' }), {}, opts);
  const cloudId = created.project!.cloudId!;

  const pdfBlob = new Blob(['%PDF-1.4 fake architectural floorplan'], { type: 'application/pdf' });
  const upRes = await uploadProjectAttachment(
    userId,
    cloudId,
    pdfBlob,
    { fileName: 'FloorPlan_Ground.pdf', mimeType: 'application/pdf', kind: 'pdf' },
    opts
  );
  assert.equal(upRes.ok, true);
  assert.ok(upRes.attachment?.storagePath.startsWith(`${userId}/${cloudId}/`));

  const listRes = await listProjectAttachments(cloudId, opts);
  assert.equal(listRes.ok, true);
  assert.equal(listRes.attachments.length, 1);

  const signedRes = await getAttachmentSignedUrl(upRes.attachment!.storagePath, 300, opts);
  assert.equal(signedRes.ok, true);
  assert.match(signedRes.signedUrl!, /project-assets/);

  const delRes = await deleteProjectAttachment(upRes.attachment!, opts);
  assert.equal(delRes.ok, true);
  const listAfterDel = await listProjectAttachments(cloudId, opts);
  assert.equal(listAfterDel.attachments.length, 0);
});
