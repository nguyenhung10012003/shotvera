export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export function containsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Applies a handle drag to `start`. Dragging past the opposite edge flips the rect,
 * the same way native selection tools behave.
 */
export function resizeRect(start: Rect, handle: Handle, dx: number, dy: number): Rect {
  let x1 = start.x;
  let y1 = start.y;
  let x2 = start.x + start.w;
  let y2 = start.y + start.h;
  if (handle.includes("w")) x1 += dx;
  if (handle.includes("e")) x2 += dx;
  if (handle.includes("n")) y1 += dy;
  if (handle.includes("s")) y2 += dy;
  return rectFromPoints({ x: x1, y: y1 }, { x: x2, y: y2 });
}

export function handlePosition(r: Rect, handle: Handle): Point {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const x = handle.includes("w") ? r.x : handle.includes("e") ? r.x + r.w : cx;
  const y = handle.includes("n") ? r.y : handle.includes("s") ? r.y + r.h : cy;
  return { x, y };
}

export function cursorForHandle(handle: Handle): string {
  switch (handle) {
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "nw":
    case "se":
      return "nwse-resize";
  }
}

export function roundRect(r: Rect): Rect {
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Places a floating panel of `size` next to `anchor` inside `bounds`.
 * Tries below (right-aligned), then above, then inside the anchor's bottom edge.
 */
export function placeBelowOrAbove(
  anchor: Rect,
  size: { w: number; h: number },
  bounds: { w: number; h: number },
  gap = 8,
): { x: number; y: number; side: "below" | "above" | "inside" } {
  const x = clamp(anchor.x + anchor.w - size.w, gap, bounds.w - size.w - gap);
  const below = anchor.y + anchor.h + gap;
  if (below + size.h <= bounds.h - gap) return { x, y: below, side: "below" };
  const above = anchor.y - gap - size.h;
  if (above >= gap) return { x, y: above, side: "above" };
  return { x, y: clamp(anchor.y + anchor.h - size.h - gap, gap, bounds.h - size.h - gap), side: "inside" };
}

/** Places a side panel to the right of `anchor`, else to the left, else pinned to the screen's right edge. */
export function placeBeside(
  anchor: Rect,
  size: { w: number; h: number },
  bounds: { w: number; h: number },
  gap = 12,
): { x: number; y: number } {
  const y = clamp(anchor.y, gap, Math.max(gap, bounds.h - size.h - gap));
  const right = anchor.x + anchor.w + gap;
  if (right + size.w <= bounds.w - gap) return { x: right, y };
  const left = anchor.x - gap - size.w;
  if (left >= gap) return { x: left, y };
  return { x: bounds.w - size.w - gap, y };
}
