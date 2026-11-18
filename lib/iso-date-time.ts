import {z} from "zod";

// Stored records and API callers may use minute precision or a compact offset.
const date = z.regexes.date.source.slice(1, -1);
const time = String.raw`(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?`;

export const utcDateTime = z.string().regex(new RegExp(`^${date}T${time}Z$`), "Invalid datetime");
export const offsetDateTime = z.string().regex(
  new RegExp(`^${date}T${time}${String.raw`(?:Z|[+-]\d{2}:?\d{2})`}$`),
  "Invalid datetime",
);
