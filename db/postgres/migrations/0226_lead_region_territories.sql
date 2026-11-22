ALTER TABLE "portable_lead_routing_members" ADD COLUMN "regions" varchar(100)[] DEFAULT '{}'::varchar[] NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_leads" ADD COLUMN "intake_region" varchar(100);--> statement-breakpoint
ALTER TABLE "portable_lead_routing_members" ADD CONSTRAINT "portable_routing_regions" CHECK (cardinality("portable_lead_routing_members"."regions")<=50 AND
    (cardinality("portable_lead_routing_members"."regions")=0 OR ("portable_lead_routing_members"."country"<>'' AND cardinality("portable_lead_routing_members"."additional_countries")=0 AND array_ndims("portable_lead_routing_members"."regions")=1))
    AND array_position("portable_lead_routing_members"."regions",NULL) IS NULL AND array_position("portable_lead_routing_members"."regions",'') IS NULL);