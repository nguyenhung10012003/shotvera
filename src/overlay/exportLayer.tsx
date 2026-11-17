import type Konva from "konva";
import { createRoot } from "react-dom/client";
import { Layer, Stage } from "react-konva";
import type { Annotation } from "../lib/annotations";
import { AnnotationView } from "./EditorStage";

/**
 * Renders annotations into an offscreen canvas with the same components the editor uses, so the
 * exported image matches what is on screen. Coordinates are relative to the selection's top-left.
 */
export async function renderAnnotations(
  list: Annotation[],
  width: number,
  height: number,
  pixelRatio: number,
  pixelSource: HTMLCanvasElement,
): Promise<HTMLCanvasElement> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;pointer-events:none;opacity:0";
  document.body.appendChild(host);
  const root = createRoot(host);
  let stage: Konva.Stage | null = null;
  try {
    root.render(
      <Stage
        ref={(s) => {
          stage = s;
        }}
        width={width}
        height={height}
        listening={false}
      >
        <Layer>
          {list.map((a) => (
            <AnnotationView key={a.id} a={a} pixelSource={pixelSource} interactive={false} hidden={false} />
          ))}
        </Layer>
      </Stage>,
    );
    // react-konva mounts the Konva tree asynchronously; wait until every shape exists.
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 5));
      const s = stage as Konva.Stage | null;
      if (s && (s.getLayers()[0]?.getChildren().length ?? -1) === list.length) break;
    }
    const s = stage as Konva.Stage | null;
    if (!s) throw new Error("Không dựng được lớp chú thích để xuất ảnh");
    return s.toCanvas({ pixelRatio });
  } finally {
    root.unmount();
    host.remove();
  }
}
