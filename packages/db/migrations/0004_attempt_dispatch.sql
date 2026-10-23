ALTER TABLE "attempts" ADD COLUMN "dispatch" jsonb;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "attempts_status_heartbeat_at_index" ON "attempts" USING btree ("status","heartbeat_at");