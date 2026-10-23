import { describe, expect, it } from "vitest";
import {
  citationsPresent,
  citedSources,
  extractLinks,
  findJsonSchema,
  mediaSpec,
  parseFactCheck,
  parseRubric,
  pickReviewer,
  probeMedia,
  type ReviewerCandidate,
  readAxe,
  readLighthouse,
  seeded,
  validateAgainstSchema,
  verdict,
} from "../src/index";

describe("verdict logic", () => {
  const item = (status: "pending" | "running" | "passed" | "failed" | "needs_human", hard = true) => ({
    kind: hard ? "tests" : "lint",
    hard,
    status,
    summary: status,
  });

  it("revises twice, reroutes once, then fails", () => {
    const failed = [item("failed"), item("passed")];
    expect(verdict({ items: failed, revisions: 0, reroutes: 0 }).kind).toBe("revise");
    expect(verdict({ items: failed, revisions: 1, reroutes: 0 }).kind).toBe("revise");
    expect(verdict({ items: failed, revisions: 2, reroutes: 0 }).kind).toBe("reroute");
    const last = verdict({ items: failed, revisions: 2, reroutes: 1 });
    expect(last).toEqual({ kind: "fail", reasons: ["tests: failed"] });
  });

  it("waits on open hard checks and passes with soft failures noted", () => {
    expect(verdict({ items: [item("passed"), item("needs_human")], revisions: 0, reroutes: 0 })).toEqual({
      kind: "wait",
      waitingOn: ["tests"],
    });
    expect(verdict({ items: [item("passed"), item("failed", false)], revisions: 0, reroutes: 0 })).toEqual({
      kind: "pass",
      softFailures: ["lint: failed"],
    });
    // A failure decides even while other checks are still running.
    expect(verdict({ items: [item("running"), item("failed")], revisions: 0, reroutes: 0 }).kind).toBe(
      "revise",
    );
  });
});

describe("the rubric reviewer is never the maker's vendor", () => {
  const VENDORS = ["openai", "anthropic", "google", "xai", "mistral"];
  const KINDS = ["review.rubric", "code.feature", "judge.pairwise"];

  it("holds for 2,000 random workspaces (property test)", () => {
    const rng = seeded(20261023);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)] as T;
    for (let run = 0; run < 2000; run++) {
      const team: ReviewerCandidate[] = Array.from({ length: 1 + Math.floor(rng() * 6) }, (_, i) => ({
        id: `a${i}`,
        name: `agent ${i}`,
        vendor: pick(VENDORS),
        runnable: rng() > 0.1,
        healthy: rng() > 0.1,
        taskTypes: rng() > 0.2 ? ["review.rubric", "code.feature"] : [pick(KINDS)],
        local: rng() > 0.7,
      }));
      const maker = team[Math.floor(rng() * team.length)] as ReviewerCandidate;
      const confidential = rng() > 0.8;
      const choice = pickReviewer(team, { agentId: maker.id, vendor: maker.vendor }, { confidential });
      const eligible = team.filter(
        (c) =>
          c.runnable &&
          c.healthy &&
          c.id !== maker.id &&
          c.taskTypes.includes("review.rubric") &&
          c.vendor !== maker.vendor &&
          (!confidential || c.local),
      );
      if (choice.ok) {
        const chosen = team.find((c) => c.id === choice.agentId) as ReviewerCandidate;
        expect(chosen.vendor).not.toBe(maker.vendor);
        expect(eligible.map((c) => c.id)).toContain(chosen.id);
      } else {
        // It only declines when no other vendor can review; then a person does.
        expect(eligible).toEqual([]);
        expect(choice.reason).toMatch(/person reviews/);
      }
    }
  });

  it("takes the caller's order (best first) among other vendors", () => {
    const c = (id: string, vendor: string): ReviewerCandidate => ({
      id,
      name: id,
      vendor,
      runnable: true,
      healthy: true,
      taskTypes: ["review.rubric"],
    });
    const choice = pickReviewer([c("same", "openai"), c("x", "xai"), c("g", "google")], {
      agentId: "maker",
      vendor: "openai",
    });
    expect(choice).toMatchObject({ ok: true, agentId: "x" });
  });
});

describe("text checks", () => {
  const long =
    "Brio routes each task to the agent most likely to pass its checks at the lowest cost and time, and it learns from every verdict which agents win at which kinds of work";
  it("finds factual paragraphs without sources", () => {
    const good = `# Report\n\n${long}, according to its scoreboard [1].\n\n${long} as described at https://example.com/brio.\n\n[1]: https://example.com/score`;
    expect(citationsPresent(good)).toMatchObject({ passed: true, paragraphs: 2 });
    const bad = `${long} (Smith, 2024).\n\n${long} and nobody says where this comes from at all today.`;
    const r = citationsPresent(bad);
    expect(r.passed).toBe(false);
    expect(r.uncited).toHaveLength(1);
    expect(citationsPresent("Short note.").passed).toBe(true);
  });

  it("extracts links and the claims that cite each numbered source", () => {
    expect(
      extractLinks("See https://a.example/x, and [b](https://b.example/y). Also https://a.example/x."),
    ).toEqual(["https://a.example/x", "https://b.example/y"]);
    const text =
      "Agents disagree [1]. Tests decide [2]. Judges break ties [1].\n\n[1]: https://one.example\n[2] Two https://two.example/p";
    expect(citedSources(text)).toEqual([
      { ref: "1", url: "https://one.example", claims: ["Agents disagree [1].", "Judges break ties [1]."] },
      { ref: "2", url: "https://two.example/p", claims: ["Tests decide [2]."] },
    ]);
  });
});

describe("media probes", () => {
  const bytes = (...parts: Array<number[] | string>) =>
    Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
  const box = (type: string, body: number[]) => [
    ...be32(8 + body.length),
    ...[...type].map((c) => c.charCodeAt(0)),
    ...body,
  ];

  it("reads image sizes", () => {
    const png = bytes([0x89], "PNG\r\n\x1a\n", be32(13), "IHDR", be32(1920), be32(1080), [8, 6, 0, 0, 0]);
    expect(probeMedia(png)).toEqual({ format: "png", width: 1920, height: 1080 });
    expect(probeMedia(bytes("GIF89a", le16(640), le16(480)))).toEqual({
      format: "gif",
      width: 640,
      height: 480,
    });
    const jpeg = bytes(
      [0xff, 0xd8, 0xff, 0xe0],
      [0, 4, 0, 0],
      [0xff, 0xc0, 0, 17, 8],
      [0x02, 0xd0, 0x05, 0x00],
      [3],
    );
    expect(probeMedia(jpeg)).toEqual({ format: "jpeg", width: 1280, height: 720 });
    const webp = bytes(
      "RIFF",
      le32(30),
      "WEBP",
      "VP8X",
      le32(10),
      [0, 0, 0, 0],
      [0xff, 0x03, 0],
      [0xff, 0x01, 0],
    );
    expect(probeMedia(webp)).toEqual({ format: "webp", width: 1024, height: 512 });
  });

  it("reads audio and video durations", () => {
    const rate = 16_000 * 2;
    const wav = bytes(
      "RIFF",
      le32(36 + rate * 3),
      "WAVE",
      "fmt ",
      le32(16),
      le16(1),
      le16(1),
      le32(16_000),
      le32(rate),
      le16(2),
      le16(16),
      "data",
      le32(rate * 3),
    );
    expect(probeMedia(wav)).toEqual({ format: "wav", durationS: 3 });
    const mvhd = box("mvhd", [
      0,
      0,
      0,
      0,
      ...be32(0),
      ...be32(0),
      ...be32(1000),
      ...be32(30_500),
      ...Array(80).fill(0),
    ]);
    const tkhd = box("tkhd", [0, 0, 0, 3, ...Array(72).fill(0), ...be32(1280 * 65536), ...be32(720 * 65536)]);
    const mp4 = bytes(
      box("ftyp", [...[..."isom"].map((c) => c.charCodeAt(0)), 0, 0, 2, 0]),
      box("moov", [...mvhd, ...box("trak", tkhd)]),
    );
    expect(probeMedia(mp4)).toEqual({ format: "mp4", durationS: 30.5, width: 1280, height: 720 });
  });

  it("checks a spec and says what is wrong", () => {
    expect(
      mediaSpec(
        { format: "png", width: 1920, height: 1080 },
        { formats: ["png"], aspect: 16 / 9, minWidth: 1200 },
      ),
    ).toEqual({
      passed: true,
      problems: [],
    });
    expect(mediaSpec({ format: "mp4", durationS: 42 }, { maxDurationS: 30, width: 1280 })).toEqual({
      passed: false,
      problems: ["could not read the size of a mp4 file", "42.0s > 30s"],
    });
  });
});

describe("web audits", () => {
  it("reads axe results by impact", () => {
    const axe = [
      {
        violations: [
          { id: "color-contrast", impact: "serious", nodes: [{}, {}] },
          { id: "region", impact: "moderate", nodes: [{}] },
        ],
      },
    ];
    expect(readAxe(axe)).toEqual({
      passed: false,
      summary: "1 violation(s): color-contrast (serious, 2 element(s))",
    });
    expect(readAxe(axe, { minImpact: "critical" }).passed).toBe(true);
    expect(readAxe({}).passed).toBe(false);
  });

  it("reads Lighthouse category scores against minimums", () => {
    const report = { categories: { performance: { score: 0.91 }, accessibility: { score: 0.7 } } };
    expect(readLighthouse(report)).toEqual({ passed: true, summary: "performance 91" });
    expect(readLighthouse(report, { performance: 0.9, accessibility: 0.9, seo: 0.5 })).toEqual({
      passed: false,
      summary: "accessibility 70 < 90, seo: not measured",
    });
  });
});

describe("agent check answers", () => {
  it("parses rubrics strictly: a skipped criterion scores 1", () => {
    const text = '```json\n{"scores":{"Correct":5,"clear":4},"verdict":"pass","reasons":["ok"]}\n```';
    expect(parseRubric(text, ["correct", "clear"], 4)).toEqual({
      scores: { correct: 5, clear: 4 },
      verdict: "pass",
      reasons: "ok",
      passed: true,
    });
    expect(parseRubric(text, ["correct", "clear", "concise"], 4)?.passed).toBe(false);
    expect(parseRubric("no json", ["x"], 3)).toBeNull();
  });

  it("parses fact checks; any unsupported claim fails", () => {
    const r = parseFactCheck(
      '```json\n{"claims":[{"claim":"A","supported":true,"why":"says so"},{"claim":"B","supported":false,"why":"not in source"}],"verdict":"fail"}\n```',
    );
    expect(r?.passed).toBe(false);
    expect(r?.summary).toContain('"B" (not in source)');
    expect(parseFactCheck('{"claims":[],"verdict":"pass"}')?.passed).toBe(true);
  });
});

describe("contract conformance by schema", () => {
  const spec = `## contracts/user.md\n\nThe user object:\n\n\`\`\`json\n{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","required":["id","email"],"properties":{"id":{"type":"string"},"email":{"type":"string"}},"additionalProperties":false}\n\`\`\``;

  it("finds the schema and validates documents against it", () => {
    const schema = findJsonSchema(spec);
    expect(schema).toMatchObject({ type: "object" });
    expect(validateAgainstSchema(schema!, { "out/user.json": '{"id":"1","email":"a@b.c"}' }).passed).toBe(
      true,
    );
    const bad = validateAgainstSchema(schema!, {
      "out/user.json": '{"id":1,"name":"x"}',
      "out/other.json": "{",
    });
    expect(bad.passed).toBe(false);
    expect(bad.errors).toEqual(
      expect.arrayContaining([
        "out/user.json: (root) must have required property 'email'",
        "out/user.json: /id must be string",
        "out/other.json: not valid JSON",
      ]),
    );
    expect(findJsonSchema("# Prose only\n\nGET /hello returns 200")).toBeNull();
  });
});
