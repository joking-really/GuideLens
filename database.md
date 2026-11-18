# Database & Storage Design (`database.md`)

## 1. Database Architecture Strategy
GuideLens follows a **Split Local-First + Minimal Cloud** database strategy:
1. **Local SQLite (`guidelens_local.db` on the user's Windows PC):** Stores all private session history, screenshot thumbnails, step-by-step guides, and user-saved app shortcuts. This keeps cloud storage costs near zero, makes history lookup instantaneous, and ensures user screenshots are never stored permanently on remote servers.
2. **Cloud PostgreSQL (Supabase):** Stores only user authentication profiles, Stripe subscription statuses, and monthly Groq API usage counters.

---

## 2. Local SQLite Schema (User's PC)

### Table: `sessions`
Stores each help session initiated by the user.
- `id` (`TEXT PRIMARY KEY` — UUID)
- `active_app` (`TEXT NOT NULL` — e.g., `"Photoshop.exe"`, `"Code.exe"`, `"WindowsTerminal.exe"`)
- `user_query` (`TEXT NOT NULL`)
- `brain_used` (`TEXT NOT NULL` — `'local_vlm' | 'groq_pro' | 'agent_mcp'`)
- `created_at` (`INTEGER NOT NULL` — Unix timestamp)

### Table: `steps`
Stores individual steps generated within a session.
- `id` (`TEXT PRIMARY KEY` — UUID)
- `session_id` (`TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`)
- `step_number` (`INTEGER NOT NULL`)
- `instruction_line` (`TEXT NOT NULL`)
- `bbox_json` (`TEXT` — JSON `[x, y, w, h]` normalized to 0–1000 screen coordinates)
- `terminal_command` (`TEXT` — nullable, for CLI tasks)
- `screenshot_path` (`TEXT` — local path in `%LOCALAPPDATA%\GuideLens\captures\`, auto-pruned after 7 days)
- `completed` (`INTEGER DEFAULT 0`)

### Table: `app_preferences`
Stores per-app user settings (e.g., preferred zoom toggle, custom hotkey overrides).
- `app_executable` (`TEXT PRIMARY KEY`)
- `always_magnify` (`INTEGER DEFAULT 0`)
- `preferred_brain` (`TEXT DEFAULT 'auto'`)

---

## 3. Cloud PostgreSQL Schema (Supabase)

### Table: `profiles`
Linked 1:1 with `auth.users`.
- `id` (`uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE`)
- `email` (`text UNIQUE NOT NULL`)
- `stripe_customer_id` (`text UNIQUE`)
- `subscription_tier` (`text NOT NULL DEFAULT 'free'` — `'free' | 'pro_monthly' | 'pro_annual'`)
- `subscription_status` (`text NOT NULL DEFAULT 'inactive'` — `'active' | 'past_due' | 'canceled' | 'inactive'`)
- `current_period_end` (`timestamptz`)
- `created_at` (`timestamptz DEFAULT now()`)

### Table: `usage_logs`
Tracks monthly Groq API requests per user for fair-use enforcement.
- `id` (`uuid PRIMARY KEY DEFAULT gen_random_uuid()`)
- `user_id` (`uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE`)
- `billing_month` (`text NOT NULL` — format `'YYYY-MM'`)
- `groq_requests_count` (`integer NOT NULL DEFAULT 0`)
- `updated_at` (`timestamptz DEFAULT now()`)
- **Unique Constraint:** `(user_id, billing_month)`

---

## 4. Indexing & Backup Strategy
- **Local SQLite Indexing:** Index `sessions(created_at DESC)` and `steps(session_id, step_number)` for instant history search. Run a scheduled local cleanup job on app startup to prune screenshot files older than 7 days (configurable in settings) so disk usage stays under 200 MB.
- **Cloud Supabase Indexing:** Primary key indexes on `profiles(id)`, unique index on `profiles(stripe_customer_id)`, and composite unique index on `usage_logs(user_id, billing_month)` for atomic increment (`INSERT ... ON CONFLICT DO UPDATE`).
- **Backups:** Supabase automated daily point-in-time backups for cloud account/billing tables. Local SQLite database is backed up automatically on major app version upgrades before any schema migration runs.
