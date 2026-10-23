CREATE TABLE "score_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"agent_key" text NOT NULL,
	"task_type" text NOT NULL,
	"pass_rate" double precision NOT NULL,
	"elo" double precision NOT NULL,
	"n" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "scored" text;--> statement-breakpoint
ALTER TABLE "score_history" ADD CONSTRAINT "score_history_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "score_history_workspace_id_agent_key_task_type_at_index" ON "score_history" USING btree ("workspace_id","agent_key","task_type","at");