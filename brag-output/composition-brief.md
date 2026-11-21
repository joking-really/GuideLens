# Hyperframes Composition Brief: GuideLens

## Objective
Create a short, polished, shareable launch video for GuideLens.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 18.0 seconds

## Source Material
- Project root: `E:\GuideLens`
- Primary files read: `apps/desktop/src/index.css`, `apps/desktop/src/components/FloatingBar.tsx`, `apps/desktop/src/components/OverlayCanvas.tsx`, `README.md`, `architecture.md`
- Product name: GuideLens
- Tagline / strongest claim: "A voice-and-hotkey copilot that illuminates the exact button on any Windows desktop app."
- Key UI or visual moment to recreate:
  - The Floating Command Bar (`.gl-glass-bar`) with live voice indicator and Groq Pro VLM status badge.
  - The transparent screen spotlight overlay with neon cyan bounding box, target crosshairs, and step card tooltip.
  - The 3 architecture superpower cards (Local SQLite/UIA, Multi-Brain Router, Agent MCP Bridge).
- Copy that must appear verbatim:
  - "Still guessing which button to click?"
  - "Where is AutoSum in Excel?"
  - "Step 1/1: Click AutoSum (Alt+=)"
  - "Stop guessing. Start clicking."
  - "Native Windows AI Copilot"

## Creative Direction
- Tone preset: `polished`
- Creative direction: Sleek, futuristic Windows desktop copilot launch
- Interpretation: Confident, fast-paced product film with high-contrast dark glass visuals, crisp typographic holds, and energetic tech sound design.
- Angle: From asking "where is that button" to an illuminated spotlight overlay on your screen in under 800ms.
- Hook: Glowing `Ctrl + Shift + Space` shortcut badge expanding and dropping down the floating bar.
- Outro / punchline: "Stop guessing. Start clicking."

## Visual Identity
- Background: `#0B0F17` (deep slate navy) / surface: `rgba(24, 24, 28, 0.88)`
- Accent: `#38BDF8` (electric cyan) & `#FACC15` (high-contrast gold) & `#22C55E` (emerald success)
- Text: `#F4F4F5` (crisp white) & `#A1A1AA` (zinc-400)
- Display font: `Inter`, `Segoe UI Variable`, system-ui, sans-serif
- Body font: `JetBrains Mono`, `Cascadia Code`, monospace
- Visual references from the project: Floating Bar glass style, keyboard badges, neon overlay target box with corner brackets, step tooltip card.

## Storyboard
Use the storyboard in `brag-output/brag-plan.md` as the creative contract.

Scene summary:
1. Scene 1: The Hook (0.0s – 3.0s) — "Still guessing which button to click?" + `Ctrl+Shift+Space` slam + glass bar drop.
2. Scene 2: The Floating Bar & Groq VLM (3.0s – 7.5s) — Voice waveform + simulated typing "Where is AutoSum in Excel?" + instant Groq Pro badge.
3. Scene 3: The Spotlight Overlay (7.5s – 12.0s) — Screen spotlight vignette + target bounding box lock + step card + simulated click and checkmark auto-advance.
4. Scene 4: Architecture Superpowers (12.0s – 15.5s) — 3 cascading glass capability pills aligned to the 120 BPM beat grid.
5. Scene 5: Outro & Logo Lockup (15.5s – 18.0s) — Glowing GuideLens prism icon, title, punchline, and Windows Tauri subtitle.

## Audio
- Audio role: Warm upbeat tech groove with crisp motion-matched UI accents
- Music: `assets/music/happy-beats-business-moves-vol-1-by-ende-dot-app.mp3`
- Music treatment: Low synth bed intro (0-3s), beat drop at 3.0s, steady 120 BPM driving groove, smooth duck under final logo hit at 17.5s.
- Music cue guidance: Preset cue file read (`120.19 BPM`); beat grid every ~0.50s; major reveal locks at 3.0s (beat drop), 7.5s (spotlight lock), 12.0s (feature cards), and 15.5s (logo lockup).
- Audio-coupled moments:
  - 0.8s: Shortcut slam / impact
  - 3.0s: Glass drop whoosh
  - 4.0s-5.0s: Keyboard typing ticks
  - 7.5s: Target lock ping
  - 10.5s: Mouse click + auto-advance success chime
  - 12.2s, 12.8s, 13.4s: Feature card swooshes
  - 15.5s: Sub-bass impact / logo lock
- SFX choice: Copied from `<skill-dir>/assets/sfx/` into `composition/assets/sfx/`.
- Audio files:
  - Music: `composition/assets/music/track.mp3`
  - SFX: `composition/assets/sfx/*.ogg`

## Hyperframes Instructions
- Show real UI components inspired by GuideLens React code.
- Ensure all text passes WCAG contrast and readability floors.
- Use native GSAP timelines and Hyperframes `data-*` attributes.
- Pass `npx hyperframes check` with zero errors.
