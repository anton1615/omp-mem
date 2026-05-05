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

test("recordObservation prefers configured model extraction over heuristic fields", async () => {
  const service = await createTrackedService({
    memoryRoot: tempRoot,
    now: () => 1_700_000_000,
    extractObservation: async () => ({
      title: "AI extracted auth decision",
      narrative: "AI says JWT refresh was fixed by rotating expired credentials.",
      type: "decision",
      facts: ["JWT refresh failure fixed"],
      files: ["src/auth.ts"],
      concepts: ["jwt", "refresh"],
      confidence: "inferred",
    }),
  });
  await service.initSession({ contentSessionId: "session-1", project: "app", prompt: "Fix auth" });

  const id = await service.recordObservation(makeObservation());
  const observation = (await service.getObservations({ ids: [id] })).observations[0];

  expect(observation?.title).toBe("AI extracted auth decision");
  expect(observation?.narrative).toContain("AI says JWT refresh");
  expect(observation?.type).toBe("decision");
  expect(observation?.facts).toEqual(["JWT refresh failure fixed"]);
  expect(observation?.files).toEqual(["src/auth.ts"]);
  expect(observation?.concepts).toEqual(["jwt", "refresh"]);
  expect(observation?.confidence).toBe("inferred");
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
