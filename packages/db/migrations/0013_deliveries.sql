CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"integration_id" uuid,
	"approval_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'awaiting_approval' NOT NULL,
	"repo" jsonb NOT NULL,
	"branch" text NOT NULL,
	"commit" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"number" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "credential_ref" uuid;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deliveries_mission_id_index" ON "deliveries" USING btree ("mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_approval_id_index" ON "deliveries" USING btree ("approval_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_credential_ref_vault_secrets_id_fk" FOREIGN KEY ("credential_ref") REFERENCES "public"."vault_secrets"("id") ON DELETE no action ON UPDATE no action;