# Deploying the GuideLens Cloud Proxy (`services/cloud`)

`services/cloud` is a stateless **FastAPI (Python 3.12 + Pydantic v2)** service that powers GuideLens Pro (`groq_pro` brain). It verifies Supabase JWTs, enforces Pro subscription entitlements and fair-use quotas (**1,500 requests/month**, **20 requests/minute**), calls the **Groq Vision API** with strict `StepPlan` JSON output, and handles **Stripe Checkout, Customer Portal, and webhooks**.

> **Zero Secrets in Client:** `GROQ_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` live **only** in `services/cloud/.env` (or your cloud host's secret manager) and are never bundled into the Windows desktop installer.

---

## 1. Environment Variables (`services/cloud/.env`)

Copy `services/cloud/.env.example` to `services/cloud/.env` (gitignored) and populate (names match `services/cloud/app/config.py`):

```dotenv
# Groq API Configuration
GROQ_API_KEY=gsk_your_groq_api_key_here
GROQ_BASE_URL=https://api.groq.com/openai/v1
GROQ_VISION_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
GROQ_REASONING_MODEL=llama-3.3-70b-versatile
GROQ_TIMEOUT_SECONDS=15.0

# Supabase Configuration
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_JWT_SECRET=your-supabase-jwt-secret-min-32-chars
# Optional: set SUPABASE_JWKS_URL to verify RS256/ES256 tokens via JWKS
SUPABASE_JWKS_URL=
SUPABASE_JWT_AUDIENCE=authenticated

# Stripe Configuration ($19/mo and $190/yr Pro plans)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_MONTHLY=price_pro_monthly_19_usd
STRIPE_PRICE_ANNUAL=price_pro_annual_190_usd

# Billing Redirect URLs
BILLING_SUCCESS_URL=https://guidelens.app/billing/success
BILLING_CANCEL_URL=https://guidelens.app/billing/cancel
BILLING_PORTAL_RETURN_URL=https://guidelens.app/settings

# Quotas & Rate Limiting
MONTHLY_QUOTA_LIMIT=1500
RATE_LIMIT_PER_MINUTE=20
# Optional Redis URL for distributed rate limiting (falls back to in-memory if empty)
REDIS_URL=

# CORS Allowed Origins (comma-separated)
ALLOWED_ORIGINS=http://localhost:1420,tauri://localhost,https://tauri.localhost
```

---

## 2. Supabase Schema & RLS Migration

Apply the SQL migration in `services/cloud/supabase/migrations/20261118000000_init_cloud_schema.sql` using the Supabase CLI or SQL Editor:

```bash
cd services/cloud
supabase db push
```

Per `database.md` §3–4, this creates:
- `public.profiles` (`id`, `email`, `stripe_customer_id`, `subscription_tier` [`free`, `pro_monthly`, `pro_annual`], `subscription_status` [`active`, `past_due`, `canceled`, `inactive`], `current_period_end`, `created_at`) with **RLS** enabled (`authenticated` users can `SELECT` only their own row; `service_role` has full access).
- `public.usage_logs` (`id`, `user_id`, `billing_month` `YYYY-MM`, `groq_requests_count`, `updated_at`, unique `(user_id, billing_month)`) with **RLS** enabled (`authenticated` users can `SELECT` only their own rows; `service_role` has full access). Records monthly aggregate counters only (**never screenshots or raw user prompts**).
- `public.handle_new_user()` trigger auto-creating a `free`/`inactive` profile row when a user signs up via `auth.users`.
- `public.increment_usage(user_id uuid, month text)` atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` function (executable by `service_role` only) to prevent quota race conditions under concurrent requests.

---

## 3. Running & Testing Locally

```bash
cd services/cloud
python -m venv .venv
# Windows: .venv\Scripts\activate | Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt

# Lint & run unit tests (all external APIs mocked, no real secrets required)
ruff check .
pytest -q

# Start local development server on http://127.0.0.1:8000
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Point the desktop app at your custom or local cloud proxy by setting `GUIDELENS_CLOUD_URL=http://127.0.0.1:8000` (or changing `cloud_url` in GuideLens Settings).

---

## 4. API Endpoints (`decisions.md` §6 & `services/cloud/app/main.py`)

| Method & Path | Auth | Description |
|---|---|---|
| `GET /health` & `GET /api/v1/health` | None | Returns `{ ok, service, version }`. |
| `POST /api/v1/guide` | `Bearer <supabase_jwt>` | Validates Pro tier & quota (`401` bad JWT, `402` not Pro, `429` `{ error, message, retry_after }` on `MONTHLY_QUOTA_LIMIT=1500` or `RATE_LIMIT_PER_MINUTE=20`, `504` Groq timeout, `502` Groq upstream error), calls Groq Vision, atomically increments `usage_logs`, and returns a validated `StepPlan`. |
| `GET /api/v1/me` | `Bearer <supabase_jwt>` | Returns `MeResponse`: `{ id, email, tier, subscription_tier, status, subscription_status, usage, limit, billing_month, current_period_end }`. |
| `POST /api/v1/billing/checkout` (also `/billing/checkout`) | `Bearer <supabase_jwt>` | Creates a Stripe Checkout Session for `monthly`/`pro_monthly` ($19/mo) or `annual`/`pro_annual` ($190/yr) and returns `{ url, session_id }`. |
| `POST /api/v1/billing/portal` (also `/billing/portal`) | `Bearer <supabase_jwt>` | Creates a Stripe Customer Portal session and returns `{ url }`. |
| `POST /api/v1/webhooks/stripe` (also `/webhooks/stripe`) | `Stripe-Signature` header | Verifies Stripe HMAC webhook signature and syncs subscription events (`checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, etc.) to `public.profiles`. |

---

## 5. Deploying to Railway or Render

### Railway / Docker (`services/cloud/Dockerfile`)
1. Deploy `/services/cloud` directly using `services/cloud/Dockerfile` (or point Railway/Render to `/services/cloud`):
   ```bash
   uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
   ```
2. Configure the environment variables from §1 in Railway/Render Secrets.
3. Register your live Stripe webhook endpoint (`https://<your-cloud-domain>/api/v1/webhooks/stripe`) in the Stripe Dashboard.
