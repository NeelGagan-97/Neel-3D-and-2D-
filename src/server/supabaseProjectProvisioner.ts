import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { Client as PgClient } from 'pg';

export const PROJECT_ASSETS_BUCKET = 'project-assets';
export const REQUIRED_PROJECT_TABLES = [
  'user_projects',
  'project_versions',
  'project_attachments',
] as const;

export const ALLOWED_PROJECT_ASSET_MIME_TYPES = [
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
] as const;

export interface CloudProvisioningStatus {
  configured: boolean;
  provisioned: boolean;
  browserSupabaseConfigured: boolean;
  serverSupabaseConfigured: boolean;
  ddlAutomationMethod: 'postgres-direct' | 'supabase-management-api' | 'none';
  tablesReady: Record<(typeof REQUIRED_PROJECT_TABLES)[number], boolean>;
  storageBucketReady: boolean;
  missingEnvVars: string[];
  lastCheckedAt: string;
  lastAttemptedProvisionAt: string | null;
  message: string;
  error?: string | null;
}

const MIGRATION_PATH = path.resolve(
  process.cwd(),
  'supabase',
  'migrations',
  '005_cloud_project_storage.sql'
);

let cachedStatus: CloudProvisioningStatus | null = null;
let inFlightProvision: Promise<CloudProvisioningStatus> | null = null;

function readEnv(key: string): string {
  return String(process.env[key] || '').trim();
}

export function extractSupabaseProjectRef(supabaseUrl: string): string | null {
  try {
    const parsed = new URL(supabaseUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const host = parsed.hostname.toLowerCase();
    const match = host.match(/^([a-z0-9-]{6,40})\.supabase\.(co|in|net)$/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function getCloudProjectEnvDiagnostics(): {
  supabaseUrl: string;
  serviceRoleKey: string;
  dbUrl: string;
  accessToken: string;
  browserSupabaseConfigured: boolean;
  serverSupabaseConfigured: boolean;
  ddlAutomationMethod: 'postgres-direct' | 'supabase-management-api' | 'none';
  missingEnvVars: string[];
} {
  const viteUrl = readEnv('VITE_SUPABASE_URL');
  const viteAnon = readEnv('VITE_SUPABASE_ANON_KEY') || readEnv('VITE_SUPABASE_PUBLISHABLE_KEY');
  const supabaseUrl = readEnv('SUPABASE_URL') || viteUrl;
  const serviceRoleKey = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  const dbUrl = readEnv('SUPABASE_DB_URL') || readEnv('DATABASE_URL');
  const accessToken = readEnv('SUPABASE_ACCESS_TOKEN');

  const browserSupabaseConfigured = Boolean(viteUrl && viteAnon);
  const serverSupabaseConfigured = Boolean(supabaseUrl && serviceRoleKey);
  const ddlAutomationMethod: 'postgres-direct' | 'supabase-management-api' | 'none' = dbUrl
    ? 'postgres-direct'
    : accessToken && extractSupabaseProjectRef(supabaseUrl)
      ? 'supabase-management-api'
      : 'none';

  const missingEnvVars: string[] = [];
  if (!viteUrl) missingEnvVars.push('VITE_SUPABASE_URL');
  if (!viteAnon) missingEnvVars.push('VITE_SUPABASE_ANON_KEY');
  if (!supabaseUrl) missingEnvVars.push('SUPABASE_URL');
  if (!serviceRoleKey) missingEnvVars.push('SUPABASE_SERVICE_ROLE_KEY');
  if (ddlAutomationMethod === 'none') {
    missingEnvVars.push('SUPABASE_DB_URL (or SUPABASE_ACCESS_TOKEN)');
  }

  return {
    supabaseUrl,
    serviceRoleKey,
    dbUrl,
    accessToken,
    browserSupabaseConfigured,
    serverSupabaseConfigured,
    ddlAutomationMethod,
    missingEnvVars: Array.from(new Set(missingEnvVars)),
  };
}

export async function readCloudProjectMigrationSql(): Promise<string> {
  return fs.readFile(MIGRATION_PATH, 'utf8');
}

async function executeSqlViaPostgres(dbUrl: string, sql: string): Promise<void> {
  const isLocalHost = /localhost|127\.0\.0\.1/i.test(dbUrl);
  const client = new PgClient({
    connectionString: dbUrl,
    ssl: isLocalHost ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end().catch(() => {});
  }
}

async function executeSqlViaManagementApi(
  supabaseUrl: string,
  accessToken: string,
  sql: string
): Promise<void> {
  const projectRef = extractSupabaseProjectRef(supabaseUrl);
  if (!projectRef) {
    throw new Error('Could not extract Supabase project reference from SUPABASE_URL.');
  }
  const endpoint = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query`;
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    throw new Error(
      `Supabase Management API query failed (${resp.status}): ${bodyText.slice(0, 240) || resp.statusText}`
    );
  }
}

async function inspectLiveSupabaseObjects(
  supabaseUrl: string,
  serviceRoleKey: string
): Promise<{
  tablesReady: Record<(typeof REQUIRED_PROJECT_TABLES)[number], boolean>;
  storageBucketReady: boolean;
}> {
  const sb = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const tablesReady: Record<(typeof REQUIRED_PROJECT_TABLES)[number], boolean> = {
    user_projects: false,
    project_versions: false,
    project_attachments: false,
  };

  for (const table of REQUIRED_PROJECT_TABLES) {
    // Use GET (not HEAD) so PostgREST returns full PGRST205 JSON error when table does not exist
    const { error } = await sb.from(table).select('id').limit(1);
    tablesReady[table] = !error;
  }

  let storageBucketReady = false;
  const { data: buckets, error: bucketErr } = await sb.storage.listBuckets();
  if (!bucketErr && Array.isArray(buckets)) {
    storageBucketReady = buckets.some((b) => b.id === PROJECT_ASSETS_BUCKET || b.name === PROJECT_ASSETS_BUCKET);
  }

  return { tablesReady, storageBucketReady };
}

async function ensureProjectAssetsBucket(
  supabaseUrl: string,
  serviceRoleKey: string
): Promise<boolean> {
  const sb = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: buckets, error: listErr } = await sb.storage.listBuckets();
  if (listErr) {
    throw new Error(`Unable to list Supabase Storage buckets: ${listErr.message}`);
  }
  const exists = Array.isArray(buckets)
    ? buckets.some((b) => b.id === PROJECT_ASSETS_BUCKET || b.name === PROJECT_ASSETS_BUCKET)
    : false;

  const bucketOptions = {
    public: false,
    fileSizeLimit: 52428800,
    allowedMimeTypes: [...ALLOWED_PROJECT_ASSET_MIME_TYPES],
  };

  if (!exists) {
    const { error: createErr } = await sb.storage.createBucket(PROJECT_ASSETS_BUCKET, bucketOptions);
    if (createErr && !/already exists/i.test(createErr.message)) {
      throw new Error(`Unable to create storage bucket "${PROJECT_ASSETS_BUCKET}": ${createErr.message}`);
    }
  } else {
    await sb.storage.updateBucket(PROJECT_ASSETS_BUCKET, bucketOptions).catch(() => {});
  }

  return true;
}

export async function getCloudProjectStorageStatus(): Promise<CloudProvisioningStatus> {
  const diag = getCloudProjectEnvDiagnostics();
  const now = new Date().toISOString();

  if (!diag.serverSupabaseConfigured) {
    cachedStatus = {
      configured: false,
      provisioned: false,
      browserSupabaseConfigured: diag.browserSupabaseConfigured,
      serverSupabaseConfigured: false,
      ddlAutomationMethod: diag.ddlAutomationMethod,
      tablesReady: {
        user_projects: false,
        project_versions: false,
        project_attachments: false,
      },
      storageBucketReady: false,
      missingEnvVars: diag.missingEnvVars,
      lastCheckedAt: now,
      lastAttemptedProvisionAt: cachedStatus?.lastAttemptedProvisionAt ?? null,
      message:
        'Supabase cloud project storage credentials are not yet configured in the runtime environment. Running with offline localStorage cache until credentials are supplied.',
      error: null,
    };
    return cachedStatus;
  }

  try {
    const live = await inspectLiveSupabaseObjects(diag.supabaseUrl, diag.serviceRoleKey);
    const allTablesReady = REQUIRED_PROJECT_TABLES.every((t) => live.tablesReady[t]);
    const provisioned = allTablesReady && live.storageBucketReady;

    cachedStatus = {
      configured: true,
      provisioned,
      browserSupabaseConfigured: diag.browserSupabaseConfigured,
      serverSupabaseConfigured: true,
      ddlAutomationMethod: diag.ddlAutomationMethod,
      tablesReady: live.tablesReady,
      storageBucketReady: live.storageBucketReady,
      missingEnvVars: provisioned ? [] : diag.missingEnvVars,
      lastCheckedAt: now,
      lastAttemptedProvisionAt: cachedStatus?.lastAttemptedProvisionAt ?? null,
      message: provisioned
        ? 'Supabase cloud project storage (tables, RLS, and private Storage bucket) is active and verified.'
        : 'Supabase is connected, but cloud project storage tables or bucket have not been provisioned yet.',
      error: null,
    };
    return cachedStatus;
  } catch (err) {
    const safeError = err instanceof Error ? err.message : 'Unable to reach Supabase.';
    cachedStatus = {
      configured: true,
      provisioned: false,
      browserSupabaseConfigured: diag.browserSupabaseConfigured,
      serverSupabaseConfigured: true,
      ddlAutomationMethod: diag.ddlAutomationMethod,
      tablesReady: {
        user_projects: false,
        project_versions: false,
        project_attachments: false,
      },
      storageBucketReady: false,
      missingEnvVars: diag.missingEnvVars,
      lastCheckedAt: now,
      lastAttemptedProvisionAt: cachedStatus?.lastAttemptedProvisionAt ?? null,
      message: 'Failed to inspect live Supabase project storage status.',
      error: safeError,
    };
    return cachedStatus;
  }
}

export async function ensureCloudProjectStorageProvisioned(): Promise<CloudProvisioningStatus> {
  if (inFlightProvision) return inFlightProvision;

  inFlightProvision = (async () => {
    const diag = getCloudProjectEnvDiagnostics();
    const now = new Date().toISOString();

    if (!diag.serverSupabaseConfigured) {
      const status: CloudProvisioningStatus = {
        configured: false,
        provisioned: false,
        browserSupabaseConfigured: diag.browserSupabaseConfigured,
        serverSupabaseConfigured: false,
        ddlAutomationMethod: diag.ddlAutomationMethod,
        tablesReady: {
          user_projects: false,
          project_versions: false,
          project_attachments: false,
        },
        storageBucketReady: false,
        missingEnvVars: diag.missingEnvVars,
        lastCheckedAt: now,
        lastAttemptedProvisionAt: now,
        message:
          'Automatic provisioning cannot run yet because Supabase environment variables are missing.',
        error: null,
      };
      cachedStatus = status;
      return status;
    }

    try {
      // 1. Check if already fully provisioned (avoid redundant DDL)
      const precheck = await inspectLiveSupabaseObjects(diag.supabaseUrl, diag.serviceRoleKey);
      const allTablesAlreadyReady = REQUIRED_PROJECT_TABLES.every((t) => precheck.tablesReady[t]);

      // 2. Always ensure private storage bucket exists via Service Role API
      if (!precheck.storageBucketReady) {
        await ensureProjectAssetsBucket(diag.supabaseUrl, diag.serviceRoleKey);
      }

      // 3. Execute additive DDL migration automatically if any table is missing
      if (!allTablesAlreadyReady) {
        if (diag.ddlAutomationMethod === 'postgres-direct' && diag.dbUrl) {
          const sql = await readCloudProjectMigrationSql();
          await executeSqlViaPostgres(diag.dbUrl, sql);
        } else if (diag.ddlAutomationMethod === 'supabase-management-api' && diag.accessToken) {
          const sql = await readCloudProjectMigrationSql();
          await executeSqlViaManagementApi(diag.supabaseUrl, diag.accessToken, sql);
        } else {
          const postBucket = await inspectLiveSupabaseObjects(diag.supabaseUrl, diag.serviceRoleKey);
          const status: CloudProvisioningStatus = {
            configured: true,
            provisioned: false,
            browserSupabaseConfigured: diag.browserSupabaseConfigured,
            serverSupabaseConfigured: true,
            ddlAutomationMethod: 'none',
            tablesReady: postBucket.tablesReady,
            storageBucketReady: postBucket.storageBucketReady,
            missingEnvVars: ['SUPABASE_DB_URL (or SUPABASE_ACCESS_TOKEN)'],
            lastCheckedAt: new Date().toISOString(),
            lastAttemptedProvisionAt: now,
            message:
              'Storage bucket is ready, but automatic PostgreSQL table/RLS provisioning requires either SUPABASE_DB_URL or SUPABASE_ACCESS_TOKEN on the server.',
            error: null,
          };
          cachedStatus = status;
          return status;
        }
      }

      // 4. Verify final live state after provisioning
      const verified = await inspectLiveSupabaseObjects(diag.supabaseUrl, diag.serviceRoleKey);
      const provisioned =
        REQUIRED_PROJECT_TABLES.every((t) => verified.tablesReady[t]) && verified.storageBucketReady;

      const status: CloudProvisioningStatus = {
        configured: true,
        provisioned,
        browserSupabaseConfigured: diag.browserSupabaseConfigured,
        serverSupabaseConfigured: true,
        ddlAutomationMethod: diag.ddlAutomationMethod,
        tablesReady: verified.tablesReady,
        storageBucketReady: verified.storageBucketReady,
        missingEnvVars: provisioned ? [] : diag.missingEnvVars,
        lastCheckedAt: new Date().toISOString(),
        lastAttemptedProvisionAt: now,
        message: provisioned
          ? 'Automatic Supabase cloud project storage provisioning succeeded and was verified.'
          : 'Provisioning ran, but one or more tables or storage buckets could not be verified.',
        error: provisioned ? null : 'Verification check did not pass for all required resources.',
      };
      cachedStatus = status;
      return status;
    } catch (err) {
      const safeError = err instanceof Error ? err.message : 'Automatic provisioning failed.';
      const status: CloudProvisioningStatus = {
        configured: true,
        provisioned: false,
        browserSupabaseConfigured: diag.browserSupabaseConfigured,
        serverSupabaseConfigured: true,
        ddlAutomationMethod: diag.ddlAutomationMethod,
        tablesReady: {
          user_projects: false,
          project_versions: false,
          project_attachments: false,
        },
        storageBucketReady: false,
        missingEnvVars: diag.missingEnvVars,
        lastCheckedAt: new Date().toISOString(),
        lastAttemptedProvisionAt: now,
        message: 'Automatic Supabase cloud project storage provisioning encountered an error.',
        error: safeError,
      };
      cachedStatus = status;
      return status;
    }
  })().finally(() => {
    inFlightProvision = null;
  });

  return inFlightProvision;
}
