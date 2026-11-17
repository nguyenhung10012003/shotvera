//! Update checks and installs (tauri-plugin-updater).
//!
//! CI signs every release and publishes `latest.json` next to the installers. The app installs an
//! update only when its signature matches the public key in `tauri.conf.json`. Unless turned off
//! in Settings, checks run in the background: shortly after launch, then every few hours.

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

use crate::i18n::{self, Text};
use crate::{output, recording, settings, AppState};

const FIRST_CHECK: Duration = Duration::from_secs(10);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// How long an automatic install waits while the user is capturing or recording.
const BUSY_RETRY: Duration = Duration::from_secs(5 * 60);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// "idle", "checking", "upToDate", "available", "downloading", "installing" or "error".
    state: &'static str,
    current_version: String,
    /// The version the update offers, when there is one.
    version: Option<String>,
    notes: Option<String>,
    /// 0..1 while downloading, when the download size is known.
    progress: Option<f64>,
    error: Option<String>,
}

impl Default for Status {
    fn default() -> Self {
        Status {
            state: "idle",
            current_version: String::new(),
            version: None,
            notes: None,
            progress: None,
            error: None,
        }
    }
}

/// Update state kept in [`AppState`].
#[derive(Default)]
pub struct Updates {
    status: Mutex<Status>,
    pending: Mutex<Option<Update>>,
    /// The last version announced with a notification, so that each version is announced once.
    announced: Mutex<Option<String>>,
}

fn set_status(app: &AppHandle, change: impl FnOnce(&mut Status)) {
    let state = app.state::<AppState>();
    let snapshot = {
        let Ok(mut status) = state.updates.status.lock() else {
            return;
        };
        change(&mut status);
        status.current_version = app.package_info().version.to_string();
        status.clone()
    };
    let _ = app.emit("update://state", snapshot);
}

pub fn status(app: &AppHandle) -> Status {
    let mut status = app
        .state::<AppState>()
        .updates
        .status
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default();
    status.current_version = app.package_info().version.to_string();
    status
}

/// The version of the update waiting to be installed, if any.
pub fn pending_version(app: &AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    let pending = state.updates.pending.lock().ok()?;
    pending.as_ref().map(|u| u.version.clone())
}

fn updater(app: &AppHandle) -> Result<Updater, String> {
    let mut builder = app.updater_builder();
    // For testing against a local `latest.json`. Signatures are still verified.
    if let Ok(url) = std::env::var("SHOTVERA_UPDATE_ENDPOINT") {
        let url = url
            .parse()
            .map_err(|e| format!("invalid SHOTVERA_UPDATE_ENDPOINT: {e}"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    builder.build().map_err(|e| e.to_string())
}

/// Looks for an update and records the result. Returns the new version, if there is one.
///
/// A failed automatic check stays quiet, since the user may just be offline. A manual check
/// reports the error.
pub async fn check(app: &AppHandle, manual: bool) -> Result<Option<String>, String> {
    if matches!(status(app).state, "downloading" | "installing") {
        return Ok(pending_version(app));
    }
    set_status(app, |s| {
        s.state = "checking";
        s.error = None;
    });
    let result = match updater(app) {
        Ok(updater) => updater.check().await.map_err(|e| e.to_string()),
        Err(err) => Err(err),
    };
    let updates = &app.state::<AppState>().updates;
    match result {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let notes = update.body.clone();
            log::info!("update available: {version}");
            if let Ok(mut pending) = updates.pending.lock() {
                *pending = Some(update);
            }
            set_status(app, |s| {
                s.state = "available";
                s.version = Some(version.clone());
                s.notes = notes;
                s.progress = None;
            });
            crate::set_tray_update(app, Some(&version));
            Ok(Some(version))
        }
        Ok(None) => {
            if let Ok(mut pending) = updates.pending.lock() {
                *pending = None;
            }
            set_status(app, |s| {
                s.state = "upToDate";
                s.version = None;
                s.notes = None;
            });
            crate::set_tray_update(app, None);
            Ok(None)
        }
        Err(err) => {
            log::warn!("update check failed: {err}");
            let had_update = pending_version(app);
            set_status(app, |s| {
                if manual {
                    s.state = "error";
                    s.error = Some(err.clone());
                } else {
                    s.state = if had_update.is_some() {
                        "available"
                    } else {
                        "idle"
                    };
                }
            });
            Err(err)
        }
    }
}

/// Downloads and installs the pending update (checking first if needed), then restarts the app.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    if pending_version(app).is_none() {
        check(app, true).await?;
    }
    let update = app
        .state::<AppState>()
        .updates
        .pending
        .lock()
        .ok()
        .and_then(|p| p.clone())
        .ok_or("Shotvera is already up to date")?;
    log::info!("installing update {}", update.version);
    set_status(app, |s| {
        s.state = "downloading";
        s.progress = Some(0.0);
        s.error = None;
    });

    let progress_app = app.clone();
    let installing_app = app.clone();
    let mut downloaded: u64 = 0;
    let mut last_percent = 0;
    let result = update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let percent = (downloaded * 100 / total).min(100);
                    if percent != last_percent {
                        last_percent = percent;
                        set_status(&progress_app, |s| s.progress = Some(percent as f64 / 100.0));
                    }
                }
            },
            move || set_status(&installing_app, |s| s.state = "installing"),
        )
        .await;
    match result {
        // On Windows the installer has already taken over and the app is exiting.
        Ok(()) => app.restart(),
        Err(err) => {
            let err = err.to_string();
            log::error!("update failed: {err}");
            set_status(app, |s| {
                s.state = "error";
                s.error = Some(err.clone());
            });
            output::notify(app, i18n::tr(app, Text::InstallFailed), &err);
            Err(err)
        }
    }
}

/// True while capturing or recording, when restarting would interrupt the user.
fn busy(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    state.capturing.load(std::sync::atomic::Ordering::SeqCst) || recording::is_active(app)
}

fn announce(app: &AppHandle, version: &str) {
    let updates = &app.state::<AppState>().updates;
    let Ok(mut announced) = updates.announced.lock() else {
        return;
    };
    if announced.as_deref() == Some(version) {
        return;
    }
    *announced = Some(version.to_string());
    drop(announced);
    output::notify(
        app,
        i18n::tr(app, Text::UpdateAvailable),
        &i18n::tr_fill(app, Text::UpdateAvailableBody, "version", version),
    );
}

/// Starts the periodic background check.
pub fn start_background(app: &AppHandle) {
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("shotvera-updates".into())
        .spawn(move || {
            thread::sleep(FIRST_CHECK);
            loop {
                if settings::update_auto_check(&app) {
                    if let Ok(Some(version)) = tauri::async_runtime::block_on(check(&app, false)) {
                        if settings::update_auto_install(&app) {
                            while busy(&app) {
                                thread::sleep(BUSY_RETRY);
                            }
                            let _ = tauri::async_runtime::block_on(install(&app));
                        } else {
                            announce(&app, &version);
                        }
                    }
                }
                thread::sleep(CHECK_EVERY);
            }
        });
    if let Err(err) = spawned {
        log::warn!("could not start update checks: {err}");
    }
}

/// From the tray menu: installs the known update, or checks now and reports the result.
pub fn check_or_install_from_tray(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if pending_version(&app).is_some() {
            let _ = install(&app).await;
            return;
        }
        match check(&app, true).await {
            Ok(Some(_)) => crate::windows::show_home(&app, None),
            Ok(None) => output::notify(
                &app,
                i18n::tr(&app, Text::UpToDate),
                &i18n::tr_fill(
                    &app,
                    Text::UpToDateBody,
                    "version",
                    app.package_info().version.to_string(),
                ),
            ),
            Err(err) => output::notify(&app, i18n::tr(&app, Text::CheckFailed), &err),
        }
    });
}

#[tauri::command]
pub fn update_status(app: AppHandle) -> Status {
    status(&app)
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<Option<String>, String> {
    check(&app, true).await
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    install(&app).await
}
