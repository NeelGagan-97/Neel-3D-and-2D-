-- ============================================================================
-- Blue Space Cloud Project Storage (Additive Migration 005)
-- Preserves all existing tables, auth, RBAC (`public.is_approved_admin()`),
-- and Central Electrical Catalogue tables (`004_central_electrical_catalogue.sql`).
--
-- Creates:
--   1. public.user_projects       (permanent source of truth for 2D/3D/Electrical/BOQ projects)
--   2. public.project_versions    (immutable version history snapshots per project)
--   3. public.project_attachments (metadata for project drawings, images, PDFs, backups in Storage)
--   4. storage.buckets            (private bucket 'project-assets' with owner + admin RLS)
--   5. Indexes, triggers, Row Level Security (RLS), and Supabase Realtime publication
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. Helper Trigger Functions
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bluespace_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.bluespace_guard_project_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    IF NOT public.is_approved_admin() THEN
      RAISE EXCEPTION 'Only an approved administrator may reassign project ownership.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. public.user_projects
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_project_id text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  ref_code text NOT NULL DEFAULT '',
  project_type text NOT NULL DEFAULT 'Residential',
  building_type text,
  status text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Saved', 'BOQ Ready')),
  description text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  project_data jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  content_hash text NOT NULL DEFAULT '',
  last_modified_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_projects_owner_client_id_key UNIQUE (owner_user_id, client_project_id)
);

CREATE INDEX IF NOT EXISTS idx_user_projects_owner_active_updated
  ON public.user_projects (owner_user_id, deleted_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_projects_owner_type
  ON public.user_projects (owner_user_id, project_type);

CREATE INDEX IF NOT EXISTS idx_user_projects_updated_at
  ON public.user_projects (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_projects_metadata_gin
  ON public.user_projects USING gin (metadata);

DROP TRIGGER IF EXISTS trg_user_projects_touch_updated_at ON public.user_projects;
CREATE TRIGGER trg_user_projects_touch_updated_at
  BEFORE UPDATE ON public.user_projects
  FOR EACH ROW
  EXECUTE FUNCTION public.bluespace_touch_updated_at();

DROP TRIGGER IF EXISTS trg_user_projects_guard_owner ON public.user_projects;
CREATE TRIGGER trg_user_projects_guard_owner
  BEFORE UPDATE ON public.user_projects
  FOR EACH ROW
  EXECUTE FUNCTION public.bluespace_guard_project_owner();

-- ----------------------------------------------------------------------------
-- 3. public.project_versions
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.user_projects(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  version_number integer NOT NULL CHECK (version_number >= 1),
  change_summary text NOT NULL DEFAULT 'Auto-save snapshot',
  project_data jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_versions_project_version_key UNIQUE (project_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_project_versions_project_desc
  ON public.project_versions (project_id, version_number DESC);

CREATE INDEX IF NOT EXISTS idx_project_versions_owner_created
  ON public.project_versions (owner_user_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 4. public.project_attachments
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.user_projects(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'attachment'
    CHECK (kind IN ('drawing', 'image', 'pdf', 'boq', 'dxf', 'backup', 'attachment')),
  file_name text NOT NULL CHECK (char_length(btrim(file_name)) BETWEEN 1 AND 255),
  mime_type text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 52428800),
  storage_bucket text NOT NULL DEFAULT 'project-assets',
  storage_path text NOT NULL UNIQUE,
  sha256 text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_attachments_project_active
  ON public.project_attachments (project_id, deleted_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_attachments_owner
  ON public.project_attachments (owner_user_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 5. Row Level Security (RLS) Policies
--    Every user accesses ONLY their own projects, versions, and attachments.
--    Approved administrators (`public.is_approved_admin()`) retain oversight access.
-- ----------------------------------------------------------------------------
ALTER TABLE public.user_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_attachments ENABLE ROW LEVEL SECURITY;

-- user_projects policies
DROP POLICY IF EXISTS "Users and admins can select user_projects" ON public.user_projects;
CREATE POLICY "Users and admins can select user_projects"
  ON public.user_projects
  FOR SELECT
  TO authenticated
  USING (owner_user_id = auth.uid() OR public.is_approved_admin());

DROP POLICY IF EXISTS "Users and admins can insert user_projects" ON public.user_projects;
CREATE POLICY "Users and admins can insert user_projects"
  ON public.user_projects
  FOR INSERT
  TO authenticated
  WITH CHECK (owner_user_id = auth.uid() OR public.is_approved_admin());

DROP POLICY IF EXISTS "Users and admins can update user_projects" ON public.user_projects;
CREATE POLICY "Users and admins can update user_projects"
  ON public.user_projects
  FOR UPDATE
  TO authenticated
  USING (owner_user_id = auth.uid() OR public.is_approved_admin())
  WITH CHECK (owner_user_id = auth.uid() OR public.is_approved_admin());

DROP POLICY IF EXISTS "Users and admins can delete user_projects" ON public.user_projects;
CREATE POLICY "Users and admins can delete user_projects"
  ON public.user_projects
  FOR DELETE
  TO authenticated
  USING (owner_user_id = auth.uid() OR public.is_approved_admin());

-- project_versions policies
DROP POLICY IF EXISTS "Users and admins can select project_versions" ON public.project_versions;
CREATE POLICY "Users and admins can select project_versions"
  ON public.project_versions
  FOR SELECT
  TO authenticated
  USING (owner_user_id = auth.uid() OR public.is_approved_admin());

DROP POLICY IF EXISTS "Users and admins can insert project_versions" ON public.project_versions;
CREATE POLICY "Users and admins can insert project_versions"
  ON public.project_versions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (owner_user_id = auth.uid() OR public.is_approved_admin())
    AND EXISTS (
      SELECT 1
      FROM public.user_projects p
      WHERE p.id = project_versions.project_id
        AND (p.owner_user_id = auth.uid() OR public.is_approved_admin())
    )
  );

DROP POLICY IF EXISTS "Users and admins can delete project_versions" ON public.project_versions;
CREATE POLICY "Users and admins can delete project_versions"
  ON public.project_versions
  FOR DELETE
  TO authenticated
  USING (owner_user_id = auth.uid() OR public.is_approved_admin());

-- project_attachments policies
DROP POLICY IF EXISTS "Users and admins can select project_attachments" ON public.project_attachments;
CREATE POLICY "Users and admins can select project_attachments"
  ON public.project_attachments
  FOR SELECT
  TO authenticated
  USING (owner_user_id = auth.uid() OR public.is_approved_admin());

DROP POLICY IF EXISTS "Users and admins can insert project_attachments" ON public.project_attachments;
CREATE POLICY "Users and admins can insert project_attachments"
  ON public.project_attachments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (owner_user_id = auth.uid() OR public.is_approved_admin())
    AND EXISTS (
      SELECT 1
      FROM public.user_projects p
      WHERE p.id = project_attachments.project_id
        AND (p.owner_user_id = auth.uid() OR public.is_approved_admin())
    )
  );

DROP POLICY IF EXISTS "Users and admins can update project_attachments" ON public.project_attachments;
CREATE POLICY "Users and admins can update project_attachments"
  ON public.project_attachments
  FOR UPDATE
  TO authenticated
  USING (owner_user_id = auth.uid() OR public.is_approved_admin())
  WITH CHECK (owner_user_id = auth.uid() OR public.is_approved_admin());

DROP POLICY IF EXISTS "Users and admins can delete project_attachments" ON public.project_attachments;
CREATE POLICY "Users and admins can delete project_attachments"
  ON public.project_attachments
  FOR DELETE
  TO authenticated
  USING (owner_user_id = auth.uid() OR public.is_approved_admin());

-- ----------------------------------------------------------------------------
-- 6. Supabase Storage Bucket: project-assets (private, 50 MB max per file)
--    Object path format: {owner_user_id}/{project_id}/{attachment_id}-{filename}
-- ----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'project-assets',
  'project-assets',
  false,
  52428800,
  ARRAY[
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
    'image/vnd.dxf'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Project assets select by owner or admin" ON storage.objects;
CREATE POLICY "Project assets select by owner or admin"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'project-assets'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.is_approved_admin()
    )
  );

DROP POLICY IF EXISTS "Project assets insert by owner or admin" ON storage.objects;
CREATE POLICY "Project assets insert by owner or admin"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'project-assets'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.is_approved_admin()
    )
  );

DROP POLICY IF EXISTS "Project assets update by owner or admin" ON storage.objects;
CREATE POLICY "Project assets update by owner or admin"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'project-assets'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.is_approved_admin()
    )
  )
  WITH CHECK (
    bucket_id = 'project-assets'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.is_approved_admin()
    )
  );

DROP POLICY IF EXISTS "Project assets delete by owner or admin" ON storage.objects;
CREATE POLICY "Project assets delete by owner or admin"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'project-assets'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.is_approved_admin()
    )
  );

-- ----------------------------------------------------------------------------
-- 7. Supabase Realtime Publication (for instant cross-device project sync)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.user_projects;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;
  END IF;
END
$$;
