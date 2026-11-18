# GuideLens Visual Accuracy Benchmark (`benchmarks/`)

Automated Intersection-over-Union (**IoU**) evaluation suite for verifying GuideLens bounding-box accuracy and `StepPlan` contract compliance across the 15 priority Windows desktop applications before every release.

## 1. Release Gate Criteria

Per `development.md` §3 and `decisions.md` §3, every release candidate must meet:

| Metric | Requirement |
|---|---|
| Per-Step Bounding-Box Accuracy | **IoU >= 0.50** between predicted `bbox` and ground-truth `expected.bbox` |
| Suite Pass Rate | **>= 90.0%** across all reference cases |
| Coordinate Space | Normalized **`0–1000`** `[x, y, width, height]` relative to the captured monitor |
| Single-Line UI Rule | `instruction_line` length **<= 140 characters** |
| Schema Compliance | Valid `StepPlan` JSON (`mode`, `total_steps`, `steps[]`) |

---

## 2. Directory Layout

```text
benchmarks/
├── README.md                 # This guide
├── schema.json               # JSON Schema (2020-12) for benchmark case definitions
├── run_benchmark.py          # Zero-dependency Python 3.11+ IoU evaluation runner
├── cases/
│   ├── 01_photoshop_object_selection.json
│   ├── 02_vscode_extensions_sidebar.json
│   ├── 03_excel_autosum_ribbon.json
│   └── images/               # Reference PNG/JPEG screenshots
└── tests/
    └── test_benchmark.py     # Unit tests for IoU math & StepPlan validation
```

---

## 3. Running the Benchmark

### Offline Schema & Self-Test (CI Mode)
Validates `schema.json`, checks all `benchmarks/cases/*.json` files and reference images, and evaluates deterministic mock predictions:
```bash
python benchmarks/run_benchmark.py --validate-only
python -m unittest discover -s benchmarks/tests -v
```

### Evaluate Local Ollama VLM (`qwen2.5vl:3b` / `qwen2.5vl:7b` / `llama3.2-vision`)
```bash
python benchmarks/run_benchmark.py \
  --brain ollama \
  --ollama-url http://127.0.0.1:11434 \
  --ollama-model qwen2.5vl:3b \
  --output benchmarks/results/ollama_qwen25vl_3b.json
```

### Evaluate GuideLens Cloud Proxy (Groq Pro Backend)
```bash
python benchmarks/run_benchmark.py \
  --brain cloud \
  --cloud-url http://127.0.0.1:8000 \
  --cloud-token "$SUPABASE_ACCESS_TOKEN" \
  --output benchmarks/results/cloud_groq.json
```

### Evaluate BYO API Key (`openai`, `gemini`, `anthropic`, `groq`, `openrouter`)
```bash
# Uses $GEMINI_API_KEY, $OPENAI_API_KEY, $ANTHROPIC_API_KEY, $GROQ_API_KEY, or $OPENROUTER_API_KEY
python benchmarks/run_benchmark.py \
  --brain byo \
  --provider gemini \
  --model gemini-2.5-flash \
  --output benchmarks/results/byo_gemini.json
```

---

## 4. Adding the 30+ Reference Screenshots Across the 15 Priority Apps

To expand the suite to the full 30+ production reference screenshots (at least 2 tasks per priority app across 100%, 125%, 150%, and 200% Windows DPI settings):

### Priority Windows Applications Target List (30+ Cases)
1. **Adobe Photoshop** (`photoshop`) — Object Selection Tool (`W`), Add Layer Mask, Export As
2. **Microsoft Excel** (`excel`) — AutoSum (`Alt+=`), PivotTable insert, Freeze Panes
3. **Microsoft PowerPoint** (`powerpoint`) — Morph transition, Slide Master, Align Objects
4. **Google Docs (Chrome)** (`google_docs`) — Suggesting mode toggle, Insert Table, Page Setup
5. **Microsoft Word** (`word`) — Track Changes, Insert Table of Contents, Styles pane
6. **Canva** (`canva`) — Magic Eraser / Background Remover, Share -> Download PNG
7. **Adobe Premiere Pro** (`premiere_pro`) — Razor Tool (`C`), Warp Stabilizer in Effects panel
8. **Adobe After Effects** (`after_effects`) — Keyframe stopwatch toggle, Graph Editor toggle
9. **Visual Studio Code** (`vscode`) — Extensions sidebar (`Ctrl+Shift+X`), Terminal toggle (`Ctrl+\``)
10. **GitHub Desktop** (`github_desktop`) — Commit to main button, Create Pull Request
11. **Windows Terminal / PowerShell** (`terminal`) — New tab dropdown, Settings (`Ctrl+,`)
12. **OpenCode** (`opencode`) — Model selector, session command bar
13. **Antigravity (`agy`)** (`antigravity`) — Agent composer bar, MCP / Plugin panel toggle
14. **Windows 11 Settings** (`windows_settings`) — Display scale dropdown, Bluetooth & devices
15. **Google Chrome** (`chrome`) — DevTools inspect toggle (`F12`), Clear browsing data

### Step-by-Step Procedure to Add a Case
1. **Capture a clean full-monitor screenshot** at native resolution (`1920x1080`, `2560x1440`, or `3840x2160`) and save it as `benchmarks/cases/images/<case_id>.png`.
2. **Convert pixel coordinates to normalized `0–1000` coordinates**:
   Given a target control at pixel rect `(px_x, px_y, px_w, px_h)` on a monitor of size `(mon_w, mon_h)`:
   ```python
   norm_x = round(px_x / mon_w * 1000, 1)
   norm_y = round(px_y / mon_h * 1000, 1)
   norm_w = round(px_w / mon_w * 1000, 1)
   norm_h = round(px_h / mon_h * 1000, 1)
   ```
3. **Create `benchmarks/cases/<NN>_<case_id>.json`** conforming to `benchmarks/schema.json`:
   ```json
   {
     "id": "after_effects_graph_editor_01",
     "app": "after_effects",
     "active_app_title": "Intro_Comp.aep * - Adobe After Effects 2025",
     "query": "Where do I open the Graph Editor to smooth my keyframe curves?",
     "image_path": "images/after_effects_graph_editor_01.png",
     "screen_resolution": {
       "width": 2560,
       "height": 1440,
       "scale_factor": 1.25
     },
     "expected": {
       "mode": "guide",
       "step_number": 1,
       "target_name": "Graph Editor",
       "control_type": "Button",
       "shortcut": "Shift+F3",
       "bbox": [378, 562, 24, 22],
       "min_iou": 0.5
     }
   }
   ```
4. **Validate your new case**:
   ```bash
   python benchmarks/run_benchmark.py --validate-only
   ```
