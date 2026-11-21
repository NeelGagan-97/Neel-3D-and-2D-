-- ============================================================================
-- NEEL 3D SPACE — SUPABASE AUTHENTICATION, EMPLOYEE PROFILES & RLS MIGRATION
-- ============================================================================
-- IMPORTANT:
-- 1. Review this SQL carefully before executing in Supabase SQL Editor.
-- 2. This migration is NON-DESTRUCTIVE. It preserves public.employee_profiles
--    and all existing records, including the existing approved administrator:
--    Neelgagan B R (role = ADMIN, account_status = APPROVED).
-- 3. Do NOT run any statement that deletes or overwrites existing rows.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- OPTIONAL STEP 0: Inspect existing schema, constraints & RLS policies first
-- (Uncomment and run separately if you want to audit before applying)
-- ----------------------------------------------------------------------------
-- SELECT column_name, data_type, column_default, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'employee_profiles'
-- ORDER BY ordinal_position;
--
-- SELECT conname, contype, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'public.employee_profiles'::regclass;
--
-- SELECT policyname, cmd, roles, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public' AND tablename = 'employee_profiles';

BEGIN;

-- ----------------------------------------------------------------------------
-- STEP 1: Ensure safe column defaults (non-destructive)
-- ----------------------------------------------------------------------------
ALTER TABLE public.employee_profiles
  ALTER COLUMN role SET DEFAULT 'EMPLOYEE',
  ALTER COLUMN account_status SET DEFAULT 'PENDING';

-- ----------------------------------------------------------------------------
-- STEP 2: Non-recursive SECURITY DEFINER helper for approved admin verification
-- Uses fixed search_path to prevent search_path hijacking and avoids RLS loops.
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

REVOKE ALL ON FUNCTION public.is_approved_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_approved_admin() TO authenticated;

-- ----------------------------------------------------------------------------
-- STEP 3: Safe registration availability check (returns booleans only, zero PII)
-- Allows the registration form to detect duplicate email/username/employee_id
-- without granting anon users read access to public.employee_profiles.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_registration_availability(
  p_email text,
  p_username text,
  p_employee_id text
)
RETURNS TABLE (
  email_taken boolean,
  username_taken boolean,
  employee_id_taken boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM public.employee_profiles
      WHERE lower(email) = lower(trim(coalesce(p_email, '')))
    ) AS email_taken,
    EXISTS (
      SELECT 1 FROM public.employee_profiles
      WHERE lower(username) = lower(trim(coalesce(p_username, '')))
    ) AS username_taken,
    EXISTS (
      SELECT 1 FROM public.employee_profiles
      WHERE lower(employee_id) = lower(trim(coalesce(p_employee_id, '')))
    ) AS employee_id_taken;
$$;

REVOKE ALL ON FUNCTION public.check_registration_availability(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_registration_availability(text, text, text) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- STEP 4: Database-level mutation guard trigger on public.employee_profiles
-- Enforces:
--   * Self-registrations are ALWAYS role = 'EMPLOYEE' and account_status = 'PENDING'
--   * Employees cannot escalate role, self-approve, or alter account_status
--   * Admins cannot demote, suspend, or reject their own admin account
--   * Automatically maintains updated_at
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
  -- Allow trusted postgres/service-role maintenance operations where auth.uid() is NULL
  -- (such as auth.users signup trigger or SQL Editor admin tasks).
  IF v_caller_uid IS NOT NULL THEN
    v_is_admin := public.is_approved_admin();
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Normalize identifiers
    NEW.email := lower(trim(NEW.email));
    NEW.username := lower(trim(NEW.username));
    NEW.employee_id := upper(trim(NEW.employee_id));
    NEW.full_name := trim(NEW.full_name);
    NEW.mobile := trim(coalesce(NEW.mobile, ''));

    -- Any authenticated non-admin insert MUST be EMPLOYEE + PENDING with no approval metadata
    IF v_caller_uid IS NOT NULL AND NOT v_is_admin THEN
      IF NEW.auth_user_id IS DISTINCT FROM v_caller_uid THEN
        RAISE EXCEPTION 'Cannot create an employee profile for another user.';
      END IF;
      IF NEW.role IS DISTINCT FROM 'EMPLOYEE' THEN
        RAISE EXCEPTION 'Self-registration must use EMPLOYEE role.';
      END IF;
      IF NEW.account_status IS DISTINCT FROM 'PENDING' THEN
        RAISE EXCEPTION 'Self-registration must start with PENDING status.';
      END IF;
      IF NEW.approved_at IS NOT NULL OR NEW.approved_by IS NOT NULL THEN
        RAISE EXCEPTION 'Self-registration cannot set approval metadata.';
      END IF;
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Immutable identity linkage
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id THEN
      RAISE EXCEPTION 'Profile identity linkage cannot be modified.';
    END IF;

    IF v_caller_uid IS NOT NULL AND NOT v_is_admin THEN
      -- Employees cannot alter their own role, account_status, approval metadata, or unique identifiers
      IF NEW.role IS DISTINCT FROM OLD.role
         OR NEW.account_status IS DISTINCT FROM OLD.account_status
         OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
         OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
         OR NEW.email IS DISTINCT FROM OLD.email
         OR NEW.username IS DISTINCT FROM OLD.username
         OR NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
        RAISE EXCEPTION 'Employees are not authorized to modify role, status, or account identifiers.';
      END IF;
    END IF;

    IF v_caller_uid IS NOT NULL AND v_is_admin THEN
      -- Prevent administrator self-lockout or self-role change
      IF OLD.auth_user_id = v_caller_uid THEN
        IF NEW.role IS DISTINCT FROM OLD.role OR NEW.account_status IS DISTINCT FROM OLD.account_status THEN
          RAISE EXCEPTION 'Administrators cannot modify their own role or account status.';
        END IF;
      END IF;

      -- Automatically stamp approval metadata when transitioning to APPROVED
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
-- STEP 5: Auth signup trigger (handles email-confirmation-required flows safely)
-- Creates the PENDING EMPLOYEE profile immediately on auth.users insert
-- without requiring an active browser session and prevents duplicates on retry.
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

  -- Only auto-create when registration metadata is provided (leaves existing/manual admin users untouched)
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
-- STEP 6: Secure Admin Action RPC (Approve / Reject / Suspend / Reactivate)
-- Performs atomic, server-verified status transitions with self-protection.
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
    RAISE EXCEPTION 'Forbidden: Approved administrator privileges required.';
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
    RAISE EXCEPTION 'Administrators cannot modify their own account status.';
  END IF;

  IF v_target.role = 'ADMIN' THEN
    RAISE EXCEPTION 'Administrator accounts cannot be modified through employee management actions.';
  END IF;

  UPDATE public.employee_profiles
  SET
    account_status = p_new_status,
    approved_at = CASE WHEN p_new_status = 'APPROVED' THEN now() ELSE approved_at END,
    approved_by = CASE WHEN p_new_status = 'APPROVED' THEN v_admin_uid ELSE approved_by END,
    updated_at = now()
  WHERE id = p_profile_id
  RETURNING * INTO v_updated;

  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_employee_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_employee_status(uuid, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- STEP 7: Row Level Security (RLS) on public.employee_profiles
-- ----------------------------------------------------------------------------
-- Revoke all direct table privileges from anonymous role
REVOKE ALL ON TABLE public.employee_profiles FROM anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.employee_profiles TO authenticated;

ALTER TABLE public.employee_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_profiles FORCE ROW LEVEL SECURITY;

-- Drop any legacy or recursive policies before recreating clean policies
DROP POLICY IF EXISTS "Employees can read own profile" ON public.employee_profiles;
DROP POLICY IF EXISTS "Admins can read all employee profiles" ON public.employee_profiles;
DROP POLICY IF EXISTS "Employees can insert own pending profile" ON public.employee_profiles;
DROP POLICY IF EXISTS "Admins can update employee profiles" ON public.employee_profiles;
DROP POLICY IF EXISTS "employee_profiles_select_own" ON public.employee_profiles;
DROP POLICY IF EXISTS "employee_profiles_select_admin" ON public.employee_profiles;
DROP POLICY IF EXISTS "employee_profiles_insert_own_pending" ON public.employee_profiles;
DROP POLICY IF EXISTS "employee_profiles_update_admin" ON public.employee_profiles;

-- 1. Authenticated users can read ONLY their own profile
CREATE POLICY "employee_profiles_select_own"
  ON public.employee_profiles
  FOR SELECT
  TO authenticated
  USING (auth_user_id = auth.uid());

-- 2. Approved administrators can read all employee profiles (non-recursive helper)
CREATE POLICY "employee_profiles_select_admin"
  ON public.employee_profiles
  FOR SELECT
  TO authenticated
  USING (public.is_approved_admin());

-- 3. Authenticated user can insert ONLY their own profile as EMPLOYEE + PENDING
CREATE POLICY "employee_profiles_insert_own_pending"
  ON public.employee_profiles
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth_user_id = auth.uid()
    AND role = 'EMPLOYEE'
    AND account_status = 'PENDING'
    AND approved_at IS NULL
    AND approved_by IS NULL
  );

-- 4. ONLY approved administrators can update employee rows (and never their own row's role/status)
CREATE POLICY "employee_profiles_update_admin"
  ON public.employee_profiles
  FOR UPDATE
  TO authenticated
  USING (
    public.is_approved_admin()
    AND auth_user_id <> auth.uid()
    AND role <> 'ADMIN'
  )
  WITH CHECK (
    public.is_approved_admin()
    AND auth_user_id <> auth.uid()
    AND role = 'EMPLOYEE'
    AND account_status IN ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED')
  );

-- Note: No DELETE policy is defined; deletes are denied by default under RLS.

COMMIT;
