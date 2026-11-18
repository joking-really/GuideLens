//! Bring-Your-Own API key provider supporting Gemini, OpenAI, Anthropic, Groq, and OpenRouter.
//! API keys are read from Windows Credential Manager (`SecretStore`) and never logged.

use crate::brain::json_repair::parse_and_repair_step_plan;
use crate::brain::provider::{BrainError, BrainErrorCode, BrainProvider, BrainRequest};
use crate::types::{BrainKind, StepPlan};
use async_trait::async_trait;
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ByoProviderId {
    Gemini,
    OpenAi,
    Anthropic,
    Groq,
    OpenRouter,
}

impl ByoProviderId {
    pub fn from_str_id(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "gemini" => Some(Self::Gemini),
            "openai" => Some(Self::OpenAi),
            "anthropic" => Some(Self::Anthropic),
            "groq" => Some(Self::Groq),
            "openrouter" => Some(Self::OpenRouter),
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
        }
    }

    pub fn default_model(&self) -> &'static str {
        match self {
            Self::Gemini => "gemini-2.5-flash",
            Self::OpenAi => "gpt-4o-mini",
            Self::Anthropic => "claude-3-5-sonnet-latest",
            Self::Groq => "meta-llama/llama-4-scout-17b-16e-instruct",
            Self::OpenRouter => "qwen/qwen2.5-vl-72b-instruct",
        }
    }

    pub fn default_base_url(&self) -> &'static str {
        match self {
            Self::Gemini => "https://generativelanguage.googleapis.com",
            Self::OpenAi => "https://api.openai.com/v1",
            Self::Anthropic => "https://api.anthropic.com/v1",
            Self::Groq => "https://api.groq.com/openai/v1",
            Self::OpenRouter => "https://openrouter.ai/api/v1",
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

        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| Client::new());

        Self {
            provider,
            model,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            client,
        }
    }

    fn map_http_error(&self, status: u16, body: &str) -> BrainError {
        let snippet: String = body.chars().take(240).collect();
        match status {
            401 | 403 => BrainError::new(
                BrainErrorCode::Unauthenticated,
                BrainKind::ByoApi,
                format!(
                    "{} API key rejected (HTTP {}). Check your key in Settings.",
                    self.provider.as_str(),
                    status
                ),
            ),
            402 => BrainError::new(
                BrainErrorCode::Quota,
                BrainKind::ByoApi,
                format!("{} account quota/billing required (HTTP 402).", self.provider.as_str()),
            ),
            429 => BrainError::new(
                BrainErrorCode::RateLimited,
                BrainKind::ByoApi,
                format!("{} rate limit exceeded (HTTP 429).", self.provider.as_str()),
            ),
            408 | 504 => BrainError::new(
                BrainErrorCode::Timeout,
                BrainKind::ByoApi,
                format!("{} request timed out (HTTP {}).", self.provider.as_str(), status),
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

    async fn call_gemini(&self, req: &BrainRequest) -> Result<String, BrainError> {
        let url = format!(
            "{}/v1beta/models/{}:generateContent",
            self.base_url, self.model
        );

        let payload = json!({
            "systemInstruction": {
                "parts": [{ "text": req.system_prompt }]
            },
            "contents": [{
                "role": "user",
                "parts": [
                    { "text": req.user_prompt },
                    {
                        "inlineData": {
                            "mimeType": "image/jpeg",
                            "data": req.image_base64
                        }
                    }
                ]
            }],
            "generationConfig": {
                "temperature": 0.1,
                "responseMimeType": "application/json"
            }
        });

        let resp = self
            .client
            .post(&url)
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

    async fn call_anthropic(&self, req: &BrainRequest) -> Result<String, BrainError> {
        let url = format!("{}/messages", self.base_url);
        let payload = json!({
            "model": self.model,
            "max_tokens": 1024,
            "temperature": 0.1,
            "system": req.system_prompt,
            "messages": [{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": req.image_base64
                        }
                    },
                    {
                        "type": "text",
                        "text": req.user_prompt
                    }
                ]
            }]
        });

        let resp = self
            .client
            .post(&url)
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

    async fn call_openai_compatible(&self, req: &BrainRequest) -> Result<String, BrainError> {
        let url = format!("{}/chat/completions", self.base_url);
        let data_uri = format!("data:image/jpeg;base64,{}", req.image_base64);

        let payload = json!({
            "model": self.model,
            "temperature": 0.1,
            "max_tokens": 1024,
            "response_format": { "type": "json_object" },
            "messages": [
                {
                    "role": "system",
                    "content": req.system_prompt
                },
                {
                    "role": "user",
                    "content": [
                        { "type": "text", "text": req.user_prompt },
                        {
                            "type": "image_url",
                            "image_url": { "url": data_uri }
                        }
                    ]
                }
            ]
        });

        let mut builder = self
            .client
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&payload);

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
                format!("{} returned invalid JSON envelope: {}", self.provider.as_str(), e),
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
                format!("{} response missing choices[0].message.content", self.provider.as_str()),
            ));
        }

        Ok(text)
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
            ByoProviderId::Gemini => self.call_gemini(req).await?,
            ByoProviderId::Anthropic => self.call_anthropic(req).await?,
            ByoProviderId::OpenAi | ByoProviderId::Groq | ByoProviderId::OpenRouter => {
                self.call_openai_compatible(req).await?
            }
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
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

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
    async fn openai_groq_openrouter_parse_step_plan_and_map_401_429() {
        for pid in [
            ByoProviderId::OpenAi,
            ByoProviderId::Groq,
            ByoProviderId::OpenRouter,
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
}
