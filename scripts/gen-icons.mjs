// Generates Shotvera's own icon artwork (no third-party assets):
//   src-tauri/icons/source.png  1024x1024 app icon (feed it to `npx tauri icon`)
//   src-tauri/icons/tray.png    44x44 monochrome template icon for the macOS menu bar / tray
// Usage: node scripts/gen-icons.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width, height, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Rasterizes `shade(u, v) -> [r,g,b,a] | null` (u, v in 0..1) with S×S supersampling. */
function render(size, shade, S = 4) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const c = shade((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
          if (!c) continue;
          const ca = c[3] / 255;
          r += c[0] * ca;
          g += c[1] * ca;
          b += c[2] * ca;
          a += ca;
        }
      }
      const i = (y * size + x) * 4;
      const n = S * S;
      out[i + 3] = Math.round((a / n) * 255);
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
    }
  }
  return out;
}

const insideRoundRect = (u, v, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(u, x0 + r), x1 - r);
  const cy = Math.min(Math.max(v, y0 + r), y1 - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
};

/** Four L-shaped viewfinder brackets around the center. */
function insideBrackets(u, v, inner, outer, arm, thick) {
  const du = Math.abs(u - 0.5);
  const dv = Math.abs(v - 0.5);
  const onOuterV = du >= inner && du <= outer && dv >= outer - arm && dv <= outer;
  const onOuterH = dv >= inner && dv <= outer && du >= outer - arm && du <= outer;
  return (onOuterV && du >= outer - thick) || (onOuterH && dv >= outer - thick);
}

/** A four-point sparkle centered at (cx, cy). */
const insideSparkle = (u, v, cx, cy, R) => Math.sqrt(Math.abs(u - cx) / R) + Math.sqrt(Math.abs(v - cy) / R) <= 1;

function appIcon(u, v) {
  const m = 0.1; // macOS-style margin around the squircle
  if (!insideRoundRect(u, v, m, m, 1 - m, 1 - m, 0.19)) return null;
  if (insideBrackets(u, v, 0.15, 0.27, 0.11, 0.045)) return [255, 255, 255, 255];
  if (insideSparkle(u, v, 0.5, 0.5, 0.15)) return [255, 255, 255, 255];
  if (insideSparkle(u, v, 0.615, 0.385, 0.05)) return [255, 255, 255, 235];
  const t = Math.min(1, Math.max(0, (u + v - 2 * m) / (2 - 4 * m)));
  const from = [139, 92, 246];
  const to = [61, 155, 255];
  return [0, 1, 2].map((i) => Math.round(from[i] + (to[i] - from[i]) * t)).concat(255);
}

/**
 * Menu-bar template icon, designed on the 36 px grid macOS uses for an 18 pt @2x status item:
 * four rounded viewfinder corners (1.5 pt strokes, pixel-aligned) around a solid AI sparkle.
 * macOS tints template images itself (white on dark menu bars, black on light ones).
 */
const TRAY = 36;
function trayIcon(u, v) {
  const x = u * TRAY;
  const y = v * TRAY;
  const ring =
    insideRoundRect(x, y, 2, 3, 34, 33, 7) && !insideRoundRect(x, y, 5, 6, 31, 30, 4);
  const corner = (x < 12 || x > 24) && (y < 12 || y > 24);
  if (ring && corner) return [0, 0, 0, 255];
  // Fuller than the app icon's sparkle so it stays legible at 18 pt.
  const R = 8.6;
  const e = 0.62;
  if ((Math.abs(x - 18) / R) ** e + (Math.abs(y - 18) / R) ** e <= 1) return [0, 0, 0, 255];
  return null;
}

mkdirSync("src-tauri/icons", { recursive: true });
writeFileSync("src-tauri/icons/source.png", png(1024, 1024, render(1024, appIcon)));
writeFileSync("src-tauri/icons/tray.png", png(TRAY, TRAY, render(TRAY, trayIcon, 8)));
console.log("wrote src-tauri/icons/source.png and src-tauri/icons/tray.png");
