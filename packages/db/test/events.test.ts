import type { Event } from "@brio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventFeed, streamMissionEvents } from "../src/event-feed";
import { EventWriter, MissionNotFoundError, readEventsSince } from "../src/events";
import { missions } from "../src/schema/index";
import { DEMO, seedDemo } from "../src/seed";
import { createTestDb, hasTestDatabase, type TestDb } from "../src/testing";

const planted = "planted-event-secret-0123456789abcdef";
/** Minimal stand-in for the vault Redactor: the writer must route every payload through it. */
const redactor = {
  redactDeep: (v: unknown) => JSON.parse(JSON.stringify(v).replaceAll(planted, "[redacted]")),
};

describe.skipIf(!hasTestDatabase)("events", () => {
  let t: TestDb;
  let feed: EventFeed;
  const writer = new EventWriter(redactor);

  const newMission = async () => {
    const [m] = await t.db
      .insert(missions)
      .values({ workspaceId: DEMO.workspaceId, title: "m", goal: "g" })
      .returning();
    return m!.id;
  };
  const ev = (missionId: string, n: number) => ({
    workspaceId: DEMO.workspaceId,
    missionId,
    type: "attempt.message" as const,
    actor: "system" as const,
    payload: { n },
  });

  beforeAll(async () => {
    t = await createTestDb();
    await seedDemo(t.db);
    feed = new EventFeed(t.pool);
    await feed.start();
  });
  afterAll(async () => {
    await feed?.stop();
    await t?.drop();
  });

  it("assigns gapless seq per mission under concurrency", async () => {
    const [a, b] = [await newMission(), await newMission()];
    await Promise.all([
      ...Array.from({ length: 30 }, (_, i) => writer.append(t.db, ev(a, i))),
      ...Array.from({ length: 10 }, (_, i) => writer.append(t.db, ev(b, i))),
    ]);
    expect((await readEventsSince(t.db, a, 0)).map((e) => e.seq)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
    expect((await readEventsSince(t.db, b, 0)).map((e) => e.seq)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
  });

  it("redacts payloads before storing them", async () => {
    const m = await newMission();
    const e = await writer.append(t.db, { ...ev(m, 0), payload: { header: `Bearer ${planted}` } });
    expect(JSON.stringify(e)).not.toContain(planted);
    expect(JSON.stringify(await readEventsSince(t.db, m, 0))).not.toContain(planted);
  });

  it("validates events and refuses unknown missions", async () => {
    const m = await newMission();
    await expect(writer.append(t.db, { ...ev(m, 0), type: "made.up" as never })).rejects.toThrow();
    await expect(writer.append(t.db, { ...ev(m, 0), actor: "root" as never })).rejects.toThrow();
    await expect(writer.append(t.db, ev("01900000-0000-7000-8000-00000000ffff", 0))).rejects.toThrow(
      MissionNotFoundError,
    );
  });

  it("streams backlog then live events, and resumes after a disconnect without gaps or duplicates", async () => {
    const m = await newMission();
    for (let i = 1; i <= 5; i++) await writer.append(t.db, ev(m, i));

    // first connection: reads from the start, sees live events, then drops after seq 7
    const first: number[] = [];
    const c1 = new AbortController();
    const s1 = streamMissionEvents(
      t.db,
      feed,
      m,
      (e: Event) => {
        first.push(e.seq);
        if (e.seq === 7) c1.abort();
      },
      { afterSeq: 0, signal: c1.signal },
    );
    await writer.append(t.db, ev(m, 6));
    await writer.append(t.db, ev(m, 7));
    await s1;
    expect(first).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // events written while disconnected
    for (let i = 8; i <= 12; i++) await writer.append(t.db, ev(m, i));

    // reconnect with Last-Event-ID 7, while more events arrive concurrently
    const second: number[] = [];
    const c2 = new AbortController();
    const s2 = streamMissionEvents(
      t.db,
      feed,
      m,
      (e: Event) => {
        second.push(e.seq);
        if (e.seq === 30) c2.abort();
      },
      { afterSeq: 7, signal: c2.signal, batchSize: 4 },
    );
    await Promise.all(Array.from({ length: 18 }, (_, i) => writer.append(t.db, ev(m, 13 + i))));
    await s2;
    expect(second).toEqual(Array.from({ length: 23 }, (_, i) => i + 8));
  });
});
