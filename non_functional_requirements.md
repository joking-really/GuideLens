# Non-Functional Requirements (`non-functional-requirements.md`)

## 1. Performance & Latency
- **App Footprint:** Desktop installer <25 MB; idle RAM usage <80 MB (excluding optional local VLM process) so it runs smoothly alongside Photoshop, Premiere Pro, and After Effects.
- **UI Summon Speed:** Global hotkey (`Ctrl + Space`) must focus the floating bar in **<100 ms**.
- **Screen Capture Speed:** Full-screen capture + JPEG/WebP compression must complete in **<80 ms** on standard 1080p/4K Windows displays.
- **Cloud Response Latency (Groq Pro):** End-to-end time from query submission to overlay highlight render **<2.0 seconds** (leveraging Groq's high-speed inference).
- **Local VLM Latency:** End-to-end highlight render **<4.5 seconds** on mid-range consumer hardware.

## 2. Availability & Uptime
- **Cloud Proxy & Auth:** **99.9% uptime** target for the Next.js/FastAPI proxy, Supabase Auth, and Stripe webhook endpoints.
- **Offline Resilience:** Because local VLM mode, local SQLite history, and local MCP agent bridge run entirely on the user's PC, core free-tier functionality must remain **100% operational offline** even if cloud services are unreachable.

## 3. Scalability & Load Handling
- **Stateless Cloud Proxy:** The Groq API proxy must be stateless and horizontally scalable (auto-scaling serverless functions or containers) to handle traffic spikes without bottlenecking.
- **Cost & Rate Protection:** Cloud Pro tier enforces per-user monthly and per-minute rate limits in Supabase/Redis to prevent runaway Groq API bills or abuse.

## 4. Fault Tolerance & Error Recovery
- **DPI & Multi-Monitor Safety:** Coordinate mapping must normalize AI bounding boxes (`0–1000` scale) to physical monitor coordinates, accounting for Windows DPI scaling (100%, 125%, 150%, 200%) and multi-monitor offsets.
- **Graceful Degradation:**
  - If Groq API times out or hits a rate limit, automatically offer a 1-click fallback to the user's local VLM or connected coding agent.
  - If the AI cannot confidently locate a button, display the 1-line text instruction in the floating bar without rendering a misleading highlight box.
- **Overlay Cleanup Guarantee:** Pressing `Esc` or closing the floating bar must immediately destroy all overlay windows and release global mouse hooks so the user's screen is never stuck.

## 5. Disaster Resilience & Updates
- **Silent Auto-Updates:** Tauri updater verifies cryptographic signatures on all updates; failed updates roll back cleanly to the previous working binary.
- **Local Data Safety:** SQLite runs in `WAL` (Write-Ahead Logging) mode to prevent database corruption during unexpected Windows shutdowns.
