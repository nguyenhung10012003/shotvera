mod capture;
mod i18n;
mod output;
mod platform;
mod secrets;
mod settings;
mod windows;

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use capture::CaptureMode;
use i18n::{Lang, Text};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Command-line flag that starts a capture.
const CAPTURE_FLAG: &str = "--capture";

/// Shared state for every command and window.
#[derive(Default)]
pub struct AppState {
    /// The most recent capture, kept until the overlays close.
    pub capture: Mutex<Option<Arc<capture::CaptureSession>>>,
    /// True while the capture overlays are open (prevents double captures).
    pub capturing: AtomicBool,
    /// True while the global pointer is being streamed to the overlays (during a drag).
    pub tracking_pointer: AtomicBool,
    /// Images shown in pin windows, by pin id.
    pub pins: Mutex<HashMap<String, output::PinImage>>,
    /// Kept alive so clipboard contents survive on X11/Wayland.
    pub clipboard: Mutex<Option<arboard::Clipboard>>,
    /// The registered global capture shortcut.
    pub shortcut: Mutex<Option<Shortcut>>,
    /// The tray menu's capture item, whose accelerator label follows the configured shortcut.
    pub capture_menu_item: Mutex<Option<MenuItem<Wry>>>,
}

/// (Re)registers the global capture shortcut, restoring the previous one on failure.
fn register_shortcut(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|e| i18n::tr_error(app, Text::ShortcutInvalid, e))?;
    let state = app.state::<AppState>();
    let mut current = state.shortcut.lock().map_err(|e| e.to_string())?;
    let gs = app.global_shortcut();
    let previous = current.take();
    if let Some(old) = previous {
        let _ = gs.unregister(old);
    }
    match gs.register(shortcut) {
        Ok(()) => {
            *current = Some(shortcut);
            if let Some(item) = state.capture_menu_item.lock().ok().and_then(|i| i.clone()) {
                let _ = item.set_accelerator(Some(accelerator));
            }
            Ok(())
        }
        Err(err) => {
            if let Some(old) = previous {
                if gs.register(old).is_ok() {
                    *current = Some(old);
                }
            }
            Err(i18n::tr_error(app, Text::ShortcutTaken, err))
        }
    }
}

#[tauri::command]
fn set_capture_shortcut(app: AppHandle, shortcut: String) -> Result<(), String> {
    register_shortcut(&app, &shortcut)
}

/// Switches the UI language: rebuilds the tray menu, retitles native windows and tells every
/// webview to re-render. The webview has already saved the choice to `settings.json`.
#[tauri::command]
fn set_language(app: AppHandle, language: String) -> Result<(), String> {
    let lang = Lang::parse(&language);
    let menu = build_menu(&app, lang).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    windows::apply_language(&app, lang);
    app.emit("app://language", lang.code())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// The capture mode requested by a `--capture[=ai|ocr]` command-line argument, if any.
fn capture_flag(args: &[String]) -> Option<CaptureMode> {
    args.iter().find_map(|a| match a.as_str() {
        CAPTURE_FLAG => Some(CaptureMode::Image),
        "--capture=ai" => Some(CaptureMode::Ai),
        "--capture=ocr" => Some(CaptureMode::Ocr),
        _ => None,
    })
}

const TRAY_ID: &str = "main";

/// Builds the tray menu in `lang`. Remembers its capture item so the shortcut label can follow
/// the configured shortcut.
fn build_menu(app: &AppHandle, lang: Lang) -> tauri::Result<Menu<Wry>> {
    let item = |id: &str, text: Text, accelerator: Option<&str>| {
        MenuItem::with_id(app, id, text.get(lang), true, accelerator)
    };
    let accelerator = settings::capture_shortcut(app);
    let capture = item("capture", Text::MenuCapture, Some(accelerator.as_str()))?;
    let capture_ai = item("capture_ai", Text::MenuCaptureAi, None)?;
    let capture_ocr = item("capture_ocr", Text::MenuCaptureOcr, None)?;
    let home = item("home", Text::MenuRecent, None)?;
    let folder = item("folder", Text::MenuOpenFolder, None)?;
    let settings = item("settings", Text::MenuSettings, Some("CmdOrCtrl+,"))?;
    let quit = item("quit", Text::MenuQuit, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(
        app,
        &[
            &capture,
            &capture_ai,
            &capture_ocr,
            &PredefinedMenuItem::separator(app)?,
            &home,
            &folder,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    if let Ok(mut slot) = app.state::<AppState>().capture_menu_item.lock() {
        *slot = Some(capture);
    }
    Ok(menu)
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, i18n::current(app))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tauri::include_image!("icons/tray.png"))
        .icon_as_template(true)
        .tooltip("Shotvera")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "capture" => capture::trigger_after_ui_hides(app, CaptureMode::Image),
            "capture_ai" => capture::trigger_after_ui_hides(app, CaptureMode::Ai),
            "capture_ocr" => capture::trigger_after_ui_hides(app, CaptureMode::Ocr),
            "home" => windows::show_home(app, None),
            "folder" => {
                if let Err(err) = output::open_save_folder(app.clone()) {
                    log::warn!("could not open the save folder: {err}");
                }
            }
            "settings" => windows::show_settings(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                windows::toggle_home(tray.app_handle(), Some(rect));
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("shotvera_lib=info"),
    )
    .init();

    tauri::Builder::default()
        // A second launch forwards its arguments here: `shotvera --capture` starts a capture
        // (handy for Shortcuts, Raycast, scripts); a plain launch opens the popover.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(mode) = capture_flag(&args) {
                capture::trigger_after_ui_hides(app, mode);
            } else {
                windows::show_home(app, None);
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        capture::trigger(app, CaptureMode::Image);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .setup(|app| {
            // Menu-bar / tray app: no Dock icon on macOS.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();
            build_tray(&handle)?;

            let accelerator = settings::capture_shortcut(&handle);
            if let Err(err) = register_shortcut(&handle, &accelerator) {
                log::warn!("could not register {accelerator}: {err}");
                if accelerator != settings::DEFAULT_SHORTCUT {
                    let _ = register_shortcut(&handle, settings::DEFAULT_SHORTCUT);
                }
            }

            // Create the overlay webviews up front so the first capture opens instantly.
            capture::warm_up(&handle);

            if let Some(mode) = capture_flag(&std::env::args().collect::<Vec<_>>()) {
                capture::trigger_after_ui_hides(&handle, mode);
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(false) if window.label() == windows::HOME => {
                let _ = window.hide();
            }
            WindowEvent::CloseRequested { api, .. }
                if window.label().starts_with(capture::OVERLAY_PREFIX) =>
            {
                api.prevent_close();
                capture::hide_overlays(window.app_handle());
            }
            WindowEvent::Destroyed if window.label().starts_with(output::PIN_PREFIX) => {
                output::forget_pin(window.app_handle(), window.label());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            capture::capture_layout,
            capture::capture_meta,
            capture::capture_frame,
            capture::overlay_ready,
            capture::close_overlays,
            capture::start_capture,
            capture::track_pointer,
            output::copy_image,
            output::quick_save,
            output::save_as,
            output::pin_image,
            output::pin_meta,
            output::pin_frame,
            output::list_history,
            output::delete_history,
            output::copy_history_item,
            output::open_save_folder,
            output::pin_history_item,
            output::resolved_save_dir,
            secrets::get_api_key,
            secrets::set_api_key,
            set_language,
            windows::open_settings,
            set_capture_shortcut,
            quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Shotvera")
        .run(|_app, event| {
            // Closing the last window must not quit a tray app; only an explicit exit does.
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
