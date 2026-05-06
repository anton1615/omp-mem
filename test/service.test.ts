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

test("obs_type prompt filter does not leak tool observations", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Fix auth" });
  await service.recordObservation(makeObservation());

  const search = await service.search({ project: "app", obs_type: "prompt", limit: 5 });

  expect(search.results).toEqual([]);
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

test("recordObservation redacts extracted files and concepts", async () => {
  const service = await createTrackedService({
    memoryRoot: tempRoot,
    now: () => 1_700_000_000,
    extractObservation: async () => ({
      title: "Safe title",
      narrative: "Safe narrative",
      files: ["src/auth.ts", "<private>secret/path.ts</private>"],
      concepts: ["auth", "<private>secret concept</private>"],
      facts: ["safe fact"],
    }),
  });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Fix auth" });

  const id = await service.recordObservation(makeObservation());
  const observation = (await service.getObservations({ ids: [id] })).observations[0];

  expect(observation?.files.join(" ")).not.toContain("secret");
  expect(observation?.concepts.join(" ")).not.toContain("secret");
});

test("summarizeSession accepts injected summary without raw assistant text", async () => {
  const service = await createTrackedService({ memoryRoot: tempRoot, now: () => 1_700_000_000 });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Fix auth" });

  await service.summarizeSession({ contentSessionId: "session-1", summary: "Injected session summary." });

  const row = service.db.prepare("SELECT summary FROM session_summaries WHERE content_session_id = ?").get("session-1") as { summary: string } | undefined;
  expect(row?.summary).toBe("Injected session summary.");
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
  expect(row?.summary).toBe("AI session summary for completed auth work.");
});
