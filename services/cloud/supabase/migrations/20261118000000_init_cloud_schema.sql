-- GuideLens Cloud Database Schema (Supabase PostgreSQL)
-- Matches database.md §3-4 and security.md §1, §4:
-- 1. profiles (1:1 with auth.users, Stripe subscription state)
-- 2. usage_logs (monthly Groq API request counters per user)
-- 3. Row-Level Security (RLS) policies on all tables
-- 4. Trigger auto-creating a profile on auth.users insert
-- 5. Atomic increment_usage(user_id, month) function (INSERT ... ON CONFLICT DO UPDATE ... RETURNING)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. Table: public.profiles
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email text UNIQUE NOT NULL,
    stripe_customer_id text UNIQUE,
    subscription_tier text NOT NULL DEFAULT 'free'
        CHECK (subscription_tier IN ('free', 'pro_monthly', 'pro_annual')),
    subscription_status text NOT NULL DEFAULT 'inactive'
        CHECK (subscription_status IN ('active', 'past_due', 'canceled', 'inactive')),
    current_period_end timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_stripe_customer_id
    ON public.profiles (stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;

-- ============================================================================
-- 2. Table: public.usage_logs
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.usage_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    billing_month text NOT NULL
        CHECK (billing_month ~ '^[0-9]{4}-[0-9]{2}$'),
    groq_requests_count integer NOT NULL DEFAULT 0
        CHECK (groq_requests_count >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT usage_logs_user_id_billing_month_key UNIQUE (user_id, billing_month)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_logs_user_id_billing_month
    ON public.usage_logs (user_id, billing_month);

-- ============================================================================
-- 3. Row-Level Security (RLS) Policies
-- ============================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_logs ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile"
    ON public.profiles
    FOR SELECT
    TO authenticated
    USING (auth.uid() = id);

-- Service role has full access to profiles
DROP POLICY IF EXISTS "Service role full access on profiles" ON public.profiles;
CREATE POLICY "Service role full access on profiles"
    ON public.profiles
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Users can read their own usage logs
DROP POLICY IF EXISTS "Users can view own usage logs" ON public.usage_logs;
CREATE POLICY "Users can view own usage logs"
    ON public.usage_logs
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Service role has full access to usage_logs
DROP POLICY IF EXISTS "Service role full access on usage_logs" ON public.usage_logs;
CREATE POLICY "Service role full access on usage_logs"
    ON public.usage_logs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ============================================================================
-- 4. Trigger: Auto-create profile row on auth.users insert
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.profiles (id, email, subscription_tier, subscription_status)
    VALUES (
        NEW.id,
        COALESCE(NEW.email, NEW.id::text || '@users.guidelens.local'),
        'free',
        'inactive'
    )
    ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- 5. Atomic Usage Increment Function: increment_usage(user_id, month)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.increment_usage(user_id uuid, month text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    new_count integer;
BEGIN
    INSERT INTO public.usage_logs AS ul (
        user_id,
        billing_month,
        groq_requests_count,
        updated_at
    )
    VALUES (
        increment_usage.user_id,
        increment_usage.month,
        1,
        now()
    )
    ON CONFLICT (user_id, billing_month)
    DO UPDATE SET
        groq_requests_count = ul.groq_requests_count + 1,
        updated_at = now()
    RETURNING ul.groq_requests_count INTO new_count;

    RETURN new_count;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_usage(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_usage(uuid, text) TO service_role;
