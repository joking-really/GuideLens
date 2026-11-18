# Product & UI/UX Design Specification (`product-design.md`)

## 1. Design Philosophy
- **Invisible Until Needed:** The assistant must never block the user's canvas, timeline, or code editor. No modal pop-ups, no full-screen takeovers.
- **Single-Line Clarity:** Every response leads with a concise, plain-English single-line explanation or instruction inside a compact text block.
- **Windows 11 Native Aesthetic:** Sleek, translucent dark-mode glassmorphic floating bar (`mica`/`acrylic` feel) that blends naturally into dark-themed creative and developer tools (Photoshop, Premiere Pro, After Effects, VS Code, Terminal).

---

## 2. Design System Recommendations

### Color Palette (Dark Mode Default)
- **Floating Bar Surface:** `rgba(24, 24, 28, 0.86)` with `backdrop-filter: blur(20px)` and `1px solid rgba(255, 255, 255, 0.12)` border.
- **Primary Text:** `#F4F4F5` (high-contrast off-white for effortless scanning).
- **Secondary / Hint Text:** `#A1A1AA` (muted zinc gray for shortcuts and status).
- **Highlight Box Accent:** `#38BDF8` (electric cyan) or `#818CF8` (indigo glow) with a subtle pulse animation so it stands out against both dark and light app backgrounds.
- **Step Badge:** `#0F172A` text on `#38BDF8` pill badge (`Step 1 of 4`).
- **Terminal Command Box:** `#09090B` background with `#22C55E` (emerald) copy-confirmation state.

### Typography
- **UI & Instructions:** `Segoe UI Variable` / `Inter` (13px–14px body, 12px micro-labels).
- **Keyboard Shortcuts & Terminal Commands:** `JetBrains Mono` / `Cascadia Code` (12.5px monospace).

---

## 3. Core Component Wireframe Descriptions

### A. The Floating Command Bar (Compact State)
- **Dimensions:** ~480px wide × 52px tall, draggable anywhere on screen; remembers last position.
- **Layout (Left to Right):**
  1. **Brain Mode Pill:** Tiny clickable indicator (`Local` | `Groq Pro` | `Agent: Claude`).
  2. **Input Field:** *"Ask how to do anything or what's on screen..."* (accepts typing immediately on `Ctrl + Space`).
  3. **Auto Voice Indicator:** Subtle pulsing mic icon (supports continuous/automatic voice-and-text input with a quick mute toggle).
  4. **Settings / History Icon:** Compact gear icon to open local SQLite history, model downloader, or account login.

### B. The Compact Response Block (Expanded State)
- **Behavior:** Expands smoothly downward from the floating bar (max width 480px) without stealing focus from the target app.
- **Contents:**
  - **1-Line Instruction / Explanation:** Bold, plain-English single sentence (e.g., *"Click the Object Selection Tool in the left toolbar, or press `W`."*).
  - **Action Controls:** `[Magnify Button]` toggle | `[Step 1/3]` | `[Next →]` backup button | `[Close / Done]`.
  - **Terminal Variant:** When a terminal/CLI window is active, displays a compact code block with the exact command, a one-click `[Copy]` button, and a 1-line plain-English explanation underneath.

### C. The Transparent Click-Through Screen Overlay
- **Behavior:** Full-screen transparent window (`WS_EX_TRANSPARENT` / click-through on Windows) layered above all other apps.
- **Visual Elements:**
  - **Glowing Bounding Box:** Drawn around the exact `[x, y, width, height]` coordinates of the target UI button.
  - **Step Badge:** Small numbered pill anchored to the top-left corner of the glowing box.
  - **Optional Magnifier Lens:** When toggled on (or for icons smaller than 24×24px), renders a 2.5× zoomed circular preview of the target button slightly offset from the cursor so the user can see tiny Photoshop/After Effects icons clearly without blocking the click.

---

## 4. Key User Flows

### Flow 1: Guided Task ("How do I remove a background in Photoshop?")
1. User is in Adobe Photoshop and presses `Ctrl + Space` (or speaks directly if voice mode is active).
2. Floating bar captures the screen and sends the image + query to the active brain (External Agent, Local VLM, or Groq Cloud).
3. Response returns Step 1 text + target button coordinates.
4. Floating bar displays the 1-line instruction; transparent overlay draws the glowing box + Step 1 badge over the target icon.
5. User clicks the highlighted area -> **Smart Auto-Advance** detects the click inside the bounding box, waits briefly for UI update, and automatically advances to Step 2 (or user clicks `Next →`).
6. Upon final step completion, overlay clears cleanly and bar returns to quiet standby.

### Flow 2: Screen Explanation ("What does this error/icon mean?")
1. User hovers or looks at a confusing menu/error in VS Code, Excel, or Windows Settings and asks *"What does this mean?"*
2. Floating bar displays a single-line plain-English explanation without intrusive pop-ups.

### Flow 3: Terminal / CLI Assistance (OpenCode, Antigravity, Git)
1. User is in Windows Terminal or VS Code integrated terminal and asks *"How do I undo my last git commit without losing code?"*
2. App detects terminal context and renders a one-click Copy box: `git reset --soft HEAD~1` with a 1-line explanation: *"Moves your branch back one commit while keeping all your edited files staged."*

### Flow 4: Coding Agent Skill Invocation
1. User types in Claude Code or Antigravity: *"Use GuideLens to show me where the export settings are in Premiere Pro."*
2. The coding agent calls GuideLens's local MCP/CLI bridge -> GuideLens captures the screen, passes context to the agent (or processes locally), and renders the glowing box on the user's live Premiere Pro window.

---

## 5. Accessibility Standards
- **Keyboard-First Navigation:** `Ctrl + Space` to summon/dismiss, `Tab` / `Enter` for manual step advance, `Esc` to clear all overlays immediately.
- **High-Contrast Mode:** Optional high-contrast border (`#FACC15` yellow) for users with color-vision deficiency.
- **Screen-Reader Support:** Floating bar controls labeled with standard ARIA attributes; text instructions readable by Windows Narrator/NVDA.
- **Privacy Notice Banner:** Clear first-run privacy disclaimer reminding users that full-screen captures are used when cloud/agent modes are active.
