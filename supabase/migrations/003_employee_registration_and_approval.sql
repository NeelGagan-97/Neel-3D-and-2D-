-- ============================================================================
-- NEEL 3D SPACE — EMPLOYEE REGISTRATION, PROFILE RECOVERY & ADMIN APPROVAL
-- Migration 003 (NON-DESTRUCTIVE, IDEMPOTENT — REVIEW BEFORE RUNNING)
-- ============================================================================
-- Guarantees:
--   1. PRESERVES SUPER ADMIN & ALL EXISTING PROFILES: Does NOT drop tables,
--      truncate data, or alter any existing row in public.employee_profiles.
--      Super Admin neelgaganat97@gmail.com (94fd4f13-09e4-4fa4-a83f-4900649b1ffc,
--      role = 'ADMIN', account_status = 'APPROVED') is never modified.
--   2. RELIABLE DATABASE-SIDE REGISTRATION: Automatically creates exactly one
--      EMPLOYEE + PENDING row in public.employee_profiles when a user signs up
--      in auth.users (even when email confirmation is enabled and no session
--      exists yet) AND on email confirmation if missed earlier.
--   3. ZERO DUPLICATE PROFILES: Enforces a unique index on auth_user_id and
--      uses ON CONFLICT (auth_user_id) DO NOTHING on retry.
--   4. SAFE RECOVERY FOR FAILED REGISTRATIONS (e.g. neelgagan.singh.br@gmail.com):
--      - Step 0 provides read-only diagnostic SQL to inspect the Auth user and
--        check whether a matching employee_profiles row exists.
--      - Step 5 installs authenticated RPC ensure_own_employee_profile(...)
--        which verifies auth.uid() and creates strictly EMPLOYEE + PENDING.
--      - Step 6 performs a non-destructive backfill ONLY for auth.users rows
--        that currently have no matching employee_profiles row.
--   5. EMAIL CONFIRMATION STATUS IN ADMIN DASHBOARD:
--      admin_list_employee_profiles() and admin_get_employee_profile(uuid)
--      securely join auth.users.email_confirmed_at for approved Admins only.
--   6. STRICT LEAST PRIVILEGE & NON-RECURSIVE RLS:
--      Preserves the single non-recursive SELECT policy (auth.uid() = auth_user_id).
--      Revokes direct INSERT/UPDATE/DELETE from anon and authenticated roles.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- STEP 0 (READ-ONLY DIAGNOSTIC — Run separately BEFORE migration to inspect
-- your Super Admin account and diagnose neelgagan.singh.br@gmail.com)
-- ----------------------------------------------------------------------------
-- -- A) Inspect Super Admin & existing failed registration in auth.users vs employee_profiles:
-- SELECT
--   u.id AS auth_uid,
--   u.email AS auth_email,
--   u.email_confirmed_at,
--   u.created_at AS auth_created_at,
--   u.raw_user_meta_data,
--   ep.id AS profile_id,
--   ep.auth_user_id AS profile_auth_user_id,
--   (ep.auth_user_id = u.id) AS auth_uid_matches,
--   ep.full_name,
--   ep.employee_id,
--   ep.username,
--   ep.mobile,
--   ep.role,
--   ep.account_status
-- FROM auth.users u
-- LEFT JOIN public.employee_profiles ep
--   ON ep.auth_user_id = u.id OR lower(ep.email) = lower(u.email)
-- WHERE lower(u.email) IN ('neelgaganat97@gmail.com', 'neelgagan.singh.br@gmail.com')
-- ORDER BY u.created_at ASC;
--
-- -- B) Inspect active triggers on auth.users and public.employee_profiles:
-- SELECT tgname, tgrelid::regclass AS table_name, proname AS function_name
-- FROM pg_trigger t
-- JOIN pg_proc p ON p.oid = t.tgfoid
-- WHERE NOT t.tgisinternal
--   AND tgrelid IN ('auth.users'::regclass, 'public.employee_profiles'::regclass);
--
-- -- C) Inspect existing RLS policies and grants on public.employee_profiles:
-- SELECT policyname, cmd, roles, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public' AND tablename = 'employee_profiles';

BEGIN;

-- ----------------------------------------------------------------------------
-- STEP 1: Enforce safe column defaults & prevent duplicate auth_user_id rows
-- ----------------------------------------------------------------------------
ALTER TABLE public.employee_profiles
  ALTER COLUMN role SET DEFAULT 'EMPLOYEE',
  ALTER COLUMN account_status SET DEFAULT 'PENDING';

CREATE UNIQUE INDEX IF NOT EXISTS employee_profiles_auth_user_id_unique_idx
  ON public.employee_profiles (auth_user_id);

-- ----------------------------------------------------------------------------
-- STEP 2: Non-recursive SECURITY DEFINER admin verification helper
-- Grants TRUE ONLY when auth.uid() matches an employee_profiles row with
-- BOTH role = 'ADMIN' AND account_status = 'APPROVED'.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_approved_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.employee_profiles ep
    WHERE ep.auth_user_id = auth.uid()
      AND ep.role = 'ADMIN'
      AND ep.account_status = 'APPROVED'
  );
$$;

REVOKE ALL ON FUNCTION public.is_approved_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_approved_admin() TO authenticated;

-- ----------------------------------------------------------------------------
-- STEP 3: Database mutation guard trigger (defense in depth)
-- Blocks employee role escalation, self-approval, identity tampering,
-- creating additional ADMIN accounts via app updates, and admin self-lockout.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_employee_profile_mutations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_is_admin boolean := false;
BEGIN
  IF v_caller_uid IS NOT NULL THEN
    v_is_admin := public.is_approved_admin();
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.email := lower(trim(coalesce(NEW.email, '')));
    NEW.username := lower(trim(coalesce(NEW.username, '')));
    NEW.employee_id := upper(trim(coalesce(NEW.employee_id, '')));
    NEW.full_name := trim(coalesce(NEW.full_name, ''));
    NEW.mobile := trim(coalesce(NEW.mobile, ''));

    -- Any authenticated non-admin insert MUST strictly be own EMPLOYEE + PENDING row
    IF v_caller_uid IS NOT NULL AND NOT v_is_admin THEN
      IF NEW.auth_user_id IS DISTINCT FROM v_caller_uid THEN
        RAISE EXCEPTION 'Cannot create an employee profile for another user.'
          USING ERRCODE = '42501';
      END IF;
      IF NEW.role IS DISTINCT FROM 'EMPLOYEE' THEN
        RAISE EXCEPTION 'Self-registration must use EMPLOYEE role.'
          USING ERRCODE = '42501';
      END IF;
      IF NEW.account_status IS DISTINCT FROM 'PENDING' THEN
        RAISE EXCEPTION 'Self-registration must start with PENDING status.'
          USING ERRCODE = '42501';
      END IF;
      IF NEW.approved_at IS NOT NULL OR NEW.approved_by IS NOT NULL THEN
        RAISE EXCEPTION 'Self-registration cannot set approval metadata.'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id THEN
      RAISE EXCEPTION 'Profile identity linkage cannot be modified.'
        USING ERRCODE = '42501';
    END IF;

    IF v_caller_uid IS NOT NULL AND NOT v_is_admin THEN
      IF NEW.role IS DISTINCT FROM OLD.role
         OR NEW.account_status IS DISTINCT FROM OLD.account_status
         OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
         OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
         OR NEW.email IS DISTINCT FROM OLD.email
         OR NEW.username IS DISTINCT FROM OLD.username
         OR NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
        RAISE EXCEPTION 'Employees are not authorized to modify role, status, or account identifiers.'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    IF v_caller_uid IS NOT NULL AND v_is_admin THEN
      IF OLD.auth_user_id = v_caller_uid THEN
        IF NEW.role IS DISTINCT FROM OLD.role OR NEW.account_status IS DISTINCT FROM OLD.account_status THEN
          RAISE EXCEPTION 'Administrators cannot modify their own role or account status.'
            USING ERRCODE = '42501';
        END IF;
      END IF;

      IF OLD.role IS DISTINCT FROM 'ADMIN' AND NEW.role = 'ADMIN' THEN
        RAISE EXCEPTION 'Role elevation to ADMIN is prohibited through employee management.'
          USING ERRCODE = '42501';
      END IF;

      IF NEW.account_status = 'APPROVED' AND OLD.account_status IS DISTINCT FROM 'APPROVED' THEN
        NEW.approved_at := now();
        NEW.approved_by := v_caller_uid;
      END IF;
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_employee_profile_mutations ON public.employee_profiles;
CREATE TRIGGER trg_guard_employee_profile_mutations
  BEFORE INSERT OR UPDATE ON public.employee_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_employee_profile_mutations();

-- ----------------------------------------------------------------------------
-- STEP 4: Reliable auth.users registration & email confirmation trigger
-- Provisions exactly one EMPLOYEE + PENDING row when a new user registers
-- (works even when email confirmation is enabled and no session exists yet)
-- AND on email confirmation if no profile existed yet.
-- Always ignores any client-supplied role/status metadata and never modifies
-- existing employee_profiles rows (including Super Admin).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_employee_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email text;
  v_full_name text;
  v_employee_id text;
  v_username text;
  v_mobile text;
  v_uid_suffix text;
BEGIN
  -- Never overwrite or duplicate an existing profile (preserves Super Admin & existing employees)
  IF EXISTS (
    SELECT 1
    FROM public.employee_profiles ep
    WHERE ep.auth_user_id = NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  v_email := lower(trim(coalesce(NEW.email, '')));
  IF v_email = '' THEN
    RETURN NEW;
  END IF;

  v_uid_suffix := substr(replace(NEW.id::text, '-', ''), 1, 8);
  v_full_name := trim(coalesce(NEW.raw_user_meta_data->>'full_name', ''));
  v_employee_id := upper(trim(coalesce(NEW.raw_user_meta_data->>'employee_id', '')));
  v_username := lower(trim(coalesce(NEW.raw_user_meta_data->>'username', '')));
  v_mobile := trim(coalesce(NEW.raw_user_meta_data->>'mobile', ''));

  IF v_full_name = '' THEN
    v_full_name := split_part(v_email, '@', 1);
  END IF;
  IF v_employee_id = '' THEN
    v_employee_id := 'EMP-' || upper(v_uid_suffix);
  END IF;
  IF v_username = '' THEN
    v_username := 'emp_' || lower(v_uid_suffix);
  END IF;

  INSERT INTO public.employee_profiles (
    auth_user_id,
    full_name,
    employee_id,
    username,
    email,
    mobile,
    role,
    account_status,
    approved_at,
    approved_by
  )
  VALUES (
    NEW.id,
    v_full_name,
    v_employee_id,
    v_username,
    v_email,
    v_mobile,
    'EMPLOYEE',
    'PENDING',
    NULL,
    NULL
  )
  ON CONFLICT (auth_user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_employee_profile ON auth.users;
CREATE TRIGGER on_auth_user_created_employee_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_employee_auth_user();

DROP TRIGGER IF EXISTS on_auth_user_confirmed_employee_profile ON auth.users;
CREATE TRIGGER on_auth_user_confirmed_employee_profile
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  WHEN (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL)
  EXECUTE FUNCTION public.handle_new_employee_auth_user();

-- ----------------------------------------------------------------------------
-- STEP 5: Authenticated self-profile recovery RPC
-- Verifies auth.uid(), inspects existing auth.users record & metadata, and
-- creates strictly role = 'EMPLOYEE' + account_status = 'PENDING' (approved_at
-- and approved_by = NULL) only if no profile exists yet for auth.uid().
-- Accepts optional fallback registration fields if metadata was incomplete.
-- Never accepts role/status from the client and never modifies existing rows.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.ensure_own_employee_profile();
DROP FUNCTION IF EXISTS public.ensure_own_employee_profile(text, text, text, text);

CREATE OR REPLACE FUNCTION public.ensure_own_employee_profile(
  p_full_name text DEFAULT NULL,
  p_employee_id text DEFAULT NULL,
  p_username text DEFAULT NULL,
  p_mobile text DEFAULT NULL
)
RETURNS public.employee_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_existing public.employee_profiles;
  v_email text;
  v_meta jsonb;
  v_full_name text;
  v_employee_id text;
  v_username text;
  v_mobile text;
  v_uid_suffix text;
  v_custom_emp_id text;
  v_custom_username text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required.'
      USING ERRCODE = '42501';
  END IF;

  -- Existing profile (including Super Admin) is always returned untouched
  SELECT * INTO v_existing
  FROM public.employee_profiles
  WHERE auth_user_id = v_uid;

  IF FOUND THEN
    RETURN v_existing;
  END IF;

  SELECT u.email, coalesce(u.raw_user_meta_data, '{}'::jsonb)
  INTO v_email, v_meta
  FROM auth.users u
  WHERE u.id = v_uid;

  IF NOT FOUND OR coalesce(trim(v_email), '') = '' THEN
    RAISE EXCEPTION 'Authenticated user record not found.';
  END IF;

  v_email := lower(trim(v_email));
  v_uid_suffix := substr(replace(v_uid::text, '-', ''), 1, 8);

  -- Prevent duplicate email link to a different auth_user_id
  IF EXISTS (
    SELECT 1
    FROM public.employee_profiles ep
    WHERE lower(ep.email) = v_email
      AND ep.auth_user_id <> v_uid
  ) THEN
    RAISE EXCEPTION 'An employee profile with this email address is already linked to another account. Contact your administrator.'
      USING ERRCODE = '23505';
  END IF;

  v_full_name := coalesce(
    nullif(trim(coalesce(p_full_name, '')), ''),
    nullif(trim(coalesce(v_meta->>'full_name', '')), ''),
    split_part(v_email, '@', 1)
  );

  v_custom_emp_id := nullif(upper(trim(coalesce(p_employee_id, ''))), '');
  IF v_custom_emp_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.employee_profiles WHERE upper(employee_id) = v_custom_emp_id) THEN
      RAISE EXCEPTION 'employee_id is already registered.'
        USING ERRCODE = '23505';
    END IF;
    v_employee_id := v_custom_emp_id;
  ELSE
    v_employee_id := upper(trim(coalesce(v_meta->>'employee_id', '')));
    IF v_employee_id = '' OR EXISTS (SELECT 1 FROM public.employee_profiles WHERE upper(employee_id) = v_employee_id) THEN
      v_employee_id := 'EMP-' || upper(v_uid_suffix);
    END IF;
  END IF;

  v_custom_username := nullif(lower(trim(coalesce(p_username, ''))), '');
  IF v_custom_username IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.employee_profiles WHERE lower(username) = v_custom_username) THEN
      RAISE EXCEPTION 'username is already taken.'
        USING ERRCODE = '23505';
    END IF;
    v_username := v_custom_username;
  ELSE
    v_username := lower(trim(coalesce(v_meta->>'username', '')));
    IF v_username = '' OR EXISTS (SELECT 1 FROM public.employee_profiles WHERE lower(username) = v_username) THEN
      v_username := 'emp_' || lower(v_uid_suffix);
    END IF;
  END IF;

  v_mobile := coalesce(
    nullif(trim(coalesce(p_mobile, '')), ''),
    trim(coalesce(v_meta->>'mobile', ''))
  );

  INSERT INTO public.employee_profiles (
    auth_user_id,
    full_name,
    employee_id,
    username,
    email,
    mobile,
    role,
    account_status,
    approved_at,
    approved_by
  )
  VALUES (
    v_uid,
    v_full_name,
    v_employee_id,
    v_username,
    v_email,
    v_mobile,
    'EMPLOYEE',
    'PENDING',
    NULL,
    NULL
  )
  ON CONFLICT (auth_user_id) DO NOTHING;

  SELECT * INTO v_existing
  FROM public.employee_profiles
  WHERE auth_user_id = v_uid;

  RETURN v_existing;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_own_employee_profile(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_own_employee_profile(text, text, text, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- STEP 6: Safe, non-destructive backfill for previously unprofiled auth.users
-- Creates EMPLOYEE + PENDING rows ONLY for existing auth.users accounts (such
-- as neelgagan.singh.br@gmail.com) that have NO employee_profiles row yet.
-- Skips Super Admin (neelgaganat97@gmail.com) and every existing profile row.
-- Does NOT delete or recreate any auth.users account.
-- ----------------------------------------------------------------------------
INSERT INTO public.employee_profiles (
  auth_user_id,
  full_name,
  employee_id,
  username,
  email,
  mobile,
  role,
  account_status,
  approved_at,
  approved_by
)
SELECT
  u.id,
  coalesce(nullif(trim(u.raw_user_meta_data->>'full_name'), ''), split_part(lower(trim(u.email)), '@', 1)),
  CASE
    WHEN nullif(upper(trim(u.raw_user_meta_data->>'employee_id')), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.employee_profiles ep2
        WHERE upper(ep2.employee_id) = upper(trim(u.raw_user_meta_data->>'employee_id'))
      )
    THEN upper(trim(u.raw_user_meta_data->>'employee_id'))
    ELSE 'EMP-' || upper(substr(replace(u.id::text, '-', ''), 1, 8))
  END,
  CASE
    WHEN nullif(lower(trim(u.raw_user_meta_data->>'username')), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.employee_profiles ep3
        WHERE lower(ep3.username) = lower(trim(u.raw_user_meta_data->>'username'))
      )
    THEN lower(trim(u.raw_user_meta_data->>'username'))
    ELSE 'emp_' || lower(substr(replace(u.id::text, '-', ''), 1, 8))
  END,
  lower(trim(u.email)),
  trim(coalesce(u.raw_user_meta_data->>'mobile', '')),
  'EMPLOYEE',
  'PENDING',
  NULL,
  NULL
FROM auth.users u
WHERE u.email IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.employee_profiles ep
    WHERE ep.auth_user_id = u.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.employee_profiles ep_email
    WHERE lower(ep_email.email) = lower(trim(u.email))
  )
ON CONFLICT (auth_user_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- STEP 7: Privileged Admin RPCs (include email_confirmed_at from auth.users)
-- Strictly enforce ADMIN + APPROVED inside PostgreSQL without recursive RLS.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_list_employee_profiles();

CREATE OR REPLACE FUNCTION public.admin_list_employee_profiles()
RETURNS TABLE (
  id uuid,
  auth_user_id uuid,
  full_name text,
  employee_id text,
  username text,
  email text,
  mobile text,
  role text,
  account_status text,
  approved_at timestamptz,
  approved_by uuid,
  created_at timestamptz,
  updated_at timestamptz,
  email_confirmed_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_approved_admin() THEN
    RAISE EXCEPTION 'Forbidden: Approved administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    ep.id,
    ep.auth_user_id,
    ep.full_name,
    ep.employee_id,
    ep.username,
    ep.email,
    ep.mobile,
    ep.role::text,
    ep.account_status::text,
    ep.approved_at,
    ep.approved_by,
    ep.created_at,
    ep.updated_at,
    u.email_confirmed_at
  FROM public.employee_profiles ep
  LEFT JOIN auth.users u ON u.id = ep.auth_user_id
  ORDER BY
    CASE WHEN ep.account_status = 'PENDING' THEN 0 ELSE 1 END,
    ep.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_employee_profiles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_employee_profiles() TO authenticated;

DROP FUNCTION IF EXISTS public.admin_get_employee_profile(uuid);

CREATE OR REPLACE FUNCTION public.admin_get_employee_profile(
  p_profile_id uuid
)
RETURNS TABLE (
  id uuid,
  auth_user_id uuid,
  full_name text,
  employee_id text,
  username text,
  email text,
  mobile text,
  role text,
  account_status text,
  approved_at timestamptz,
  approved_by uuid,
  created_at timestamptz,
  updated_at timestamptz,
  email_confirmed_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_approved_admin() THEN
    RAISE EXCEPTION 'Forbidden: Approved administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    ep.id,
    ep.auth_user_id,
    ep.full_name,
    ep.employee_id,
    ep.username,
    ep.email,
    ep.mobile,
    ep.role::text,
    ep.account_status::text,
    ep.approved_at,
    ep.approved_by,
    ep.created_at,
    ep.updated_at,
    u.email_confirmed_at
  FROM public.employee_profiles ep
  LEFT JOIN auth.users u ON u.id = ep.auth_user_id
  WHERE ep.id = p_profile_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee profile not found.';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_employee_profile(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_employee_profile(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_update_employee_status(
  p_profile_id uuid,
  p_new_status text
)
RETURNS public.employee_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_uid uuid := auth.uid();
  v_target public.employee_profiles;
  v_updated public.employee_profiles;
BEGIN
  IF v_admin_uid IS NULL OR NOT public.is_approved_admin() THEN
    RAISE EXCEPTION 'Forbidden: Approved administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  IF p_new_status NOT IN ('APPROVED', 'REJECTED', 'SUSPENDED') THEN
    RAISE EXCEPTION 'Invalid target account status: %', p_new_status;
  END IF;

  SELECT * INTO v_target
  FROM public.employee_profiles
  WHERE id = p_profile_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee profile not found.';
  END IF;

  IF v_target.auth_user_id = v_admin_uid THEN
    RAISE EXCEPTION 'Administrators cannot modify their own account status.'
      USING ERRCODE = '42501';
  END IF;

  IF v_target.role = 'ADMIN' THEN
    RAISE EXCEPTION 'Administrator accounts cannot be modified through employee management actions.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.employee_profiles
  SET
    account_status = p_new_status,
    approved_at = CASE WHEN p_new_status = 'APPROVED' THEN now() ELSE approved_at END,
    approved_by = CASE WHEN p_new_status = 'APPROVED' THEN v_admin_uid ELSE approved_by END,
    updated_at = now()
  WHERE id = p_profile_id
    AND role = 'EMPLOYEE'
  RETURNING * INTO v_updated;

  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_employee_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_employee_status(uuid, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- STEP 8: Strict Table Privileges & Non-Recursive Row Level Security (RLS)
-- Preserves the single non-recursive SELECT policy ("Users can view own profile").
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE public.employee_profiles FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.employee_profiles FROM authenticated;
GRANT SELECT ON TABLE public.employee_profiles TO authenticated;

ALTER TABLE public.employee_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_profiles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Employees can read own profile" ON public.employee_profiles;
DROP POLICY IF EXISTS "Admins can read all employee profiles" ON public.employee_profiles;
DROP POLICY IF EXISTS "Employees can insert own pending profile" ON public.employee_profiles;
DROP POLICY IF EXISTS "Admins can update employee profiles" ON public.employee_profiles;
DROP POLICY IF EXISTS "employee_profiles_select_own" ON public.employee_profiles;
DROP POLICY IF EXISTS "employee_profiles_select_admin" ON public.employee_profiles;
DROP POLICY IF EXISTS "employee_profiles_insert_own_pending" ON public.employee_profiles;
DROP POLICY IF EXISTS "employee_profiles_update_admin" ON public.employee_profiles;
DROP POLICY IF EXISTS "Users can view own profile" ON public.employee_profiles;

CREATE POLICY "Users can view own profile"
  ON public.employee_profiles
  FOR SELECT
  TO authenticated
  USING (auth.uid() = auth_user_id);

COMMIT;
