/**
 * Draws a fake desktop so the overlay, editor and AI panel can be developed and tested in a plain
 * browser (`npm run dev`) without the Rust backend or screen-recording permission.
 */
export interface MockWindow {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  app: string;
}

export function renderMockDesktop(width: number, height: number, scale: number, variant = 0) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  const W = width / scale;
  const H = height / scale;

  if (variant !== 0) return renderSecondMonitor(canvas, ctx, W, H, scale);

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#1e3a8a");
  bg.addColorStop(0.55, "#6d28d9");
  bg.addColorStop(1, "#db2777");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Menu bar
  ctx.fillStyle = "rgba(20,20,24,0.55)";
  ctx.fillRect(0, 0, W, 26);
  ctx.fillStyle = "#fff";
  ctx.font = "600 13px -apple-system, Segoe UI, sans-serif";
  ctx.fillText("Finder   File   Edit   View   Go   Window   Help", 16, 17);
  ctx.textAlign = "right";
  ctx.fillText("Thứ Hai 16 thg 11  10:42", W - 16, 17);
  ctx.textAlign = "left";

  const windows: MockWindow[] = [];
  const win = (x: number, y: number, w: number, h: number, title: string, app: string, body: (cx: number, cy: number) => void) => {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 12;
    ctx.fillStyle = "#ffffff";
    roundRect(ctx, x, y, w, h, 12);
    ctx.fill();
    ctx.restore();
    ctx.save();
    roundRect(ctx, x, y, w, h, 12);
    ctx.clip();
    ctx.fillStyle = "#f3f4f6";
    ctx.fillRect(x, y, w, 36);
    ["#ff5f57", "#febc2e", "#28c840"].forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(x + 18 + i * 20, y + 18, 6, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = "#374151";
    ctx.font = "600 13px -apple-system, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(title, x + w / 2, y + 23);
    ctx.textAlign = "left";
    body(x, y + 36);
    ctx.restore();
    windows.push({ x: x * scale, y: y * scale, w: w * scale, h: h * scale, title, app });
  };

  // Order matters: later windows are on top; the list is reversed at the end so it runs front-to-back.
  win(W * 0.05, H * 0.12, Math.min(620, W * 0.42), Math.min(430, H * 0.55), "main.rs — shotvera", "Code", (cx, cy) => {
    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(cx, cy, 2000, 2000);
    ctx.font = "14px Menlo, Consolas, monospace";
    const lines: [string, string][] = [
      ["#c586c0", "fn main() {"],
      ["#9cdcfe", "    let shots = capture_all_monitors()?;"],
      ["#9cdcfe", "    for shot in shots.iter() {"],
      ["#dcdcaa", "        overlay::show(shot);"],
      ["#9cdcfe", "    }"],
      ["#6a9955", "    // TODO: handle permission denied on macOS"],
      ["#ce9178", "    println!(\"captured {} screens\", shots.len());"],
      ["#c586c0", "}"],
    ];
    lines.forEach(([c, t], i) => {
      ctx.fillStyle = "#6b7280";
      ctx.fillText(String(i + 1).padStart(2, " "), cx + 14, cy + 28 + i * 22);
      ctx.fillStyle = c;
      ctx.fillText(t, cx + 48, cy + 28 + i * 22);
    });
  });

  win(W * 0.4, H * 0.22, Math.min(560, W * 0.4), Math.min(470, H * 0.62), "Đăng ký tài khoản — Safari", "Safari", (cx, cy) => {
    ctx.fillStyle = "#111827";
    ctx.font = "700 22px -apple-system, Segoe UI, sans-serif";
    ctx.fillText("Tạo tài khoản mới", cx + 32, cy + 48);
    const field = (label: string, value: string, y: number) => {
      ctx.fillStyle = "#6b7280";
      ctx.font = "13px -apple-system, Segoe UI, sans-serif";
      ctx.fillText(label, cx + 32, cy + y);
      ctx.strokeStyle = "#d1d5db";
      ctx.lineWidth = 1;
      roundRect(ctx, cx + 32, cy + y + 8, 380, 38, 8);
      ctx.stroke();
      ctx.fillStyle = "#111827";
      ctx.font = "15px -apple-system, Segoe UI, sans-serif";
      ctx.fillText(value, cx + 44, cy + y + 33);
    };
    field("Họ và tên", "Nguyễn Văn An", 90);
    field("Email", "nguyenvanan@example.com", 160);
    field("Số điện thoại", "0912 345 678", 230);
    ctx.fillStyle = "#2563eb";
    roundRect(ctx, cx + 32, cy + 310, 160, 42, 10);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "600 15px -apple-system, Segoe UI, sans-serif";
    ctx.fillText("Đăng ký", cx + 82, cy + 337);
    ctx.fillStyle = "#dc2626";
    ctx.font = "13px -apple-system, Segoe UI, sans-serif";
    ctx.fillText("Mật khẩu phải có ít nhất 8 ký tự", cx + 32, cy + 380);
  });

  // Dock
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  roundRect(ctx, W / 2 - 220, H - 70, 440, 58, 18);
  ctx.fill();
  ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"].forEach((c, i) => {
    ctx.fillStyle = c;
    roundRect(ctx, W / 2 - 200 + i * 68, H - 62, 44, 44, 11);
    ctx.fill();
  });

  return { canvas, windows: windows.reverse() };
}

/** A second, visibly different desktop: teal wallpaper and a chat window near its left edge. */
function renderSecondMonitor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, W: number, H: number, scale: number) {
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#065f46");
  bg.addColorStop(1, "#0e7490");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const x = 20;
  const y = H * 0.18;
  const w = Math.min(520, W * 0.45);
  const h = Math.min(420, H * 0.6);
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, x, y, w, h, 12);
  ctx.fill();
  ctx.fillStyle = "#f3f4f6";
  ctx.fillRect(x, y, w, 36);
  ctx.fillStyle = "#374151";
  ctx.font = "600 13px -apple-system, Segoe UI, sans-serif";
  ctx.fillText("Messages — Lan", x + 16, y + 23);
  const bubbles: [string, boolean][] = [
    ["Gửi mình ảnh lỗi đăng ký nhé", false],
    ["Đây, nút Đăng ký không bấm được", true],
    ["Mật khẩu của mình là hunter2 😅", true],
  ];
  bubbles.forEach(([t, mine], i) => {
    ctx.font = "15px -apple-system, Segoe UI, sans-serif";
    const tw = ctx.measureText(t).width + 24;
    const bx = mine ? x + w - tw - 16 : x + 16;
    const by = y + 60 + i * 56;
    ctx.fillStyle = mine ? "#2563eb" : "#e5e7eb";
    roundRect(ctx, bx, by, tw, 38, 18);
    ctx.fill();
    ctx.fillStyle = mine ? "#fff" : "#111827";
    ctx.fillText(t, bx + 12, by + 24);
  });
  return { canvas, windows: [{ x: x * scale, y: y * scale, w: w * scale, h: h * scale, title: "Lan", app: "Messages" }] };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
