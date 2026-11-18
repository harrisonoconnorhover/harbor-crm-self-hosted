import { z } from "zod";

export const stageColorOptions = [
  { value: "teal", label: "Teal", hex: "#438c94" },
  { value: "blue", label: "Blue", hex: "#5088c2" },
  { value: "purple", label: "Purple", hex: "#9274bb" },
  { value: "pink", label: "Pink", hex: "#bd729b" },
  { value: "red", label: "Red", hex: "#c76868" },
  { value: "orange", label: "Orange", hex: "#d28b47" },
  { value: "green", label: "Green", hex: "#5ead83" },
  { value: "gray", label: "Gray", hex: "#81909d" },
] as const;
export const stageColorsSchema = z.record(z.string(), z.enum(["teal", "blue", "purple", "pink", "red", "orange", "green", "gray"]));
export type StageColors = z.infer<typeof stageColorsSchema>;
export type StageColor = StageColors[string];
export function stageColorHex(color: StageColor | undefined, outcome: "open" | "won" | "lost") {
  return stageColorOptions.find(option => option.value === color)?.hex ??
    (outcome === "won" ? "#5ead83" : outcome === "lost" ? "#c69188" : "#8bbac0");
}
