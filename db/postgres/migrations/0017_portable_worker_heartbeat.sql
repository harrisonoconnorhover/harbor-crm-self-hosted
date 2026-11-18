CREATE TABLE "portable_worker_heartbeat" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_poll_at" bigint NOT NULL,
	CONSTRAINT "portable_worker_heartbeat_singleton" CHECK ("portable_worker_heartbeat"."id"=1)
);
