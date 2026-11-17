import Anthropic from "@anthropic-ai/sdk";
import { create } from "zustand";
import {
  boundsOf,
  newId,
  nextStepNumber,
  type Annotation,
} from "../lib/annotations";
import type { Rect } from "../lib/geometry";
import { getApiKey, loadSettings } from "../lib/platform";
import { exportComposite, toPngBase64 } from "../overlay/exportImage";
import { useOverlay } from "../overlay/store";
import { QUICK_ACTIONS, SYSTEM_PROMPT, type QuickId } from "./prompts";
import { buildTools, type AnnotationSpec, type EditorBridge } from "./tools";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type Message = Anthropic.Beta.Messages.BetaMessage;

/** Long edge of the image sent to Claude; larger screenshots are downscaled. */
const MAX_IMAGE_EDGE = 1568;

export interface ChatTool {
  kind: "tool";
  name: string;
  status: "running" | "done" | "error";
  summary?: string;
}

/** Assistant replies are an ordered list of text segments and tool calls, rendered in that order. */
export type ChatPart = { kind: "text"; text: string } | ChatTool;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** User messages only. */
  text: string;
  parts: ChatPart[];
  error?: string;
  pending?: boolean;
}

function appendText(parts: ChatPart[], delta: string): ChatPart[] {
  const last = parts[parts.length - 1];
  if (last?.kind === "text") return [...parts.slice(0, -1), { kind: "text", text: last.text + delta }];
  return [...parts, { kind: "text", text: delta }];
}

/** Maps between the image Claude saw and overlay CSS coordinates. */
interface Snapshot {
  width: number;
  height: number;
  origin: Rect;
}

interface AiState {
  messages: ChatMessage[];
  status: "idle" | "streaming";
  needsKey: boolean;
  history: MessageParam[];
  snapshot: Snapshot | null;
  controller: AbortController | null;
  reset(): void;
  setNeedsKey(v: boolean): void;
  send(text: string): Promise<void>;
  sendQuick(id: QuickId): Promise<void>;
  stop(): void;
}

function makeBridge(snap: Snapshot): EditorBridge {
  const k = snap.origin.w / snap.width; // CSS px per screenshot px
  const X = (x: number) => snap.origin.x + x * k;
  const Y = (y: number) => snap.origin.y + y * k;
  const L = (v: number) => v * k;
  return {
    add(specs: AnnotationSpec[]) {
      const st = useOverlay.getState();
      let step = nextStepNumber(st.annotations);
      const list: Annotation[] = specs.map((s) => {
        const base = { id: newId(), color: s.type === "pixelate" ? "#000000" : (s.color ?? "#FF3B30").toUpperCase(), strokeWidth: 4, source: "ai" as const };
        switch (s.type) {
          case "rectangle":
            return { ...base, kind: "rect", x: X(s.x), y: Y(s.y), w: L(s.width), h: L(s.height), filled: s.filled ?? false };
          case "ellipse":
            return { ...base, kind: "ellipse", x: X(s.x), y: Y(s.y), w: L(s.width), h: L(s.height) };
          case "highlight":
            return { ...base, color: (s.color ?? "#FFCC00").toUpperCase(), kind: "highlight", x: X(s.x), y: Y(s.y), w: L(s.width), h: L(s.height) };
          case "pixelate":
            return { ...base, kind: "pixelate", x: X(s.x), y: Y(s.y), w: L(s.width), h: L(s.height) };
          case "arrow":
          case "line":
            return { ...base, kind: s.type, points: [X(s.from_x), Y(s.from_y), X(s.to_x), Y(s.to_y)] };
          case "text":
            return {
              ...base,
              kind: "text",
              x: X(s.x),
              y: Y(s.y),
              text: s.text,
              fontSize: Math.round(Math.min(72, Math.max(11, L(s.font_size ?? 18)))),
              background: s.background ?? false,
            };
          case "step":
            return { ...base, kind: "step", x: X(s.x), y: Y(s.y), n: s.number ?? step++, size: 28 };
        }
      });
      st.addAnnotations(list);
      st.setTool("select");
      return list.map((a) => a.id);
    },
    remove(ids: string[]) {
      const before = useOverlay.getState().annotations.length;
      useOverlay.getState().removeAnnotations(ids);
      return before - useOverlay.getState().annotations.length;
    },
  };
}

function annotationContext(snap: Snapshot): string {
  const k = snap.origin.w / snap.width;
  const list = useOverlay.getState().annotations.map((a) => {
    const b = boundsOf(a);
    return {
      id: a.id,
      type: a.kind,
      x: Math.round((b.x - snap.origin.x) / k),
      y: Math.round((b.y - snap.origin.y) / k),
      width: Math.round(b.w / k),
      height: Math.round(b.h / k),
      ...(a.kind === "text" ? { text: a.text } : {}),
      by: a.source ?? "user",
    };
  });
  return `<current_annotations>${list.length ? JSON.stringify(list) : "none"}</current_annotations>`;
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIUserAbortError) return "Đã dừng.";
  if (err instanceof Anthropic.AuthenticationError) return "API key không hợp lệ. Hãy kiểm tra lại trong phần cài đặt AI.";
  if (err instanceof Anthropic.PermissionDeniedError) return "API key không có quyền dùng mô hình này.";
  if (err instanceof Anthropic.RateLimitError) return "Đang bị giới hạn tốc độ. Thử lại sau ít phút.";
  if (err instanceof Anthropic.BadRequestError) return `Yêu cầu không hợp lệ: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Không kết nối được tới Anthropic API. Kiểm tra mạng.";
  if (err instanceof Anthropic.APIError) return `Lỗi API (${err.status ?? "?"}): ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export const useAiSession = create<AiState>((set, get) => {
  const patchLast = (fn: (m: ChatMessage) => ChatMessage) =>
    set((s) => {
      const messages = [...s.messages];
      const i = messages.length - 1;
      if (i >= 0 && messages[i].role === "assistant") messages[i] = fn(messages[i]);
      return { messages };
    });

  return {
    messages: [],
    status: "idle",
    needsKey: false,
    history: [],
    snapshot: null,
    controller: null,

    reset() {
      get().controller?.abort();
      set({ messages: [], status: "idle", history: [], snapshot: null, controller: null });
    },

    setNeedsKey: (needsKey) => set({ needsKey }),

    stop() {
      get().controller?.abort();
    },

    async sendQuick(id) {
      const action = QUICK_ACTIONS.find((q) => q.id === id);
      if (action) await get().send(action.prompt);
    },

    async send(text) {
      if (get().status === "streaming" || !text.trim()) return;
      const apiKey = await getApiKey();
      if (!apiKey) {
        set({ needsKey: true });
        return;
      }
      const overlay = useOverlay.getState();
      if (!overlay.frame || !overlay.selection) return;
      const settings = await loadSettings();

      let { snapshot } = get();
      const { history } = get();
      const content: ContentBlockParam[] = [];
      if (!snapshot || history.length === 0) {
        const png = await toPngBase64(await exportComposite(true), MAX_IMAGE_EDGE);
        snapshot = { width: png.width, height: png.height, origin: { ...overlay.selection } };
        content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: png.data } });
        content.push({ type: "text", text: `Screenshot size: ${png.width}×${png.height} px.` });
      }
      content.push({ type: "text", text: `${annotationContext(snapshot)}\n\n${text}` });
      const userMessage: MessageParam = { role: "user", content };

      const controller = new AbortController();
      set((s) => ({
        status: "streaming",
        snapshot,
        controller,
        messages: [
          ...s.messages,
          { id: newId(), role: "user", text, parts: [] },
          { id: newId(), role: "assistant", text: "", parts: [], pending: true },
        ],
      }));

      const report = (name: string, summary: string, ok: boolean) =>
        patchLast((m) => {
          const parts = [...m.parts];
          const i = parts.findIndex((p) => p.kind === "tool" && p.name === name && p.status === "running");
          const entry: ChatTool = { kind: "tool", name, summary, status: ok ? "done" : "error" };
          if (i >= 0) parts[i] = entry;
          else parts.push(entry);
          return { ...m, parts };
        });

      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
      const model = settings.aiModel;
      // Server-side refusal fallback is available on Opus/Sonnet 5.5, not on Haiku.
      const fallback = model === "claude-haiku-5-5" ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

      const runner = client.beta.messages.toolRunner(
        {
          model,
          max_tokens: 16000,
          system: SYSTEM_PROMPT,
          tools: buildTools(makeBridge(snapshot), report),
          messages: [...history, userMessage],
          output_config: { effort: settings.aiEffort },
          cache_control: { type: "ephemeral" },
          stream: true,
          thread: false,
          max_iterations: 8,
          ...fallback,
        },
        { signal: controller.signal },
      );

      let last: Message | null = null;
      let completed = false;
      try {
        for await (const stream of runner) {
          stream.on("text", (delta) => patchLast((m) => ({ ...m, pending: false, parts: appendText(m.parts, delta) })));
          stream.on("streamEvent", (event) => {
            if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
              const name = event.content_block.name;
              patchLast((m) => ({ ...m, pending: false, parts: [...m.parts, { kind: "tool", name, status: "running" }] }));
            }
          });
          const message = await stream.finalMessage();
          last = message;
          if (message.stop_reason === "refusal") {
            patchLast((m) => ({ ...m, error: "Claude đã từ chối yêu cầu này." }));
            break;
          }
          if (message.stop_reason === "max_tokens" && message.content.some((b) => b.type === "tool_use")) {
            patchLast((m) => ({ ...m, error: "Phản hồi bị cắt ngắn trước khi hoàn tất thao tác. Hãy thử lại." }));
            break;
          }
          completed = message.stop_reason === "end_turn" || message.stop_reason === "stop_sequence" || message.stop_reason === "max_tokens";
        }
        if (completed && last) {
          let messages = [...runner.params.messages];
          if (messages[messages.length - 1]?.role !== "assistant") {
            messages = [...messages, { role: "assistant", content: last.content }];
          }
          set({ history: messages });
        }
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) set({ needsKey: true });
        patchLast((m) => ({ ...m, error: describeError(err) }));
      } finally {
        patchLast((m) => ({
          ...m,
          pending: false,
          parts: m.parts.map((p) => (p.kind === "tool" && p.status === "running" ? { ...p, status: "error" } : p)),
        }));
        set({ status: "idle", controller: null });
      }
    },
  };
});
