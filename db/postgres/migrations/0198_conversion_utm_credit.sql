ALTER TABLE "portable_form_conversions" ADD COLUMN "utm_counts" jsonb;--> statement-breakpoint
ALTER TABLE "portable_form_conversions" ADD CONSTRAINT "form_conversion_utm_counts" CHECK ("portable_form_conversions"."utm_counts" IS NULL OR (
    jsonb_typeof("portable_form_conversions"."utm_counts"->'medium') IS NOT DISTINCT FROM 'object' AND
    jsonb_typeof("portable_form_conversions"."utm_counts"->'campaign') IS NOT DISTINCT FROM 'object'));