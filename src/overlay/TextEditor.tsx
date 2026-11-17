import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { contrastText, type TextAnnotation } from "../lib/annotations";
import { useOverlay } from "./store";

const FONT = '600 {size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif';

function measure(text: string, fontSize: number): { w: number; h: number } {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = FONT.replace("{size}", String(fontSize));
  const lines = (text || " ").split("\n");
  const w = Math.max(...lines.map((l) => ctx.measureText(l || " ").width));
  return { w: Math.ceil(w) + fontSize, h: Math.ceil(lines.length * fontSize * 1.0) };
}

/** In-place editor for a text annotation. Commits on blur, Esc or ⌘/Ctrl+Enter. */
export function TextEditor() {
  const editingId = useOverlay((s) => s.editingTextId);
  const annotation = useOverlay((s) => s.annotations.find((a) => a.id === s.editingTextId)) as TextAnnotation | undefined;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(annotation?.text ?? "");

  useEffect(() => {
    setValue(annotation?.text ?? "");
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    // Only when a different annotation starts editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  const size = annotation ? measure(value, annotation.fontSize) : { w: 0, h: 0 };
  useLayoutEffect(() => {
    if (ref.current) ref.current.style.height = `${size.h}px`;
  }, [size.h]);

  if (!annotation) return null;

  const commit = () => {
    const st = useOverlay.getState();
    if (st.editingTextId !== annotation.id) return;
    if (value.trim().length === 0) {
      st.setAnnotations(st.annotations.filter((a) => a.id !== annotation.id));
    } else {
      st.updateAnnotation(annotation.id, (a) => (a.kind === "text" ? { ...a, text: value } : a));
    }
    st.editText(null);
  };

  const pad = annotation.background ? Math.round(annotation.fontSize * 0.3) : 2;
  return (
    <textarea
      ref={ref}
      className="text-editor"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          commit();
        }
      }}
      style={{
        left: annotation.x,
        top: annotation.y,
        width: size.w + pad * 2,
        padding: pad,
        fontSize: annotation.fontSize,
        lineHeight: 1,
        color: annotation.background ? contrastText(annotation.color) : annotation.color,
        background: annotation.background ? annotation.color : "rgba(0,0,0,0.18)",
        borderRadius: annotation.background ? Math.max(3, annotation.fontSize * 0.2) : 4,
      }}
    />
  );
}
