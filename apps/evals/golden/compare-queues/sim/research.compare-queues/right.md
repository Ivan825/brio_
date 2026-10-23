**pg-boss** keeps jobs in Postgres (retries, cron, exactly-once claims with SKIP LOCKED). **BullMQ** needs Redis; it is very fast and has a rich UI ecosystem.

Recommendation: pg-boss — the service already runs Postgres and has no Redis, so it adds no infrastructure.
