//! Common async trait, request context, and structured error types for all brain providers.

use crate::types::{BrainKind, StepPlan};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Default)]
pub struct BrainRequest {
    pub query: String,
    pub image_base64: String,
    pub image_path: String,
    pub active_app: String,
    pub window_title: String,
    pub screen_resolution: (u32, u32),
    pub system_prompt: String,
    pub user_prompt: String,
    pub conversation_history: Vec<String>,
    pub has_som: bool,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrainErrorCode {
    Timeout,
    RateLimited,
    Quota,
    NotPro,
    Unauthenticated,
    Unavailable,
    InvalidResponse,
    Unknown,
}

impl BrainErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            BrainErrorCode::Timeout => "timeout",
            BrainErrorCode::RateLimited => "rate_limited",
            BrainErrorCode::Quota => "quota",
            BrainErrorCode::NotPro => "not_pro",
            BrainErrorCode::Unauthenticated => "unauthenticated",
            BrainErrorCode::Unavailable => "unavailable",
            BrainErrorCode::InvalidResponse => "invalid_response",
            BrainErrorCode::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrainError {
    pub code: BrainErrorCode,
    pub brain: BrainKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
}

impl BrainError {
    pub fn new(code: BrainErrorCode, brain: BrainKind, message: impl Into<String>) -> Self {
        Self {
            code,
            brain,
            message: message.into(),
            retry_after: None,
        }
    }

    pub fn with_retry_after(mut self, retry_after: Option<u64>) -> Self {
        self.retry_after = retry_after;
        self
    }

    pub fn is_fallback_eligible(&self) -> bool {
        matches!(
            self.code,
            BrainErrorCode::Timeout
                | BrainErrorCode::RateLimited
                | BrainErrorCode::Quota
                | BrainErrorCode::Unavailable
        )
    }

    pub fn to_ipc_error_json(&self, fallbacks: Vec<BrainKind>) -> String {
        let payload = AskErrorPayload {
            code: self.code,
            brain: self.brain,
            message: self.message.clone(),
            fallbacks,
        };
        serde_json::to_string(&payload).unwrap_or_else(|_| self.message.clone())
    }
}

impl fmt::Display for BrainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "[{} / {}] {}",
            self.brain.as_str(),
            self.code.as_str(),
            self.message
        )
    }
}

impl std::error::Error for BrainError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskErrorPayload {
    pub code: BrainErrorCode,
    pub brain: BrainKind,
    pub message: String,
    pub fallbacks: Vec<BrainKind>,
}

#[async_trait]
pub trait BrainProvider: Send + Sync {
    fn kind(&self) -> BrainKind;
    async fn generate_plan(&self, req: &BrainRequest) -> Result<StepPlan, BrainError>;
}
