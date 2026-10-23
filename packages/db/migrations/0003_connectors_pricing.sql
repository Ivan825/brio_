CREATE TYPE "public"."price_source" AS ENUM('vendor_docs', 'openrouter', 'models_endpoint');--> statement-breakpoint
ALTER TYPE "public"."ledger_kind" ADD VALUE 'connector.added';--> statement-breakpoint
ALTER TYPE "public"."ledger_kind" ADD VALUE 'connector.removed';--> statement-breakpoint
CREATE TABLE "connector_models" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"model" text NOT NULL,
	"display_name" text,
	"context_tokens" integer,
	"max_output_tokens" integer,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"listed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_models_connectorId_model_unique" UNIQUE("connector_id","model")
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"preset_key" text NOT NULL,
	"model" text NOT NULL,
	"input_per_m" numeric(14, 6) NOT NULL,
	"output_per_m" numeric(14, 6) NOT NULL,
	"cached_input_per_m" numeric(14, 6),
	"cache_write_per_m" numeric(14, 6),
	"long_context" jsonb,
	"off_peak" jsonb,
	"currency" text DEFAULT 'USD' NOT NULL,
	"source" "price_source" NOT NULL,
	"source_url" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_prices_presetKey_model_unique" UNIQUE("preset_key","model")
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"workspace_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blobs_workspace_id_sha256_pk" PRIMARY KEY("workspace_id","sha256")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "price_override" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "options" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_models" ADD CONSTRAINT "connector_models_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_models" ADD CONSTRAINT "connector_models_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_models_workspace_id_index" ON "connector_models" USING btree ("workspace_id");