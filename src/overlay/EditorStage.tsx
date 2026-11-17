import { useEffect, useRef } from "react";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import {
  Arrow,
  Circle,
  Ellipse,
  Group,
  Label,
  Layer,
  Line,
  Rect as KRect,
  Shape,
  Stage,
  Tag,
  Text,
  Transformer,
} from "react-konva";
import {
  PAINT_TOOLS,
  contrastText,
  isDegenerate,
  newId,
  nextStepNumber,
  translate,
  type Annotation,
  type AnnotationKind,
  type TextAnnotation,
} from "../lib/annotations";
import { clamp, containsPoint, distance, rectFromPoints, type Point, type Rect } from "../lib/geometry";
import { followGlobalPointer } from "../lib/platform";
import { desktopBoundsLocal } from "./space";
import { useOverlay, type WindowRect } from "./store";

type Gesture =
  | { kind: "select"; start: Point; moved: boolean }
  | { kind: "moveSelection"; start: Point; rect: Rect }
  | { kind: "draw"; id: string; start: Point };

const TRANSFORMABLE: ReadonlySet<AnnotationKind> = new Set([
  "rect",
  "ellipse",
  "highlight",
  "pixelate",
  "text",
  "step",
  "emoji",
]);
const KEEP_RATIO: ReadonlySet<AnnotationKind> = new Set(["text", "step", "emoji"]);
const ACCENT = "#3d9bff";

/** Rendered stroke width for kinds that scale the user's size setting. */
export function renderedWidth(a: Annotation): number {
  if (a.kind === "marker") return a.strokeWidth * 3 + 6;
  if (a.kind === "mosaic") return a.strokeWidth * 3 + 10;
  return a.strokeWidth;
}

interface Props {
  onDoubleClickInside(): void;
}

/** Keeps `r` inside `bounds` by moving it (bounds may start at negative coordinates). */
function clampRectTo(r: Rect, bounds: Rect): Rect {
  const w = Math.min(r.w, bounds.w);
  const h = Math.min(r.h, bounds.h);
  return {
    x: clamp(r.x, bounds.x, bounds.x + bounds.w - w),
    y: clamp(r.y, bounds.y, bounds.y + bounds.h - h),
    w,
    h,
  };
}

export function EditorStage({ onDoubleClickInside }: Props) {
  const frame = useOverlay((s) => s.frame)!;
  const space = useOverlay((s) => s.space)!;
  const phase = useOverlay((s) => s.phase);
  const selection = useOverlay((s) => s.selection);
  const tool = useOverlay((s) => s.tool);
  const annotations = useOverlay((s) => s.annotations);
  const selectedId = useOverlay((s) => s.selectedId);
  const editingTextId = useOverlay((s) => s.editingTextId);

  const stage = useRef<Konva.Stage>(null);
  const transformer = useRef<Konva.Transformer>(null);
  const gesture = useRef<Gesture | null>(null);

  const selected = annotations.find((a) => a.id === selectedId) ?? null;

  useEffect(() => {
    const tr = transformer.current;
    if (!tr) return;
    const node = selected && TRANSFORMABLE.has(selected.kind) ? stage.current?.findOne(`#${selected.id}-body`) : null;
    tr.nodes(node ? [node] : []);
    tr.keepRatio(!!selected && KEEP_RATIO.has(selected.kind));
    tr.enabledAnchors(
      selected && KEEP_RATIO.has(selected.kind)
        ? ["top-left", "top-right", "bottom-left", "bottom-right"]
        : ["top-left", "top-center", "top-right", "middle-right", "bottom-right", "bottom-center", "bottom-left", "middle-left"],
    );
    tr.getLayer()?.batchDraw();
  }, [selected]);

  const snap = (v: number) => Math.round(v * frame.scale) / frame.scale;
  const snapRect = (r: Rect): Rect => {
    const x = snap(r.x);
    const y = snap(r.y);
    return { x, y, w: snap(r.x + r.w) - x, h: snap(r.y + r.h) - y };
  };
  // Selections may extend onto other monitors, so they are clamped to the whole desktop.
  const desktop = desktopBoundsLocal(space);
  const fullScreen: WindowRect = { x: 0, y: 0, w: frame.cssWidth, h: frame.cssHeight, title: "", app: "" };
  const pointer = (): Point => stage.current?.getPointerPosition() ?? { x: 0, y: 0 };

  // While a gesture runs, also follow the OS pointer so it continues on other monitors.
  const stopFollowing = useRef<(() => void) | null>(null);
  const lastShift = useRef(false);
  const beginGesture = (g: Gesture) => {
    gesture.current = g;
    stopFollowing.current?.();
    stopFollowing.current = followGlobalPointer(
      (gx, gy) => {
        const sp = useOverlay.getState().space;
        if (!sp) return;
        const k = sp.cssPerNative;
        moveRef.current({ x: (gx - sp.self.x) * k, y: (gy - sp.self.y) * k }, lastShift.current);
      },
      () => endRef.current(),
    );
  };

  const setCursor = (c: string) => {
    const el = stage.current?.container();
    if (el && el.style.cursor !== c) el.style.cursor = c;
  };

  const onMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0) return;
    const st = useOverlay.getState();
    const p = pointer();

    if (st.phase === "selecting") {
      beginGesture({ kind: "select", start: p, moved: false });
      return;
    }
    if (st.phase !== "editing" || !st.selection || st.editingTextId) return;

    const onEmpty = e.target === e.target.getStage();
    const inside = containsPoint(st.selection, p);

    if (st.tool === "select") {
      if (!onEmpty) return; // Konva drags the shape itself.
      st.select(null);
      if (inside) {
        beginGesture({ kind: "moveSelection", start: p, rect: st.selection });
      } else if (st.annotations.length === 0) {
        st.setSelection(null);
        st.setPhase("selecting");
        beginGesture({ kind: "select", start: p, moved: false });
      }
      return;
    }

    if (!inside) return;
    if (!onEmpty && !PAINT_TOOLS.has(st.tool)) return; // grabbing an existing shape
    st.select(null);

    const { style } = st;
    const base = { id: newId(), color: style.color, strokeWidth: style.strokeWidth, source: "user" as const };
    let created: Annotation | null = null;
    switch (st.tool) {
      case "rect":
      case "ellipse":
        created = { ...base, kind: st.tool, x: p.x, y: p.y, w: 0, h: 0, filled: style.filled };
        break;
      case "mosaic":
        created =
          style.mosaicMode === "rect"
            ? { ...base, kind: "pixelate", x: p.x, y: p.y, w: 0, h: 0 }
            : { ...base, kind: "mosaic", points: [p.x, p.y] };
        break;
      case "line":
      case "arrow":
        created = { ...base, kind: st.tool, points: [p.x, p.y, p.x, p.y] };
        break;
      case "pen":
      case "marker":
        created = { ...base, kind: st.tool, points: [p.x, p.y] };
        break;
      case "text": {
        const t: TextAnnotation = {
          ...base,
          kind: "text",
          x: p.x,
          y: p.y - style.fontSize * 0.6,
          text: "",
          fontSize: style.fontSize,
          background: style.textBackground,
        };
        st.addAnnotations([t]);
        st.editText(t.id);
        return;
      }
      case "step":
        st.addAnnotations([
          { ...base, kind: "step", x: p.x, y: p.y, n: nextStepNumber(st.annotations), size: 16 + style.strokeWidth * 2.5 },
        ]);
        return;
      case "emoji":
        st.addAnnotations([{ ...base, kind: "emoji", x: p.x, y: p.y, char: style.emoji, size: 20 + style.strokeWidth * 4 }]);
        return;
    }
    if (created) {
      st.addAnnotations([created]);
      beginGesture({ kind: "draw", id: created.id, start: p });
    }
  };

  // Hover feedback and cursor shape (no gesture in progress).
  const onMouseMove = (e: KonvaEventObject<MouseEvent>) => {
    if (gesture.current) return;
    const st = useOverlay.getState();
    const p = pointer();
    st.setCursor(p);
    if (st.phase === "selecting" && !st.selection) {
      st.setHover(st.windows.find((w) => containsPoint(w, p)) ?? fullScreen);
      setCursor("crosshair");
    } else if (st.phase === "editing" && st.selection) {
      const inside = containsPoint(st.selection, p);
      const onShape = e.target !== e.target.getStage();
      if (st.tool === "select") setCursor(onShape ? "move" : inside ? "move" : "default");
      else if (st.tool === "text") setCursor(inside ? "text" : "default");
      else setCursor(inside ? (onShape && !PAINT_TOOLS.has(st.tool) ? "move" : "crosshair") : "default");
    }
  };

  // Gesture updates. Window-level so a drag keeps working after the pointer leaves this
  // monitor; coordinates outside the window are simply points on a neighbouring monitor.
  const moveGesture = (p: Point, shift: boolean) => {
    const g = gesture.current;
    if (!g) return;
    const st = useOverlay.getState();
    if (g.kind === "select") {
      if (!g.moved && distance(g.start, p) < 4) return;
      g.moved = true;
      st.setHover(null);
      const end = {
        x: clamp(p.x, desktop.x, desktop.x + desktop.w),
        y: clamp(p.y, desktop.y, desktop.y + desktop.h),
      };
      st.setSelection(snapRect(rectFromPoints(g.start, end)));
      return;
    }
    if (g.kind === "moveSelection") {
      const moved = { ...g.rect, x: g.rect.x + p.x - g.start.x, y: g.rect.y + p.y - g.start.y };
      st.setSelection(snapRect(clampRectTo(moved, desktop)));
      return;
    }
    st.setAnnotations(st.annotations.map((a) => (a.id === g.id ? extend(a, g.start, p, shift) : a)));
  };
  const moveRef = useRef(moveGesture);
  moveRef.current = moveGesture;
  useEffect(() => {
    const move = (ev: MouseEvent) => {
      lastShift.current = ev.shiftKey;
      if (gesture.current) moveRef.current({ x: ev.clientX, y: ev.clientY }, ev.shiftKey);
    };
    window.addEventListener("mousemove", move);
    return () => window.removeEventListener("mousemove", move);
  }, []);

  const endGesture = () => {
    stopFollowing.current?.();
    stopFollowing.current = null;
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const st = useOverlay.getState();
    if (g.kind === "select") {
      if (!g.moved) {
        st.setSelection(snapRect(st.hover ?? fullScreen));
      } else if (!st.selection || st.selection.w < 4 || st.selection.h < 4) {
        st.setSelection(null);
        return;
      }
      st.setHover(null);
      st.setPhase("editing");
      return;
    }
    if (g.kind === "draw") {
      const a = st.annotations.find((x) => x.id === g.id);
      if (a && isDegenerate(a)) {
        st.setAnnotations(st.annotations.filter((x) => x.id !== g.id));
        st.dropCheckpoint();
      }
    }
  };

  // Mouse-up can land on DOM elements above the canvas (toolbar, labels), so listen on window.
  const endRef = useRef(endGesture);
  endRef.current = endGesture;
  useEffect(() => {
    const up = (ev: MouseEvent) => {
      if (ev.button === 0) endRef.current();
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const onDblClick = (e: KonvaEventObject<MouseEvent>) => {
    const st = useOverlay.getState();
    if (st.phase !== "editing" || !st.selection) return;
    const target = e.target;
    const id = annotationIdOf(target);
    const a = id ? st.annotations.find((x) => x.id === id) : undefined;
    if (a?.kind === "text") {
      st.checkpoint();
      st.editText(a.id);
      return;
    }
    if (target === target.getStage() && st.tool === "select" && containsPoint(st.selection, pointer())) {
      onDoubleClickInside();
    }
  };

  const interactive = phase === "editing" && !PAINT_TOOLS.has(tool) && tool !== "text";
  const clip = selection ?? { x: 0, y: 0, w: 0, h: 0 };

  return (
    <Stage
      ref={stage}
      className="konva-host"
      width={frame.cssWidth}
      height={frame.cssHeight}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onDblClick={onDblClick}
      onContextMenu={(e) => e.evt.preventDefault()}
    >
      <Layer clipX={clip.x} clipY={clip.y} clipWidth={clip.w} clipHeight={clip.h}>
        {annotations.map((a) => (
          <AnnotationView
            key={a.id}
            a={a}
            pixelSource={frame.pixelCanvas}
            interactive={interactive}
            hidden={a.id === editingTextId}
          />
        ))}
      </Layer>
      <Layer name="ui-only">
        <Transformer
          ref={transformer}
          name="ui-only"
          rotateEnabled={false}
          flipEnabled={false}
          anchorSize={9}
          anchorCornerRadius={5}
          anchorStroke={ACCENT}
          anchorFill="#ffffff"
          borderStroke={ACCENT}
          borderDash={[4, 3]}
          ignoreStroke
          boundBoxFunc={(oldBox, newBox) => (newBox.width < 6 || newBox.height < 6 ? oldBox : newBox)}
        />
        {selected && (selected.kind === "line" || selected.kind === "arrow") && interactive && (
          <LineHandles a={selected} />
        )}
      </Layer>
    </Stage>
  );
}

function annotationIdOf(node: Konva.Node): string | null {
  let n: Konva.Node | null = node;
  while (n && !n.hasName("annotation")) n = n.getParent();
  return n ? n.id() : null;
}

/** Updates a shape being drawn from its start point to `p`. Shift constrains to squares / 45° lines. */
function extend(a: Annotation, start: Point, p: Point, shift: boolean): Annotation {
  switch (a.kind) {
    case "rect":
    case "ellipse":
    case "highlight":
    case "pixelate": {
      let end = p;
      if (shift) {
        const side = Math.max(Math.abs(p.x - start.x), Math.abs(p.y - start.y));
        end = { x: start.x + Math.sign(p.x - start.x || 1) * side, y: start.y + Math.sign(p.y - start.y || 1) * side };
      }
      const r = rectFromPoints(start, end);
      return { ...a, x: r.x, y: r.y, w: r.w, h: r.h };
    }
    case "line":
    case "arrow": {
      let end = p;
      if (shift) {
        const angle = Math.round(Math.atan2(p.y - start.y, p.x - start.x) / (Math.PI / 4)) * (Math.PI / 4);
        const len = distance(start, p);
        end = { x: start.x + Math.cos(angle) * len, y: start.y + Math.sin(angle) * len };
      }
      return { ...a, points: [start.x, start.y, end.x, end.y] };
    }
    case "pen":
    case "marker":
    case "mosaic": {
      const n = a.points.length;
      const last = { x: a.points[n - 2], y: a.points[n - 1] };
      if (distance(last, p) < 1.5) return a;
      return { ...a, points: [...a.points, p.x, p.y] };
    }
    default:
      return a;
  }
}

/** A canvas pattern drawn in stage coordinates, whatever transform the shape currently has. */
function stagePattern(ctx: CanvasRenderingContext2D, shape: Konva.Shape, source: HTMLCanvasElement) {
  const pattern = ctx.createPattern(source, "no-repeat");
  if (!pattern) return null;
  const m = shape.getAbsoluteTransform().copy().invert().getMatrix();
  pattern.setTransform(new DOMMatrix(m));
  return pattern;
}

function nativeContext(ctx: Konva.Context): CanvasRenderingContext2D {
  return (ctx as unknown as { _context: CanvasRenderingContext2D })._context;
}

/**
 * One annotation as Konva nodes. `pixelSource` is a pixelated image aligned with the stage's
 * coordinates, used by mosaic shapes. Also used offscreen to render exports.
 */
export function AnnotationView({
  a,
  pixelSource,
  interactive,
  hidden,
}: {
  a: Annotation;
  pixelSource: HTMLCanvasElement;
  interactive: boolean;
  hidden: boolean;
}) {
  const actions = useOverlay.getState;
  const bodyId = `${a.id}-body`;
  const sw = renderedWidth(a);
  const hit = Math.max(14, sw + 8);

  const onTransformStart = () => actions().checkpoint();
  const onTransformEnd = (e: KonvaEventObject<Event>) => {
    const node = e.target;
    const sx = node.scaleX();
    const sy = node.scaleY();
    node.scale({ x: 1, y: 1 });
    actions().updateAnnotation(a.id, (cur) => {
      switch (cur.kind) {
        case "rect":
        case "highlight":
        case "pixelate":
          return { ...cur, x: node.x(), y: node.y(), w: Math.max(4, cur.w * sx), h: Math.max(4, cur.h * sy) };
        case "ellipse": {
          const w = Math.max(4, cur.w * sx);
          const h = Math.max(4, cur.h * sy);
          return { ...cur, x: node.x() - w / 2, y: node.y() - h / 2, w, h };
        }
        case "text":
          return { ...cur, x: node.x(), y: node.y(), fontSize: clamp(Math.round(cur.fontSize * sy), 8, 240) };
        case "step":
        case "emoji":
          return { ...cur, x: node.x(), y: node.y(), size: clamp(cur.size * sy, 12, 480) };
        default:
          return cur;
      }
    });
  };
  const transformProps = { onTransformStart, onTransformEnd };

  let body: React.ReactNode = null;
  switch (a.kind) {
    case "rect":
      body = (
        <KRect
          id={bodyId}
          x={a.x}
          y={a.y}
          width={a.w}
          height={a.h}
          stroke={a.color}
          strokeWidth={sw}
          fill={a.filled ? a.color : undefined}
          cornerRadius={3}
          hitStrokeWidth={hit}
          strokeScaleEnabled={false}
          {...transformProps}
        />
      );
      break;
    case "ellipse":
      body = (
        <Ellipse
          id={bodyId}
          x={a.x + a.w / 2}
          y={a.y + a.h / 2}
          radiusX={a.w / 2}
          radiusY={a.h / 2}
          stroke={a.color}
          strokeWidth={sw}
          fill={a.filled ? a.color : undefined}
          hitStrokeWidth={hit}
          strokeScaleEnabled={false}
          {...transformProps}
        />
      );
      break;
    case "highlight":
      body = (
        <KRect id={bodyId} x={a.x} y={a.y} width={a.w} height={a.h} fill={a.color} opacity={0.32} cornerRadius={3} {...transformProps} />
      );
      break;
    case "pixelate":
      body = (
        <Shape
          id={bodyId}
          x={a.x}
          y={a.y}
          width={a.w}
          height={a.h}
          fill="#000"
          sceneFunc={(kctx, shape) => {
            const ctx = nativeContext(kctx);
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, shape.width(), shape.height());
            ctx.clip();
            const m = shape.getAbsoluteTransform().copy().invert().getMatrix();
            ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(pixelSource, 0, 0);
            ctx.restore();
          }}
          hitFunc={(kctx, shape) => {
            kctx.beginPath();
            kctx.rect(0, 0, shape.width(), shape.height());
            kctx.closePath();
            kctx.fillStrokeShape(shape);
          }}
          {...transformProps}
        />
      );
      break;
    case "mosaic":
      body = (
        <Shape
          id={bodyId}
          stroke="#000"
          strokeWidth={sw}
          lineCap="round"
          lineJoin="round"
          sceneFunc={(kctx, shape) => {
            const ctx = nativeContext(kctx);
            const pattern = stagePattern(ctx, shape, pixelSource);
            if (!pattern) return;
            ctx.save();
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.lineWidth = sw;
            ctx.strokeStyle = pattern;
            tracePath(ctx, a.points);
            ctx.stroke();
            ctx.restore();
          }}
          hitFunc={(kctx, shape) => {
            tracePath(kctx, a.points);
            kctx.strokeShape(shape);
          }}
        />
      );
      break;
    case "line":
      body = <Line id={bodyId} points={a.points} stroke={a.color} strokeWidth={sw} lineCap="round" hitStrokeWidth={hit} />;
      break;
    case "arrow": {
      const head = 6 + sw * 2.6;
      body = (
        <Arrow
          id={bodyId}
          points={a.points}
          stroke={a.color}
          fill={a.color}
          strokeWidth={sw}
          pointerLength={head}
          pointerWidth={head}
          lineCap="round"
          lineJoin="round"
          hitStrokeWidth={hit}
        />
      );
      break;
    }
    case "pen":
      body = (
        <Line id={bodyId} points={a.points} stroke={a.color} strokeWidth={sw} tension={0.35} lineCap="round" lineJoin="round" hitStrokeWidth={hit} />
      );
      break;
    case "marker":
      body = (
        <Line id={bodyId} points={a.points} stroke={a.color} strokeWidth={sw} opacity={0.42} tension={0.25} lineCap="round" lineJoin="round" hitStrokeWidth={hit} />
      );
      break;
    case "text":
      body = a.background ? (
        <Label id={bodyId} x={a.x} y={a.y} visible={!hidden} {...transformProps}>
          <Tag fill={a.color} cornerRadius={Math.max(3, a.fontSize * 0.2)} />
          <Text text={a.text} fontSize={a.fontSize} fontStyle="600" fill={contrastText(a.color)} padding={Math.round(a.fontSize * 0.3)} fontFamily={FONT} />
        </Label>
      ) : (
        <Text
          id={bodyId}
          x={a.x}
          y={a.y}
          visible={!hidden}
          text={a.text}
          fontSize={a.fontSize}
          fontStyle="600"
          fontFamily={FONT}
          fill={a.color}
          padding={2}
          shadowColor="rgba(0,0,0,0.55)"
          shadowBlur={a.color.toUpperCase() === "#FFFFFF" ? 3 : 0}
          {...transformProps}
        />
      );
      break;
    case "step":
      body = (
        <Group id={bodyId} x={a.x} y={a.y} {...transformProps}>
          <Circle radius={a.size / 2} fill={a.color} stroke="#ffffff" strokeWidth={Math.max(1.5, a.size / 14)} shadowColor="rgba(0,0,0,0.35)" shadowBlur={4} />
          <Text
            text={String(a.n)}
            width={a.size}
            height={a.size}
            offsetX={a.size / 2}
            offsetY={a.size / 2}
            align="center"
            verticalAlign="middle"
            fontStyle="bold"
            fontFamily={FONT}
            fontSize={a.size * 0.52}
            fill={contrastText(a.color)}
          />
        </Group>
      );
      break;
    case "emoji":
      body = (
        <Text id={bodyId} x={a.x} y={a.y} offsetX={a.size / 2} offsetY={a.size / 2} text={a.char} fontSize={a.size} lineHeight={1} {...transformProps} />
      );
      break;
  }

  return (
    <Group
      id={a.id}
      name="annotation"
      listening={interactive}
      draggable={interactive}
      onMouseDown={() => {
        if (interactive) actions().select(a.id);
      }}
      onDragStart={() => {
        actions().checkpoint();
        actions().select(a.id);
      }}
      onDragEnd={(e) => {
        if (e.target.id() !== a.id) return;
        const dx = e.target.x();
        const dy = e.target.y();
        e.target.position({ x: 0, y: 0 });
        actions().updateAnnotation(a.id, (cur) => translate(cur, dx, dy));
      }}
    >
      {body}
    </Group>
  );
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif';

function tracePath(ctx: { beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void }, pts: number[]) {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  if (pts.length === 2) ctx.lineTo(pts[0] + 0.01, pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
}

function LineHandles({ a }: { a: Extract<Annotation, { kind: "line" | "arrow" }> }) {
  const [x1, y1, x2, y2] = a.points;
  const move = (index: 0 | 1) => (e: KonvaEventObject<DragEvent>) => {
    const { x, y } = e.target.position();
    useOverlay.getState().updateAnnotation(a.id, (cur) => {
      if (cur.kind !== "line" && cur.kind !== "arrow") return cur;
      const p = [...cur.points] as [number, number, number, number];
      p[index * 2] = x;
      p[index * 2 + 1] = y;
      return { ...cur, points: p };
    });
  };
  const common = {
    radius: 6,
    fill: "#ffffff",
    stroke: ACCENT,
    strokeWidth: 2,
    draggable: true,
    name: "ui-only",
    onDragStart: () => useOverlay.getState().checkpoint(),
  };
  return (
    <>
      <Circle x={x1} y={y1} {...common} onDragMove={move(0)} />
      <Circle x={x2} y={y2} {...common} onDragMove={move(1)} />
    </>
  );
}
