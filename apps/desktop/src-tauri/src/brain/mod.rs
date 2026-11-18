//! Multi-brain reasoning engine: router, providers, prompts, profiles, and secret storage.

pub mod agent_cli;
pub mod byo_api;
pub mod commands;
pub mod groq_pro;
pub mod json_repair;
pub mod ollama;
pub mod prompts;
pub mod provider;
pub mod router;
pub mod secrets;

use crate::brain::groq_pro::AuthStatus;
use crate::brain::secrets::SecretStore;
use crate::types::StepPlan;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::RwLock;

#[derive(Clone, Default)]
pub struct BrainState {
    pub secrets: SecretStore,
    pub cached_auth: Arc<RwLock<Option<AuthStatus>>>,
    history: Arc<Mutex<VecDeque<String>>>,
}

impl BrainState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_history(&self, query: &str, plan: &StepPlan) {
        let Ok(mut guard) = self.history.lock() else {
            return;
        };
        let summary = plan
            .steps
            .first()
            .map(|s| s.instruction_line.as_str())
            .unwrap_or("");
        guard.push_back(format!("Q: {} -> {}", query.trim(), summary));
        while guard.len() > 6 {
            guard.pop_front();
        }
    }

    pub fn recent_history(&self) -> Vec<String> {
        self.history
            .lock()
            .map(|g| g.iter().cloned().collect())
            .unwrap_or_default()
    }
}
