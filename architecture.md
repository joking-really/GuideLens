# System Architecture & Tech Stack (`architecture.md`)

## 1. High-Level Architecture
GuideLens uses a **Hybrid Local-First + Thin Cloud Proxy** architecture designed to minimize server costs, maximize UI responsiveness, and interoperate with external AI coding agents.

```
+-------------------------------------------------------------------+
|                        WINDOWS DESKTOP CLIENT                      |
|                     (Tauri v2 + Rust + React/TS)                   |
|                                                                   |
|  [Floating Bar UI]   [Transparent Click-Through Overlay Window]   |
|         |                               ^                         |
|         v                               | (x, y, w, h + 1-line)   |
|  [Rust Core Engine: Screen Capture, Global Hotkeys, Click Hook]   |
|         |                                                         |
|         +---> [Local SQLite DB] (History, Screenshots, Shortcuts) |
|         |                                                         |
|         +---> [Multi-Brain Router]                                |
|                 |-- 1. Local MCP/CLI Bridge (Claude Code,         |
|                 |      Antigravity, Hermes, ChatGPT Codex)        |
|                 |-- 2. Local VLM Runner (Ollama / ONNX Runtime)   |
|                 +-- 3. Cloud Pro Mode (HTTPS -> Cloud Backend)    |
+-------------------------------------------------------------------+
                                  |
                                  v (Pro Subscribers Only)
+-------------------------------------------------------------------+
|                     CLOUD BACKEND (Next.js / FastAPI)             |
|   - Verifies Supabase JWT & Stripe Subscription Status            |
|   - Enforces Fair-Use Rate Limits                                 |
|   - Proxies Screen + Prompt to Groq API (Reasoning + Vision/OCR)  |
+-------------------------------------------------------------------+
          |                              |
          v                              v
+-------------------+          +-------------------+
|     Supabase      |          |     Groq API      |
| (Auth + Postgres) |          | (Vision/OCR/LLM)  |
+-------------------+          +-------------------+
          |
          v
+-------------------+
|      Stripe       |
|  (Subscriptions)  |
+-------------------+
```

---

## 2. Recommended Tech Stack

| Layer | Technology | Rationale |
| :--- | :--- | :--- |
| **Desktop Shell** | **Tauri v2 (Rust)** | Ultra-lightweight (~10–15 MB installer), low RAM usage alongside Photoshop/Premiere, native Windows transparent click-through overlay support, and future macOS/Linux portability. |
| **Desktop Frontend** | **React 18 + TypeScript + Tailwind CSS** | Fast UI iteration for the translucent dark floating bar, magnifier lens, and command copy boxes. |
| **Screen & Input Hooks** | **Rust (`windows-rs`, `xcap` / `scrap`, `rdev`)** | Sub-50ms full-screen capture, global `Ctrl + Space` hotkey, and global mouse-click coordinate detection for smart auto-advance. |
| **Voice Input** | **Web Speech API / Local Whisper (`whisper.cpp`)** | Automatic voice-and-text capture with low latency and zero cloud STT cost when using local Whisper. |
| **Local AI Runner** | **Ollama / ONNX Runtime** | One-click download and execution of small Vision-Language Models (e.g., Qwen2.5-VL / Florence-2 / Llama-3.2-Vision) for $0-cost free tier. |
| **Agent Skill Bridge** | **Local MCP Server + CLI (`guidelens-mcp`)** | Exposes `capture_screen`, `highlight_region`, `show_instruction`, and `copy_command` tools so Claude Code, Antigravity, Hermes, and Codex can drive the UI. |
| **Cloud Backend** | **FastAPI (Python) or Next.js API Routes** | Lightweight stateless proxy hosted on Railway/Render/Vercel to protect the Groq API key and enforce subscription quotas. |
| **Cloud AI Engine** | **Groq API** | Ultra-low-latency reasoning and vision/OCR inference for Pro subscribers. |
| **Auth & Cloud DB** | **Supabase (Auth + PostgreSQL)** | Handles email/Google login, JWT verification, and subscription/usage tracking. |
| **Payments** | **Stripe** | Subscription checkout, customer portal, and webhook sync to Supabase. |
| **Distribution** | **Tauri Updater + Signed MSI/NSIS Installer** | Code-signed Windows installer with silent background auto-updates via GitHub Releases or S3/R2. |

---

## 3. API & Integration Design

### A. Cloud Proxy Endpoints (Pro Mode)
- `POST /api/v1/guide`
  - **Headers:** `Authorization: Bearer <supabase_jwt>`
  - **Body:** `{ image_base64, query, active_app_title, screen_resolution, conversation_history }`
  - **Process:** Validates JWT -> checks active Stripe tier & monthly quota in Supabase -> calls **Groq API** (vision/OCR + reasoning model) with structured JSON output schema -> increments usage counter -> returns `{ instruction_line, step_number, total_steps, bbox: [x, y, w, h], terminal_command?, explanation? }`.
- `POST /api/v1/webhooks/stripe`
  - Listens for `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted` to update user plan status in Supabase.

### B. Local Agent Skill Interface (MCP / CLI)
Allows external coding agents (Claude Code, Antigravity, Hermes Agent, ChatGPT Codex) to use GuideLens as a visual eyes-and-pointer tool:
- `guidelens.capture_screen()` -> Returns active window metadata + screenshot path/base64.
- `guidelens.highlight(x, y, width, height, step_label, instruction_text, magnify=false)` -> Renders the glowing box and 1-line instruction on the user's live Windows screen.
- `guidelens.show_command(command, explanation)` -> Renders the one-click Copy terminal box in the floating bar.
- `guidelens.clear()` -> Dismisses active overlays.

---

## 4. Multi-Brain Routing Logic
1. **Agent Mode (If invoked by or connected to Claude Code / Antigravity / Hermes / Codex):** Routes reasoning to the user's active coding agent via MCP/CLI.
2. **Local Free Mode (Default Free Tier):** Sends compressed screenshot + query to the locally installed VLM (via Ollama/ONNX).
3. **Groq Pro Mode (Paid Toggle):** Sends screenshot + query to the Cloud Proxy -> Groq API for fastest, highest-accuracy UI element detection and OCR.
