//! The tray popover ("home") and the settings window.

use tauri::{AppHandle, Manager, Rect, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const HOME: &str = "home";
pub const SETTINGS: &str = "settings";

const HOME_WIDTH: f64 = 340.0;
const HOME_HEIGHT: f64 = 500.0;

fn home_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(HOME) {
        return Ok(w);
    }
    let builder = WebviewWindowBuilder::new(app, HOME, WebviewUrl::App("index.html#home".into()))
        .title("Shotvera")
        .inner_size(HOME_WIDTH, HOME_HEIGHT)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false);
    // A translucent, blurred popover like the system's own menu-bar extras.
    #[cfg(target_os = "macos")]
    let builder = {
        use tauri::window::{Effect, EffectState, EffectsBuilder};
        builder.transparent(true).shadow(true).effects(
            EffectsBuilder::new()
                .effect(Effect::Popover)
                .state(EffectState::Active)
                .radius(14.0)
                .build(),
        )
    };
    builder.build()
}

/// Top-left of the popover (macOS, global points): centered under the clicked status item on the
/// monitor that holds the pointer, just below that monitor's menu bar.
///
/// Uses the pointer and our own monitor list rather than the tray rect's y, which comes out wrong
/// when a secondary display sits above the primary one.
#[cfg(target_os = "macos")]
fn popover_origin(anchor: Option<&Rect>) -> Option<(f64, f64)> {
    let (px, py, _) = crate::platform::global_pointer()?;
    let monitor = xcap::Monitor::all().ok()?.into_iter().find(|m| {
        let (Ok(x), Ok(y), Ok(w), Ok(h)) = (m.x(), m.y(), m.width(), m.height()) else {
            return false;
        };
        px >= x as f64 && px < (x + w as i32) as f64 && py >= y as f64 && py < (y + h as i32) as f64
    })?;
    let (mx, my, mw) = (
        monitor.x().ok()? as f64,
        monitor.y().ok()? as f64,
        monitor.width().ok()? as f64,
    );
    let scale = monitor.scale_factor().unwrap_or(2.0) as f64;
    // The status item is as tall as the menu bar (taller on notched displays).
    let menu_bar = anchor
        .map(|r| r.size.to_logical::<f64>(scale).height)
        .filter(|h| *h > 10.0 && *h < 60.0)
        .unwrap_or(24.0);
    let x = (px - HOME_WIDTH / 2.0).clamp(mx + 8.0, mx + mw - HOME_WIDTH - 8.0);
    Some((x, my + menu_bar + 5.0))
}

/// Shows the popover under the menu-bar icon (macOS) or above the tray icon (Windows/Linux).
pub fn show_home(app: &AppHandle, anchor: Option<Rect>) {
    let Ok(window) = home_window(app) else { return };
    #[cfg(target_os = "macos")]
    let placed = popover_origin(anchor.as_ref())
        .map(|(x, y)| {
            window
                .set_position(tauri::LogicalPosition::new(x, y))
                .is_ok()
        })
        .unwrap_or(false);
    #[cfg(not(target_os = "macos"))]
    let placed = anchor
        .map(|rect| {
            let scale = window.scale_factor().unwrap_or(1.0);
            let pos = rect.position.to_physical::<f64>(scale);
            let size = rect.size.to_physical::<f64>(scale);
            let (w, h) = window
                .outer_size()
                .map(|s| (s.width as f64, s.height as f64))
                .unwrap_or((HOME_WIDTH * scale, HOME_HEIGHT * scale));
            let x = pos.x + size.width / 2.0 - w / 2.0;
            let y = pos.y - h - 8.0;
            window
                .set_position(tauri::PhysicalPosition::new(x.max(0.0), y.max(0.0)))
                .is_ok()
        })
        .unwrap_or(false);
    if !placed {
        let _ = window.center();
    }
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn toggle_home(app: &AppHandle, anchor: Option<Rect>) {
    match app.get_webview_window(HOME) {
        Some(w) if w.is_visible().unwrap_or(false) => {
            let _ = w.hide();
        }
        _ => show_home(app, anchor),
    }
}

/// Hides the popover; returns whether it was visible.
pub fn hide_home(app: &AppHandle) -> bool {
    match app.get_webview_window(HOME) {
        Some(w) if w.is_visible().unwrap_or(false) => {
            let _ = w.hide();
            true
        }
        _ => false,
    }
}

pub fn show_settings(app: &AppHandle) {
    hide_home(app);
    if let Some(w) = app.get_webview_window(SETTINGS) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let builder =
        WebviewWindowBuilder::new(app, SETTINGS, WebviewUrl::App("index.html#settings".into()))
            .title("Cài đặt Shotvera")
            .inner_size(620.0, 560.0)
            .resizable(false)
            .center()
            .focused(true);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    match builder.build() {
        Ok(w) => {
            let _ = w.set_focus();
        }
        Err(err) => log::error!("could not open settings: {err}"),
    }
}

#[tauri::command]
pub async fn open_settings(app: AppHandle) {
    show_settings(&app);
}
