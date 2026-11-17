import { useLayoutEffect, useRef } from "react";
import { useOverlay } from "./store";

const SIZE = 132; // CSS px
const CELLS = 15; // physical pixels shown per side (odd, so there is a center pixel)

export function pixelHex(data: Uint8ClampedArray, width: number, x: number, y: number): string {
  const i = (y * width + x) * 4;
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${hex(data[i])}${hex(data[i + 1])}${hex(data[i + 2])}`.toUpperCase();
}

/** Zoomed loupe with crosshair, pixel coordinates and the color under the cursor. */
export function Magnifier() {
  const frame = useOverlay((s) => s.frame)!;
  const cursor = useOverlay((s) => s.cursor);
  const canvas = useRef<HTMLCanvasElement>(null);

  const px = cursor ? Math.min(frame.width - 1, Math.max(0, Math.floor(cursor.x * frame.scale))) : 0;
  const py = cursor ? Math.min(frame.height - 1, Math.max(0, Math.floor(cursor.y * frame.scale))) : 0;

  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c || !cursor) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== SIZE * dpr) {
      c.width = SIZE * dpr;
      c.height = SIZE * dpr;
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, SIZE, SIZE);
    const half = Math.floor(CELLS / 2);
    const cell = SIZE / CELLS;
    ctx.drawImage(frame.bitmap, px - half, py - half, CELLS, CELLS, 0, 0, SIZE, SIZE);

    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    for (let i = 1; i < CELLS; i++) {
      ctx.beginPath();
      ctx.moveTo(i * cell, 0);
      ctx.lineTo(i * cell, SIZE);
      ctx.moveTo(0, i * cell);
      ctx.lineTo(SIZE, i * cell);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(61,155,255,0.28)";
    ctx.fillRect(half * cell, 0, cell, SIZE);
    ctx.fillRect(0, half * cell, SIZE, cell);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(half * cell, half * cell, cell, cell);
  }, [frame, cursor, px, py]);

  if (!cursor) return null;

  const color = pixelHex(frame.data, frame.width, px, py);
  const boxH = SIZE + 46;
  let left = cursor.x + 20;
  let top = cursor.y + 24;
  if (left + SIZE > frame.cssWidth - 4) left = cursor.x - SIZE - 20;
  if (top + boxH > frame.cssHeight - 4) top = cursor.y - boxH - 20;

  return (
    <div className="magnifier" style={{ left, top, width: SIZE }}>
      <canvas ref={canvas} style={{ width: SIZE, height: SIZE }} />
      <div className="magnifier-info">
        <div className="magnifier-row">
          <span>
            {px}, {py}
          </span>
          <span className="magnifier-color">
            <i style={{ background: color }} />
            {color}
          </span>
        </div>
        <div className="magnifier-hint">C: sao chép màu · Esc: thoát</div>
      </div>
    </div>
  );
}
