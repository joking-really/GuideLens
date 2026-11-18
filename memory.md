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
- **Current Phase:** Blueprint & Specification Complete — Ready for Milestone 1 Implementation
- **Target Launch OS:** Windows 10/11 (macOS & Linux deferred to V2)
- **Core Stack:** Tauri v2 (Rust) + React/TS + Local SQLite + Ollama/ONNX + `guidelens-mcp` + Cloud Proxy (FastAPI/Next.js) + Groq API + Supabase + Stripe
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

*(No implementation entries logged yet. Ready for first coding agent to begin Milestone 1.)*
