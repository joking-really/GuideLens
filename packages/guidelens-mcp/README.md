# `guidelens-mcp` — GuideLens MCP Server & CLI Bridge

`guidelens-mcp` connects external AI coding agents (**Claude Code, OpenAI Codex CLI, Gemini CLI, Google Antigravity, and Hermes Agent**) to the **GuideLens** Windows desktop copilot over its authenticated localhost bridge (`127.0.0.1`).

It provides:
1. A **stdio Model Context Protocol (MCP) server** exposing `capture_screen`, `highlight`, `show_command`, `guide`, and `clear`.
2. A **`guidelens` CLI** for command-line automation, headless skill scripts, and one-command MCP agent setup.
3. An **Agent Skill definition** at [`skills/guidelens/SKILL.md`](./skills/guidelens/SKILL.md).

---

## Prerequisites

- **Node.js 20+**
- **GuideLens Desktop App** running on Windows 10/11 (writes `%LOCALAPPDATA%\GuideLens\bridge.json` containing the localhost port and 32-byte hex Bearer token).

If the GuideLens desktop app is not running, all MCP tools and CLI commands fail fast with:
> `GuideLens desktop app is not running (...). Start GuideLens first.`

---

## Installation & Build

```bash
cd packages/guidelens-mcp
npm install
npm run build
```

---

## CLI Usage (`guidelens`)

```bash
# Capture active monitor screenshot + active window metadata
guidelens capture
guidelens capture --out ./screen.jpg

# Highlight a target UI control (normalized 0-1000 coords by default)
guidelens highlight 18 240 28 28 "Step 1 of 3" "Click the Object Selection Tool, or press W." --magnify

# Highlight using physical pixel coordinates
guidelens highlight 45 600 72 72 "Step 1" "Click the Export button." --coords pixels

# Show a one-click copyable terminal command in the floating bar
guidelens command "git reset --soft HEAD~1" "Moves your branch back one commit while keeping edits staged."

# Run a multi-step StepPlan JSON file with smart auto-advance
guidelens guide ./plan.json

# Clear active screen overlays
guidelens clear

# Start the stdio MCP server
guidelens mcp

# Print or write MCP configuration for your coding agent
guidelens install <claude|codex|gemini|antigravity|hermes> [--write] [--config <path>]
```

---

## Agent MCP Configuration Snippets

You can print or automatically write any of the snippets below using `guidelens install <agent> [--write]`.

### 1. Claude Code (`~/.claude.json` or `.mcp.json`)

Run `guidelens install claude --write` or `claude mcp add guidelens -- guidelens mcp`, or add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "guidelens": {
      "command": "guidelens",
      "args": ["mcp"]
    }
  }
}
```

### 2. OpenAI Codex CLI (`~/.codex/config.toml`)

Run `guidelens install codex --write` or add to `~/.codex/config.toml`:

```toml
[mcp_servers.guidelens]
command = "guidelens"
args = ["mcp"]
```

### 3. Gemini CLI (`~/.gemini/settings.json`)

Run `guidelens install gemini --write` or add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "guidelens": {
      "command": "guidelens",
      "args": ["mcp"]
    }
  }
}
```

### 4. Google Antigravity (`~/.gemini/antigravity/mcp_config.json`)

Run `guidelens install antigravity --write` or add to `~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "guidelens": {
      "command": "guidelens",
      "args": ["mcp"]
    }
  }
}
```

### 5. Hermes Agent (`~/.hermes/mcp.json`)

Run `guidelens install hermes --write` or add to `~/.hermes/mcp.json`:

```json
{
  "mcpServers": {
    "guidelens": {
      "command": "guidelens",
      "args": ["mcp"]
    }
  }
}
```

---

## MCP Tools Exposed

| Tool | Bridge Endpoint | Description |
| :--- | :--- | :--- |
| `capture_screen` | `POST /v1/capture` | Returns the active monitor screenshot as MCP `image/jpeg` content plus JSON metadata (`image_path`, `active_app`, `window_title`, `monitor`). |
| `highlight` | `POST /v1/highlight` | Renders a glowing highlight box (`x`, `y`, `width`, `height`, `coords: "normalized" \| "pixels"`), `step_label`, `instruction_text` (`<=140` chars), and optional `magnify` lens. |
| `show_command` | `POST /v1/show_command` | Displays a one-click Copy terminal command box with a 1-line `explanation` (`<=140` chars). |
| `guide` | `POST /v1/guide` | Sends a full `StepPlan` (`mode`, `total_steps`, `steps`) with smart click auto-advance. |
| `clear` | `POST /v1/clear` | Dismisses all active overlays. |

---

## Security

- Reads `%LOCALAPPDATA%\GuideLens\bridge.json` (`{ port, token, pid }`) on each request.
- Connects exclusively to `http://127.0.0.1:<port>` with `Authorization: Bearer <token>`.
- Exposes MCP strictly over `stdio` so remote network devices cannot capture screenshots or draw on the screen.
