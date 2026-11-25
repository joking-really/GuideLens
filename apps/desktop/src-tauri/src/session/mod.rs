//! Reactive Live Copilot Session engine (`Idle -> Listening -> Observing -> Guiding -> WaitingSettle -> Paused -> Completed`).

use crate::brain::commands::{allocate_capture_path, save_raw_capture_async};
use crate::brain::router::{
    build_grounded_brain_request, resolve_brain_order, route_and_execute, BrainRoutingInput,
    CaptureContext, ProviderOverrides, RouteExecutionContext,
};
use crate::brain::BrainState;
use crate::db::{unix_now, DbState};
use crate::overlay;
use crate::types::{
    BrainKind, LatencyBreakdown, LiveSessionState, LiveSessionStatus, LiveSessionTurn,
    OverlayCompanionPayload, RectPx, ResolvedStep,
};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

const SETTLE_DELAY_MS: u64 = 280;
const SETTLE_DHASH_DIFF_THRESHOLD: u32 = 3;
const MAX_LIVE_HISTORY_TURNS: usize = 8;

fn default_live_session_state() -> LiveSessionState {
    LiveSessionState {
        session_id: None,
        status: LiveSessionStatus::Idle,
        goal: String::new(),
        companion_id: "pixel_cat".to_string(),
        current_step: None,
        current_monitor: None,
        turn_count: 0,
        turns: Vec::new(),
        graph_md_path: None,
        started_at: None,
    }
}

#[derive(Debug)]
struct LiveSessionInner {
    state: LiveSessionState,
    brain_override: Option<BrainKind>,
    active_app: String,
    last_window_title: String,
    last_hwnd: isize,
    last_dhash64: Option<u64>,
    resolved_steps: Vec<ResolvedStep>,
    conversation_history: Vec<String>,
    generation: u64,
    settle_pending: bool,
}

impl Default for LiveSessionInner {
    fn default() -> Self {
        Self {
            state: default_live_session_state(),
            brain_override: None,
            active_app: String::new(),
            last_window_title: String::new(),
            last_hwnd: 0,
            last_dhash64: None,
            resolved_steps: Vec::new(),
            conversation_history: Vec::new(),
            generation: 0,
            settle_pending: false,
        }
    }
}

#[derive(Clone, Default)]
pub struct LiveSessionManager {
    inner: Arc<Mutex<LiveSessionInner>>,
    step_lock: Arc<tokio::sync::Mutex<()>>,
}

impl LiveSessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> LiveSessionState {
        self.inner
            .lock()
            .map(|g| g.state.clone())
            .unwrap_or_else(|_| default_live_session_state())
    }

    pub fn is_active(&self) -> bool {
        self.inner
            .lock()
            .map(|g| {
                !matches!(
                    g.state.status,
                    LiveSessionStatus::Idle | LiveSessionStatus::Completed
                )
            })
            .unwrap_or(false)
    }

    pub fn is_guiding(&self) -> bool {
        self.inner
            .lock()
            .map(|g| g.state.status == LiveSessionStatus::Guiding)
            .unwrap_or(false)
    }

    fn current_generation(&self) -> u64 {
        self.inner.lock().map(|g| g.generation).unwrap_or(0)
    }
}

/// Pure settle predicate: advances when visual dHash differs by >= 3 bits OR foreground HWND/title changed.
pub fn should_advance_after_settle(
    prev_dhash: Option<u64>,
    new_dhash: u64,
    prev_hwnd: isize,
    new_hwnd: isize,
    prev_title: &str,
    new_title: &str,
) -> bool {
    if new_hwnd != prev_hwnd || new_title != prev_title {
        return true;
    }
    match prev_dhash {
        Some(prev) => crate::capture::hamming_distance(prev, new_dhash) >= SETTLE_DHASH_DIFF_THRESHOLD,
        None => true,
    }
}

/// Pure rect containment helper used to ignore clicks inside GuideLens's own floating capsule/hub windows.
pub fn is_click_in_any_rect(rects: &[RectPx], click_x: i32, click_y: i32) -> bool {
    rects
        .iter()
        .any(|r| r.w > 0 && r.h > 0 && r.contains(click_x, click_y))
}

fn is_click_on_own_window(app: &AppHandle, x: i32, y: i32) -> bool {
    let mut rects = Vec::with_capacity(2);
    for label in ["bar", "settings"] {
        if let Some(win) = app.get_webview_window(label) {
            if win.is_visible().unwrap_or(false) {
                if let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) {
                    rects.push(RectPx {
                        x: pos.x,
                        y: pos.y,
                        w: size.width as i32,
                        h: size.height as i32,
                    });
                }
            }
        }
    }
    is_click_in_any_rect(&rects, x, y)
}

fn emit_live_session(app: &AppHandle, state: &LiveSessionState) {
    let _ = app.emit("live-session-event", state);
}

fn emit_live_companion_status(
    app: &AppHandle,
    companion_id: &str,
    wander: bool,
    screenday_recording: bool,
    mode: &str,
    emotion: &str,
    bubble_text: Option<String>,
) {
    if companion_id.trim().eq_ignore_ascii_case("none") {
        return;
    }
    let _ = overlay::emit_overlay_companion(
        app,
        OverlayCompanionPayload {
            mode: mode.to_string(),
            companion_id: companion_id.to_string(),
            emotion: emotion.to_string(),
            wander,
            x: None,
            y: None,
            bubble_text,
            screenday_recording,
        },
    );
}

fn build_live_turn_query(goal: &str, user_text: Option<&str>, is_first_turn: bool) -> String {
    match user_text.map(str::trim).filter(|s| !s.is_empty()) {
        Some(msg) if is_first_turn => msg.to_string(),
        Some(msg) => format!(
            "Overall Goal: {}\nUser Update: {}\nGive the single immediate next step on the current screen, or set goal_complete=true if finished.",
            goal, msg
        ),
        None => format!(
            "Overall Goal: {}\nThe user just interacted with the screen and it settled. Observe the updated screen and give the single immediate next step, or set goal_complete=true if the goal is accomplished.",
            goal
        ),
    }
}

async fn execute_live_step(
    app: &AppHandle,
    db: &DbState,
    brain_state: &BrainState,
    session_mgr: &LiveSessionManager,
    user_text: Option<String>,
    expected_gen: u64,
) -> Result<LiveSessionState, String> {
    let _step_guard = session_mgr.step_lock.lock().await;
    if session_mgr.current_generation() != expected_gen {
        return Ok(session_mgr.snapshot());
    }

    let total_started = Instant::now();
    let settings = db.get_settings().unwrap_or_default();

    let (session_id, goal, brain_override, history, is_first_turn, started_at) = {
        let mut guard = session_mgr
            .inner
            .lock()
            .map_err(|_| "LiveSessionManager mutex poisoned".to_string())?;
        if guard.generation != expected_gen {
            return Ok(guard.state.clone());
        }
        guard.state.status = LiveSessionStatus::Observing;
        guard.settle_pending = false;
        guard.state.companion_id = settings.companion_id.clone();
        emit_live_session(app, &guard.state);

        (
            guard
                .state
                .session_id
                .clone()
                .ok_or_else(|| "No active live session".to_string())?,
            guard.state.goal.clone(),
            guard.brain_override,
            guard.conversation_history.clone(),
            guard.state.turns.is_empty(),
            guard.state.started_at.unwrap_or_else(unix_now),
        )
    };

    emit_live_companion_status(
        app,
        &settings.companion_id,
        settings.companion_wander,
        settings.screenday_enabled,
        "observing",
        "thinking",
        Some("Watching your screen...".to_string()),
    );

    let prepared = crate::grounding::capture_and_ground(Some(app)).await?;
    if session_mgr.current_generation() != expected_gen {
        return Ok(session_mgr.snapshot());
    }

    let capture_file = allocate_capture_path();
    let capture_path = capture_file.to_string_lossy().to_string();
    save_raw_capture_async(
        capture_file,
        prepared.raw_image_for_save,
        prepared.som_jpeg_bytes.clone(),
    );

    let turn_query = build_live_turn_query(&goal, user_text.as_deref(), is_first_turn);

    let mem_started = Instant::now();
    let memory_hints = crate::memory::retrieve_memory_hints(
        db,
        &prepared.snapshot.active_app,
        &prepared.snapshot.window_title,
        &turn_query,
    );
    let memory_ms = mem_started.elapsed().as_millis() as u64;

    let app_pref_brain = crate::db::get_app_preference(db, &prepared.snapshot.active_app);
    let cached_auth = brain_state.cached_auth.read().await.clone();
    let detected_agents = brain_state.detect_agents_cached(settings.custom_agent_cmd.as_deref());
    let (_, planned_order) = resolve_brain_order(&BrainRoutingInput {
        settings: &settings,
        app_preferred_brain: app_pref_brain.as_deref(),
        brain_override,
        secrets: &brain_state.secrets,
        cached_auth: cached_auth.as_ref(),
        detected_agents: &detected_agents,
    });
    let _primary_brain = planned_order.first().copied().unwrap_or(BrainKind::LocalVlm);

    let req = build_grounded_brain_request(
        &turn_query,
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
        true,
        history,
    );

    let overrides = ProviderOverrides {
        detected_agents_override: Some(detected_agents),
        ..Default::default()
    };

    let llm_started = Instant::now();
    let (used_brain, mut plan) = route_and_execute(
        &req,
        &RouteExecutionContext {
            settings: &settings,
            app_preferred_brain: app_pref_brain.as_deref(),
            brain_override,
            secrets: &brain_state.secrets,
            cached_auth: cached_auth.as_ref(),
            overrides: &overrides,
        },
    )
    .await
    .map_err(|(_, err_json)| err_json)?;
    let llm_ms = llm_started.elapsed().as_millis() as u64;

    if session_mgr.current_generation() != expected_gen {
        return Ok(session_mgr.snapshot());
    }

    plan.steps.truncate(1);
    plan.enforce_limits();

    let resolved_steps =
        crate::grounding::resolve_plan_with_grounding(&plan, &prepared.snapshot).await;
    if session_mgr.current_generation() != expected_gen {
        return Ok(session_mgr.snapshot());
    }

    let step = resolved_steps.into_iter().next().ok_or_else(|| {
        "Brain returned an empty live step plan".to_string()
    })?;

    let total_ms = total_started.elapsed().as_millis() as u64;
    let latency = LatencyBreakdown {
        capture_ms: prepared.snapshot.capture_ms,
        grounding_ms: prepared.snapshot.grounding_ms,
        memory_ms,
        llm_ms,
        total_ms,
    };
    brain_state.record_latency(latency);

    let now = unix_now();
    let is_goal_complete =
        step.goal_complete || step.action_kind.as_deref() == Some("complete");

    if is_first_turn {
        let _ = crate::db::insert_session(
            db,
            &session_id,
            &prepared.snapshot.active_app,
            &goal,
            used_brain,
            started_at,
        );
    }

    let (turn_number, completed_payload) = {
        let mut guard = session_mgr
            .inner
            .lock()
            .map_err(|_| "LiveSessionManager mutex poisoned".to_string())?;
        if guard.generation != expected_gen {
            return Ok(guard.state.clone());
        }

        let turn_num = (guard.state.turns.len() + 1) as u32;
        let mut step_for_turn = step.clone();
        step_for_turn.step_number = turn_num;

        let turn = LiveSessionTurn {
            turn_number: turn_num,
            user_text: user_text.clone(),
            instruction_line: step_for_turn.instruction_line.clone(),
            spoken_text: step_for_turn.spoken_text.clone(),
            action_kind: step_for_turn.action_kind.clone(),
            companion_emotion: step_for_turn.companion_emotion.clone(),
            target_name: step_for_turn.target_name.clone(),
            rect_px: step_for_turn.rect_px,
            active_app: prepared.snapshot.active_app.clone(),
            window_title: prepared.snapshot.window_title.clone(),
            latency: Some(latency),
            timestamp: now,
        };

        guard.last_dhash64 = u64::from_str_radix(&prepared.snapshot.dhash64, 16).ok();
        guard.last_hwnd = prepared.snapshot.hwnd;
        guard.last_window_title = prepared.snapshot.window_title.clone();
        guard.active_app = prepared.snapshot.active_app.clone();
        guard.resolved_steps.push(step_for_turn.clone());
        guard.state.turns.push(turn);
        guard.state.turn_count = guard.state.turns.len() as u32;
        guard.state.current_step = Some(step_for_turn.clone());
        guard.state.current_monitor = Some(prepared.snapshot.monitor.clone());
        guard.state.companion_id = settings.companion_id.clone();

        let history_entry = format!(
            "Turn {} ({}): {} [target: {}]",
            turn_num,
            prepared.snapshot.active_app,
            step_for_turn.instruction_line,
            step_for_turn.target_name.as_deref().unwrap_or("none")
        );
        guard.conversation_history.push(history_entry);
        while guard.conversation_history.len() > MAX_LIVE_HISTORY_TURNS {
            guard.conversation_history.remove(0);
        }

        guard.state.status = if is_goal_complete {
            LiveSessionStatus::Completed
        } else {
            LiveSessionStatus::Guiding
        };

        let payload = if is_goal_complete {
            Some((
                guard.active_app.clone(),
                guard.state.goal.clone(),
                guard.resolved_steps.clone(),
                guard.state.turns.clone(),
            ))
        } else {
            None
        };

        (turn_num, payload)
    };

    let bbox_json = step.bbox.and_then(|b| serde_json::to_string(&b).ok());
    let _ = crate::db::insert_step(
        db,
        &session_id,
        turn_number,
        &step.instruction_line,
        bbox_json.as_deref(),
        step.terminal_command.as_deref(),
        Some(&capture_path),
    );

    if let Some((app_exe, goal_str, steps_all, turns_all)) = completed_payload {
        match crate::memory::record_session_and_write_graph(
            db,
            &session_id,
            &app_exe,
            &goal_str,
            &steps_all,
            &turns_all,
            true,
        ) {
            Ok(summary) => {
                if let Ok(mut guard) = session_mgr.inner.lock() {
                    if guard.generation == expected_gen {
                        guard.state.graph_md_path = Some(summary.graph_md_path);
                    }
                }
            }
            Err(e) => {
                log::warn!("Failed to record completed live session graph: {}", e);
            }
        }
    }

    let mut overlay_step = step;
    overlay_step.step_number = turn_number;
    if let Err(e) = overlay::start_guidance(
        app,
        vec![overlay_step],
        plan.mode,
        Some(capture_path),
        Some(prepared.snapshot.monitor),
        Some(session_id),
    ) {
        log::warn!("Failed to update live overlay guidance: {}", e);
    }

    let snapshot = session_mgr.snapshot();
    emit_live_session(app, &snapshot);

    if is_goal_complete {
        crate::input::release_overlay_hooks_if_idle(app);
    }

    Ok(snapshot)
}

/// Starts a new reactive Live Copilot Session for `goal`, emits `live-session-event`, and runs step 1.
pub async fn start_live_session_impl(
    app: &AppHandle,
    db: &DbState,
    brain_state: &BrainState,
    session_mgr: &LiveSessionManager,
    goal: String,
    brain: Option<BrainKind>,
) -> Result<LiveSessionState, String> {
    let clean_goal = {
        let trimmed = goal.trim();
        if trimmed.is_empty() {
            "Guide me step by step on this screen".to_string()
        } else {
            trimmed.to_string()
        }
    };

    let settings = db.get_settings().unwrap_or_default();
    let new_session_id = Uuid::new_v4().to_string();
    let started_at = unix_now();

    let (expected_gen, listening_snapshot) = {
        let mut guard = session_mgr
            .inner
            .lock()
            .map_err(|_| "LiveSessionManager mutex poisoned".to_string())?;
        guard.generation = guard.generation.wrapping_add(1);
        let gen = guard.generation;
        guard.brain_override = brain;
        guard.active_app.clear();
        guard.last_window_title.clear();
        guard.last_hwnd = 0;
        guard.last_dhash64 = None;
        guard.resolved_steps.clear();
        guard.conversation_history.clear();
        guard.settle_pending = false;
        guard.state = LiveSessionState {
            session_id: Some(new_session_id),
            status: LiveSessionStatus::Listening,
            goal: clean_goal.clone(),
            companion_id: settings.companion_id.clone(),
            current_step: None,
            current_monitor: None,
            turn_count: 0,
            turns: Vec::new(),
            graph_md_path: None,
            started_at: Some(started_at),
        };
        (gen, guard.state.clone())
    };

    emit_live_session(app, &listening_snapshot);
    crate::input::ensure_overlay_hooks(app);

    match execute_live_step(
        app,
        db,
        brain_state,
        session_mgr,
        Some(clean_goal),
        expected_gen,
    )
    .await
    {
        Ok(state) => Ok(state),
        Err(err) => {
            if let Ok(mut guard) = session_mgr.inner.lock() {
                if guard.generation == expected_gen && guard.state.turns.is_empty() {
                    guard.state.status = LiveSessionStatus::Idle;
                    emit_live_session(app, &guard.state);
                }
            }
            crate::input::release_overlay_hooks_if_idle(app);
            Err(err)
        }
    }
}

/// Starts a new reactive Live Copilot Session for `goal`, emits `live-session-event`, and runs step 1.
#[tauri::command]
pub async fn start_live_session(
    app: AppHandle,
    db: State<'_, DbState>,
    brain_state: State<'_, BrainState>,
    session_mgr: State<'_, LiveSessionManager>,
    goal: String,
    brain: Option<BrainKind>,
) -> Result<LiveSessionState, String> {
    start_live_session_impl(&app, &db, &brain_state, &session_mgr, goal, brain).await
}

/// Sends a spoken/typed follow-up message in the active Live Session (or starts one if idle).
#[tauri::command]
pub async fn send_live_message(
    app: AppHandle,
    db: State<'_, DbState>,
    brain_state: State<'_, BrainState>,
    session_mgr: State<'_, LiveSessionManager>,
    text: String,
    session_id: Option<String>,
) -> Result<LiveSessionState, String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err("Message text must not be empty".to_string());
    }

    let should_start_fresh = {
        let guard = session_mgr
            .inner
            .lock()
            .map_err(|_| "LiveSessionManager mutex poisoned".to_string())?;
        let idle_or_done = matches!(
            guard.state.status,
            LiveSessionStatus::Idle | LiveSessionStatus::Completed
        );
        let id_mismatch = session_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
            .is_some_and(|id| guard.state.session_id.as_deref() != Some(id));
        idle_or_done || (guard.state.session_id.is_none() && id_mismatch)
    };

    if should_start_fresh {
        return start_live_session_impl(&app, &db, &brain_state, &session_mgr, trimmed, None).await;
    }

    let expected_gen = {
        let mut guard = session_mgr
            .inner
            .lock()
            .map_err(|_| "LiveSessionManager mutex poisoned".to_string())?;
        guard.generation = guard.generation.wrapping_add(1);
        guard.settle_pending = false;
        guard.state.status = LiveSessionStatus::Listening;
        emit_live_session(&app, &guard.state);
        guard.generation
    };

    match execute_live_step(
        &app,
        &db,
        &brain_state,
        &session_mgr,
        Some(trimmed),
        expected_gen,
    )
    .await
    {
        Ok(state) => Ok(state),
        Err(err) => {
            if let Ok(mut guard) = session_mgr.inner.lock() {
                if guard.generation == expected_gen {
                    guard.state.status = if guard.state.turns.is_empty() {
                        LiveSessionStatus::Idle
                    } else {
                        LiveSessionStatus::Guiding
                    };
                    emit_live_session(&app, &guard.state);
                }
            }
            Err(err)
        }
    }
}

/// Pauses or resumes click-advance & live observation for the active Live Session.
#[tauri::command]
pub async fn pause_live_session(
    app: AppHandle,
    session_mgr: State<'_, LiveSessionManager>,
    paused: bool,
    session_id: Option<String>,
) -> Result<LiveSessionState, String> {
    let settings = app
        .try_state::<DbState>()
        .and_then(|db| db.get_settings().ok())
        .unwrap_or_default();

    let snapshot = {
        let mut guard = session_mgr
            .inner
            .lock()
            .map_err(|_| "LiveSessionManager mutex poisoned".to_string())?;
        if let Some(ref req_sid) = session_id {
            if !req_sid.trim().is_empty()
                && guard.state.session_id.as_deref() != Some(req_sid.as_str())
            {
                return Ok(guard.state.clone());
            }
        }
        if matches!(
            guard.state.status,
            LiveSessionStatus::Idle | LiveSessionStatus::Completed
        ) {
            return Ok(guard.state.clone());
        }

        guard.generation = guard.generation.wrapping_add(1);
        guard.settle_pending = false;
        guard.state.status = if paused {
            LiveSessionStatus::Paused
        } else if guard.state.current_step.is_some() {
            LiveSessionStatus::Guiding
        } else {
            LiveSessionStatus::Listening
        };
        guard.state.clone()
    };

    if paused {
        emit_live_companion_status(
            &app,
            &settings.companion_id,
            settings.companion_wander,
            settings.screenday_enabled,
            "idle",
            "peeking",
            Some("Paused — resume whenever you're ready.".to_string()),
        );
    } else if let Some(ref step) = snapshot.current_step {
        let _ = overlay::start_guidance(
            &app,
            vec![step.clone()],
            if step.terminal_command.is_some() {
                crate::types::StepMode::Terminal
            } else {
                crate::types::StepMode::Guide
            },
            None,
            snapshot.current_monitor.clone(),
            snapshot.session_id.clone(),
        );
    }

    emit_live_session(&app, &snapshot);
    Ok(snapshot)
}

/// Ends the active Live Session, writes its `.graph.md` + Knowledge Graph entry, and clears overlay guidance.
pub async fn end_live_session_impl(
    app: &AppHandle,
    db: &DbState,
    session_mgr: &LiveSessionManager,
    session_id: Option<String>,
) -> Result<LiveSessionState, String> {
    let record_payload = {
        let mut guard = session_mgr
            .inner
            .lock()
            .map_err(|_| "LiveSessionManager mutex poisoned".to_string())?;
        if let Some(ref req_sid) = session_id {
            if !req_sid.trim().is_empty()
                && guard.state.session_id.as_deref() != Some(req_sid.as_str())
            {
                return Ok(guard.state.clone());
            }
        }

        if guard.state.status == LiveSessionStatus::Idle {
            return Ok(guard.state.clone());
        }

        let already_recorded = guard.state.status == LiveSessionStatus::Completed
            && guard.state.graph_md_path.is_some();

        guard.generation = guard.generation.wrapping_add(1);
        guard.settle_pending = false;
        guard.state.status = LiveSessionStatus::Completed;

        if !already_recorded && (!guard.resolved_steps.is_empty() || !guard.state.turns.is_empty()) {
            guard.state.session_id.clone().map(|sid| {
                (
                    sid,
                    guard.active_app.clone(),
                    guard.state.goal.clone(),
                    guard.resolved_steps.clone(),
                    guard.state.turns.clone(),
                )
            })
        } else {
            None
        }
    };

    if let Some((sid, app_exe, goal, steps, turns)) = record_payload {
        match crate::memory::record_session_and_write_graph(
            db, &sid, &app_exe, &goal, &steps, &turns, true,
        ) {
            Ok(summary) => {
                if let Ok(mut guard) = session_mgr.inner.lock() {
                    guard.state.graph_md_path = Some(summary.graph_md_path);
                }
            }
            Err(e) => {
                log::warn!("Failed to record ended live session graph: {}", e);
            }
        }
    }

    let _ = overlay::clear_overlay_state(app);
    crate::input::release_overlay_hooks_if_idle(app);

    let snapshot = session_mgr.snapshot();
    emit_live_session(app, &snapshot);
    Ok(snapshot)
}

/// Ends the active Live Session, writes its `.graph.md` + Knowledge Graph entry, and clears overlay guidance.
#[tauri::command]
pub async fn end_live_session(
    app: AppHandle,
    db: State<'_, DbState>,
    session_mgr: State<'_, LiveSessionManager>,
    session_id: Option<String>,
) -> Result<LiveSessionState, String> {
    end_live_session_impl(&app, &db, &session_mgr, session_id).await
}

/// Toggles a Live Copilot Session from the system tray ("Start / Stop Live Session").
pub async fn toggle_live_session_from_tray(app: AppHandle) {
    let (Some(db), Some(brain_state), Some(mgr)) = (
        app.try_state::<DbState>(),
        app.try_state::<BrainState>(),
        app.try_state::<LiveSessionManager>(),
    ) else {
        return;
    };

    if mgr.is_active() {
        let _ = end_live_session_impl(&app, &db, &mgr, None).await;
    } else {
        let _ = start_live_session_impl(
            &app,
            &db,
            &brain_state,
            &mgr,
            "Guide me step by step on this screen".to_string(),
            None,
        )
        .await;
    }
}

/// Returns the current `LiveSessionState`.
#[tauri::command]
pub fn get_live_session(
    session_mgr: State<'_, LiveSessionManager>,
) -> Result<LiveSessionState, String> {
    Ok(session_mgr.snapshot())
}

/// Called by `input/mod.rs` on global `WM_LBUTTONUP`: waits 280ms to let the UI settle,
/// checks whether the screen changed (`dhash` diff >= 3 or foreground HWND/title switch),
/// and automatically advances the active Live Session to the next step.
pub fn notify_user_click(app: &AppHandle, x: i32, y: i32) {
    if is_click_on_own_window(app, x, y) {
        return;
    }

    let Some(session_mgr) = app.try_state::<LiveSessionManager>() else {
        return;
    };

    let settle_ctx = {
        let Ok(mut guard) = session_mgr.inner.lock() else {
            return;
        };
        if guard.state.status != LiveSessionStatus::Guiding || guard.settle_pending {
            return;
        }
        guard.settle_pending = true;
        guard.state.status = LiveSessionStatus::WaitingSettle;
        let snap = guard.state.clone();
        (
            guard.generation,
            guard.last_dhash64,
            guard.last_hwnd,
            guard.last_window_title.clone(),
            guard.active_app.clone(),
            snap,
        )
    };

    let (expected_gen, prev_dhash, prev_hwnd, prev_title, prev_app, settle_snapshot) = settle_ctx;
    emit_live_session(app, &settle_snapshot);

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(SETTLE_DELAY_MS)).await;

        let Some(mgr) = app_handle.try_state::<LiveSessionManager>() else {
            return;
        };
        if mgr.current_generation() != expected_gen {
            return;
        }

        let app_for_cap = app_handle.clone();
        let frame_res = tokio::task::spawn_blocking(move || {
            crate::capture::capture_for_live_grounding(Some(&app_for_cap))
        })
        .await;

        let Ok(Ok(frame)) = frame_res else {
            if let Ok(mut guard) = mgr.inner.lock() {
                if guard.generation == expected_gen
                    && guard.state.status == LiveSessionStatus::WaitingSettle
                {
                    guard.state.status = LiveSessionStatus::Guiding;
                    guard.settle_pending = false;
                    emit_live_session(&app_handle, &guard.state);
                }
            }
            return;
        };

        let screen_changed = should_advance_after_settle(
            prev_dhash,
            frame.dhash64,
            prev_hwnd,
            frame.hwnd,
            &prev_title,
            &frame.window_title,
        ) || !frame.active_app.eq_ignore_ascii_case(&prev_app);

        if !screen_changed {
            if let Ok(mut guard) = mgr.inner.lock() {
                if guard.generation == expected_gen
                    && guard.state.status == LiveSessionStatus::WaitingSettle
                {
                    guard.state.status = LiveSessionStatus::Guiding;
                    guard.settle_pending = false;
                    emit_live_session(&app_handle, &guard.state);
                }
            }
            return;
        }

        let (Some(db), Some(brain_state)) = (
            app_handle.try_state::<DbState>(),
            app_handle.try_state::<BrainState>(),
        ) else {
            return;
        };

        if let Err(err) =
            execute_live_step(&app_handle, &db, &brain_state, &mgr, None, expected_gen).await
        {
            log::warn!("Live session auto-advance step error: {}", err);
            if let Ok(mut guard) = mgr.inner.lock() {
                if guard.generation == expected_gen
                    && !matches!(
                        guard.state.status,
                        LiveSessionStatus::Idle
                            | LiveSessionStatus::Completed
                            | LiveSessionStatus::Paused
                    )
                {
                    guard.state.status = LiveSessionStatus::Guiding;
                    guard.settle_pending = false;
                    emit_live_session(&app_handle, &guard.state);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settle_predicate_checks_dhash_threshold_and_window_switches() {
        let base_hash: u64 = 0x1234_5678_9abc_def0;

        // Identical or 1-2 bit jitter on same window -> do not advance
        assert!(!should_advance_after_settle(
            Some(base_hash),
            base_hash,
            100,
            100,
            "Editor",
            "Editor"
        ));
        assert!(!should_advance_after_settle(
            Some(base_hash),
            base_hash ^ 0b11,
            100,
            100,
            "Editor",
            "Editor"
        ));

        // 3+ bit visual change -> advance
        assert!(should_advance_after_settle(
            Some(base_hash),
            base_hash ^ 0b111,
            100,
            100,
            "Editor",
            "Editor"
        ));

        // HWND switch -> advance even with identical hash
        assert!(should_advance_after_settle(
            Some(base_hash),
            base_hash,
            100,
            202,
            "Editor",
            "Editor"
        ));

        // Title change -> advance even on same HWND
        assert!(should_advance_after_settle(
            Some(base_hash),
            base_hash,
            100,
            100,
            "Inbox",
            "Compose Message"
        ));

        // Missing prior hash -> advance
        assert!(should_advance_after_settle(
            None,
            base_hash,
            100,
            100,
            "Editor",
            "Editor"
        ));
    }

    #[test]
    fn click_in_own_window_rects_ignores_bar_and_hub_clicks() {
        let bar_rect = RectPx {
            x: 700,
            y: 40,
            w: 480,
            h: 64,
        };
        let hub_rect = RectPx {
            x: 200,
            y: 120,
            w: 1120,
            h: 740,
        };
        assert!(is_click_in_any_rect(&[bar_rect, hub_rect], 820, 60));
        assert!(is_click_in_any_rect(&[bar_rect, hub_rect], 500, 300));
        assert!(!is_click_in_any_rect(&[bar_rect, hub_rect], 120, 40));
        assert!(!is_click_in_any_rect(&[], 120, 40));
    }

    #[test]
    fn live_session_manager_initial_state_and_transitions() {
        let mgr = LiveSessionManager::new();
        let snap = mgr.snapshot();
        assert_eq!(snap.status, LiveSessionStatus::Idle);
        assert!(!mgr.is_active());
        assert!(!mgr.is_guiding());

        {
            let mut guard = mgr.inner.lock().unwrap();
            guard.state.session_id = Some("live-1".to_string());
            guard.state.status = LiveSessionStatus::Listening;
        }
        assert!(mgr.is_active());
        assert!(!mgr.is_guiding());

        {
            let mut guard = mgr.inner.lock().unwrap();
            guard.state.status = LiveSessionStatus::Guiding;
        }
        assert!(mgr.is_active());
        assert!(mgr.is_guiding());

        {
            let mut guard = mgr.inner.lock().unwrap();
            guard.state.status = LiveSessionStatus::WaitingSettle;
        }
        assert!(mgr.is_active());
        assert!(!mgr.is_guiding());

        {
            let mut guard = mgr.inner.lock().unwrap();
            guard.state.status = LiveSessionStatus::Paused;
        }
        assert!(mgr.is_active());
        assert!(!mgr.is_guiding());

        {
            let mut guard = mgr.inner.lock().unwrap();
            guard.state.status = LiveSessionStatus::Completed;
        }
        assert!(!mgr.is_active());
        assert!(!mgr.is_guiding());
    }

    #[test]
    fn build_live_turn_query_formats_first_followup_and_settle_prompts() {
        assert_eq!(
            build_live_turn_query("Export PNG", Some("Export PNG"), true),
            "Export PNG"
        );
        let followup = build_live_turn_query("Export PNG", Some("Use 2x scale"), false);
        assert!(followup.contains("Overall Goal: Export PNG"));
        assert!(followup.contains("User Update: Use 2x scale"));

        let settled = build_live_turn_query("Export PNG", None, false);
        assert!(settled.contains("Overall Goal: Export PNG"));
        assert!(settled.contains("settled"));
    }
}
