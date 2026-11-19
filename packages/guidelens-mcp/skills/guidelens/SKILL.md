---
name: guidelens
description: Visually guide the user step by step on their live Windows screen using GuideLens MCP tools (capture_screen, highlight, show_command, guide, clear) or the guidelens CLI.
---

# GuideLens On-Screen Visual Copilot Skill

Use GuideLens whenever the user asks how to locate a button, navigate a dense GUI (e.g., Photoshop, Premiere Pro, After Effects, Excel, PowerPoint, VS Code, Windows Settings, Chrome), or perform a step-by-step workflow on their screen.

GuideLens renders a **100% click-through glowing highlight box**, step badge, optional **2.5× circular magnifier lens**, and a **concise single-line instruction (`<= 140` characters)** directly over the user's live Windows application without stealing window focus.

---

## Core Agent Workflow: Capture → Reason → Highlight Step by Step

1. **Capture the Active Screen (`capture_screen`)**
   - Always begin by calling `capture_screen` (or `guidelens capture`) so you can see the exact state of the user's active monitor, foreground application (`active_app`), window title (`window_title`), and monitor DPI scaling (`monitor`).
   - Do not guess UI coordinates without capturing first.

2. **Reason & Locate Targets in Normalized `0–1000` Coordinates**
   - Inspect the captured JPEG screenshot and identify the exact UI control the user needs to interact with next.
   - Express every bounding box `[x, y, width, height]` in **normalized `0–1000` coordinates** relative to the captured monitor:
     - `(0, 0)` is the top-left corner of the captured monitor.
     - `(1000, 1000)` is the bottom-right corner of the captured monitor.
     - GuideLens automatically converts `0–1000` normalized coordinates to physical pixels across 100%–200% Windows DPI scaling and multi-monitor offsets.
   - Keep `instruction_text` / `instruction_line` to a **single plain-English sentence of at most 140 characters**, and include the keyboard shortcut when available (e.g., `"Click the Object Selection Tool in the left toolbar, or press W."`).

3. **Highlight Step by Step (`highlight` or `guide`)**
   - **Interactive step-by-step mode (`highlight`):**
     - Call `highlight` for the current step with `coords: "normalized"` (the default).
     - Set `magnify: true` when targeting small toolbar icons (`< 24×24px`) in dense apps like Photoshop, Premiere Pro, or After Effects.
     - After the user completes the action (or asks for the next step), call `capture_screen` again to verify the updated UI state before highlighting the next step.
   - **Full multi-step plan mode (`guide`):**
     - When all targets are visible or follow a predictable sequence, submit a complete `StepPlan` via `guide`. GuideLens's global mouse hook detects when the user left-clicks inside the active bounding box and automatically advances to Step `N + 1`.
   - **Terminal / CLI mode (`show_command`):**
     - When guiding the user in a terminal or command-line task, call `show_command(command, explanation)` to display a one-click `[Copy]` monospace command box with a 1-line plain-English explanation (`<= 140` chars).

4. **Clean Up (`clear`)**
   - Call `clear` when the workflow is complete or if the user asks to dismiss the overlay.

---

## MCP Tool Reference

### 1. `capture_screen`
Captures the active monitor screenshot and active window metadata.
- **Arguments:** `{}`
- **Returns:**
  - MCP `image` content (`image/jpeg`, base64-encoded screenshot)
  - MCP `text` content with JSON metadata:
    ```json
    {
      "image_path": "C:\\Users\\...\\AppData\\Local\\GuideLens\\captures\\capture_123.jpg",
      "active_app": "Photoshop.exe",
      "window_title": "Untitled-1 @ 100% (RGB/8)",
      "monitor": { "x": 0, "y": 0, "w": 2560, "h": 1440, "scale": 1.25 }
    }
    ```

### 2. `highlight`
Draws a glowing bounding box and 1-line instruction on the live Windows overlay.
- **Arguments:**
  ```json
  {
    "x": 18,
    "y": 240,
    "width": 28,
    "height": 28,
    "step_label": "Step 1 of 3",
    "instruction_text": "Click the Object Selection Tool in the left toolbar, or press W.",
    "magnify": true,
    "coords": "normalized"
  }
  ```

### 3. `show_command`
Renders a one-click copyable terminal command in the floating bar.
- **Arguments:**
  ```json
  {
    "command": "git reset --soft HEAD~1",
    "explanation": "Moves your branch back one commit while keeping all edited files staged."
  }
  ```

### 4. `guide`
Submits a full `StepPlan` with automatic click-to-advance.
- **Arguments:**
  ```json
  {
    "plan": {
      "mode": "guide",
      "total_steps": 2,
      "steps": [
        {
          "step_number": 1,
          "instruction_line": "Click File in the top menu bar, or press Alt+F.",
          "target_name": "File",
          "control_type": "MenuItem",
          "bbox": [12, 8, 32, 22],
          "confidence": 0.95,
          "shortcut": "Alt+F",
          "terminal_command": null,
          "explanation": null
        },
        {
          "step_number": 2,
          "instruction_line": "Click Export > Export As to open the export settings dialog.",
          "target_name": "Export As...",
          "control_type": "MenuItem",
          "bbox": [24, 185, 140, 26],
          "confidence": 0.9,
          "shortcut": "Alt+Shift+Ctrl+W",
          "terminal_command": null,
          "explanation": null
        }
      ]
    }
  }
  ```

### 5. `clear`
Dismisses any active overlay highlights and floating bar instructions.
- **Arguments:** `{}`

---

## Troubleshooting

- If any tool returns `"GuideLens desktop app is not running (...). Start GuideLens first."`, tell the user to launch the **GuideLens** desktop app so that `%LOCALAPPDATA%\GuideLens\bridge.json` is active on `127.0.0.1`.
