//! Multi-brain router: selects the optimal provider per `settings` + `app_preferences`,
//! executes the request, enforces StepPlan constraints, and constructs graceful fallback options.

use crate::brain::agent_cli::{
    detect_agents_with_custom, resolve_custom_command, AgentCliProvider, AgentId, DetectedAgent,
};
use crate::brain::byo_api::{ByoApiProvider, ByoProviderId};
use crate::brain::groq_pro::{AuthStatus, CloudEndpoints, GroqProProvider};
use crate::brain::ollama::{resolve_ollama_base_url, OllamaProvider};
use crate::brain::prompts::{
    build_grounded_system_prompt, build_grounded_user_prompt, build_system_prompt,
    build_text_only_system_prompt, build_user_prompt, GroundedPromptContext,
};
use crate::brain::provider::{BrainError, BrainErrorCode, BrainProvider, BrainRequest};
use crate::brain::secrets::SecretStore;
use crate::types::{BrainKind, Settings, StepPlan};
use std::path::PathBuf;
use std::str::FromStr;

#[derive(Debug, Clone, Default)]
pub struct ProviderOverrides {
    pub ollama_base_url: Option<String>,
    pub cloud_endpoints: Option<CloudEndpoints>,
    pub byo_base_url: Option<String>,
    pub agent_binary_override: Option<PathBuf>,
    pub agent_custom_args: Option<Vec<String>>,
    pub detected_agents_override: Option<Vec<DetectedAgent>>,
}

#[derive(Debug, Clone)]
pub struct BrainRoutingInput<'a> {
    pub settings: &'a Settings,
    pub app_preferred_brain: Option<&'a str>,
    pub brain_override: Option<BrainKind>,
    pub secrets: &'a SecretStore,
    pub cached_auth: Option<&'a AuthStatus>,
    pub detected_agents: &'a [DetectedAgent],
}

/// Resolves which `ByoProviderId` and API key to use (prefers `settings.byo_provider`,
/// falling back to any other configured BYO key in Credential Manager or `custom_api_base_url`).
pub fn resolve_byo_provider_and_key(
    settings: &Settings,
    secrets: &SecretStore,
) -> Option<(ByoProviderId, String)> {
    if let Some(ref pref) = settings.byo_provider {
        if let Some(pid) = ByoProviderId::from_str_id(pref) {
            if let Ok(Some(key)) = secrets.get_api_key(pid.as_str()) {
                return Some((pid, key));
            }
            if pid == ByoProviderId::CustomOpenAi
                && settings
                    .custom_api_base_url
                    .as_deref()
                    .is_some_and(|u| !u.trim().is_empty())
            {
                return Some((pid, String::new()));
            }
        }
    }

    if let Ok(configured) = secrets.list_api_key_providers() {
        for name in configured {
            if let Some(pid) = ByoProviderId::from_str_id(&name) {
                if let Ok(Some(key)) = secrets.get_api_key(pid.as_str()) {
                    return Some((pid, key));
                }
            }
        }
    }

    None
}

/// Resolves the chosen and installed `AgentId` for `agent_cli`.
pub fn resolve_selected_installed_agent(
    settings: &Settings,
    detected_agents: &[DetectedAgent],
) -> Option<AgentId> {
    let selected = settings
        .agent_id
        .as_deref()
        .and_then(AgentId::from_str_id)?;

    if selected == AgentId::Custom
        && resolve_custom_command(settings.custom_agent_cmd.as_deref()).is_some()
    {
        return Some(AgentId::Custom);
    }

    let is_installed = detected_agents
        .iter()
        .any(|d| d.id == selected.as_str() && d.installed);

    if is_installed {
        Some(selected)
    } else {
        None
    }
}

/// Determines whether `groq_pro` is eligible in `auto` mode.
pub fn is_groq_pro_eligible(secrets: &SecretStore, cached_auth: Option<&AuthStatus>) -> bool {
    let has_tokens = secrets.get_access_token().ok().flatten().is_some()
        || secrets.get_refresh_token().ok().flatten().is_some();

    if !has_tokens {
        return false;
    }

    match cached_auth {
        Some(auth) => {
            auth.logged_in
                && auth.status.eq_ignore_ascii_case("active")
                && (auth.tier == "pro_monthly" || auth.tier == "pro_annual")
        }
        // Tokens exist in Credential Manager, auth_status hasn't been fetched yet this session
        None => true,
    }
}

/// Computes the ordered list of candidate `BrainKind`s for the current context.
pub fn resolve_brain_order(input: &BrainRoutingInput<'_>) -> (bool, Vec<BrainKind>) {
    if let Some(explicit) = input.brain_override {
        return (true, vec![explicit]);
    }

    if let Some(app_pref) = input.app_preferred_brain {
        let trimmed = app_pref.trim();
        if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("auto") {
            if let Ok(kind) = BrainKind::from_str(trimmed) {
                return (true, vec![kind]);
            }
        }
    }

    if !input.settings.brain_mode.trim().eq_ignore_ascii_case("auto") {
        if let Ok(kind) = BrainKind::from_str(input.settings.brain_mode.trim()) {
            return (true, vec![kind]);
        }
    }

    let priority = if input.settings.brain_priority.is_empty() {
        vec![
            BrainKind::AgentCli,
            BrainKind::ByoApi,
            BrainKind::GroqPro,
            BrainKind::LocalVlm,
        ]
    } else {
        input.settings.brain_priority.clone()
    };

    let mut order = Vec::new();
    for kind in priority {
        let eligible = match kind {
            BrainKind::AgentCli => {
                resolve_selected_installed_agent(input.settings, input.detected_agents).is_some()
            }
            BrainKind::ByoApi => resolve_byo_provider_and_key(input.settings, input.secrets).is_some(),
            BrainKind::GroqPro => is_groq_pro_eligible(input.secrets, input.cached_auth),
            BrainKind::LocalVlm => true,
            BrainKind::AgentMcp => false,
        };
        if eligible && !order.contains(&kind) {
            order.push(kind);
        }
    }

    if !order.contains(&BrainKind::LocalVlm) {
        order.push(BrainKind::LocalVlm);
    }

    (false, order)
}

/// Builds the 1-click fallback buttons list presented to the user if a brain errors.
pub fn compute_fallback_options(
    failed_brain: BrainKind,
    settings: &Settings,
    secrets: &SecretStore,
    detected_agents: &[DetectedAgent],
) -> Vec<BrainKind> {
    let mut fallbacks = Vec::new();

    if failed_brain != BrainKind::LocalVlm {
        fallbacks.push(BrainKind::LocalVlm);
    }

    let any_agent_installed = resolve_selected_installed_agent(settings, detected_agents).is_some()
        || detected_agents.iter().any(|d| d.installed);
    if failed_brain != BrainKind::AgentCli && any_agent_installed {
        fallbacks.push(BrainKind::AgentCli);
    }

    if failed_brain != BrainKind::ByoApi && resolve_byo_provider_and_key(settings, secrets).is_some()
    {
        fallbacks.push(BrainKind::ByoApi);
    }

    if failed_brain != BrainKind::GroqPro
        && (secrets.get_access_token().ok().flatten().is_some()
            || secrets.get_refresh_token().ok().flatten().is_some())
    {
        fallbacks.push(BrainKind::GroqPro);
    }

    if fallbacks.is_empty() {
        if failed_brain != BrainKind::LocalVlm {
            fallbacks.push(BrainKind::LocalVlm);
        }
        if failed_brain != BrainKind::AgentCli {
            fallbacks.push(BrainKind::AgentCli);
        }
    }

    fallbacks
}

pub struct CaptureContext {
    pub image_base64: String,
    pub image_path: String,
    pub active_app: String,
    pub window_title: String,
    pub screen_resolution: (u32, u32),
}

/// Constructs a legacy `BrainRequest` using the shared system prompt and the 15 app profiles.
pub fn build_brain_request(
    query: &str,
    capture: CaptureContext,
    conversation_history: Vec<String>,
) -> BrainRequest {
    let system_prompt = build_system_prompt(&capture.active_app, &capture.window_title);
    let user_prompt = build_user_prompt(
        query,
        &capture.active_app,
        &capture.window_title,
        capture.screen_resolution,
    );
    BrainRequest {
        query: query.trim().to_string(),
        image_base64: capture.image_base64,
        image_path: capture.image_path,
        active_app: capture.active_app,
        window_title: capture.window_title,
        screen_resolution: capture.screen_resolution,
        system_prompt,
        user_prompt,
        conversation_history,
        has_som: false,
        max_tokens: None,
    }
}

/// Constructs a v2 Set-of-Mark + KG Memory + Companion Persona `BrainRequest`.
pub fn build_grounded_brain_request(
    query: &str,
    capture: CaptureContext,
    element_table_prompt: &str,
    memory_hints: &str,
    companion_id: &str,
    live_mode: bool,
    conversation_history: Vec<String>,
) -> BrainRequest {
    let system_prompt = build_grounded_system_prompt(
        &capture.active_app,
        &capture.window_title,
        companion_id,
        live_mode,
    );
    let user_prompt = build_grounded_user_prompt(&GroundedPromptContext {
        query,
        active_exe: &capture.active_app,
        window_title: &capture.window_title,
        screen_size: capture.screen_resolution,
        element_table_prompt,
        memory_hints,
        session_history: &conversation_history,
    });
    BrainRequest {
        query: query.trim().to_string(),
        image_base64: capture.image_base64,
        image_path: capture.image_path,
        active_app: capture.active_app,
        window_title: capture.window_title,
        screen_resolution: capture.screen_resolution,
        system_prompt,
        user_prompt,
        conversation_history,
        has_som: !element_table_prompt.trim().is_empty(),
        max_tokens: if live_mode { Some(280) } else { None },
    }
}

/// Constructs a Tier-1 text-only `BrainRequest` (no screenshot bytes) for fast UIA + KG disambiguation.
#[allow(clippy::too_many_arguments)]
pub fn build_text_only_grounded_request(
    query: &str,
    active_app: &str,
    window_title: &str,
    screen_resolution: (u32, u32),
    element_table_prompt: &str,
    memory_hints: &str,
    companion_id: &str,
    conversation_history: Vec<String>,
) -> BrainRequest {
    let system_prompt = build_text_only_system_prompt(active_app, window_title, companion_id);
    let user_prompt = build_grounded_user_prompt(&GroundedPromptContext {
        query,
        active_exe: active_app,
        window_title,
        screen_size: screen_resolution,
        element_table_prompt,
        memory_hints,
        session_history: &conversation_history,
    });
    BrainRequest {
        query: query.trim().to_string(),
        image_base64: String::new(),
        image_path: String::new(),
        active_app: active_app.to_string(),
        window_title: window_title.to_string(),
        screen_resolution,
        system_prompt,
        user_prompt,
        conversation_history,
        has_som: !element_table_prompt.trim().is_empty(),
        max_tokens: Some(260),
    }
}

pub struct RouteExecutionContext<'a> {
    pub settings: &'a Settings,
    pub app_preferred_brain: Option<&'a str>,
    pub brain_override: Option<BrainKind>,
    pub secrets: &'a SecretStore,
    pub cached_auth: Option<&'a AuthStatus>,
    pub overrides: &'a ProviderOverrides,
}

/// Executes the routed brain pipeline, returning `(BrainKind, StepPlan)` or an IPC-formatted error JSON.
pub async fn route_and_execute(
    req: &BrainRequest,
    ctx: &RouteExecutionContext<'_>,
) -> Result<(BrainKind, StepPlan), (BrainKind, String)> {
    let owned_agents;
    let detected = match &ctx.overrides.detected_agents_override {
        Some(list) => list.as_slice(),
        None => {
            owned_agents = detect_agents_with_custom(ctx.settings.custom_agent_cmd.as_deref());
            owned_agents.as_slice()
        }
    };

    let (is_explicit, candidates) = resolve_brain_order(&BrainRoutingInput {
        settings: ctx.settings,
        app_preferred_brain: ctx.app_preferred_brain,
        brain_override: ctx.brain_override,
        secrets: ctx.secrets,
        cached_auth: ctx.cached_auth,
        detected_agents: detected,
    });

    let mut last_err: Option<BrainError> = None;

    for (idx, kind) in candidates.iter().enumerate() {
        let res = execute_single_provider(
            *kind,
            req,
            ctx.settings,
            ctx.secrets,
            detected,
            ctx.overrides,
        )
        .await;

        match res {
            Ok(mut plan) => {
                plan.enforce_limits();
                return Ok((*kind, plan));
            }
            Err(err) => {
                let has_next = idx + 1 < candidates.len();
                let should_continue_auto = !is_explicit
                    && has_next
                    && *kind == BrainKind::GroqPro
                    && matches!(
                        err.code,
                        BrainErrorCode::NotPro | BrainErrorCode::Unauthenticated
                    );

                if should_continue_auto {
                    last_err = Some(err);
                    continue;
                }

                let fallbacks = compute_fallback_options(*kind, ctx.settings, ctx.secrets, detected);
                let json_err = err.to_ipc_error_json(fallbacks);
                return Err((*kind, json_err));
            }
        }
    }

    let fallback_err = last_err.unwrap_or_else(|| {
        BrainError::new(
            BrainErrorCode::Unavailable,
            BrainKind::LocalVlm,
            "No AI brain is currently available.",
        )
    });
    let fallbacks = compute_fallback_options(fallback_err.brain, ctx.settings, ctx.secrets, detected);
    Err((fallback_err.brain, fallback_err.to_ipc_error_json(fallbacks)))
}

async fn execute_single_provider(
    kind: BrainKind,
    req: &BrainRequest,
    settings: &Settings,
    secrets: &SecretStore,
    detected_agents: &[DetectedAgent],
    overrides: &ProviderOverrides,
) -> Result<StepPlan, BrainError> {
    match kind {
        BrainKind::LocalVlm => {
            let base = overrides
                .ollama_base_url
                .clone()
                .unwrap_or_else(resolve_ollama_base_url);
            let provider = OllamaProvider::with_base_url(base, &settings.ollama_model);
            provider.generate_plan(req).await
        }
        BrainKind::ByoApi => {
            let Some((pid, key)) = resolve_byo_provider_and_key(settings, secrets) else {
                return Err(BrainError::new(
                    BrainErrorCode::Unauthenticated,
                    BrainKind::ByoApi,
                    "No BYO API key configured in Windows Credential Manager.",
                ));
            };
            let base = overrides
                .byo_base_url
                .as_deref()
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
            let model_override = if settings
                .byo_provider
                .as_deref()
                .and_then(ByoProviderId::from_str_id)
                == Some(pid)
            {
                settings.byo_model.as_deref()
            } else {
                None
            };
            let provider = ByoApiProvider::with_base_url(pid, key, model_override, base);
            provider.generate_plan(req).await
        }
        BrainKind::AgentCli => {
            let chosen = settings
                .agent_id
                .as_deref()
                .and_then(AgentId::from_str_id)
                .or_else(|| {
                    detected_agents
                        .iter()
                        .find(|d| d.installed)
                        .and_then(|d| AgentId::from_str_id(&d.id))
                })
                .unwrap_or(AgentId::Claude);

            let provider = if let Some(ref bin) = overrides.agent_binary_override {
                AgentCliProvider::with_executable(
                    chosen,
                    bin.clone(),
                    overrides.agent_custom_args.clone(),
                    std::time::Duration::from_secs(30),
                )
            } else if chosen == AgentId::Custom {
                AgentCliProvider::with_custom_cmd(chosen, settings.custom_agent_cmd.clone())
            } else {
                AgentCliProvider::new(chosen)
            };
            provider.generate_plan(req).await
        }
        BrainKind::GroqPro => {
            let endpoints = overrides
                .cloud_endpoints
                .clone()
                .unwrap_or_else(|| CloudEndpoints::from_env(Some(&settings.cloud_url)));
            let provider = GroqProProvider::new(endpoints, secrets.clone());
            provider.generate_plan(req).await
        }
        BrainKind::AgentMcp => Err(BrainError::new(
            BrainErrorCode::Unavailable,
            BrainKind::AgentMcp,
            "Agent MCP pushes guidance directly via local bridge.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain::provider::AskErrorPayload;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_req() -> BrainRequest {
        build_brain_request(
            "How do I select subject?",
            CaptureContext {
                image_base64: "aGVsbG8=".to_string(),
                image_path: "C:\\tmp\\cap.jpg".to_string(),
                active_app: "Photoshop.exe".to_string(),
                window_title: "Adobe Photoshop".to_string(),
                screen_resolution: (1920, 1080),
            },
            vec![],
        )
    }

    fn no_agents() -> Vec<DetectedAgent> {
        vec![
            DetectedAgent {
                id: "claude".into(),
                installed: false,
                path: None,
            },
            DetectedAgent {
                id: "codex".into(),
                installed: false,
                path: None,
            },
        ]
    }

    #[test]
    fn auto_routing_follows_priority_order_and_app_preferences() {
        let settings = Settings::default();
        let secrets = SecretStore::new_memory();

        // 1. Nothing configured -> falls back directly to Ollama (`local_vlm`)
        let (explicit, order) = resolve_brain_order(&BrainRoutingInput {
            settings: &settings,
            app_preferred_brain: None,
            brain_override: None,
            secrets: &secrets,
            cached_auth: None,
            detected_agents: &no_agents(),
        });
        assert!(!explicit);
        assert_eq!(order, vec![BrainKind::LocalVlm]);

        // 2. Agent CLI + BYO key + Pro auth all active -> exact order: AgentCli -> ByoApi -> GroqPro -> LocalVlm
        secrets.set_api_key("gemini", "test-key").unwrap();
        secrets
            .save_auth_tokens("jwt", "ref", Some("pro@test.com"))
            .unwrap();
        let pro_auth = AuthStatus {
            logged_in: true,
            email: Some("pro@test.com".into()),
            tier: "pro_monthly".into(),
            status: "active".into(),
            usage: 0,
            limit: 1500,
        };
        let claude_installed = vec![DetectedAgent {
            id: "claude".into(),
            installed: true,
            path: Some("C:\\bin\\claude.exe".into()),
        }];

        let (_, full_order) = resolve_brain_order(&BrainRoutingInput {
            settings: &settings,
            app_preferred_brain: None,
            brain_override: None,
            secrets: &secrets,
            cached_auth: Some(&pro_auth),
            detected_agents: &claude_installed,
        });
        assert_eq!(
            full_order,
            vec![
                BrainKind::AgentCli,
                BrainKind::ByoApi,
                BrainKind::GroqPro,
                BrainKind::LocalVlm,
            ]
        );

        // 3. Per-app preference in SQLite overrides auto order
        let (pref_explicit, pref_order) = resolve_brain_order(&BrainRoutingInput {
            settings: &settings,
            app_preferred_brain: Some("groq_pro"),
            brain_override: None,
            secrets: &secrets,
            cached_auth: Some(&pro_auth),
            detected_agents: &claude_installed,
        });
        assert!(pref_explicit);
        assert_eq!(pref_order, vec![BrainKind::GroqPro]);
    }

    #[tokio::test]
    async fn groq_429_offers_local_and_agent_fallbacks_and_auto_falls_through_402() {
        let ollama_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "message": {
                    "content": r#"{"mode":"guide","total_steps":1,"steps":[{"step_number":1,"instruction_line":"Click Select Subject.","confidence":0.9}]}"#
                }
            })))
            .mount(&ollama_server)
            .await;

        let cloud_429 = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/guide"))
            .respond_with(ResponseTemplate::new(429).set_body_json(json!({
                "error": "rate_limit_exceeded",
                "message": "20 req/min reached",
                "retry_after": 30
            })))
            .mount(&cloud_429)
            .await;

        let secrets = SecretStore::new_memory();
        secrets.set_api_key("openai", "sk-test").unwrap();
        secrets.save_auth_tokens("jwt-1", "ref-1", None).unwrap();

        let settings = Settings::default();
        let req = test_req();

        let overrides = ProviderOverrides {
            ollama_base_url: Some(ollama_server.uri()),
            cloud_endpoints: Some(CloudEndpoints {
                cloud_url: cloud_429.uri(),
                supabase_url: String::new(),
                supabase_anon_key: String::new(),
            }),
            detected_agents_override: Some(vec![DetectedAgent {
                id: "codex".into(),
                installed: true,
                path: Some("C:\\bin\\codex.exe".into()),
            }]),
            ..Default::default()
        };

        // Explicit GroqPro hitting 429 returns structured AskError with Local + Agent + BYO fallbacks
        let (failed_kind, err_json) = route_and_execute(
            &req,
            &RouteExecutionContext {
                settings: &settings,
                app_preferred_brain: None,
                brain_override: Some(BrainKind::GroqPro),
                secrets: &secrets,
                cached_auth: None,
                overrides: &overrides,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(failed_kind, BrainKind::GroqPro);
        let parsed: AskErrorPayload = serde_json::from_str(&err_json).unwrap();
        assert_eq!(parsed.code, BrainErrorCode::RateLimited);
        assert!(parsed.fallbacks.contains(&BrainKind::LocalVlm));
        assert!(parsed.fallbacks.contains(&BrainKind::AgentCli));
        assert!(parsed.fallbacks.contains(&BrainKind::ByoApi));

        // In auto mode, if GroqPro returns 402 (not Pro), router gracefully falls back to Ollama
        let cloud_402 = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/guide"))
            .respond_with(ResponseTemplate::new(402).set_body_json(json!({
                "error": "pro_subscription_required"
            })))
            .mount(&cloud_402)
            .await;

        let auto_settings = Settings {
            brain_priority: vec![BrainKind::GroqPro, BrainKind::LocalVlm],
            ..Default::default()
        };
        let auto_secrets = SecretStore::new_memory();
        auto_secrets.save_auth_tokens("jwt-free", "ref-free", None).unwrap();

        let auto_overrides = ProviderOverrides {
            ollama_base_url: Some(ollama_server.uri()),
            cloud_endpoints: Some(CloudEndpoints {
                cloud_url: cloud_402.uri(),
                supabase_url: String::new(),
                supabase_anon_key: String::new(),
            }),
            detected_agents_override: Some(no_agents()),
            ..Default::default()
        };

        let (used_brain, plan) = route_and_execute(
            &req,
            &RouteExecutionContext {
                settings: &auto_settings,
                app_preferred_brain: None,
                brain_override: None,
                secrets: &auto_secrets,
                cached_auth: None,
                overrides: &auto_overrides,
            },
        )
        .await
        .expect("auto mode falls through 402 to Ollama");
        assert_eq!(used_brain, BrainKind::LocalVlm);
        assert_eq!(plan.steps[0].instruction_line, "Click Select Subject.");

        // Auto mode selects BYO API when key is configured and no agent CLI is installed
        let byo_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{
                    "message": {
                        "content": r#"{"mode":"guide","total_steps":1,"steps":[{"step_number":1,"instruction_line":"Press W for Object Selection.","shortcut":"W","confidence":0.95}]}"#
                    }
                }]
            })))
            .mount(&byo_server)
            .await;

        let byo_secrets = SecretStore::new_memory();
        byo_secrets.set_api_key("openai", "sk-byo-test").unwrap();
        let byo_settings = Settings {
            byo_provider: Some("openai".into()),
            ..Default::default()
        };
        let byo_overrides = ProviderOverrides {
            byo_base_url: Some(byo_server.uri()),
            detected_agents_override: Some(no_agents()),
            ..Default::default()
        };
        let (byo_used, byo_plan) = route_and_execute(
            &req,
            &RouteExecutionContext {
                settings: &byo_settings,
                app_preferred_brain: None,
                brain_override: None,
                secrets: &byo_secrets,
                cached_auth: None,
                overrides: &byo_overrides,
            },
        )
        .await
        .expect("auto mode routes to BYO API when key set");
        assert_eq!(byo_used, BrainKind::ByoApi);
        assert_eq!(byo_plan.steps[0].shortcut.as_deref(), Some("W"));
    }
}
