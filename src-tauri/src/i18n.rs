//! Text shown by the Rust side (tray menu, notifications, dialogs, errors), in the UI language
//! chosen in Settings. The webview has its own catalogs in `src/i18n/`.

use tauri::AppHandle;

use crate::settings;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    En,
    Vi,
}

impl Lang {
    /// Parses a settings value. Unknown values fall back to English.
    pub fn parse(code: &str) -> Lang {
        match code {
            "vi" => Lang::Vi,
            _ => Lang::En,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::Vi => "vi",
        }
    }
}

/// The language currently selected in Settings.
pub fn current(app: &AppHandle) -> Lang {
    Lang::parse(&settings::language(app))
}

#[derive(Clone, Copy, Debug)]
pub enum Text {
    MenuCapture,
    MenuCaptureAi,
    MenuCaptureOcr,
    MenuRecord,
    MenuRecordGif,
    MenuStopRecording,
    MenuRecent,
    MenuOpenFolder,
    MenuSettings,
    MenuQuit,
    SettingsTitle,
    ImageSaved,
    SaveDialogTitle,
    CaptureFailed,
    NeedScreenPermission,
    NoDisplay,
    RecordingSaved,
    RecordingFailed,
    MicUnavailable,
    TrayRecording,
    /// Contains an `{error}` placeholder.
    ShortcutInvalid,
    /// Contains an `{error}` placeholder.
    ShortcutTaken,
    ShortcutDuplicate,
}

impl Text {
    pub fn get(self, lang: Lang) -> &'static str {
        // Menu labels avoid "&": some platforms treat it as a mnemonic marker and hide it.
        let (en, vi) = match self {
            Text::MenuCapture => ("Capture Screen", "Chụp màn hình"),
            Text::MenuCaptureAi => ("Capture and Ask AI", "Chụp và hỏi AI"),
            Text::MenuCaptureOcr => ("Capture and Extract Text", "Chụp và trích xuất văn bản"),
            Text::MenuRecord => ("Record Screen", "Quay màn hình"),
            Text::MenuRecordGif => ("Record GIF", "Quay GIF"),
            Text::MenuStopRecording => ("Stop Recording", "Dừng quay"),
            Text::MenuRecent => ("Recent Captures…", "Ảnh gần đây…"),
            Text::MenuOpenFolder => ("Open Captures Folder", "Mở thư mục ảnh"),
            Text::MenuSettings => ("Settings…", "Cài đặt…"),
            Text::MenuQuit => ("Quit Shotvera", "Thoát Shotvera"),
            Text::SettingsTitle => ("Shotvera Settings", "Cài đặt Shotvera"),
            Text::ImageSaved => ("Screenshot saved", "Đã lưu ảnh chụp"),
            Text::SaveDialogTitle => ("Save Screenshot", "Lưu ảnh chụp màn hình"),
            Text::CaptureFailed => ("Couldn't capture the screen", "Không chụp được màn hình"),
            Text::NeedScreenPermission => (
                "Allow Screen Recording for Shotvera in System Settings, then reopen the app.",
                "Hãy cho phép Shotvera ghi màn hình (Screen Recording) trong Cài đặt hệ thống, rồi mở lại ứng dụng.",
            ),
            Text::NoDisplay => ("No display found.", "Không tìm thấy màn hình nào."),
            Text::RecordingSaved => ("Recording saved", "Đã lưu bản quay"),
            Text::RecordingFailed => ("Couldn't record the screen", "Không quay được màn hình"),
            Text::MicUnavailable => (
                "Recorded without sound: Shotvera couldn't use the microphone.",
                "Đã quay không có tiếng: Shotvera không dùng được micro.",
            ),
            Text::TrayRecording => ("Recording. Click to stop.", "Đang quay. Bấm để dừng."),
            Text::ShortcutInvalid => ("Invalid shortcut: {error}", "Phím tắt không hợp lệ: {error}"),
            Text::ShortcutDuplicate => (
                "Shotvera already uses this shortcut for another action",
                "Shotvera đã dùng phím tắt này cho thao tác khác",
            ),
            Text::ShortcutTaken => (
                "Another app is already using this shortcut ({error})",
                "Một ứng dụng khác đang dùng phím tắt này ({error})",
            ),
        };
        match lang {
            Lang::En => en,
            Lang::Vi => vi,
        }
    }
}

/// `text` in the current UI language.
pub fn tr(app: &AppHandle, text: Text) -> &'static str {
    text.get(current(app))
}

/// `text` in the current UI language, with its `{error}` placeholder filled in.
pub fn tr_error(app: &AppHandle, text: Text, error: impl std::fmt::Display) -> String {
    tr(app, text).replace("{error}", &error.to_string())
}
