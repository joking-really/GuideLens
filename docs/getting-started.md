# Getting Started with GuideLens on Windows 10/11

GuideLens is a Windows AI on-screen desktop copilot built with **Tauri v2 (Rust)**, **React 18 + TypeScript + Tailwind CSS**, **SQLite (WAL)**, and a multi-brain router supporting local Ollama VLMs, BYO API keys, agent CLIs, MCP integration, and the Groq Cloud Pro backend.

---

## 1. Prerequisites (Windows 10 / 11 x64)

### 1.1 Install Rust (`stable-x86_64-pc-windows-msvc`) & VS 2022 C++ Build Tools
Run the following commands in PowerShell:

```powershell
# Install rustup and configure the MSVC toolchain
winget install --id Rustlang.Rustup -e --accept-package-agreements --accept-source-agreements
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
rustup default stable-x86_64-pc-windows-msvc
rustup component add clippy rustfmt

# Install Visual Studio 2022 Build Tools with C++ Desktop workload + Windows 10/11 SDK
winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
  --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

### 1.2 Install Node.js 20+ & Python 3.12+
```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Python.Python.3.12 -e
```

> **Note:** Microsoft Edge WebView2 Runtime is pre-installed on Windows 11 and up-to-date Windows 10 systems.

---

## 2. Clone & Install Dependencies

```powershell
cd E:\GuideLens

# 1. Desktop app (Tauri v2 + React/TS)
cd apps\desktop
npm install

# 2. Local MCP Server & CLI bridge
cd ..\..\packages\guidelens-mcp
npm install
npm run build
```

---

## 3. Running GuideLens in Development Mode

From `apps/desktop`:

```powershell
cd E:\GuideLens\apps\desktop
npm run tauri dev
```

### What happens on startup:
1. **SQLite WAL database** is initialized at `%LOCALAPPDATA%\GuideLens\guidelens.db` (with automatic pre-migration backups and 7-day screenshot capture pruning).
2. **Local Bridge HTTP Server** starts on `127.0.0.1:47615` (or the next free localhost port) and writes `%LOCALAPPDATA%\GuideLens\bridge.json` with a random 32-byte bearer token for `guidelens-mcp`.
3. **Global Hotkey (`Ctrl + Space`)** is registered. Press `Ctrl + Space` at any time to summon or hide the floating 480×52 GuideLens command bar.
4. **Click-Through Overlay Window** spans the virtual desktop (`WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`), rendering glowing bounding boxes, step badges, and an optional 2.5× magnifier lens without stealing focus from your active application.
5. **Smart Auto-Advance & Escape**: Left-clicking inside the highlighted target control automatically advances to the next step; pressing `Esc` immediately clears the overlay and releases mouse hooks.

---

## 4. Building & Running Tests

### Desktop Rust Backend (`apps/desktop/src-tauri`)
```powershell
cd E:\GuideLens\apps\desktop\src-tauri
cargo clippy --all-targets -- -D warnings
cargo test
```

### Desktop React Frontend (`apps/desktop`)
```powershell
cd E:\GuideLens\apps\desktop
npx tsc --noEmit
npx vitest run
npm run build
```

### Production Windows Installer (`.exe` NSIS + `.msi`)
```powershell
cd E:\GuideLens\apps\desktop
npm run tauri build
```
Installers are emitted under `apps/desktop/src-tauri/target/release/bundle/`.
