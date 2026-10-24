ALTER TABLE "ledger" ALTER COLUMN "seq" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger" ALTER COLUMN "prev_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger" ALTER COLUMN "hash" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "ledger_pending_index" ON "ledger" USING btree ("workspace_id") WHERE "ledger"."hash" is null;--> statement-breakpoint
-- The ledger stays append-only, with one exception (D-98): a pending entry (hash still null) may be chained once —
-- seq, prev_hash and hash set — and nothing else about it may change. Every other UPDATE and every DELETE raises.
CREATE OR REPLACE FUNCTION brio_ledger_chain_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.hash IS NULL AND OLD.seq IS NULL AND OLD.prev_hash IS NULL
     AND NEW.hash IS NOT NULL AND NEW.seq IS NOT NULL AND NEW.prev_hash IS NOT NULL
     AND NEW.id = OLD.id AND NEW.workspace_id = OLD.workspace_id AND NEW.kind = OLD.kind
     AND NEW.payload = OLD.payload AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'brio: % on % is not allowed; the table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'BR001';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ledger_append_only ON ledger;
--> statement-breakpoint
CREATE TRIGGER ledger_append_only
  BEFORE UPDATE OR DELETE ON ledger
  FOR EACH ROW EXECUTE FUNCTION brio_ledger_chain_only();
