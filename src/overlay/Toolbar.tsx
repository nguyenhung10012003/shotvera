import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Circle,
  Download,
  FaceSlightlySmiling,
  Grid3x3,
  Highlighter,
  ListOrdered,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Pin,
  Redo2,
  ScanText,
  Slash,
  Sparkles,
  Square,
  Trash,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { EMOJIS, PALETTE, TOOL_LABELS, type ToolId } from "../lib/annotations";
import { placeBelowOrAbove } from "../lib/geometry";
import { useOverlay } from "./store";

export type OverlayAction = "copy" | "quickSave" | "saveAs" | "pin" | "close" | "ai" | "ocr";

const MOD = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

const TOOLS: { id: ToolId; icon: ReactNode }[] = [
  { id: "select", icon: <MousePointer2 size={17} /> },
  { id: "rect", icon: <Square size={17} /> },
  { id: "ellipse", icon: <Circle size={17} /> },
  { id: "line", icon: <Slash size={17} /> },
  { id: "arrow", icon: <MoveUpRight size={17} /> },
  { id: "pen", icon: <Pencil size={17} /> },
  { id: "marker", icon: <Highlighter size={17} /> },
  { id: "text", icon: <Type size={17} /> },
  { id: "mosaic", icon: <Grid3x3 size={17} /> },
  { id: "step", icon: <ListOrdered size={17} /> },
  { id: "emoji", icon: <FaceSlightlySmiling size={17} /> },
];

export function Toolbar({ onAction }: { onAction(a: OverlayAction): void }) {
  const frame = useOverlay((s) => s.frame)!;
  const selection = useOverlay((s) => s.selection)!;
  const tool = useOverlay((s) => s.tool);
  const canUndo = useOverlay((s) => s.past.length > 0);
  const canRedo = useOverlay((s) => s.future.length > 0);
  const selectedId = useOverlay((s) => s.selectedId);
  const aiOpen = useOverlay((s) => s.aiOpen);
  const { setTool, undo, redo, removeAnnotations } = useOverlay.getState();

  const bar = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 640, h: 44 });
  const [saveMenu, setSaveMenu] = useState(false);

  useLayoutEffect(() => {
    const el = bar.current;
    if (el && (el.offsetWidth !== size.w || el.offsetHeight !== size.h)) setSize({ w: el.offsetWidth, h: el.offsetHeight });
  });

  const bounds = { w: frame.cssWidth, h: frame.cssHeight };
  const pos = placeBelowOrAbove(selection, size, bounds);
  const showOptions = tool !== "select" || !!selectedId;
  const optionsTop = pos.side === "above" ? pos.y - 50 : pos.y + size.h + 6;

  // Publish the area taken by the toolbar (and its options row) so the AI panel can stay clear of it.
  const top = showOptions ? Math.min(pos.y, optionsTop) : pos.y;
  const bottom = showOptions ? Math.max(pos.y + size.h, optionsTop + 44) : pos.y + size.h;
  useLayoutEffect(() => {
    useOverlay.getState().setToolbarRect({ x: pos.x, y: top, w: size.w, h: bottom - top });
  }, [pos.x, top, bottom, size.w]);
  useLayoutEffect(() => () => useOverlay.getState().setToolbarRect(null), []);

  return (
    <>
      <div
        ref={bar}
        className="toolbar"
        style={{ left: pos.x, top: pos.y }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`tb-btn${tool === t.id ? " active" : ""}`}
            data-tip={`${TOOL_LABELS[t.id].label} (${TOOL_LABELS[t.id].key})`}
            onClick={() => setTool(tool === t.id && t.id !== "select" ? "select" : t.id)}
          >
            {t.icon}
          </button>
        ))}
        <span className="tb-sep" />
        <button className="tb-btn" disabled={!canUndo} data-tip={`Hoàn tác (${MOD}Z)`} onClick={undo}>
          <Undo2 size={17} />
        </button>
        <button className="tb-btn" disabled={!canRedo} data-tip={`Làm lại (${MOD}⇧Z)`} onClick={redo}>
          <Redo2 size={17} />
        </button>
        {selectedId && (
          <button className="tb-btn" data-tip="Xoá hình đang chọn (Delete)" onClick={() => removeAnnotations([selectedId])}>
            <Trash size={17} />
          </button>
        )}
        <span className="tb-sep" />
        <button className={`tb-btn ai${aiOpen ? " on" : ""}`} data-tip="Hỏi AI về ảnh này (I)" onClick={() => onAction("ai")}>
          <Sparkles size={16} />
          <span>AI</span>
        </button>
        <button className="tb-btn" data-tip="Trích xuất văn bản (OCR)" onClick={() => onAction("ocr")}>
          <ScanText size={17} />
        </button>
        <button className="tb-btn" data-tip="Ghim lên màn hình (F3)" onClick={() => onAction("pin")}>
          <Pin size={17} />
        </button>
        <div className="tb-split">
          <button className="tb-btn" data-tip={`Lưu nhanh (${MOD}S)`} onClick={() => onAction("quickSave")}>
            <Download size={17} />
          </button>
          <button className="tb-btn tb-caret" onClick={() => setSaveMenu((v) => !v)}>
            <ChevronDown size={13} />
          </button>
          {saveMenu && (
            <div className="menu" onMouseLeave={() => setSaveMenu(false)}>
              <button onClick={() => onAction("quickSave")}>
                Lưu nhanh <kbd>{MOD}S</kbd>
              </button>
              <button onClick={() => onAction("saveAs")}>
                Lưu thành… <kbd>{MOD}⇧S</kbd>
              </button>
            </div>
          )}
        </div>
        <span className="tb-sep" />
        <button className="tb-btn" data-tip="Đóng (Esc)" onClick={() => onAction("close")}>
          <X size={18} />
        </button>
        <button className="tb-btn primary" data-tip={`Sao chép (${MOD}C / ${MOD}↵)`} onClick={() => onAction("copy")}>
          <Check size={18} />
        </button>
      </div>
      {showOptions && (
        <ToolOptions left={pos.x} top={optionsTop} />
      )}
    </>
  );
}

function ToolOptions({ left, top }: { left: number; top: number }) {
  const tool = useOverlay((s) => s.tool);
  const style = useOverlay((s) => s.style);
  const selected = useOverlay((s) => s.annotations.find((a) => a.id === s.selectedId));
  const setStyle = useOverlay.getState().setStyle;

  const kind = selected?.kind;
  const isText = tool === "text" || kind === "text";
  const isMosaic = tool === "mosaic" || kind === "mosaic" || kind === "pixelate";
  const isEmoji = tool === "emoji" || kind === "emoji";
  const canFill = tool === "rect" || tool === "ellipse" || kind === "rect" || kind === "ellipse";
  const showColors = !isMosaic && !isEmoji;

  return (
    <div className="options" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
      {showColors && (
        <div className="swatches">
          {PALETTE.map((c) => (
            <button
              key={c}
              className={`swatch${style.color.toUpperCase() === c ? " active" : ""}`}
              style={{ background: c }}
              onClick={() => setStyle({ color: c })}
              aria-label={c}
            />
          ))}
          <label className="swatch custom" data-tip="Màu khác">
            <input type="color" value={style.color} onChange={(e) => setStyle({ color: e.target.value.toUpperCase() })} />
          </label>
        </div>
      )}
      {isEmoji && (
        <div className="emoji-grid">
          {EMOJIS.map((e) => (
            <button key={e} className={style.emoji === e ? "active" : ""} onClick={() => setStyle({ emoji: e })}>
              {e}
            </button>
          ))}
        </div>
      )}
      {showColors && <span className="opt-sep" />}
      {isText ? (
        <label className="opt-range">
          <span>Cỡ chữ</span>
          <input type="range" min={10} max={72} value={style.fontSize} onChange={(e) => setStyle({ fontSize: Number(e.target.value) })} />
          <b>{style.fontSize}</b>
        </label>
      ) : (
        <label className="opt-range">
          <span>{isMosaic ? "Cỡ cọ" : isEmoji ? "Kích thước" : "Nét"}</span>
          <input type="range" min={1} max={24} value={style.strokeWidth} onChange={(e) => setStyle({ strokeWidth: Number(e.target.value) })} />
          <b>{style.strokeWidth}</b>
        </label>
      )}
      {canFill && (
        <div className="seg">
          <button className={!style.filled ? "on" : ""} onClick={() => setStyle({ filled: false })}>Viền</button>
          <button className={style.filled ? "on" : ""} onClick={() => setStyle({ filled: true })}>Tô đặc</button>
        </div>
      )}
      {isText && (
        <div className="seg">
          <button className={!style.textBackground ? "on" : ""} onClick={() => setStyle({ textBackground: false })}>Chữ</button>
          <button className={style.textBackground ? "on" : ""} onClick={() => setStyle({ textBackground: true })}>Có nền</button>
        </div>
      )}
      {tool === "mosaic" && (
        <div className="seg">
          <button className={style.mosaicMode === "brush" ? "on" : ""} onClick={() => setStyle({ mosaicMode: "brush" })}>Cọ</button>
          <button className={style.mosaicMode === "rect" ? "on" : ""} onClick={() => setStyle({ mosaicMode: "rect" })}>Vùng</button>
        </div>
      )}
    </div>
  );
}
