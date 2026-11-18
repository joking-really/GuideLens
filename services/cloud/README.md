# GuideLens Cloud Proxy (`services/cloud`)

Stateless **FastAPI (Python 3.12, Pydantic v2)** backend for GuideLens Pro Mode (`groq_pro`).

## Responsibilities
- **Supabase JWT Authentication:** Verifies Supabase access tokens via HS256 (`SUPABASE_JWT_SECRET`) or JWKS (`SUPABASE_JWKS_URL`).
- **Pro Tier & Fair-Use Quotas:** Checks `profiles.subscription_tier` (`pro_monthly` / `pro_annual`) and `profiles.subscription_status == 'active'`; enforces **1,500 Groq requests/month** and **20 requests/minute** per user and per IP (in-memory sliding window limiter with pluggable Redis backend via `REDIS_URL`).
- **Groq Vision + Reasoning Proxy (`POST /api/v1/guide`):** Sends screenshot + query to Groq (`GROQ_VISION_MODEL` / `GROQ_REASONING_MODEL`), repairs and validates the output into a strict `StepPlan` (`instruction_line <= 140` chars, normalized `0..1000` coordinates), holds screenshots strictly in memory (never logged or persisted), and returns `504` on Groq timeouts.
- **Stripe Billing & Webhooks:**
  - `POST /billing/checkout` (and `/api/v1/billing/checkout`) — Creates a Stripe Checkout session for Pro Monthly (`$19/mo`) or Pro Annual (`$190/yr`).
  - `POST /billing/portal` (and `/api/v1/billing/portal`) — Creates a Stripe Customer Portal session.
  - `POST /webhooks/stripe` (and `/api/v1/webhooks/stripe`) — Verifies `Stripe-Signature` and handles `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted` to update `public.profiles`.
  - `GET /api/v1/me` — Returns current user's subscription tier, status, monthly usage, and quota limit.

---

## Quickstart (Local Development)

```bash
cd services/cloud

# 1. Copy environment template (runs with deterministic mocks if keys are omitted)
cp .env.example .env

# 2. Install dependencies
pip install -r requirements.txt

# 3. Run linter and test suite
ruff check .
pytest

# 4. Start the local server (defaults to http://127.0.0.1:8000)
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

---

## Supabase Database Setup (`supabase db push`)

The SQL migration in `supabase/migrations/20261118000000_init_cloud_schema.sql` creates:
- `public.profiles` (linked 1:1 with `auth.users`)
- `public.usage_logs` (composite unique constraint `(user_id, billing_month)`)
- Row-Level Security (RLS) policies on both tables
- Trigger `on_auth_user_created` auto-creating a `profiles` row on `auth.users` insert
- Atomic `public.increment_usage(user_id uuid, month text)` function (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`)

To push migrations to your Supabase project:

```bash
cd services/cloud
supabase login
supabase link --project-ref <your-supabase-project-ref>
supabase db push
```

---

## Deploying to Railway or Render

### Option A: Railway
1. Create a new project in [Railway](https://railway.app) and connect this repository.
2. Set the **Root Directory** to `services/cloud` (Railway automatically detects the `Dockerfile`).
3. Configure environment variables from `.env.example`:
   - `GROQ_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_JWT_SECRET`
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_PRICE_MONTHLY`
   - `STRIPE_PRICE_ANNUAL`
   - `ALLOWED_ORIGINS`
4. Configure your Stripe Webhook endpoint in the Stripe Dashboard to point to `https://<your-railway-domain>/webhooks/stripe` (or `/api/v1/webhooks/stripe`) for events:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`

### Option B: Render
1. In the [Render Dashboard](https://dashboard.render.com), click **New -> Web Service** and connect this repository.
2. Set **Root Directory** to `services/cloud` and **Runtime** to **Docker**.
3. Set **Health Check Path** to `/health`.
4. Add all environment variables from `.env.example` and deploy.
