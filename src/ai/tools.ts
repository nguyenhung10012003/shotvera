import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { t } from "../i18n";

const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .optional()
  .describe("Hex color such as #FF3B30 (red, default), #FF9500, #FFCC00, #34C759, #0A84FF, #BF5AF2, #FFFFFF");

const box = {
  x: z.number().describe("Left edge, in screenshot pixels"),
  y: z.number().describe("Top edge, in screenshot pixels"),
  width: z.number().positive().describe("Width in screenshot pixels"),
  height: z.number().positive().describe("Height in screenshot pixels"),
};

const segment = {
  from_x: z.number().describe("Start x (arrow tail), in screenshot pixels"),
  from_y: z.number().describe("Start y (arrow tail), in screenshot pixels"),
  to_x: z.number().describe("End x (arrow head), in screenshot pixels"),
  to_y: z.number().describe("End y (arrow head), in screenshot pixels"),
};

export const AnnotationSpec = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rectangle"), ...box, color, filled: z.boolean().optional().describe("Solid fill instead of outline") }),
  z.object({ type: z.literal("ellipse"), ...box, color }),
  z.object({ type: z.literal("highlight"), ...box, color: color.describe("Translucent marker color, default #FFCC00") }),
  z.object({ type: z.literal("pixelate"), ...box }),
  z.object({ type: z.literal("arrow"), ...segment, color }),
  z.object({ type: z.literal("line"), ...segment, color }),
  z.object({
    type: z.literal("text"),
    x: z.number().describe("Left edge of the label, in screenshot pixels"),
    y: z.number().describe("Top edge of the label, in screenshot pixels"),
    text: z.string().min(1).max(300),
    font_size: z.number().min(8).max(96).optional().describe("Font size in screenshot pixels, default about 18"),
    color,
    background: z.boolean().optional().describe("Draw the label on a solid colored background for readability"),
  }),
  z.object({
    type: z.literal("step"),
    x: z.number().describe("Badge center x, in screenshot pixels"),
    y: z.number().describe("Badge center y, in screenshot pixels"),
    number: z.number().int().min(1).max(99).optional().describe("Badge number; defaults to the next unused number"),
    color,
  }),
]);

export type AnnotationSpec = z.infer<typeof AnnotationSpec>;

export interface EditorBridge {
  /** Adds the shapes to the editor and returns their ids, in order. */
  add(specs: AnnotationSpec[]): string[];
  /** Removes annotations by id and returns how many were removed. */
  remove(ids: string[]): number;
}

export type ToolReport = (name: string, summary: string, ok: boolean) => void;

export function buildTools(bridge: EditorBridge, report: ToolReport) {
  const addAnnotations = betaZodTool({
    name: "add_annotations",
    description:
      "Draw annotations on the user's screenshot. Call this whenever the user asks you to mark, circle, box, highlight, point at, number, label, hide, blur, redact or censor something on the screenshot. Coordinates are pixels of the attached screenshot image with the origin at the top-left. The shapes appear in the editor as normal annotations that the user can move, edit or undo.",
    inputSchema: z.object({ annotations: z.array(AnnotationSpec).min(1).max(40) }),
    eager_input_streaming: true,
    run: async ({ annotations }) => {
      const ids = bridge.add(annotations);
      report("add_annotations", t("ai.added", { count: ids.length }), true);
      return JSON.stringify({ added: ids.map((id, i) => ({ id, type: annotations[i].type })) });
    },
  });

  const removeAnnotations = betaZodTool({
    name: "remove_annotations",
    description:
      "Remove annotations from the screenshot by id. Call this when the user asks to delete, undo or redo specific marks. The ids are listed in <current_annotations> in each user message.",
    inputSchema: z.object({ ids: z.array(z.string()).min(1).max(200) }),
    eager_input_streaming: true,
    run: async ({ ids }) => {
      const removed = bridge.remove(ids);
      report("remove_annotations", t("ai.removed", { count: removed }), true);
      return JSON.stringify({ removed });
    },
  });

  return [addAnnotations, removeAnnotations];
}
