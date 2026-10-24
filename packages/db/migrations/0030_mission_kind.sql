CREATE TYPE "public"."mission_kind" AS ENUM('mission', 'chat');--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "kind" "mission_kind" DEFAULT 'mission' NOT NULL;--> statement-breakpoint
CREATE INDEX "missions_workspace_id_kind_updated_at_index" ON "missions" USING btree ("workspace_id","kind","updated_at");