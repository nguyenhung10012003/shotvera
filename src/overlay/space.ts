/**
 * Desktop coordinate space shared by all overlay windows.
 *
 * "Global" units are the platform's native window units (points on macOS, physical pixels on
 * Windows/Linux), the same units Rust reports monitor origins in. Each overlay window works in its
 * own local CSS pixels; selection and annotations are converted to global units when they are
 * shared with the other monitors' overlays.
 */
import type { Annotation } from "../lib/annotations";
import type { Rect } from "../lib/geometry";

export interface MonitorLayout {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
  /** CSS pixels of this monitor's overlay per global unit (1 on macOS, 1 / scale factor elsewhere). */
  cssPerNative: number;
}

export interface Space {
  self: MonitorLayout;
  layout: MonitorLayout[];
  /** CSS pixels of this overlay per global unit (1 on macOS, 1 / devicePixelRatio elsewhere). */
  cssPerNative: number;
}

export const monitorRect = (m: MonitorLayout): Rect => ({ x: m.x, y: m.y, w: m.width, h: m.height });

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}

export function rectToGlobal(s: Space, r: Rect): Rect {
  const k = s.cssPerNative;
  return { x: s.self.x + r.x / k, y: s.self.y + r.y / k, w: r.w / k, h: r.h / k };
}

export function rectToLocal(s: Space, r: Rect): Rect {
  const k = s.cssPerNative;
  return { x: (r.x - s.self.x) * k, y: (r.y - s.self.y) * k, w: r.w * k, h: r.h * k };
}

/** Maps every coordinate of an annotation; `fl` maps lengths (box sizes). Stroke widths are left as is. */
export function mapAnnotation(
  a: Annotation,
  fx: (x: number) => number,
  fy: (y: number) => number,
  fl: (len: number) => number,
): Annotation {
  switch (a.kind) {
    case "rect":
    case "ellipse":
    case "highlight":
    case "pixelate":
      return { ...a, x: fx(a.x), y: fy(a.y), w: fl(a.w), h: fl(a.h) };
    case "line":
    case "arrow": {
      const [x1, y1, x2, y2] = a.points;
      return { ...a, points: [fx(x1), fy(y1), fx(x2), fy(y2)] };
    }
    case "pen":
    case "marker":
    case "mosaic":
      return { ...a, points: a.points.map((v, i) => (i % 2 === 0 ? fx(v) : fy(v))) };
    case "text":
    case "step":
    case "emoji":
      return { ...a, x: fx(a.x), y: fy(a.y) };
  }
}

export function annotationToGlobal(s: Space, a: Annotation): Annotation {
  const k = s.cssPerNative;
  return mapAnnotation(a, (x) => s.self.x + x / k, (y) => s.self.y + y / k, (l) => l / k);
}

export function annotationToLocal(s: Space, a: Annotation): Annotation {
  const k = s.cssPerNative;
  return mapAnnotation(a, (x) => (x - s.self.x) * k, (y) => (y - s.self.y) * k, (l) => l * k);
}

/** Bounding box of all monitors, in this overlay's CSS pixels (selections are clamped to it). */
export function desktopBoundsLocal(s: Space): Rect {
  const x1 = Math.min(...s.layout.map((m) => m.x));
  const y1 = Math.min(...s.layout.map((m) => m.y));
  const x2 = Math.max(...s.layout.map((m) => m.x + m.width));
  const y2 = Math.max(...s.layout.map((m) => m.y + m.height));
  return rectToLocal(s, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
}

/**
 * The monitor that shows the toolbar and AI panel for a selection: the one containing the
 * selection's bottom-right corner, else the one with the largest overlap.
 */
export function hostMonitor(layout: MonitorLayout[], selection: Rect): number {
  const cx = selection.x + selection.w - 0.5;
  const cy = selection.y + selection.h - 0.5;
  const corner = layout.find((m) => cx >= m.x && cy >= m.y && cx < m.x + m.width && cy < m.y + m.height);
  if (corner) return corner.index;
  let best = layout[0]?.index ?? 0;
  let bestArea = -1;
  for (const m of layout) {
    const r = intersect(selection, monitorRect(m));
    const area = r ? r.w * r.h : 0;
    if (area > bestArea) {
      bestArea = area;
      best = m.index;
    }
  }
  return best;
}
