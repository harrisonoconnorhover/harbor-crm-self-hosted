import { boardAssociationSectionsSchema } from "./board-associations";
import { z } from "zod";

export const defaultCardFields = ["amount", "weightedAmount", "company", "closeDate", "owner"];
export const boardCardSettingsSchema = z.object({
  fields: z.array(z.string().min(1).max(150)).max(15)
    .refine(ids => new Set(ids).size === ids.length, "Choose each card property only once.")
    .nullable().default(null),
  associations: boardAssociationSectionsSchema,
  highlightInactive: z.boolean().default(false),
  inactivityDays: z.number().int().min(1).max(365).default(14),
  showTags: z.boolean().default(true),
  showLabels: z.boolean().default(true),
  showEmpty: z.boolean().default(true),
  showNextTask: z.boolean().default(true),
  showQuickActions: z.boolean().default(true),
}).prefault({});
export type BoardCardSettings = z.infer<typeof boardCardSettingsSchema>;
