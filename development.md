# Development Roadmap & Engineering Standards (`development.md`)

## 1. Phased Development Roadmap

### Milestone 1: Core Tauri Shell & Windows Overlay Engine (Weeks 1–2)
- Initialize Tauri v2 + React + TypeScript + Tailwind CSS project.
- Implement Rust modules for:
  - Global shortcut (`Ctrl + Space`).
  - Fast Windows screen capture (`xcap` / `windows-rs`) with DPI/multi-monitor coordinate normalization.
  - Transparent click-through overlay window (`WS_EX_TRANSPARENT`) rendering glowing bounding boxes, step badges, and 2.5× magnifier lens.
  - Global mouse click listener (`rdev`) for smart auto-advance.

### Milestone 2: Multi-Brain Router & Local VLM + MCP Agent Bridge (Weeks 3–4)
- Build local SQLite persistence (`sessions`, `steps`, `app_preferences`).
- Integrate local VLM runner (Ollama / ONNX) with a 1-click model download manager.
- Build `guidelens-mcp` local MCP server + CLI so **Claude Code, Antigravity, Hermes Agent, and ChatGPT Codex** can invoke `capture_screen`, `highlight`, `show_command`, and `clear`.
- Add automatic voice-and-text input bar + Terminal one-click Copy command box.

### Milestone 3: Cloud Pro Backend, Groq API, Supabase & Stripe (Weeks 5–6)
- Set up Supabase project (Auth + `profiles` + `usage_logs` tables).
- Build lightweight FastAPI/Next.js proxy calling **Groq API** for fast vision/OCR and reasoning with strict JSON coordinate output.
- Integrate Stripe Checkout, Customer Portal, and webhook sync.
- Tune prompt templates & shortcut knowledge for the 15 priority Windows apps (Photoshop, Excel, PowerPoint, Google Docs, MS Word, Canva, Premiere Pro, After Effects, VS Code, GitHub Desktop, Terminal, OpenCode, Antigravity, Windows Settings, Chrome).

### Milestone 4: QA, Code Signing & V1 Launch (Weeks 7–8)
- Test DPI scaling (100%–200%) and multi-monitor setups across all 15 priority apps.
- Configure Windows EV/OV code-signing certificate for the `.msi`/`.exe` installer.
- Set up Tauri auto-updater and GitHub Actions CI/CD release pipeline.

---

## 2. Local Environment Setup
- **Prerequisites:** Node.js 20+, Rust (stable `msvc` toolchain on Windows), Python 3.11+ (if using FastAPI proxy), Supabase CLI, Stripe CLI.
- **Commands:**
  ```bash
  npm install
  npm run tauri dev
  ```
- **Environment Variables (Cloud Proxy Only — never bundled in desktop app):**
  - `GROQ_API_KEY`
  - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
  - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`

---

## 3. CI/CD & Testing Strategy
- **Unit & Integration Tests:**
  - Rust unit tests for coordinate normalization (`0–1000` -> physical pixels) and SQLite migrations.
  - React component tests (Vitest) for floating bar states and terminal copy boxes.
  - Cloud proxy tests (Pytest / Vitest) mocking Groq API and verifying JWT + Stripe quota enforcement.
- **Visual Accuracy Benchmark:** Automated test suite running 30+ reference screenshots across Photoshop, VS Code, Excel, and After Effects to verify bounding-box IoU (Intersection over Union) accuracy before every release.
- **CI/CD Pipeline (GitHub Actions):** On tag `v*.*.*`, run lint + tests -> build signed Windows installer -> publish release manifest to Tauri auto-updater endpoint.

---

## 4. Coding Standards (For Human & AI Developers)
- **Strict Type Safety:** TypeScript `strict: true`; Rust `clippy` warnings treated as errors in CI.
- **Zero Secrets in Client:** Never embed `GROQ_API_KEY` or `SUPABASE_SERVICE_ROLE_KEY` in the Tauri frontend or Rust binary.
- **Single-Line UI Rule:** AI system prompts must enforce concise 1-line instructions (`<= 140` characters) to keep the floating bar clean and readable.
