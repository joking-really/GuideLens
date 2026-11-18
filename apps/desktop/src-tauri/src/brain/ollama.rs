//! Local Ollama VLM provider (`localhost:11434/api/chat`), status detection, and model pull with progress events.

use crate::brain::json_repair::parse_and_repair_step_plan;
use crate::brain::provider::{BrainError, BrainErrorCode, BrainProvider, BrainRequest};
use crate::types::{BrainKind, OllamaPullProgressPayload, StepPlan};
use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OllamaStatus {
    pub running: bool,
    pub models: Vec<String>,
    pub install_url: String,
}

pub const DEFAULT_OLLAMA_URL: &str = "http://127.0.0.1:11434";
pub const DEFAULT_OLLAMA_MODEL: &str = "qwen2.5vl:3b";
pub const SUPPORTED_OLLAMA_MODELS: &[&str] = &[
    "qwen2.5vl:3b",
    "qwen2.5vl:7b",
    "llama3.2-vision",
];
pub const OLLAMA_INSTALL_URL: &str = "https://ollama.com/download";

pub fn resolve_ollama_base_url() -> String {
    std::env::var("OLLAMA_HOST")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .map(|v| {
            if v.starts_with("http://") || v.starts_with("https://") {
                v
            } else {
                format!("http://{}", v)
            }
        })
        .unwrap_or_else(|| DEFAULT_OLLAMA_URL.to_string())
}

#[derive(Debug, Clone)]
pub struct OllamaProvider {
    pub base_url: String,
    pub model: String,
    client: Client,
}

impl OllamaProvider {
    pub fn new(model: impl Into<String>) -> Self {
        Self::with_base_url(resolve_ollama_base_url(), model)
    }

    pub fn with_base_url(base_url: impl Into<String>, model: impl Into<String>) -> Self {
        let model_str = model.into();
        let effective_model = if model_str.trim().is_empty() {
            DEFAULT_OLLAMA_MODEL.to_string()
        } else {
            model_str.trim().to_string()
        };

        let client = Client::builder()
            .timeout(Duration::from_secs(45))
            .build()
            .unwrap_or_else(|_| Client::new());

        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            model: effective_model,
            client,
        }
    }
}

#[async_trait]
impl BrainProvider for OllamaProvider {
    fn kind(&self) -> BrainKind {
        BrainKind::LocalVlm
    }

    async fn generate_plan(&self, req: &BrainRequest) -> Result<StepPlan, BrainError> {
        let url = format!("{}/api/chat", self.base_url);
        let payload = json!({
            "model": self.model,
            "stream": false,
            "format": "json",
            "messages": [
                {
                    "role": "system",
                    "content": req.system_prompt
                },
                {
                    "role": "user",
                    "content": req.user_prompt,
                    "images": [req.image_base64]
                }
            ],
            "options": {
                "temperature": 0.1
            }
        });

        let resp = self
            .client
            .post(&url)
            .json(&payload)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    BrainError::new(
                        BrainErrorCode::Timeout,
                        BrainKind::LocalVlm,
                        format!("Ollama request timed out ({})", self.model),
                    )
                } else {
                    BrainError::new(
                        BrainErrorCode::Unavailable,
                        BrainKind::LocalVlm,
                        format!(
                            "Ollama is not reachable at {}. Start Ollama or pull {}.",
                            self.base_url, self.model
                        ),
                    )
                }
            })?;

        let status = resp.status();
        let body_text = resp.text().await.map_err(|e| {
            BrainError::new(
                BrainErrorCode::InvalidResponse,
                BrainKind::LocalVlm,
                format!("Failed to read Ollama response body: {}", e),
            )
        })?;

        if !status.is_success() {
            let code = if status.as_u16() == 404 {
                BrainErrorCode::Unavailable
            } else if status.as_u16() == 408 || status.as_u16() == 504 {
                BrainErrorCode::Timeout
            } else {
                BrainErrorCode::Unknown
            };
            return Err(BrainError::new(
                code,
                BrainKind::LocalVlm,
                format!(
                    "Ollama returned HTTP {} for model '{}': {}",
                    status.as_u16(),
                    self.model,
                    body_text
                ),
            ));
        }

        let json_body: Value = serde_json::from_str(&body_text).map_err(|e| {
            BrainError::new(
                BrainErrorCode::InvalidResponse,
                BrainKind::LocalVlm,
                format!("Ollama returned invalid JSON envelope: {}", e),
            )
        })?;

        if let Some(err_msg) = json_body.get("error").and_then(|v| v.as_str()) {
            return Err(BrainError::new(
                BrainErrorCode::Unavailable,
                BrainKind::LocalVlm,
                format!("Ollama error: {}", err_msg),
            ));
        }

        let content = json_body
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .or_else(|| json_body.get("response").and_then(|r| r.as_str()))
            .ok_or_else(|| {
                BrainError::new(
                    BrainErrorCode::InvalidResponse,
                    BrainKind::LocalVlm,
                    "Ollama response missing 'message.content' field",
                )
            })?;

        parse_and_repair_step_plan(content).map_err(|e| {
            BrainError::new(
                BrainErrorCode::InvalidResponse,
                BrainKind::LocalVlm,
                format!("Failed to parse StepPlan from Ollama output: {}", e),
            )
        })
    }
}

#[derive(Debug, Deserialize)]
struct OllamaTagsResponse {
    #[serde(default)]
    models: Vec<OllamaTagModel>,
}

#[derive(Debug, Deserialize)]
struct OllamaTagModel {
    name: String,
}

/// Checks if Ollama is running on `base_url` and lists installed model tags.
pub async fn check_ollama_status(base_url: &str) -> OllamaStatus {
    let client = Client::builder()
        .timeout(Duration::from_millis(2500))
        .build()
        .unwrap_or_else(|_| Client::new());

    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let models = resp
                .json::<OllamaTagsResponse>()
                .await
                .map(|t| t.models.into_iter().map(|m| m.name).collect())
                .unwrap_or_default();
            OllamaStatus {
                running: true,
                models,
                install_url: OLLAMA_INSTALL_URL.to_string(),
            }
        }
        _ => OllamaStatus {
            running: false,
            models: Vec::new(),
            install_url: OLLAMA_INSTALL_URL.to_string(),
        },
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct PullStreamLine {
    #[serde(default)]
    status: String,
    #[serde(default)]
    completed: Option<u64>,
    #[serde(default)]
    total: Option<u64>,
    #[serde(default)]
    error: Option<String>,
}

/// Pulls an Ollama model with streaming progress callbacks (`0.0..=100.0`).
pub async fn pull_ollama_model<F>(
    base_url: &str,
    model: &str,
    mut on_progress: F,
) -> Result<(), String>
where
    F: FnMut(OllamaPullProgressPayload) + Send,
{
    let trimmed_model = model.trim();
    if trimmed_model.is_empty() {
        return Err("Model name must not be empty".to_string());
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(60 * 30))
        .build()
        .map_err(|e| format!("Failed to initialize HTTP client: {}", e))?;

    let url = format!("{}/api/pull", base_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .json(&json!({
            "name": trimmed_model,
            "stream": true
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama at {}: {}", base_url, e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let err_body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Ollama pull failed with HTTP {}: {}",
            status.as_u16(),
            err_body
        ));
    }

    on_progress(OllamaPullProgressPayload {
        model: trimmed_model.to_string(),
        pct: 0.0,
        status: Some("starting".to_string()),
    });

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut last_pct = 0.0f64;

    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| format!("Error reading Ollama pull stream: {}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim().to_string();
            buffer.drain(..=newline_pos);
            if line.is_empty() {
                continue;
            }
            if let Ok(parsed) = serde_json::from_str::<PullStreamLine>(&line) {
                if let Some(err) = parsed.error {
                    return Err(format!("Ollama pull error: {}", err));
                }
                let pct = match (parsed.completed, parsed.total) {
                    (Some(done), Some(total)) if total > 0 => {
                        ((done as f64 / total as f64) * 100.0).clamp(0.0, 100.0).round()
                    }
                    _ if parsed.status.eq_ignore_ascii_case("success") => 100.0,
                    _ => last_pct,
                };
                last_pct = pct;
                on_progress(OllamaPullProgressPayload {
                    model: trimmed_model.to_string(),
                    pct,
                    status: if parsed.status.is_empty() {
                        None
                    } else {
                        Some(parsed.status)
                    },
                });
            }
        }
    }

    // Flush any remaining trailing line
    let rem = buffer.trim();
    if !rem.is_empty() {
        if let Ok(parsed) = serde_json::from_str::<PullStreamLine>(rem) {
            if let Some(err) = parsed.error {
                return Err(format!("Ollama pull error: {}", err));
            }
        }
    }

    on_progress(OllamaPullProgressPayload {
        model: trimmed_model.to_string(),
        pct: 100.0,
        status: Some("success".to_string()),
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn sample_request() -> BrainRequest {
        BrainRequest {
            query: "How do I select the brush tool?".to_string(),
            image_base64: "aGVsbG8=".to_string(),
            image_path: "C:\\temp\\cap.jpg".to_string(),
            active_app: "Photoshop.exe".to_string(),
            window_title: "Adobe Photoshop".to_string(),
            screen_resolution: (1920, 1080),
            system_prompt: "Return StepPlan JSON".to_string(),
            user_prompt: "How do I select the brush tool?".to_string(),
            conversation_history: vec![],
        }
    }

    #[tokio::test]
    async fn ollama_chat_parses_step_plan() {
        let server = MockServer::start().await;
        let step_plan_str = r#"{
            "mode": "guide",
            "total_steps": 1,
            "steps": [{
                "step_number": 1,
                "instruction_line": "Click the Brush Tool in the left toolbar, or press B.",
                "target_name": "Brush Tool",
                "control_type": "Button",
                "bbox": [18, 290, 28, 28],
                "confidence": 0.91,
                "shortcut": "B"
            }]
        }"#;

        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "model": "qwen2.5vl:3b",
                "message": {
                    "role": "assistant",
                    "content": step_plan_str
                },
                "done": true
            })))
            .mount(&server)
            .await;

        let provider = OllamaProvider::with_base_url(server.uri(), "qwen2.5vl:3b");
        let plan = provider
            .generate_plan(&sample_request())
            .await
            .expect("Ollama StepPlan");

        assert_eq!(plan.total_steps, 1);
        assert_eq!(plan.steps[0].shortcut.as_deref(), Some("B"));
        assert_eq!(plan.steps[0].target_name.as_deref(), Some("Brush Tool"));
    }

    #[tokio::test]
    async fn ollama_status_and_pull_progress_work() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "models": [
                    { "name": "qwen2.5vl:3b" },
                    { "name": "llama3.2-vision:latest" }
                ]
            })))
            .mount(&server)
            .await;

        let status = check_ollama_status(&server.uri()).await;
        assert!(status.running);
        assert_eq!(status.models, vec!["qwen2.5vl:3b", "llama3.2-vision:latest"]);

        let ndjson = concat!(
            r#"{"status":"pulling manifest"}"#, "\n",
            r#"{"status":"downloading","completed":500,"total":1000}"#, "\n",
            r#"{"status":"downloading","completed":1000,"total":1000}"#, "\n",
            r#"{"status":"success"}"#, "\n"
        );

        Mock::given(method("POST"))
            .and(path("/api/pull"))
            .respond_with(ResponseTemplate::new(200).set_body_string(ndjson))
            .mount(&server)
            .await;

        let mut events = Vec::new();
        pull_ollama_model(&server.uri(), "qwen2.5vl:3b", |ev| {
            events.push(ev);
        })
        .await
        .expect("pull should succeed");

        assert!(events.iter().any(|e| (e.pct - 50.0).abs() < 1e-6));
        assert_eq!(events.last().map(|e| e.pct), Some(100.0));
    }
}
