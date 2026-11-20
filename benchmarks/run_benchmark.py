#!/usr/bin/env python3
"""
GuideLens Visual Accuracy Benchmark Harness (IoU Evaluator)

Evaluates reference screenshots + ground-truth bounding boxes (`benchmarks/cases/*.json`)
against a GuideLens Brain provider:
  - mock   : Deterministic offline validation using each case's `mock_prediction`
  - cloud  : GuideLens Cloud Proxy (`POST /api/v1/guide`)
  - ollama : Local Ollama VLM (`POST http://127.0.0.1:11434/api/chat`)
  - byo    : Direct BYO API key (`openai`, `gemini`, `anthropic`, `groq`, `openrouter`)

Target release gate:
  - Per-case pass criterion: IoU >= 0.50 (or case-specific `expected.min_iou`)
  - Suite pass criterion   : Pass rate > 90.0% across all cases
  - StepPlan contract      : instruction_line <= 140 chars, coords normalized 0..1000
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import statistics
import struct
import sys
import time
import urllib.error
import urllib.request
import zlib
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

BENCHMARKS_DIR = Path(__file__).resolve().parent
CASES_DIR = BENCHMARKS_DIR / "cases"
SCHEMA_PATH = BENCHMARKS_DIR / "schema.json"

SYSTEM_PROMPT = """You are GuideLens, an AI on-screen desktop copilot for Windows.
Given a screenshot, the active window title, and the user's question, return ONLY valid JSON matching the StepPlan schema:
{
  "mode": "guide" | "explain" | "terminal",
  "total_steps": 1,
  "steps": [{
    "step_number": 1,
    "instruction_line": "<=140 chars concise action line",
    "target_name": "UI control label",
    "control_type": "Button",
    "bbox": [x, y, width, height],
    "confidence": 0.95,
    "shortcut": "optional shortcut or null",
    "terminal_command": null,
    "explanation": "1 short line or null"
  }]
}
All bbox coordinates [x, y, width, height] MUST be normalized to a 0-1000 grid relative to the screenshot (0,0 is top-left; 1000,1000 is bottom-right)."""


@dataclass
class CaseResult:
    case_id: str
    app: str
    query: str
    expected_bbox: list[float]
    predicted_bbox: list[float] | None
    iou: float
    min_iou: float
    passed: bool
    instruction_line: str
    instruction_len_ok: bool
    latency_ms: float
    error: str | None = None


def compute_iou(box_a: list[float] | tuple[float, ...], box_b: list[float] | tuple[float, ...]) -> float:
    """
    Compute Intersection over Union (IoU) for two boxes in [x, y, width, height] format
    (normalized 0-1000 coordinate system).
    """
    if len(box_a) != 4 or len(box_b) != 4:
        raise ValueError("Bounding boxes must have 4 elements: [x, y, width, height]")

    ax, ay, aw, ah = [float(v) for v in box_a]
    bx, by, bw, bh = [float(v) for v in box_b]

    if aw <= 0.0 or ah <= 0.0 or bw <= 0.0 or bh <= 0.0:
        return 0.0

    ax2, ay2 = ax + aw, ay + ah
    bx2, by2 = bx + bw, by + bh

    inter_x1 = max(ax, bx)
    inter_y1 = max(ay, by)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)

    inter_w = max(0.0, inter_x2 - inter_x1)
    inter_h = max(0.0, inter_y2 - inter_y1)
    inter_area = inter_w * inter_h

    if inter_area <= 0.0:
        return 0.0

    area_a = aw * ah
    area_b = bw * bh
    union_area = area_a + area_b - inter_area
    if union_area <= 0.0:
        return 0.0

    return round(inter_area / union_area, 6)


def generate_synthetic_png(
    output_path: Path,
    bbox_norm: list[float],
    bg_rgb: tuple[int, int, int] = (30, 32, 38),
    accent_rgb: tuple[int, int, int] = (56, 189, 248),
    width: int = 640,
    height: int = 360,
) -> None:
    """
    Generate a lightweight, valid RGB PNG screenshot with a synthetic UI chrome
    and a highlighted control button at `bbox_norm` ([x, y, w, h] in 0-1000 coords).
    Uses only Python stdlib (`zlib`, `struct`).
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    bx1 = max(0, min(width - 1, round(bbox_norm[0] / 1000.0 * width)))
    by1 = max(0, min(height - 1, round(bbox_norm[1] / 1000.0 * height)))
    bw = max(4, round(bbox_norm[2] / 1000.0 * width))
    bh = max(4, round(bbox_norm[3] / 1000.0 * height))
    bx2 = min(width, bx1 + bw)
    by2 = min(height, by1 + bh)

    raw_rows = bytearray()
    for y in range(height):
        raw_rows.append(0)  # PNG filter type 0 (None)
        in_top_bar = y < int(height * 0.08)
        in_y_box = by1 <= y <= by2
        for x in range(width):
            if in_y_box and bx1 <= x <= bx2:
                r, g, b = accent_rgb
            elif in_top_bar:
                r, g, b = (min(255, bg_rgb[0] + 18), min(255, bg_rgb[1] + 18), min(255, bg_rgb[2] + 22))
            elif x < int(width * 0.05):
                r, g, b = (min(255, bg_rgb[0] + 10), min(255, bg_rgb[1] + 10), min(255, bg_rgb[2] + 14))
            else:
                r, g, b = bg_rgb
            raw_rows.extend((r, g, b))

    def png_chunk(chunk_type: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    compressed = zlib.compress(bytes(raw_rows), level=6)
    png_bytes = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", compressed)
        + png_chunk(b"IEND", b"")
    )
    output_path.write_bytes(png_bytes)


def validate_step_plan(plan: dict[str, Any]) -> list[str]:
    """Validate a StepPlan dictionary against decisions.md §3 contract."""
    errors: list[str] = []
    if not isinstance(plan, dict):
        return ["StepPlan must be a JSON object"]

    mode = plan.get("mode")
    if mode not in ("guide", "explain", "terminal"):
        errors.append(f"Invalid mode: {mode!r} (expected 'guide', 'explain', or 'terminal')")

    steps = plan.get("steps")
    if not isinstance(steps, list) or len(steps) == 0:
        errors.append("StepPlan.steps must be a non-empty array")
        return errors

    total_steps = plan.get("total_steps")
    if not isinstance(total_steps, int) or total_steps < 1:
        errors.append(f"StepPlan.total_steps must be an integer >= 1 (got {total_steps!r})")

    for idx, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            errors.append(f"Step {idx} is not an object")
            continue
        line = step.get("instruction_line")
        if not isinstance(line, str) or not line.strip():
            errors.append(f"Step {idx} missing non-empty instruction_line")
        elif len(line) > 140:
            errors.append(f"Step {idx} instruction_line exceeds 140 chars ({len(line)} chars)")

        bbox = step.get("bbox")
        if bbox is not None:
            if not isinstance(bbox, list) or len(bbox) != 4:
                errors.append(f"Step {idx} bbox must be [x, y, w, h] or null")
            else:
                for coord in bbox:
                    if not isinstance(coord, (int, float)) or coord < 0 or coord > 1000:
                        errors.append(f"Step {idx} bbox coordinate {coord!r} out of 0..1000 range")

        conf = step.get("confidence")
        if not isinstance(conf, (int, float)) or conf < 0.0 or conf > 1.0:
            errors.append(f"Step {idx} confidence {conf!r} must be in 0.0..1.0")

    return errors


def validate_case_dict(case: dict[str, Any], source_name: str = "<case>") -> list[str]:
    """Validate a benchmark case JSON object against benchmarks/schema.json rules."""
    errors: list[str] = []
    required = ["id", "app", "active_app_title", "query", "image_path", "screen_resolution", "expected"]
    for key in required:
        if key not in case:
            errors.append(f"{source_name}: missing required field '{key}'")

    if errors:
        return errors

    if not isinstance(case["id"], str) or not re.match(r"^[a-z0-9_-]+$", case["id"]):
        errors.append(f"{source_name}: 'id' must match ^[a-z0-9_-]+$")

    for str_field in ("app", "active_app_title", "query", "image_path"):
        if not isinstance(case[str_field], str) or not case[str_field].strip():
            errors.append(f"{source_name}: '{str_field}' must be a non-empty string")

    res = case["screen_resolution"]
    if not isinstance(res, dict):
        errors.append(f"{source_name}: 'screen_resolution' must be an object")
    else:
        for dim in ("width", "height", "scale_factor"):
            if dim not in res or not isinstance(res[dim], (int, float)) or res[dim] <= 0:
                errors.append(f"{source_name}: screen_resolution.{dim} must be a positive number")

    exp = case["expected"]
    if not isinstance(exp, dict):
        errors.append(f"{source_name}: 'expected' must be an object")
    else:
        if exp.get("mode") not in ("guide", "explain", "terminal"):
            errors.append(f"{source_name}: expected.mode must be guide|explain|terminal")
        bbox = exp.get("bbox")
        if not isinstance(bbox, list) or len(bbox) != 4:
            errors.append(f"{source_name}: expected.bbox must be a 4-number array [x, y, w, h]")
        else:
            for c in bbox:
                if not isinstance(c, (int, float)) or c < 0 or c > 1000:
                    errors.append(f"{source_name}: expected.bbox coordinate {c!r} out of 0..1000")

    if "mock_prediction" in case and case["mock_prediction"] is not None:
        errors.extend(f"{source_name} mock_prediction: {e}" for e in validate_step_plan(case["mock_prediction"]))

    return errors


def extract_json_object(raw_text: str) -> dict[str, Any]:
    """Extract a JSON object from a raw LLM string (handling optional ```json fences)."""
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError(f"No JSON object found in model output: {raw_text[:200]!r}")
    return json.loads(cleaned[start : end + 1])


def http_post_json(url: str, payload: dict[str, Any], headers: dict[str, str], timeout: float = 30.0) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    req_headers = {"Content-Type": "application/json", "User-Agent": "GuideLens/1.0", **headers}
    req = urllib.request.Request(url, data=data, headers=req_headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def call_brain(
    case: dict[str, Any],
    image_b64: str,
    brain: str,
    cloud_url: str,
    cloud_token: str,
    ollama_url: str,
    ollama_model: str,
    byo_provider: str,
    byo_model: str | None,
    api_key: str | None,
) -> dict[str, Any]:
    """Invoke the selected brain and return a parsed StepPlan dict."""
    if brain == "mock":
        if case.get("mock_prediction"):
            return case["mock_prediction"]
        # Fallback synthetic prediction matching ground truth
        return {
            "mode": case["expected"]["mode"],
            "total_steps": 1,
            "steps": [
                {
                    "step_number": 1,
                    "instruction_line": f"Click {case['expected'].get('target_name', 'the target control')}.",
                    "target_name": case["expected"].get("target_name"),
                    "control_type": case["expected"].get("control_type", "Button"),
                    "bbox": case["expected"]["bbox"],
                    "confidence": 0.95,
                    "shortcut": case["expected"].get("shortcut"),
                    "terminal_command": None,
                    "explanation": None,
                }
            ],
        }

    if brain == "cloud":
        url = f"{cloud_url.rstrip('/')}/api/v1/guide"
        headers = {}
        if cloud_token:
            headers["Authorization"] = f"Bearer {cloud_token}"
        payload = {
            "image_base64": image_b64,
            "query": case["query"],
            "active_app_title": case["active_app_title"],
            "screen_resolution": case["screen_resolution"],
            "conversation_history": [],
        }
        return http_post_json(url, payload, headers=headers)

    user_prompt = (
        f"Active window: {case['active_app_title']}\n"
        f"Application: {case['app']}\n"
        f"User question: {case['query']}\n"
        "Respond with valid StepPlan JSON only."
    )

    if brain == "ollama":
        url = f"{ollama_url.rstrip('/')}/api/chat"
        payload = {
            "model": ollama_model,
            "stream": False,
            "format": "json",
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt, "images": [image_b64]},
            ],
        }
        resp = http_post_json(url, payload, headers={}, timeout=60.0)
        content = resp.get("message", {}).get("content", "")
        return extract_json_object(content)

    if brain == "byo":
        provider = byo_provider.lower()
        env_map = {
            "openai": "OPENAI_API_KEY",
            "gemini": "GEMINI_API_KEY",
            "anthropic": "ANTHROPIC_API_KEY",
            "groq": "GROQ_API_KEY",
            "openrouter": "OPENROUTER_API_KEY",
        }
        resolved_key = api_key or os.environ.get(env_map.get(provider, ""), "")
        if not resolved_key:
            raise RuntimeError(f"Missing API key for provider '{provider}'. Set --api-key or ${env_map.get(provider)}")

        if provider in ("openai", "groq", "openrouter"):
            default_models = {
                "openai": "gpt-4o-mini",
                "groq": "qwen/qwen3.8-27b",
                "openrouter": "qwen/qwen2.5-vl-72b-instruct",
            }
            endpoints = {
                "openai": "https://api.openai.com/v1/chat/completions",
                "groq": "https://api.groq.com/openai/v1/chat/completions",
                "openrouter": "https://openrouter.ai/api/v1/chat/completions",
            }
            payload = {
                "model": byo_model or default_models[provider],
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": user_prompt},
                            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}},
                        ],
                    },
                ],
                "temperature": 0.1,
            }
            resp = http_post_json(
                endpoints[provider],
                payload,
                headers={"Authorization": f"Bearer {resolved_key}"},
            )
            content = resp["choices"][0]["message"]["content"]
            return extract_json_object(content)

        if provider == "gemini":
            model_name = byo_model or "gemini-2.5-flash"
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={resolved_key}"
            payload = {
                "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
                "contents": [
                    {
                        "parts": [
                            {"text": user_prompt},
                            {"inlineData": {"mimeType": "image/png", "data": image_b64}},
                        ]
                    }
                ],
                "generationConfig": {"responseMimeType": "application/json", "temperature": 0.1},
            }
            resp = http_post_json(url, payload, headers={})
            content = resp["candidates"][0]["content"]["parts"][0]["text"]
            return extract_json_object(content)

        if provider == "anthropic":
            model_name = byo_model or "claude-3-5-sonnet-latest"
            payload = {
                "model": model_name,
                "max_tokens": 1024,
                "system": SYSTEM_PROMPT,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {"type": "base64", "media_type": "image/png", "data": image_b64},
                            },
                            {"type": "text", "text": user_prompt},
                        ],
                    }
                ],
            }
            resp = http_post_json(
                "https://api.anthropic.com/v1/messages",
                payload,
                headers={"x-api-key": resolved_key, "anthropic-version": "2023-06-01"},
            )
            content = resp["content"][0]["text"]
            return extract_json_object(content)

        raise ValueError(f"Unsupported BYO provider: {provider}")

    raise ValueError(f"Unsupported brain: {brain}")


def load_and_prepare_cases(cases_dir: Path = CASES_DIR, auto_generate_images: bool = True) -> list[tuple[Path, dict[str, Any]]]:
    """Load all benchmark case JSON files and ensure their synthetic images exist."""
    case_files = sorted(cases_dir.glob("*.json"))
    if not case_files:
        raise FileNotFoundError(f"No benchmark cases found in {cases_dir}")

    loaded: list[tuple[Path, dict[str, Any]]] = []
    for path in case_files:
        case = json.loads(path.read_text(encoding="utf-8"))
        errors = validate_case_dict(case, source_name=path.name)
        if errors:
            raise ValueError("Invalid benchmark case:\n  " + "\n  ".join(errors))

        img_path = cases_dir / case["image_path"]
        if not img_path.exists():
            if auto_generate_images:
                generate_synthetic_png(img_path, case["expected"]["bbox"])
            else:
                raise FileNotFoundError(f"Missing reference image {img_path} for case {case['id']}")
        loaded.append((path, case))
    return loaded


def evaluate_suite(
    cases: list[tuple[Path, dict[str, Any]]],
    brain: str = "mock",
    iou_threshold: float = 0.5,
    cloud_url: str = "http://127.0.0.1:8000",
    cloud_token: str = "",
    ollama_url: str = "http://127.0.0.1:11434",
    ollama_model: str = "qwen2.5vl:3b",
    byo_provider: str = "openai",
    byo_model: str | None = None,
    api_key: str | None = None,
) -> dict[str, Any]:
    results: list[CaseResult] = []
    for case_path, case in cases:
        img_path = case_path.parent / case["image_path"]
        img_b64 = base64.b64encode(img_path.read_bytes()).decode("ascii")
        expected_bbox = [float(x) for x in case["expected"]["bbox"]]
        min_iou = float(case["expected"].get("min_iou", iou_threshold))
        target_step_num = int(case["expected"].get("step_number", 1))

        t0 = time.perf_counter()
        error_msg: str | None = None
        pred_bbox: list[float] | None = None
        instruction_line = ""
        instruction_ok = False
        iou = 0.0

        try:
            plan = call_brain(
                case=case,
                image_b64=img_b64,
                brain=brain,
                cloud_url=cloud_url,
                cloud_token=cloud_token,
                ollama_url=ollama_url,
                ollama_model=ollama_model,
                byo_provider=byo_provider,
                byo_model=byo_model,
                api_key=api_key,
            )
            plan_errors = validate_step_plan(plan)
            if plan_errors:
                error_msg = "; ".join(plan_errors)

            steps = plan.get("steps", [])
            matched_step = next(
                (s for s in steps if isinstance(s, dict) and s.get("step_number") == target_step_num),
                steps[0] if steps else None,
            )
            if matched_step:
                instruction_line = str(matched_step.get("instruction_line", ""))
                instruction_ok = 0 < len(instruction_line) <= 140
                raw_bbox = matched_step.get("bbox")
                if isinstance(raw_bbox, list) and len(raw_bbox) == 4:
                    pred_bbox = [float(x) for x in raw_bbox]
                    iou = compute_iou(expected_bbox, pred_bbox)
        except Exception as exc:  # noqa: BLE001
            error_msg = str(exc)

        latency_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        passed = (error_msg is None) and instruction_ok and (iou >= min_iou)
        results.append(
            CaseResult(
                case_id=case["id"],
                app=case["app"],
                query=case["query"],
                expected_bbox=expected_bbox,
                predicted_bbox=pred_bbox,
                iou=iou,
                min_iou=min_iou,
                passed=passed,
                instruction_line=instruction_line,
                instruction_len_ok=instruction_ok,
                latency_ms=latency_ms,
                error=error_msg,
            )
        )

    total = len(results)
    passed_count = sum(1 for r in results if r.passed)
    pass_rate = (passed_count / total) if total else 0.0
    ious = [r.iou for r in results]
    latencies = [r.latency_ms for r in results]

    return {
        "brain": brain,
        "total_cases": total,
        "passed_cases": passed_count,
        "pass_rate": round(pass_rate, 4),
        "mean_iou": round(statistics.mean(ious), 4) if ious else 0.0,
        "median_iou": round(statistics.median(ious), 4) if ious else 0.0,
        "min_iou_observed": round(min(ious), 4) if ious else 0.0,
        "mean_latency_ms": round(statistics.mean(latencies), 2) if latencies else 0.0,
        "target_pass_rate": 0.90,
        "target_iou_threshold": iou_threshold,
        "suite_passed": pass_rate >= 0.90,
        "results": [asdict(r) for r in results],
    }


def print_summary(report: dict[str, Any]) -> None:
    print("=" * 94)
    print(f"GuideLens Visual Accuracy Benchmark Report (brain={report['brain']})")
    print("=" * 94)
    print(f"{'Case ID':<34} {'App':<12} {'Expected BBox':<18} {'Pred BBox':<18} {'IoU':>6} {'Status':>6}")
    print("-" * 94)
    for r in report["results"]:
        exp_str = json.dumps([round(v) for v in r["expected_bbox"]])
        pred_str = json.dumps([round(v) for v in r["predicted_bbox"]]) if r["predicted_bbox"] else "null"
        status = "PASS" if r["passed"] else "FAIL"
        print(f"{r['case_id']:<34} {r['app']:<12} {exp_str:<18} {pred_str:<18} {r['iou']:>6.3f} {status:>6}")
        if r["error"]:
            print(f"   [error] {r['error']}")
    print("-" * 94)
    pct = report["pass_rate"] * 100.0
    target_pct = report["target_pass_rate"] * 100.0
    gate = "PASSED" if report["suite_passed"] else "FAILED"
    print(
        f"Cases: {report['passed_cases']}/{report['total_cases']} ({pct:.1f}%) | "
        f"Mean IoU: {report['mean_iou']:.3f} | Median IoU: {report['median_iou']:.3f} | "
        f"Release Gate (>={target_pct:.0f}% @ IoU>={report['target_iou_threshold']:.2f}): {gate}"
    )
    print("=" * 94)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="GuideLens Visual Accuracy (IoU) Benchmark Runner")
    parser.add_argument(
        "--brain",
        choices=["mock", "cloud", "ollama", "byo"],
        default="mock",
        help="Brain backend to evaluate (default: mock)",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Validate schema.json, cases/*.json, reference images, and run offline mock IoU check.",
    )
    parser.add_argument("--cases-dir", type=Path, default=CASES_DIR, help="Path to benchmark case JSON files")
    parser.add_argument("--iou-threshold", type=float, default=0.5, help="Minimum IoU for a step to pass (default: 0.5)")
    parser.add_argument("--min-pass-rate", type=float, default=0.90, help="Minimum suite pass rate (default: 0.90)")
    parser.add_argument(
        "--cloud-url",
        default=os.environ.get("GUIDELENS_CLOUD_URL", "http://127.0.0.1:8000"),
        help="GuideLens Cloud Proxy base URL",
    )
    parser.add_argument(
        "--cloud-token",
        default=os.environ.get("GUIDELENS_CLOUD_TOKEN", ""),
        help="Supabase JWT for Cloud Proxy authentication",
    )
    parser.add_argument(
        "--ollama-url",
        default=os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"),
        help="Local Ollama base URL",
    )
    parser.add_argument("--ollama-model", default="qwen2.5vl:3b", help="Ollama vision model name")
    parser.add_argument(
        "--provider",
        choices=["openai", "gemini", "anthropic", "groq", "openrouter"],
        default="openai",
        help="BYO API provider when --brain=byo",
    )
    parser.add_argument("--model", default=None, help="Optional model override for --brain=byo")
    parser.add_argument("--api-key", default=None, help="Optional API key override for --brain=byo")
    parser.add_argument("--output", type=Path, default=None, help="Write JSON report to file")
    args = parser.parse_args(argv)

    # 1. Verify schema.json parses cleanly
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    if schema.get("type") != "object":
        print("ERROR: benchmarks/schema.json root must have type='object'", file=sys.stderr)
        return 1

    # 2. Load and validate all cases (and generate synthetic sample PNGs if missing)
    cases = load_and_prepare_cases(args.cases_dir, auto_generate_images=True)

    brain_mode = "mock" if args.validate_only else args.brain
    report = evaluate_suite(
        cases=cases,
        brain=brain_mode,
        iou_threshold=args.iou_threshold,
        cloud_url=args.cloud_url,
        cloud_token=args.cloud_token,
        ollama_url=args.ollama_url,
        ollama_model=args.ollama_model,
        byo_provider=args.provider,
        byo_model=args.model,
        api_key=args.api_key,
    )
    report["target_pass_rate"] = args.min_pass_rate
    report["suite_passed"] = report["pass_rate"] >= args.min_pass_rate

    print_summary(report)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"Saved JSON report to {args.output}")

    return 0 if report["suite_passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
