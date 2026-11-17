import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { t } from "../i18n";
import type { ToolId } from "../lib/annotations";
import {
  closeOverlays,
  copyImage,
  isTauri,
  loadFrame,
  loadLayout,
  loadSettings,
  onCaptureStart,
  onWindowsListed,
  overlayReady,
  pinImage,
  quickSave,
  saveAs,
  startRecording,
  type RecordFormat,
} from "../lib/platform";
import { AiPanel } from "../ai/AiPanel";
import { useAiSession } from "../ai/session";
import { EditorStage } from "./EditorStage";
import { buildPixelCanvas, exportComposite } from "./exportImage";
import { Magnifier, pixelHex } from "./Magnifier";
import { RecordBar } from "./RecordBar";
import { SelectionLayer } from "./SelectionLayer";
import { hostMonitor, rectToGlobal, rectToLocal } from "./space";
import { useOverlay } from "./store";
import { startSync } from "./sync";
import { TextEditor } from "./TextEditor";
import { Toolbar, type OverlayAction } from "./Toolbar";

const TOOL_KEYS: Record<string, ToolId> = {
  v: "select",
  r: "rect",
  o: "ellipse",
  l: "line",
  a: "arrow",
  p: "pen",
  h: "marker",
  t: "text",
  m: "mosaic",
  n: "step",
  e: "emoji",
};

export function OverlayApp({ monitor }: { monitor: number }) {
  const frame = useOverlay((s) => s.frame);
  const phase = useOverlay((s) => s.phase);
  const selection = useOverlay((s) => s.selection);
  const editingTextId = useOverlay((s) => s.editingTextId);
  const aiOpen = useOverlay((s) => s.aiOpen);
  const toast = useOverlay((s) => s.toast);
  // Only the monitor holding the selection's bottom-right corner shows the toolbar and AI panel.
  const isHost = useOverlay((s) =>
    s.space && s.selection ? hostMonitor(s.space.layout, rectToGlobal(s.space, s.selection)) === s.monitor : true,
  );
  const bg = useRef<HTMLCanvasElement>(null);
  const loadedSession = useRef<number | null>(null);
  const busy = useRef(false);

  const begin = useCallback(async () => {
    try {
      const f = await loadFrame(monitor);
      if (loadedSession.current === f.sessionId) return;
      const layout = await loadLayout();
      const self = layout.find((m) => m.index === monitor);
      if (!self) throw new Error(`monitor ${monitor} is not in the capture layout`);
      loadedSession.current = f.sessionId;
      // Derived from the monitor, not window.innerWidth: the webview may not have received its
      // new size yet when the capture event arrives.
      const cssWidth = self.width * self.cssPerNative;
      const cssHeight = self.height * self.cssPerNative;
      useAiSession.getState().reset();
      useOverlay.getState().setFrame(
        {
          sessionId: f.sessionId,
          mode: f.mode,
          bitmap: f.bitmap,
          data: f.data,
          width: f.width,
          height: f.height,
          cssWidth,
          cssHeight,
          scale: f.width / cssWidth,
          pixelCanvas: buildPixelCanvas(f.bitmap, cssWidth, cssHeight),
        },
        { self, layout, cssPerNative: self.cssPerNative },
      );
    } catch (err) {
      // No capture session yet (the window was pre-created at startup).
      if (!isTauri) console.error(err);
    }
  }, [monitor]);

  // Lifecycle: load on mount (covers the first capture) and on every later capture.
  useEffect(() => {
    useOverlay.getState().init(monitor);
    const unlisten: (() => void)[] = [];
    let alive = true;
    const keep = (p: Promise<() => void>) => p.then((u) => (alive ? unlisten.push(u) : u()));
    keep(onCaptureStart(() => void begin()));
    keep(
      onWindowsListed((wins) => {
        const st = useOverlay.getState();
        const space = st.space;
        if (!space) return;
        // Global window rects (they may span monitors) in this overlay's coordinates.
        st.setWindows(wins.map((w) => ({ ...rectToLocal(space, w), title: w.title, app: w.app })));
      }),
    );
    unlisten.push(startSync());
    const mockClose = () => {
      loadedSession.current = null;
      void begin();
    };
    window.addEventListener("shotvera:mock-close", mockClose);
    void begin();
    return () => {
      alive = false;
      unlisten.forEach((u) => u());
      window.removeEventListener("shotvera:mock-close", mockClose);
    };
  }, [begin, monitor]);

  // Paint the frozen screenshot, then tell Rust this monitor's overlay can be shown.
  useLayoutEffect(() => {
    const c = bg.current;
    if (!c || !frame) return;
    c.width = frame.width;
    c.height = frame.height;
    c.getContext("2d")!.drawImage(frame.bitmap, 0, 0);
    void overlayReady(monitor);
  }, [frame, monitor]);

  // "Capture & ask AI" / "Capture & extract text": act once the region is chosen, on the
  // monitor that shows the toolbar.
  const modeApplied = useRef<number | null>(null);
  useEffect(() => {
    if (!frame || phase !== "editing" || !selection || !isHost) return;
    if ((frame.mode !== "ai" && frame.mode !== "ocr") || modeApplied.current === frame.sessionId) return;
    modeApplied.current = frame.sessionId;
    useOverlay.getState().setAiOpen(true);
    if (frame.mode === "ocr") void useAiSession.getState().sendQuick("ocr");
  }, [frame, phase, selection, isHost]);

  const runAction = useCallback(
    async (action: OverlayAction) => {
      const st = useOverlay.getState();
      if (action === "close") {
        await closeOverlays();
        return;
      }
      if (!st.frame || !st.selection) return;
      if (action === "record") {
        st.setMode("record");
        return;
      }
      if (action === "ai") {
        st.setAiOpen(!st.aiOpen);
        return;
      }
      if (action === "ocr") {
        st.setAiOpen(true);
        void useAiSession.getState().sendQuick("ocr");
        return;
      }
      if (busy.current) return;
      busy.current = true;
      try {
        (document.activeElement as HTMLElement | null)?.blur();
        st.select(null);
        const img = await exportComposite();
        switch (action) {
          case "copy": {
            await copyImage(img);
            const settings = await loadSettings();
            if (settings.closeAfterCopy && isTauri) await closeOverlays();
            else st.showToast(t("overlay.copiedToClipboard"));
            break;
          }
          case "quickSave": {
            const path = await quickSave(img);
            if (!isTauri) st.showToast(t("overlay.savedTo", { path }));
            break;
          }
          case "saveAs":
            await saveAs(img);
            break;
          case "pin": {
            const where = st.space ? rectToGlobal(st.space, st.selection) : st.selection;
            await pinImage(img, where, { w: st.selection.w, h: st.selection.h });
            await closeOverlays();
            break;
          }
        }
      } catch (err) {
        st.showToast(t("common.error", { message: String(err) }));
      } finally {
        busy.current = false;
      }
    },
    [monitor],
  );

  // Hides the overlays and records the selected area (the record bar's button or Enter).
  const record = useCallback(async (format: RecordFormat, microphone: boolean) => {
    const st = useOverlay.getState();
    if (!st.space || !st.selection) return;
    const g = rectToGlobal(st.space, st.selection);
    try {
      await startRecording({ x: g.x, y: g.y, width: g.w, height: g.h, format, microphone });
    } catch (err) {
      st.showToast(t("common.error", { message: String(err) }));
    }
  }, []);

  // Keyboard shortcuts. Text inputs (AI chat, text annotations) handle their own keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest("textarea, input")) return;
      const st = useOverlay.getState();
      const recordMode = st.frame?.mode === "record" || st.frame?.mode === "gif";
      if (recordMode && e.key !== "Escape") return; // the record bar handles Enter
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (e.key === "Escape") {
        e.preventDefault();
        if (st.selectedId) st.select(null);
        else if (st.aiOpen) st.setAiOpen(false);
        else void runAction("close");
        return;
      }
      if (st.phase === "selecting" && key === "c" && !mod && st.frame && st.cursor) {
        const px = Math.min(st.frame.width - 1, Math.floor(st.cursor.x * st.frame.scale));
        const py = Math.min(st.frame.height - 1, Math.floor(st.cursor.y * st.frame.scale));
        const hex = pixelHex(st.frame.data, st.frame.width, px, py);
        void navigator.clipboard.writeText(hex).then(() => st.showToast(t("overlay.colorCopied", { hex })));
        return;
      }
      if (st.phase !== "editing") return;

      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        st.redo();
      } else if (mod && (key === "c" || e.key === "Enter")) {
        e.preventDefault();
        void runAction("copy");
      } else if (mod && key === "s") {
        e.preventDefault();
        void runAction(e.shiftKey ? "saveAs" : "quickSave");
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (st.selectedId) {
          e.preventDefault();
          st.removeAnnotations([st.selectedId]);
        }
      } else if (e.key === "F3") {
        e.preventDefault();
        void runAction("pin");
      } else if (!mod && !e.altKey && key === "i") {
        e.preventDefault();
        void runAction("ai");
      } else if (!mod && !e.altKey && TOOL_KEYS[key]) {
        st.setTool(TOOL_KEYS[key]);
      } else if (e.key.startsWith("Arrow") && st.selection && st.frame) {
        // Nudge the selection by one physical pixel (Shift: 10).
        e.preventDefault();
        const step = (e.shiftKey ? 10 : 1) / st.frame.scale;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        const s = st.selection;
        st.setSelection({ ...s, x: Math.max(0, s.x + dx), y: Math.max(0, s.y + dy) });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runAction]);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const st = useOverlay.getState();
    if (st.phase === "editing" && st.annotations.length === 0 && !st.aiOpen) {
      st.setSelection(null);
      st.setPhase("selecting");
    } else if (st.phase !== "editing") {
      void runAction("close");
    }
  };

  if (!frame) return <div className="overlay-root loading" />;
  const recordMode = frame.mode === "record" || frame.mode === "gif";

  const onMouseLeave = () => {
    // The pointer moved to another monitor: drop this monitor's loupe and hover highlight.
    const st = useOverlay.getState();
    st.setCursor(null);
    if (st.phase === "selecting") st.setHover(null);
  };

  return (
    <div className="overlay-root" onContextMenu={onContextMenu} onMouseLeave={onMouseLeave}>
      <canvas ref={bg} className="bg-canvas" style={{ width: frame.cssWidth, height: frame.cssHeight }} />
      <EditorStage onDoubleClickInside={() => (recordMode ? undefined : void runAction("copy"))} />
      <SelectionLayer />
      {phase === "selecting" && <Magnifier />}
      {phase === "editing" && selection && isHost && !recordMode && <Toolbar onAction={(a) => void runAction(a)} />}
      {phase === "editing" && selection && isHost && recordMode && (
        <RecordBar onRecord={(format, microphone) => void record(format, microphone)} onClose={() => void runAction("close")} />
      )}
      {editingTextId && <TextEditor />}
      {phase === "editing" && selection && aiOpen && isHost && !recordMode && <AiPanel />}
      {toast && (
        <div key={toast.id} className="toast">
          {toast.text}
        </div>
      )}
    </div>
  );
}
