-- ============================================================================
-- NEEL 3D SPACE — STRICT RBAC & PRIVILEGED ADMIN SECURITY MIGRATION (PROPOSED)
-- ============================================================================
-- REVIEW BEFORE EXECUTING IN SUPABASE SQL EDITOR.
--
-- Guarantees:
--   1. NON-DESTRUCTIVE: Preserves public.employee_profiles and all existing
--      records, including your existing approved administrator account
--      (role = 'ADMIN', account_status = 'APPROVED').
--   2. ZERO RLS RECURSION: Keeps public.employee_profiles SELECT RLS strictly
--      non-recursive (`auth.uid() = auth_user_id`) and executes all privileged
--      admin reads/writes through hardened SECURITY DEFINER RPC functions.
--   3. LEAST PRIVILEGE: Revokes direct INSERT, UPDATE, DELETE on
--      public.employee_profiles from both anon and authenticated roles so
--      employees can never self-approve, escalate role, or alter other records.
--   4. FIXED SEARCH PATH: Every SECURITY DEFINER function pins
--      `SET search_path = public, pg_temp` and revokes PUBLIC/anon execution.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- STEP 0 (READ-ONLY AUDIT): Run these queries first to verify current state
-- ----------------------------------------------------------------------------
-- SELECT column_name, data_type, column_default, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'employee_profiles'
-- ORDER BY ordinal_position;
--
-- SELECT policyname, cmd, roles, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public' AND tablename = 'employee_profiles';
--
-- SELECT grantee, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE table_schema = 'public' AND table_name = 'employee_profiles'
-- ORDER BY grantee, privilege_type;

BEGIN;

-- ----------------------------------------------------------------------------
-- STEP 1: Enforce safe column defaults on public.employee_profiles
-- ----------------------------------------------------------------------------
ALTER TABLE public.employee_profiles
  ALTER COLUMN role SET DEFAULT 'EMPLOYEE',
  ALTER COLUMN account_status SET DEFAULT 'PENDING';

-- ----------------------------------------------------------------------------
-- STEP 2: Non-recursive SECURITY DEFINER admin verification helper
-- Grants TRUE only when the caller's auth.uid() matches an employee_profiles
-- row with BOTH role = 'ADMIN' AND account_status = 'APPROVED'.
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
-- Prevents role escalation, self-approval, identity tampering, and admin
-- self-lockout even if future table privileges or policies are added.
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
    NEW.email := lower(trim(NEW.email));
    NEW.username := lower(trim(NEW.username));
    NEW.employee_id := upper(trim(NEW.employee_id));
    NEW.full_name := trim(NEW.full_name);
    NEW.mobile := trim(coalesce(NEW.mobile, ''));

    -- Any authenticated non-admin insert must strictly be own EMPLOYEE + PENDING row
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

      -- Prevent promoting any employee to ADMIN via application updates
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
-- STEP 4: Auth signup trigger (provisions EMPLOYEE + PENDING automatically)
-- Leaves all existing users (including the existing ADMIN account) untouched.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_employee_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_full_name text;
  v_employee_id text;
  v_username text;
  v_mobile text;
BEGIN
  v_full_name := trim(coalesce(NEW.raw_user_meta_data->>'full_name', ''));
  v_employee_id := upper(trim(coalesce(NEW.raw_user_meta_data->>'employee_id', '')));
  v_username := lower(trim(coalesce(NEW.raw_user_meta_data->>'username', '')));
  v_mobile := trim(coalesce(NEW.raw_user_meta_data->>'mobile', ''));

  IF v_full_name <> '' AND v_employee_id <> '' AND v_username <> '' THEN
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
      lower(trim(NEW.email)),
      v_mobile,
      'EMPLOYEE',
      'PENDING',
      NULL,
      NULL
    )
    ON CONFLICT (auth_user_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_employee_profile ON auth.users;
CREATE TRIGGER on_auth_user_created_employee_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_employee_auth_user();

-- ----------------------------------------------------------------------------
-- STEP 5: Privileged Admin RPC — List all employee profiles
-- Enforces ADMIN + APPROVED verification inside PostgreSQL without adding
-- recursive SELECT policies to public.employee_profiles.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_employee_profiles()
RETURNS SETOF public.employee_profiles
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
  SELECT *
  FROM public.employee_profiles
  ORDER BY created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_employee_profiles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_employee_profiles() TO authenticated;

-- ----------------------------------------------------------------------------
-- STEP 6: Privileged Admin RPC — View single employee details
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_employee_profile(
  p_profile_id uuid
)
RETURNS public.employee_profiles
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_record public.employee_profiles;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_approved_admin() THEN
    RAISE EXCEPTION 'Forbidden: Approved administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_record
  FROM public.employee_profiles
  WHERE id = p_profile_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee profile not found.';
  END IF;

  RETURN v_record;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_employee_profile(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_employee_profile(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- STEP 7: Privileged Admin RPC — Approve / Reject / Suspend / Reactivate
-- Strictly verifies caller is ADMIN + APPROVED, never alters roles, and
-- protects administrator accounts from modification.
-- ----------------------------------------------------------------------------
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
-- Preserves the single non-recursive SELECT policy ("Users can view own profile")
-- so every authenticated user can ONLY query their own profile row directly.
-- All admin directory listing & status mutations go exclusively through the
-- SECURITY DEFINER RPC functions above.
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE public.employee_profiles FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.employee_profiles FROM authenticated;
GRANT SELECT ON TABLE public.employee_profiles TO authenticated;

ALTER TABLE public.employee_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_profiles FORCE ROW LEVEL SECURITY;

-- Remove any duplicate or permissive direct-table policies while preserving own-profile SELECT
DROP POLICY IF EXISTS "Employees can read own profile" ON public.employee_profiles;
DROP POLICY IF EXISTS "Admins can read all employee profiles" ON public.employee_profiles;
DROP POLICY IF EXISTS "Employees can insert own pending profile" ON public.employee_profiles;
DROP POLICY IF EXISTS "Admins can update employee profiles" ON public.employee_profiles;
DROP POLICY IF EXISTS "employee_profiles_select_own" ON public.employee_profiles;
DROP POLICY IF EXISTS "employee_profiles_select_admin" ON public.employee_profiles;
DROP POLICY IF EXISTS "employee_profiles_insert_own_pending" ON public.employee_profiles;
DROP POLICY IF EXISTS "employee_profiles_update_admin" ON public.employee_profiles;
DROP POLICY IF EXISTS "Users can view own profile" ON public.employee_profiles;

-- Single non-recursive SELECT policy: authenticated users can read ONLY their own profile
CREATE POLICY "Users can view own profile"
  ON public.employee_profiles
  FOR SELECT
  TO authenticated
  USING (auth.uid() = auth_user_id);

-- No direct INSERT, UPDATE, or DELETE policies for authenticated/anon roles.
-- Registrations are provisioned atomically via handle_new_employee_auth_user(),
-- and admin operations are executed exclusively via SECURITY DEFINER RPCs.

COMMIT;
