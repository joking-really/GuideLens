# Setting Up `guidelens-mcp` (MCP Server & CLI Bridge)

`packages/guidelens-mcp` exposes GuideLens's screen capture and visual overlay engine to external AI agents (**Claude Code**, **Antigravity (`agy`)**, **Hermes Agent**, and **ChatGPT Codex**) via both the **Model Context Protocol (MCP)** over `stdio` and a standalone command-line tool (`guidelens`).

---

## 1. How the Local Bridge Works (`decisions.md` §5)

1. When the GuideLens desktop app starts, its Rust bridge server binds strictly to **`127.0.0.1:47615`** (or the next free localhost port—never `0.0.0.0`).
2. GuideLens writes `%LOCALAPPDATA%\GuideLens\bridge.json`:
   ```json
   {
     "port": 47615,
     "token": "<random-32-byte-hex-secret>",
     "pid": 18420
   }
   ```
3. `guidelens-mcp` reads `%LOCALAPPDATA%\GuideLens\bridge.json` (overridable via `GUIDELENS_BRIDGE_FILE` or `--bridge-file <path>`) and attaches `Authorization: Bearer <token>` on every HTTP request.

---

## 2. Building `guidelens-mcp`

```powershell
cd E:\GuideLens\packages\guidelens-mcp
npm install
npm run build
npm test
```

The package emits two executable entrypoints (`package.json` `bin`):
- `guidelens` (`dist/cli.js`) — full CLI + `mcp` subcommand + `install` config generator
- `guidelens-mcp` (`dist/mcp-bin.js`) — starts the stdio MCP server when run with no arguments (or forwards subcommands to `cli.js`)

---

## 3. MCP Tools Exposed

| Tool Name | Bridge Endpoint | Arguments | Description |
|---|---|---|---|
| `capture_screen` | `POST /v1/capture` | `{}` | Captures the active monitor as JPEG (`image_path`, `image_base64`, `active_app`, `window_title`, `monitor: {x,y,w,h,scale}`). |
| `highlight` | `POST /v1/highlight` | `{ x, y, width, height, coords?: "normalized"\|"pixels", step_label, instruction_text, magnify?: boolean }` | Renders a glowing bounding box, step badge, and optional 2.5× magnifier lens on the click-through overlay in `< 200 ms`. |
| `show_command` | `POST /v1/show_command` | `{ command: string, explanation: string }` | Displays a one-click **Copy** terminal command box in the GuideLens floating bar. |
| `guide` | `POST /v1/guide` | `{ plan: StepPlan }` | Sends a complete multi-step `StepPlan` to GuideLens with smart click auto-advance. |
| `clear` | `POST /v1/clear` | `{}` | Clears all active overlay boxes, magnifiers, and terminal command cards. |

---

## 4. Registering with Agents

You can either use the built-in config installer (`node E:/GuideLens/packages/guidelens-mcp/dist/cli.js install <agent> --write`, where `<agent>` is `claude | codex | gemini | antigravity | hermes`), or configure each agent manually using `dist/mcp-bin.js` (or `dist/cli.js mcp`):

### Claude Code (`~/.claude.json` or `.mcp.json`)
```json
{
  "mcpServers": {
    "guidelens": {
      "command": "node",
      "args": ["E:/GuideLens/packages/guidelens-mcp/dist/mcp-bin.js"]
    }
  }
}
```
Or via the Claude CLI:
```powershell
claude mcp add guidelens -- node E:/GuideLens/packages/guidelens-mcp/dist/mcp-bin.js
```

### Antigravity (`~/.gemini/antigravity/mcp_config.json`) & Gemini CLI (`~/.gemini/settings.json`)
```json
{
  "mcpServers": {
    "guidelens": {
      "command": "node",
      "args": ["E:/GuideLens/packages/guidelens-mcp/dist/mcp-bin.js"]
    }
  }
}
```

### Codex (`~/.codex/config.toml`)
```toml
[mcp_servers.guidelens]
command = "node"
args = ["E:/GuideLens/packages/guidelens-mcp/dist/mcp-bin.js"]
```

### Hermes Agent (`~/.hermes/mcp.json`)
```json
{
  "mcpServers": {
    "guidelens": {
      "command": "node",
      "args": ["E:/GuideLens/packages/guidelens-mcp/dist/mcp-bin.js"]
    }
  }
}
```

> If `guidelens-mcp` is installed globally (`npm link` / `npm install -g`), `"command": "guidelens"`, `"args": ["mcp"]` (which `guidelens install` outputs by default) can be used in place of `node .../dist/mcp-bin.js`.

---

## 5. Standalone CLI Usage

`dist/cli.js` (also exposed as `guidelens`) supports `capture`, `highlight`, `command`, `guide`, `clear`, `mcp`, and `install`:

```powershell
# Capture active monitor metadata + optional JPEG output file
node packages/guidelens-mcp/dist/cli.js capture --out capture.jpg

# Highlight a target box in normalized 0-1000 coordinates
node packages/guidelens-mcp/dist/cli.js highlight `
  --x 12 --y 185 --width 28 --height 32 `
  --coords normalized `
  --step-label "1" `
  --instruction-text "Click the Object Selection Tool in the left toolbar, or press W." `
  --magnify

# Show a one-click Copy terminal command
node packages/guidelens-mcp/dist/cli.js command `
  "git rebase -i HEAD~3" `
  "Interactively squash or reorder the last 3 commits."

# Send a complete multi-step StepPlan JSON file (auto-advance enabled)
node packages/guidelens-mcp/dist/cli.js guide ./plan.json

# Clear the overlay
node packages/guidelens-mcp/dist/cli.js clear

# Start the stdio MCP server explicitly
node packages/guidelens-mcp/dist/cli.js mcp

# Print or write MCP config for a supported agent (claude|codex|gemini|antigravity|hermes)
node packages/guidelens-mcp/dist/cli.js install claude --write
```
