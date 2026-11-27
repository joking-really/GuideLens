//! Bring-Your-Own API key provider supporting Gemini, OpenAI, Anthropic, Groq, OpenRouter,
//! DeepSeek, and Custom OpenAI-compatible endpoints (`settings.custom_api_base_url`).
//! API keys are read from Windows Credential Manager (`SecretStore`) and never logged.

use crate::brain::agent_cli::{self, AgentCliProvider, AgentId};
use crate::brain::groq_pro::{self, CloudEndpoints};
use crate::brain::http_client::shared_http_client;
use crate::brain::json_repair::parse_and_repair_step_plan;
use crate::brain::ollama::{self, resolve_ollama_base_url, OllamaProvider};
use crate::brain::provider::{BrainError, BrainErrorCode, BrainProvider, BrainRequest};
use crate::brain::BrainState;
use crate::db::DbState;
use crate::types::{BrainKind, ConnectionTestResult, Settings, StepPlan};
use async_trait::async_trait;
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::str::FromStr;
use std::time::{Duration, Instant};
use tauri::State;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ByoProviderId {
    Gemini,
    OpenAi,
    Anthropic,
    Groq,
    OpenRouter,
    DeepSeek,
    CustomOpenAi,
}

impl ByoProviderId {
    pub fn from_str_id(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "gemini" => Some(Self::Gemini),
            "openai" => Some(Self::OpenAi),
            "anthropic" => Some(Self::Anthropic),
            "groq" => Some(Self::Groq),
            "openrouter" => Some(Self::OpenRouter),
            "deepseek" => Some(Self::DeepSeek),
            "custom_openai" | "custom" => Some(Self::CustomOpenAi),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Gemini => "gemini",
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::Groq => "groq",
            Self::OpenRouter => "openrouter",
            Self::DeepSeek => "deepseek",
            Self::CustomOpenAi => "custom_openai",
        }
    }

    pub fn default_model(&self) -> &'static str {
        match self {
            Self::Gemini => "gemini-2.5-flash",
            Self::OpenAi => "gpt-4o-mini",
            Self::Anthropic => "claude-3-5-sonnet-latest",
            Self::Groq => "qwen/qwen3.8-27b",
            Self::OpenRouter => "qwen/qwen2.5-vl-72b-instruct",
            Self::DeepSeek => "deepseek-chat",
            Self::CustomOpenAi => "gpt-4o-mini",
        }
    }

    pub fn default_base_url(&self) -> &'static str {
        match self {
            Self::Gemini => "https://generativelanguage.googleapis.com",
            Self::OpenAi => "https://api.openai.com/v1",
            Self::Anthropic => "https://api.anthropic.com/v1",
            Self::Groq => "https://api.groq.com/openai/v1",
            Self::OpenRouter => "https://openrouter.ai/api/v1",
            Self::DeepSeek => "https://api.deepseek.com/v1",
            Self::CustomOpenAi => "http://127.0.0.1:8080/v1",
        }
    }

    pub fn supports_vision(&self, model: &str) -> bool {
        match self {
            Self::DeepSeek => {
                let lower = model.to_ascii_lowercase();
                lower.contains("vl") || lower.contains("vision")
            }
            _ => true,
        }
    }
}

#[derive(Clone)]
pub struct ByoApiProvider {
    pub provider: ByoProviderId,
    pub model: String,
    pub base_url: String,
    api_key: String,
    client: Client,
}

impl std::fmt::Debug for ByoApiProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never include `api_key` in Debug output.
        f.debug_struct("ByoApiProvider")
            .field("provider", &self.provider)
            .field("model", &self.model)
            .field("base_url", &self.base_url)
            .field("api_key", &"[REDACTED]")
            .finish()
    }
}

impl ByoApiProvider {
    pub fn new(
        provider: ByoProviderId,
        api_key: impl Into<String>,
        model_override: Option<&str>,
    ) -> Self {
        Self::with_base_url(
            provider,
            api_key,
            model_override,
            provider.default_base_url(),
        )
    }

    pub fn with_base_url(
        provider: ByoProviderId,
        api_key: impl Into<String>,
        model_override: Option<&str>,
        base_url: impl Into<String>,
    ) -> Self {
        let model = model_override
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| provider.default_model())
            .to_string();

        let raw_base = base_url.into();
        let trimmed_base = raw_base.trim().trim_end_matches('/');
        let effective_base = if trimmed_base.is_empty() {
            provider.default_base_url().to_string()
        } else {
            trimmed_base.to_string()
        };

        Self {
            provider,
            model,
            base_url: effective_base,
            api_key: api_key.into(),
            client: shared_http_client().clone(),
        }
    }

    fn map_http_error(&self, status: u16, body: &str) -> BrainError {
        let snippet: String = body.chars().take(240).collect();
        match status {
            401 | 403 => BrainError::new(
                BrainErrorCode::Unauthenticated,
                BrainKind::ByoApi,
                format!(
                    "{} API key rejected (HTTP {}). Check your key in Control Center.",
                    self.provider.as_str(),
                    status
                ),
            ),
            402 => BrainError::new(
                BrainErrorCode::Quota,
                BrainKind::ByoApi,
                format!(
                    "{} account quota/billing required (HTTP 402).",
                    self.provider.as_str()
                ),
            ),
            429 => BrainError::new(
                BrainErrorCode::RateLimited,
                BrainKind::ByoApi,
                format!(
                    "{} rate limit exceeded (HTTP 429).",
                    self.provider.as_str()
                ),
            ),
            408 | 504 => BrainError::new(
                BrainErrorCode::Timeout,
                BrainKind::ByoApi,
                format!(
                    "{} request timed out (HTTP {}).",
                    self.provider.as_str(),
                    status
                ),
            ),
            _ => BrainError::new(
                BrainErrorCode::Unavailable,
                BrainKind::ByoApi,
                format!(
                    "{} returned HTTP {}: {}",
                    self.provider.as_str(),
                    status,
                    snippet
                ),
            ),
        }
    }

    async fn call_gemini(&self, req: &BrainRequest, json_mode: bool) -> Result<String, BrainError> {
        let url = format!(
            "{}/v1beta/models/{}:generateContent",
            self.base_url, self.model
        );

        let mut parts = vec![json!({ "text": req.user_prompt })];
        if !req.image_base64.trim().is_empty() {
            parts.push(json!({
                "inlineData": {
                    "mimeType": "image/jpeg",
                    "data": req.image_base64
                }
            }));
        }

        let mut gen_config = json!({
            "temperature": if json_mode { 0.1 } else { 0.3 }
        });
        if json_mode {
            gen_config["responseMimeType"] = json!("application/json");
        }
        if let Some(max_tok) = req.max_tokens {
            gen_config["maxOutputTokens"] = json!(max_tok);
        }

        let payload = json!({
            "systemInstruction": {
                "parts": [{ "text": req.system_prompt }]
            },
            "contents": [{
                "role": "user",
                "parts": parts
            }],
            "generationConfig": gen_config
        });

        let resp = self
            .client
            .post(&url)
            .timeout(Duration::from_secs(30))
            .header("x-goog-api-key", &self.api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|e| self.map_transport_error(e))?;

        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(self.map_http_error(status, &body));
        }

        let parsed: Value = serde_json::from_str(&body).map_err(|e| {
            BrainError::new(
                BrainErrorCode::InvalidResponse,
                BrainKind::ByoApi,
                format!("Gemini returned invalid JSON envelope: {}", e),
            )
        })?;

        let text = parsed
            .get("candidates")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("content"))
            .and_then(|c| c.get("parts"))
            .and_then(|p| p.as_array())
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                BrainError::new(
                    BrainErrorCode::InvalidResponse,
                    BrainKind::ByoApi,
                    "Gemini response missing candidate text content",
                )
            })?;

        Ok(text)
    }

    async fn call_anthropic(
        &self,
        req: &BrainRequest,
        json_mode: bool,
    ) -> Result<String, BrainError> {
        let url = format!("{}/messages", self.base_url);
        let max_tokens = req.max_tokens.unwrap_or(1024);
        let mut content = Vec::new();
        if !req.image_base64.trim().is_empty() {
            content.push(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": req.image_base64
                }
            }));
        }
        content.push(json!({
            "type": "text",
            "text": req.user_prompt
        }));

        let payload = json!({
            "model": self.model,
            "max_tokens": max_tokens,
            "temperature": if json_mode { 0.1 } else { 0.3 },
            "system": req.system_prompt,
            "messages": [{
                "role": "user",
                "content": content
            }]
        });

        let resp = self
            .client
            .post(&url)
            .timeout(Duration::from_secs(30))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&payload)
            .send()
            .await
            .map_err(|e| self.map_transport_error(e))?;

        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(self.map_http_error(status, &body));
        }

        let parsed: Value = serde_json::from_str(&body).map_err(|e| {
            BrainError::new(
                BrainErrorCode::InvalidResponse,
                BrainKind::ByoApi,
                format!("Anthropic returned invalid JSON envelope: {}", e),
            )
        })?;

        let text = parsed
            .get("content")
            .and_then(|c| c.as_array())
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                BrainError::new(
                    BrainErrorCode::InvalidResponse,
                    BrainKind::ByoApi,
                    "Anthropic response missing content text block",
                )
            })?;

        Ok(text)
    }

    async fn call_openai_compatible(
        &self,
        req: &BrainRequest,
        json_mode: bool,
    ) -> Result<String, BrainError> {
        let url = format!("{}/chat/completions", self.base_url);
        let send_image =
            !req.image_base64.trim().is_empty() && self.provider.supports_vision(&self.model);

        let user_content = if send_image {
            let data_uri = format!("data:image/jpeg;base64,{}", req.image_base64);
            json!([
                { "type": "text", "text": req.user_prompt },
                {
                    "type": "image_url",
                    "image_url": { "url": data_uri }
                }
            ])
        } else {
            json!(req.user_prompt)
        };

        let max_tokens = req.max_tokens.unwrap_or(1024);
        let mut payload = json!({
            "model": self.model,
            "temperature": if json_mode { 0.1 } else { 0.3 },
            "max_tokens": max_tokens,
            "messages": [
                {
                    "role": "system",
                    "content": req.system_prompt
                },
                {
                    "role": "user",
                    "content": user_content
                }
            ]
        });

        if json_mode {
            payload["response_format"] = json!({ "type": "json_object" });
        }

        let mut builder = self
            .client
            .post(&url)
            .timeout(Duration::from_secs(30))
            .header("User-Agent", "GuideLens/2.0")
            .json(&payload);

        if !self.api_key.trim().is_empty() {
            builder = builder.bearer_auth(&self.api_key);
        }

        if self.provider == ByoProviderId::OpenRouter {
            builder = builder
                .header("HTTP-Referer", "https://guidelens.app")
                .header("X-Title", "GuideLens");
        }

        let resp = builder
            .send()
            .await
            .map_err(|e| self.map_transport_error(e))?;

        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(self.map_http_error(status, &body));
        }

        let parsed: Value = serde_json::from_str(&body).map_err(|e| {
            BrainError::new(
                BrainErrorCode::InvalidResponse,
                BrainKind::ByoApi,
                format!(
                    "{} returned invalid JSON envelope: {}",
                    self.provider.as_str(),
                    e
                ),
            )
        })?;

        let message_content = parsed
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"));

        let text = match message_content {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(parts)) => parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };

        if text.trim().is_empty() {
            return Err(BrainError::new(
                BrainErrorCode::InvalidResponse,
                BrainKind::ByoApi,
                format!(
                    "{} response missing choices[0].message.content",
                    self.provider.as_str()
                ),
            ));
        }

        Ok(text)
    }

    /// Plain-text generation (without JSON-schema forcing) for connection tests & Nightly Diary summaries.
    pub async fn generate_text(
        &self,
        system_prompt: &str,
        user_prompt: &str,
        max_tokens: u32,
    ) -> Result<String, BrainError> {
        let req = BrainRequest {
            query: user_prompt.to_string(),
            system_prompt: system_prompt.to_string(),
            user_prompt: user_prompt.to_string(),
            max_tokens: Some(max_tokens),
            ..Default::default()
        };

        match self.provider {
            ByoProviderId::Gemini => self.call_gemini(&req, false).await,
            ByoProviderId::Anthropic => self.call_anthropic(&req, false).await,
            ByoProviderId::OpenAi
            | ByoProviderId::Groq
            | ByoProviderId::OpenRouter
            | ByoProviderId::DeepSeek
            | ByoProviderId::CustomOpenAi => self.call_openai_compatible(&req, false).await,
        }
    }

    fn map_transport_error(&self, err: reqwest::Error) -> BrainError {
        if err.is_timeout() {
            BrainError::new(
                BrainErrorCode::Timeout,
                BrainKind::ByoApi,
                format!("{} request timed out", self.provider.as_str()),
            )
        } else {
            BrainError::new(
                BrainErrorCode::Unavailable,
                BrainKind::ByoApi,
                format!("Failed to reach {} API", self.provider.as_str()),
            )
        }
    }
}

#[async_trait]
impl BrainProvider for ByoApiProvider {
    fn kind(&self) -> BrainKind {
        BrainKind::ByoApi
    }

    async fn generate_plan(&self, req: &BrainRequest) -> Result<StepPlan, BrainError> {
        let raw_text = match self.provider {
            ByoProviderId::Gemini => self.call_gemini(req, true).await?,
            ByoProviderId::Anthropic => self.call_anthropic(req, true).await?,
            ByoProviderId::OpenAi
            | ByoProviderId::Groq
            | ByoProviderId::OpenRouter
            | ByoProviderId::DeepSeek
            | ByoProviderId::CustomOpenAi => self.call_openai_compatible(req, true).await?,
        };

        parse_and_repair_step_plan(&raw_text).map_err(|e| {
            BrainError::new(
                BrainErrorCode::InvalidResponse,
                BrainKind::ByoApi,
                format!(
                    "Failed to parse StepPlan from {} response: {}",
                    self.provider.as_str(),
                    e
                ),
            )
        })
    }
}

/// Transcribes recorded `audio/webm` bytes using BYO Groq Whisper or OpenAI Whisper.
pub async fn transcribe_with_whisper_api(
    base_url: &str,
    api_key: &str,
    model: &str,
    audio_bytes: Vec<u8>,
) -> Result<String, String> {
    let client = shared_http_client();

    let part = Part::bytes(audio_bytes)
        .file_name("voice.webm")
        .mime_str("audio/webm")
        .map_err(|e| format!("Invalid audio mime: {}", e))?;

    let form = Form::new()
        .text("model", model.to_string())
        .part("file", part);

    let url = format!("{}/audio/transcriptions", base_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .timeout(Duration::from_secs(30))
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|_| "Cloud STT request failed".to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Cloud STT returned HTTP {}", resp.status().as_u16()));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid STT JSON response: {}", e))?;

    Ok(body
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

/// Pure helper implementing `test_brain_connection` with real roundtrip timing.
pub async fn test_brain_connection_impl(
    settings: &Settings,
    brain_state: &BrainState,
    brain: &str,
    provider: Option<&str>,
    model: Option<&str>,
    base_url: Option<&str>,
) -> ConnectionTestResult {
    let clean_brain = brain.trim().to_ascii_lowercase();
    let started = Instant::now();

    match clean_brain.as_str() {
        "byo_api" => {
            let pid = provider
                .and_then(ByoProviderId::from_str_id)
                .or_else(|| settings.byo_provider.as_deref().and_then(ByoProviderId::from_str_id))
                .unwrap_or(ByoProviderId::OpenAi);

            let effective_model = model
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .or_else(|| {
                    if settings.byo_provider.as_deref() == Some(pid.as_str()) {
                        settings.byo_model.clone()
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| pid.default_model().to_string());

            let effective_base = base_url
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .or_else(|| {
                    if pid == ByoProviderId::CustomOpenAi {
                        settings
                            .custom_api_base_url
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(String::from)
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| pid.default_base_url().to_string());

            let api_key = brain_state
                .secrets
                .get_api_key(pid.as_str())
                .ok()
                .flatten()
                .unwrap_or_default();

            if api_key.is_empty() && pid != ByoProviderId::CustomOpenAi {
                return ConnectionTestResult {
                    ok: false,
                    brain: "byo_api".to_string(),
                    provider: Some(pid.as_str().to_string()),
                    model: Some(effective_model),
                    latency_ms: started.elapsed().as_millis() as u64,
                    message: format!(
                        "No API key saved for {}. Add it in Control Center -> Brains & Keys.",
                        pid.as_str()
                    ),
                };
            }

            let client = ByoApiProvider::with_base_url(
                pid,
                api_key,
                Some(&effective_model),
                effective_base,
            );
            match client
                .generate_text("Reply concisely.", "Reply with OK.", 16)
                .await
            {
                Ok(_) => {
                    let latency_ms = started.elapsed().as_millis() as u64;
                    ConnectionTestResult {
                        ok: true,
                        brain: "byo_api".to_string(),
                        provider: Some(pid.as_str().to_string()),
                        model: Some(effective_model.clone()),
                        latency_ms,
                        message: format!(
                            "Connected to {} ({}) in {}ms.",
                            pid.as_str(),
                            effective_model,
                            latency_ms
                        ),
                    }
                }
                Err(err) => ConnectionTestResult {
                    ok: false,
                    brain: "byo_api".to_string(),
                    provider: Some(pid.as_str().to_string()),
                    model: Some(effective_model),
                    latency_ms: started.elapsed().as_millis() as u64,
                    message: err.message,
                },
            }
        }
        "local_vlm" => {
            let effective_base = base_url
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .unwrap_or_else(resolve_ollama_base_url);
            let target_model = model
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&settings.ollama_model)
                .to_string();
            let status = ollama::check_ollama_status(&effective_base).await;
            let latency_ms = started.elapsed().as_millis() as u64;
            if !status.running {
                return ConnectionTestResult {
                    ok: false,
                    brain: "local_vlm".to_string(),
                    provider: Some("ollama".to_string()),
                    model: Some(target_model),
                    latency_ms,
                    message: format!("Ollama is not reachable at {}.", effective_base),
                };
            }
            let model_present = status.models.iter().any(|m| {
                m == &target_model
                    || m.starts_with(&format!("{}:", target_model))
                    || target_model.starts_with(&format!("{}:", m))
            });
            if model_present || status.models.is_empty() {
                ConnectionTestResult {
                    ok: true,
                    brain: "local_vlm".to_string(),
                    provider: Some("ollama".to_string()),
                    model: Some(target_model),
                    latency_ms,
                    message: format!(
                        "Ollama ready ({} model(s) installed) in {}ms.",
                        status.models.len(),
                        latency_ms
                    ),
                }
            } else {
                ConnectionTestResult {
                    ok: false,
                    brain: "local_vlm".to_string(),
                    provider: Some("ollama".to_string()),
                    model: Some(target_model.clone()),
                    latency_ms,
                    message: format!(
                        "Ollama is running, but model '{}' is not installed yet.",
                        target_model
                    ),
                }
            }
        }
        "agent_cli" => {
            let agent = provider
                .and_then(AgentId::from_str_id)
                .or_else(|| settings.agent_id.as_deref().and_then(AgentId::from_str_id))
                .unwrap_or(AgentId::Claude);
            let cli = if agent == AgentId::Custom {
                AgentCliProvider::with_custom_cmd(agent, settings.custom_agent_cmd.clone())
            } else {
                AgentCliProvider::new(agent)
            };
            match cli.probe_version().await {
                Ok(ver) => {
                    let latency_ms = started.elapsed().as_millis() as u64;
                    ConnectionTestResult {
                        ok: true,
                        brain: "agent_cli".to_string(),
                        provider: Some(agent.as_str().to_string()),
                        model: None,
                        latency_ms,
                        message: format!("{} ({}ms)", ver, latency_ms),
                    }
                }
                Err(msg) => ConnectionTestResult {
                    ok: false,
                    brain: "agent_cli".to_string(),
                    provider: Some(agent.as_str().to_string()),
                    model: None,
                    latency_ms: started.elapsed().as_millis() as u64,
                    message: msg,
                },
            }
        }
        "groq_pro" => {
            let endpoints = CloudEndpoints::from_env(Some(&settings.cloud_url));
            match groq_pro::auth_status(&brain_state.secrets, &endpoints).await {
                Ok(status) => {
                    let latency_ms = started.elapsed().as_millis() as u64;
                    let ok = status.logged_in && status.status.eq_ignore_ascii_case("active");
                    ConnectionTestResult {
                        ok,
                        brain: "groq_pro".to_string(),
                        provider: Some("groq_pro".to_string()),
                        model: None,
                        latency_ms,
                        message: if ok {
                            format!("Pro account active ({}/{})", status.usage, status.limit)
                        } else if status.logged_in {
                            format!("Signed in, subscription status: {}", status.status)
                        } else {
                            "Not signed in to GuideLens Pro.".to_string()
                        },
                    }
                }
                Err(msg) => ConnectionTestResult {
                    ok: false,
                    brain: "groq_pro".to_string(),
                    provider: Some("groq_pro".to_string()),
                    model: None,
                    latency_ms: started.elapsed().as_millis() as u64,
                    message: msg,
                },
            }
        }
        other => ConnectionTestResult {
            ok: false,
            brain: other.to_string(),
            provider: provider.map(String::from),
            model: model.map(String::from),
            latency_ms: started.elapsed().as_millis() as u64,
            message: format!("Unknown brain type '{}'", other),
        },
    }
}

/// Tests a configured brain/provider/model with a real lightweight roundtrip and returns latency.
pub async fn test_brain_connection(
    db: State<'_, DbState>,
    brain_state: State<'_, BrainState>,
    brain: String,
    provider: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<ConnectionTestResult, String> {
    let settings = db.get_settings().unwrap_or_default();
    Ok(test_brain_connection_impl(
        &settings,
        &brain_state,
        &brain,
        provider.as_deref(),
        model.as_deref(),
        base_url.as_deref(),
    )
    .await)
}

const NIGHTLY_SUMMARY_SYSTEM_PROMPT: &str = "You are GuideLens Screen Day, a thoughtful personal work-diary assistant. Summarize the user's captured day clearly in concise Markdown with sections for Highlights, Projects & Tasks, Meetings & Screen Discussions, and Follow-ups.";

/// Pure helper used by `generate_day_summary_text` (and unit tests with mocked endpoints).
pub async fn generate_day_summary_text_with_overrides(
    settings: &Settings,
    brain_state: &BrainState,
    prompt: &str,
    ollama_base_override: Option<&str>,
    byo_base_override: Option<&str>,
) -> Result<String, String> {
    let effective_mode = settings
        .summary_brain_mode
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&settings.brain_mode);

    let effective_provider = settings
        .summary_byo_provider
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(settings.byo_provider.as_deref());

    let effective_model = settings
        .summary_byo_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(settings.byo_model.as_deref());

    let candidates: Vec<BrainKind> = if !effective_mode.eq_ignore_ascii_case("auto") {
        match BrainKind::from_str(effective_mode) {
            Ok(kind) => vec![kind],
            Err(_) => vec![BrainKind::ByoApi, BrainKind::AgentCli, BrainKind::LocalVlm],
        }
    } else {
        vec![BrainKind::ByoApi, BrainKind::AgentCli, BrainKind::LocalVlm]
    };

    let full_cli_prompt = format!("{}\n\n{}", NIGHTLY_SUMMARY_SYSTEM_PROMPT, prompt);
    let mut errors = Vec::new();

    for kind in candidates {
        match kind {
            BrainKind::ByoApi => {
                let pid = effective_provider
                    .and_then(ByoProviderId::from_str_id)
                    .or_else(|| {
                        brain_state
                            .secrets
                            .list_api_key_providers()
                            .ok()
                            .and_then(|list| list.into_iter().find_map(|p| ByoProviderId::from_str_id(&p)))
                    });

                if let Some(pid) = pid {
                    let key = brain_state
                        .secrets
                        .get_api_key(pid.as_str())
                        .ok()
                        .flatten()
                        .unwrap_or_default();
                    let has_custom_base = pid == ByoProviderId::CustomOpenAi
                        && settings
                            .custom_api_base_url
                            .as_deref()
                            .is_some_and(|u| !u.trim().is_empty());

                    if !key.is_empty() || has_custom_base || byo_base_override.is_some() {
                        let base = byo_base_override
                            .or_else(|| {
                                if pid == ByoProviderId::CustomOpenAi {
                                    settings
                                        .custom_api_base_url
                                        .as_deref()
                                        .map(str::trim)
                                        .filter(|s| !s.is_empty())
                                } else {
                                    None
                                }
                            })
                            .unwrap_or_else(|| pid.default_base_url());
                        let provider =
                            ByoApiProvider::with_base_url(pid, key, effective_model, base);
                        match provider
                            .generate_text(NIGHTLY_SUMMARY_SYSTEM_PROMPT, prompt, 900)
                            .await
                        {
                            Ok(text) if !text.trim().is_empty() => return Ok(text),
                            Ok(_) => errors.push("BYO API returned empty summary".to_string()),
                            Err(e) => errors.push(e.message),
                        }
                    } else {
                        errors.push(format!("No API key configured for {}", pid.as_str()));
                    }
                } else {
                    errors.push("No BYO API provider configured".to_string());
                }
            }
            BrainKind::AgentCli => {
                let detected =
                    brain_state.detect_agents_cached(settings.custom_agent_cmd.as_deref());
                let chosen = settings
                    .agent_id
                    .as_deref()
                    .and_then(AgentId::from_str_id)
                    .filter(|id| {
                        detected
                            .iter()
                            .any(|d| d.id == id.as_str() && d.installed)
                    })
                    .or_else(|| {
                        detected
                            .iter()
                            .find(|d| d.installed)
                            .and_then(|d| AgentId::from_str_id(&d.id))
                    });

                if let Some(agent) = chosen {
                    let cli = if agent == AgentId::Custom {
                        AgentCliProvider::with_custom_cmd(agent, settings.custom_agent_cmd.clone())
                    } else {
                        AgentCliProvider::new(agent)
                    };
                    match cli.generate_text(&full_cli_prompt).await {
                        Ok(text) if !text.trim().is_empty() => return Ok(text),
                        Ok(_) => errors.push("Agent CLI returned empty summary".to_string()),
                        Err(e) => errors.push(e),
                    }
                } else {
                    errors.push("No Agent CLI installed".to_string());
                }
            }
            BrainKind::LocalVlm => {
                let base = ollama_base_override
                    .map(String::from)
                    .unwrap_or_else(resolve_ollama_base_url);
                let model = if effective_mode.eq_ignore_ascii_case("local_vlm") {
                    effective_model.unwrap_or(&settings.ollama_model)
                } else {
                    &settings.ollama_model
                };
                let provider = OllamaProvider::with_base_url(base, model);
                match provider
                    .generate_text(NIGHTLY_SUMMARY_SYSTEM_PROMPT, prompt)
                    .await
                {
                    Ok(text) if !text.trim().is_empty() => return Ok(text),
                    Ok(_) => errors.push("Ollama returned empty summary".to_string()),
                    Err(e) => errors.push(e.message),
                }
            }
            BrainKind::GroqPro | BrainKind::AgentMcp => {
                let _ = agent_cli::detect_agents();
                errors.push("Groq Pro / MCP does not serve plain-text diary summaries".to_string());
            }
        }
    }

    Err(if errors.is_empty() {
        "No summary brain available".to_string()
    } else {
        errors.join("; ")
    })
}

/// Generates a Nightly Diary summary using `summary_brain_mode` / `summary_byo_provider` / `summary_byo_model`
/// when configured, falling back to the primary brain configuration.
pub async fn generate_day_summary_text(
    db: &DbState,
    brain_state: &BrainState,
    prompt: &str,
) -> Result<String, String> {
    let settings = db.get_settings().unwrap_or_default();
    generate_day_summary_text_with_overrides(&settings, brain_state, prompt, None, None).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn sample_req() -> BrainRequest {
        BrainRequest {
            query: "Open Settings".to_string(),
            image_base64: "aGVsbG8=".to_string(),
            image_path: "C:\\temp\\screen.jpg".to_string(),
            active_app: "Code.exe".to_string(),
            window_title: "Visual Studio Code".to_string(),
            screen_resolution: (1920, 1080),
            system_prompt: "Output StepPlan JSON".to_string(),
            user_prompt: "Open Settings".to_string(),
            conversation_history: vec![],
            ..Default::default()
        }
    }

    fn sample_plan_json() -> &'static str {
        r#"{
            "mode": "guide",
            "total_steps": 1,
            "steps": [{
                "step_number": 1,
                "instruction_line": "Click the gear icon at the bottom-left, or press Ctrl+,.",
                "target_name": "Manage",
                "control_type": "Button",
                "bbox": [10, 930, 32, 32],
                "confidence": 0.94,
                "shortcut": "Ctrl+,"
            }]
        }"#
    }

    #[tokio::test]
    async fn gemini_parses_step_plan_and_sends_header_key() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1beta/models/gemini-2.5-flash:generateContent"))
            .and(header("x-goog-api-key", "secret-gemini-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "candidates": [{
                    "content": {
                        "parts": [{ "text": sample_plan_json() }]
                    }
                }]
            })))
            .mount(&server)
            .await;

        let provider = ByoApiProvider::with_base_url(
            ByoProviderId::Gemini,
            "secret-gemini-key",
            None,
            server.uri(),
        );
        let plan = provider.generate_plan(&sample_req()).await.unwrap();
        assert_eq!(plan.steps[0].shortcut.as_deref(), Some("Ctrl+,"));
        assert!(!format!("{:?}", provider).contains("secret-gemini-key"));
    }

    #[tokio::test]
    async fn anthropic_parses_step_plan() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/messages"))
            .and(header("x-api-key", "sk-ant-test"))
            .and(header("anthropic-version", "2023-06-01"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "content": [{ "type": "text", "text": sample_plan_json() }]
            })))
            .mount(&server)
            .await;

        let provider = ByoApiProvider::with_base_url(
            ByoProviderId::Anthropic,
            "sk-ant-test",
            None,
            server.uri(),
        );
        let plan = provider.generate_plan(&sample_req()).await.unwrap();
        assert_eq!(plan.total_steps, 1);
        assert_eq!(plan.steps[0].target_name.as_deref(), Some("Manage"));
    }

    #[tokio::test]
    async fn openai_groq_openrouter_deepseek_custom_parse_and_map_errors() {
        for pid in [
            ByoProviderId::OpenAi,
            ByoProviderId::Groq,
            ByoProviderId::OpenRouter,
            ByoProviderId::DeepSeek,
            ByoProviderId::CustomOpenAi,
        ] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/chat/completions"))
                .and(header("authorization", "Bearer test-token"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "choices": [{
                        "message": { "content": sample_plan_json() }
                    }]
                })))
                .mount(&server)
                .await;

            let provider = ByoApiProvider::with_base_url(pid, "test-token", None, server.uri());
            let plan = provider.generate_plan(&sample_req()).await.unwrap();
            assert_eq!(plan.steps[0].control_type.as_deref(), Some("Button"));
        }

        // Verify 401 maps to Unauthenticated without leaking key
        let err_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(401).set_body_string("Invalid API key"))
            .mount(&err_server)
            .await;

        let bad = ByoApiProvider::with_base_url(
            ByoProviderId::OpenAi,
            "sk-super-secret-xyz",
            None,
            err_server.uri(),
        );
        let err = bad.generate_plan(&sample_req()).await.unwrap_err();
        assert_eq!(err.code, BrainErrorCode::Unauthenticated);
        assert!(!err.message.contains("sk-super-secret-xyz"));
    }

    #[tokio::test]
    async fn test_brain_connection_and_day_summary_override_work() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{
                    "message": { "content": "# Highlights\n- Built GuideLens v2" }
                }]
            })))
            .mount(&server)
            .await;

        let brain_state = BrainState::new();
        let brain_state = BrainState {
            secrets: crate::brain::secrets::SecretStore::new_memory(),
            ..brain_state
        };
        brain_state
            .secrets
            .set_api_key("deepseek", "sk-ds-test")
            .unwrap();

        let settings = Settings {
            brain_mode: "local_vlm".to_string(),
            summary_brain_mode: Some("byo_api".to_string()),
            summary_byo_provider: Some("deepseek".to_string()),
            summary_byo_model: Some("deepseek-chat".to_string()),
            custom_api_base_url: Some(server.uri()),
            ..Default::default()
        };

        let conn_res = test_brain_connection_impl(
            &settings,
            &brain_state,
            "byo_api",
            Some("deepseek"),
            Some("deepseek-chat"),
            Some(&server.uri()),
        )
        .await;
        assert!(conn_res.ok, "expected connection test ok: {:?}", conn_res);
        assert_eq!(conn_res.provider.as_deref(), Some("deepseek"));

        let summary = generate_day_summary_text_with_overrides(
            &settings,
            &brain_state,
            "Summarize today's commits",
            None,
            Some(&server.uri()),
        )
        .await
        .expect("summary text should succeed");
        assert!(summary.contains("Built GuideLens v2"));
    }

    #[tokio::test]
    async fn whisper_transcribe_parses_text() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/audio/transcriptions"))
            .and(header("authorization", "Bearer stt-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "text": "How do I undo my last commit?"
            })))
            .mount(&server)
            .await;

        let text = transcribe_with_whisper_api(
            &server.uri(),
            "stt-key",
            "whisper-large-v3-turbo",
            vec![1, 2, 3, 4],
        )
        .await
        .unwrap();
        assert_eq!(text, "How do I undo my last commit?");
    }

    #[tokio::test]
    async fn text_only_requests_omit_image_fields_across_all_byo_providers() {
        let mut text_req = sample_req();
        text_req.image_base64 = "   ".to_string();
        text_req.image_path = String::new();
        text_req.max_tokens = Some(260);

        // 1. Gemini omits inlineData
        let gem_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1beta/models/gemini-2.5-flash:generateContent"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "candidates": [{ "content": { "parts": [{ "text": sample_plan_json() }] } }]
            })))
            .mount(&gem_server)
            .await;
        let gem = ByoApiProvider::with_base_url(ByoProviderId::Gemini, "k", None, gem_server.uri());
        gem.generate_plan(&text_req).await.unwrap();
        let gem_body = String::from_utf8_lossy(&gem_server.received_requests().await.unwrap()[0].body).into_owned();
        assert!(!gem_body.contains("inlineData"));

        // 2. Anthropic omits image content block
        let ant_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "content": [{ "type": "text", "text": sample_plan_json() }]
            })))
            .mount(&ant_server)
            .await;
        let ant = ByoApiProvider::with_base_url(ByoProviderId::Anthropic, "k", None, ant_server.uri());
        ant.generate_plan(&text_req).await.unwrap();
        let ant_body = String::from_utf8_lossy(&ant_server.received_requests().await.unwrap()[0].body).into_owned();
        assert!(!ant_body.contains("\"type\":\"image\""));

        // 3. OpenAI, Groq, OpenRouter, DeepSeek, CustomOpenAi omit image_url
        for pid in [
            ByoProviderId::OpenAi,
            ByoProviderId::Groq,
            ByoProviderId::OpenRouter,
            ByoProviderId::DeepSeek,
            ByoProviderId::CustomOpenAi,
        ] {
            let oai_server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/chat/completions"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "choices": [{ "message": { "content": sample_plan_json() } }]
                })))
                .mount(&oai_server)
                .await;
            let prov = ByoApiProvider::with_base_url(pid, "k", None, oai_server.uri());
            prov.generate_plan(&text_req).await.unwrap();
            let raw_body = String::from_utf8_lossy(&oai_server.received_requests().await.unwrap()[0].body).into_owned();
            assert!(!raw_body.contains("image_url"), "provider {:?} sent image_url on empty image", pid);
        }
    }
}
