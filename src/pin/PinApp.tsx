import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Copy, Download, X } from "lucide-react";
import { copyImage, loadPin, saveAs, type PinMeta } from "../lib/platform";

/** Always-on-top window showing a pinned screenshot. Drag to move, scroll to zoom, double-click to close. */
export function PinApp({ id }: { id: string }) {
  const [pin, setPin] = useState<{ meta: PinMeta; bitmap: ImageBitmap; image: ImageData } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [flash, setFlash] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    void loadPin(id).then(setPin);
  }, [id]);

  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c || !pin) return;
    c.width = pin.meta.width;
    c.height = pin.meta.height;
    c.getContext("2d")!.drawImage(pin.bitmap, 0, 0);
  }, [pin]);

  useEffect(() => {
    if (!pin) return;
    void getCurrentWindow().setSize(new LogicalSize(Math.round(pin.meta.cssWidth * zoom), Math.round(pin.meta.cssHeight * zoom)));
  }, [zoom, pin]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void getCurrentWindow().close();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") void doCopy();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const notify = (text: string) => {
    setFlash(text);
    window.setTimeout(() => setFlash(null), 1200);
  };
  const doCopy = async () => {
    if (!pin) return;
    await copyImage(pin.image);
    notify("Đã sao chép");
  };
  const doSave = async () => {
    if (!pin) return;
    const win = getCurrentWindow();
    await win.setAlwaysOnTop(false);
    try {
      const path = await saveAs(pin.image);
      if (path) notify("Đã lưu");
    } finally {
      await win.setAlwaysOnTop(true);
    }
  };

  if (!pin) return null;

  return (
    <div
      className="pin-root"
      onMouseDown={(e) => {
        if (e.button === 0 && !(e.target as HTMLElement).closest("button")) void getCurrentWindow().startDragging();
      }}
      onDoubleClick={() => void getCurrentWindow().close()}
      onWheel={(e) => setZoom((z) => Math.min(5, Math.max(0.2, z * (e.deltaY > 0 ? 0.92 : 1.08))))}
    >
      <canvas ref={canvas} className="pin-canvas" />
      <div className="pin-bar">
        <button onClick={() => void doCopy()} data-tip="Sao chép">
          <Copy size={14} />
        </button>
        <button onClick={() => void doSave()} data-tip="Lưu">
          <Download size={14} />
        </button>
        <button onClick={() => setZoom(1)} className="pin-zoom">
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={() => void getCurrentWindow().close()} data-tip="Đóng (Esc)">
          <X size={14} />
        </button>
      </div>
      {flash && <div className="pin-flash">{flash}</div>}
    </div>
  );
}
