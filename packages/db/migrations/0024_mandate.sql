CREATE TABLE "mandate_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"base_url" text NOT NULL,
	"token_ref" uuid NOT NULL,
	"mandate_id" text NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"connected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mandate_connections_workspaceId_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
CREATE TABLE "mandate_holds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_id" uuid,
	"request_key" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"merchant" text NOT NULL,
	"status" text NOT NULL,
	"transaction_id" text,
	"approval_id" text,
	"reason" text,
	"captured_cents" integer,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mandate_holds_requestKey_unique" UNIQUE("request_key")
);
--> statement-breakpoint
ALTER TABLE "mandate_connections" ADD CONSTRAINT "mandate_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_connections" ADD CONSTRAINT "mandate_connections_token_ref_vault_secrets_id_fk" FOREIGN KEY ("token_ref") REFERENCES "public"."vault_secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_connections" ADD CONSTRAINT "mandate_connections_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_holds" ADD CONSTRAINT "mandate_holds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_holds" ADD CONSTRAINT "mandate_holds_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_holds" ADD CONSTRAINT "mandate_holds_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mandate_holds_workspace_id_status_index" ON "mandate_holds" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "mandate_holds_attempt_id_index" ON "mandate_holds" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "mandate_holds_task_id_status_index" ON "mandate_holds" USING btree ("task_id","status");