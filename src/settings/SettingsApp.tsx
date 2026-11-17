import { useEffect, useState, type ReactNode } from "react";
import { Info, Keyboard, Settings as Cog, Sparkles } from "lucide-react";
import {
  applyCaptureShortcut,
  getApiKey,
  isTauri,
  loadSettings,
  resolvedSaveDir,
  saveSettings,
  setApiKey,
} from "../lib/platform";
import { AI_MODELS, DEFAULT_SETTINGS, type Settings } from "../lib/settings";

type Tab = "general" | "shortcuts" | "ai" | "about";

const IS_MAC = navigator.platform.toLowerCase().includes("mac");

export function SettingsApp() {
  const [tab, setTab] = useState<Tab>("general");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  const update = async (patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    await saveSettings(patch);
  };

  const tabs: { id: Tab; label: string; icon: ReactNode }[] = [
    { id: "general", label: "Chung", icon: <Cog size={16} /> },
    { id: "shortcuts", label: "Phím tắt", icon: <Keyboard size={16} /> },
    { id: "ai", label: "AI", icon: <Sparkles size={16} /> },
    { id: "about", label: "Giới thiệu", icon: <Info size={16} /> },
  ];

  return (
    <div className="settings">
      <nav className="settings-tabs" data-tauri-drag-region>
        {tabs.map((t) => (
          <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>
      <main className="settings-body">
        {tab === "general" && <General settings={settings} update={update} />}
        {tab === "shortcuts" && <Shortcuts settings={settings} update={update} />}
        {tab === "ai" && <AiSettings settings={settings} update={update} />}
        {tab === "about" && <About />}
      </main>
    </div>
  );
}

interface SectionProps {
  settings: Settings;
  update(patch: Partial<Settings>): Promise<void>;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="row">
      <div className="row-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange(v: boolean): void }) {
  return <button className={`toggle${on ? " on" : ""}`} onClick={() => onChange(!on)} aria-pressed={on} />;
}

function General({ settings, update }: SectionProps) {
  const [dir, setDir] = useState("");
  const [autostart, setAutostart] = useState(settings.launchAtLogin);

  useEffect(() => {
    void resolvedSaveDir().then(setDir);
  }, [settings.saveDir]);

  useEffect(() => {
    if (!isTauri) return;
    void import("@tauri-apps/plugin-autostart").then((m) => m.isEnabled()).then(setAutostart);
  }, []);

  const pickDir = async () => {
    if (!isTauri) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, defaultPath: dir });
    if (typeof picked === "string") await update({ saveDir: picked });
  };

  const setLogin = async (on: boolean) => {
    setAutostart(on);
    if (isTauri) {
      const m = await import("@tauri-apps/plugin-autostart");
      if (on) await m.enable();
      else await m.disable();
    }
    await update({ launchAtLogin: on });
  };

  return (
    <>
      <h2>Chung</h2>
      <Row label="Thư mục lưu ảnh" hint="Dùng cho Lưu nhanh (⌘S)">
        <div className="path">
          <code title={dir}>{dir}</code>
          <button className="btn" onClick={() => void pickDir()}>
            Đổi…
          </button>
        </div>
      </Row>
      <Row label="Định dạng lưu nhanh">
        <div className="seg">
          {(["png", "jpg"] as const).map((f) => (
            <button key={f} className={settings.saveFormat === f ? "on" : ""} onClick={() => void update({ saveFormat: f })}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Đóng sau khi sao chép" hint="Nút ✓ / ⌘C sẽ đóng màn hình chụp">
        <Toggle on={settings.closeAfterCopy} onChange={(v) => void update({ closeAfterCopy: v })} />
      </Row>
      <Row label="Mở cùng hệ thống" hint="Chạy Shotvera khi đăng nhập máy tính">
        <Toggle on={autostart} onChange={(v) => void setLogin(v)} />
      </Row>
    </>
  );
}

function toAccelerator(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("CommandOrControl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const code = e.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(code)) key = code;
  else if (code === "Space") key = "Space";
  if (!key) return null;
  if (parts.length === 0 && !key.startsWith("F")) return null; // plain letters would steal typing
  return [...parts, key].join("+");
}

export function prettyShortcut(acc: string): string {
  return acc
    .split("+")
    .map((p) =>
      p === "CommandOrControl" ? (IS_MAC ? "⌘" : "Ctrl") : p === "Shift" ? (IS_MAC ? "⇧" : "Shift") : p === "Alt" ? (IS_MAC ? "⌥" : "Alt") : p,
    )
    .join(IS_MAC ? "" : "+");
}

function Shortcuts({ settings, update }: SectionProps) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = async (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const acc = toAccelerator(e);
      if (!acc) return;
      setRecording(false);
      try {
        await applyCaptureShortcut(acc);
        await update({ captureShortcut: acc });
        setError(null);
      } catch (err) {
        setError(`Không đặt được phím tắt: ${String(err)}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, update]);

  const list: [string, string][] = [
    ["Sao chép & đóng", IS_MAC ? "⌘C · ⌘↵ · nhấp đúp" : "Ctrl+C · Ctrl+Enter · nhấp đúp"],
    ["Lưu nhanh / Lưu thành…", IS_MAC ? "⌘S / ⇧⌘S" : "Ctrl+S / Ctrl+Shift+S"],
    ["Hoàn tác / Làm lại", IS_MAC ? "⌘Z / ⇧⌘Z" : "Ctrl+Z / Ctrl+Y"],
    ["Ghim lên màn hình", "F3"],
    ["Mở AI", "I"],
    ["Công cụ", "V R O L A P H T M N E"],
    ["Di chuyển vùng chọn 1px / 10px", "← ↑ → ↓ / ⇧ + mũi tên"],
    ["Sao chép mã màu (khi đang chọn vùng)", "C"],
    ["Thoát", "Esc · chuột phải"],
  ];

  return (
    <>
      <h2>Phím tắt</h2>
      <Row label="Chụp màn hình" hint="Phím tắt toàn hệ thống">
        <button className={`shortcut${recording ? " rec" : ""}`} onClick={() => setRecording(true)}>
          {recording ? "Nhấn tổ hợp phím…" : prettyShortcut(settings.captureShortcut)}
        </button>
      </Row>
      {error && <p className="error">{error}</p>}
      <p className="hint">Nếu phím tắt không hoạt động, có thể nó đang trùng với ứng dụng khác. Hãy chọn tổ hợp khác.</p>
      <h3>Trong màn hình chụp</h3>
      <table className="keys">
        <tbody>
          {list.map(([a, b]) => (
            <tr key={a}>
              <td>{a}</td>
              <td>
                <kbd>{b}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function AiSettings({ settings, update }: SectionProps) {
  const [hasKey, setHasKey] = useState(false);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");

  useEffect(() => {
    void getApiKey().then((k) => setHasKey(!!k));
  }, []);

  const saveKey = async () => {
    await setApiKey(key.trim() || null);
    setHasKey(!!key.trim());
    setKey("");
    setEditing(false);
  };

  return (
    <>
      <h2>AI</h2>
      <Row label="Anthropic API key" hint="Lưu an toàn trong kho khoá của hệ điều hành">
        {editing ? (
          <div className="path">
            <input type="password" placeholder="sk-ant-…" value={key} autoFocus onChange={(e) => setKey(e.target.value)} />
            <button className="btn primary" onClick={() => void saveKey()}>
              Lưu
            </button>
          </div>
        ) : (
          <div className="path">
            <span className={hasKey ? "ok" : "muted"}>{hasKey ? "Đã thiết lập" : "Chưa có"}</span>
            <button className="btn" onClick={() => setEditing(true)}>
              {hasKey ? "Thay đổi" : "Thêm"}
            </button>
            {hasKey && (
              <button
                className="btn"
                onClick={() => {
                  void setApiKey(null).then(() => setHasKey(false));
                }}
              >
                Xoá
              </button>
            )}
          </div>
        )}
      </Row>
      <Row label="Mô hình">
        <select value={settings.aiModel} onChange={(e) => void update({ aiModel: e.target.value as Settings["aiModel"] })}>
          {AI_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {m.hint}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Mức suy luận" hint="Cao hơn: kỹ hơn nhưng chậm và tốn hơn">
        <div className="seg">
          {(
            [
              ["low", "Nhanh"],
              ["medium", "Cân bằng"],
              ["high", "Kỹ"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className={settings.aiEffort === v ? "on" : ""} onClick={() => void update({ aiEffort: v })}>
              {label}
            </button>
          ))}
        </div>
      </Row>
      <p className="hint">
        Ảnh chụp chỉ được gửi tới Anthropic khi bạn mở khung AI và gửi câu hỏi. Shotvera không lưu ảnh hay hội thoại trên máy chủ nào khác.
      </p>
    </>
  );
}

function About() {
  return (
    <div className="about">
      <div className="about-logo">S</div>
      <h2>Shotvera</h2>
      <p>Phiên bản 0.1.0</p>
      <p className="hint">Chụp màn hình, chú thích và chỉnh sửa bằng AI trên macOS, Windows và Linux.</p>
    </div>
  );
}
