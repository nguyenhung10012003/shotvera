import { useEffect, useState } from "react";
import { Pause, Play, Square, Trash } from "lucide-react";
import { useT } from "../i18n";
import { formatDuration } from "../lib/duration";
import {
  cancelRecording,
  onRecordingState,
  pauseRecording,
  recordingStatus,
  resumeRecording,
  stopRecording,
  type RecordingStatus,
} from "../lib/platform";
import "./recorder.css";

/** Tracks the recorder's state. Between updates, the timer advances locally. */
function useRecordingStatus(): { status: RecordingStatus; elapsedMs: number } {
  const [status, setStatus] = useState<RecordingStatus>({ state: "recording", elapsedMs: 0, format: null });
  const [base, setBase] = useState({ at: performance.now(), ms: 0 });
  const [, setTick] = useState(0);

  useEffect(() => {
    const apply = (s: RecordingStatus) => {
      setStatus(s);
      setBase({ at: performance.now(), ms: s.elapsedMs });
    };
    void recordingStatus().then(apply);
    const unlisten = onRecordingState(apply);
    const timer = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => {
      window.clearInterval(timer);
      void unlisten.then((u) => u());
    };
  }, []);

  const elapsedMs = status.state === "recording" ? base.ms + performance.now() - base.at : status.elapsedMs;
  return { status, elapsedMs };
}

/** The floating control bar shown during a recording. */
export function RecorderApp() {
  const t = useT();
  const { status, elapsedMs } = useRecordingStatus();
  const paused = status.state === "paused";
  const busy = status.state === "processing" || status.state === "idle";

  return (
    <div className="recbar" data-tauri-drag-region>
      <span className={`rec-dot${paused ? " paused" : ""}`} data-tauri-drag-region />
      <span className="rec-time" data-tauri-drag-region>
        {busy ? t("rec.saving") : formatDuration(elapsedMs)}
      </span>
      {status.format === "gif" && (
        <span className="rec-badge" data-tauri-drag-region>
          GIF
        </span>
      )}
      <span className="rec-spacer" data-tauri-drag-region />
      <button
        title={t(paused ? "rec.resume" : "rec.pause")}
        disabled={busy}
        onClick={() => void (paused ? resumeRecording() : pauseRecording())}
      >
        {paused ? <Play size={15} /> : <Pause size={15} />}
      </button>
      <button className="rec-stop" title={t("rec.stop")} disabled={busy} onClick={() => void stopRecording()}>
        <Square size={13} fill="currentColor" />
      </button>
      <button title={t("rec.discard")} disabled={busy} onClick={() => void cancelRecording()}>
        <Trash size={15} />
      </button>
    </div>
  );
}

/** A border just outside the recorded area. The window itself ignores the mouse. */
export function FrameApp() {
  const { status } = useRecordingStatus();
  return <div className={`recframe${status.state === "paused" ? " paused" : ""}`} />;
}
