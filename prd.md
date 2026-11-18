# Product Requirements Document (`PRD.md`)

## 1. MVP Scope (Version 1.0 — Windows)
Version 1 focuses exclusively on **Windows 10/11** to validate core accuracy and user adoption before expanding to macOS and Linux.

### In Scope for V1
- Translucent dark-mode floating command bar (`Ctrl + Space` global shortcut, draggable).
- Automatic voice-and-text input.
- Transparent click-through full-screen overlay drawing a glowing bounding box + step badge + optional 2.5× magnifier lens.
- Smart auto-advance on target click + manual `Next →` fallback button.
- Terminal/CLI mode with one-click Copy command box and 1-line plain-English explanation.
- Multi-brain routing:
  1. **Local MCP/CLI Agent Skill** (for Claude Code, Antigravity, Hermes Agent, ChatGPT Codex).
  2. **Local Lightweight VLM** (Ollama / ONNX one-click download for $0-cost free tier).
  3. **Pro Cloud Tier** powered by **Groq API** (reasoning + OCR/vision) via Next.js/FastAPI proxy + Supabase Auth + Stripe.
- Priority app tuning for: Photoshop, Excel, PowerPoint, Google Docs, MS Word, Canva, Premiere Pro, After Effects, VS Code, GitHub Desktop, Windows Terminal, OpenCode, Antigravity, Windows Settings, and Chrome.
- Signed Windows installer + silent background auto-updater.

### Out of Scope for V1 (Deferred to V2)
- macOS and Linux desktop builds.
- Autonomous mouse/keyboard takeover ("autopilot").
- Team/enterprise admin dashboards and shared workspace libraries.
- On-device real-time PII/secret blurring (V1 uses standard full-screen capture with a clear privacy disclaimer).

---

## 2. Functional Requirements & User Stories

### FR-1: Summon & Input
- **User Story:** *As a solo creator, I want to press `Ctrl + Space` or speak naturally without leaving Photoshop so I can ask how to complete a task.*
- **Acceptance Criteria:**
  - Pressing `Ctrl + Space` focuses the floating bar in <100ms without minimizing the active app.
  - Automatic voice-and-text mode allows typing or speaking immediately; a mute toggle disables the mic at any time.

### FR-2: Visual Highlight & Magnification
- **User Story:** *As a beginner, I want to see a glowing box and optional zoom lens over the exact button I need to click so I don't waste time hunting through tiny menus.*
- **Acceptance Criteria:**
  - Overlay window is 100% click-through (`WS_EX_TRANSPARENT`) so the user clicks directly into the underlying app.
  - Bounding box aligns within ±5px of the target UI control across 100%–200% Windows DPI scaling.
  - Clicking the `Magnify` toggle renders a 2.5× zoomed preview of the target icon.

### FR-3: Multi-Step Auto-Advance
- **User Story:** *As a user following a 4-step workflow, I want the highlight to automatically move to Step 2 after I click Step 1.*
- **Acceptance Criteria:**
  - Global mouse hook detects a left-click inside the active bounding box and advances to Step `N+1` within 500ms.
  - A manual `Next →` button is always available if the user uses a keyboard shortcut instead of clicking.

### FR-4: Terminal & CLI Guidance
- **User Story:** *As a developer using terminal tools, OpenCode, or Antigravity, I want a copy-ready command with a 1-line explanation.*
- **Acceptance Criteria:**
  - When a terminal window is active, the compact block renders a monospace command box with a 1-click `[Copy]` button and a single plain-English explanation line.

### FR-5: Coding Agent Skill Bridge (MCP / CLI)
- **User Story:** *As an AI-first builder using Claude Code or Antigravity, I want my coding agent to call GuideLens directly to highlight buttons on my screen.*
- **Acceptance Criteria:**
  - Local MCP server exposes `capture_screen`, `highlight`, `show_command`, and `clear` tools.
  - Calling `highlight` from an external agent renders the overlay on the user's live Windows screen within 200ms.

### FR-6: Multi-Brain Switching & Billing
- **User Story:** *As a free user, I want to download a small local vision model so I can use the app for free, or upgrade to Pro for faster Groq cloud intelligence.*
- **Acceptance Criteria:**
  - Corner toggle switches cleanly between `Local (Free)`, `Pro (Groq)`, and `Agent` modes.
  - Pro requests validate Supabase JWT and active Stripe subscription before calling the Groq API.
