import { create } from "zustand";
import {
  DEFAULT_STYLE,
  type Annotation,
  type DrawStyle,
  type ToolId,
} from "../lib/annotations";
import type { Point, Rect } from "../lib/geometry";
import type { CaptureMode } from "../lib/platform";
import type { Space } from "./space";

export type Phase = "loading" | "selecting" | "editing";

/** The part of the overlay state that is mirrored across all monitors' overlays. */
export interface SharedDoc {
  phase: "selecting" | "editing";
  selection: Rect | null;
  annotations: Annotation[];
  tool: ToolId;
  style: DrawStyle;
  aiOpen: boolean;
  past?: Annotation[][];
  future?: Annotation[][];
}

export interface FrameInfo {
  sessionId: number;
  /** What to do once a region is selected (open AI chat, extract text, or nothing). */
  mode: CaptureMode;
  bitmap: ImageBitmap;
  data: Uint8ClampedArray;
  /** Image size in physical pixels. */
  width: number;
  height: number;
  /** Overlay size in CSS pixels. */
  cssWidth: number;
  cssHeight: number;
  /** Physical pixels per CSS pixel. */
  scale: number;
  /** CSS-sized pixelated copy of the screen, used as the source for mosaic shapes. */
  pixelCanvas: HTMLCanvasElement;
}

export interface WindowRect extends Rect {
  title: string;
  app: string;
}

const HISTORY_LIMIT = 100;

interface OverlayState {
  monitor: number;
  phase: Phase;
  frame: FrameInfo | null;
  /** Where this overlay sits in the desktop; null until the first capture loads. */
  space: Space | null;
  windows: WindowRect[];
  hover: WindowRect | null;
  cursor: Point | null;
  selection: Rect | null;
  tool: ToolId;
  style: DrawStyle;
  annotations: Annotation[];
  past: Annotation[][];
  future: Annotation[][];
  selectedId: string | null;
  editingTextId: string | null;
  aiOpen: boolean;
  toast: { id: number; text: string } | null;
  /** Where the toolbar + options currently sit, so side panels can avoid covering them. */
  toolbarRect: Rect | null;

  init(monitor: number): void;
  setToolbarRect(r: Rect | null): void;
  setFrame(frame: FrameInfo, space: Space): void;
  /** Applies a document received from another monitor (already converted to local coordinates). */
  applyRemote(doc: SharedDoc): void;
  clearFrame(): void;
  setPhase(phase: Phase): void;
  setWindows(windows: WindowRect[]): void;
  setHover(hover: WindowRect | null): void;
  setCursor(p: Point | null): void;
  setSelection(r: Rect | null): void;
  setTool(tool: ToolId): void;
  setStyle(patch: Partial<DrawStyle>): void;
  /** Saves the current annotations so the next change can be undone. */
  checkpoint(): void;
  /** Discards the last checkpoint (for gestures that ended up changing nothing). */
  dropCheckpoint(): void;
  /** Replaces annotations without touching history (used during a drag). */
  setAnnotations(list: Annotation[]): void;
  addAnnotations(list: Annotation[]): void;
  updateAnnotation(id: string, fn: (a: Annotation) => Annotation, record?: boolean): void;
  removeAnnotations(ids: string[]): void;
  undo(): void;
  redo(): void;
  select(id: string | null): void;
  editText(id: string | null): void;
  setAiOpen(open: boolean): void;
  /** Switches what the selection is for (for example from annotating to recording). */
  setMode(mode: CaptureMode): void;
  showToast(text: string): void;
}

/** Applies the parts of a style change that make sense for an existing annotation. */
function restyle(a: Annotation, patch: Partial<DrawStyle>): Annotation {
  let next: Annotation = a;
  if (patch.color && a.kind !== "pixelate" && a.kind !== "mosaic" && a.kind !== "emoji") next = { ...next, color: patch.color };
  if (patch.strokeWidth !== undefined) {
    if (next.kind === "step") next = { ...next, size: 16 + patch.strokeWidth * 2.5 };
    else if (next.kind === "emoji") next = { ...next, size: 20 + patch.strokeWidth * 4 };
    else if (next.kind !== "text") next = { ...next, strokeWidth: patch.strokeWidth };
  }
  if (patch.fontSize !== undefined && next.kind === "text") next = { ...next, fontSize: patch.fontSize };
  if (patch.textBackground !== undefined && next.kind === "text") next = { ...next, background: patch.textBackground };
  if (patch.filled !== undefined && (next.kind === "rect" || next.kind === "ellipse")) next = { ...next, filled: patch.filled };
  if (patch.emoji && next.kind === "emoji") next = { ...next, char: patch.emoji };
  return next;
}

export const useOverlay = create<OverlayState>((set, get) => ({
  monitor: 0,
  phase: "loading",
  frame: null,
  space: null,
  windows: [],
  hover: null,
  cursor: null,
  selection: null,
  tool: "select",
  style: DEFAULT_STYLE,
  annotations: [],
  past: [],
  future: [],
  selectedId: null,
  editingTextId: null,
  aiOpen: false,
  toast: null,
  toolbarRect: null,

  init: (monitor) => set({ monitor }),

  setToolbarRect: (r) => {
    const cur = get().toolbarRect;
    if (cur && r && cur.x === r.x && cur.y === r.y && cur.w === r.w && cur.h === r.h) return;
    set({ toolbarRect: r });
  },

  applyRemote: (doc) =>
    set((s) => ({
      phase: doc.phase,
      selection: doc.selection,
      annotations: doc.annotations,
      tool: doc.tool,
      style: doc.style,
      aiOpen: doc.aiOpen,
      ...(doc.past ? { past: doc.past } : {}),
      ...(doc.future ? { future: doc.future } : {}),
      hover: doc.selection ? null : s.hover,
      selectedId: s.selectedId && doc.annotations.some((a) => a.id === s.selectedId) ? s.selectedId : null,
    })),

  setFrame: (frame, space) => {
    get().frame?.bitmap.close();
    set({
      frame,
      space,
      phase: "selecting",
      windows: [],
      hover: null,
      selection: null,
      tool: "select",
      annotations: [],
      past: [],
      future: [],
      selectedId: null,
      editingTextId: null,
      aiOpen: false,
      toast: null,
    });
  },

  clearFrame: () => {
    get().frame?.bitmap.close();
    set({ frame: null, phase: "loading", annotations: [], past: [], future: [], selection: null, aiOpen: false });
  },

  setPhase: (phase) => set({ phase }),
  setWindows: (windows) => set({ windows }),
  setHover: (hover) => set({ hover }),
  setCursor: (cursor) => set({ cursor }),
  setSelection: (selection) => set({ selection }),

  setTool: (tool) =>
    set((s) => ({ tool, selectedId: tool === "select" ? s.selectedId : null })),

  setStyle: (patch) => {
    const { selectedId, annotations } = get();
    set((s) => ({ style: { ...s.style, ...patch } }));
    if (!selectedId) return;
    const target = annotations.find((a) => a.id === selectedId);
    if (!target) return;
    const next = restyle(target, patch);
    if (next !== target) get().updateAnnotation(selectedId, () => next, true);
  },

  checkpoint: () =>
    set((s) => ({ past: [...s.past.slice(-HISTORY_LIMIT + 1), s.annotations], future: [] })),

  dropCheckpoint: () => set((s) => ({ past: s.past.slice(0, -1) })),

  setAnnotations: (annotations) => set({ annotations }),

  addAnnotations: (list) => {
    get().checkpoint();
    set((s) => ({ annotations: [...s.annotations, ...list] }));
  },

  updateAnnotation: (id, fn, record = false) => {
    if (record) get().checkpoint();
    set((s) => ({ annotations: s.annotations.map((a) => (a.id === id ? fn(a) : a)) }));
  },

  removeAnnotations: (ids) => {
    const drop = new Set(ids);
    if (!get().annotations.some((a) => drop.has(a.id))) return;
    get().checkpoint();
    set((s) => ({
      annotations: s.annotations.filter((a) => !drop.has(a.id)),
      selectedId: s.selectedId && drop.has(s.selectedId) ? null : s.selectedId,
    }));
  },

  undo: () =>
    set((s) => {
      if (s.past.length === 0) return s;
      const prev = s.past[s.past.length - 1];
      return {
        annotations: prev,
        past: s.past.slice(0, -1),
        future: [s.annotations, ...s.future],
        selectedId: null,
        editingTextId: null,
      };
    }),

  redo: () =>
    set((s) => {
      if (s.future.length === 0) return s;
      const [next, ...rest] = s.future;
      return {
        annotations: next,
        past: [...s.past, s.annotations],
        future: rest,
        selectedId: null,
        editingTextId: null,
      };
    }),

  select: (selectedId) => {
    set({ selectedId });
    if (!selectedId) return;
    // Reflect the selected shape's style in the options bar so tweaks apply to it.
    const a = get().annotations.find((x) => x.id === selectedId);
    if (!a) return;
    set((s) => ({
      style: {
        ...s.style,
        color: a.color,
        ...(a.kind === "text" ? { fontSize: a.fontSize, textBackground: a.background } : {}),
        ...(a.kind === "rect" || a.kind === "ellipse" ? { filled: !!a.filled } : {}),
        ...(a.kind !== "text" && a.kind !== "step" && a.kind !== "emoji" ? { strokeWidth: a.strokeWidth } : {}),
      },
    }));
  },

  editText: (editingTextId) => set({ editingTextId, selectedId: null }),

  setAiOpen: (aiOpen) => set({ aiOpen }),

  setMode: (mode) =>
    set((s) => {
      if (!s.frame) return s;
      const recording = mode === "record" || mode === "gif";
      // Annotations are not part of a recording, so a record selection starts clean.
      return {
        frame: { ...s.frame, mode },
        ...(recording
          ? { annotations: [], past: [], future: [], selectedId: null, editingTextId: null, aiOpen: false, tool: "select" as const }
          : {}),
      };
    }),

  showToast: (text) => {
    const id = Date.now();
    set({ toast: { id, text } });
    window.setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null });
    }, 1800);
  },
}));
