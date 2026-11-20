pub mod brain;
pub mod bridge;
pub mod capture;
pub mod db;
pub mod input;
pub mod locator;
pub mod overlay;
pub mod types;

use crate::db::DbState;
use crate::overlay::OverlayState;
use crate::types::{HistoryDetail, HistorySession, ResolvedStep, Settings};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, State,
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
fn set_settings(db: State<'_, DbState>, s: Settings) -> Result<(), String> {
    db.set_settings(&s)
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

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_hide = MenuItem::with_id(app, "toggle_bar", "Show / Hide Bar", true, None::<&str>)?;
    let clear_item = MenuItem::with_id(app, "clear_overlay", "Clear Overlay", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit GuideLens", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_hide, &clear_item, &quit_item])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("GuideLens — Press Ctrl+Space to summon")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle_bar" => input::toggle_bar_window(app),
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
        .setup(|app| {
            let handle = app.handle().clone();

            // Configure overlay window to span the virtual desktop and be 100% click-through
            overlay::configure_overlay_window(&handle);

            // Restore bar position if persisted in settings
            if let Some(db) = handle.try_state::<DbState>() {
                if let Ok(settings) = db.get_settings() {
                    if let Some(pos) = settings.bar_position {
                        if let Some(bar) = handle.get_webview_window("bar") {
                            let _ = bar.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
                        }
                    }
                }
            }

            // Initialize global Ctrl+Space shortcut + WH_MOUSE_LL / WH_KEYBOARD_LL hooks
            if let Err(e) = input::init_input_hooks(&handle) {
                log::warn!("Input hooks initialization warning: {}", e);
            }

            // Start localhost HTTP bridge on 127.0.0.1:47615 for guidelens-mcp
            bridge::start_bridge_server(handle.clone());

            // Build system tray icon with Quit
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
