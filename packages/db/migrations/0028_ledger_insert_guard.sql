-- D-98 hardening (security re-review M-e): an entry is written pending (seq, prev_hash and hash all empty) and given
-- all three at once when chained. No row may be inserted already chained (a forged head would jam the chain), and
-- the three are set or empty together.
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_chained_together" CHECK (
  ("hash" IS NULL) = ("seq" IS NULL) AND ("hash" IS NULL) = ("prev_hash" IS NULL)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION brio_ledger_insert_pending() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.seq IS NOT NULL OR NEW.prev_hash IS NOT NULL OR NEW.hash IS NOT NULL THEN
    RAISE EXCEPTION 'brio: ledger entries are written pending and chained by Brio; the table is append-only'
      USING ERRCODE = 'BR001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_insert_pending
  BEFORE INSERT ON ledger
  FOR EACH ROW EXECUTE FUNCTION brio_ledger_insert_pending();
