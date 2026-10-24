ALTER TYPE "public"."ledger_kind" ADD VALUE 'memory.change';--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD COLUMN "ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_edges_from_id_to_id_kind_index" ON "memory_edges" USING btree ("from_id","to_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_nodes_project_id_ref_index" ON "memory_nodes" USING btree ("project_id","ref") WHERE "memory_nodes"."ref" is not null;