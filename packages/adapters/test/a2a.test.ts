// A2A adapter pieces (ADAPTER_SPEC §2.5): skills suggest task types; an A2A task's artifacts become Brio's result.
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/index";
import { resultOf, taskTypesFromSkills } from "../src/services/a2a/index";

const part = (content: unknown, extra: Record<string, unknown> = {}) =>
  ({ content, metadata: undefined, filename: "", mediaType: "", ...extra }) as never;

describe("A2A agents", () => {
  it("suggests task types from an agent's skills", () => {
    expect(taskTypesFromSkills([{ id: "fix", name: "Fix bugs", tags: ["code"] }])).toEqual([
      "code.bugfix",
      "code.feature",
      "code.tests",
    ]);
    expect(
      taskTypesFromSkills([{ id: "x", description: "Find and cite sources", tags: ["research"] }]),
    ).toEqual(["research.deep_report", "research.web"]);
    expect(taskTypesFromSkills([{ id: "illustrate", description: "Draws an image" }])).toEqual([
      "media.image",
    ]);
    // An agent that says nothing specific still writes and summarises.
    expect(taskTypesFromSkills([])).toEqual(["write.summary"]);
  });

  it("turns artifacts into the answer, files and links", () => {
    const r = resultOf([
      {
        artifactId: "a",
        name: "answer",
        description: "",
        parts: [part({ $case: "text", value: "Hello" })],
        metadata: undefined,
        extensions: [],
      },
      {
        artifactId: "b",
        name: "",
        description: "",
        parts: [part({ $case: "data", value: { ok: true } })],
        metadata: undefined,
        extensions: [],
      },
      {
        artifactId: "c",
        name: "chart",
        description: "",
        parts: [
          part(
            { $case: "raw", value: Buffer.from([1, 2, 3]) },
            { filename: "chart.png", mediaType: "image/png" },
          ),
        ],
        metadata: undefined,
        extensions: [],
      },
      {
        artifactId: "d",
        name: "",
        description: "",
        parts: [part({ $case: "url", value: "https://example.com/x" })],
        metadata: undefined,
        extensions: [],
      },
    ]);
    expect(r.text).toBe('## answer\n\nHello\n\n```json\n{\n  "ok": true\n}\n```');
    expect(r.files).toEqual([
      { kind: "image", name: "chart.png", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
    ]);
    expect(r.urls).toEqual(["https://example.com/x"]);
  });

  it("is registered as the a2a route", () => {
    expect(ADAPTERS.a2a?.route).toBe("a2a");
  });
});
