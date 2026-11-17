//! Everything that leaves the editor: clipboard, files, pinned windows and the local history.

use std::fs::{self, File};
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::RgbaImage;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use crate::{capture, settings, AppState};

pub const PIN_PREFIX: &str = "pin-";
const HISTORY_LIMIT: usize = 60;
static PIN_COUNTER: AtomicU64 = AtomicU64::new(1);

pub struct PinImage {
    image: RgbaImage,
    css_width: f64,
    css_height: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinMeta {
    width: u32,
    height: u32,
    css_width: f64,
    css_height: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    path: String,
    created_ms: u64,
}

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

fn header<T: std::str::FromStr>(request: &Request<'_>, name: &str) -> Result<T, String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| format!("missing or invalid header {name}"))
}

/// Reads an RGBA image sent from the webview as a raw IPC body with x-width / x-height headers.
fn read_image(request: &Request<'_>) -> Result<RgbaImage, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw image bytes".into());
    };
    let width: u32 = header(request, "x-width")?;
    let height: u32 = header(request, "x-height")?;
    if bytes.len() != width as usize * height as usize * 4 {
        return Err(format!(
            "image is {} bytes, expected {}x{}x4",
            bytes.len(),
            width,
            height
        ));
    }
    RgbaImage::from_raw(width, height, bytes.clone()).ok_or_else(|| "invalid image buffer".into())
}

fn copy_to_clipboard(app: &AppHandle, image: &RgbaImage) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut guard = state.clipboard.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
    }
    let clipboard = guard.as_mut().ok_or("clipboard unavailable")?;
    clipboard
        .set_image(arboard::ImageData {
            width: image.width() as usize,
            height: image.height() as usize,
            bytes: std::borrow::Cow::Borrowed(image.as_raw()),
        })
        .map_err(|e| e.to_string())
}

fn encode(path: &Path, image: &RgbaImage) -> Result<(), String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    let file = BufWriter::new(File::create(path).map_err(|e| e.to_string())?);
    match ext.as_str() {
        "jpg" | "jpeg" => {
            let rgb = image::DynamicImage::ImageRgba8(image.clone()).to_rgb8();
            JpegEncoder::new_with_quality(file, 92)
                .encode_image(&rgb)
                .map_err(|e| e.to_string())
        }
        _ => image
            .write_with_encoder(PngEncoder::new_with_quality(
                file,
                CompressionType::Fast,
                FilterType::Adaptive,
            ))
            .map_err(|e| e.to_string()),
    }
}

fn timestamp_name(ext: &str) -> String {
    format!(
        "Shotvera {}.{ext}",
        chrono::Local::now().format("%Y-%m-%d at %H.%M.%S")
    )
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, "png"));
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}).{ext}")))
        .find(|p| !p.exists())
        .unwrap_or(candidate)
}

fn history_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("history");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Stores a copy in the history folder on a background thread and trims old entries.
fn remember(app: &AppHandle, image: RgbaImage) {
    let Ok(dir) = history_dir(app) else { return };
    std::thread::spawn(move || {
        let path = unique_path(&dir, &timestamp_name("png"));
        if let Err(err) = encode(&path, &image) {
            log::warn!("history save failed: {err}");
            return;
        }
        let mut items = list_dir(&dir);
        if items.len() > HISTORY_LIMIT {
            for old in items.drain(HISTORY_LIMIT..) {
                let _ = fs::remove_file(old.path);
            }
        }
    });
}

fn list_dir(dir: &Path) -> Vec<HistoryItem> {
    let mut items: Vec<HistoryItem> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "png"))
        .map(|e| HistoryItem {
            created_ms: e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64),
            path: e.path().to_string_lossy().into_owned(),
        })
        .collect();
    items.sort_by_key(|item| std::cmp::Reverse(item.created_ms));
    items
}

/// Resolves `path` and checks it lives inside the history folder (the webview must not reach elsewhere).
fn history_file(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let dir = history_dir(app)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let file = Path::new(path).canonicalize().map_err(|e| e.to_string())?;
    if file.starts_with(&dir) {
        Ok(file)
    } else {
        Err("path is outside the history folder".into())
    }
}

#[tauri::command]
pub async fn copy_image(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let image = read_image(&request)?;
    copy_to_clipboard(&app, &image)?;
    remember(&app, image);
    Ok(())
}

#[tauri::command]
pub async fn quick_save(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let image = read_image(&request)?;
    let dir = settings::save_dir(&app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = unique_path(&dir, &timestamp_name(&settings::save_format(&app)));
    encode(&path, &image)?;
    capture::hide_overlays_async(&app)?;
    notify(&app, "Đã lưu ảnh", &path.to_string_lossy());
    remember(&app, image);
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn save_as(app: AppHandle, request: Request<'_>) -> Result<Option<String>, String> {
    let image = read_image(&request)?;
    // The overlay sits above everything, so get it out of the way before the native dialog opens.
    capture::hide_overlays_async(&app)?;

    let dir = settings::save_dir(&app);
    let picked = app
        .dialog()
        .file()
        .set_title("Lưu ảnh chụp màn hình")
        .set_directory(&dir)
        .set_file_name(timestamp_name(&settings::save_format(&app)))
        .add_filter("PNG", &["png"])
        .add_filter("JPEG", &["jpg", "jpeg"])
        .blocking_save_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let mut path = picked.into_path().map_err(|e| e.to_string())?;
    if path.extension().is_none() {
        path.set_extension("png");
    }
    encode(&path, &image)?;
    remember(&app, image);
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Opens an always-on-top window showing `image` at `css_width`×`css_height` CSS pixels.
/// `position` is the window's top-left in global units; `None` centers it.
fn open_pin(
    app: &AppHandle,
    image: RgbaImage,
    css_width: f64,
    css_height: f64,
    position: Option<(f64, f64)>,
) -> Result<(), String> {
    let id = PIN_COUNTER.fetch_add(1, Ordering::SeqCst).to_string();
    app.state::<AppState>()
        .pins
        .lock()
        .map_err(|e| e.to_string())?
        .insert(
            id.clone(),
            PinImage {
                image,
                css_width,
                css_height,
            },
        );
    let window = WebviewWindowBuilder::new(
        app,
        format!("{PIN_PREFIX}{id}"),
        WebviewUrl::App(format!("index.html#pin?id={id}").into()),
    )
    .title("Shotvera Pin")
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(true)
    .inner_size(css_width, css_height)
    .focused(true)
    .build()
    .map_err(|e| e.to_string())?;
    match position {
        Some((x, y)) => {
            let position: tauri::Position = if cfg!(target_os = "macos") {
                tauri::LogicalPosition::new(x, y).into()
            } else {
                tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32).into()
            };
            let _ = window.set_position(position);
        }
        None => {
            let _ = window.center();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn pin_image(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let image = read_image(&request)?;
    // Top-left of the selection in global units (points on macOS, physical pixels elsewhere).
    let x: f64 = header(&request, "x-x")?;
    let y: f64 = header(&request, "x-y")?;
    let css_width: f64 = header(&request, "x-css-w")?;
    let css_height: f64 = header(&request, "x-css-h")?;
    open_pin(&app, image.clone(), css_width, css_height, Some((x, y)))?;
    remember(&app, image);
    Ok(())
}

/// Pins a screenshot from the history, centered, at the primary monitor's pixel density and at
/// most 80% of that monitor's size.
#[tauri::command]
pub async fn pin_history_item(app: AppHandle, path: String) -> Result<(), String> {
    let file = history_file(&app, &path)?;
    let image = image::open(file).map_err(|e| e.to_string())?.to_rgba8();
    let primary = xcap::Monitor::all()
        .ok()
        .and_then(|all| all.into_iter().find(|m| m.is_primary().unwrap_or(false)));
    let (scale, max_w, max_h) = primary
        .map(|m| {
            let scale = m.scale_factor().unwrap_or(1.0) as f64;
            let (w, h) = (
                m.width().unwrap_or(1440) as f64,
                m.height().unwrap_or(900) as f64,
            );
            // Monitor sizes are points on macOS and physical pixels elsewhere.
            let css = if cfg!(target_os = "macos") {
                1.0
            } else {
                1.0 / scale
            };
            (scale, w * css * 0.8, h * css * 0.8)
        })
        .unwrap_or((1.0, 1200.0, 800.0));
    let mut css_w = image.width() as f64 / scale;
    let mut css_h = image.height() as f64 / scale;
    let fit = (max_w / css_w).min(max_h / css_h).min(1.0);
    css_w *= fit;
    css_h *= fit;
    open_pin(&app, image, css_w.round(), css_h.round(), None)
}

pub fn forget_pin(app: &AppHandle, label: &str) {
    if let Some(id) = label.strip_prefix(PIN_PREFIX) {
        if let Ok(mut pins) = app.state::<AppState>().pins.lock() {
            pins.remove(id);
        }
    }
}

#[tauri::command]
pub fn pin_meta(state: State<'_, AppState>, id: String) -> Result<PinMeta, String> {
    let pins = state.pins.lock().map_err(|e| e.to_string())?;
    let pin = pins.get(&id).ok_or("unknown pin")?;
    Ok(PinMeta {
        width: pin.image.width(),
        height: pin.image.height(),
        css_width: pin.css_width,
        css_height: pin.css_height,
    })
}

#[tauri::command]
pub async fn pin_frame(state: State<'_, AppState>, id: String) -> Result<Response, String> {
    let pins = state.pins.lock().map_err(|e| e.to_string())?;
    let pin = pins.get(&id).ok_or("unknown pin")?;
    Ok(Response::new(pin.image.as_raw().clone()))
}

#[tauri::command]
pub fn list_history(app: AppHandle) -> Result<Vec<HistoryItem>, String> {
    Ok(list_dir(&history_dir(&app)?))
}

#[tauri::command]
pub fn delete_history(app: AppHandle, path: String) -> Result<(), String> {
    fs::remove_file(history_file(&app, &path)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn copy_history_item(app: AppHandle, path: String) -> Result<(), String> {
    let file = history_file(&app, &path)?;
    let image = image::open(file).map_err(|e| e.to_string())?.to_rgba8();
    copy_to_clipboard(&app, &image)
}

#[tauri::command]
pub fn open_save_folder(app: AppHandle) -> Result<(), String> {
    let dir = settings::save_dir(&app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resolved_save_dir(app: AppHandle) -> String {
    settings::save_dir(&app).to_string_lossy().into_owned()
}
