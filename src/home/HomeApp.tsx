import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Camera, Copy, FolderOpen, ImagePlay, Play, Power, ScanText, Settings, Sparkles, Trash, Video } from "lucide-react";
import {
  appVersion,
  copyHistoryItem,
  deleteHistory,
  fitWindowHeight,
  hideCurrentWindow,
  historyImageUrl,
  isTauri,
  listHistory,
  loadSettings,
  openRecording,
  openSaveFolder,
  openSettings,
  pinHistoryItem,
  quitApp,
  revealRecording,
  startCapture,
  type CaptureMode,
  type HistoryItem,
} from "../lib/platform";
import { getLocale, useI18n, useT } from "../i18n";
import { formatDuration } from "../lib/duration";
import { prettyShortcut } from "../settings/SettingsApp";
import "./home.css";

const IS_MAC = navigator.platform.toLowerCase().includes("mac");
const RECENT_LIMIT = 9;

/** "now", "5 minutes ago", "yesterday", then a short date, in the UI language. */
function timeAgo(ms: number): string {
  const locale = getLocale();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return rtf.format(0, "second");
  if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), "hour");
  if (s < 172800) return rtf.format(-1, "day");
  return new Date(ms).toLocaleDateString(locale, { day: "numeric", month: "short" });
}

/** Shotvera's mark: viewfinder corners and an AI sparkle on the brand gradient. */
function LogoMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="sv-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#3d9bff" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#sv-grad)" />
      <path
        d="M7.5 12V9.5a2 2 0 0 1 2-2H12M20 7.5h2.5a2 2 0 0 1 2 2V12M24.5 20v2.5a2 2 0 0 1-2 2H20M12 24.5H9.5a2 2 0 0 1-2-2V20"
        fill="none"
        stroke="#fff"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path d="M16 10.5Q16 16 21.5 16Q16 16 16 21.5Q16 16 10.5 16Q16 16 16 10.5Z" fill="#fff" />
    </svg>
  );
}

/** The menu-bar popover: quick capture actions and recent screenshots. */
export function HomeApp() {
  const [items, setItems] = useState<(HistoryItem & { url: string })[]>([]);
  const [shortcut, setShortcut] = useState("");
  const [version, setVersion] = useState("");
  const [flash, setFlash] = useState<string | null>(null);
  const t = useT();
  const locale = useI18n((s) => s.locale);

  const refresh = useCallback(async () => {
    const list = await listHistory();
    setItems(await Promise.all(list.slice(0, RECENT_LIMIT).map(async (i) => ({ ...i, url: await historyImageUrl(i.path) }))));
  }, []);

  useEffect(() => {
    void refresh();
    void loadSettings().then((s) => setShortcut(prettyShortcut(s.captureShortcut)));
    void appVersion().then(setVersion);
    const onFocus = () => {
      void refresh();
      void loadSettings().then((s) => setShortcut(prettyShortcut(s.captureShortcut)));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void hideCurrentWindow();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("keydown", onKey);
    };
  }, [refresh]);

  // Size the popover to its content so it never shows an empty block under a short history.
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (el) void fitWindowHeight(Math.ceil(el.getBoundingClientRect().height));
  }, [items, shortcut, version, locale]);

  const notify = (text: string) => {
    setFlash(text);
    window.setTimeout(() => setFlash(null), 1300);
  };
  const capture = (mode: CaptureMode) => void startCapture(mode);

  return (
    <div ref={root} className={`home${IS_MAC && isTauri ? " glass" : ""}`}>
      <header className="home-head" data-tauri-drag-region>
        <div className="brand">
          <span className="brand-logo">
            <LogoMark />
          </span>
          <div>
            <b>Shotvera</b>
            <small>{version ? t("home.version", { version }) : " "}</small>
          </div>
        </div>
        <div className="head-actions">
          <button className="ghost" title={t("home.settings")} onClick={() => void openSettings()}>
            <Settings size={16} />
          </button>
          <button className="ghost" title={t("home.quit")} onClick={() => void quitApp()}>
            <Power size={16} />
          </button>
        </div>
      </header>

      <button className="hero" onClick={() => capture("image")}>
        <span className="hero-icon">
          <Camera size={19} />
        </span>
        <span className="hero-text">
          <b>{t("home.capture")}</b>
          <small>{t("home.captureHint")}</small>
        </span>
        {shortcut && <kbd>{shortcut}</kbd>}
      </button>

      <div className="tiles">
        <button className="tile ai" onClick={() => capture("ai")}>
          <Sparkles size={18} />
          <b>{t("home.captureAi")}</b>
          <small>{t("home.captureAiHint")}</small>
        </button>
        <button className="tile" onClick={() => capture("ocr")}>
          <ScanText size={18} />
          <b>{t("home.extractText")}</b>
          <small>{t("home.extractTextHint")}</small>
        </button>
        <button className="tile rec" onClick={() => capture("record")}>
          <Video size={18} />
          <b>{t("home.recordVideo")}</b>
          <small>{t("home.recordVideoHint")}</small>
        </button>
        <button className="tile rec" onClick={() => capture("gif")}>
          <ImagePlay size={18} />
          <b>{t("home.recordGif")}</b>
          <small>{t("home.recordGifHint")}</small>
        </button>
      </div>

      <section className="recent">
        <div className="recent-head">
          <h4>{t("home.recent")}</h4>
          <button className="link" onClick={() => void openSaveFolder()}>
            <FolderOpen size={13} />
            {t("home.openFolder")}
          </button>
        </div>
        {items.length === 0 ? (
          <div className="empty">
            <Camera size={24} />
            <p>{t("home.empty")}</p>
            {shortcut && <small>{t("home.emptyHint", { shortcut })}</small>}
          </div>
        ) : (
          <div className="grid">
            {items.map((i) =>
              i.video ? (
                <div
                  key={i.path}
                  className="shot video"
                  title={t("home.playHint")}
                  onClick={() => void openRecording(i.path).catch((err) => notify(String(err)))}
                >
                  <img src={i.url} alt="" draggable={false} />
                  <span className="shot-play">
                    <Play size={9} fill="currentColor" />
                    {i.video.toLowerCase().endsWith(".gif") ? "GIF" : formatDuration(i.durationMs ?? 0)}
                  </span>
                  <span className="shot-time">{timeAgo(i.createdMs)}</span>
                  <div className="shot-actions">
                    <button
                      title={t("home.showInFolder")}
                      onClick={(e) => {
                        e.stopPropagation();
                        void revealRecording(i.path).catch((err) => notify(String(err)));
                      }}
                    >
                      <FolderOpen size={12} />
                    </button>
                    <button
                      title={t("home.removeFromRecent")}
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteHistory(i.path).then(refresh);
                      }}
                    >
                      <Trash size={12} />
                    </button>
                  </div>
                </div>
              ) : (
                <div key={i.path} className="shot" title={t("home.pinHint")} onClick={() => void pinHistoryItem(i.path)}>
                  <img src={i.url} alt="" draggable={false} />
                  <span className="shot-time">{timeAgo(i.createdMs)}</span>
                  <div className="shot-actions">
                    <button
                      title={t("common.copy")}
                      onClick={(e) => {
                        e.stopPropagation();
                        void copyHistoryItem(i.path).then(() => notify(t("common.copied")));
                      }}
                    >
                      <Copy size={12} />
                    </button>
                    <button
                      title={t("common.delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteHistory(i.path).then(refresh);
                      }}
                    >
                      <Trash size={12} />
                    </button>
                  </div>
                </div>
              ),
            )}
          </div>
        )}
      </section>
      {flash && <div className="home-flash">{flash}</div>}
    </div>
  );
}
