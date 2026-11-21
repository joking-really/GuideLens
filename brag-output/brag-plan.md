# Brag Plan: GuideLens

## What is this app?
GuideLens is a native Windows desktop AI copilot that doesn't just explain software—it illuminates the exact button on your screen using an intelligent spotlight overlay, powered by Groq API VLM and local UIA snapping.

## The angle
"Stop squinting at 20-minute tutorial videos to find one hidden button." GuideLens turns any Windows application into a self-guiding experience: press Ctrl+Shift+Space, ask a question, and an illuminated bounding-box spotlight locks directly onto your target.

## Hook (first 2-3 seconds)
"Lost in complex software?" Dark desktop background with subtle grid lines. A user typing frantically. Suddenly, `Ctrl + Shift + Space` slams into the frame in glowing gold, glass-blurring the desktop as the GuideLens Floating Command Bar descends with zero latency.

## Key moments (the middle)
- **Instant VLM Intelligence:** Floating Bar receives query `"Where is AutoSum in Excel?"` and instantly routes to Groq Pro Qwen 3.8-27B Vision (`⚡ 420ms`).
- **Target Spotlight Lock:** Transparent click-through overlay darkens the screen with a vignette and locks an electric cyan bounding box with crosshairs directly onto the ribbon button.
- **Smart Auto-Advance:** Simulated mouse click on the highlighted button triggers a ripple effect and an instant green checkmark auto-advancing the guidance step.
- **Local-First & Agent Native:** Rapid sequence showcasing SQLite WAL persistence, local Windows UIA snapping, and bi-directional Model Context Protocol (MCP) bridge for coding agents.

## Outro / punchline
"Stop guessing. Start clicking." The GuideLens glowing prism logo locks up with the tagline: "Native Windows AI Copilot · Powered by Rust & Tauri".

## User flow worth showing
Entry (Ctrl+Shift+Space summon) → Key Action (Speak/Type "Where is AutoSum?" + Groq VLM routing) → Result (Spotlight bounding box appears over Excel UI element, user clicks it, step completes).

## Tone
- Preset: `polished` (with cinematic tech energy)
- Creative direction: Sleek, futuristic Windows desktop copilot launch
- Interpretation: Confident, fast-paced product film with high-contrast dark glass visuals, crisp typographic holds, and energetic tech sound design.

## Format: landscape — 1920x1080
## Duration: 18.0 seconds

## Visual identity (from the project)
- Background: `#0B0F17` (deep slate navy) / `--gl-surface`: `rgba(24, 24, 28, 0.86)`
- Accent: `#38BDF8` (electric cyan) & `#FACC15` (high-contrast gold)
- Text: `#F4F4F5` (crisp white) & `#A1A1AA` (zinc-400)
- Display font: `Segoe UI Variable`, `Inter`, sans-serif
- Body font: `JetBrains Mono`, `Cascadia Code`, monospace
- Strongest visual element: Floating glass command bar with glowing border, and the transparent overlay spotlight with target crosshairs and step tooltip.

## Share copy (draft)
Meet GuideLens: the native Windows AI copilot that doesn't just explain software—it illuminates the exact button on your screen in real time.

## Audio direction
- Role: Warm upbeat tech groove with crisp motion-matched UI accents
- Music: `happy-beats-business-moves-vol-1-by-ende-dot-app.mp3`
- Music treatment: Low synth bed intro, energetic beat drop at 3.0s, steady 120 BPM driving groove, smooth duck under final logo hit at 17.5s.
- Music cue guidance: Preset cue file read (`120.19 BPM`); beat grid every ~0.50s; major reveal locks at 3.0s (beat drop), 7.5s (spotlight lock), 12.0s (feature cards), and 15.5s (logo lockup).
- Audio-reactive treatment: Subtle glow and border pulse on the floating bar and spotlight box synchronized to music presence.
- SFX posture: Sparse to moderate, high-precision interface switches, keyboard ticks, and clean confirmation hits.
- Audio-coupled moments:
  - 0.8s: Keyboard clack / shortcut slam
  - 3.0s: Glass whoosh / bar drop
  - 4.2s: Soft typing ticks
  - 7.5s: Target lock chime / electronic sweep
  - 10.5s: Mouse click + success chime
  - 12.0s - 13.5s: 3 card slide whooshes
  - 15.5s: Bass impact / logo lock
- Restraint rule: No harsh buzzers, no cartoon pops; keep it strictly premium high-tech.

## Storyboard

### Scene 1 — The Hook (0.0s – 3.0s, 3.0s)
What's on screen: Dark workspace grid. Headline: "Still guessing which button to click?" In the center, a glowing keyboard badge `[Ctrl] + [Shift] + [Space]` expands with an electric gold aura.
Sequential/interaction: Badge pulses, desktop blurs, GuideLens bar appears.
Audio intent: Atmospheric tension breaking into momentum.
Audio-coupled idea: Heavy shortcut slam at 0.8s, rising synth riser up to 3.0s.
Music: Ambient opening before beat drop.
Transition mood: Snap cut / hard glow wipe → Scene 2

### Scene 2 — The Floating Bar & Groq VLM (3.0s – 7.5s, 4.5s)
What's on screen: GuideLens sleek glass floating bar anchored at the top. Microphone icon pulses with an active audio wave. Text rapidly types into the input: "Where is AutoSum in Excel?". A badge immediately flips to green: `⚡ Groq Pro · Qwen 3.8-27B Vision · 420ms`.
Sequential/interaction: Simulated typing + instant badge status change.
Audio intent: Energetic 120 BPM drum groove kicks in; typing sound effects.
Audio-coupled idea: Rapid typewriter ticks (4.0s-5.0s), positive status flip tick (5.6s).
Music: Full beat engaged.
Transition mood: Camera zoom-in into screen space → Scene 3

### Scene 3 — The Spotlight Overlay (7.5s – 12.0s, 4.5s)
What's on screen: The entire screen dims to 20% opacity with a circular spotlight cutout focusing on an Excel toolbar. A vibrant cyan bounding box animates onto the "AutoSum" button with glowing corner crosshairs. A glass step card floats nearby: `Step 1/1: Click AutoSum (Alt+=)`. A mouse cursor sweeps in, clicks the button, a subtle ripple shockwave emits, and a green badge displays `✓ Target Clicked · Auto-Advancing`.
Sequential/interaction: Spotlight reveals → Box bounds snap → Cursor moves and clicks → Checkmark confirmation.
Audio intent: High satisfaction, problem solved.
Audio-coupled idea: Target lock ping at 7.8s, crisp mouse click at 10.5s, auto-advance success chime at 10.8s.
Transition mood: Fast card slide → Scene 4

### Scene 4 — Architecture Superpowers (12.0s – 15.5s, 3.5s)
What's on screen: Three glass feature cards cascade into view on the 0.5s beat grid:
1. `🛡️ 100% Local-First SQLite & Windows UIA`
2. `🧠 Multi-Brain: Groq Pro · Local Ollama · BYO Keys`
3. `🔌 Native Agent MCP Bridge: Claude · Codex · Gemini`
Sequential/interaction: 3 cards slide up sequentially (12.2s, 12.8s, 13.4s).
Audio intent: Confident rhythmic build to climax.
Audio-coupled idea: Card slide whoosh / snap sound on each card arrival.
Transition mood: Iris focus wipe → Scene 5

### Scene 5 — Outro & Logo Lockup (15.5s – 18.0s, 2.5s)
What's on screen: GuideLens iridescent icon centers with glowing light rays. Large title: `GuideLens`. Punchline: `Stop guessing. Start clicking.` Subtitle: `Native Windows AI Copilot · Built with Rust & Tauri`.
Sequential/interaction: Logo flares in, text settles, URL / repo badge shines.
Audio intent: Resonant musical resolution with punchy logo impact.
Audio-coupled idea: Clean bass sub-hit on logo drop, music fade out to 18.0s.

**Music mood for this video:** Upbeat futuristic tech groove (120 BPM)
**Audio summary:** Ambient curiosity builds into a driving 120 BPM beat with tactile UI sounds, culminating in a crisp, confident tech outro.
