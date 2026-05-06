import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createMemoryService,
  formatMemoryGetResponse,
  formatMemorySearchResponse,
  formatMemoryTimelineResponse,
  resolveMemoryRoot,
  resolveMemoryDatabasePath,
  type ObservationRequest,
} from "../src/service";
import { resolveOmpMemConfig } from "../src/config";

let tempRoot: string;
const services: Array<{ close(): void }> = [];

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mem-"));
});

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function makeObservation(overrides: Partial<ObservationRequest> = {}): ObservationRequest {
  return {
    contentSessionId: "session-1",
    tool_name: "bash",
    tool_input: { command: "bun test auth.test.ts" },
    tool_response: "Fixed JWT refresh failure in src/auth.ts",
    cwd: "/repo/app",
    platformSource: "omp",
    tool_use_id: "tool-1",
    ...overrides,
  };
}
async function createTrackedService(options: Parameters<typeof createMemoryService>[0]) {
  const service = await createMemoryService({ ...options, dbPath: ":memory:" });
  services.push(service);
  return service;
}



test("resolveMemoryRoot uses omp-mem state outside builtin memory folder", () => {
  const root = resolveMemoryRoot({ cwd: "C:/Users/Anton/project", homeDir: "C:/Users/Anton" });

  expect(root.replaceAll("\\", "/")).toBe(
    "C:/Users/Anton/.omp/agent/omp-mem/state/--C--Users-Anton-project--",
  );
});

test("uses omp-mem database filename for new memory roots", async () => {
  const dbPath = await resolveMemoryDatabasePath({ memoryRoot: tempRoot, now: () => 1_700_000_000 });

  expect(dbPath.replaceAll("\\", "/")).toBe(`${tempRoot.replaceAll("\\", "/")}/omp-mem.sqlite`);
});

test("uses omp-mem database even when old plugin database exists", async () => {
  await fs.writeFile(path.join(tempRoot, "omp-memory.sqlite"), "");

  const dbPath = await resolveMemoryDatabasePath({ memoryRoot: tempRoot, now: () => 1_700_000_000 });

  expect(dbPath.replaceAll("\\", "/")).toBe(`${tempRoot.replaceAll("\\", "/")}/omp-mem.sqlite`);
});

test("records observations using claude-mem compatible request fields and redacts private content", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Fix auth", platformSource: "omp" });

  const id = await service.recordObservation(
    makeObservation({
      tool_response: "Safe line\n<private>secret token abc</private>\nFixed auth refresh",
    }),
  );

  const response = await service.getObservations({ ids: [id] });
  expect(response.observations).toHaveLength(1);
  expect(response.observations[0]?.contentSessionId).toBe("session-1");
  expect(response.observations[0]?.toolName).toBe("bash");
  expect(response.observations[0]?.narrative).toContain("Fixed auth refresh");
  expect(response.observations[0]?.narrative).not.toContain("secret token");
  expect(response.observations[0]?.type).toBe("bugfix");
});

test("search returns compact index before details", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Fix auth" });
  const authId = await service.recordObservation(makeObservation());
  await service.recordObservation(
    makeObservation({ tool_use_id: "tool-2", tool_response: "Updated dashboard layout", tool_input: { path: "src/dashboard.ts" } }),
  );

  const search = await service.search({ query: "JWT auth", project: "app", limit: 5 });

  expect(search.results.map(result => result.id)).toEqual([authId]);
  expect(search.results[0]?.title).toContain("JWT");
  expect("narrative" in (search.results[0] as unknown as Record<string, unknown>)).toBe(false);
  expect(formatMemorySearchResponse(search)).toContain(`#${authId}`);
});

test("obs_type prompt returns prompt records without leaking tool observations", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Fix auth prompt" });
  await service.recordObservation(makeObservation({ tool_response: "Fixed JWT auth regression in src/auth.ts" }));

  const search = await service.search({ query: "Fix auth", project: "app", obs_type: "prompt", limit: 5 });
  const record = search.results[0] as unknown as Record<string, unknown>;

  expect(search.total).toBe(1);
  expect(search.results).toHaveLength(1);
  expect(record.recordType).toBe("prompt");
  expect(record.type).toBe("prompt");
  expect(search.results[0]?.title).toContain("Fix auth prompt");
  expect(formatMemorySearchResponse(search)).toContain("P1");
  expect(formatMemorySearchResponse(search)).not.toContain("JWT auth regression");
});

test("obs_type session returns session summary records without leaking observations", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Fix auth" });
  await service.recordObservation(makeObservation({ tool_response: "Fixed JWT auth regression in src/auth.ts" }));
  await service.summarizeSession({ contentSessionId: "session-1", summary: "Session summary alpha durable decision." });

  const search = await service.search({ query: "alpha", project: "app", obs_type: "session", limit: 5 });
  const record = search.results[0] as unknown as Record<string, unknown>;

  expect(search.total).toBe(1);
  expect(search.results).toHaveLength(1);
  expect(record.recordType).toBe("session");
  expect(record.type).toBe("session");
  expect(search.results[0]?.title).toContain("Session summary alpha");
  expect(formatMemorySearchResponse(search)).toContain("S1");
  expect(formatMemorySearchResponse(search)).not.toContain("JWT auth regression");
});

test("search total counts all matching records before pagination", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Fix auth" });
  await service.recordObservation(makeObservation({ tool_use_id: "tool-1", tool_response: "auth first detail" }));
  await service.recordObservation(makeObservation({ tool_use_id: "tool-2", tool_response: "auth second detail" }));
  await service.recordObservation(makeObservation({ tool_use_id: "tool-3", tool_response: "auth third detail" }));

  const search = await service.search({ query: "auth", project: "app", obs_type: "observation", limit: 1 });

  expect(search.results).toHaveLength(1);
  expect(search.total).toBe(3);
});

test("search with FTS query honors explicit date_desc order", async () => {
  const service = await createTrackedService({
    memoryRoot: tempRoot,
    now: (() => {
      let current = 1_700_000_000;
      return () => current++;
    })(),
  });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Fix auth" });
  const older = await service.recordObservation(makeObservation({ tool_use_id: "tool-older", tool_response: "auth auth auth older detail" }));
  const newer = await service.recordObservation(makeObservation({ tool_use_id: "tool-newer", tool_response: "auth newer detail" }));

  const search = await service.search({ query: "auth", project: "app", obs_type: "observation", orderBy: "date_desc", limit: 2 });

  expect(search.results.map(result => result.id)).toEqual([newer, older]);
});

test("initializes claude-mem aligned core schema columns", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });

  const observationColumns = new Set((service.db.prepare("PRAGMA table_info(observations)").all() as Array<{ name: string }>).map(row => row.name));
  const summaryColumns = new Set((service.db.prepare("PRAGMA table_info(session_summaries)").all() as Array<{ name: string }>).map(row => row.name));
  const sessionColumns = new Set((service.db.prepare("PRAGMA table_info(sdk_sessions)").all() as Array<{ name: string }>).map(row => row.name));

  expect(observationColumns).toContain("memory_session_id");
  expect(observationColumns).toContain("content_hash");
  expect(observationColumns).toContain("agent_type");
  expect(observationColumns).toContain("agent_id");
  expect(observationColumns).toContain("generated_by_model");
  expect(observationColumns).toContain("metadata");
  expect(summaryColumns).toContain("request");
  expect(summaryColumns).toContain("investigated");
  expect(summaryColumns).toContain("learned");
  expect(summaryColumns).toContain("completed");
  expect(summaryColumns).toContain("next_steps");
  expect(sessionColumns).toContain("status");
  expect(sessionColumns).toContain("prompt_counter");
});

test("remember stores manual memory as redacted discovery observation", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });

  const id = await (service as unknown as {
    remember(request: { text: string; title?: string; project?: string; metadata?: Record<string, unknown> }): Promise<number>;
  }).remember({
    text: "Manual memory alpha <private>secret</private>",
    title: "Manual alpha",
    project: "app",
    metadata: { source: "test" },
  });
  const observation = (await service.getObservations({ ids: [id], project: "app" })).observations[0];

  expect(observation?.type).toBe("discovery");
  expect(observation?.toolName).toBe("memory_remember");
  expect(observation?.title).toBe("Manual alpha");
  expect(observation?.narrative).toContain("Manual memory alpha");
  expect(observation?.narrative).not.toContain("secret");
});

test("remember redacts project and metadata keys before SQLite storage", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });

  const id = await service.remember({
    text: "Manual memory gamma",
    project: "<private>secret-project</private>",
    metadata: {
      project: "<private>secret-metadata-project</private>",
      "<private>secret-key</private>": "<private>secret-value</private>",
    },
  });
  const session = service.db.prepare("SELECT content_session_id, project, memory_session_id FROM sdk_sessions").get() as Record<string, string>;
  const row = service.db.prepare("SELECT project, metadata FROM observations WHERE id = ?").get(id) as Record<string, string>;

  expect(JSON.stringify(session)).not.toContain("secret");
  expect(JSON.stringify(row)).not.toContain("secret");
  expect(session.project).toContain("[private redacted]");
  expect(row.project).toContain("[private redacted]");
  expect(row.metadata).toContain("[private redacted]");
});

test("timeline supports session anchors and merges prompts observations summaries", async () => {
  const service = await createTrackedService({
    memoryRoot: tempRoot,
    now: (() => {
      let current = 1_700_000_000;
      return () => current++;
    })(),
  });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Prompt timeline alpha" });
  await service.recordObservation(makeObservation({ tool_use_id: "tool-timeline", tool_response: "Fixed observation timeline alpha" }));
  await service.summarizeSession({ contentSessionId: "session-1", summary: "Summary timeline alpha" });

  const timeline = await service.timeline({ anchor: "S1", depth_before: 2, depth_after: 2, project: "app" });
  const formatted = formatMemoryTimelineResponse(timeline);

  expect(timeline.anchor).toBe("S1");
  expect(formatted).toContain("P1 [prompt] Prompt timeline alpha");
  expect(formatted).toContain("#1 [bugfix]");
  expect(formatted).toContain("* S1 [session] Summary timeline alpha");
});

test("timeline resolves session anchor without repeated project", async () => {
  const service = await createTrackedService({
    memoryRoot: tempRoot,
    now: (() => {
      let current = 1_700_000_000;
      return () => current++;
    })(),
  });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Prompt timeline beta" });
  await service.recordObservation(makeObservation({ tool_use_id: "tool-timeline-beta", tool_response: "Fixed observation timeline beta" }));
  await service.summarizeSession({ contentSessionId: "session-1", summary: "Summary timeline beta" });

  const timeline = await service.timeline({ anchor: "S1", depth_before: 2, depth_after: 0 });

  expect(timeline.anchor).toBe("S1");
  expect(formatMemoryTimelineResponse(timeline)).toContain("Summary timeline beta");
});

test("timeline centers chronological context around an observation", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: (() => {
    let current = 1_700_000_000;
    return () => current++;
  })() });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Work" });
  const first = await service.recordObservation(makeObservation({ tool_use_id: "tool-1", tool_response: "Investigated auth failure" }));
  const second = await service.recordObservation(makeObservation({ tool_use_id: "tool-2", tool_response: "Fixed auth failure" }));
  const third = await service.recordObservation(makeObservation({ tool_use_id: "tool-3", tool_response: "Ran regression tests" }));

  const timeline = await service.timeline({ anchor: second, depth_before: 1, depth_after: 1, project: "app" });

  expect(timeline.anchor).toBe(second);
  expect(timeline.items.map(item => item.id)).toEqual([first, second, third]);
  expect(formatMemoryTimelineResponse(timeline)).toContain("Fixed auth failure");
});

test("search concept and file filters handle literal underscores", async () => {
  const service = await createTrackedService({
    memoryRoot: tempRoot,
    now: () => 1_700_000_000,
    extractObservation: async () => ({
      title: "Literal underscore memory",
      narrative: "Literal underscore detail",
      type: "discovery",
      concepts: ["foo_bar"],
      files: ["src/foo_bar.ts"],
    }),
  });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Filter underscores" });
  const id = await service.recordObservation(makeObservation({ tool_response: "underscore" }));

  const byConcept = await service.search({ project: "app", obs_type: "observation", concept: "foo_bar" });
  const byFile = await service.search({ project: "app", obs_type: "observation", filePath: "src/foo_bar.ts" });

  expect(byConcept.results.map(result => result.id)).toEqual([id]);
  expect(byFile.results.map(result => result.id)).toEqual([id]);
});

test("search concept and file filters handle JSON escaped backslashes and percent signs", async () => {
  const service = await createTrackedService({
    memoryRoot: tempRoot,
    now: () => 1_700_000_000,
    extractObservation: async () => ({
      title: "Escaped literal memory",
      narrative: "Escaped literal detail",
      type: "discovery",
      concepts: ["foo%bar", "path\\segment"],
      files: ["src\\foo%bar.ts"],
    }),
  });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Filter escaped literals" });
  const id = await service.recordObservation(makeObservation({ tool_response: "escaped" }));

  const byPercentConcept = await service.search({ project: "app", obs_type: "observation", concept: "foo%bar" });
  const byBackslashConcept = await service.search({ project: "app", obs_type: "observation", concept: "path\\segment" });
  const byBackslashFile = await service.search({ project: "app", obs_type: "observation", filePath: "src\\foo%bar.ts" });

  expect(byPercentConcept.results.map(result => result.id)).toEqual([id]);
  expect(byBackslashConcept.results.map(result => result.id)).toEqual([id]);
  expect(byBackslashFile.results.map(result => result.id)).toEqual([id]);
});

test("manual memory subtitle is searchable through observation FTS", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });

  const id = await service.remember({
    text: "Durable user preference without the subtitle keyword.",
    title: "Preference record",
    project: "app",
  });

  const search = await service.search({ query: "Manual", project: "app", obs_type: "observation" });

  expect(search.results.map(result => result.id)).toEqual([id]);
});

test("folder file filters only match direct child files", async () => {
  const service = await createTrackedService({
    memoryRoot: tempRoot,
    now: (() => {
      let current = 1_700_000_000;
      return () => current++;
    })(),
    extractObservation: async request => request.toolResponseText.includes("direct")
      ? { title: "Direct child", narrative: "Direct child detail", type: "discovery", files: ["src/direct.ts"] }
      : { title: "Nested child", narrative: "Nested child detail", type: "discovery", files: ["src/nested/child.ts"] },
  });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Filter folder files" });
  const direct = await service.recordObservation(makeObservation({ tool_use_id: "tool-direct", tool_response: "direct" }));
  await service.recordObservation(makeObservation({ tool_use_id: "tool-nested", tool_response: "nested" }));

  const search = await service.search({ project: "app", obs_type: "observation", filePath: "src", isFolder: true } as never);

  expect(search.results.map(result => result.id)).toEqual([direct]);
});

test("unknown obs_type returns no records instead of broad observation search", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Unknown filter" });
  await service.recordObservation(makeObservation({ tool_response: "Unknown filter should not leak all records" }));

  const search = await service.search({ project: "app", obs_type: "not-a-type" });

  expect(search.total).toBe(0);
  expect(search.results).toEqual([]);
});

test("context injection writes compatible memory artifacts", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Fix auth" });
  await service.recordObservation(makeObservation());
  await service.flushArtifacts("app");

  const summary = await fs.readFile(path.join(tempRoot, "memory_summary.md"), "utf8");
  const full = await fs.readFile(path.join(tempRoot, "MEMORY.md"), "utf8");
  const context = await service.injectContext({ project: "app", q: "auth", limit: 3 });

  expect(summary).toContain("Memory summary");
  expect(summary).toContain("generated by omp-mem, a claude-mem-compatible replacement plugin");
  expect(full).toContain("Fixed JWT refresh failure");
  expect(full).toContain("Generated by omp-mem.");
  expect(context).toContain("Memory Guidance");
  expect(context).toContain("Memory source: omp-mem claude-mem-compatible replacement plugin.");
  expect(context).toContain("#1");
  expect(formatMemoryGetResponse(await service.getObservations({ ids: [1] }))).toContain("Fixed JWT refresh failure");
});

test("context injection uses configured session summaries and full observation details", async () => {
  const service = await createTrackedService({
    memoryRoot: tempRoot,
    now: () => 1_700_000_000,
    config: resolveOmpMemConfig({ context: { observations: 5, sessions: 1, fullCount: 1 } }),
  });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Investigate alpha" });
  await service.recordObservation(makeObservation({ tool_use_id: "tool-alpha", tool_response: "Alpha durable detail in src/alpha.ts" }));
  await service.recordObservation(makeObservation({ tool_use_id: "tool-beta", tool_response: "Beta durable detail in src/beta.ts" }));
  await service.summarizeSession({ contentSessionId: "session-1", last_assistant_message: "Session summary: alpha remains important" });

  const context = await service.injectContext({ project: "app", q: "Alpha" });

  expect(context).toContain("## Recent session summaries");
  expect(context).toContain("Session summary: alpha remains important");
  expect(context).toContain("## Full memory details");
  expect(context).toContain("Alpha durable detail in src/alpha.ts");
});

test("context injection honors observation type concept filters and full field", async () => {
  const service = await createTrackedService({
    memoryRoot: tempRoot,
    now: () => 1_700_000_000,
    config: resolveOmpMemConfig({
      context: {
        observations: 10,
        types: ["decision"],
        concepts: ["alpha"],
        fullCount: 1,
        fullField: "facts",
      },
    }),
    extractObservation: async request => request.toolResponseText.includes("alpha")
      ? {
        title: "Alpha decision",
        narrative: "Alpha narrative should stay compact-only.",
        type: "decision",
        concepts: ["alpha"],
        facts: ["Alpha fact expanded from facts field."],
      }
      : {
        title: "Beta feature",
        narrative: "Beta narrative should be filtered out.",
        type: "feature",
        concepts: ["beta"],
        facts: ["Beta fact"],
      },
  });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Filter context" });
  await service.recordObservation(makeObservation({ tool_use_id: "tool-alpha", tool_response: "alpha" }));
  await service.recordObservation(makeObservation({ tool_use_id: "tool-beta", tool_response: "beta" }));

  const context = await service.injectContext({ project: "app" });

  expect(context).toContain("Alpha decision");
  expect(context).toContain("Alpha fact expanded from facts field.");
  expect(context).not.toContain("Alpha narrative should stay compact-only.");
  expect(context).not.toContain("Beta feature");
});

test("context filters are applied before final observation limit", async () => {
  const service = await createTrackedService({
    memoryRoot: tempRoot,
    now: (() => {
      let current = 1_700_000_000;
      return () => current++;
    })(),
    config: resolveOmpMemConfig({ context: { observations: 1, types: ["decision"], fullCount: 0 } }),
    extractObservation: async request => request.toolResponseText.includes("decision")
      ? { title: "Older decision", narrative: "Decision detail", type: "decision", concepts: ["architecture"] }
      : { title: "Newer feature", narrative: "Feature detail", type: "feature", concepts: ["ui"] },
  });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Filter context" });
  await service.recordObservation(makeObservation({ tool_use_id: "tool-decision", tool_response: "decision" }));
  await service.recordObservation(makeObservation({ tool_use_id: "tool-feature", tool_response: "feature" }));

  const context = await service.injectContext({ project: "app" });

  expect(context).toContain("Older decision");
  expect(context).not.toContain("Newer feature");
});

test("context filters can reach older matching observations beyond candidate window", async () => {
  const service = await createTrackedService({
    memoryRoot: tempRoot,
    now: (() => {
      let current = 1_700_000_000;
      return () => current++;
    })(),
    config: resolveOmpMemConfig({ context: { observations: 1, concepts: ["target"], fullCount: 0 } }),
    extractObservation: async request => request.toolResponseText.includes("target")
      ? { title: "Older target memory", narrative: "Target detail", type: "decision", concepts: ["target"] }
      : { title: "Newer noise", narrative: "Noise detail", type: "feature", concepts: ["noise"] },
  });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Filter context" });
  await service.recordObservation(makeObservation({ tool_use_id: "tool-target", tool_response: "target" }));
  for (let index = 0; index < 11; index += 1) {
    await service.recordObservation(makeObservation({ tool_use_id: `tool-noise-${index}`, tool_response: `noise ${index}` }));
  }

  const context = await service.injectContext({ project: "app" });

  expect(context).toContain("Older target memory");
  expect(context).not.toContain("Newer noise");
});

test("recordObservation prefers configured model extraction over heuristic fields", async () => {
  const service = await createTrackedService({
    memoryRoot: tempRoot,
    now: () => 1_700_000_000,
    extractObservation: async request => {
      expect(request.toolInputText).not.toContain("secret-input");
      expect(request.toolResponseText).not.toContain("secret-response");
      expect(request.toolInputText).toContain("[private redacted]");
      expect(request.toolResponseText).toContain("[private redacted]");
      return {
        title: "AI extracted auth decision",
        narrative: "AI says JWT refresh was fixed by rotating expired credentials.",
        type: "decision",
        facts: ["JWT refresh failure fixed"],
        files: ["src/auth.ts"],
        concepts: ["jwt", "refresh"],
        confidence: "inferred",
      };
    },
  });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Fix auth" });

  const id = await service.recordObservation(makeObservation({
    tool_input: { command: "<private>secret-input</private> bun test auth.test.ts" },
    tool_response: "Fixed JWT refresh failure in src/auth.ts <private>secret-response</private>",
  }));
  const observation = (await service.getObservations({ ids: [id] })).observations[0];

  expect(observation?.title).toBe("AI extracted auth decision");
  expect(observation?.narrative).toContain("AI says JWT refresh");
  expect(observation?.type).toBe("decision");
  expect(observation?.facts).toEqual(["JWT refresh failure fixed"]);
  expect(observation?.files).toEqual(["src/auth.ts"]);
  expect(observation?.concepts).toEqual(["jwt", "refresh"]);
  expect(observation?.confidence).toBe("inferred");
});

test("recordObservation redacts and bounds extracted metadata lists", async () => {
  const longFile = `src/${"a".repeat(260)}.ts`;
  const longConcept = `concept-${"b".repeat(140)}`;
  const longFact = `fact ${"c".repeat(260)}`;
  const service = await createTrackedService({
    memoryRoot: tempRoot,
    now: () => 1_700_000_000,
    extractObservation: async () => ({
      title: "Safe title",
      narrative: "Safe narrative",
      files: ["src/auth.ts", "<private>secret/path.ts</private>", longFile, ...Array.from({ length: 20 }, (_, index) => `src/file-${index}.ts`)],
      concepts: ["auth", "<private>secret concept</private>", longConcept, ...Array.from({ length: 35 }, (_, index) => `concept-${index}`)],
      facts: ["safe fact", "<private>secret fact</private>", longFact, ...Array.from({ length: 15 }, (_, index) => `fact ${index}`)],
    }),
  });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Fix auth" });

  const id = await service.recordObservation(makeObservation());
  const observation = (await service.getObservations({ ids: [id] })).observations[0];
  const row = service.db.prepare("SELECT facts, files_read, concepts FROM observations WHERE id = ?").get(id) as Record<string, string>;
  const fts = service.db.prepare("SELECT facts, files, concepts FROM observations_fts WHERE rowid = ?").get(id) as Record<string, string>;

  expect(observation?.files).toHaveLength(20);
  expect(observation?.concepts).toHaveLength(30);
  expect(observation?.facts).toHaveLength(12);
  expect(observation?.files.every(file => file.length <= 240)).toBe(true);
  expect(observation?.concepts.every(concept => concept.length <= 120)).toBe(true);
  expect(observation?.facts.every(fact => fact.length <= 240)).toBe(true);
  expect(JSON.stringify({ observation, row, fts })).toContain("[private redacted]");
  expect(JSON.stringify({ observation, row, fts })).not.toContain("secret");
});

test("summarizeSession redacts and clamps injected summary without raw assistant text", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Fix auth" });

  await service.summarizeSession({
    contentSessionId: "session-1",
    summary: `Injected <private>secret summary</private> ${"x".repeat(8_100)}`,
    last_assistant_message: "Raw assistant unsafe needle should not be persisted",
  });

  const row = service.db.prepare("SELECT summary, request FROM session_summaries WHERE content_session_id = ?").get("session-1") as { summary: string; request: string | null } | undefined;
  const search = await service.search({ query: "unsafe needle", project: "app", obs_type: "session", limit: 5 });
  expect(row?.summary).toContain("[private redacted]");
  expect(row?.summary).not.toContain("secret");
  expect(row?.request).toBe(null);
  expect(JSON.stringify({ row, search })).not.toContain("unsafe needle");
  expect((row?.summary.length ?? 0) <= 8_000).toBe(true);
});

test("summarizeSession stores structured upstream summary fields", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Implement memory parity" });

  await service.summarizeSession({
    contentSessionId: "session-1",
    summary: JSON.stringify({
      request: "Implement SQLite parity",
      investigated: "Compared upstream search and context builders",
      learned: "Session summaries need structured fields",
      completed: "Added SQLite FTS coverage",
      next_steps: "Run rare-next-step verification",
      files_read: ["temp/claude-mem-upstream/src/services/context/ContextBuilder.ts"],
      files_edited: ["agent/extensions/omp-mem/src/service.ts"],
      notes: "Keep Chroma out of scope",
    }),
  });

  const row = service.db.prepare("SELECT summary, request, investigated, learned, completed, next_steps, files_read, files_edited, notes FROM session_summaries WHERE content_session_id = ?").get("session-1") as Record<string, string>;
  const search = await service.search({ query: "rare-next-step", project: "app", obs_type: "session" });

  expect(row.summary).not.toContain("{\"");
  expect(row.request).toBe("Implement SQLite parity");
  expect(row.investigated).toBe("Compared upstream search and context builders");
  expect(row.learned).toBe("Session summaries need structured fields");
  expect(row.completed).toBe("Added SQLite FTS coverage");
  expect(row.next_steps).toBe("Run rare-next-step verification");
  expect(JSON.parse(row.files_read)).toEqual(["temp/claude-mem-upstream/src/services/context/ContextBuilder.ts"]);
  expect(JSON.parse(row.files_edited)).toEqual(["agent/extensions/omp-mem/src/service.ts"]);
  expect(row.notes).toBe("Keep Chroma out of scope");
  expect(search.results.map(result => result.ref)).toEqual(["S1"]);
});

test("session summary FTS covers direct SQLite structured fields", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });
  service.db.prepare(`
INSERT INTO session_summaries (
  content_session_id, memory_session_id, project, summary, request, investigated, learned, completed, next_steps, notes, created_at, created_at_epoch
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
    "manual-session",
    "omp-mem:manual-session",
    "app",
    "Generic direct summary",
    "Generic request",
    "Generic investigation",
    "Generic learning",
    "Generic completion",
    "Direct rare-next-step from sqlite trigger",
    "Generic notes",
    1_700_000_000,
    1_700_000_000,
  );

  const tables = new Set((service.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name));
  const search = await service.search({ query: "rare-next-step", project: "app", obs_type: "session" });

  expect(tables.has("session_summaries_fts")).toBe(true);
  expect(search.results.map(result => result.ref)).toEqual(["S1"]);
});

test("session summary FTS covers direct SQLite summary-only rows", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });
  service.db.prepare(`
INSERT INTO session_summaries (
  content_session_id, memory_session_id, project, summary, created_at
) VALUES (?, ?, ?, ?, ?)
`).run("summary-only-session", "omp-mem:summary-only-session", "app", "Direct summary-only-needle text", 1_700_000_000);

  const search = await service.search({ query: "summary-only-needle", project: "app", obs_type: "session" });

  expect(search.results.map(result => result.ref)).toEqual(["S1"]);
});

test("observation FTS rebuild indexes legacy json-only rows", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });
  service.db.prepare(`
INSERT INTO observations (
  content_session_id, project, tool_name, type, title, narrative, facts_json, files_json, concepts_json, confidence, created_at, platform_source
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
    "legacy-session",
    "app",
    "bash",
    "discovery",
    "Legacy json-only row",
    "Legacy narrative",
    JSON.stringify(["legacyfact-needle"]),
    JSON.stringify(["src/legacy.ts"]),
    JSON.stringify(["legacy-concept"]),
    "observed",
    1_700_000_000,
    "omp",
  );

  const byFact = await service.search({ query: "legacyfact-needle", project: "app" });
  const byFile = await service.search({ query: "legacy", project: "app", filePath: "src/legacy.ts" });
  const byConcept = await service.search({ query: "legacy", project: "app", concept: "legacy-concept" });

  expect(byFact.results.map(result => result.ref)).toEqual(["#1"]);
  expect(byFile.results.map(result => result.ref)).toEqual(["#1"]);
  expect(byConcept.results.map(result => result.ref)).toEqual(["#1"]);
});

test("project filters include memories adopted into the requested project", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });
  await service.initSession({ contentSessionId: "worktree-session", project: "app-worktree", prompt: "Worktree work" });
  const id = await service.recordObservation(makeObservation({ contentSessionId: "worktree-session", tool_use_id: "tool-worktree", tool_response: "Worktree auth fix" }));
  await service.summarizeSession({ contentSessionId: "worktree-session", summary: "Worktree summary should surface in parent project" });
  service.db.prepare("UPDATE observations SET merged_into_project = ? WHERE id = ?").run("app", id);
  service.db.prepare("UPDATE session_summaries SET merged_into_project = ? WHERE content_session_id = ?").run("app", "worktree-session");

  const observations = await service.search({ query: "auth", project: "app", obs_type: "observation" });
  const sessions = await service.search({ query: "summary", project: "app", obs_type: "session" });
  const details = await service.getObservations({ ids: [id], project: "app" });
  const context = await service.injectContext({ project: "app", q: "auth", limit: 5 });

  expect(observations.results.map(result => result.id)).toEqual([id]);
  expect(sessions.results.map(result => result.ref)).toEqual(["S1"]);
  expect(details.observations.map(observation => observation.id)).toEqual([id]);
  expect(context).toContain("Worktree auth fix");
});

test("flushArtifacts honors artifact max above public search cap", async () => {
  const service = await createTrackedService({
    memoryRoot: tempRoot,
    now: (() => {
      let current = 1_700_000_000;
      return () => current++;
    })(),
    config: resolveOmpMemConfig({ search: { maxLimit: 1 }, artifacts: { maxObservations: 3 } }),
  });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Work" });
  await service.recordObservation(makeObservation({ tool_use_id: "tool-1", tool_response: "First artifact detail" }));
  await service.recordObservation(makeObservation({ tool_use_id: "tool-2", tool_response: "Second artifact detail" }));
  await service.recordObservation(makeObservation({ tool_use_id: "tool-3", tool_response: "Third artifact detail" }));

  await service.flushArtifacts("app");

  const full = await fs.readFile(path.join(tempRoot, "MEMORY.md"), "utf8");
  expect(full).toContain("First artifact detail");
  expect(full).toContain("Second artifact detail");
  expect(full).toContain("Third artifact detail");
});

test("retention maxObservations prunes oldest project observations", async () => {
  const service = await createTrackedService({
    memoryRoot: tempRoot,
    now: (() => {
      let current = 1_700_000_000;
      return () => current++;
    })(),
    config: resolveOmpMemConfig({ retention: { maxObservations: 2 } }),
  });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Work" });
  await service.recordObservation(makeObservation({ tool_use_id: "tool-1", tool_response: "First retained detail" }));
  const second = await service.recordObservation(makeObservation({ tool_use_id: "tool-2", tool_response: "Second retained detail" }));
  const third = await service.recordObservation(makeObservation({ tool_use_id: "tool-3", tool_response: "Third retained detail" }));

  const search = await service.search({ project: "app", limit: 10, orderBy: "date_asc" });
  const firstSearch = await service.search({ project: "app", query: "First", limit: 10 });

  expect(search.results.map(result => result.id)).toEqual([second, third]);
  expect(firstSearch.results).toEqual([]);
});

test("summarizeSession uses configured model summary and falls back safely", async () => {
  const service = await createTrackedService({
    memoryRoot: tempRoot,
    now: () => 1_700_000_000,
    summarizeText: async () => "AI session summary for completed auth work.",
  });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Fix auth" });

  await service.summarizeSession({ contentSessionId: "session-1", last_assistant_message: "Raw assistant final message" });

  const row = service.db.prepare("SELECT summary FROM session_summaries WHERE content_session_id = ?").get("session-1") as { summary: string } | undefined;
  const search = await service.search({ query: "completed auth", project: "app", obs_type: "session" });
  expect(row?.summary).toBe("AI session summary for completed auth work.");
  expect(search.results[0]?.title).toBe("AI session summary for completed auth work.");
});
