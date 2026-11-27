//! Tauri IPC commands exposed by the `brain` module (`decisions.md` §4 & §6).

use crate::brain::agent_cli::DetectedAgent;
use crate::brain::byo_api::{test_brain_connection_impl, transcribe_with_whisper_api};
use crate::brain::groq_pro::{self, AuthStatus, CheckoutResponse, CloudEndpoints};
use crate::brain::ollama::{self, resolve_ollama_base_url, OllamaStatus};
use crate::brain::router::{
    build_grounded_brain_request, build_text_only_grounded_request, resolve_brain_order,
    route_and_execute, BrainRoutingInput, CaptureContext, ProviderOverrides, RouteExecutionContext,
};
use crate::brain::{BrainState, LatencyStats};
use crate::db::{unix_now, DbState};
use crate::memory::compiler::{
    detect_active_window_and_monitor, extract_vocab_tokens, find_best_matching_playbook_id,
    find_best_tier0_playbook, verify_playbook_on_live_uia,
};
use crate::overlay;
use crate::types::{
    AskResponse, BrainKind, BrainStatusPayload, CompiledPlaybookDto, ConnectionTestResult,
    GroundedElement, GroundingSnapshot, LatencyBreakdown, LiveSessionTurn, MonitorInfo,
    ResolvedStep, StepMode, StepPlan,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

pub use crate::brain::byo_api::generate_day_summary_text;

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

pub(crate) fn allocate_capture_path() -> std::path::PathBuf {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    crate::capture::captures_dir().join(format!(
        "capture_{}_{}.jpg",
        ts,
        Uuid::new_v4().simple()
    ))
}

pub(crate) fn save_raw_capture_async(
    path: std::path::PathBuf,
    raw_image: image::RgbaImage,
    fallback_jpeg: Vec<u8>,
) {
    tokio::spawn(async move {
        let bytes = tokio::task::spawn_blocking(move || {
            crate::capture::encode_rgba_as_jpeg(&raw_image, 82).unwrap_or(fallback_jpeg)
        })
        .await
        .unwrap_or_default();
        if !bytes.is_empty() {
            crate::capture::save_bytes_async(path, bytes);
        }
    });
}

fn build_plan_from_resolved(resolved_steps: &[ResolvedStep]) -> StepPlan {
    let mode = if resolved_steps.iter().any(|s| {
        s.terminal_command
            .as_deref()
            .is_some_and(|c| !c.trim().is_empty())
    }) {
        StepMode::Terminal
    } else if resolved_steps.iter().all(|s| {
        s.rect_px.is_none()
            && s.shortcut.as_deref().map(str::trim).unwrap_or("").is_empty()
            && s.action_kind.as_deref() == Some("explain")
    }) {
        StepMode::Explain
    } else {
        StepMode::Guide
    };
    let steps = resolved_steps.iter().map(ResolvedStep::to_step).collect::<Vec<_>>();
    let mut plan = StepPlan {
        mode,
        total_steps: steps.len().max(1) as u32,
        steps,
    };
    plan.enforce_limits();
    plan
}

fn persist_session_and_steps(
    db: &DbState,
    session_id: &str,
    active_app: &str,
    query: &str,
    used_brain: BrainKind,
    created_at: i64,
    resolved_steps: &[ResolvedStep],
    capture_path: Option<&str>,
) {
    if let Err(e) =
        crate::db::insert_session(db, session_id, active_app, query, used_brain, created_at)
    {
        log::warn!("Failed to persist session {}: {}", session_id, e);
        return;
    }
    for step in resolved_steps {
        let bbox_json = step.bbox.and_then(|b| serde_json::to_string(&b).ok());
        if let Err(e) = crate::db::insert_step(
            db,
            session_id,
            step.step_number,
            &step.instruction_line,
            bbox_json.as_deref(),
            step.terminal_command.as_deref(),
            capture_path,
        ) {
            log::warn!("Failed to persist step {}: {}", step.step_number, e);
        }
    }
}

async fn collect_fast_uia_elements(
    hwnd: isize,
    monitor: &MonitorInfo,
) -> (Vec<GroundedElement>, String, u64) {
    let started = Instant::now();
    let mon_uia = monitor.clone();
    let uia_cands = tokio::task::spawn_blocking(move || {
        crate::grounding::uia_fast::collect_fast_uia_and_taskbar(hwnd, &mon_uia)
    })
    .await
    .unwrap_or_default();
    let mon_merge = monitor.clone();
    let (elements, table) = tokio::task::spawn_blocking(move || {
        let els =
            crate::grounding::som_renderer::merge_and_number_candidates(uia_cands, &mon_merge);
        let tbl = crate::grounding::som_renderer::format_element_table_prompt(&els);
        (els, tbl)
    })
    .await
    .unwrap_or_default();
    (elements, table, started.elapsed().as_millis() as u64)
}

pub(crate) fn is_tier1_eligible(
    active_app: &str,
    window_title: &str,
    query: &str,
    elements: &[GroundedElement],
    memory_hints: &str,
) -> bool {
    let labeled_count = elements
        .iter()
        .filter(|e| !e.label.trim().is_empty())
        .count();
    if labeled_count < 6 {
        return false;
    }
    if !memory_hints.trim().is_empty() {
        return true;
    }
    if crate::brain::prompts::match_app_profile(active_app, window_title)
        .is_some_and(|p| p.terminal_mode)
    {
        return true;
    }
    let q_tokens = extract_vocab_tokens(query);
    if q_tokens.is_empty() {
        return false;
    }
    elements.iter().any(|el| {
        let label_l = el.label.to_ascii_lowercase();
        q_tokens.iter().any(|t| label_l.contains(t.as_str()))
    })
}

pub(crate) fn is_tier1_plan_resolved(plan: &StepPlan, resolved: &[ResolvedStep]) -> bool {
    let Some(first) = resolved.first() else {
        return false;
    };
    if plan.mode == StepMode::Explain {
        return true;
    }
    first.rect_px.is_some()
        || first
            .terminal_command
            .as_deref()
            .is_some_and(|c| !c.trim().is_empty())
        || first
            .shortcut
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn execute_playbook_tier0(
    app: &AppHandle,
    db: &DbState,
    brain_state: &BrainState,
    playbook: CompiledPlaybookDto,
    active_app: String,
    window_title: String,
    hwnd: isize,
    monitor: MonitorInfo,
    precomputed_elements: Option<Vec<GroundedElement>>,
    started: Instant,
    memory_ms: u64,
    primary_brain: BrainKind,
) -> Option<AskResponse> {
    emit_brain_status(
        app,
        "locating",
        Some(primary_brain),
        Some("Verifying learned playbook on live UI...".to_string()),
    );

    let (elements, grounding_ms) = match precomputed_elements {
        Some(els) => (els, 0),
        None => {
            let (els, _, gms) = collect_fast_uia_elements(hwnd, &monitor).await;
            (els, gms)
        }
    };

    let resolved_steps = verify_playbook_on_live_uia(&playbook, &monitor, &elements)?;
    let _ = db.record_playbook_hit(&playbook.id, 1800);
    let plan = build_plan_from_resolved(&resolved_steps);

    let total_ms = started.elapsed().as_millis() as u64;
    let latency = LatencyBreakdown {
        capture_ms: 0,
        grounding_ms,
        memory_ms,
        llm_ms: 0,
        total_ms,
    };
    brain_state.record_latency(latency);

    let session_id = Uuid::new_v4().to_string();
    let created_at = unix_now();
    persist_session_and_steps(
        db,
        &session_id,
        &active_app,
        &playbook.canonical_goal,
        primary_brain,
        created_at,
        &resolved_steps,
        None,
    );

    brain_state.push_history(&playbook.canonical_goal, &plan);

    if let Err(e) = overlay::start_guidance(
        app,
        resolved_steps.clone(),
        plan.mode,
        None,
        Some(monitor.clone()),
        Some(session_id.clone()),
    ) {
        log::warn!("Failed to start Tier-0 overlay guidance: {}", e);
    }

    let _ = window_title;
    emit_brain_status(app, "done", Some(primary_brain), None);

    Some(AskResponse {
        session_id,
        brain: primary_brain,
        plan,
        resolved_steps,
        capture_path: None,
        monitor: Some(monitor),
        latency: Some(latency),
        resolution_tier: Some("tier0_playbook".to_string()),
        tokens_saved: Some(1800),
        playbook_id: Some(playbook.id),
    })
}

/// Core 3-tier guidance cascade (`Tier-0 Playbook -> Tier-1 Text/UIA+Graph -> Tier-2 Full Vision SoM`).
pub async fn ask_inner(
    app: &AppHandle,
    db: &DbState,
    brain_state: &BrainState,
    query: String,
    brain: Option<BrainKind>,
    force_ai: bool,
) -> Result<AskResponse, String> {
    let trimmed_query = query.trim().to_string();
    if trimmed_query.is_empty() {
        return Err("Query must not be empty".to_string());
    }

    let total_started = Instant::now();
    let settings = db.get_settings().unwrap_or_default();
    let cached_auth = brain_state.cached_auth.read().await.clone();
    let history = brain_state.recent_history();
    let detected_agents = brain_state.detect_agents_cached(settings.custom_agent_cmd.as_deref());

    let mut cached_uia: Option<(
        crate::capture::ActiveWindowInfo,
        MonitorInfo,
        Vec<GroundedElement>,
        String,
        u64,
        String,
        u64,
        Option<String>,
        BrainKind,
    )> = None;

    if !force_ai {
        let (win, monitor) = tokio::task::spawn_blocking(detect_active_window_and_monitor)
            .await
            .unwrap_or_else(|_| (crate::capture::detect_active_window(), MonitorInfo::default()));

        let app_pref_brain = crate::db::get_app_preference(db, &win.active_app);
        let (_, planned_order) = resolve_brain_order(&BrainRoutingInput {
            settings: &settings,
            app_preferred_brain: app_pref_brain.as_deref(),
            brain_override: brain,
            secrets: &brain_state.secrets,
            cached_auth: cached_auth.as_ref(),
            detected_agents: &detected_agents,
        });
        let primary_brain = planned_order.first().copied().unwrap_or(BrainKind::LocalVlm);

        let mem_started = Instant::now();
        let tier0_match = if brain.is_none() {
            find_best_tier0_playbook(db, &win.active_app, &win.window_title, &trimmed_query)
        } else {
            None
        };
        let memory_hints =
            crate::memory::retrieve_memory_hints(db, &win.active_app, &win.window_title, &trimmed_query);
        let memory_ms = mem_started.elapsed().as_millis() as u64;

        let mut uia_loaded: Option<(Vec<GroundedElement>, String, u64)> = None;

        if let Some((playbook, _score)) = tier0_match {
            let (els, table, gms) = collect_fast_uia_elements(win.hwnd, &monitor).await;
            if let Some(resp) = execute_playbook_tier0(
                app,
                db,
                brain_state,
                playbook,
                win.active_app.clone(),
                win.window_title.clone(),
                win.hwnd,
                monitor.clone(),
                Some(els.clone()),
                total_started,
                memory_ms,
                primary_brain,
            )
            .await
            {
                return Ok(resp);
            }
            uia_loaded = Some((els, table, gms));
        }

        // Tier 1: Text-only UIA + Knowledge Graph disambiguation (0 screenshot bytes)
        if matches!(primary_brain, BrainKind::ByoApi | BrainKind::LocalVlm) {
            let (els, table, gms) = match uia_loaded {
                Some(v) => v,
                None => collect_fast_uia_elements(win.hwnd, &monitor).await,
            };

            if is_tier1_eligible(
                &win.active_app,
                &win.window_title,
                &trimmed_query,
                &els,
                &memory_hints,
            ) {
                emit_brain_status(
                    app,
                    "thinking",
                    Some(primary_brain),
                    Some(format!("Thinking text-only (Tier 1) with {}...", primary_brain.as_str())),
                );

                let req = build_text_only_grounded_request(
                    &trimmed_query,
                    &win.active_app,
                    &win.window_title,
                    (monitor.w, monitor.h),
                    &table,
                    &memory_hints,
                    &settings.companion_id,
                    history.clone(),
                );
                let overrides = ProviderOverrides {
                    detected_agents_override: Some(detected_agents.clone()),
                    ..Default::default()
                };

                let llm_started = Instant::now();
                if let Ok((used_brain, mut plan)) = route_and_execute(
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
                    let llm_ms = llm_started.elapsed().as_millis() as u64;
                    plan.enforce_limits();

                    let snapshot = GroundingSnapshot {
                        monitor: monitor.clone(),
                        active_app: win.active_app.clone(),
                        window_title: win.window_title.clone(),
                        hwnd: win.hwnd,
                        dhash64: String::new(),
                        elements: els.clone(),
                        element_table_prompt: table.clone(),
                        capture_ms: 0,
                        grounding_ms: gms,
                    };
                    let resolved_steps =
                        crate::grounding::resolve_plan_with_grounding(&plan, &snapshot).await;

                    if is_tier1_plan_resolved(&plan, &resolved_steps) {
                        let total_ms = total_started.elapsed().as_millis() as u64;
                        let latency = LatencyBreakdown {
                            capture_ms: 0,
                            grounding_ms: gms,
                            memory_ms,
                            llm_ms,
                            total_ms,
                        };
                        brain_state.record_latency(latency);

                        let session_id = Uuid::new_v4().to_string();
                        let created_at = unix_now();
                        persist_session_and_steps(
                            db,
                            &session_id,
                            &win.active_app,
                            &trimmed_query,
                            used_brain,
                            created_at,
                            &resolved_steps,
                            None,
                        );
                        brain_state.push_history(&trimmed_query, &plan);

                        if let Err(e) = overlay::start_guidance(
                            app,
                            resolved_steps.clone(),
                            plan.mode,
                            None,
                            Some(monitor.clone()),
                            Some(session_id.clone()),
                        ) {
                            log::warn!("Failed to start Tier-1 overlay guidance: {}", e);
                        }

                        let turns: Vec<LiveSessionTurn> = resolved_steps
                            .iter()
                            .enumerate()
                            .map(|(idx, step)| LiveSessionTurn {
                                turn_number: if step.step_number > 0 {
                                    step.step_number
                                } else {
                                    (idx + 1) as u32
                                },
                                user_text: (idx == 0).then(|| trimmed_query.clone()),
                                instruction_line: step.instruction_line.clone(),
                                spoken_text: step.spoken_text.clone(),
                                action_kind: step.action_kind.clone(),
                                companion_emotion: step.companion_emotion.clone(),
                                target_name: step.target_name.clone(),
                                rect_px: step.rect_px,
                                active_app: win.active_app.clone(),
                                window_title: win.window_title.clone(),
                                latency: (idx == 0).then_some(latency),
                                timestamp: created_at,
                            })
                            .collect();

                        let _ = crate::memory::record_session_and_write_graph(
                            db,
                            &session_id,
                            &win.active_app,
                            &trimmed_query,
                            &resolved_steps,
                            &turns,
                            false,
                        );
                        let playbook_id =
                            find_best_matching_playbook_id(db, &win.active_app, &trimmed_query);

                        emit_brain_status(app, "done", Some(used_brain), None);

                        return Ok(AskResponse {
                            session_id,
                            brain: used_brain,
                            plan,
                            resolved_steps,
                            capture_path: None,
                            monitor: Some(monitor),
                            latency: Some(latency),
                            resolution_tier: Some("tier1_text_graph".to_string()),
                            tokens_saved: Some(1400),
                            playbook_id,
                        });
                    }
                }
            }

            cached_uia = Some((
                win,
                monitor,
                els,
                table,
                gms,
                memory_hints,
                memory_ms,
                app_pref_brain,
                primary_brain,
            ));
        } else {
            cached_uia = Some((
                win,
                monitor,
                Vec::new(),
                String::new(),
                0,
                memory_hints,
                memory_ms,
                app_pref_brain,
                primary_brain,
            ));
        }
    }

    // Tier 2: Full Vision SoM fallback
    emit_brain_status(
        app,
        "capturing",
        brain,
        Some("Capturing & grounding active window...".to_string()),
    );

    let prepared = crate::grounding::capture_and_ground(Some(app)).await?;
    let capture_file = allocate_capture_path();
    let capture_path = capture_file.to_string_lossy().to_string();
    save_raw_capture_async(
        capture_file,
        prepared.raw_image_for_save,
        prepared.som_jpeg_bytes.clone(),
    );

    let (app_pref_brain, memory_hints, memory_ms, primary_brain) = if let Some((_, _, _, _, _, hints, m_ms, pref, p_brain)) = cached_uia {
        (pref, hints, m_ms, p_brain)
    } else {
        let app_pref_brain = crate::db::get_app_preference(db, &prepared.snapshot.active_app);
        let mem_started = Instant::now();
        let memory_hints = crate::memory::retrieve_memory_hints(
            db,
            &prepared.snapshot.active_app,
            &prepared.snapshot.window_title,
            &trimmed_query,
        );
        let memory_ms = mem_started.elapsed().as_millis() as u64;
        let (_, planned_order) = resolve_brain_order(&BrainRoutingInput {
            settings: &settings,
            app_preferred_brain: app_pref_brain.as_deref(),
            brain_override: brain,
            secrets: &brain_state.secrets,
            cached_auth: cached_auth.as_ref(),
            detected_agents: &detected_agents,
        });
        let primary_brain = planned_order.first().copied().unwrap_or(BrainKind::LocalVlm);
        (app_pref_brain, memory_hints, memory_ms, primary_brain)
    };

    emit_brain_status(
        app,
        "thinking",
        Some(primary_brain),
        Some(format!("Thinking with {}...", primary_brain.as_str())),
    );

    let req = build_grounded_brain_request(
        &trimmed_query,
        CaptureContext {
            image_base64: prepared.som_image_base64.clone(),
            image_path: capture_path.clone(),
            active_app: prepared.snapshot.active_app.clone(),
            window_title: prepared.snapshot.window_title.clone(),
            screen_resolution: (prepared.snapshot.monitor.w, prepared.snapshot.monitor.h),
        },
        &prepared.snapshot.element_table_prompt,
        &memory_hints,
        &settings.companion_id,
        false,
        history,
    );

    let overrides = ProviderOverrides {
        detected_agents_override: Some(detected_agents),
        ..Default::default()
    };

    let llm_started = Instant::now();
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
            emit_brain_status(app, "error", Some(failed_kind), Some(msg));
            return Err(err_json);
        }
    };
    let llm_ms = llm_started.elapsed().as_millis() as u64;

    plan.enforce_limits();

    emit_brain_status(
        app,
        "locating",
        Some(used_brain),
        Some("Snapping to UI elements...".to_string()),
    );

    let resolved_steps =
        crate::grounding::resolve_plan_with_grounding(&plan, &prepared.snapshot).await;

    let total_ms = total_started.elapsed().as_millis() as u64;
    let latency = LatencyBreakdown {
        capture_ms: prepared.snapshot.capture_ms,
        grounding_ms: prepared.snapshot.grounding_ms,
        memory_ms,
        llm_ms,
        total_ms,
    };
    brain_state.record_latency(latency);

    let session_id = Uuid::new_v4().to_string();
    let created_at = unix_now();
    persist_session_and_steps(
        db,
        &session_id,
        &prepared.snapshot.active_app,
        &trimmed_query,
        used_brain,
        created_at,
        &resolved_steps,
        Some(&capture_path),
    );

    brain_state.push_history(&trimmed_query, &plan);

    if let Err(e) = overlay::start_guidance(
        app,
        resolved_steps.clone(),
        plan.mode,
        Some(capture_path.clone()),
        Some(prepared.snapshot.monitor.clone()),
        Some(session_id.clone()),
    ) {
        log::warn!("Failed to start overlay guidance: {}", e);
    }

    let ask_turns: Vec<LiveSessionTurn> = resolved_steps
        .iter()
        .enumerate()
        .map(|(idx, step)| LiveSessionTurn {
            turn_number: if step.step_number > 0 {
                step.step_number
            } else {
                (idx + 1) as u32
            },
            user_text: if idx == 0 {
                Some(trimmed_query.clone())
            } else {
                None
            },
            instruction_line: step.instruction_line.clone(),
            spoken_text: step.spoken_text.clone(),
            action_kind: step.action_kind.clone(),
            companion_emotion: step.companion_emotion.clone(),
            target_name: step.target_name.clone(),
            rect_px: step.rect_px,
            active_app: prepared.snapshot.active_app.clone(),
            window_title: prepared.snapshot.window_title.clone(),
            latency: if idx == 0 { Some(latency) } else { None },
            timestamp: created_at,
        })
        .collect();

    if let Err(e) = crate::memory::record_session_and_write_graph(
        db,
        &session_id,
        &prepared.snapshot.active_app,
        &trimmed_query,
        &resolved_steps,
        &ask_turns,
        false,
    ) {
        log::warn!(
            "Failed to record Knowledge Graph for session {}: {}",
            session_id,
            e
        );
    }

    let playbook_id =
        find_best_matching_playbook_id(db, &prepared.snapshot.active_app, &trimmed_query);

    emit_brain_status(app, "done", Some(used_brain), None);

    Ok(AskResponse {
        session_id,
        brain: used_brain,
        plan,
        resolved_steps,
        capture_path: Some(capture_path),
        monitor: Some(prepared.snapshot.monitor),
        latency: Some(latency),
        resolution_tier: Some("tier2_vision".to_string()),
        tokens_saved: Some(0),
        playbook_id,
    })
}

/// Primary AI guidance IPC command (`ask(query, brain?, force_ai?)`).
#[tauri::command]
pub async fn ask(
    app: AppHandle,
    db: State<'_, DbState>,
    brain_state: State<'_, BrainState>,
    query: String,
    brain: Option<BrainKind>,
    force_ai: Option<bool>,
) -> Result<AskResponse, String> {
    ask_inner(
        &app,
        &db,
        &brain_state,
        query,
        brain,
        force_ai.unwrap_or(false),
    )
    .await
}

/// Tests a configured brain/provider/model with a real lightweight roundtrip and returns latency.
#[tauri::command]
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

/// Returns recent and averaged latency breakdown samples across `ask` and live session turns.
#[tauri::command]
pub fn get_latency_stats(
    brain_state: State<'_, BrainState>,
    limit: Option<usize>,
) -> Result<LatencyStats, String> {
    Ok(brain_state.latency_stats(limit.unwrap_or(25)))
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

/// Detects installed headless coding agent CLIs (`claude`, `codex`, `gemini`, `agy`, `copilot`, `opencode`, `hermes`, `custom`) with a 60s cache.
#[tauri::command]
pub fn detect_agents(
    db: State<'_, DbState>,
    brain_state: State<'_, BrainState>,
) -> Result<Vec<DetectedAgent>, String> {
    let custom_cmd = db
        .get_settings()
        .ok()
        .and_then(|s| s.custom_agent_cmd);
    Ok(brain_state.detect_agents_cached(custom_cmd.as_deref()))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{GroundedElementSource, RectPx, Step, StepSource};

    fn el(id: u32, label: &str) -> GroundedElement {
        GroundedElement {
            id,
            label: label.to_string(),
            control_type: "Button".to_string(),
            rect_px: RectPx {
                x: (id as i32) * 40,
                y: 20,
                w: 36,
                h: 24,
            },
            norm_bbox: [10.0, 10.0, 20.0, 20.0],
            source: GroundedElementSource::Uia,
            is_taskbar: false,
        }
    }

    #[test]
    fn tier1_eligibility_and_resolution_checks_work() {
        let few = vec![el(1, "File"), el(2, "Edit")];
        assert!(!is_tier1_eligible("notepad.exe", "Untitled", "save file", &few, ""));

        let six = vec![
            el(1, "File"),
            el(2, "Edit"),
            el(3, "View"),
            el(4, "Terminal"),
            el(5, "Run"),
            el(6, "Help"),
        ];
        // Unrelated query with no memory hints -> not eligible
        assert!(!is_tier1_eligible("notepad.exe", "Untitled", "render shader", &six, ""));
        // Query matches labeled element -> eligible
        assert!(is_tier1_eligible("notepad.exe", "Untitled", "open terminal", &six, ""));
        // Memory hints present -> eligible
        assert!(is_tier1_eligible("notepad.exe", "Untitled", "something", &six, "- [Playbook]"));
        // Terminal profile -> eligible
        assert!(is_tier1_eligible("WindowsTerminal.exe", "PowerShell", "git status", &six, ""));

        let unresolved_step = ResolvedStep::from_step(
            Step {
                step_number: 1,
                instruction_line: "Click icon".to_string(),
                target_name: None,
                control_type: None,
                bbox: None,
                confidence: 0.2,
                shortcut: None,
                terminal_command: None,
                explanation: None,
                spoken_text: None,
                target_id: None,
                action_kind: Some("click".to_string()),
                companion_emotion: None,
                goal_complete: false,
            },
            None,
            StepSource::None,
        );
        let unresolved_plan = StepPlan {
            mode: StepMode::Guide,
            total_steps: 1,
            steps: vec![unresolved_step.to_step()],
        };
        assert!(!is_tier1_plan_resolved(&unresolved_plan, &[unresolved_step]));

        let resolved_step = ResolvedStep::from_step(
            Step {
                step_number: 1,
                instruction_line: "Click Terminal".to_string(),
                target_name: Some("Terminal".to_string()),
                control_type: Some("Button".to_string()),
                bbox: None,
                confidence: 0.9,
                shortcut: None,
                terminal_command: None,
                explanation: None,
                spoken_text: None,
                target_id: Some(4),
                action_kind: Some("click".to_string()),
                companion_emotion: None,
                goal_complete: false,
            },
            Some(six[3].rect_px),
            StepSource::Som,
        );
        assert!(is_tier1_plan_resolved(&unresolved_plan, &[resolved_step]));
    }
}
