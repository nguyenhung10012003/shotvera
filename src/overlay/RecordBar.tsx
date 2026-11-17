import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Mic, MicOff, X } from "lucide-react";
import { useT } from "../i18n";
import { placeBelowOrAbove } from "../lib/geometry";
import { canRecordAudio, loadSettings, saveSettings, type RecordFormat } from "../lib/platform";
import { useOverlay } from "./store";

/** Replaces the annotation toolbar when the selection is meant for a recording. */
export function RecordBar({ onRecord, onClose }: { onRecord(format: RecordFormat, microphone: boolean): void; onClose(): void }) {
  const t = useT();
  const frame = useOverlay((s) => s.frame)!;
  const selection = useOverlay((s) => s.selection)!;
  const [format, setFormat] = useState<RecordFormat>(frame.mode === "gif" ? "gif" : "mp4");
  const [microphone, setMicrophone] = useState(false);
  const [starting, setStarting] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 260, h: 44 });

  useEffect(() => {
    void loadSettings().then((s) => {
      if (frame.mode !== "gif") setFormat(s.recordFormat);
      setMicrophone(s.recordMicrophone);
    });
  }, [frame.mode]);

  useLayoutEffect(() => {
    const el = bar.current;
    if (el && (el.offsetWidth !== size.w || el.offsetHeight !== size.h)) setSize({ w: el.offsetWidth, h: el.offsetHeight });
  });

  const withSound = canRecordAudio && format === "mp4" && microphone;
  const start = () => {
    if (starting) return;
    setStarting(true);
    void saveSettings({ recordFormat: format, recordMicrophone: microphone });
    onRecord(format, withSound);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        start();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const pos = placeBelowOrAbove(selection, size, { w: frame.cssWidth, h: frame.cssHeight });
  return (
    <div ref={bar} className="toolbar recordbar" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      <button className="tb-btn rec-start" data-tip={t("record.startHint")} disabled={starting} onClick={start}>
        <span className="rec-start-dot" />
        <span>{t("record.start")}</span>
      </button>
      <div className="seg">
        {(["mp4", "gif"] as const).map((f) => (
          <button key={f} className={format === f ? "on" : ""} onClick={() => setFormat(f)}>
            {f.toUpperCase()}
          </button>
        ))}
      </div>
      {canRecordAudio && format === "mp4" && (
        <button
          className={`tb-btn${microphone ? " active" : ""}`}
          data-tip={t(microphone ? "record.micOn" : "record.micOff")}
          onClick={() => setMicrophone((v) => !v)}
        >
          {microphone ? <Mic size={17} /> : <MicOff size={17} />}
        </button>
      )}
      <span className="tb-sep" />
      <button className="tb-btn" data-tip={t("toolbar.close")} onClick={onClose}>
        <X size={18} />
      </button>
    </div>
  );
}
