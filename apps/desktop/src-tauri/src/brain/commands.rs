//! Tauri IPC commands exposed by the `brain` module (`decisions.md` §4 & §6).

use crate::brain::agent_cli::{self, DetectedAgent};
use crate::brain::byo_api::transcribe_with_whisper_api;
use crate::brain::groq_pro::{self, AuthStatus, CheckoutResponse, CloudEndpoints};
use crate::brain::ollama::{self, resolve_ollama_base_url, OllamaStatus};
use crate::brain::router::{
    build_brain_request, resolve_brain_order, route_and_execute, BrainRoutingInput,
    CaptureContext, ProviderOverrides, RouteExecutionContext,
};
use crate::brain::BrainState;
use crate::db::{unix_now, DbState};
use crate::locator::resolve_step_plan;
use crate::overlay;
use crate::types::{AskResponse, BrainKind, BrainStatusPayload};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscribeResponse {
    pub text: String,
}

fn emit_brain_status(
    app: &AppHandle,
    state: &str,
    brain: Option<BrainKind>,
    message: Option<String>,
) {
    let _ = app.emit(
        "brain-status",
        BrainStatusPayload {
            state: state.to_string(),
            brain: brain.map(|b| b.as_str().to_string()),
            message,
        },
    );
}

/// Primary AI guidance IPC command (`ask(query, brain?)`).
#[tauri::command]
pub async fn ask(
    app: AppHandle,
    db: State<'_, DbState>,
    brain_state: State<'_, BrainState>,
    query: String,
    brain: Option<BrainKind>,
) -> Result<AskResponse, String> {
    let trimmed_query = query.trim().to_string();
    if trimmed_query.is_empty() {
        return Err("Query must not be empty".to_string());
    }

    emit_brain_status(
        &app,
        "capturing",
        brain,
        Some("Capturing active window...".to_string()),
    );

    let app_for_cap = app.clone();
    let capture = tokio::task::spawn_blocking(move || crate::capture::capture_active(&app_for_cap))
        .await
        .map_err(|e| format!("Screen capture task failed: {}", e))??;

    let settings = db.get_settings().unwrap_or_default();
    let app_pref_brain = crate::db::get_app_preference(&db, &capture.active_app);
    let cached_auth = brain_state.cached_auth.read().await.clone();
    let history = brain_state.recent_history();

    let detected_agents = agent_cli::detect_agents();
    let (_, planned_order) = resolve_brain_order(&BrainRoutingInput {
        settings: &settings,
        app_preferred_brain: app_pref_brain.as_deref(),
        brain_override: brain,
        secrets: &brain_state.secrets,
        cached_auth: cached_auth.as_ref(),
        detected_agents: &detected_agents,
    });
    let primary_brain = planned_order.first().copied().unwrap_or(BrainKind::LocalVlm);

    emit_brain_status(
        &app,
        "thinking",
        Some(primary_brain),
        Some(format!("Thinking with {}...", primary_brain.as_str())),
    );

    let req = build_brain_request(
        &trimmed_query,
        CaptureContext {
            image_base64: capture.image_base64.clone(),
            image_path: capture.image_path.clone(),
            active_app: capture.active_app.clone(),
            window_title: capture.window_title.clone(),
            screen_resolution: (capture.monitor.w, capture.monitor.h),
        },
        history,
    );

    let overrides = ProviderOverrides {
        detected_agents_override: Some(detected_agents),
        ..Default::default()
    };

    let (used_brain, mut plan) = match route_and_execute(
        &req,
        &RouteExecutionContext {
            settings: &settings,
            app_preferred_brain: app_pref_brain.as_deref(),
            brain_override: brain,
            secrets: &brain_state.secrets,
            cached_auth: cached_auth.as_ref(),
            overrides: &overrides,
        },
    )
    .await
    {
        Ok(res) => res,
        Err((failed_kind, err_json)) => {
            let msg = serde_json::from_str::<serde_json::Value>(&err_json)
                .ok()
                .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
                .unwrap_or_else(|| "Brain request failed".to_string());
            emit_brain_status(&app, "error", Some(failed_kind), Some(msg));
            return Err(err_json);
        }
    };

    plan.enforce_limits();

    emit_brain_status(
        &app,
        "locating",
        Some(used_brain),
        Some("Snapping to UI elements...".to_string()),
    );

    let resolved_steps = resolve_step_plan(&plan, &capture.monitor, capture.hwnd).await;

    let session_id = Uuid::new_v4().to_string();
    let created_at = unix_now();
    if let Err(e) = crate::db::insert_session(
        &db,
        &session_id,
        &capture.active_app,
        &trimmed_query,
        used_brain,
        created_at,
    ) {
        log::warn!("Failed to persist session {}: {}", session_id, e);
    } else {
        for step in &resolved_steps {
            let bbox_json = step.bbox.and_then(|b| serde_json::to_string(&b).ok());
            if let Err(e) = crate::db::insert_step(
                &db,
                &session_id,
                step.step_number,
                &step.instruction_line,
                bbox_json.as_deref(),
                step.terminal_command.as_deref(),
                Some(&capture.image_path),
            ) {
                log::warn!("Failed to persist step {}: {}", step.step_number, e);
            }
        }
    }

    brain_state.push_history(&trimmed_query, &plan);

    if let Err(e) = overlay::start_guidance(
        &app,
        resolved_steps.clone(),
        plan.mode,
        Some(capture.image_path.clone()),
        Some(capture.monitor.clone()),
        Some(session_id.clone()),
    ) {
        log::warn!("Failed to start overlay guidance: {}", e);
    }

    emit_brain_status(&app, "done", Some(used_brain), None);

    Ok(AskResponse {
        session_id,
        brain: used_brain,
        plan,
        resolved_steps,
        capture_path: Some(capture.image_path),
        monitor: Some(capture.monitor),
    })
}

/// Stores a BYO API key in Windows Credential Manager via `keyring` (never SQLite or logs).
#[tauri::command]
pub fn set_api_key(
    brain_state: State<'_, BrainState>,
    provider: String,
    key: String,
) -> Result<(), String> {
    brain_state.secrets.set_api_key(&provider, &key)
}

/// Deletes a BYO API key from Windows Credential Manager.
#[tauri::command]
pub fn delete_api_key(
    brain_state: State<'_, BrainState>,
    provider: String,
) -> Result<(), String> {
    brain_state.secrets.delete_api_key(&provider)
}

/// Lists BYO providers that currently have a key configured in Windows Credential Manager.
#[tauri::command]
pub fn list_api_key_providers(brain_state: State<'_, BrainState>) -> Result<Vec<String>, String> {
    brain_state.secrets.list_api_key_providers()
}

/// Checks if Ollama is running at localhost:11434 and lists installed vision models.
#[tauri::command]
pub async fn ollama_status() -> Result<OllamaStatus, String> {
    let base = resolve_ollama_base_url();
    Ok(ollama::check_ollama_status(&base).await)
}

/// Pulls an Ollama model and streams `ollama-pull-progress` events (`{ model, pct, status }`).
#[tauri::command]
pub async fn ollama_pull(app: AppHandle, model: String) -> Result<(), String> {
    let base = resolve_ollama_base_url();
    ollama::pull_ollama_model(&base, &model, |payload| {
        let _ = app.emit("ollama-pull-progress", payload);
    })
    .await
}

/// Detects installed headless coding agent CLIs (`claude`, `codex`, `gemini`, `agy`, `hermes`) on PATH.
#[tauri::command]
pub fn detect_agents() -> Result<Vec<DetectedAgent>, String> {
    Ok(agent_cli::detect_agents())
}

/// Signs into Supabase Auth (GoTrue) and stores the refresh + access tokens in Credential Manager.
#[tauri::command]
pub async fn auth_login(
    db: State<'_, DbState>,
    brain_state: State<'_, BrainState>,
    email: String,
    password: String,
) -> Result<AuthStatus, String> {
    let cloud_url = db.get_settings().ok().map(|s| s.cloud_url);
    let endpoints = CloudEndpoints::from_env(cloud_url.as_deref());
    let status = groq_pro::auth_login(&email, &password, &brain_state.secrets, &endpoints).await?;
    *brain_state.cached_auth.write().await = Some(status.clone());
    Ok(status)
}

/// Signs out of Supabase Auth and clears stored tokens from Windows Credential Manager.
#[tauri::command]
pub async fn auth_logout(
    db: State<'_, DbState>,
    brain_state: State<'_, BrainState>,
) -> Result<(), String> {
    let cloud_url = db.get_settings().ok().map(|s| s.cloud_url);
    let endpoints = CloudEndpoints::from_env(cloud_url.as_deref());
    let res = groq_pro::auth_logout(&brain_state.secrets, &endpoints).await;
    *brain_state.cached_auth.write().await = Some(AuthStatus::logged_out());
    res
}

/// Returns current Supabase authentication and Pro subscription status/quota.
#[tauri::command]
pub async fn auth_status(
    db: State<'_, DbState>,
    brain_state: State<'_, BrainState>,
) -> Result<AuthStatus, String> {
    let cloud_url = db.get_settings().ok().map(|s| s.cloud_url);
    let endpoints = CloudEndpoints::from_env(cloud_url.as_deref());
    let status = groq_pro::auth_status(&brain_state.secrets, &endpoints).await?;
    *brain_state.cached_auth.write().await = Some(status.clone());
    Ok(status)
}

/// Creates a Stripe Checkout session URL via the cloud proxy (`monthly` $19/mo or `annual` $190/yr).
#[tauri::command]
pub async fn billing_checkout(
    db: State<'_, DbState>,
    brain_state: State<'_, BrainState>,
    plan: String,
) -> Result<CheckoutResponse, String> {
    let cloud_url = db.get_settings().ok().map(|s| s.cloud_url);
    let endpoints = CloudEndpoints::from_env(cloud_url.as_deref());
    groq_pro::billing_checkout(&plan, &brain_state.secrets, &endpoints).await
}

/// Optional STT transcription command (`cloud` uses BYO Groq/OpenAI Whisper API keys).
#[tauri::command]
pub async fn transcribe(
    brain_state: State<'_, BrainState>,
    audio_base64: String,
    engine: String,
) -> Result<TranscribeResponse, String> {
    let clean_engine = engine.trim().to_ascii_lowercase();
    if clean_engine != "cloud" {
        return Err(
            "Local whisper.cpp runtime is not bundled; use Web Speech or Cloud STT in Settings."
                .to_string(),
        );
    }

    let bytes = BASE64
        .decode(audio_base64.trim())
        .map_err(|e| format!("Invalid audio base64 payload: {}", e))?;

    let (base_url, key, model) = if let Ok(Some(groq_key)) = brain_state.secrets.get_api_key("groq")
    {
        (
            "https://api.groq.com/openai/v1",
            groq_key,
            "whisper-large-v3-turbo",
        )
    } else if let Ok(Some(openai_key)) = brain_state.secrets.get_api_key("openai") {
        ("https://api.openai.com/v1", openai_key, "whisper-1")
    } else {
        return Err(
            "Add a Groq or OpenAI API key in Settings -> BYO API Keys to use Cloud STT."
                .to_string(),
        );
    };

    let text = transcribe_with_whisper_api(base_url, &key, model, bytes).await?;
    Ok(TranscribeResponse { text })
}
