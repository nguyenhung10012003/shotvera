import { useEffect, useState, type ReactNode } from "react";
import { Info, Keyboard, Settings as Cog, Sparkles, Video } from "lucide-react";
import { LOCALES, setLocale, useT, type Locale, type MessageKey } from "../i18n";
import {
  appVersion,
  applyCaptureShortcut,
  applyLanguage,
  applyRecordShortcut,
  canRecordAudio,
  getApiKey,
  isTauri,
  loadSettings,
  resolvedSaveDir,
  saveSettings,
  setApiKey,
} from "../lib/platform";
import { AI_MODELS, DEFAULT_SETTINGS, type Settings } from "../lib/settings";

type Tab = "general" | "shortcuts" | "recording" | "ai" | "about";

const IS_MAC = navigator.platform.toLowerCase().includes("mac");
const MOD = IS_MAC ? "⌘" : "Ctrl+";

export function SettingsApp() {
  const t = useT();
  const [tab, setTab] = useState<Tab>("general");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  const update = async (patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    await saveSettings(patch);
  };

  const tabs: { id: Tab; label: MessageKey; icon: ReactNode }[] = [
    { id: "general", label: "settings.tab.general", icon: <Cog size={16} /> },
    { id: "shortcuts", label: "settings.tab.shortcuts", icon: <Keyboard size={16} /> },
    { id: "recording", label: "settings.tab.recording", icon: <Video size={16} /> },
    { id: "ai", label: "settings.tab.ai", icon: <Sparkles size={16} /> },
    { id: "about", label: "settings.tab.about", icon: <Info size={16} /> },
  ];

  return (
    <div className="settings">
      <nav className="settings-tabs" data-tauri-drag-region>
        {tabs.map((item) => (
          <button key={item.id} className={tab === item.id ? "on" : ""} onClick={() => setTab(item.id)}>
            {item.icon}
            {t(item.label)}
          </button>
        ))}
      </nav>
      <main className="settings-body">
        {tab === "general" && <General settings={settings} update={update} />}
        {tab === "shortcuts" && <Shortcuts settings={settings} update={update} />}
        {tab === "recording" && <RecordingSettings settings={settings} update={update} />}
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
  const t = useT();
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

  const setLanguage = async (language: Locale) => {
    setLocale(language);
    await update({ language });
    await applyLanguage(language);
  };

  return (
    <>
      <h2>{t("settings.tab.general")}</h2>
      <Row label={t("settings.language")}>
        <select value={settings.language} onChange={(e) => void setLanguage(e.target.value as Locale)}>
          {LOCALES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t("settings.saveFolder")} hint={t("settings.saveFolderHint", { shortcut: `${MOD}S` })}>
        <div className="path">
          <code title={dir}>{dir}</code>
          <button className="btn" onClick={() => void pickDir()}>
            {t("settings.change")}
          </button>
        </div>
      </Row>
      <Row label={t("settings.saveFormat")}>
        <div className="seg">
          {(["png", "jpg"] as const).map((f) => (
            <button key={f} className={settings.saveFormat === f ? "on" : ""} onClick={() => void update({ saveFormat: f })}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </Row>
      <Row label={t("settings.closeAfterCopy")} hint={t("settings.closeAfterCopyHint", { shortcut: `${MOD}C` })}>
        <Toggle on={settings.closeAfterCopy} onChange={(v) => void update({ closeAfterCopy: v })} />
      </Row>
      <Row label={t("settings.launchAtLogin")} hint={t("settings.launchAtLoginHint")}>
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

/** A button that records a new key combination and registers it with `apply`. */
function ShortcutField({ value, apply, onSaved }: { value: string; apply(acc: string): Promise<void>; onSaved(acc: string): Promise<void> }) {
  const t = useT();
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
        await apply(acc);
        await onSaved(acc);
        setError(null);
      } catch (err) {
        setError(t("settings.shortcutError", { error: String(err) }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, apply, onSaved, t]);

  return (
    <div className="shortcut-field">
      <button className={`shortcut${recording ? " rec" : ""}`} onClick={() => setRecording(true)}>
        {recording ? t("settings.pressKeys") : prettyShortcut(value)}
      </button>
      {error && <small className="error">{error}</small>}
    </div>
  );
}

function Shortcuts({ settings, update }: SectionProps) {
  const t = useT();
  const doubleClick = t("settings.keys.doubleClick");
  const list: [MessageKey, string][] = [
    ["settings.keys.copyClose", IS_MAC ? `⌘C · ⌘↵ · ${doubleClick}` : `Ctrl+C · Ctrl+Enter · ${doubleClick}`],
    ["settings.keys.save", IS_MAC ? "⌘S / ⇧⌘S" : "Ctrl+S / Ctrl+Shift+S"],
    ["settings.keys.undoRedo", IS_MAC ? "⌘Z / ⇧⌘Z" : "Ctrl+Z / Ctrl+Y"],
    ["settings.keys.pin", "F3"],
    ["settings.keys.ai", "I"],
    ["settings.keys.tools", "V R O L A P H T M N E"],
    ["settings.keys.nudge", `← ↑ → ↓ / ${IS_MAC ? "⇧" : "Shift"} + ${t("settings.keys.arrows")}`],
    ["settings.keys.copyColor", "C"],
    ["settings.keys.exit", `Esc · ${t("settings.keys.rightClick")}`],
  ];

  return (
    <>
      <h2>{t("settings.tab.shortcuts")}</h2>
      <Row label={t("settings.captureShortcut")} hint={t("settings.captureShortcutHint")}>
        <ShortcutField
          value={settings.captureShortcut}
          apply={applyCaptureShortcut}
          onSaved={(acc) => update({ captureShortcut: acc })}
        />
      </Row>
      <Row label={t("settings.recordShortcut")} hint={t("settings.recordShortcutHint")}>
        <ShortcutField
          value={settings.recordShortcut}
          apply={applyRecordShortcut}
          onSaved={(acc) => update({ recordShortcut: acc })}
        />
      </Row>
      <p className="hint">{t("settings.shortcutHint")}</p>
      <h3>{t("settings.inCapture")}</h3>
      <table className="keys">
        <tbody>
          {list.map(([label, keys]) => (
            <tr key={label}>
              <td>{t(label)}</td>
              <td>
                <kbd>{keys}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function RecordingSettings({ settings, update }: SectionProps) {
  const t = useT();
  return (
    <>
      <h2>{t("settings.tab.recording")}</h2>
      <Row label={t("settings.recordFormat")}>
        <div className="seg">
          {(["mp4", "gif"] as const).map((f) => (
            <button key={f} className={settings.recordFormat === f ? "on" : ""} onClick={() => void update({ recordFormat: f })}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </Row>
      <Row label={t("settings.recordFps")} hint={t("settings.recordFpsHint")}>
        <div className="seg">
          {([30, 60] as const).map((fps) => (
            <button key={fps} className={settings.recordFps === fps ? "on" : ""} onClick={() => void update({ recordFps: fps })}>
              {fps} fps
            </button>
          ))}
        </div>
      </Row>
      {canRecordAudio && (
        <>
          <Row label={t("settings.recordMicrophone")} hint={t("settings.recordMicrophoneHint")}>
            <Toggle on={settings.recordMicrophone} onChange={(v) => void update({ recordMicrophone: v })} />
          </Row>
          <Row label={t("settings.recordClicks")} hint={t("settings.recordClicksHint")}>
            <Toggle on={settings.recordShowClicks} onChange={(v) => void update({ recordShowClicks: v })} />
          </Row>
          <Row label={t("settings.recordRetina")} hint={t("settings.recordRetinaHint")}>
            <Toggle on={settings.recordFullResolution} onChange={(v) => void update({ recordFullResolution: v })} />
          </Row>
        </>
      )}
      <p className="hint">{t("settings.recordInfo")}</p>
    </>
  );
}

function AiSettings({ settings, update }: SectionProps) {
  const t = useT();
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

  const efforts: [Settings["aiEffort"], MessageKey][] = [
    ["low", "settings.effort.low"],
    ["medium", "settings.effort.medium"],
    ["high", "settings.effort.high"],
  ];

  return (
    <>
      <h2>{t("settings.tab.ai")}</h2>
      <Row label={t("settings.apiKey")} hint={t("settings.apiKeyHint")}>
        {editing ? (
          <div className="path">
            <input type="password" placeholder="sk-ant-…" value={key} autoFocus onChange={(e) => setKey(e.target.value)} />
            <button className="btn primary" onClick={() => void saveKey()}>
              {t("common.save")}
            </button>
          </div>
        ) : (
          <div className="path">
            <span className={hasKey ? "ok" : "muted"}>{t(hasKey ? "settings.keySet" : "settings.keyMissing")}</span>
            <button className="btn" onClick={() => setEditing(true)}>
              {t(hasKey ? "settings.keyChange" : "settings.keyAdd")}
            </button>
            {hasKey && (
              <button
                className="btn"
                onClick={() => {
                  void setApiKey(null).then(() => setHasKey(false));
                }}
              >
                {t("settings.keyRemove")}
              </button>
            )}
          </div>
        )}
      </Row>
      <Row label={t("settings.model")}>
        <select value={settings.aiModel} onChange={(e) => void update({ aiModel: e.target.value as Settings["aiModel"] })}>
          {AI_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {t(m.hint)}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t("settings.effort")} hint={t("settings.effortHint")}>
        <div className="seg">
          {efforts.map(([value, label]) => (
            <button key={value} className={settings.aiEffort === value ? "on" : ""} onClick={() => void update({ aiEffort: value })}>
              {t(label)}
            </button>
          ))}
        </div>
      </Row>
      <p className="hint">{t("settings.aiPrivacy")}</p>
    </>
  );
}

function About() {
  const t = useT();
  const [version, setVersion] = useState("");

  useEffect(() => {
    void appVersion().then(setVersion);
  }, []);

  return (
    <div className="about">
      <div className="about-logo">S</div>
      <h2>Shotvera</h2>
      <p>{version ? t("settings.version", { version }) : " "}</p>
      <p className="hint">{t("settings.tagline")}</p>
    </div>
  );
}
