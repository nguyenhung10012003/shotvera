//! Screen capture: grabs every monitor, shows one frozen-screenshot overlay window per monitor,
//! and lists on-screen windows so the overlay can snap the selection to them.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use image::RgbaImage;
use serde::Serialize;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::{output, platform, AppState};

pub const OVERLAY_PREFIX: &str = "overlay-";

/// Apps whose windows are never useful snap targets.
const IGNORED_APPS: &[&str] = &[
    "Window Server",
    "Dock",
    "Control Center",
    "Control Centre",
    "Notification Center",
    "Notification Centre",
    "Spotlight",
    "WindowManager",
];

pub struct MonitorShot {
    pub index: usize,
    /// Monitor origin and size in the platform's window coordinates
    /// (points on macOS, physical pixels on Windows/Linux).
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    pub primary: bool,
    pub image: RgbaImage,
}

pub struct CaptureSession {
    pub id: u64,
    pub mode: CaptureMode,
    pub monitors: Vec<MonitorShot>,
}

/// What happens once the user has selected a region.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureMode {
    /// Plain capture: annotate, copy, save.
    #[default]
    Image,
    /// Open the AI chat as soon as the region is selected.
    Ai,
    /// Extract the text of the region right away.
    Ocr,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMeta {
    session_id: u64,
    mode: CaptureMode,
    width: u32,
    height: u32,
}

#[derive(Serialize, Clone)]
struct WindowRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    title: String,
    app: String,
}

#[derive(Serialize, Clone)]
struct WindowsPayload {
    windows: Vec<WindowRect>,
}

/// Where a monitor sits in the desktop (global units: points on macOS, physical pixels elsewhere).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorLayout {
    index: usize,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    image_width: u32,
    image_height: u32,
    /// CSS pixels of this monitor's overlay per global unit (points are CSS pixels on macOS).
    css_per_native: f64,
}

pub fn overlay_label(index: usize) -> String {
    format!("{OVERLAY_PREFIX}{index}")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Starts a capture unless one is already open.
pub fn trigger(app: &AppHandle, mode: CaptureMode) {
    let state = app.state::<AppState>();
    if state.capturing.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(err) = capture_now(&app, mode) {
            log::error!("capture failed: {err}");
            app.state::<AppState>()
                .capturing
                .store(false, Ordering::SeqCst);
            output::notify(&app, "Không chụp được màn hình", &err);
        }
    });
}

/// Hides Shotvera's own popover first so it does not end up in the screenshot.
pub fn trigger_after_ui_hides(app: &AppHandle, mode: CaptureMode) {
    let had_home = crate::windows::hide_home(app);
    let app = app.clone();
    std::thread::spawn(move || {
        if had_home {
            std::thread::sleep(Duration::from_millis(180));
        }
        trigger(&app, mode);
    });
}

fn capture_now(app: &AppHandle, mode: CaptureMode) -> Result<(), String> {
    if !platform::has_screen_permission() {
        platform::request_screen_permission();
        return Err(
            "Hãy cấp quyền Ghi màn hình (Screen Recording) cho Shotvera trong Cài đặt hệ thống, rồi mở lại ứng dụng."
                .into(),
        );
    }

    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let mut shots = Vec::with_capacity(monitors.len());
    for (index, m) in monitors.iter().enumerate() {
        let err = |e: xcap::XCapError| e.to_string();
        shots.push(MonitorShot {
            index,
            x: m.x().map_err(err)?,
            y: m.y().map_err(err)?,
            width: m.width().map_err(err)?,
            height: m.height().map_err(err)?,
            scale: m.scale_factor().unwrap_or(1.0),
            primary: m.is_primary().unwrap_or(index == 0),
            image: m.capture_image().map_err(err)?,
        });
    }
    if shots.is_empty() {
        return Err("Không tìm thấy màn hình nào.".into());
    }

    for m in &shots {
        log::info!(
            "captured monitor {} at ({}, {}) {}x{} -> {}x{} px (primary: {})",
            m.index,
            m.x,
            m.y,
            m.width,
            m.height,
            m.image.width(),
            m.image.height(),
            m.primary
        );
    }
    let session = Arc::new(CaptureSession {
        id: now_ms(),
        mode,
        monitors: shots,
    });
    *app.state::<AppState>()
        .capture
        .lock()
        .map_err(|e| e.to_string())? = Some(session.clone());

    let ui_app = app.clone();
    let ui_session = session.clone();
    app.run_on_main_thread(move || {
        if let Err(err) = prepare_overlays(&ui_app, &ui_session) {
            log::error!("overlay setup failed: {err}");
        }
        let _ = ui_app.emit("capture://start", ui_session.id);
    })
    .map_err(|e| e.to_string())?;

    // Safety net: show the overlays even if a webview never reports that it rendered.
    let fallback_app = app.clone();
    let id = session.id;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        show_all(&fallback_app, id);
    });

    // Window rectangles for click-to-select / hover highlighting; arrives shortly after the overlay.
    let list_app = app.clone();
    std::thread::spawn(move || emit_windows(&list_app, &session));
    Ok(())
}

/// Pre-creates hidden overlay windows, one per monitor.
pub fn warm_up(app: &AppHandle) {
    let count = xcap::Monitor::all().map(|m| m.len()).unwrap_or(1).max(1);
    for index in 0..count {
        if app.get_webview_window(&overlay_label(index)).is_none() {
            if let Err(err) = create_overlay(app, index) {
                log::warn!("could not pre-create overlay {index}: {err}");
            }
        }
    }
}

fn create_overlay(app: &AppHandle, index: usize) -> tauri::Result<WebviewWindow> {
    let url = WebviewUrl::App(format!("index.html#overlay?monitor={index}").into());
    let builder = WebviewWindowBuilder::new(app, overlay_label(index), url)
        .title("Shotvera")
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .shadow(false)
        .focused(false)
        .visible(false);
    #[cfg(target_os = "macos")]
    let builder = builder.accept_first_mouse(true);
    let window = builder.build()?;
    platform::configure_overlay(&window);
    Ok(window)
}

fn prepare_overlays(app: &AppHandle, session: &CaptureSession) -> tauri::Result<()> {
    let count = session.monitors.len();
    for (label, window) in app.webview_windows() {
        let stale = label
            .strip_prefix(OVERLAY_PREFIX)
            .and_then(|i| i.parse::<usize>().ok())
            .is_some_and(|i| i >= count);
        if stale {
            let _ = window.destroy();
        }
    }
    for m in &session.monitors {
        let window = match app.get_webview_window(&overlay_label(m.index)) {
            Some(w) => w,
            None => create_overlay(app, m.index)?,
        };
        place_overlay(&window, m)?;
    }
    Ok(())
}

/// Covers monitor `m` exactly. The size is set before the position: on macOS resizing keeps the
/// window's bottom edge fixed, so resizing after positioning would push the top edge off-screen.
fn place_overlay(window: &WebviewWindow, m: &MonitorShot) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use tauri::{LogicalPosition, LogicalSize};
        window.set_size(LogicalSize::new(m.width as f64, m.height as f64))?;
        window.set_position(LogicalPosition::new(m.x as f64, m.y as f64))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri::{PhysicalPosition, PhysicalSize};
        window.set_size(PhysicalSize::new(m.width, m.height))?;
        window.set_position(PhysicalPosition::new(m.x, m.y))?;
    }
    Ok(())
}

fn show_overlay(app: &AppHandle, session: &CaptureSession, monitor: usize) {
    let Some(window) = app.get_webview_window(&overlay_label(monitor)) else {
        return;
    };
    let was_visible = window.is_visible().unwrap_or(false);
    log::info!("showing overlay {monitor} (already visible: {was_visible})");
    let _ = window.show();
    platform::configure_overlay(&window);
    let primary = session
        .monitors
        .iter()
        .find(|m| m.primary)
        .map_or(0, |m| m.index);
    if !was_visible && monitor == primary {
        let _ = window.set_focus();
    }
}

fn show_all(app: &AppHandle, session_id: u64) {
    let ui_app = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = ui_app.state::<AppState>();
        if !state.capturing.load(Ordering::SeqCst) {
            return;
        }
        let session = state.capture.lock().ok().and_then(|s| s.clone());
        if let Some(session) = session.filter(|s| s.id == session_id) {
            for m in &session.monitors {
                show_overlay(&ui_app, &session, m.index);
            }
        }
    });
}

/// Hides every overlay and ends the capture session. Call on the main thread.
pub fn hide_overlays(app: &AppHandle) {
    log::info!("closing capture overlays");
    for (label, window) in app.webview_windows() {
        if label.starts_with(OVERLAY_PREFIX) {
            let _ = window.hide();
        }
    }
    let state = app.state::<AppState>();
    state.capturing.store(false, Ordering::SeqCst);
    if let Ok(mut capture) = state.capture.lock() {
        *capture = None;
    }
    let _ = app.emit("capture://end", ());
    // Hand focus back to the app the user was in, unless one of our own windows is still up.
    #[cfg(target_os = "macos")]
    {
        let ours_visible = app.webview_windows().iter().any(|(label, w)| {
            !label.starts_with(OVERLAY_PREFIX) && w.is_visible().unwrap_or(false)
        });
        if !ours_visible {
            let _ = app.hide();
        }
    }
}

/// `hide_overlays` from any thread.
pub fn hide_overlays_async(app: &AppHandle) -> Result<(), String> {
    let ui_app = app.clone();
    app.run_on_main_thread(move || hide_overlays(&ui_app))
        .map_err(|e| e.to_string())
}

/// Lists on-screen windows in global units so the overlays can highlight them on hover and select
/// a whole window with one click, even one that spans several monitors.
fn emit_windows(app: &AppHandle, session: &CaptureSession) {
    let windows = match xcap::Window::all() {
        Ok(w) => w,
        Err(err) => {
            log::warn!("window list unavailable: {err}");
            return;
        }
    };
    let own_pid = std::process::id();
    let mut rects = Vec::new();
    for w in windows {
        if w.pid().ok() == Some(own_pid) || w.is_minimized().unwrap_or(false) {
            continue;
        }
        let app_name = w.app_name().unwrap_or_default();
        if IGNORED_APPS.contains(&app_name.as_str()) {
            continue;
        }
        let (Ok(x), Ok(y), Ok(width), Ok(height)) = (w.x(), w.y(), w.width(), w.height()) else {
            continue;
        };
        if width < 50 || height < 50 {
            continue;
        }
        let on_screen = session.monitors.iter().any(|m| {
            x < m.x + m.width as i32
                && x + width as i32 > m.x
                && y < m.y + m.height as i32
                && y + height as i32 > m.y
        });
        if !on_screen {
            continue;
        }
        rects.push(WindowRect {
            x: x as f64,
            y: y as f64,
            w: width as f64,
            h: height as f64,
            title: w.title().unwrap_or_default(),
            app: app_name,
        });
    }
    log::info!("listed {} windows for snapping", rects.len());
    let _ = app.emit("capture://windows", WindowsPayload { windows: rects });
}

fn session_monitor(
    session: &Option<Arc<CaptureSession>>,
    monitor: usize,
) -> Result<&MonitorShot, String> {
    session
        .as_ref()
        .ok_or_else(|| "no active capture".to_string())?
        .monitors
        .get(monitor)
        .ok_or_else(|| format!("no monitor {monitor} in this capture"))
}

#[tauri::command]
pub fn capture_layout(state: State<'_, AppState>) -> Result<Vec<MonitorLayout>, String> {
    let session = state.capture.lock().map_err(|e| e.to_string())?.clone();
    let session = session.ok_or("no active capture")?;
    Ok(session
        .monitors
        .iter()
        .map(|m| MonitorLayout {
            index: m.index,
            x: m.x,
            y: m.y,
            width: m.width,
            height: m.height,
            image_width: m.image.width(),
            image_height: m.image.height(),
            css_per_native: if cfg!(target_os = "macos") {
                1.0
            } else {
                1.0 / m.scale.max(0.1) as f64
            },
        })
        .collect())
}

#[tauri::command]
pub fn capture_meta(state: State<'_, AppState>, monitor: usize) -> Result<CaptureMeta, String> {
    let session = state.capture.lock().map_err(|e| e.to_string())?.clone();
    let m = session_monitor(&session, monitor)?;
    Ok(CaptureMeta {
        session_id: session.as_ref().map_or(0, |s| s.id),
        mode: session.as_ref().map_or(CaptureMode::Image, |s| s.mode),
        width: m.image.width(),
        height: m.image.height(),
    })
}

/// Raw RGBA pixels of one monitor (no encoding, so the overlay can appear immediately).
#[tauri::command]
pub async fn capture_frame(state: State<'_, AppState>, monitor: usize) -> Result<Response, String> {
    let session = state.capture.lock().map_err(|e| e.to_string())?.clone();
    let m = session_monitor(&session, monitor)?;
    Ok(Response::new(m.image.as_raw().clone()))
}

#[tauri::command]
pub fn overlay_ready(app: AppHandle, state: State<'_, AppState>, monitor: usize) {
    if !state.capturing.load(Ordering::SeqCst) {
        return;
    }
    let session = state.capture.lock().ok().and_then(|s| s.clone());
    if let Some(session) = session {
        show_overlay(&app, &session, monitor);
    }
}

#[tauri::command]
pub fn close_overlays(app: AppHandle) {
    hide_overlays(&app);
}

#[derive(Serialize, Clone, PartialEq)]
struct PointerState {
    x: f64,
    y: f64,
    down: bool,
}

/// Streams the global pointer to the overlays until the button is released.
///
/// A drag that starts on one monitor's overlay stops receiving mouse events in the webview once
/// the pointer crosses onto another monitor, so the overlay follows this stream instead.
#[tauri::command]
pub fn track_pointer(app: AppHandle, state: State<'_, AppState>) {
    if platform::global_pointer().is_none() || state.tracking_pointer.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let mut last: Option<PointerState> = None;
        // Bounded (about 10 minutes) in case the button state is never reported as released.
        for _ in 0..75_000 {
            let Some((x, y, down)) = platform::global_pointer() else {
                break;
            };
            let current = PointerState { x, y, down };
            if last.as_ref() != Some(&current) {
                let _ = app.emit("overlay://pointer", current.clone());
                last = Some(current);
            }
            if !down {
                break;
            }
            std::thread::sleep(Duration::from_millis(8));
        }
        app.state::<AppState>()
            .tracking_pointer
            .store(false, Ordering::SeqCst);
    });
}

#[tauri::command]
pub fn start_capture(app: AppHandle, mode: Option<CaptureMode>) {
    trigger_after_ui_hides(&app, mode.unwrap_or_default());
}
