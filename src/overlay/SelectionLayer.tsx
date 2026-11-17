import { useRef } from "react";
import {
  HANDLES,
  cursorForHandle,
  handlePosition,
  resizeRect,
  type Handle,
  type Rect,
} from "../lib/geometry";
import { useT } from "../i18n";
import { followGlobalPointer } from "../lib/platform";
import { desktopBoundsLocal, intersect } from "./space";
import { useOverlay } from "./store";

/** Dim mask, selection frame, resize handles and the size/window label. */
export function SelectionLayer() {
  const t = useT();
  const frame = useOverlay((s) => s.frame)!;
  const phase = useOverlay((s) => s.phase);
  const selection = useOverlay((s) => s.selection);
  const hover = useOverlay((s) => s.hover);
  const space = useOverlay((s) => s.space)!;

  const W = frame.cssWidth;
  const H = frame.cssHeight;
  const isHover = phase === "selecting" && !selection && !!hover;
  const rect: Rect | null = selection ?? (phase === "selecting" ? hover : null);

  const hole = rect ? `M${rect.x} ${rect.y}h${rect.w}v${rect.h}h${-rect.w}Z` : "";
  const pxW = rect ? Math.round(rect.w * frame.scale) : 0;
  const pxH = rect ? Math.round(rect.h * frame.scale) : 0;
  const hoverName =
    isHover && hover ? (hover.app ? [hover.app, hover.title].filter(Boolean).join(" — ") : t("overlay.fullScreen")) : "";

  const labelAbove = rect && rect.y > 30;

  return (
    <>
      <svg className="mask" width={W} height={H}>
        <path d={`M0 0H${W}V${H}H0Z${hole}`} fillRule="evenodd" fill="rgba(8, 8, 12, 0.48)" />
      </svg>
      {rect && (
        <div
          className={`sel-frame${isHover ? " hover" : ""}`}
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        >
          {phase === "editing" && HANDLES.map((h) => <ResizeHandle key={h} handle={h} rect={rect} bounds={desktopBoundsLocal(space)} />)}
        </div>
      )}
      {rect && rect.w > 0 && (
        <div
          className="size-label"
          style={{
            left: rect.x,
            top: labelAbove ? rect.y - 26 : rect.y + 6,
            marginLeft: labelAbove ? 0 : 6,
          }}
        >
          {hoverName && <span className="size-label-name">{hoverName}</span>}
          {pxW} × {pxH}
        </div>
      )}
    </>
  );
}

/** Resize handles may be dragged onto other monitors, so they are bounded by the whole desktop. */
function ResizeHandle({ handle, rect, bounds }: { handle: Handle; rect: Rect; bounds: Rect }) {
  const drag = useRef<{ x: number; y: number; start: Rect; stop: () => void } | null>(null);
  const p = handlePosition(rect, handle);

  const apply = (clientX: number, clientY: number) => {
    const d = drag.current;
    if (!d) return;
    const st = useOverlay.getState();
    const scale = st.frame?.scale ?? 1;
    const resized = resizeRect(d.start, handle, clientX - d.x, clientY - d.y);
    const next = intersect(resized, bounds) ?? resized;
    const snap = (v: number) => Math.round(v * scale) / scale;
    const x = snap(next.x);
    const y = snap(next.y);
    st.setSelection({ x, y, w: Math.max(1 / scale, snap(next.x + next.w) - x), h: Math.max(1 / scale, snap(next.y + next.h) - y) });
  };
  const end = () => {
    drag.current?.stop();
    drag.current = null;
  };

  return (
    <div
      className="handle"
      style={{ left: p.x - rect.x, top: p.y - rect.y, cursor: cursorForHandle(handle) }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        // Follow the OS pointer too, so the edge can be dragged onto another monitor.
        const stop = followGlobalPointer((gx, gy) => {
          const sp = useOverlay.getState().space;
          if (sp) apply((gx - sp.self.x) * sp.cssPerNative, (gy - sp.self.y) * sp.cssPerNative);
        }, end);
        drag.current = { x: e.clientX, y: e.clientY, start: rect, stop };
      }}
      onPointerMove={(e) => apply(e.clientX, e.clientY)}
      onPointerUp={(e) => {
        end();
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      }}
    />
  );
}
