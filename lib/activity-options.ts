import {activityAssociationRulesSchema} from './activity-auto-associations';
import { z } from "zod";
import { InputError } from "./input-error";
export const callOutcomes = ["Busy", "Connected", "Left live message", "Left voicemail", "No answer", "Wrong number"] as const;
export const meetingOutcomes = ["Completed", "Canceled", "No show", "Rescheduled"] as const;
const option = z.object({ label: z.string().trim().min(1).max(50), archived: z.boolean().default(false) });
export const activityOptionsSchema = z.object({
  types: z.array(option).max(1000), callOutcomes: z.array(option).max(1000), meetingOutcomes: z.array(option).max(1000),
  revision: z.number().int().min(0),
  associations: activityAssociationRulesSchema.optional(),
});
export type ActivityOptions = z.infer<typeof activityOptionsSchema>;
export type ActivityOption = ActivityOptions["types"][number];
export const defaultActivityOptions: ActivityOptions = { revision: 0, types: [],
  callOutcomes: callOutcomes.map(label => ({ label, archived: false })),
  meetingOutcomes: meetingOutcomes.map(label => ({ label, archived: false })),
};
export const activityOptionKeys = ["types", "callOutcomes", "meetingOutcomes"] as const;
export function validateActivityOptions(next: ActivityOptions, previous: ActivityOptions) {
  for (const key of activityOptionKeys) {
    const options = next[key], labels = options.map(o => o.label.toLocaleLowerCase());
    if (new Set(labels).size !== labels.length) throw new InputError("Each list needs unique labels (ignoring capitalization).");
    if (previous[key].some(old => !options.some(o => o.label === old.label))) throw new InputError("Archive existing choices instead of removing or renaming them. History keeps its original labels.");
    const defaults = defaultActivityOptions[key].map(o => o.label);
    if (defaults.some(label => !options.some(o => o.label === label && !o.archived))) throw new InputError("Keep the default outcomes available.");
    const active = options.filter(o => !o.archived && !defaults.includes(o.label));
    if (active.length > (key === "types" ? 100 : 30)) throw new InputError("Use at most 100 active types and 30 active custom outcomes per list.");
  }
}
export function availableActivityOptions(options: ActivityOption[], retained?: string | null) {
  return options.filter(o => !o.archived || o.label === retained);
}
