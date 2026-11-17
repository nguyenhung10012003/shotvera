/**
 * The only module that talks to the Rust backend. Every function has a browser fallback so the
 * UI can be developed with `npm run dev` in a normal browser.
 */
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Locale } from "../i18n";
import { DEFAULT_SETTINGS, type Settings } from "./settings";
import { renderMockDesktop } from "./mockScreen";
import type { MonitorLayout } from "../overlay/space";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Window routing: every webview loads index.html with a hash like `#overlay?monitor=1`. */
export function currentRoute(): { view: string; params: URLSearchParams } {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [view, query = ""] = raw.split("?");
  return { view: view || "home", params: new URLSearchParams(query) };
}

// ---------------------------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------------------------

/** What happens after a region is selected: plain capture, open the AI chat, or extract text. */
/** What the overlay does once an area is selected: annotate, ask AI, extract text, or record. */
export type CaptureMode = "image" | "ai" | "ocr" | "record" | "gif";

export interface CaptureMeta {
  sessionId: number;
  mode: CaptureMode;
  width: number;
  height: number;
}

/** A window on screen at capture time, in global units (see overlay/space.ts), front-most first. */
export interface CapturedWindow {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  app: string;
}

export interface LoadedFrame {
  sessionId: number;
  mode: CaptureMode;
  width: number;
  height: number;
  data: Uint8ClampedArray;
  bitmap: ImageBitmap;
}

// Browser mock: two side-by-side "monitors", one per tab (#overlay?monitor=0 / 1), synced with a
// BroadcastChannel standing in for Tauri events.
const MOCK_MONITORS = 2;
const mockChannel = !isTauri && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("shotvera-mock") : null;
const mockWindowsByMonitor = new Map<number, CapturedWindow[]>();

function mockLayout(): MonitorLayout[] {
  const scale = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  return Array.from({ length: MOCK_MONITORS }, (_, index) => ({
    index,
    x: index * w,
    y: 0,
    width: w,
    height: h,
    imageWidth: Math.round(w * scale),
    imageHeight: Math.round(h * scale),
    cssPerNative: 1,
  }));
}

/** Position and size of every monitor in this capture, in global units. */
export async function loadLayout(): Promise<MonitorLayout[]> {
  if (isTauri) return invoke<MonitorLayout[]>("capture_layout");
  return mockLayout();
}

export async function loadFrame(monitor: number): Promise<LoadedFrame> {
  if (isTauri) {
    const meta = await invoke<CaptureMeta>("capture_meta", { monitor });
    const buffer = await invoke<ArrayBuffer>("capture_frame", { monitor });
    const data = new Uint8ClampedArray(buffer);
    const bitmap = await createImageBitmap(new ImageData(data, meta.width, meta.height));
    return { sessionId: meta.sessionId, mode: meta.mode, width: meta.width, height: meta.height, data, bitmap };
  }
  const scale = window.devicePixelRatio || 1;
  const width = Math.round(window.innerWidth * scale);
  const height = Math.round(window.innerHeight * scale);
  const { canvas, windows } = renderMockDesktop(width, height, scale, monitor);
  const originX = monitor * window.innerWidth;
  mockWindowsByMonitor.set(
    monitor,
    windows.map((w) => ({ ...w, x: originX + w.x / scale, y: w.y / scale, w: w.w / scale, h: w.h / scale })),
  );
  const data = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
  const bitmap = await createImageBitmap(canvas);
  const mode = (new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("mode") ?? "image") as CaptureMode;
  return { sessionId: 1, mode, width, height, data, bitmap };
}

export async function onCaptureStart(cb: () => void): Promise<UnlistenFn> {
  if (!isTauri) return () => {};
  return listen("capture://start", () => cb());
}

export async function onWindowsListed(cb: (windows: CapturedWindow[]) => void): Promise<UnlistenFn> {
  if (!isTauri) {
    const id = window.setTimeout(() => cb([...mockWindowsByMonitor.values()].flat()), 50);
    return () => window.clearTimeout(id);
  }
  return listen<{ windows: CapturedWindow[] }>("capture://windows", (e) => cb(e.payload.windows));
}

/** Broadcasts the shared overlay document (selection, annotations…) to the other monitors. */
export async function emitDoc<T>(doc: T): Promise<void> {
  if (isTauri) await emit("overlay://doc", doc);
  else mockChannel?.postMessage({ type: "doc", doc });
}

export async function onDoc<T>(cb: (doc: T) => void): Promise<UnlistenFn> {
  if (isTauri) return listen<T>("overlay://doc", (e) => cb(e.payload));
  if (!mockChannel) return () => {};
  const handler = (e: MessageEvent) => {
    if (e.data?.type === "doc") cb(e.data.doc as T);
  };
  mockChannel.addEventListener("message", handler);
  return () => mockChannel.removeEventListener("message", handler);
}

/**
 * Follows the pointer in global units for the rest of a drag, even after it leaves this window
 * (webviews stop receiving mouse events once a drag crosses onto another monitor's window).
 * Calls `onUp` once when the button is released. Returns a function that stops following.
 */
export function followGlobalPointer(
  onMove: (x: number, y: number) => void,
  onUp: () => void,
): () => void {
  if (!isTauri) return () => {};
  let done = false;
  const pending = listen<{ x: number; y: number; down: boolean }>("overlay://pointer", (e) => {
    if (done) return;
    if (e.payload.down) {
      onMove(e.payload.x, e.payload.y);
    } else {
      done = true;
      onUp();
    }
  });
  void pending.then(() => invoke("track_pointer"));
  return () => {
    done = true;
    void pending.then((unlisten) => unlisten());
  };
}

export async function overlayReady(monitor: number): Promise<void> {
  if (isTauri) await invoke("overlay_ready", { monitor });
}

export async function closeOverlays(): Promise<void> {
  if (isTauri) {
    await invoke("close_overlays");
    return;
  }
  mockChannel?.postMessage({ type: "close" });
  window.dispatchEvent(new CustomEvent("shotvera:mock-close"));
}

mockChannel?.addEventListener("message", (e) => {
  if (e.data?.type === "close") window.dispatchEvent(new CustomEvent("shotvera:mock-close"));
});

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

function rawHeaders(img: ImageData, extra: Record<string, string> = {}) {
  return { headers: { "x-width": String(img.width), "x-height": String(img.height), ...extra } };
}

function rawBody(img: ImageData): Uint8Array {
  return new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
}

async function imageDataToBlob(img: ImageData): Promise<Blob> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  canvas.getContext("2d")!.putImageData(img, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

export async function copyImage(img: ImageData): Promise<void> {
  if (isTauri) {
    await invoke("copy_image", rawBody(img), rawHeaders(img));
    return;
  }
  const blob = await imageDataToBlob(img);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

/** Saves into the configured folder without asking. Returns the written path. */
export async function quickSave(img: ImageData): Promise<string> {
  if (isTauri) return invoke<string>("quick_save", rawBody(img), rawHeaders(img));
  const blob = await imageDataToBlob(img);
  const name = `Shotvera ${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  return name;
}

/** Closes the overlay and shows the native save dialog. Resolves with the path, or null if cancelled. */
export async function saveAs(img: ImageData): Promise<string | null> {
  if (isTauri) return invoke<string | null>("save_as", rawBody(img), rawHeaders(img));
  return quickSave(img);
}

/**
 * Pins the image as an always-on-top window. `globalRect` is where the selection was, in global
 * units; `cssSize` is the window size in CSS pixels.
 */
export async function pinImage(
  img: ImageData,
  globalRect: { x: number; y: number },
  cssSize: { w: number; h: number },
): Promise<void> {
  if (!isTauri) {
    const blob = await imageDataToBlob(img);
    window.open(URL.createObjectURL(blob), "_blank");
    return;
  }
  await invoke(
    "pin_image",
    rawBody(img),
    rawHeaders(img, {
      "x-x": String(globalRect.x),
      "x-y": String(globalRect.y),
      "x-css-w": String(cssSize.w),
      "x-css-h": String(cssSize.h),
    }),
  );
}

export interface PinMeta {
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
}

export async function loadPin(id: string): Promise<{ meta: PinMeta; bitmap: ImageBitmap; image: ImageData }> {
  const meta = await invoke<PinMeta>("pin_meta", { id });
  const buffer = await invoke<ArrayBuffer>("pin_frame", { id });
  const image = new ImageData(new Uint8ClampedArray(buffer), meta.width, meta.height);
  return { meta, image, bitmap: await createImageBitmap(image) };
}

// ---------------------------------------------------------------------------------------------
// App-level commands
// ---------------------------------------------------------------------------------------------

export async function startCapture(mode: CaptureMode = "image"): Promise<void> {
  if (isTauri) await invoke("start_capture", { mode });
  else window.location.hash = `#overlay?monitor=0&mode=${mode}`;
}

export async function openSettings(): Promise<void> {
  if (isTauri) await invoke("open_settings");
  else window.location.hash = "#settings";
}

export async function openSaveFolder(): Promise<void> {
  if (isTauri) await invoke("open_save_folder");
}

export async function quitApp(): Promise<void> {
  if (isTauri) await invoke("quit_app");
}

/** Resolved quick-save folder (the configured one, or the platform default). */
export async function resolvedSaveDir(): Promise<string> {
  if (!isTauri) return "~/Pictures/Shotvera";
  return invoke<string>("resolved_save_dir");
}

export interface HistoryItem {
  /** The thumbnail image in the history folder. */
  path: string;
  createdMs: number;
  /** Set for screen recordings: the video file the thumbnail stands for. */
  video?: string;
  durationMs?: number;
}

export async function listHistory(): Promise<HistoryItem[]> {
  if (!isTauri) return [];
  return invoke<HistoryItem[]>("list_history");
}

export async function deleteHistory(path: string): Promise<void> {
  if (isTauri) await invoke("delete_history", { path });
}

export async function historyImageUrl(path: string): Promise<string> {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(path);
}

export async function copyHistoryItem(path: string): Promise<void> {
  if (isTauri) await invoke("copy_history_item", { path });
}

/** Opens a history screenshot as a floating, always-on-top preview. */
export async function pinHistoryItem(path: string): Promise<void> {
  if (isTauri) await invoke("pin_history_item", { path });
}

/** Opens a recording from the history in the default video player. */
export async function openRecording(path: string): Promise<void> {
  if (isTauri) await invoke("open_recording", { path });
}

/** Shows a recording from the history in Finder / Explorer. */
export async function revealRecording(path: string): Promise<void> {
  if (isTauri) await invoke("reveal_recording", { path });
}

// ---------------------------------------------------------------------------------------------
// Screen recording
// ---------------------------------------------------------------------------------------------

export type RecordFormat = "mp4" | "gif";

export interface RecordRequest {
  /** The area in global units (points on macOS, physical pixels elsewhere). */
  x: number;
  y: number;
  width: number;
  height: number;
  format: RecordFormat;
  microphone: boolean;
}

export interface RecordingStatus {
  state: "idle" | "recording" | "paused" | "processing";
  elapsedMs: number;
  format: RecordFormat | null;
}

/** Hides the overlays and starts recording the area. Rejects if the recorder cannot start. */
export async function startRecording(request: RecordRequest): Promise<void> {
  if (isTauri) await invoke("start_recording", { request });
  else console.info("recording (mock)", request);
}

export async function stopRecording(): Promise<void> {
  if (isTauri) await invoke("stop_recording");
}

/** Stops and discards the recording. */
export async function cancelRecording(): Promise<void> {
  if (isTauri) await invoke("cancel_recording");
}

export async function pauseRecording(): Promise<void> {
  if (isTauri) await invoke("pause_recording");
}

export async function resumeRecording(): Promise<void> {
  if (isTauri) await invoke("resume_recording");
}

export async function recordingStatus(): Promise<RecordingStatus> {
  if (!isTauri) return { state: "recording", elapsedMs: 0, format: "mp4" };
  return invoke<RecordingStatus>("recording_status");
}

export async function onRecordingState(cb: (status: RecordingStatus) => void): Promise<UnlistenFn> {
  if (!isTauri) return () => {};
  return listen<RecordingStatus>("recording://state", (e) => cb(e.payload));
}

/** Microphone recording is only implemented by the native macOS recorder. */
export const canRecordAudio = navigator.platform.toLowerCase().includes("mac");

export async function hideCurrentWindow(): Promise<void> {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().hide();
}

/**
 * Resizes the current window to `height` CSS pixels, keeping its top edge where it is
 * (macOS keeps the bottom edge fixed when a window is resized).
 */
export async function fitWindowHeight(height: number): Promise<void> {
  if (!isTauri) return;
  const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  const scale = await win.scaleFactor();
  const size = await win.innerSize();
  if (Math.abs(size.height / scale - height) < 2) return;
  const position = await win.outerPosition();
  await win.setSize(new LogicalSize(size.width / scale, height));
  await win.setPosition(position);
}

export async function appVersion(): Promise<string> {
  if (!isTauri) return "dev";
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

// ---------------------------------------------------------------------------------------------
// Settings & secrets
// ---------------------------------------------------------------------------------------------

const MOCK_SETTINGS_KEY = "shotvera.settings";
const MOCK_KEY = "shotvera.apiKey";

async function store() {
  const { load } = await import("@tauri-apps/plugin-store");
  return load("settings.json", { autoSave: 200, defaults: {} });
}

export async function loadSettings(): Promise<Settings> {
  if (!isTauri) {
    const raw = localStorage.getItem(MOCK_SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? (JSON.parse(raw) as Partial<Settings>) : {}) };
  }
  const s = await store();
  const entries = await s.entries<unknown>();
  const saved = Object.fromEntries(entries) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  if (!isTauri) {
    const current = await loadSettings();
    localStorage.setItem(MOCK_SETTINGS_KEY, JSON.stringify({ ...current, ...patch }));
    return;
  }
  const s = await store();
  for (const [k, v] of Object.entries(patch)) await s.set(k, v);
  await s.save();
}

/**
 * Switches the UI language: Rust rebuilds the tray menu and tells every window (overlays, popover,
 * pins, settings) to re-render. In the browser mock, other tabs pick it up from the storage event.
 */
export async function applyLanguage(language: Locale): Promise<void> {
  if (isTauri) await invoke("set_language", { language });
}

/** Calls `cb` when the UI language is changed from any window. */
export async function onLanguageChange(cb: (language: string) => void): Promise<UnlistenFn> {
  if (isTauri) return listen<string>("app://language", (e) => cb(e.payload));
  const onStorage = (e: StorageEvent) => {
    if (e.key !== MOCK_SETTINGS_KEY || !e.newValue) return;
    const language = (JSON.parse(e.newValue) as Partial<Settings>).language;
    if (language) cb(language);
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/** Registers the global record shortcut (starts and stops recordings). */
export async function applyRecordShortcut(shortcut: string): Promise<void> {
  if (isTauri) await invoke("set_record_shortcut", { shortcut });
}

/** Registers the global capture shortcut; rejects with a readable message if it is invalid or taken. */
export async function applyCaptureShortcut(shortcut: string): Promise<void> {
  if (isTauri) await invoke("set_capture_shortcut", { shortcut });
}

export async function getApiKey(): Promise<string | null> {
  if (!isTauri) return localStorage.getItem(MOCK_KEY);
  return invoke<string | null>("get_api_key");
}

export async function setApiKey(key: string | null): Promise<void> {
  if (!isTauri) {
    if (key) localStorage.setItem(MOCK_KEY, key);
    else localStorage.removeItem(MOCK_KEY);
    return;
  }
  await invoke("set_api_key", { key });
}
