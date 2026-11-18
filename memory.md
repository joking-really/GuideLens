# AI Agent Handoff & Context Ledger (`memory.md`)

> **STRICT SYSTEM INSTRUCTIONS FOR ALL AI CODING AGENTS**
> 1. **READ FIRST:** Before writing any code, running commands, or making architectural decisions, you MUST read this entire `memory.md` file to understand the current project state, locked-in architecture, and pending tasks.
> 2. **STAY ALIGNED:** Do not deviate from the finalized stack (`Tauri v2 + Rust + React/TS`, `Local SQLite`, `Ollama/ONNX Local VLM`, `Local MCP/CLI Agent Bridge`, `FastAPI/Next.js Cloud Proxy`, `Groq API`, `Supabase`, `Stripe`) without explicit user approval.
> 3. **UPDATE AFTER EVERY TASK:** Immediately after completing any task, feature, bugfix, or architectural change, you MUST update this ledger with:
>    - Date/time and Agent ID/Name
>    - Exact files created or modified
>    - Architectural or schema changes made
>    - Updated list of completed vs. pending items
>    - Any known blockers or test results
> 4. **NEVER DELETE HISTORY:** Append new entries chronologically in the Execution Log below so any future agent can seamlessly resume work.

---

## Current Project State Snapshot
- **Project Name:** GuideLens (AI On-Screen Desktop Copilot & Agent Visual Bridge)
- **Current Phase:** Milestones 1–4 Implementation in Progress (Release/CI/Benchmarks/Docs complete; Desktop Core, Brains, Frontend, MCP, and Cloud actively building)
- **Target Launch OS:** Windows 10/11 (macOS & Linux deferred to V2)
- **Core Stack:** Tauri v2 (Rust) + React/TS + Local SQLite + Ollama/ONNX + `guidelens-mcp` + Cloud Proxy (FastAPI) + Groq API + Supabase + Stripe
- **Active Blockers:** None

---

## Milestone Checklist
- [ ] **Milestone 1:** Tauri v2 shell, global hotkey (`Ctrl + Space`), Windows screen capture, transparent click-through overlay, glowing box + magnifier, click auto-advance
- [ ] **Milestone 2:** Local SQLite DB, Local VLM runner (Ollama/ONNX), `guidelens-mcp` agent skill bridge (Claude Code, Antigravity, Hermes, Codex), voice/text bar, terminal Copy box
- [ ] **Milestone 3:** Cloud proxy, Groq API integration, Supabase Auth/DB, Stripe billing, 15 priority app prompt/shortcut profiles
- [ ] **Milestone 4:** DPI & multi-monitor QA, Windows code signing, Tauri auto-updater, V1 release

---

## Execution Log (Chronological — Append New Entries Below)

### Entry Template
```markdown
### [YYYY-MM-DD HH:MM] — Agent: [Agent Name / Model]
- **Task:** [Brief description of task worked on]
- **Status:** [Completed | In Progress | Blocked]
- **Files Created / Modified:**
  - `path/to/file` — [what changed]
- **Architectural / Schema Changes:** [None | describe changes]
- **Verification / Test Results:** [Commands run & outcomes]
- **Next Pending Step:** [What the next agent should pick up immediately]
```

### [2026-11-18 23:45] — Agent: release (gemini-pro-orchestrator-g1-pro)
- **Task:** Root `.gitignore`/`.editorconfig`, GitHub Actions CI & Windows Release pipelines (`ci.yml`, `release.yml`, `dependabot.yml`), Visual Accuracy IoU Benchmark Harness (`benchmarks/`), Documentation (`docs/` & root `README.md`), and `memory.md` ledger maintenance.
- **Status:** Completed
- **Files Created / Modified:**
  - `.gitignore` & `.editorconfig` — Root ignore rules (`node_modules`, `target`, `dist`, `.env`, `*.db`, `captures`, `.venv`, `__pycache__`) and formatting defaults.
  - `.github/workflows/ci.yml` — Multi-job CI covering Desktop Rust (`cargo clippy -- -D warnings`, `cargo test`), Desktop TS (`tsc --noEmit`, `vitest run`, `npm run build`), `guidelens-mcp` (`npm run build`, `npm test`), `services/cloud` (`ruff check`, `pytest`, `pip-audit`), IoU benchmark self-test, and `npm audit` + `cargo audit`.
  - `.github/workflows/release.yml` — Tag `v*.*.*` release workflow building Windows NSIS (`.exe`) + MSI (`.msi`) installers via `tauri-apps/tauri-action@v0`, optional Authenticode signing (`WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`), Ed25519 updater signing (`TAURI_SIGNING_PRIVATE_KEY`), and publishing `latest.json` to GitHub Releases.
  - `.github/dependabot.yml` — Weekly dependency update checks for npm (`apps/desktop`, `packages/guidelens-mcp`), cargo (`apps/desktop/src-tauri`), pip (`services/cloud`), and `github-actions`.
  - `benchmarks/schema.json` — JSON Schema (2020-12) for reference screenshot + ground-truth `bbox` (`0–1000` normalized) benchmark cases.
  - `benchmarks/run_benchmark.py` — IoU accuracy harness supporting `--validate-only`, `--brain mock`, `--brain cloud`, `--brain ollama`, and `--brain byo` (`openai`, `gemini`, `anthropic`, `groq`, `openrouter`), enforcing `IoU >= 0.50`, suite pass rate `>= 90%`, and `instruction_line <= 140` chars.
  - `benchmarks/cases/01_photoshop_object_selection.json`, `02_vscode_extensions_sidebar.json`, `03_excel_autosum_ribbon.json` (+ synthetic reference PNGs in `benchmarks/cases/images/`) — 3 synthetic reference cases across Photoshop, VS Code, and Excel.
  - `benchmarks/tests/test_benchmark.py` & `benchmarks/README.md` — Unit tests for IoU math & StepPlan validation, plus instructions for adding the 30+ reference screenshots across the 15 priority apps.
  - `docs/getting-started.md`, `docs/configuring-brains.md`, `docs/mcp-setup.md`, `docs/cloud-deploy.md`, `docs/code-signing-and-updater.md`, `README.md` — Full developer and release documentation.
- **Architectural / Schema Changes:** Locked IPC payload additions from board #11/#12 (`billing_checkout` and optional `transcribe`, plus detailed `ask`/`step-changed`/`brain-status`/`Settings` shapes).
- **Verification / Test Results:**
  - `python benchmarks/run_benchmark.py --validate-only` → 3/3 cases passed (100.0% pass rate, Mean IoU 0.875, Median IoU 0.871, Release Gate PASSED).
  - `python -m unittest discover -s benchmarks/tests -v` → 6/6 unit tests passed (`OK`).
  - `PyYAML` validation of `.github/workflows/ci.yml`, `.github/workflows/release.yml`, and `.github/dependabot.yml` → all valid YAML.
- **Next Pending Step:** `@verifier-services` to verify CI workflows, IoU benchmark harness, and docs; `@release` continuing to monitor board and record completed worker summaries in `memory.md`.
