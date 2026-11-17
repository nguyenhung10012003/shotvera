//! Reads user settings written by the webview into the plugin-store file `settings.json`.

use std::path::PathBuf;

use serde::de::DeserializeOwned;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

pub const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+2";

fn get<T: DeserializeOwned>(app: &AppHandle, key: &str) -> Option<T> {
    let store = app.store("settings.json").ok()?;
    store.get(key).and_then(|v| serde_json::from_value(v).ok())
}

/// UI language code ("en" or "vi"); English unless the user picked another one.
pub fn language(app: &AppHandle) -> String {
    get::<String>(app, "language").unwrap_or_else(|| "en".to_string())
}

pub fn capture_shortcut(app: &AppHandle) -> String {
    get::<String>(app, "captureShortcut").unwrap_or_else(|| DEFAULT_SHORTCUT.to_string())
}

pub fn save_dir(app: &AppHandle) -> PathBuf {
    get::<Option<String>>(app, "saveDir")
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            app.path()
                .picture_dir()
                .or_else(|_| app.path().home_dir())
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("Shotvera")
        })
}

/// "png" or "jpg".
pub fn save_format(app: &AppHandle) -> String {
    match get::<String>(app, "saveFormat").as_deref() {
        Some("jpg") => "jpg".into(),
        _ => "png".into(),
    }
}
