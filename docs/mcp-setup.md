# Setting Up `guidelens-mcp` (MCP Server & CLI Bridge)

`packages/guidelens-mcp` exposes GuideLens's screen capture and visual overlay engine to external AI agents (**Claude Code**, **Antigravity (`agy`)**, **Hermes Agent**, and **ChatGPT Codex**) via both the **Model Context Protocol (MCP)** over `stdio` and a standalone command-line tool (`guidelens-mcp`).

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
3. `guidelens-mcp` reads `%LOCALAPPDATA%\GuideLens\bridge.json` (or `GUIDELENS_BRIDGE_FILE` / `GUIDELENS_BRIDGE_PORT` + `GUIDELENS_BRIDGE_TOKEN`) and attaches `Authorization: Bearer <token>` on every HTTP request.

---

## 2. Building `guidelens-mcp`

```powershell
cd E:\GuideLens\packages\guidelens-mcp
npm install
npm run build
npm test
```

---

## 3. MCP Tools Exposed

| Tool Name | Bridge Endpoint | Arguments | Description |
|---|---|---|---|
| `capture_screen` | `POST /v1/capture` | `{}` | Captures the active monitor as JPEG (`image_path`, `image_base64`, `active_app`, `window_title`, `monitor: {x,y,w,h,scale}`). |
| `highlight` | `POST /v1/highlight` | `{ x, y, width, height, coords?: "normalized"\|"pixels", step_label?: string, instruction_text: string, magnify?: boolean }` | Renders a glowing bounding box, step badge, and optional 2.5× magnifier lens on the click-through overlay in `< 200 ms`. |
| `show_command` | `POST /v1/show_command` | `{ command: string, explanation: string }` | Displays a one-click **Copy** terminal command box in the GuideLens floating bar. |
| `guide` | `POST /v1/guide` | `{ plan: StepPlan }` | Sends a complete multi-step `StepPlan` to GuideLens with smart click auto-advance. |
| `clear` | `POST /v1/clear` | `{}` | Clears all active overlay boxes, magnifiers, and terminal command cards. |

---

## 4. Registering with Agents

### Claude Code (`~/.claude.json` or `.mcp.json`)
```json
{
  "mcpServers": {
    "guidelens": {
      "command": "node",
      "args": ["E:/GuideLens/packages/guidelens-mcp/dist/index.js"]
    }
  }
}
```
Or via the Claude CLI:
```powershell
claude mcp add guidelens -- node E:/GuideLens/packages/guidelens-mcp/dist/index.js
```

### Antigravity (`agy`) / Gemini CLI (`settings.json` / `mcp_config.json`)
```json
{
  "mcpServers": {
    "guidelens": {
      "command": "node",
      "args": ["E:/GuideLens/packages/guidelens-mcp/dist/index.js"]
    }
  }
}
```

### Codex (`~/.codex/config.toml`)
```toml
[mcp_servers.guidelens]
command = "node"
args = ["E:/GuideLens/packages/guidelens-mcp/dist/index.js"]
```

### Hermes Agent
Add `guidelens` to your Hermes MCP configuration pointing to `node E:/GuideLens/packages/guidelens-mcp/dist/index.js`.

---

## 5. Standalone CLI Usage

Agents or shell scripts can also invoke `guidelens-mcp` directly as a CLI:

```powershell
# Check desktop bridge health
node packages/guidelens-mcp/dist/cli.js health

# Capture active monitor metadata + screenshot path
node packages/guidelens-mcp/dist/cli.js capture

# Highlight a target box in normalized 0-1000 coordinates
node packages/guidelens-mcp/dist/cli.js highlight `
  --x 12 --y 185 --width 28 --height 32 `
  --coords normalized `
  --label "1" `
  --text "Click the Object Selection Tool in the left toolbar, or press W." `
  --magnify

# Show a one-click Copy terminal command
node packages/guidelens-mcp/dist/cli.js show-command `
  --command "git rebase -i HEAD~3" `
  --explanation "Interactively squash or reorder the last 3 commits."

# Clear the overlay
node packages/guidelens-mcp/dist/cli.js clear
```
