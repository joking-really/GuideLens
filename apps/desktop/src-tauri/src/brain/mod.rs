//! Multi-brain reasoning engine: router, providers, prompts, profiles, latency telemetry, and secret storage.

pub mod agent_cli;
pub mod byo_api;
pub mod commands;
pub mod groq_pro;
pub mod http_client;
pub mod json_repair;
pub mod ollama;
pub mod prompts;
pub mod provider;
pub mod router;
pub mod secrets;

use crate::brain::agent_cli::{detect_agents_uncached, DetectedAgent};
use crate::brain::groq_pro::AuthStatus;
use crate::brain::secrets::SecretStore;
use crate::types::{LatencyBreakdown, StepPlan};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

const MAX_LATENCY_SAMPLES: usize = 100;
const AGENT_CACHE_TTL: Duration = Duration::from_secs(60);

type AgentCacheEntry = Option<(Instant, Vec<DetectedAgent>)>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct LatencyStats {
    pub recent: Vec<LatencyBreakdown>,
    pub average: Option<LatencyBreakdown>,
    pub count: usize,
}

#[derive(Clone, Default)]
pub struct BrainState {
    pub secrets: SecretStore,
    pub cached_auth: Arc<RwLock<Option<AuthStatus>>>,
    history: Arc<Mutex<VecDeque<String>>>,
    latency_history: Arc<Mutex<VecDeque<LatencyBreakdown>>>,
    agent_cache: Arc<Mutex<AgentCacheEntry>>,
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

    pub fn record_latency(&self, sample: LatencyBreakdown) {
        let Ok(mut guard) = self.latency_history.lock() else {
            return;
        };
        guard.push_back(sample);
        while guard.len() > MAX_LATENCY_SAMPLES {
            guard.pop_front();
        }
    }

    pub fn latency_stats(&self, limit: usize) -> LatencyStats {
        let Ok(guard) = self.latency_history.lock() else {
            return LatencyStats::default();
        };
        let total_count = guard.len();
        if total_count == 0 {
            return LatencyStats::default();
        }

        let take_n = limit.clamp(1, MAX_LATENCY_SAMPLES);
        let skip = total_count.saturating_sub(take_n);
        let recent: Vec<LatencyBreakdown> = guard.iter().skip(skip).copied().collect();

        let (mut cap, mut gnd, mut mem, mut llm, mut tot) = (0u128, 0u128, 0u128, 0u128, 0u128);
        for item in guard.iter() {
            cap += item.capture_ms as u128;
            gnd += item.grounding_ms as u128;
            mem += item.memory_ms as u128;
            llm += item.llm_ms as u128;
            tot += item.total_ms as u128;
        }
        let n = total_count as u128;
        let average = Some(LatencyBreakdown {
            capture_ms: (cap / n) as u64,
            grounding_ms: (gnd / n) as u64,
            memory_ms: (mem / n) as u64,
            llm_ms: (llm / n) as u64,
            total_ms: (tot / n) as u64,
        });

        LatencyStats {
            recent,
            average,
            count: total_count,
        }
    }

    /// Returns detected agent CLIs cached with a 60s TTL (or refreshes when custom command changes).
    pub fn detect_agents_cached(&self, custom_cmd: Option<&str>) -> Vec<DetectedAgent> {
        if let Some(cmd) = custom_cmd.map(str::trim).filter(|s| !s.is_empty()) {
            return agent_cli::detect_agents_with_custom(Some(cmd));
        }
        if let Ok(guard) = self.agent_cache.lock() {
            if let Some((captured_at, ref list)) = *guard {
                if captured_at.elapsed() < AGENT_CACHE_TTL {
                    return list.clone();
                }
            }
        }
        let fresh = detect_agents_uncached(None);
        if let Ok(mut guard) = self.agent_cache.lock() {
            *guard = Some((Instant::now(), fresh.clone()));
        }
        fresh
    }

    pub fn invalidate_agent_cache(&self) {
        if let Ok(mut guard) = self.agent_cache.lock() {
            *guard = None;
        }
        agent_cli::invalidate_agent_cache();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_summarizes_latency_ring_buffer() {
        let state = BrainState::new();
        assert_eq!(state.latency_stats(25).count, 0);
        assert_eq!(state.latency_stats(25).average, None);

        state.record_latency(LatencyBreakdown {
            capture_ms: 10,
            grounding_ms: 20,
            memory_ms: 2,
            llm_ms: 100,
            total_ms: 132,
        });
        state.record_latency(LatencyBreakdown {
            capture_ms: 20,
            grounding_ms: 40,
            memory_ms: 4,
            llm_ms: 200,
            total_ms: 264,
        });

        let stats = state.latency_stats(1);
        assert_eq!(stats.count, 2);
        assert_eq!(stats.recent.len(), 1);
        assert_eq!(stats.recent[0].total_ms, 264);
        assert_eq!(
            stats.average,
            Some(LatencyBreakdown {
                capture_ms: 15,
                grounding_ms: 30,
                memory_ms: 3,
                llm_ms: 150,
                total_ms: 198,
            })
        );
    }
}
