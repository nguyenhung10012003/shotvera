//! Platform specifics: screen-recording permission, global pointer state and overlay window level.

use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
    fn CGEventGetLocation(event: *mut std::ffi::c_void) -> CGPoint;
    fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const std::ffi::c_void);
}

/// Pointer position in global units (points on macOS, physical pixels on Windows) and whether the
/// primary button is held. Works regardless of which window, if any, is under the pointer.
/// `None` where unsupported (Linux), in which case drags stay within one monitor.
pub fn global_pointer() -> Option<(f64, f64, bool)> {
    #[cfg(target_os = "macos")]
    // SAFETY: CGEventCreate(NULL) returns an owned event (released below) or NULL; the other calls
    // only read global input state.
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return None;
        }
        let p = CGEventGetLocation(event);
        CFRelease(event as *const _);
        // kCGEventSourceStateCombinedSessionState = 0, kCGMouseButtonLeft = 0
        let down = CGEventSourceButtonState(0, 0);
        Some((p.x, p.y, down))
    }
    #[cfg(target_os = "windows")]
    // SAFETY: GetCursorPos writes into the provided POINT; GetAsyncKeyState only reads input state.
    unsafe {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut p = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut p) == 0 {
            return None;
        }
        let down = (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0;
        Some((p.x as f64, p.y as f64, down))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    None
}

/// Whether the app may capture other apps' windows (macOS Screen Recording permission).
pub fn has_screen_permission() -> bool {
    #[cfg(target_os = "macos")]
    // SAFETY: plain CoreGraphics call without arguments.
    unsafe {
        CGPreflightScreenCaptureAccess()
    }
    #[cfg(not(target_os = "macos"))]
    true
}

/// Shows the system permission prompt (macOS only; a no-op elsewhere).
pub fn request_screen_permission() {
    #[cfg(target_os = "macos")]
    // SAFETY: plain CoreGraphics call without arguments.
    unsafe {
        CGRequestScreenCaptureAccess();
    }
}

/// Puts an overlay above the menu bar, the Dock and full-screen apps, on every Space.
/// Must run on the main thread.
pub fn configure_overlay(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
        let Ok(ptr) = window.ns_window() else { return };
        // SAFETY: Tauri returns a valid NSWindow pointer for a live window; we only call setters on it.
        let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        // kCGScreenSaverWindowLevel: above the menu bar and the Dock.
        ns_window.setLevel(1000);
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        ns_window.setHasShadow(false);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}
