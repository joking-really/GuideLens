# GuideLens — Windows AI On-Screen Copilot & Agent Visual Bridge

GuideLens is a low-latency Windows 10/11 desktop copilot that sees your active application, locates the exact UI control you need (combining **Vision LLMs** with live **Windows UI Automation** snapping), and draws a click-through glowing bounding box, step badge, 2.5× magnifier lens, or one-click **Copy** terminal command right on your screen.

It also acts as a **bi-directional visual bridge for AI coding & desktop agents** (**Claude Code**, **Antigravity (`agy`)**, **ChatGPT Codex**, **Gemini CLI**, **Hermes**): agents can drive GuideLens's overlay via `guidelens-mcp`, or GuideLens can invoke your installed agent CLI headlessly as its reasoning brain.

---

## Key Features

- **Instant Global Summon (`Ctrl + Space`)**: Toggles a compact `480×52` translucent command bar (`< 100 ms`) with automatic voice (`Web Speech API` / `whisper.cpp` / cloud STT) and text input.
- **Non-Intrusive Click-Through Overlay**: Full virtual-desktop transparent window (`WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`) with DPI-aware multi-monitor coordinate mapping.
- **Hybrid UIA + VLM Target Locator**: Snaps bounding boxes to real Windows UI Automation (`IUIAutomation`) controls when available, falling back to normalized `0–1000` VLM coordinates, or graceful text-only guidance when confidence `< 0.5`.
- **Smart Auto-Advance**: Global mouse hook (`WH_MOUSE_LL` / `rdev`) detects when you click inside the highlighted target control and automatically advances to the next step (`<= 500 ms`). Press `Esc` anytime to clear.
- **5 Interchangeable Brains (`BrainKind`)**:
  - `local_vlm` — Offline **Ollama** vision models (`qwen2.5vl:3b` default, `qwen2.5vl:7b`, `llama3.2-vision`) with 1-click download.
  - `byo_api` — Bring-Your-Own API keys (**Gemini, OpenAI, Anthropic, Groq, OpenRouter**) stored exclusively in **Windows Credential Manager** (`keyring`).
  - `agent_cli` — Headless invocation of installed agent CLIs (`claude -p`, `codex exec`, `gemini -p`, `agy`, `hermes`).
  - `agent_mcp` — External MCP agents driving GuideLens over the localhost bridge (`127.0.0.1:47615`).
  - `groq_pro` — Managed **GuideLens Cloud Pro** proxy powered by Groq Vision (`1,500 req/mo`, `20 req/min`).
- **15 Priority Windows App Profiles**: Built-in shortcut & UI layout profiles for Photoshop, Excel, PowerPoint, Google Docs, Word, Canva, Premiere Pro, After Effects, VS Code, GitHub Desktop, Terminal, OpenCode, Antigravity, Windows Settings, and Chrome.

---

## Monorepo Layout

```text
GuideLens/
├── apps/desktop/                 # Tauri v2 (Rust) + React 18 + TS + Tailwind desktop app
│   ├── src/                      # Floating bar, click-through overlay, settings, onboarding UI
│   └── src-tauri/src/
│       ├── capture/              # xcap screen capture + DPI/multi-monitor 0-1000 normalization
│       ├── overlay/              # Win32 extended styles + virtual-desktop overlay window
│       ├── input/                # Global hotkey (Ctrl+Space), mouse click hook, Esc handler
│       ├── db/                   # SQLite (WAL mode) sessions, steps, app_preferences + 7-day prune
│       ├── bridge/               # Localhost HTTP control API (127.0.0.1:47615, bearer token)
│       ├── brain/                # Multi-brain router, providers, 15 app profiles, JSON repair
│       └── locator/              # Windows UI Automation (UIA) tree matcher & rect snapping
├── packages/guidelens-mcp/       # Node/TypeScript MCP server + standalone CLI
├── services/cloud/               # FastAPI (Python 3.12) Groq proxy + Supabase Auth/RLS + Stripe
├── benchmarks/                   # Visual accuracy IoU benchmark harness + reference cases
├── docs/                         # Setup, brain config, MCP, cloud deploy, and code-signing docs
└── .github/                      # GitHub Actions CI, Windows NSIS/MSI release pipeline, Dependabot
```

---

## Quick Start

```powershell
# 1. Desktop App (Tauri v2 + React)
cd apps/desktop
npm install
npm run tauri dev

# 2. Local MCP Server & CLI
cd ../../packages/guidelens-mcp
npm install && npm run build && npm test

# 3. Cloud Proxy (FastAPI + Pytest)
cd ../../services/cloud
pip install -r requirements.txt
pytest -q

# 4. Visual Accuracy IoU Benchmark
cd ../..
python benchmarks/run_benchmark.py --validate-only
```

---

## Documentation

- [Getting Started on Windows 10/11](docs/getting-started.md) — Toolchain setup (`rustup`, VS 2022 C++ Build Tools), running `tauri dev`, and building installers.
- [Configuring Brains](docs/configuring-brains.md) — Setting up Ollama local VLMs, BYO API keys in Windows Credential Manager, and headless agent CLIs.
- [MCP Server & CLI Setup](docs/mcp-setup.md) — Connecting Claude Code, Antigravity, Codex, and Hermes to `guidelens-mcp`.
- [Cloud Proxy Deployment](docs/cloud-deploy.md) — Deploying `services/cloud` (FastAPI + Supabase + Stripe + Groq) to Railway/Render.
- [Code Signing & Auto-Updater](docs/code-signing-and-updater.md) — Generating Ed25519 updater keys (`tauri signer generate`) and configuring Windows Authenticode secrets.
- [Visual Accuracy Benchmark](benchmarks/README.md) — Running the IoU accuracy harness (`>90%` pass rate at `IoU >= 0.5`).
