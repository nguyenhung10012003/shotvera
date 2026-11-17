import type { Rect } from "./geometry";

export type ToolId =
  | "select"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "pen"
  | "marker"
  | "text"
  | "mosaic"
  | "step"
  | "emoji";

/** Who created an annotation. AI-created ones behave exactly like hand-drawn ones. */
export type AnnotationSource = "user" | "ai";

interface Base {
  id: string;
  color: string;
  strokeWidth: number;
  source?: AnnotationSource;
}

export interface BoxAnnotation extends Base {
  kind: "rect" | "ellipse" | "highlight" | "pixelate";
  x: number;
  y: number;
  w: number;
  h: number;
  filled?: boolean;
}

export interface LineAnnotation extends Base {
  kind: "line" | "arrow";
  points: [number, number, number, number];
}

export interface PathAnnotation extends Base {
  kind: "pen" | "marker" | "mosaic";
  points: number[];
}

export interface TextAnnotation extends Base {
  kind: "text";
  x: number;
  y: number;
  text: string;
  fontSize: number;
  background: boolean;
}

export interface StepAnnotation extends Base {
  kind: "step";
  x: number;
  y: number;
  n: number;
  size: number;
}

export interface EmojiAnnotation extends Base {
  kind: "emoji";
  x: number;
  y: number;
  char: string;
  size: number;
}

export type Annotation =
  | BoxAnnotation
  | LineAnnotation
  | PathAnnotation
  | TextAnnotation
  | StepAnnotation
  | EmojiAnnotation;

export type AnnotationKind = Annotation["kind"];

export interface DrawStyle {
  color: string;
  strokeWidth: number;
  fontSize: number;
  filled: boolean;
  textBackground: boolean;
  mosaicMode: "brush" | "rect";
  emoji: string;
}

export const PALETTE = [
  "#FF3B30",
  "#FF9500",
  "#FFCC00",
  "#34C759",
  "#0A84FF",
  "#BF5AF2",
  "#FFFFFF",
  "#1C1C1E",
] as const;

export const EMOJIS = [
  "👍", "👎", "👉", "👆", "✅", "❌", "⚠️", "❗",
  "❓", "💡", "⭐", "🔥", "🎉", "❤️", "😀", "😂",
  "😍", "🤔", "😅", "😢", "😡", "👀", "🚀", "🐛",
];

export const DEFAULT_STYLE: DrawStyle = {
  color: PALETTE[0],
  strokeWidth: 4,
  fontSize: 20,
  filled: false,
  textBackground: false,
  mosaicMode: "brush",
  emoji: EMOJIS[0],
};

/** Tools whose shapes are drawn by dragging; pressing on an existing shape grabs it instead. */
export const SHAPE_TOOLS: ReadonlySet<ToolId> = new Set(["rect", "ellipse", "line", "arrow"]);
/** Tools that always paint, even over existing shapes. */
export const PAINT_TOOLS: ReadonlySet<ToolId> = new Set(["pen", "marker", "mosaic"]);

let counter = 0;
export function newId(): string {
  counter += 1;
  return `a${Date.now().toString(36)}${counter.toString(36)}`;
}

export function boundsOf(a: Annotation): Rect {
  switch (a.kind) {
    case "rect":
    case "ellipse":
    case "highlight":
    case "pixelate":
      return { x: a.x, y: a.y, w: a.w, h: a.h };
    case "line":
    case "arrow":
    case "pen":
    case "marker":
    case "mosaic": {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < a.points.length; i += 2) {
        minX = Math.min(minX, a.points[i]);
        maxX = Math.max(maxX, a.points[i]);
        minY = Math.min(minY, a.points[i + 1]);
        maxY = Math.max(maxY, a.points[i + 1]);
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    case "text": {
      const lines = a.text.split("\n");
      const longest = Math.max(1, ...lines.map((l) => l.length));
      return { x: a.x, y: a.y, w: longest * a.fontSize * 0.6, h: lines.length * a.fontSize * 1.25 };
    }
    case "step":
    case "emoji":
      return { x: a.x - a.size / 2, y: a.y - a.size / 2, w: a.size, h: a.size };
  }
}

export function translate(a: Annotation, dx: number, dy: number): Annotation {
  switch (a.kind) {
    case "line":
    case "arrow": {
      const [x1, y1, x2, y2] = a.points;
      return { ...a, points: [x1 + dx, y1 + dy, x2 + dx, y2 + dy] };
    }
    case "pen":
    case "marker":
    case "mosaic":
      return { ...a, points: a.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)) };
    default:
      return { ...a, x: a.x + dx, y: a.y + dy };
  }
}

export function nextStepNumber(list: Annotation[]): number {
  let max = 0;
  for (const a of list) if (a.kind === "step") max = Math.max(max, a.n);
  return max + 1;
}

/** Shapes this small (in CSS px) are accidental clicks and get dropped when the drag ends. */
export function isDegenerate(a: Annotation): boolean {
  switch (a.kind) {
    case "pen":
    case "marker":
    case "mosaic":
      return a.points.length < 2;
    case "text":
      return a.text.trim().length === 0;
    case "step":
    case "emoji":
      return false;
    default: {
      const b = boundsOf(a);
      return b.w < 3 && b.h < 3;
    }
  }
}

export function contrastText(hex: string): string {
  const v = hex.replace("#", "");
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? "#111111" : "#FFFFFF";
}

export const TOOL_LABELS: Record<ToolId, { label: string; key: string }> = {
  select: { label: "Chọn / di chuyển", key: "V" },
  rect: { label: "Hình chữ nhật", key: "R" },
  ellipse: { label: "Hình elip", key: "O" },
  line: { label: "Đường thẳng", key: "L" },
  arrow: { label: "Mũi tên", key: "A" },
  pen: { label: "Bút vẽ", key: "P" },
  marker: { label: "Bút dạ quang", key: "H" },
  text: { label: "Văn bản", key: "T" },
  mosaic: { label: "Làm mờ (mosaic)", key: "M" },
  step: { label: "Đánh số bước", key: "N" },
  emoji: { label: "Emoji", key: "E" },
};
