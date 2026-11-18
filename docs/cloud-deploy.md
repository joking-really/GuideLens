# Deploying the GuideLens Cloud Proxy (`services/cloud`)

`services/cloud` is a stateless **FastAPI (Python 3.12 + Pydantic v2)** service that powers GuideLens Pro (`groq_pro` brain). It verifies Supabase JWTs, enforces Pro subscription entitlements and fair-use quotas (**1,500 requests/month**, **20 requests/minute**), calls the **Groq Vision API** with strict `StepPlan` JSON output, and handles **Stripe Checkout, Customer Portal, and webhooks**.

> **Zero Secrets in Client:** `GROQ_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` live **only** in `services/cloud/.env` (or your cloud host's secret manager) and are never bundled into the Windows desktop installer.

---

## 1. Environment Variables (`services/cloud/.env`)

Copy `services/cloud/.env.example` to `services/cloud/.env` (gitignored) and populate:

```dotenv
# Groq API
GROQ_API_KEY=gsk_...
GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
GROQ_TIMEOUT_SECONDS=8.0

# Supabase Auth & Postgres
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_JWT_SECRET=<your-supabase-jwt-secret>

# Stripe Billing ($19/mo or $190/yr)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_ANNUAL=price_...
STRIPE_SUCCESS_URL=https://guidelens.ai/billing/success
STRIPE_CANCEL_URL=https://guidelens.ai/billing/cancel

# Fair-use Quotas
PRO_MONTHLY_QUOTA=1500
PRO_RATE_LIMIT_PER_MIN=20
```

---

## 2. Supabase Schema & RLS Migration

Apply the SQL migration in `services/cloud/supabase/migrations/` using the Supabase CLI or SQL Editor:

```bash
cd services/cloud
supabase db push
```

This creates:
- `public.profiles` (`id`, `email`, `subscription_tier`, `subscription_status`, `stripe_customer_id`, `monthly_request_count`, `billing_cycle_reset_at`) with Row-Level Security (**RLS**) enabled so users can only `SELECT` their own profile while writes are restricted to the backend `service_role`.
- `public.usage_logs` (`id`, `user_id`, `brain_provider`, `active_app`, `latency_ms`, `created_at`) — logs token/latency metadata only (**never screenshots or raw user prompts**).
- Atomic quota check-and-increment function / RPC to prevent race conditions under concurrent requests.

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

## 4. API Endpoints (`decisions.md` §6)

| Method & Path | Auth | Description |
|---|---|---|
| `POST /api/v1/guide` | `Bearer <supabase_jwt>` | Validates Pro tier & quota (`401` bad JWT, `402` not Pro, `429` `{error, retry_after}` on 1,500/mo or 20/min limit, `504` on Groq timeout), invokes Groq Vision with active app profile, and returns a validated `StepPlan`. |
| `GET /api/v1/me` | `Bearer <supabase_jwt>` | Returns `{ tier, status, usage, limit, email }`. |
| `POST /api/v1/billing/checkout` | `Bearer <supabase_jwt>` | Creates a Stripe Checkout Session for `pro_monthly` ($19/mo) or `pro_annual` ($190/yr) and returns `{ url }`. |
| `POST /api/v1/billing/portal` | `Bearer <supabase_jwt>` | Creates a Stripe Customer Portal session and returns `{ url }`. |
| `POST /api/v1/webhooks/stripe` | `Stripe-Signature` header | Verifies HMAC-SHA256 webhook signature and syncs `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted` to Supabase `profiles`. |

---

## 5. Deploying to Railway or Render

### Railway
1. Create a new Railway service pointing to `/services/cloud`.
2. Set start command:
   ```bash
   uvicorn app.main:app --host 0.0.0.0 --port $PORT --workers 2
   ```
3. Configure the environment variables from §1 in Railway Variables.
4. Register your live Stripe webhook endpoint (`https://<your-railway-domain>/api/v1/webhooks/stripe`) in the Stripe Dashboard.
