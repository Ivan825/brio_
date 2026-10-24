CREATE TABLE "usage_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"day" text NOT NULL,
	"status" text NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_reports_workspaceId_day_unique" UNIQUE("workspace_id","day")
);
--> statement-breakpoint
ALTER TABLE "usage_reports" ADD CONSTRAINT "usage_reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;