"""Pydantic v2 schemas and StepPlan validation/repair logic (decisions.md §3 & §6)."""

from __future__ import annotations

import json
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_INSTRUCTION_CHARS = 140
StepMode = Literal["guide", "explain", "terminal"]
SubscriptionTier = Literal["free", "pro_monthly", "pro_annual"]
SubscriptionStatus = Literal["active", "past_due", "canceled", "inactive"]


def normalize_single_line(text: str, max_len: int | None = None) -> str:
    """Collapse whitespace/newlines into a single line and optionally truncate to max_len."""
    collapsed = re.sub(r"\s+", " ", text or "").strip()
    if max_len is not None and len(collapsed) > max_len:
        if max_len > 1:
            return collapsed[: max_len - 1].rstrip() + "…"
        return collapsed[:max_len]
    return collapsed


class Step(BaseModel):
    """Single step in a StepPlan (decisions.md §3)."""

    model_config = ConfigDict(extra="forbid")

    step_number: int = Field(..., ge=1)
    instruction_line: str = Field(..., min_length=1, max_length=MAX_INSTRUCTION_CHARS)
    target_name: str | None = Field(default=None)
    control_type: str | None = Field(default=None)
    bbox: list[float] | None = Field(default=None)
    confidence: float = Field(..., ge=0.0, le=1.0)
    shortcut: str | None = Field(default=None)
    terminal_command: str | None = Field(default=None)
    explanation: str | None = Field(default=None)
    spoken_text: str | None = Field(default=None)

    @field_validator("instruction_line")
    @classmethod
    def validate_instruction_line(cls, value: str) -> str:
        if "\n" in value or "\r" in value:
            raise ValueError("instruction_line must be a single line without newlines")
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("instruction_line must not be empty")
        if len(cleaned) > MAX_INSTRUCTION_CHARS:
            raise ValueError(f"instruction_line must be <= {MAX_INSTRUCTION_CHARS} characters")
        return cleaned

    @field_validator("bbox")
    @classmethod
    def validate_bbox(cls, value: list[float] | None) -> list[float] | None:
        if value is None:
            return None
        if len(value) != 4:
            raise ValueError("bbox must contain exactly 4 numbers: [x, y, w, h]")
        x, y, w, h = (float(v) for v in value)
        for coord_name, coord_val in (("x", x), ("y", y), ("w", w), ("h", h)):
            if coord_val < 0.0 or coord_val > 1000.0:
                raise ValueError(
                    f"bbox {coord_name}={coord_val} must be normalized in range 0..1000"
                )
        return [x, y, w, h]

    @field_validator("explanation")
    @classmethod
    def validate_explanation(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return normalize_single_line(value, max_len=280) or None

    @field_validator("spoken_text")
    @classmethod
    def validate_spoken_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return normalize_single_line(value, max_len=MAX_INSTRUCTION_CHARS) or None


class StepPlan(BaseModel):
    """Complete StepPlan contract returned by all brains and /api/v1/guide (decisions.md §3)."""

    model_config = ConfigDict(extra="forbid")

    mode: StepMode
    total_steps: int = Field(..., ge=1)
    steps: list[Step] = Field(..., min_length=1)

    @model_validator(mode="after")
    def validate_step_counts(self) -> StepPlan:
        if self.total_steps != len(self.steps):
            raise ValueError(
                f"total_steps ({self.total_steps}) must match len(steps) ({len(self.steps)})"
            )
        return self


def _extract_json_dict(raw: str | dict[str, Any]) -> dict[str, Any]:
    """Extract a JSON object from raw LLM string output (including markdown fences) or dict."""
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        raise ValueError("StepPlan payload must be a JSON string or dict")

    text = raw.strip()
    fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, flags=re.DOTALL)
    if fence_match:
        text = fence_match.group(1).strip()
    elif not text.startswith("{"):
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            text = text[start : end + 1]

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Failed to parse StepPlan JSON: {exc}") from exc

    if not isinstance(parsed, dict):
        raise ValueError("StepPlan JSON root must be an object")
    return parsed


def _repair_bbox(raw_bbox: Any) -> list[float] | None:
    if not isinstance(raw_bbox, (list, tuple)) or len(raw_bbox) != 4:
        return None
    coords: list[float] = []
    for item in raw_bbox:
        try:
            val = float(item)
        except (TypeError, ValueError):
            return None
        coords.append(max(0.0, min(1000.0, val)))
    if coords[2] <= 0.0 or coords[3] <= 0.0:
        return None
    return coords


def _repair_confidence(raw_conf: Any) -> float:
    try:
        conf = float(raw_conf)
    except (TypeError, ValueError):
        return 0.75
    if 1.0 < conf <= 100.0:
        conf = conf / 100.0
    return max(0.0, min(1.0, conf))


def repair_step_plan(raw: str | dict[str, Any]) -> StepPlan:
    """Validate and repair raw LLM JSON output into a strict StepPlan (decisions.md §3)."""
    data = _extract_json_dict(raw)

    raw_steps = data.get("steps")
    if not isinstance(raw_steps, list) or len(raw_steps) == 0:
        # Handle flat single-step response from an LLM
        if "instruction_line" in data:
            raw_steps = [data]
        else:
            raise ValueError("StepPlan must contain a non-empty 'steps' list")

    repaired_steps: list[dict[str, Any]] = []
    has_terminal_cmd = False

    for item in raw_steps:
        if not isinstance(item, dict):
            continue
        raw_instruction = str(item.get("instruction_line") or item.get("instruction") or "").strip()
        instruction_line = normalize_single_line(raw_instruction, max_len=MAX_INSTRUCTION_CHARS)
        if not instruction_line:
            continue

        terminal_command = item.get("terminal_command")
        if isinstance(terminal_command, str):
            terminal_command = terminal_command.strip() or None
            if terminal_command:
                has_terminal_cmd = True
        else:
            terminal_command = None

        explanation = item.get("explanation")
        if isinstance(explanation, str):
            explanation = normalize_single_line(explanation, max_len=280) or None
        else:
            explanation = None

        spoken_text = item.get("spoken_text")
        if isinstance(spoken_text, str):
            spoken_text = normalize_single_line(spoken_text, max_len=MAX_INSTRUCTION_CHARS) or None
        else:
            spoken_text = None

        target_name = item.get("target_name")
        if isinstance(target_name, str):
            target_name = normalize_single_line(target_name, max_len=120) or None
        else:
            target_name = None

        control_type = item.get("control_type")
        if isinstance(control_type, str):
            control_type = normalize_single_line(control_type, max_len=60) or None
        else:
            control_type = None

        shortcut = item.get("shortcut")
        if isinstance(shortcut, str):
            shortcut = normalize_single_line(shortcut, max_len=40) or None
        else:
            shortcut = None

        confidence = _repair_confidence(item.get("confidence", 0.75))
        bbox = _repair_bbox(item.get("bbox"))
        if confidence < 0.5:
            # Per decisions.md §1 & non_functional_requirements.md §4:
            # If confidence < 0.5 -> text only, no misleading highlight box
            bbox = None

        repaired_steps.append(
            {
                "step_number": len(repaired_steps) + 1,
                "instruction_line": instruction_line,
                "target_name": target_name,
                "control_type": control_type,
                "bbox": bbox,
                "confidence": confidence,
                "shortcut": shortcut,
                "terminal_command": terminal_command,
                "explanation": explanation,
                "spoken_text": spoken_text,
            }
        )

    if not repaired_steps:
        raise ValueError("No valid steps could be repaired from StepPlan output")

    raw_mode = data.get("mode")
    if raw_mode in ("guide", "explain", "terminal"):
        mode: StepMode = raw_mode
    elif has_terminal_cmd:
        mode = "terminal"
    else:
        mode = "guide"

    return StepPlan.model_validate(
        {
            "mode": mode,
            "total_steps": len(repaired_steps),
            "steps": repaired_steps,
        }
    )


class GuideRequest(BaseModel):
    """Request payload for POST /api/v1/guide (decisions.md §6).

    Note: image_base64 has repr=False so screenshots are never printed in logs or tracebacks.
    """

    model_config = ConfigDict(extra="ignore")

    image_base64: str = Field(..., min_length=1, repr=False)
    query: str = Field(..., min_length=1, max_length=2000)
    active_app_title: str = Field(default="")
    screen_resolution: str | list[int] | dict[str, Any] | None = Field(default=None)
    conversation_history: list[dict[str, Any] | str] = Field(default_factory=list)

    @field_validator("image_base64")
    @classmethod
    def validate_image_not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("image_base64 must not be blank")
        return stripped


class CheckoutRequest(BaseModel):
    """Request payload for POST /billing/checkout (and /api/v1/billing/checkout)."""

    model_config = ConfigDict(extra="ignore")

    plan: Literal["monthly", "annual", "pro_monthly", "pro_annual"] = Field(default="monthly")
    price_id: str | None = Field(default=None)
    success_url: str | None = Field(default=None)
    cancel_url: str | None = Field(default=None)


class CheckoutResponse(BaseModel):
    url: str
    session_id: str


class PortalRequest(BaseModel):
    """Request payload for POST /billing/portal (and /api/v1/billing/portal)."""

    model_config = ConfigDict(extra="ignore")

    return_url: str | None = Field(default=None)


class PortalResponse(BaseModel):
    url: str


class MeResponse(BaseModel):
    """Response payload for GET /api/v1/me (decisions.md §6 & frontend auth_status)."""

    id: str
    email: str
    tier: SubscriptionTier
    subscription_tier: SubscriptionTier
    status: SubscriptionStatus
    subscription_status: SubscriptionStatus
    usage: int
    limit: int
    billing_month: str
    current_period_end: str | None = None
