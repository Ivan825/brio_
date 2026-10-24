# Load test

M10 acceptance (`BUILD_PLAN.md`):
- 100 concurrent missions and 500 concurrent attempts;
- API p95 under 300 ms;
- event fan-out under 1 s.

## How to run it

```sh
TEST_DATABASE_URL=postgres://brio:brio@localhost:5433/brio pnpm --filter @brio/api load
```

`apps/api/load/run.ts` creates a fresh database and starts Brio the way it is deployed at scale. Each part is its own process, started from its real entry point:
- **2 API web processes** (`BRIO_API_ROLE=web`): requests, live events, MCP, A2A;
- **1 API worker** (`BRIO_API_ROLE=worker`): the orchestrator, budget guard, notifier, memory, Mandate and the ledger chainer;
- **8 runners**, each running up to 64 attempts.

The script itself is only a client and a vendor. It plays:
- an OpenAI-compatible vendor that takes about 12 s to answer;
- people: one signs in through an emailed link, connects that vendor and makes an agent; 20 readers then load the missions list, mission pages, the inbox, the scoreboard and budgets in a loop;
- browsers: one live event stream per mission, as each mission's board would open.

It creates **125 missions × 4 tasks** and approves them all at once. A mission runs at most 4 tasks in parallel, so 4 × 125 gives the 500 attempts. It follows every stream until each mission is done.

**What it measures:**
- **API latency:** each reader request, from send to full response.
- **Fan-out:** for every event, the time from the event being written (`events.ts`, `clock_timestamp()` at insert) to a watching browser receiving it.

The run fails if an SLO is missed or a mission does not finish.

Settings: `LOAD_MISSIONS`, `LOAD_TASKS`, `LOAD_RUNNERS`, `LOAD_READERS`, `LOAD_VENDOR_MS`, and `LOAD_WEB` (`0` puts the API in one process). `LOAD_PROFILE=<dir>` writes the API processes' CPU profiles.

## Result

24 Oct 2026, on one laptop (8 cores, 16 GB RAM, Postgres 17 in Docker with 8 vCPU and 4 GB). Every process, Postgres and the client shared that machine.

| | Measured | SLO |
|---|---|---|
| Missions done | 125 / 125 | all |
| Attempts running at once (peak) | 492 of 500 (the first finish as the last start) | 500 |
| API p50 / **p95** / p99 | 34 / **136** / 224 ms (7,371 requests) | p95 < 300 ms |
| Fan-out p50 / **p95** / p99 | 169 / **741** / 892 ms (5,375 events) | p95 < 1 s |

## What it took

The first runs missed both SLOs: API p95 677 ms (p99 4 s) and fan-out p95 2.2 s. Profiling and counting queries found five causes, each fixed and kept:

1. **Idle runners hammered Postgres.**
   - **Cause:** pg-boss workers polled once per concurrency slot. Eight idle runners at 64 slots made about 2,100 transactions a second and held Postgres at 87% CPU.
   - **Fix:** a runner now has one claim loop per queue, which asks for as many jobs as it has free slots (`JobPump`). Eight idle runners now make 72 transactions a second.
2. **One process did everything.**
   - **Cause:** the API served every request and stream while also running the orchestrator, budget guard, notifier and memory ingest for every live mission. Its one thread ran at 92%.
   - **Fix:** `BRIO_API_ROLE` separates **web** processes (scale them freely) from the single **worker** (D-99). Writes from the web side still wake the worker through the events they emit.
3. **Every event woke the orchestrator.**
   - **Cause:** agents' messages, tool calls, edits and cost updates each triggered a full mission tick, though none of them changes what happens next.
   - **Fix:** they no longer trigger one. The periodic sweep is still the safety net.
4. **Every request minted a JWT.**
   - **Cause:** Better Auth's JWT plugin read the signing keys and signed a token on every session lookup.
   - **Fix:** turned off; JWTs are only for MCP's OAuth.
5. **The ledger serialised the workspace.**
   - **Cause:** each dispatch and each settlement appended to the hash-chained ledger inside its own transaction, holding the workspace's chain lock until commit. With hundreds of attempts in one workspace, events waited seconds behind it.
   - **Fix:** entries are now written in their transaction and chained a moment later by the worker, and by every reader before it reads (D-98). A trigger still forbids any change except chaining a pending entry once.

Also:
- indexes for a workspace's monthly spend, its tasks by status and its open messages;
- one query each for the inbox's checklists and approvals;
- events dated when written rather than when their transaction began.

## Limits to know

- **One worker runs every mission.** At this load the worker is about half busy. Past several hundred live missions it is the next bottleneck; ticks would then be sharded by mission across workers. The scheduler is already per-mission, but that work is not done.
- **One workspace, one ledger chain.** Each workspace's chain is built in order by whichever worker holds its lock; chaining is far cheaper than the business transactions it used to hold up.
- **Postgres is shared by everything.** It was the busiest process here (about 250% CPU). In production, give it its own cores. Postgres connections per process: web 20 (`DATABASE_POOL_MAX`), worker 20, about 14 per runner.
