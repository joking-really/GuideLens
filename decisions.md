# Locked Build Decisions & Interface Contract (`decisions.md`)

Decided with the user on 2026-11-18 (grill-me session). These override any "X or Y" left open in the other spec files. All workers build against the contracts below; changing a contract requires posting to `@coordinator` first.

## 1. Decisions
| Topic | Decision |
|---|---|
| Scope | All 4 milestones, one monorepo |
| Toolchain | Install rustup (stable-x86_64-pc-windows-msvc) + VS 2022 Build Tools (C++ workload, Windows SDK) via winget; app must compile and run on this machine |
| Cloud proxy | **FastAPI (Python 3.12)**, Pydantic v2, pytest; stateless container (Railway/Render) |
| Local VLM | **Ollama** (localhost:11434); detect/installer link + 1-click `pull` of `qwen2.5vl:3b` (default), `qwen2.5vl:7b`, `llama3.2-vision` |
| BYO API keys (NEW, free tier) | User can plug their own keys for **Gemini, OpenAI, Anthropic, Groq, OpenRouter** for vision+reasoning (and STT where supported) so no local RAM/GPU is used. Keys stored in Windows Credential Manager (`keyring` crate), never in SQLite/plain files |
| Agent integration | **Both directions**: (a) `guidelens-mcp` MCP server/CLI lets agents drive GuideLens; (b) GuideLens can use installed agent CLIs as its brain, headless: Claude Code `claude -p`, Codex `codex exec`, Gemini CLI `gemini -p`, Antigravity `agy`, Hermes `hermes` — screenshot path + prompt in, JSON StepPlan out |
| Target location | **Hybrid**: brain returns a StepPlan (with optional bbox + `target_name`/`control_type`); Rust locator queries Windows **UI Automation** tree and snaps to the matching control's real rect; fallback to brain bbox; if neither is confident (<0.5) → text only, no box |
| Voice | Web Speech API in WebView2 (default); whisper.cpp optional setting; BYO-key cloud STT (Groq Whisper / OpenAI) |
| Cloud accounts | User will supply real Supabase / Stripe test-mode / Groq keys in `services/cloud/.env` (gitignored). Always ship `.env.example`; tests use mocks |
| Pricing | Pro **$19/mo** or **$190/yr**; fair-use **1,500 Groq requests/month**, **20 req/min** |
| Signing | Pipeline wired with placeholder secrets; unsigned local builds for now |

## 2. Repository Layout (ownership in brackets)
```
apps/desktop/                 Tauri v2 app (package name guidelens-desktop)
  src/                        React 18 + TS + Tailwind UI          [frontend]
  src-tauri/src/
    main.rs lib.rs            app setup, plugin + command wiring  [core]
    capture/ overlay/ input/  screen capture, overlay window, hotkey, mouse hook, DPI [core]
    db/                       SQLite (rusqlite, WAL, migrations)   [core]
    bridge/                   localhost control API for MCP        [core]
    brain/                    router + providers + prompts + profiles [brains]
    locator/                  UIA snapping                         [brains]
packages/guidelens-mcp/       Node/TS MCP server + CLI             [mcp]
services/cloud/               FastAPI proxy + supabase/migrations  [cloud]
.github/ benchmarks/ docs/    CI, release, IoU benchmark, docs     [release]
memory.md                     execution ledger                     [release]
```

## 3. Core Types (Rust `serde` + TS mirror in `apps/desktop/src/types.ts`)
Coordinates from brains are **normalized 0–1000** relative to the captured monitor. Rust converts to physical pixels (DPI + monitor offset aware).
```jsonc
// StepPlan — every brain must produce exactly this JSON
{
  "mode": "guide" | "explain" | "terminal",
  "total_steps": 3,
  "steps": [{
    "step_number": 1,
    "instruction_line": "Click the Object Selection Tool in the left toolbar, or press W.", // <=140 chars
    "target_name": "Object Selection Tool",   // optional, used by UIA snapping
    "control_type": "Button",                 // optional UIA control type hint
    "bbox": [x, y, w, h],                     // optional, 0-1000 normalized
    "confidence": 0.0-1.0,
    "shortcut": "W",                          // optional
    "terminal_command": null,                 // string when mode=terminal
    "explanation": null                       // 1 line
  }]
}
// ResolvedStep = Step + "rect_px": {x,y,w,h} | null (physical px, virtual-desktop coords) + "source": "uia"|"vlm"|"none"
```
`BrainKind` = `"agent_mcp" | "agent_cli" | "local_vlm" | "byo_api" | "groq_pro"` (SQLite `sessions.brain_used` accepts all five).

## 4. Tauri IPC (frontend ⇄ core/brains)
Commands (`invoke`): `ask(query: String) -> StepPlan+ResolvedSteps`, `next_step()`, `clear_overlay()`, `toggle_magnify(on: bool)`, `get_settings()/set_settings(s)`, `set_api_key(provider, key)/delete_api_key(provider)/list_api_key_providers()`, `ollama_status()/ollama_pull(model)`, `detect_agents() -> [{id, installed, path}]`, `history_list(limit)/history_get(session_id)`, `auth_login(email,password)/auth_logout()/auth_status()`, `copy_to_clipboard(text)`.
Events (`emit`): `step-changed {step, index, total}`, `overlay-cleared`, `brain-status {state, brain, message}`, `ollama-pull-progress {model, pct}`, `bar-summoned`.
Windows: `bar` (480×52 transparent, frameless, always-on-top, skip-taskbar, draggable), `overlay` (full virtual-desktop, transparent, click-through WS_EX_TRANSPARENT|WS_EX_LAYERED|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE, renders route `/overlay`).

## 5. Local Bridge API (core serves, mcp consumes)
- HTTP on `127.0.0.1:47615` only (fallback next free port). On start, core writes `%LOCALAPPDATA%\GuideLens\bridge.json` = `{ "port": n, "token": "<random 32 bytes hex>", "pid": n }`.
- Every request needs header `Authorization: Bearer <token>`.
- `GET  /v1/health` → `{ok, version}`
- `POST /v1/capture` `{}` → `{ image_path, image_base64 (jpeg), active_app, window_title, monitor: {x,y,w,h,scale} }`
- `POST /v1/highlight` `{ x, y, width, height, coords: "normalized"|"pixels", step_label, instruction_text, magnify? }` → `{ok}` (render < 200 ms)
- `POST /v1/show_command` `{ command, explanation }` → `{ok}`
- `POST /v1/guide` `{ plan: StepPlan }` → `{ok}` (agent supplies a whole multi-step plan; auto-advance applies)
- `POST /v1/clear` → `{ok}`

## 6. Cloud API (cloud serves, brains' `groq_pro` provider consumes)
`POST /api/v1/guide`, `Authorization: Bearer <supabase_jwt>`, body `{ image_base64, query, active_app_title, screen_resolution, conversation_history }` → **StepPlan** (same schema). Errors: 401 bad JWT, 402 not Pro, 429 quota/rate (`{error, retry_after}`), 504 Groq timeout. Plus `POST /api/v1/billing/checkout`, `POST /api/v1/billing/portal`, `GET /api/v1/me` (tier, usage, limit), `POST /api/v1/webhooks/stripe`. Base URL configurable (`GUIDELENS_CLOUD_URL`, default `http://127.0.0.1:8000`).
