ALTER TABLE "budgets" ADD COLUMN "warned_period" text;--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "stopped_period" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "cancel_reason" text;