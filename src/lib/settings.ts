export type AiModel = "claude-opus-5-5" | "claude-sonnet-5-5" | "claude-haiku-5-5";
export type AiEffort = "low" | "medium" | "high";

export interface Settings {
  /** Accelerator string understood by tauri-plugin-global-shortcut. */
  captureShortcut: string;
  /** Absolute folder for quick saves; null means the platform default (Pictures/Shotvera). */
  saveDir: string | null;
  saveFormat: "png" | "jpg";
  launchAtLogin: boolean;
  /** Close the capture overlay after copying with the OK button. */
  closeAfterCopy: boolean;
  aiModel: AiModel;
  aiEffort: AiEffort;
}

export const DEFAULT_SETTINGS: Settings = {
  captureShortcut: "CommandOrControl+Shift+2",
  saveDir: null,
  saveFormat: "png",
  launchAtLogin: false,
  closeAfterCopy: true,
  aiModel: "claude-opus-5-5",
  aiEffort: "medium",
};

export const AI_MODELS: { id: AiModel; label: string; hint: string }[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Thông minh nhất (mặc định)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Nhanh, cân bằng" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "Nhanh nhất, rẻ nhất" },
];
