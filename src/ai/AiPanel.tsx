import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, CircleStop, KeyRound, Sparkles, X } from "lucide-react";
import { useT } from "../i18n";
import { placeBeside } from "../lib/geometry";
import { getApiKey, isTauri, setApiKey } from "../lib/platform";
import { useOverlay } from "../overlay/store";
import { Markdown } from "./Markdown";
import { QUICK_ACTIONS } from "./prompts";
import { useAiSession } from "./session";

const WIDTH = 380;

export function AiPanel() {
  const frame = useOverlay((s) => s.frame)!;
  const selection = useOverlay((s) => s.selection)!;
  const messages = useAiSession((s) => s.messages);
  const status = useAiSession((s) => s.status);
  const needsKey = useAiSession((s) => s.needsKey);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const t = useT();

  useEffect(() => {
    void getApiKey().then((k) => setHasKey(!!k));
  }, [needsKey]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    if (hasKey) textarea.current?.focus();
  }, [hasKey]);

  const toolbar = useOverlay((s) => s.toolbarRect);
  let height = Math.min(600, frame.cssHeight - 24);
  const pos = placeBeside(selection, { w: WIDTH, h: height }, { w: frame.cssWidth, h: frame.cssHeight });
  // Keep the toolbar visible: if the panel would cover it, end the panel just above (or start just below) it.
  if (toolbar && pos.x < toolbar.x + toolbar.w && pos.x + WIDTH > toolbar.x && pos.y < toolbar.y + toolbar.h && pos.y + height > toolbar.y) {
    const MIN = 320;
    const spaceAbove = toolbar.y - 8 - 12;
    const spaceBelow = frame.cssHeight - 12 - (toolbar.y + toolbar.h + 8);
    if (spaceAbove >= Math.min(MIN, spaceBelow) || spaceAbove >= MIN) {
      height = Math.min(height, spaceAbove);
      pos.y = Math.max(12, Math.min(pos.y, toolbar.y - 8 - height));
    } else {
      pos.y = toolbar.y + toolbar.h + 8;
      height = Math.min(height, spaceBelow);
    }
  }
  const showSetup = hasKey === false || needsKey;

  const submit = () => {
    const text = input.trim();
    if (!text || status === "streaming") return;
    setInput("");
    void useAiSession.getState().send(text);
  };

  return (
    <div
      className="ai-panel"
      style={{ left: pos.x, top: pos.y, width: WIDTH, height }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <header className="ai-head">
        <span className="ai-logo">
          <Sparkles size={15} />
        </span>
        <b>Shotvera AI</b>
        <span className="ai-sub">Claude</span>
        <button className="icon-btn" onClick={() => useOverlay.getState().setAiOpen(false)} aria-label={t("common.close")}>
          <X size={16} />
        </button>
      </header>

      {showSetup ? (
        <KeySetup
          onSaved={() => {
            setHasKey(true);
            useAiSession.getState().setNeedsKey(false);
          }}
        />
      ) : (
        <>
          <div className="ai-list" ref={list}>
            {messages.length === 0 && (
              <div className="ai-empty">
                <p>{t("ai.intro")}</p>
                <div className="chips">
                  {QUICK_ACTIONS.map((id) => (
                    <button key={id} className="chip" onClick={() => void useAiSession.getState().sendQuick(id)}>
                      {t(`quick.${id}`)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                {m.role === "user" ? (
                  <div className="bubble">{m.text}</div>
                ) : (
                  <div className="reply">
                    {m.parts.map((p, i) =>
                      p.kind === "text" ? (
                        <Markdown key={i} text={p.text} />
                      ) : (
                        <div key={i} className={`tool-chip ${p.status}`}>
                          {p.status === "running" ? <span className="spinner" /> : p.status === "done" ? <Check size={13} /> : <X size={13} />}
                          {p.summary ?? t(p.status === "error" ? "ai.toolFailed" : p.name === "add_annotations" ? "ai.drawing" : "ai.removing")}
                        </div>
                      ),
                    )}
                    {m.pending && (
                      <div className="thinking">
                        <i />
                        <i />
                        <i />
                      </div>
                    )}
                    {m.error && <div className="ai-error">{m.error}</div>}
                  </div>
                )}
              </div>
            ))}
          </div>
          {messages.length > 0 && status === "idle" && (
            <div className="chips compact">
              {QUICK_ACTIONS.slice(0, 4).map((id) => (
                <button key={id} className="chip" onClick={() => void useAiSession.getState().sendQuick(id)}>
                  {t(`quick.${id}`)}
                </button>
              ))}
            </div>
          )}
          <div className="composer">
            <textarea
              ref={textarea}
              value={input}
              rows={1}
              placeholder={t("ai.placeholder")}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  (e.target as HTMLTextAreaElement).blur();
                }
              }}
            />
            {status === "streaming" ? (
              <button className="send stop" onClick={() => useAiSession.getState().stop()} aria-label={t("ai.stop")}>
                <CircleStop size={16} />
              </button>
            ) : (
              <button className="send" disabled={!input.trim()} onClick={submit} aria-label={t("ai.send")}>
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function KeySetup({ onSaved }: { onSaved(): void }) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  const save = async () => {
    const value = key.trim();
    if (!value) return;
    setSaving(true);
    setError(null);
    try {
      await setApiKey(value);
      onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const openConsole = async () => {
    const url = "https://console.anthropic.com/settings/keys";
    if (isTauri) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } else {
      window.open(url, "_blank");
    }
  };

  return (
    <div className="key-setup">
      <KeyRound size={26} />
      <h3>{t("ai.connectTitle")}</h3>
      <p>{t("ai.connectBody", { store: t(isTauri ? "ai.storeOs" : "ai.storeBrowser") })}</p>
      <input
        type="password"
        placeholder="sk-ant-…"
        value={key}
        autoFocus
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") void save();
        }}
      />
      {error && <div className="ai-error">{error}</div>}
      <button className="btn primary" disabled={!key.trim() || saving} onClick={() => void save()}>
        {t(saving ? "ai.saving" : "ai.saveKey")}
      </button>
      <button className="btn link" onClick={() => void openConsole()}>
        {t("ai.getKey")}
      </button>
    </div>
  );
}
