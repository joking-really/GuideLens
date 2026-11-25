pub mod brain;
pub mod bridge;
pub mod capture;
pub mod db;
pub mod grounding;
pub mod input;
pub mod locator;
pub mod memory;
pub mod overlay;
pub mod screenday;
pub mod session;
pub mod types;

use crate::db::DbState;
use crate::overlay::OverlayState;
use crate::screenday::ScreenDayState;
use crate::session::LiveSessionManager;
use crate::types::{HistoryDetail, HistorySession, ResolvedStep, Settings};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, State,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[tauri::command]
fn next_step(app: AppHandle) -> Result<Option<ResolvedStep>, String> {
    overlay::advance_step(&app)
}

#[tauri::command]
fn clear_overlay(app: AppHandle) -> Result<(), String> {
    overlay::clear_overlay_state(&app)
}

#[tauri::command]
fn toggle_magnify(app: AppHandle, on: bool) -> Result<(), String> {
    overlay::set_magnify(&app, on)
}

#[tauri::command]
fn get_settings(db: State<'_, DbState>) -> Result<Settings, String> {
    db.get_settings()
}

#[tauri::command]
fn set_settings(app: AppHandle, db: State<'_, DbState>, s: Settings) -> Result<(), String> {
    let prev_custom_agent = db.get_settings().ok().and_then(|p| p.custom_agent_cmd);
    db.set_settings(&s)?;
    if let Some(sd) = app.try_state::<ScreenDayState>() {
        sd.set_enabled(s.screenday_enabled);
    }
    if prev_custom_agent != s.custom_agent_cmd {
        if let Some(brain_state) = app.try_state::<brain::BrainState>() {
            brain_state.invalidate_agent_cache();
        }
    }
    overlay::sync_companion_with_settings(&app, &s);
    let _ = tauri::Emitter::emit(&app, "settings-changed", &s);
    Ok(())
}

#[tauri::command]
fn history_list(db: State<'_, DbState>, limit: Option<u32>) -> Result<Vec<HistorySession>, String> {
    db.history_list(limit.unwrap_or(50))
}

#[tauri::command]
fn history_get(db: State<'_, DbState>, session_id: String) -> Result<HistoryDetail, String> {
    db.history_get(&session_id)
}

#[tauri::command]
fn copy_to_clipboard(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard()
        .write_text(text)
        .map_err(|e| format!("Failed to copy to clipboard: {}", e))
}

fn open_settings_tab(app: &AppHandle, tab: &str, title: &str) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = tauri::Emitter::emit(
            app,
            "settings-route",
            serde_json::json!({ "route": "/settings", "tab": tab }),
        );
        let _ = win.set_title(title);
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn toggle_screenday_from_tray(app: &AppHandle) {
    if let (Some(db), Some(sd)) = (app.try_state::<DbState>(), app.try_state::<ScreenDayState>()) {
        let next_enabled = !sd.is_enabled();
        sd.set_enabled(next_enabled);
        let mut settings = db.get_settings().unwrap_or_default();
        settings.screenday_enabled = next_enabled;
        if let Err(e) = db.set_settings(&settings) {
            log::warn!("Failed to persist Screen Day tray toggle: {}", e);
        }
        overlay::sync_companion_with_settings(app, &settings);
        let _ = tauri::Emitter::emit(app, "settings-changed", &settings);
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle_live = MenuItem::with_id(
        app,
        "toggle_live_session",
        "Start / Stop Live Session",
        true,
        None::<&str>,
    )?;
    let toggle_screenday = MenuItem::with_id(
        app,
        "toggle_screenday",
        "Toggle Screen Day",
        true,
        None::<&str>,
    )?;
    let open_control_center = MenuItem::with_id(
        app,
        "open_control_center",
        "Open Control Center",
        true,
        None::<&str>,
    )?;
    let open_voice_studio =
        MenuItem::with_id(app, "open_voice_studio", "Voice Studio", true, None::<&str>)?;
    let clear_item = MenuItem::with_id(app, "clear_overlay", "Clear Overlay", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit GuideLens", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &toggle_live,
            &toggle_screenday,
            &open_control_center,
            &open_voice_studio,
            &clear_item,
            &quit_item,
        ],
    )?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("GuideLens — Press Ctrl+Space to summon")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                input::toggle_bar_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle_live_session" => {
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    session::toggle_live_session_from_tray(app_clone).await;
                });
            }
            "toggle_screenday" => toggle_screenday_from_tray(app),
            "open_control_center" => {
                open_settings_tab(app, "overview", "GuideLens Control Center");
            }
            "open_voice_studio" => open_settings_tab(app, "voice", "GuideLens Voice Studio"),
            "clear_overlay" => {
                let _ = overlay::clear_overlay_state(app);
            }
            "quit" => {
                input::stop_input_hooks();
                let _ = overlay::clear_overlay_state(app);
                bridge::remove_bridge_manifest();
                app.exit(0);
            }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    let _tray = builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let db_state = DbState::init_default().expect("Failed to initialize GuideLens SQLite database");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(bar) = app.get_webview_window("bar") {
                let _ = bar.unminimize();
                let _ = bar.show();
                let _ = bar.set_focus();
                let _ = tauri::Emitter::emit(app, "bar-summoned", ());
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(db_state)
        .manage(OverlayState::new())
        .manage(brain::BrainState::new())
        .manage(LiveSessionManager::new())
        .manage(ScreenDayState::new())
        .setup(|app| {
            let handle = app.handle().clone();

            // Configure overlay window to span the virtual desktop and be 100% click-through
            overlay::configure_overlay_window(&handle);
            if let Some(db) = handle.try_state::<DbState>() {
                if let Ok(settings) = db.get_settings() {
                    overlay::sync_companion_with_settings(&handle, &settings);
                }
            }

            // Restore bar position if valid within virtual desktop, else center near top of primary monitor
            if let Some(bar) = handle.get_webview_window("bar") {
                let (vx, vy, vw, vh) = overlay::virtual_desktop_bounds();
                let saved_pos = handle
                    .try_state::<DbState>()
                    .and_then(|db| db.get_settings().ok())
                    .and_then(|s| s.bar_position);

                let in_bounds = saved_pos.filter(|pos| {
                    pos.x >= vx
                        && pos.x < vx + vw as i32 - 80
                        && pos.y >= vy
                        && pos.y < vy + vh as i32 - 40
                });

                if let Some(pos) = in_bounds {
                    let _ = bar.set_position(PhysicalPosition::new(pos.x, pos.y));
                } else if let Ok(Some(mon)) = bar.primary_monitor() {
                    let scale = mon.scale_factor();
                    let bar_w = (480.0 * scale).round() as i32;
                    let x = mon.position().x + ((mon.size().width as i32 - bar_w) / 2).max(0);
                    let y = mon.position().y + (48.0 * scale).round() as i32;
                    let _ = bar.set_position(PhysicalPosition::new(x, y));
                }

                let _ = bar.unminimize();
                let _ = bar.show();
                let _ = bar.set_focus();
            }

            // Initialize global Ctrl+Space shortcut + WH_MOUSE_LL / WH_KEYBOARD_LL hooks
            if let Err(e) = input::init_input_hooks(&handle) {
                log::warn!("Input hooks initialization warning: {}", e);
            }

            // Start localhost HTTP bridge on 127.0.0.1:47615 for guidelens-mcp
            bridge::start_bridge_server(handle.clone());

            // Start all-day privacy-shielded Screen Day worker
            screenday::start_screenday_worker(handle.clone());

            // Build system tray icon
            if let Err(e) = setup_tray(&handle) {
                log::warn!("Tray icon setup warning: {}", e);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            next_step,
            clear_overlay,
            toggle_magnify,
            get_settings,
            set_settings,
            history_list,
            history_get,
            copy_to_clipboard,
            brain::commands::ask,
            brain::commands::set_api_key,
            brain::commands::delete_api_key,
            brain::commands::list_api_key_providers,
            brain::commands::ollama_status,
            brain::commands::ollama_pull,
            brain::commands::detect_agents,
            brain::commands::auth_login,
            brain::commands::auth_logout,
            brain::commands::auth_status,
            brain::commands::billing_checkout,
            brain::commands::transcribe,
            brain::commands::test_brain_connection,
            brain::commands::get_latency_stats,
            session::start_live_session,
            session::send_live_message,
            session::end_live_session,
            session::get_live_session,
            session::pause_live_session,
            overlay::preview_companion,
            memory::get_knowledge_graph,
            memory::list_session_graphs,
            memory::read_graph_markdown,
            memory::delete_memory_node,
            screenday::screenday_set_enabled,
            screenday::screenday_status,
            screenday::screenday_capture_now,
            screenday::screenday_list_days,
            screenday::screenday_get_day,
            screenday::screenday_generate_summary,
        ])
        .on_window_event(|window, event| {
            if window.label() == "bar" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = overlay::clear_overlay_state(window.app_handle());
                }
            } else if window.label() == "settings" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running GuideLens Tauri application");
}
