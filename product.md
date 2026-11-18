# Product Strategy & Vision (`product.md`)

## 1. Product Overview
**Working Name:** GuideLens (AI On-Screen Desktop Copilot)  
**Category:** B2B/Prosumer SaaS Desktop Application + AI Agent Visual Skill  
**Launch Platform:** Windows 10/11 (expanding to macOS and Linux post-V1)

**GuideLens** is a lightweight, non-intrusive AI desktop assistant that sees what is on a user's screen and guides them step by step through any software application—from creative suites like Photoshop and Premiere Pro to developer tools like VS Code, GitHub Desktop, and terminal CLIs. Instead of leaving their workflow to watch 10-minute YouTube tutorials or read dense documentation, users ask a question via text or voice and immediately see a glowing visual highlight (with optional magnification) directly over the exact button they need to click, paired with a concise one-line explanation.

Additionally, GuideLens doubles as a **callable visual skill/bridge** (similar to Agent Desktop) for coding and productivity agents such as **Claude Code, Antigravity, Hermes Agent, and ChatGPT Codex**, allowing those agents to visually guide humans through GUI applications.

---

## 2. Vision Statement
> *"To make every piece of desktop software immediately usable by anyone—turning any screen into an interactive, zero-search guided workspace powered by your choice of local AI, existing coding agents, or ultra-fast cloud intelligence."*

---

## 3. Target Audience Personas

### Persona 1: The Creative Freelancer ("Sara, 26 — Freelance Designer & Content Creator")
- **Tools Used:** Adobe Photoshop, Canva, Premiere Pro, After Effects, Chrome.
- **Pain Point:** Needs to perform occasional advanced tasks (e.g., removing a complex background, keyframing an effect in After Effects, exporting with specific Premiere settings) without spending 20 minutes scrubbing through YouTube tutorials.
- **How GuideLens Helps:** Sara presses `Ctrl + Space`, speaks *"How do I remove this background?"*, and follows 3 glowing highlight boxes directly on her Photoshop canvas.

### Persona 2: The Solo Knowledge Worker ("Tariq, 32 — Operations Consultant")
- **Tools Used:** Microsoft Excel, PowerPoint, MS Word, Google Docs, Windows Settings.
- **Pain Point:** Gets stuck on complex Excel formulas, pivot tables, or buried Windows Settings menus.
- **How GuideLens Helps:** Explains what unfamiliar toolbar icons do in a single plain-English line and highlights the exact menu path to complete the task.

### Persona 3: The AI-First Builder / Indie Developer ("Alex, 24 — Indie Hacker & Vibe Coder")
- **Tools Used:** VS Code, GitHub Desktop, Windows Terminal, OpenCode, Antigravity, Claude Code, Codex.
- **Pain Point:** Uses AI coding agents daily, but still gets stuck in GUI tools or terminal workflows and hates switching back and forth between chat windows and the app.
- **How GuideLens Helps:** Connects directly to Alex's existing Claude Code / Antigravity / Codex subscription as a visual skill, and displays copy-ready terminal commands with plain-English explanations inside the floating bar.

---

## 4. Value Proposition
1. **Zero-Search, On-Screen Clarity:** Eliminates context switching to Google or YouTube by placing glowing step-by-step highlights and optional icon magnification directly over the live application.
2. **Multi-Brain Cost Freedom:**
   - **Bring Your Agent:** Connects to Claude Code, Antigravity, Hermes, or Codex if already installed.
   - **Zero-Cost Local Mode:** Lets free users download a lightweight local Vision-Language Model (VLM) so neither the user nor the founder pays cloud API fees.
   - **Pro Cloud Mode:** Offers an ultra-fast **Groq API**-powered cloud tier for instant reasoning and OCR accuracy without heavy local hardware requirements.
3. **Calm, Non-Intrusive UX:** No modal pop-ups or cluttered sidebars—just a compact, translucent dark-mode bar that waits quietly until summoned.

---

## 5. Priority Application Coverage (V1)
While universal AI screen reading works across any Windows application, V1 includes tuned prompt templates, shortcut knowledge, and UI-element heuristics for:
- **Creative & Media:** Adobe Photoshop, Adobe Premiere Pro, Adobe After Effects, Canva
- **Office & Productivity:** Microsoft Excel, Microsoft PowerPoint, Microsoft Word, Google Docs
- **Developer & CLI:** Visual Studio Code (VS Code), GitHub Desktop, Windows Terminal / CLI tools, OpenCode, Antigravity
- **System & Web:** Windows Settings, Google Chrome

---

## 6. Business Goals & Monetization
- **Business Model:** Freemium SaaS
  - **Free Tier:** Unlimited guidance using a downloaded local VLM or the user's own connected coding agent (Claude Code, Antigravity, Hermes, Codex) — **$0 marginal AI cost to the business**.
  - **Pro Tier ($15–$25/month or discounted annual):** Managed cloud intelligence powered by **Groq API** (ultra-fast reasoning + OCR), higher accuracy on dense UIs (After Effects, Premiere Pro), and priority updates.
- **V1 Launch Goal:** Ship a rock-solid, signed Windows installer with >90% button-highlight accuracy on the 15 priority applications and seamless local/Groq/agent routing.
- **V2 Expansion Goals:** macOS and Linux support, team/agency licensing, and custom workflow recording.
