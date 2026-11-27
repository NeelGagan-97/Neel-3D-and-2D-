-- ============================================================================
-- BLUE SPACE — CENTRAL ELECTRICAL PRODUCT CATALOGUE & STORAGE MIGRATION (004)
-- ============================================================================
-- Additive, non-destructive, idempotent migration.
-- Preserves all existing tables (including public.employee_profiles), triggers,
-- RLS policies, and approved administrator accounts.
-- Reuses public.is_approved_admin() established in migrations 002 & 003.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Central Manufacturer Directory Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.catalogue_manufacturers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  website_url text,
  logo_storage_path text,
  logo_url text,
  primary_categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'admin-entry'
    CHECK (source IN ('official-directory', 'cauvery-import', 'admin-entry')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_catalogue_manufacturers_name
  ON public.catalogue_manufacturers (lower(name));

CREATE INDEX IF NOT EXISTS idx_catalogue_manufacturers_active
  ON public.catalogue_manufacturers (is_active);

-- ----------------------------------------------------------------------------
-- 2. Central Electrical Product Catalogue Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.catalogue_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL UNIQUE,
  source text NOT NULL DEFAULT 'admin-entry'
    CHECK (source IN ('admin-entry', 'csv-import', 'cauvery-import')),
  source_url text,
  source_category text,
  category text NOT NULL,
  subcategory text,
  manufacturer_id uuid REFERENCES public.catalogue_manufacturers(id) ON DELETE SET NULL,
  manufacturer text NOT NULL,
  brand text NOT NULL,
  product_name text NOT NULL,
  model_number text NOT NULL DEFAULT 'Not specified',
  sku text,
  specification text NOT NULL DEFAULT '',
  technical_specs jsonb NOT NULL DEFAULT '{}'::jsonb,
  variants jsonb NOT NULL DEFAULT '[]'::jsonb,
  rating text NOT NULL DEFAULT '',
  wattage_w numeric CHECK (wattage_w IS NULL OR wattage_w >= 0),
  cable_size_sq_mm numeric CHECK (cable_size_sq_mm IS NULL OR cable_size_sq_mm > 0),
  dimensions text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT 'Nos',
  mrp numeric CHECK (mrp IS NULL OR mrp >= 0),
  unit_price numeric CHECK (unit_price IS NULL OR unit_price >= 0),
  discount_percent numeric CHECK (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 100)),
  gst_percent numeric CHECK (gst_percent IS NULL OR (gst_percent >= 0 AND gst_percent <= 100)),
  gst_details jsonb,
  image_storage_path text,
  image_url text,
  gallery_images jsonb NOT NULL DEFAULT '[]'::jsonb,
  datasheet_url text,
  manufacturer_url text,
  mapped_item_type text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_catalogue_products_category
  ON public.catalogue_products (category, subcategory);

CREATE INDEX IF NOT EXISTS idx_catalogue_products_manufacturer
  ON public.catalogue_products (lower(manufacturer));

CREATE INDEX IF NOT EXISTS idx_catalogue_products_brand
  ON public.catalogue_products (lower(brand));

CREATE INDEX IF NOT EXISTS idx_catalogue_products_sku
  ON public.catalogue_products (sku);

CREATE INDEX IF NOT EXISTS idx_catalogue_products_active
  ON public.catalogue_products (is_active);

-- ----------------------------------------------------------------------------
-- 3. Resumable Catalogue Import Jobs Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.catalogue_import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_domain text NOT NULL DEFAULT 'www.cauverypowers.com',
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed')),
  current_page integer NOT NULL DEFAULT 0,
  total_pages integer NOT NULL DEFAULT 0,
  page_size integer NOT NULL DEFAULT 50,
  discovered_count integer NOT NULL DEFAULT 0,
  imported_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  skipped_duplicates_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  manufacturers_count integer NOT NULL DEFAULT 0,
  images_uploaded_count integer NOT NULL DEFAULT 0,
  images_failed_count integer NOT NULL DEFAULT 0,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_by uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_catalogue_import_jobs_status
  ON public.catalogue_import_jobs (status, updated_at DESC);

-- ----------------------------------------------------------------------------
-- 4. Updated-at Maintenance Trigger
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_catalogue_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_catalogue_manufacturers_updated_at ON public.catalogue_manufacturers;
CREATE TRIGGER trg_catalogue_manufacturers_updated_at
  BEFORE UPDATE ON public.catalogue_manufacturers
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_catalogue_updated_at();

DROP TRIGGER IF EXISTS trg_catalogue_products_updated_at ON public.catalogue_products;
CREATE TRIGGER trg_catalogue_products_updated_at
  BEFORE UPDATE ON public.catalogue_products
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_catalogue_updated_at();

DROP TRIGGER IF EXISTS trg_catalogue_import_jobs_updated_at ON public.catalogue_import_jobs;
CREATE TRIGGER trg_catalogue_import_jobs_updated_at
  BEFORE UPDATE ON public.catalogue_import_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_catalogue_updated_at();

-- ----------------------------------------------------------------------------
-- 5. Strict Row Level Security (RLS) & Least-Privilege Grants
--    - Approved authenticated employees can READ active catalogue products & manufacturers.
--    - Only approved ADMIN users (public.is_approved_admin()) can INSERT / UPDATE / DELETE.
--    - Import job logs are strictly ADMIN-only.
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE public.catalogue_manufacturers FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.catalogue_products FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.catalogue_import_jobs FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.catalogue_manufacturers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.catalogue_products TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.catalogue_import_jobs TO authenticated;

ALTER TABLE public.catalogue_manufacturers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalogue_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalogue_import_jobs ENABLE ROW LEVEL SECURITY;

-- Manufacturers policies
DROP POLICY IF EXISTS "catalogue_manufacturers_select_authenticated" ON public.catalogue_manufacturers;
CREATE POLICY "catalogue_manufacturers_select_authenticated"
  ON public.catalogue_manufacturers
  FOR SELECT
  TO authenticated
  USING (is_active = true OR public.is_approved_admin());

DROP POLICY IF EXISTS "catalogue_manufacturers_admin_insert" ON public.catalogue_manufacturers;
CREATE POLICY "catalogue_manufacturers_admin_insert"
  ON public.catalogue_manufacturers
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_approved_admin());

DROP POLICY IF EXISTS "catalogue_manufacturers_admin_update" ON public.catalogue_manufacturers;
CREATE POLICY "catalogue_manufacturers_admin_update"
  ON public.catalogue_manufacturers
  FOR UPDATE
  TO authenticated
  USING (public.is_approved_admin())
  WITH CHECK (public.is_approved_admin());

DROP POLICY IF EXISTS "catalogue_manufacturers_admin_delete" ON public.catalogue_manufacturers;
CREATE POLICY "catalogue_manufacturers_admin_delete"
  ON public.catalogue_manufacturers
  FOR DELETE
  TO authenticated
  USING (public.is_approved_admin());

-- Products policies
DROP POLICY IF EXISTS "catalogue_products_select_authenticated" ON public.catalogue_products;
CREATE POLICY "catalogue_products_select_authenticated"
  ON public.catalogue_products
  FOR SELECT
  TO authenticated
  USING (is_active = true OR public.is_approved_admin());

DROP POLICY IF EXISTS "catalogue_products_admin_insert" ON public.catalogue_products;
CREATE POLICY "catalogue_products_admin_insert"
  ON public.catalogue_products
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_approved_admin());

DROP POLICY IF EXISTS "catalogue_products_admin_update" ON public.catalogue_products;
CREATE POLICY "catalogue_products_admin_update"
  ON public.catalogue_products
  FOR UPDATE
  TO authenticated
  USING (public.is_approved_admin())
  WITH CHECK (public.is_approved_admin());

DROP POLICY IF EXISTS "catalogue_products_admin_delete" ON public.catalogue_products;
CREATE POLICY "catalogue_products_admin_delete"
  ON public.catalogue_products
  FOR DELETE
  TO authenticated
  USING (public.is_approved_admin());

-- Import jobs policies (Admin only)
DROP POLICY IF EXISTS "catalogue_import_jobs_admin_all" ON public.catalogue_import_jobs;
CREATE POLICY "catalogue_import_jobs_admin_all"
  ON public.catalogue_import_jobs
  FOR ALL
  TO authenticated
  USING (public.is_approved_admin())
  WITH CHECK (public.is_approved_admin());

-- ----------------------------------------------------------------------------
-- 6. Supabase Storage Bucket for Permanent Product Images (catalogue-images)
--    Zero dependency on external image hotlinks at runtime.
-- ----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'catalogue-images',
  'catalogue-images',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "catalogue_images_public_read" ON storage.objects;
CREATE POLICY "catalogue_images_public_read"
  ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'catalogue-images');

DROP POLICY IF EXISTS "catalogue_images_admin_insert" ON storage.objects;
CREATE POLICY "catalogue_images_admin_insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'catalogue-images' AND public.is_approved_admin());

DROP POLICY IF EXISTS "catalogue_images_admin_update" ON storage.objects;
CREATE POLICY "catalogue_images_admin_update"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (bucket_id = 'catalogue-images' AND public.is_approved_admin())
  WITH CHECK (bucket_id = 'catalogue-images' AND public.is_approved_admin());

DROP POLICY IF EXISTS "catalogue_images_admin_delete" ON storage.objects;
CREATE POLICY "catalogue_images_admin_delete"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'catalogue-images' AND public.is_approved_admin());

COMMIT;
