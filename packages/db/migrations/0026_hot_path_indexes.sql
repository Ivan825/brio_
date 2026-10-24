CREATE INDEX "messages_workspace_id_status_index" ON "messages" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "attempts_workspace_id_created_at_index" ON "attempts" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_workspace_id_status_index" ON "tasks" USING btree ("workspace_id","status");