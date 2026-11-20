"""Groq API client for screenshot vision + reasoning with strict StepPlan JSON output."""

from __future__ import annotations

import json
from typing import Any, Protocol

import httpx

from app.config import Settings
from app.schemas import GuideRequest, StepPlan, repair_step_plan

SYSTEM_PROMPT = """You are GuideLens, an AI on-screen desktop copilot for Windows 10/11.
Given the user's screenshot, active application title, and question, return a strict JSON object
matching the StepPlan schema:
{
  "mode": "guide" | "explain" | "terminal",
  "total_steps": <integer >= 1>,
  "steps": [
    {
      "step_number": 1,
      "instruction_line": "<concise 1-line instruction, MUST BE <= 140 characters>",
      "target_name": "<exact UI button/menu label for Windows UI Automation, or null>",
      "control_type": "<Button | MenuItem | TabItem | Edit | CheckBox | ComboBox | null>",
      "bbox": [x, y, width, height],
      "confidence": 0.0 to 1.0,
      "shortcut": "<keyboard shortcut like Ctrl+Shift+P or W, or null>",
      "terminal_command": "<CLI command string when mode is terminal, else null>",
      "explanation": "<concise 1-line explanation, or null>"
    }
  ]
}
Rules:
1. Coordinates in `bbox` MUST be normalized to a 0-1000 scale [x, y, width, height].
2. Every `instruction_line` MUST be a single line of at most 140 characters.
3. If confidence is below 0.5, set `bbox` to null.
4. Support priority apps (Photoshop, Premiere Pro, After Effects, Canva, Excel, PowerPoint,
   MS Word, Google Docs, VS Code, GitHub Desktop, Windows Terminal, OpenCode, Antigravity,
   Windows Settings, Chrome); use mode="terminal" + terminal_command for CLI tasks.
5. Output ONLY valid JSON with no markdown fences or extra commentary."""


class GroqTimeoutError(Exception):
    """Raised when the Groq API call times out (maps to HTTP 504)."""


class GroqUpstreamError(Exception):
    """Raised when the Groq API fails or returns invalid data (maps to HTTP 502)."""


class GroqProvider(Protocol):
    """Interface for generating a StepPlan from a GuideRequest."""

    async def generate_step_plan(self, request: GuideRequest) -> StepPlan: ...


def _to_data_url(image_base64: str) -> str:
    """Convert raw base64 image string into a data URL in memory (never logged/persisted)."""
    if image_base64.startswith("data:image/"):
        return image_base64
    return f"data:image/jpeg;base64,{image_base64}"


def _build_user_context(request: GuideRequest) -> str:
    parts = [f"User query: {request.query}"]
    if request.active_app_title:
        parts.append(f"Active application: {request.active_app_title}")
    if request.screen_resolution:
        parts.append(f"Screen resolution: {json.dumps(request.screen_resolution)}")
    if request.conversation_history:
        history_snippet = json.dumps(request.conversation_history[-5:])
        parts.append(f"Recent context: {history_snippet}")
    return "\n".join(parts)


class GroqHttpClient:
    """Production Groq API client calling the configured vision (and optional reasoning) model."""

    def __init__(
        self,
        settings: Settings,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.settings = settings
        self._client = http_client

    async def _post_chat_completion(self, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.settings.groq_base_url.rstrip('/')}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.settings.groq_api_key}",
            "Content-Type": "application/json",
            "User-Agent": "GuideLens/1.0",
        }
        try:
            if self._client is not None:
                resp = await self._client.post(
                    url,
                    json=payload,
                    headers=headers,
                    timeout=self.settings.groq_timeout_seconds,
                )
            else:
                async with httpx.AsyncClient(timeout=self.settings.groq_timeout_seconds) as client:
                    resp = await client.post(url, json=payload, headers=headers)
        except (TimeoutError, httpx.TimeoutException) as exc:
            raise GroqTimeoutError("Groq API request timed out") from exc
        except httpx.HTTPError as exc:
            raise GroqUpstreamError(f"Groq API HTTP error: {exc}") from exc

        if resp.status_code in (408, 504):
            raise GroqTimeoutError(f"Groq API gateway timeout (status {resp.status_code})")
        if resp.status_code >= 400:
            raise GroqUpstreamError(f"Groq API returned HTTP {resp.status_code}")

        try:
            return resp.json()
        except ValueError as exc:
            raise GroqUpstreamError("Groq API returned non-JSON response") from exc

    async def generate_step_plan(self, request: GuideRequest) -> StepPlan:
        # Image is held strictly in local memory for the duration of the outgoing request
        user_context = _build_user_context(request)
        payload: dict[str, Any] = {
            "model": self.settings.groq_vision_model,
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_context},
                        {
                            "type": "image_url",
                            "image_url": {"url": _to_data_url(request.image_base64)},
                        },
                    ],
                },
            ],
        }

        data = await self._post_chat_completion(payload)
        try:
            raw_content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise GroqUpstreamError("Unexpected Groq completion payload structure") from exc

        try:
            return repair_step_plan(raw_content)
        except ValueError as first_err:
            # Second-pass repair via configured reasoning model if vision JSON was malformed
            if self.settings.groq_reasoning_model:
                repair_payload: dict[str, Any] = {
                    "model": self.settings.groq_reasoning_model,
                    "temperature": 0.0,
                    "response_format": {"type": "json_object"},
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {
                            "role": "user",
                            "content": (
                                f"{user_context}\n\n"
                                f"Repair this draft into a valid StepPlan JSON:\n{raw_content}"
                            ),
                        },
                    ],
                }
                repaired_data = await self._post_chat_completion(repair_payload)
                try:
                    repaired_content = repaired_data["choices"][0]["message"]["content"]
                    return repair_step_plan(repaired_content)
                except (KeyError, IndexError, TypeError, ValueError) as exc:
                    raise GroqUpstreamError(f"Failed to repair Groq StepPlan: {exc}") from exc
            raise GroqUpstreamError(f"Invalid StepPlan from Groq: {first_err}") from first_err


class MockGroqClient:
    """Deterministic mock Groq provider used when GROQ_API_KEY is not set."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings

    async def generate_step_plan(self, request: GuideRequest) -> StepPlan:
        app_lower = request.active_app_title.lower()
        query_lower = request.query.lower()

        if "terminal" in app_lower or "powershell" in app_lower or "git " in query_lower:
            return StepPlan.model_validate(
                {
                    "mode": "terminal",
                    "total_steps": 1,
                    "steps": [
                        {
                            "step_number": 1,
                            "instruction_line": "Run the command below in your terminal.",
                            "target_name": "Terminal Prompt",
                            "control_type": "Edit",
                            "bbox": [100.0, 200.0, 600.0, 40.0],
                            "confidence": 0.92,
                            "shortcut": None,
                            "terminal_command": "git status",
                            "explanation": "Displays working tree status.",
                        }
                    ],
                }
            )

        return StepPlan.model_validate(
            {
                "mode": "guide",
                "total_steps": 1,
                "steps": [
                    {
                        "step_number": 1,
                        "instruction_line": "Click the highlighted toolbar button to proceed.",
                        "target_name": "Object Selection Tool",
                        "control_type": "Button",
                        "bbox": [42.0, 180.0, 36.0, 36.0],
                        "confidence": 0.91,
                        "shortcut": "W",
                        "terminal_command": None,
                        "explanation": "Selects the primary tool for your query.",
                    }
                ],
            }
        )


def create_groq_provider(settings: Settings) -> GroqProvider:
    """Return GroqHttpClient when a real GROQ_API_KEY is set, else MockGroqClient."""
    key = settings.groq_api_key.strip()
    if key and key != "gsk_your_groq_api_key_here" and not key.startswith("mock"):
        return GroqHttpClient(settings)
    return MockGroqClient(settings)
