//! Screen recording.
//!
//! The user picks the area in the capture overlay (modes `record` and `gif`). This module then
//! runs a recorder back end, shows floating controls and a border around the recorded area, and
//! files the result in the save folder and in the "Recent" list.

mod encode;
#[cfg(target_os = "macos")]
mod macos;
mod portable;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use image::RgbaImage;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::capture::{self, CaptureMode};
use crate::i18n::{self, Text};
use crate::{output, platform, settings, AppState};
use encode::Msg;

/// Floating window with the timer and the pause and stop buttons.
pub const CONTROLS: &str = "recorder";
/// Click-through window that draws a border just outside the recorded area.
pub const FRAME: &str = "recframe";
/// Control bar size, in CSS pixels.
const CONTROLS_SIZE: (f64, f64) = (236.0, 44.0);
/// Gap between the recorded area and the border drawn around it, in CSS pixels.
const FRAME_PAD: f64 = 4.0;
/// GIF frame rate: keeps files small and lets the encoder keep up.
const GIF_FPS: u32 = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordFormat {
    Mp4,
    Gif,
}

impl RecordFormat {
    fn extension(self) -> &'static str {
        match self {
            RecordFormat::Mp4 => "mp4",
            RecordFormat::Gif => "gif",
        }
    }
}

/// Sent by the overlay: the selected area in global units (points on macOS, physical pixels
/// elsewhere) and the options chosen in the record bar.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordRequest {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    format: RecordFormat,
    microphone: bool,
}

/// Everything a back end needs to record one area.
#[derive(Clone)]
pub struct Job {
    pub format: RecordFormat,
    pub output: PathBuf,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub temp_dir: PathBuf,
    pub fps: u32,
    pub microphone: bool,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub show_clicks: bool,
    /// xcap's monitor id. On macOS this is the CGDirectDisplayID.
    pub monitor_id: u32,
    /// The area as fractions of the monitor.
    pub region: encode::RelRect,
    /// The area relative to the monitor in global units, top-left origin: (x, y, width, height).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub local: (f64, f64, f64, f64),
    /// Monitor size in global units.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub monitor_size: (f64, f64),
    /// Physical pixels per global unit.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub scale: f64,
    pub out_width: u32,
    pub out_height: u32,
}

pub enum Outcome {
    Saved {
        path: PathBuf,
        duration: Duration,
        /// Sound was requested but could not be recorded.
        mic_unavailable: bool,
    },
    Cancelled,
}

/// A running back end. Send it [`Msg`] commands, then join `done` to get the result.
pub struct Handle {
    tx: SyncSender<Msg>,
    done: JoinHandle<Result<Outcome, String>>,
}

struct Active {
    handle: Handle,
    format: RecordFormat,
    output: PathBuf,
    thumbnail: Option<RgbaImage>,
    started: Instant,
    paused_since: Option<Instant>,
    paused_total: Duration,
}

impl Active {
    fn elapsed(&self) -> Duration {
        self.paused_since
            .unwrap_or_else(Instant::now)
            .duration_since(self.started)
            .saturating_sub(self.paused_total)
    }
}

/// Recording state kept in [`AppState`].
#[derive(Default)]
pub struct Recorder {
    active: Mutex<Option<Active>>,
    /// True while a stopped recording is being finalized.
    processing: AtomicBool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// "idle", "recording", "paused" or "processing".
    state: &'static str,
    elapsed_ms: u64,
    format: Option<RecordFormat>,
}

pub fn is_active(app: &AppHandle) -> bool {
    app.state::<AppState>()
        .recorder
        .active
        .lock()
        .map(|a| a.is_some())
        .unwrap_or(false)
}

fn status(app: &AppHandle) -> Status {
    let recorder = &app.state::<AppState>().recorder;
    let guard = recorder.active.lock().ok();
    match guard.as_ref().and_then(|a| a.as_ref()) {
        Some(active) => Status {
            state: if active.paused_since.is_some() {
                "paused"
            } else {
                "recording"
            },
            elapsed_ms: active.elapsed().as_millis() as u64,
            format: Some(active.format),
        },
        None => Status {
            state: if recorder.processing.load(Ordering::SeqCst) {
                "processing"
            } else {
                "idle"
            },
            elapsed_ms: 0,
            format: None,
        },
    }
}

fn emit_status(app: &AppHandle) {
    let _ = app.emit("recording://state", status(app));
}

/// Called from the tray, the menu or the shortcut. Stops the running recording, or opens the
/// overlay to pick an area to record.
pub fn toggle(app: &AppHandle, mode: CaptureMode) {
    if is_active(app) {
        stop(app);
    } else if !app
        .state::<AppState>()
        .recorder
        .processing
        .load(Ordering::SeqCst)
    {
        capture::trigger_after_ui_hides(app, mode);
    }
}

// ------------------------------------------------------------------------------------- start

/// The display that holds the area, and the area clipped to that display.
#[derive(Clone)]
struct Target {
    monitor_id: u32,
    /// Monitor bounds in global units: (x, y, width, height).
    monitor: (f64, f64, f64, f64),
    /// The area to record, in global units, inside `monitor`.
    rect: (f64, f64, f64, f64),
    /// Physical pixels per global unit: the Retina factor on macOS, 1 elsewhere.
    units_to_px: f64,
    /// The display's UI scale (physical pixels per CSS pixel).
    dpi: f64,
}

impl Target {
    fn resolve(r: &RecordRequest) -> Result<Target, String> {
        let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
        let bounds = |m: &xcap::Monitor| -> Option<(f64, f64, f64, f64)> {
            Some((
                m.x().ok()? as f64,
                m.y().ok()? as f64,
                m.width().ok()? as f64,
                m.height().ok()? as f64,
            ))
        };
        // A recording covers a single display: the one under the centre of the selection.
        let (cx, cy) = (r.x + r.width / 2.0, r.y + r.height / 2.0);
        let monitor = monitors
            .iter()
            .find(|m| {
                bounds(m).is_some_and(|(x, y, w, h)| cx >= x && cx < x + w && cy >= y && cy < y + h)
            })
            .or_else(|| monitors.first())
            .ok_or("no display found")?;
        let (mx, my, mw, mh) = bounds(monitor).ok_or("cannot read the display bounds")?;
        let x0 = r.x.max(mx);
        let y0 = r.y.max(my);
        let x1 = (r.x + r.width).min(mx + mw);
        let y1 = (r.y + r.height).min(my + mh);
        if x1 - x0 < 16.0 || y1 - y0 < 16.0 {
            return Err("the selected area is too small to record".into());
        }
        let dpi = monitor.scale_factor().unwrap_or(1.0) as f64;
        Ok(Target {
            monitor_id: monitor.id().map_err(|e| e.to_string())?,
            monitor: (mx, my, mw, mh),
            rect: (x0, y0, x1 - x0, y1 - y0),
            units_to_px: if cfg!(target_os = "macos") { dpi } else { 1.0 },
            dpi,
        })
    }
}

fn make_job(app: &AppHandle, request: &RecordRequest, t: &Target) -> Result<Job, String> {
    let (x, y, w, h) = t.rect;
    let (mx, my, mw, mh) = t.monitor;
    let (fps, max_edge) = match request.format {
        RecordFormat::Mp4 => (settings::record_fps(app), 3840),
        RecordFormat::Gif => (GIF_FPS, 960),
    };
    // On Retina displays, record one pixel per point unless full resolution is turned on. The
    // file is a quarter of the size and still looks sharp at normal viewing size.
    let px_per_unit =
        if request.format == RecordFormat::Mp4 && settings::record_full_resolution(app) {
            t.units_to_px
        } else {
            1.0_f64.max(t.units_to_px / t.dpi.max(1.0))
        };
    let (out_width, out_height) = encode::output_size(w * px_per_unit, h * px_per_unit, max_edge);

    let dir = settings::save_dir(app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let output = output::unique_path(&dir, &output::recording_name(request.format.extension()));
    let temp_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("recordings");
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;

    Ok(Job {
        format: request.format,
        output,
        temp_dir,
        fps,
        microphone: request.microphone,
        show_clicks: settings::record_show_clicks(app),
        monitor_id: t.monitor_id,
        region: encode::RelRect {
            x: (x - mx) / mw,
            y: (y - my) / mh,
            width: w / mw,
            height: h / mh,
        },
        local: (x - mx, y - my, w, h),
        monitor_size: (mw, mh),
        scale: t.units_to_px,
        out_width,
        out_height,
    })
}

/// A still of the recorded area, cut from the screenshot the overlay was showing.
fn thumbnail(app: &AppHandle, t: &Target) -> Option<RgbaImage> {
    let session = app.state::<AppState>().capture.lock().ok()?.clone()?;
    let (mx, my, _, _) = t.monitor;
    let shot = session
        .monitors
        .iter()
        .find(|m| m.x as f64 == mx && m.y as f64 == my)?;
    let k = shot.image.width() as f64 / shot.width as f64;
    let (x, y, w, h) = t.rect;
    let crop = image::imageops::crop_imm(
        &shot.image,
        ((x - mx) * k) as u32,
        ((y - my) * k) as u32,
        (w * k).max(1.0) as u32,
        (h * k).max(1.0) as u32,
    )
    .to_image();
    Some(image::imageops::thumbnail(
        &crop,
        640,
        (640.0 * h / w).round().max(1.0) as u32,
    ))
}

fn spawn_backend(job: Job) -> Result<Handle, String> {
    #[cfg(target_os = "macos")]
    if std::env::var_os("SHOTVERA_PORTABLE_RECORDER").is_none() {
        return macos::spawn(job);
    }
    portable::spawn(job)
}

fn start(app: &AppHandle, request: RecordRequest) -> Result<(), String> {
    let state = app.state::<AppState>();
    if is_active(app) || state.recorder.processing.load(Ordering::SeqCst) {
        return Err("a recording is already in progress".into());
    }
    let target = Target::resolve(&request)?;
    let job = make_job(app, &request, &target)?;
    let thumbnail = thumbnail(app, &target);
    log::info!(
        "recording {:?} {}x{} at {} fps to {}",
        job.format,
        job.out_width,
        job.out_height,
        job.fps,
        job.output.display()
    );

    // The overlays must be gone before the first frame is captured.
    capture::dismiss_overlays_async(app)?;
    std::thread::sleep(Duration::from_millis(250));

    let output = job.output.clone();
    let handle = spawn_backend(job)?;
    if let Ok(mut active) = state.recorder.active.lock() {
        *active = Some(Active {
            handle,
            format: request.format,
            output,
            thumbnail,
            started: Instant::now(),
            paused_since: None,
            paused_total: Duration::ZERO,
        });
    }
    show_ui(app, target);
    emit_status(app);
    Ok(())
}

#[tauri::command]
pub async fn start_recording(app: AppHandle, request: RecordRequest) -> Result<(), String> {
    let result = start(&app, request);
    if let Err(err) = &result {
        log::error!("recording did not start: {err}");
        capture::dismiss_overlays_async(&app)?;
        output::notify(&app, i18n::tr(&app, Text::RecordingFailed), err);
    }
    result
}

// ------------------------------------------------------------------------------------- stop

pub fn stop(app: &AppHandle) {
    end(app, Msg::Stop);
}

fn end(app: &AppHandle, msg: Msg) {
    let recorder = &app.state::<AppState>().recorder;
    let Some(active) = recorder.active.lock().ok().and_then(|mut a| a.take()) else {
        return;
    };
    recorder.processing.store(true, Ordering::SeqCst);
    let _ = active.handle.tx.send(msg);
    hide_ui(app);
    emit_status(app);

    let app = app.clone();
    std::thread::spawn(move || {
        let Active {
            handle,
            output: planned,
            thumbnail,
            ..
        } = active;
        let result = handle
            .done
            .join()
            .unwrap_or_else(|_| Err("the recorder stopped unexpectedly".into()));
        match result {
            Ok(Outcome::Saved {
                path,
                duration,
                mic_unavailable,
            }) => {
                log::info!(
                    "recording saved: {} ({:.1}s)",
                    path.display(),
                    duration.as_secs_f64()
                );
                output::remember_recording(&app, thumbnail, &path, duration);
                let name = path
                    .file_name()
                    .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
                let body = if mic_unavailable {
                    format!("{name}\n{}", i18n::tr(&app, Text::MicUnavailable))
                } else {
                    name
                };
                output::notify(&app, i18n::tr(&app, Text::RecordingSaved), &body);
                let _ = app.emit("recording://saved", path.to_string_lossy().into_owned());
            }
            Ok(Outcome::Cancelled) => {
                let _ = fs::remove_file(&planned);
            }
            Err(err) => {
                log::error!("recording failed: {err}");
                let _ = fs::remove_file(&planned);
                output::notify(&app, i18n::tr(&app, Text::RecordingFailed), &err);
            }
        }
        app.state::<AppState>()
            .recorder
            .processing
            .store(false, Ordering::SeqCst);
        emit_status(&app);
    });
}

fn set_paused(app: &AppHandle, paused: bool) {
    let state = app.state::<AppState>();
    let tx = {
        let Ok(mut guard) = state.recorder.active.lock() else {
            return;
        };
        let Some(active) = guard.as_mut() else { return };
        match (paused, active.paused_since) {
            (true, None) => active.paused_since = Some(Instant::now()),
            (false, Some(since)) => {
                active.paused_total += since.elapsed();
                active.paused_since = None;
            }
            _ => return,
        }
        active.handle.tx.clone()
    };
    let _ = tx.send(if paused { Msg::Pause } else { Msg::Resume });
    emit_status(app);
}

#[tauri::command]
pub fn stop_recording(app: AppHandle) {
    stop(&app);
}

#[tauri::command]
pub fn cancel_recording(app: AppHandle) {
    end(&app, Msg::Cancel);
}

#[tauri::command]
pub fn pause_recording(app: AppHandle) {
    set_paused(&app, true);
}

#[tauri::command]
pub fn resume_recording(app: AppHandle) {
    set_paused(&app, false);
}

#[tauri::command]
pub fn recording_status(app: AppHandle) -> Status {
    status(&app)
}

// ------------------------------------------------------------------------------------- windows

fn show_ui(app: &AppHandle, target: Target) {
    let ui_app = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(err) = build_ui(&ui_app, &target) {
            log::warn!("could not show the recording controls: {err}");
        }
        crate::set_tray_recording(&ui_app, true);
        // Give the keyboard back to the app being recorded. Our windows stay on top.
        #[cfg(target_os = "macos")]
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            objc2_app_kit::NSApplication::sharedApplication(mtm).deactivate();
        }
    });
}

fn hide_ui(app: &AppHandle) {
    let ui_app = app.clone();
    let _ = app.run_on_main_thread(move || {
        for label in [CONTROLS, FRAME] {
            if let Some(window) = ui_app.get_webview_window(label) {
                let _ = window.destroy();
            }
        }
        crate::set_tray_recording(&ui_app, false);
    });
}

fn build_ui(app: &AppHandle, t: &Target) -> tauri::Result<()> {
    let (x, y, w, h) = t.rect;
    let (mx, my, mw, mh) = t.monitor;
    // Global units per CSS pixel: points on macOS, physical pixels elsewhere.
    let u = if cfg!(target_os = "macos") {
        1.0
    } else {
        t.dpi
    };
    let (bw, bh) = (CONTROLS_SIZE.0 * u, CONTROLS_SIZE.1 * u);
    let gap = 10.0 * u;
    // Put the controls outside the recorded area when there is room, so they are not recorded.
    let by = if y + h + gap + bh <= my + mh {
        y + h + gap
    } else if y - gap - bh >= my {
        y - gap - bh
    } else {
        y + h - bh - gap
    };
    let bx = (x + w / 2.0 - bw / 2.0).clamp(mx + gap, (mx + mw - bw - gap).max(mx + gap));
    let pad = FRAME_PAD * u;

    let frame = floating_window(
        app,
        FRAME,
        "index.html#recframe",
        (x - pad, y - pad),
        (w + 2.0 * pad, h + 2.0 * pad),
    )?;
    frame.set_ignore_cursor_events(true)?;
    floating_window(app, CONTROLS, "index.html#recorder", (bx, by), (bw, bh))?;
    Ok(())
}

/// A borderless, transparent window that floats above everything, placed in global units.
fn floating_window(
    app: &AppHandle,
    label: &str,
    url: &str,
    pos: (f64, f64),
    size: (f64, f64),
) -> tauri::Result<WebviewWindow> {
    if let Some(old) = app.get_webview_window(label) {
        let _ = old.destroy();
    }
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("Shotvera")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .visible_on_all_workspaces(true)
        .accept_first_mouse(true)
        .build()?;
    // Set the size before the position: on macOS a resize keeps the bottom edge in place.
    #[cfg(target_os = "macos")]
    {
        window.set_size(tauri::LogicalSize::new(size.0, size.1))?;
        window.set_position(tauri::LogicalPosition::new(pos.0, pos.1))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.set_size(tauri::PhysicalSize::new(
            size.0.round() as u32,
            size.1.round() as u32,
        ))?;
        window.set_position(tauri::PhysicalPosition::new(
            pos.0.round() as i32,
            pos.1.round() as i32,
        ))?;
    }
    platform::configure_overlay(&window);
    window.show()?;
    Ok(window)
}
