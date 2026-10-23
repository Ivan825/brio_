ALTER TABLE "contracts" ADD COLUMN "mission_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reply_to_id" uuid;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "checks" jsonb;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "planner_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "auto_approve" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "origin" text DEFAULT 'planner' NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "lint" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "revisions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;