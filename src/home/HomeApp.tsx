import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Camera, Copy, FolderOpen, Power, ScanText, Settings, Sparkles, Trash } from "lucide-react";
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
  openSaveFolder,
  openSettings,
  pinHistoryItem,
  quitApp,
  startCapture,
  type CaptureMode,
  type HistoryItem,
} from "../lib/platform";
import { prettyShortcut } from "../settings/SettingsApp";
import "./home.css";

const IS_MAC = navigator.platform.toLowerCase().includes("mac");
const RECENT_LIMIT = 9;

function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "vừa xong";
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  if (s < 172800) return "hôm qua";
  return new Date(ms).toLocaleDateString("vi-VN", { day: "numeric", month: "numeric" });
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
  }, [items, shortcut, version]);

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
            <small>{version ? `Phiên bản ${version}` : " "}</small>
          </div>
        </div>
        <div className="head-actions">
          <button className="ghost" title="Cài đặt" onClick={() => void openSettings()}>
            <Settings size={16} />
          </button>
          <button className="ghost" title="Thoát Shotvera" onClick={() => void quitApp()}>
            <Power size={16} />
          </button>
        </div>
      </header>

      <button className="hero" onClick={() => capture("image")}>
        <span className="hero-icon">
          <Camera size={19} />
        </span>
        <span className="hero-text">
          <b>Chụp màn hình</b>
          <small>Chọn vùng, chú thích, sao chép</small>
        </span>
        {shortcut && <kbd>{shortcut}</kbd>}
      </button>

      <div className="tiles">
        <button className="tile ai" onClick={() => capture("ai")}>
          <Sparkles size={18} />
          <b>Chụp &amp; hỏi AI</b>
          <small>Giải thích, chỉnh sửa ảnh bằng AI</small>
        </button>
        <button className="tile" onClick={() => capture("ocr")}>
          <ScanText size={18} />
          <b>Trích xuất chữ</b>
          <small>Lấy văn bản trong vùng chọn</small>
        </button>
      </div>

      <section className="recent">
        <div className="recent-head">
          <h4>Gần đây</h4>
          <button className="link" onClick={() => void openSaveFolder()}>
            <FolderOpen size={13} />
            Mở thư mục
          </button>
        </div>
        {items.length === 0 ? (
          <div className="empty">
            <Camera size={24} />
            <p>Ảnh bạn chụp sẽ xuất hiện ở đây</p>
            {shortcut && <small>Nhấn {shortcut} để bắt đầu</small>}
          </div>
        ) : (
          <div className="grid">
            {items.map((i) => (
              <div key={i.path} className="shot" title="Bấm để xem nổi trên màn hình" onClick={() => void pinHistoryItem(i.path)}>
                <img src={i.url} alt="" draggable={false} />
                <span className="shot-time">{timeAgo(i.createdMs)}</span>
                <div className="shot-actions">
                  <button
                    title="Sao chép"
                    onClick={(e) => {
                      e.stopPropagation();
                      void copyHistoryItem(i.path).then(() => notify("Đã sao chép"));
                    }}
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    title="Xoá"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteHistory(i.path).then(refresh);
                    }}
                  >
                    <Trash size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      {flash && <div className="home-flash">{flash}</div>}
    </div>
  );
}
