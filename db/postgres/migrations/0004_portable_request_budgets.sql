CREATE TABLE "portable_request_budgets" (
	"scope" text NOT NULL,
	"subject" text NOT NULL,
	"minute" integer NOT NULL,
	"used" integer NOT NULL,
	CONSTRAINT "portable_request_budgets_scope_subject_pk" PRIMARY KEY("scope","subject"),
	CONSTRAINT "portable_request_budget_scope" CHECK (
    ("portable_request_budgets"."scope" IN ('login_start','login_callback') AND "portable_request_budgets"."subject"='')
    OR ("portable_request_budgets"."scope" IN ('api_read','api_write') AND "portable_request_budgets"."subject"<>'')
  )
);
