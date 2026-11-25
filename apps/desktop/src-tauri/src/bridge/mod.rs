use crate::capture::{self, Capture};
use crate::db::{self, DbState};
use crate::overlay;
use crate::types::{
    BrainKind, MonitorInfo, RectPx, ResolvedStep, Step, StepMode, StepPlan, StepSource,
};
use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;
use uuid::Uuid;

pub const DEFAULT_BRIDGE_PORT: u16 = 47615;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeManifest {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

#[derive(Clone)]
pub struct BridgeContext {
    pub app: Option<AppHandle>,
    pub token: String,
    pub last_capture: Arc<Mutex<Option<(String, MonitorInfo)>>>,
}

impl BridgeContext {
    pub fn new(app: Option<AppHandle>, token: String) -> Self {
        Self {
            app,
            token,
            last_capture: Arc::new(Mutex::new(None)),
        }
    }

    fn current_monitor_and_capture(&self) -> (Option<String>, MonitorInfo) {
        if let Ok(guard) = self.last_capture.lock() {
            if let Some((ref path, ref mon)) = *guard {
                return (Some(path.clone()), mon.clone());
            }
        }
        let mon = primary_monitor_info();
        (None, mon)
    }
}

fn primary_monitor_info() -> MonitorInfo {
    if let Ok(monitors) = xcap::Monitor::all() {
        if let Some(m) = monitors.iter().find(|m| m.is_primary()).or_else(|| monitors.first()) {
            let scale = m.scale_factor() as f64;
            return MonitorInfo {
                x: m.x(),
                y: m.y(),
                w: m.width(),
                h: m.height(),
                scale: if scale > 0.0 { scale } else { 1.0 },
            };
        }
    }
    MonitorInfo::default()
}

/// Returns `%LOCALAPPDATA%\GuideLens\bridge.json`.
pub fn bridge_manifest_path() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
    let dir = base.join("GuideLens");
    let _ = fs::create_dir_all(&dir);
    dir.join("bridge.json")
}

/// Removes `%LOCALAPPDATA%\GuideLens\bridge.json` on clean application shutdown.
pub fn remove_bridge_manifest() {
    let path = bridge_manifest_path();
    let _ = fs::remove_file(path);
}

/// Generates a cryptographically random 32-byte hex token (64 hex characters).
pub fn generate_bearer_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    ok: bool,
    version: &'static str,
}

#[derive(Debug, Serialize)]
struct OkResponse {
    ok: bool,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug, Serialize)]
struct CaptureResponse {
    image_path: String,
    image_base64: String,
    active_app: String,
    window_title: String,
    monitor: MonitorInfo,
}

#[derive(Debug, Deserialize)]
pub struct HighlightRequest {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default = "default_coords_mode")]
    pub coords: String,
    #[serde(default)]
    pub step_label: Option<String>,
    pub instruction_text: String,
    #[serde(default)]
    pub magnify: Option<bool>,
}

fn default_coords_mode() -> String {
    "normalized".to_string()
}

#[derive(Debug, Deserialize)]
pub struct ShowCommandRequest {
    pub command: String,
    pub explanation: String,
}

#[derive(Debug, Deserialize)]
pub struct GuideRequest {
    pub plan: StepPlan,
}

async fn bearer_auth_middleware(
    State(ctx): State<BridgeContext>,
    req: Request,
    next: Next,
) -> Response {
    let expected = format!("Bearer {}", ctx.token);
    let authorized = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|val| constant_time_eq(val.trim().as_bytes(), expected.as_bytes()))
        .unwrap_or(false);

    if !authorized {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "Unauthorized: valid Authorization: Bearer <token> required".to_string(),
            }),
        )
            .into_response();
    }

    next.run(req).await
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn health_handler() -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn capture_handler(
    State(ctx): State<BridgeContext>,
) -> Result<Json<CaptureResponse>, (StatusCode, Json<ErrorResponse>)> {
    let cap: Capture = tokio::task::spawn_blocking(capture::capture_active_screen)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Capture join error: {}", e),
                }),
            )
        })?
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: e }),
            )
        })?;

    if let Ok(mut guard) = ctx.last_capture.lock() {
        *guard = Some((cap.image_path.clone(), cap.monitor.clone()));
    }

    Ok(Json(CaptureResponse {
        image_path: cap.image_path,
        image_base64: cap.image_base64,
        active_app: cap.active_app,
        window_title: cap.window_title,
        monitor: cap.monitor,
    }))
}

fn parse_step_number(label: Option<&str>) -> u32 {
    label
        .and_then(|s| {
            s.split(|c: char| !c.is_ascii_digit())
                .find(|part| !part.is_empty())
                .and_then(|num| num.parse::<u32>().ok())
        })
        .filter(|&n| n > 0)
        .unwrap_or(1)
}

async fn highlight_handler(
    State(ctx): State<BridgeContext>,
    Json(req): Json<HighlightRequest>,
) -> Result<Json<OkResponse>, (StatusCode, Json<ErrorResponse>)> {
    let (capture_path, monitor) = ctx.current_monitor_and_capture();

    let (bbox, rect_px) = if req.coords.eq_ignore_ascii_case("pixels") {
        let r = RectPx {
            x: req.x.round() as i32,
            y: req.y.round() as i32,
            w: req.width.round().max(0.0) as i32,
            h: req.height.round().max(0.0) as i32,
        };
        let norm = capture::physical_to_normalized(r, &monitor);
        (Some(norm), Some(r))
    } else {
        let norm = [req.x, req.y, req.width, req.height];
        let r = capture::normalized_to_physical(norm, &monitor);
        (Some(norm), Some(r))
    };

    let resolved = ResolvedStep {
        step_number: parse_step_number(req.step_label.as_deref()),
        instruction_line: Step::clamp_instruction(&req.instruction_text),
        target_name: req.step_label,
        control_type: None,
        bbox,
        confidence: 1.0,
        shortcut: None,
        terminal_command: None,
        explanation: None,
        spoken_text: None,
        target_id: None,
        action_kind: Some("click".to_string()),
        companion_emotion: Some("pointing".to_string()),
        goal_complete: false,
        rect_px,
        source: StepSource::Vlm,
    };

    if let Some(ref app) = ctx.app {
        overlay::start_guidance(
            app,
            vec![resolved],
            StepMode::Guide,
            capture_path,
            Some(monitor),
            None,
        )
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: e }),
            )
        })?;

        if let Some(mag) = req.magnify {
            let _ = overlay::set_magnify(app, mag);
        }
    }

    Ok(Json(OkResponse { ok: true }))
}

async fn show_command_handler(
    State(ctx): State<BridgeContext>,
    Json(req): Json<ShowCommandRequest>,
) -> Result<Json<OkResponse>, (StatusCode, Json<ErrorResponse>)> {
    if let Some(ref app) = ctx.app {
        overlay::show_terminal_command(app, req.command, req.explanation).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: e }),
            )
        })?;
    }
    Ok(Json(OkResponse { ok: true }))
}

async fn guide_handler(
    State(ctx): State<BridgeContext>,
    Json(mut req): Json<GuideRequest>,
) -> Result<Json<OkResponse>, (StatusCode, Json<ErrorResponse>)> {
    req.plan.enforce_limits();
    let (capture_path, monitor) = ctx.current_monitor_and_capture();

    let resolved_steps: Vec<ResolvedStep> = req
        .plan
        .steps
        .iter()
        .cloned()
        .map(|step| {
            let (rect_px, source) = match step.bbox {
                Some(b) if step.confidence >= 0.5 && b[2] > 0.0 && b[3] > 0.0 => {
                    (Some(capture::normalized_to_physical(b, &monitor)), StepSource::Vlm)
                }
                _ => (None, StepSource::None),
            };
            ResolvedStep::from_step(step, rect_px, source)
        })
        .collect();

    let session_id = Uuid::new_v4().to_string();

    if let Some(ref app) = ctx.app {
        if let Some(db) = app.try_state::<DbState>() {
            let win = capture::detect_active_window();
            let first_instr = resolved_steps
                .first()
                .map(|s| s.instruction_line.as_str())
                .unwrap_or("MCP guide");
            if db
                .insert_session(
                    &session_id,
                    &win.active_app,
                    first_instr,
                    BrainKind::AgentMcp,
                    db::unix_now(),
                )
                .is_ok()
            {
                for s in &resolved_steps {
                    let bbox_json = s
                        .bbox
                        .and_then(|b| serde_json::to_string(&b).ok());
                    let _ = db.insert_step(
                        &session_id,
                        s.step_number,
                        &s.instruction_line,
                        bbox_json.as_deref(),
                        s.terminal_command.as_deref(),
                        capture_path.as_deref(),
                    );
                }
            }
        }

        overlay::start_guidance(
            app,
            resolved_steps,
            req.plan.mode,
            capture_path,
            Some(monitor),
            Some(session_id),
        )
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: e }),
            )
        })?;
    }

    Ok(Json(OkResponse { ok: true }))
}

async fn clear_handler(
    State(ctx): State<BridgeContext>,
) -> Result<Json<OkResponse>, (StatusCode, Json<ErrorResponse>)> {
    if let Some(ref app) = ctx.app {
        overlay::clear_overlay_state(app).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: e }),
            )
        })?;
    }
    Ok(Json(OkResponse { ok: true }))
}

pub fn build_router(ctx: BridgeContext) -> Router {
    Router::new()
        .route("/v1/health", get(health_handler))
        .route("/v1/capture", post(capture_handler))
        .route("/v1/highlight", post(highlight_handler))
        .route("/v1/show_command", post(show_command_handler))
        .route("/v1/guide", post(guide_handler))
        .route("/v1/clear", post(clear_handler))
        .layer(middleware::from_fn_with_state(
            ctx.clone(),
            bearer_auth_middleware,
        ))
        .with_state(ctx)
}

async fn bind_loopback_listener(preferred_port: u16) -> Result<TcpListener, String> {
    for port in preferred_port..preferred_port.saturating_add(50) {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        if let Ok(listener) = TcpListener::bind(addr).await {
            return Ok(listener);
        }
    }
    TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .map_err(|e| format!("Failed to bind localhost bridge server: {}", e))
}

/// Starts the localhost bridge HTTP server on `127.0.0.1:47615` (or next free port)
/// and writes `%LOCALAPPDATA%\GuideLens\bridge.json`.
pub fn start_bridge_server(app: AppHandle) {
    let token = generate_bearer_token();
    let ctx = BridgeContext::new(Some(app), token.clone());

    tauri::async_runtime::spawn(async move {
        let listener = match bind_loopback_listener(DEFAULT_BRIDGE_PORT).await {
            Ok(l) => l,
            Err(e) => {
                log::error!("Bridge server failed to start: {}", e);
                return;
            }
        };

        let port = listener
            .local_addr()
            .map(|a| a.port())
            .unwrap_or(DEFAULT_BRIDGE_PORT);

        let manifest = BridgeManifest {
            port,
            token,
            pid: std::process::id(),
        };
        let manifest_path = bridge_manifest_path();
        if let Ok(json_str) = serde_json::to_string_pretty(&manifest) {
            if let Err(e) = fs::write(&manifest_path, json_str) {
                log::error!("Failed to write bridge manifest {:?}: {}", manifest_path, e);
            }
        }

        log::info!("GuideLens local bridge listening on 127.0.0.1:{}", port);

        let router = build_router(ctx);
        if let Err(e) = axum::serve(listener, router).await {
            log::error!("Bridge server exited with error: {}", e);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_bridge_auth_and_endpoints() {
        let token = generate_bearer_token();
        assert_eq!(token.len(), 64);

        let ctx = BridgeContext::new(None, token.clone());
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .expect("bind loopback");
        let addr = listener.local_addr().expect("local_addr");
        assert!(addr.ip().is_loopback());

        let router = build_router(ctx);
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });

        let client = reqwest::Client::new();
        let base = format!("http://127.0.0.1:{}", addr.port());

        // Missing auth -> 401
        let unauth = client
            .get(format!("{}/v1/health", base))
            .send()
            .await
            .expect("send unauth");
        assert_eq!(unauth.status().as_u16(), 401);

        // Wrong token -> 401
        let bad = client
            .get(format!("{}/v1/health", base))
            .bearer_auth("wrong-token")
            .send()
            .await
            .expect("send bad token");
        assert_eq!(bad.status().as_u16(), 401);

        // Valid bearer token -> 200 { ok: true, version: ... }
        let ok_health = client
            .get(format!("{}/v1/health", base))
            .bearer_auth(&token)
            .send()
            .await
            .expect("send valid health");
        assert_eq!(ok_health.status().as_u16(), 200);
        let body: serde_json::Value = ok_health.json().await.expect("parse json");
        assert_eq!(body["ok"], true);

        // Valid /v1/highlight, /v1/show_command, /v1/guide, /v1/clear
        let hl = client
            .post(format!("{}/v1/highlight", base))
            .bearer_auth(&token)
            .json(&serde_json::json!({
                "x": 100.0,
                "y": 200.0,
                "width": 50.0,
                "height": 40.0,
                "coords": "normalized",
                "step_label": "Step 1",
                "instruction_text": "Click Export",
                "magnify": false
            }))
            .send()
            .await
            .expect("send highlight");
        assert_eq!(hl.status().as_u16(), 200);

        let cmd = client
            .post(format!("{}/v1/show_command", base))
            .bearer_auth(&token)
            .json(&serde_json::json!({
                "command": "git reset --soft HEAD~1",
                "explanation": "Undo last commit keeping staged changes."
            }))
            .send()
            .await
            .expect("send show_command");
        assert_eq!(cmd.status().as_u16(), 200);

        let guide = client
            .post(format!("{}/v1/guide", base))
            .bearer_auth(&token)
            .json(&serde_json::json!({
                "plan": {
                    "mode": "guide",
                    "total_steps": 1,
                    "steps": [{
                        "step_number": 1,
                        "instruction_line": "Click File",
                        "bbox": [10.0, 10.0, 40.0, 20.0],
                        "confidence": 0.9
                    }]
                }
            }))
            .send()
            .await
            .expect("send guide");
        assert_eq!(guide.status().as_u16(), 200);

        let clear = client
            .post(format!("{}/v1/clear", base))
            .bearer_auth(&token)
            .json(&serde_json::json!({}))
            .send()
            .await
            .expect("send clear");
        assert_eq!(clear.status().as_u16(), 200);
    }
}
