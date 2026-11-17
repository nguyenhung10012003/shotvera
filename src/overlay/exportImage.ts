import { t } from "../i18n";
import { loadFrame } from "../lib/platform";
import { renderAnnotations } from "./exportLayer";
import { annotationToGlobal, intersect, mapAnnotation, monitorRect, rectToGlobal } from "./space";
import { useOverlay } from "./store";

/** Screens of other monitors, loaded on demand when a selection spans them. */
const otherFrames = new Map<number, { session: number; bitmap: ImageBitmap }>();

async function monitorBitmap(index: number): Promise<ImageBitmap> {
  const st = useOverlay.getState();
  const frame = st.frame!;
  if (index === st.monitor) return frame.bitmap;
  const cached = otherFrames.get(index);
  if (cached && cached.session === frame.sessionId) return cached.bitmap;
  cached?.bitmap.close();
  const loaded = await loadFrame(index);
  otherFrames.set(index, { session: frame.sessionId, bitmap: loaded.bitmap });
  return loaded.bitmap;
}

/**
 * Renders the current selection at full resolution: the captured pixels of every monitor it
 * covers, plus the annotations. Pass `withAnnotations: false` for the untouched screenshot.
 */
export async function exportComposite(withAnnotations = true): Promise<ImageData> {
  const st = useOverlay.getState();
  const { space, selection, frame } = st;
  if (!space || !selection || !frame) throw new Error(t("overlay.noSelection"));
  const sel = rectToGlobal(space, selection);

  const parts = space.layout
    .map((m) => ({ m, r: intersect(sel, monitorRect(m)) }))
    .filter((p): p is { m: (typeof space.layout)[number]; r: NonNullable<typeof p.r> } => p.r !== null);
  // Output at the sharpest resolution among the monitors the selection covers.
  const outScale = Math.max(1, ...parts.map((p) => p.m.imageWidth / p.m.width));
  const width = Math.max(1, Math.round(sel.w * outScale));
  const height = Math.max(1, Math.round(sel.h * outScale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  for (const { m, r } of parts) {
    const bitmap = await monitorBitmap(m.index);
    const s = m.imageWidth / m.width;
    ctx.drawImage(
      bitmap,
      (r.x - m.x) * s,
      (r.y - m.y) * s,
      r.w * s,
      r.h * s,
      Math.round((r.x - sel.x) * outScale),
      Math.round((r.y - sel.y) * outScale),
      Math.round(r.w * outScale),
      Math.round(r.h * outScale),
    );
  }

  const annotations = useOverlay.getState().annotations;
  if (withAnnotations && annotations.length > 0) {
    const relative = annotations.map((a) =>
      mapAnnotation(annotationToGlobal(space, a), (x) => x - sel.x, (y) => y - sel.y, (l) => l),
    );
    const pixelSource = buildPixelCanvas(canvas, sel.w, sel.h);
    const layer = await renderAnnotations(relative, sel.w, sel.h, outScale, pixelSource);
    ctx.drawImage(layer, 0, 0, width, height);
  }
  return ctx.getImageData(0, 0, width, height);
}

/** Downscales an ImageData so its long edge is at most `maxEdge`, returning a PNG base64 string. */
export async function toPngBase64(img: ImageData, maxEdge: number): Promise<{ data: string; width: number; height: number }> {
  const ratio = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * ratio));
  const height = Math.max(1, Math.round(img.height * ratio));
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext("2d")!.putImageData(img, 0, 0);
  const dst = new OffscreenCanvas(width, height);
  const ctx = dst.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, width, height);
  const blob = await dst.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return { data: btoa(binary), width, height };
}

/** Builds a pixelated copy of `source`, `cssWidth`×`cssHeight` in size, used by mosaic shapes. */
export function buildPixelCanvas(source: CanvasImageSource, cssWidth: number, cssHeight: number, block = 10): HTMLCanvasElement {
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.ceil(cssWidth / block));
  small.height = Math.max(1, Math.ceil(cssHeight / block));
  const sctx = small.getContext("2d")!;
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = "medium";
  sctx.drawImage(source, 0, 0, small.width, small.height);

  const big = document.createElement("canvas");
  big.width = Math.max(1, Math.round(cssWidth));
  big.height = Math.max(1, Math.round(cssHeight));
  const bctx = big.getContext("2d")!;
  bctx.imageSmoothingEnabled = false;
  bctx.drawImage(small, 0, 0, small.width * block, small.height * block);
  return big;
}
