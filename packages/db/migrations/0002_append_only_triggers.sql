-- The ledger and the events table are append-only (CLAUDE.md rule 3, SECURITY_GOVERNANCE.md §8).
-- Any UPDATE, DELETE or TRUNCATE raises, whoever runs it.
CREATE OR REPLACE FUNCTION brio_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'brio: % on % is not allowed; the table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'BR001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_append_only
  BEFORE UPDATE OR DELETE ON ledger
  FOR EACH ROW EXECUTE FUNCTION brio_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_no_truncate
  BEFORE TRUNCATE ON ledger
  FOR EACH STATEMENT EXECUTE FUNCTION brio_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION brio_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER events_no_truncate
  BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION brio_forbid_mutation();
