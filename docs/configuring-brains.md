# Configuring GuideLens Brains

GuideLens supports five interchangeable reasoning & vision backends (`BrainKind`), selectable globally or per-application (`app_preferences`):

1. **`local_vlm`** — Local Ollama vision models (`qwen2.5vl:3b` default, `qwen2.5vl:7b`, `llama3.2-vision`)
2. **`byo_api`** — Bring-Your-Own API keys (`Gemini`, `OpenAI`, `Anthropic`, `Groq`, `OpenRouter`) stored securely in Windows Credential Manager
3. **`agent_cli`** — Headless local coding/desktop agent CLIs (`Claude Code`, `Codex`, `Gemini CLI`, `Antigravity`, `Hermes`)
4. **`agent_mcp`** — External agent driving GuideLens via `guidelens-mcp`
5. **`groq_pro`** — Managed GuideLens Cloud Pro proxy backed by high-speed Groq vision inference

When `brain_mode` is set to **`auto`**, GuideLens routes in priority order:
`Connected Agent CLI (if selected) -> BYO API Key (if configured) -> Groq Pro (if logged into Pro) -> Local Ollama VLM`.

---

## 1. Local VLM via Ollama (`local_vlm`)

Local VLM mode runs 100% offline on your machine at `http://127.0.0.1:11434`.

### Setup
1. Install Ollama for Windows from [https://ollama.com/download/windows](https://ollama.com/download/windows) (or click the **Install Ollama** link in GuideLens Settings -> Brains -> Local VLM).
2. In GuideLens Settings, use the **1-Click Pull** button (or run in PowerShell):
   ```powershell
   # Recommended default (fast, ~2.5 GB VRAM/RAM)
   ollama pull qwen2.5vl:3b

   # Higher precision for dense UIs like After Effects / Excel (~5.5 GB VRAM/RAM)
   ollama pull qwen2.5vl:7b

   # Alternative vision model
   ollama pull llama3.2-vision
   ```
3. GuideLens streams pull progress via the `ollama-pull-progress` event and automatically verifies readiness with `ollama_status()`.

---

## 2. Bring-Your-Own API Keys (`byo_api` — Free Tier)

Use cloud vision models without using local GPU/RAM or a Pro subscription by supplying your own API key.

### Security Guarantee
- Keys are stored **exclusively** in **Windows Credential Manager** via the Rust `keyring` crate (`windows-native` backend) under service `com.guidelens.desktop`.
- Keys are **never** written to SQLite, plain-text config files, logs, or frontend JavaScript storage.

### Supported Providers & Default Vision Models
| Provider ID | Provider Name | Default Vision Model |
|---|---|---|
| `gemini` | Google Gemini API | `gemini-2.5-flash` |
| `openai` | OpenAI API | `gpt-4o` / `gpt-4o-mini` |
| `anthropic` | Anthropic API | `claude-3-5-sonnet-latest` |
| `groq` | Groq Cloud API | `meta-llama/llama-4-scout-17b-16e-instruct` |
| `openrouter` | OpenRouter | `qwen/qwen2.5-vl-72b-instruct` |

### Configuring in UI or via Tauri IPC
Open **Settings -> Brains -> BYO API Keys**, select a provider, paste your key, and click **Save to Windows Credential Manager** (calls `set_api_key(provider, key)`). Use **Remove** (`delete_api_key(provider)`) at any time.

---

## 3. Local Agent CLIs (`agent_cli`)

GuideLens automatically detects installed agent CLIs on your Windows `PATH` (`detect_agents()`) and can invoke them headlessly as its brain—passing the captured screenshot path, active window title, and prompt, and parsing a `StepPlan` JSON response.

| Agent ID | CLI Binary | Headless Invocation |
|---|---|---|
| `claude` | `claude` | `claude -p "<prompt + screenshot_path>" --output-format json` |
| `codex` | `codex` | `codex exec "<prompt + screenshot_path>"` |
| `gemini` | `gemini` | `gemini -p "<prompt + screenshot_path>"` |
| `agy` | `agy` | `agy -p "<prompt + screenshot_path>"` |
| `hermes` | `hermes` | `hermes -p "<prompt + screenshot_path>"` |

---

## 4. Hybrid Windows UI Automation (UIA) Target Snapping

Regardless of which brain produces the `StepPlan`, GuideLens runs a **Hybrid Target Locator** (`apps/desktop/src-tauri/src/locator/`):
1. The brain returns a `StepPlan` containing an optional normalized `bbox` (`0–1000`) plus `target_name` (e.g. `"Object Selection Tool"`) and `control_type` (e.g. `"Button"`).
2. The Rust locator queries the live **Windows UI Automation (UIA)** accessibility tree of the active window and fuzzy-matches (`strsim`) the target control's name and control type.
3. If a high-confidence UIA match is found, GuideLens snaps the highlight box to the control's exact physical screen rectangle (`source: "uia"`).
4. Otherwise, if the brain's visual `bbox` has `confidence >= 0.5`, GuideLens converts the normalized `0–1000` bbox into DPI-aware physical virtual-desktop pixels (`source: "vlm"`).
5. If confidence is `< 0.5` and no UIA control matches, GuideLens degrades gracefully to **text-only guidance** (`rect_px: null, source: "none"`) rather than drawing a misleading box.
