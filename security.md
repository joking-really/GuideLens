# Security & Privacy Blueprint (`security.md`)

## 1. Authentication & Authorization (RBAC)
- **Authentication:** Handled by **Supabase Auth** (Email/Password + Google OAuth) using short-lived JWT access tokens and secure refresh tokens stored in the Windows Credential Manager via Tauri's secure storage plugin.
- **Role-Based Access Control (RBAC):**
  - `free`: Local VLM + external MCP coding agent bridge only; blocked from cloud Groq proxy.
  - `pro`: Authenticated + active Stripe subscription verified server-side; granted access to `/api/v1/guide` within monthly fair-use quota.
  - `admin`: Internal founder role for viewing aggregate health metrics and managing abuse/rate limits.

## 2. API & Secret Protection
- **Zero Client-Side API Secrets:** The `GROQ_API_KEY` and `STRIPE_SECRET_KEY` live exclusively on the cloud backend server. The desktop client only ever holds the user's own Supabase session JWT.
- **Webhook Verification:** All Stripe webhook events must verify the `Stripe-Signature` header before updating subscription records in Supabase.
- **Rate Limiting:** Per-user and per-IP rate limiting on `/api/v1/guide` (e.g., max 20 requests/minute) to prevent automated scraping or credential stuffing.

## 3. Data Encryption & Screen Privacy
- **In Transit:** All communication between the desktop app, Cloud Proxy, Supabase, Stripe, and Groq API uses **TLS 1.3 (HTTPS)**.
- **At Rest:**
  - Cloud database (Supabase PostgreSQL) encrypted at rest via AES-256.
  - Local SQLite database and screenshots reside strictly on the user's local `%LOCALAPPDATA%\GuideLens\` directory and are auto-pruned after 7 days.
- **V1 Screen Capture Policy:** Uses standard full-screen capture with a clear, upfront **Privacy Disclaimer** shown during onboarding and in settings, informing users to close sensitive windows (banking, password managers, `.env` files) before triggering cloud Pro mode. (No screenshots are stored on the cloud proxy—images are held in memory only for the duration of the Groq API call and immediately discarded.)

## 4. OWASP Top 10 Mitigations
- **Broken Access Control:** Row-Level Security (RLS) enabled on all Supabase tables; server-side subscription checks on every Pro API call.
- **Injection:** Parameterized queries in both local SQLite (`sqlx`/`rusqlite`) and Supabase; strict JSON schema validation (Pydantic/Zod) on all API payloads.
- **XSS in Floating Bar:** React auto-escaping + strict Tauri Content Security Policy (CSP) blocking arbitrary remote scripts; AI responses rendered as plain text/code blocks, never raw HTML.
- **MCP Local Bridge Security:** The local MCP server (`guidelens-mcp`) binds strictly to `127.0.0.1` (localhost) or `stdio` so external network devices cannot view screenshots or draw on the user's screen.

## 5. Software Distribution & Vulnerability Management
- **Code Signing:** Windows `.msi`/`.exe` installers are signed with an Authenticode certificate to prevent Windows SmartScreen warnings and verify binary integrity.
- **Signed Auto-Updates:** Tauri's updater verifies Ed25519 cryptographic signatures on every update bundle before installation.
- **Dependency Hygiene:** Automated `npm audit`, `cargo audit`, and Dependabot alerts enabled in GitHub.
