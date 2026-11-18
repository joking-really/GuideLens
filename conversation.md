# Discovery Interview Transcript (`conversation.md`)

**Project:** On-Screen AI Desktop Copilot & Agent Visual Bridge  
**Session Date:** November 18, 2026  
**Format:** Adaptive Product & Architecture Discovery Interview (15 Core Questions + 5 Crucial Wrap-Up Questions)

---

## Phase 1: Core Vision, Target Audience & Value Proposition

### Question 1/50 — Primary Software Category
**Question:** What best describes the primary type of software you want to build?
- **A.** A subscription-based web app for businesses or professionals (B2B SaaS) `[Recommended]`
- **B.** A consumer-facing app or two-sided marketplace
- **C.** An internal tool or custom operations platform
- **D.** A content, community, or AI-powered utility tool

**Selected Answer:** **A** — Subscription-based software for businesses/professionals (SaaS).

---

### Question 2/50 — Primary Target Customer
**Question:** Who is your primary target customer for this application?
- **A.** Small businesses and startups (1–50 employees) `[Recommended]`
- **B.** Solo professionals, freelancers, or creators
- **C.** Mid-sized companies (50–500 employees)
- **D.** Large enterprises (500+ employees)

**Selected Answer:** **B** — Solo professionals, freelancers, or creators.

---

### Question 3/50 — Core Problem & Product Concept
**Question:** What is the main problem your software will help these solo professionals solve?
- **A.** Client management, proposals, invoicing, and project tracking `[Recommended]`
- **B.** Content creation, scheduling, and audience growth
- **C.** Time-saving AI automation and smart assistants
- **D.** Booking, appointments, and service delivery

**Selected Answer:** **Custom Product Vision (aligned with C):**  
An on-screen AI desktop assistant for Windows, Linux, and macOS that helps users operate any software they don't know how to use (e.g., asking *"What should I do to move the logo?"* or *"How do I remove a background in Photoshop?"*). The app tells them what to do, shows shortcuts, and visually zooms/magnifies or highlights the exact button to click.

---

### Question 4/50 — Primary Guidance Mode
**Question:** How should your software primarily guide the user when they ask for help?
- **A.** Step-by-step text instructions paired with live visual highlights on their screen `[Recommended]`
- **B.** Full AI autopilot that takes control of the mouse and keyboard
- **C.** Voice-guided coaching with visual highlights
- **D.** A side-by-side chat window with annotated screenshots

**Selected Answer:** **A** — Step-by-step text instructions paired with live visual highlights on their screen.

---

### Question 5/50 — Launch Operating System Scope
**Question:** You mentioned Windows, Linux, and Mac. Which operating systems should we target for your first public launch?
- **A.** Windows and macOS first, with Linux added right after `[Recommended]`
- **B.** All three (Windows, macOS, and Linux) simultaneously at launch
- **C.** Windows only for launch
- **D.** A browser-based screen-sharing web app first

**Selected Answer:** **C** — Windows only for V1 launch (fastest path to validate before expanding to macOS and Linux).

---

### Question 6/50 — Priority Desktop Applications
**Question:** Which desktop applications should your software be able to help with at launch?
- **A.** Any Windows app using AI screen reading, with extra-deep accuracy for top popular apps `[Recommended]`
- **B.** Creative and design software only
- **C.** Business and office software only
- **D.** Strictly universal AI vision with zero app-specific tuning

**Selected Answer:** **A** — Universal Windows app support, with extra-deep accuracy for the following priority applications:
- Adobe Photoshop
- Microsoft Excel
- Microsoft PowerPoint
- Google Docs
- Microsoft Word (MS Docs)
- Canva
- Adobe Premiere Pro
- Adobe After Effects
- Visual Studio Code (VS Code)
- GitHub Desktop
- Terminal-based software / CLI tools
- OpenCode
- Antigravity
- Windows Settings
- Google Chrome (key browser features)

---

### Question 7/50 — Monetization & Cost-Control Model
**Question:** Because AI screen reading has a small cost every time a user asks a question, how should you charge for the software?
- **A.** A free trial or limited free tier, plus a monthly/annual subscription with fair-use limits (Freemium) `[Recommended]`
- **B.** Paid subscription only from day one
- **C.** Pay-as-you-go credit packs
- **D.** Unlimited flat-rate monthly subscription

**Selected Answer:** **A (with Hybrid Local-First Modification):**  
Freemium model where users can download a lightweight local vision model (small VLM) to run screen reading on their own hardware at zero API cost to the founder, alongside a paid Pro subscription for cloud AI.

---

### Question 8/50 — Core Value Proposition
**Question:** What is the #1 promise that will convince someone to use your app instead of searching YouTube tutorials or asking ChatGPT?
- **A.** Instant, zero-search answers right on their live screen ("Never leave your app to search a tutorial again") `[Recommended]`
- **B.** Learning keyboard shortcuts and pro workflows faster
- **C.** Privacy-first, offline-capable guidance
- **D.** Plain-English translation of complex technical menus

**Selected Answer:** **A** — Instant, zero-search answers right on the user's live screen.

---

### Question 9/50 — V1 MVP Success Criteria
*(Focused on product & development per user preference)*  
**Question:** For your Version 1 (MVP) launch, what is the single most important thing the product must nail before you release it?
- **A.** Accurate button detection and clear 1-step-at-a-time visual highlights on the user's screen `[Recommended]`
- **B.** Ultra-fast response speed (under 2 seconds)
- **C.** Seamless offline local-model setup
- **D.** Deep, multi-step workflow memory

**Selected Answer:** **A** — Accurate button detection and clear 1-step-at-a-time visual highlights.

---

### Question 10/50 — Core Task & Explanation Behavior
**Question:** When a user opens your assistant inside an app like Photoshop or VS Code, what core job should it focus on first?
- **A.** Task guidance ("How do I do X?") with automatic step-by-step progression `[Recommended]`
- **B.** Screen explanation ("What does this button or error mean?")
- **C.** Shortcut & speed coaching
- **D.** Equal support for both task guidance and "what is this?" screen explanation from day one

**Selected Answer:** **A & B (Combined) with Minimalist UI:**  
Supports both task guidance and simple one-line explanations inside a clean, separate small text block—with zero intrusive pop-ups—waiting quietly until the user asks a question.

---

## Phase 2: Core Features, User Roles & User Flows

### Question 11/50 — Voice vs. Text Input
**Question:** Should your app be text-focused or voice-focused?
- **A.** Text-first with optional push-to-talk voice input `[Recommended]`
- **B.** Voice-first using voice commands as the main way to interact
- **C.** Text-only for Version 1 (no voice)
- **D.** Automatic voice-and-text mode

**Selected Answer:** **D** — Automatic voice-and-text mode (users can speak or type seamlessly).

---

### Question 12/50 — Summoning & Screen Presence
**Question:** While working inside an app like Photoshop, Excel, or a terminal, how should the user summon or keep your assistant on screen?
- **A.** A global keyboard shortcut (like `Ctrl + Space`) plus a small, draggable floating bar `[Recommended]`
- **B.** A slim docked side-panel pinned to the edge of the screen
- **C.** A wake-word voice trigger plus a system tray icon
- **D.** Automatically appears whenever a supported app is opened

**Selected Answer:** **A** — Global keyboard shortcut (`Ctrl + Space`) plus a small, draggable floating bar.

---

### Question 13/50 — Visual Highlight & Magnification Style
**Question:** When your app points out a button on the user's screen, how should the visual highlight look?
- **A.** A glowing colored box around the button with a small step-number badge, plus an optional zoom/magnifier toggle for tiny icons `[Recommended]`
- **B.** Always-on circular magnifier lens
- **C.** Spotlight dim mode
- **D.** Simple animated arrow pointing to the button

**Selected Answer:** **A** — Glowing colored box with a step-number badge and an optional zoom/magnifier toggle.

---

### Question 14/50 — Multi-Step Progression
**Question:** During a multi-step task, how should the assistant move to the next step?
- **A.** Smart auto-advance when the user clicks the highlighted area, with a manual "Next" button as backup `[Recommended]`
- **B.** Strictly manual "Next Step" button
- **C.** Show all steps at once in a numbered list
- **D.** Continuous live screen watching

**Selected Answer:** **A** — Smart auto-advance on click, with a manual "Next" button as backup.

---

### Question 15/50 — Terminal & CLI Guidance
**Question:** How should your assistant help inside terminal-based software (like OpenCode, Antigravity, and command-line tools) where there aren't buttons to highlight?
- **A.** Show the exact command in a one-click "Copy" box with a plain-English explanation of what it does `[Recommended]`
- **B.** Let the assistant type and run the terminal command automatically with a "Confirm & Run" button
- **C.** Highlight the terminal window and display text instructions only
- **D.** Skip terminal-specific features in Version 1

**Selected Answer:** **A** — Exact command in a one-click "Copy" box with a plain-English explanation.

---

## Phase 3: Crucial Wrap-Up Questions (Architecture, Data, Security & UI/Deployment)

### Crucial Question 1/5 — Desktop Framework, Local AI & Coding Agent Integration
**Question:** How should we build the desktop app to support Windows first (and Mac/Linux later), smooth overlays, and local AI?
- **A.** A lightweight cross-platform desktop app (Tauri + React) paired with a built-in local AI runner (Ollama or ONNX Runtime) `[Recommended]`
- **B.** A native Windows-only app (C# / WPF)
- **C.** Electron + Node.js desktop app
- **D.** A Python desktop app (PyQt / CustomTkinter)

**Selected Answer:** **A (with Agent-Skill & Groq Multi-Brain Extension):**  
- Tauri + React desktop app.
- Also callable as a **skill/tool for coding agents** (Claude Code, Antigravity, Hermes Agent, ChatGPT Codex, Google), similar to Vercel Labs' Agent Desktop—allowing existing user agents to drive the visual guide.
- Fallback to downloaded local LLMs/VLMs if the user lacks those agents, or the user's paid Pro subscription powered by the **Groq API** for fast reasoning and OCR.

---

### Crucial Question 2/5 — Cloud Backend, Accounts & Billing
**Question:** For users who choose your Pro subscription (using your Groq API backend) or want to sync their settings, how should accounts, payments, and API calls be managed?
- **A.** A lightweight cloud backend (Next.js / FastAPI) with Supabase for logins and Stripe for subscriptions `[Recommended]`
- **B.** Serverless edge functions (Cloudflare Workers) + Lemon Squeezy
- **C.** No user accounts at all—license keys only
- **D.** Fully local-only with no cloud backend in V1

**Selected Answer:** **A** — Lightweight cloud backend (Next.js / FastAPI) with Supabase for authentication and Stripe for subscription billing, proxying Pro requests to the Groq API.

---

### Crucial Question 3/5 — Database Structure & Data Privacy
**Question:** Where should the app store the user's question history, custom app shortcuts, and screen captures?
- **A.** Local-first storage (SQLite on the user's PC) for history and screenshots, with only account, subscription, and usage counts in the cloud (Supabase) `[Recommended]`
- **B.** Sync everything to the cloud (Supabase)
- **C.** Ephemeral / zero-history mode
- **D.** Exportable local JSON/Markdown files only

**Selected Answer:** **A** — Local-first SQLite on the user's PC for history/screenshots; Supabase PostgreSQL for account, subscription, and usage counts.

---

### Crucial Question 4/5 — Security & Screen Privacy
**Question:** Because your app reads the user's screen, how should we protect sensitive screen data?
- **A.** Capture only the active target window, auto-pause on password managers/incognito windows, and let users blur/exclude specific apps `[Recommended]`
- **B.** Run an on-device text/secret scanner before sending any screenshot to the cloud
- **C.** Ask the user to click "Approve Screenshot" before every cloud request
- **D.** Standard full-screen capture with a clear privacy disclaimer

**Selected Answer:** **D** — Standard full-screen capture with a clear privacy disclaimer for V1 speed-to-market.

---

### Crucial Question 5/5 — UI Theme & Deployment
**Question:** What visual style should the floating assistant bar use, and how should users install and update the Windows app?
- **A.** A sleek, translucent dark-mode floating bar (matching Windows 11) distributed via a standard signed Windows installer with automatic background updates `[Recommended]`
- **B.** An adaptive light/dark theme distributed via the Microsoft Store
- **C.** A high-contrast neon/cyberpunk overlay with a portable `.exe`
- **D.** A minimal white/clean glass card distributed via Winget and GitHub Releases only

**Selected Answer:** **A** — Sleek, translucent dark-mode floating bar (Windows 11 aesthetic) with a signed Windows installer and automatic background updates.
