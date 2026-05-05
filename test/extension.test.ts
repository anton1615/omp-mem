import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerOmpMemExtension } from "../src/extension";
import { resolveOmpMemConfig } from "../src/config";

interface FakeTool {
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>, onUpdate?: unknown, ctx?: FakeContext): Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

interface FakeContext {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getSessionName(): string | undefined;
  };
  model?: { provider: string; id: string; name?: string; api?: string };
  modelRegistry?: {
    getApiKey(model: unknown, sessionId?: string): Promise<string | undefined>;
    find?(provider: string, modelId: string): unknown;
    getAvailable?(): unknown[];
  };
}

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mem-extension-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function createFakeApi() {
  const handlers = new Map<string, Array<(event: Record<string, unknown>, ctx: FakeContext) => Promise<unknown> | unknown>>();
  const tools = new Map<string, FakeTool>();
  const commands = new Map<string, unknown>();
  const typebox = {
    Type: {
      Object: (shape: unknown) => ({ type: "object", shape }),
      String: () => ({ type: "string" }),
      Number: () => ({ type: "number" }),
      Array: (items: unknown) => ({ type: "array", items }),
      Optional: (schema: unknown) => schema,
      Union: (items: unknown[]) => ({ anyOf: items }),
      Literal: (value: unknown) => ({ const: value }),
    },
  };

  return {
    handlers,
    tools,
    commands,
    api: {
      typebox,
      logger: { warn: () => {}, error: () => {}, debug: () => {} },
      on(eventName: string, handler: (event: Record<string, unknown>, ctx: FakeContext) => Promise<unknown> | unknown) {
        handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
      },
      registerTool(tool: FakeTool) {
        tools.set(tool.name, tool);
      },
      registerCommand(name: string, command: unknown) {
        commands.set(name, command);
      },
    },
  };
}

function createContext(): FakeContext {
  return {
    cwd: "/repo/app",
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionName: () => "app-session",
    },
    model: { provider: "test", id: "model", name: "Test Model", api: "openai-responses" },
    modelRegistry: {
      getApiKey: async () => "test-api-key",
      getAvailable: () => [],
    },
  };
}

test("registers claude-mem compatible memory tools", async () => {
  const fake = createFakeApi();

  await registerOmpMemExtension(fake.api, { memoryRoot: tempRoot, dbPath: ":memory:", now: () => 1_700_000_000 });

  expect([...fake.tools.keys()].sort()).toEqual(["memory_get_observations", "memory_search", "memory_timeline"]);
  expect(fake.commands.has("mem")).toBe(true);
});

test("captures OMP prompt and tool_execution_end events then exposes progressive search", async () => {
  const fake = createFakeApi();
  const ctx = createContext();
  await registerOmpMemExtension(fake.api, { memoryRoot: tempRoot, dbPath: ":memory:", now: () => 1_700_000_000 });

  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0];
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0];
  expect(beforeAgentStart).toBeDefined();
  expect(toolExecutionEnd).toBeDefined();

  const beforeResult = await beforeAgentStart?.({ type: "before_agent_start", prompt: "Fix JWT auth", systemPrompt: "base prompt" }, ctx);
  await toolExecutionEnd?.({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "bash",
    result: {
      input: { command: "bun test auth.test.ts" },
      content: [{ type: "text", text: "Fixed JWT auth regression in src/auth.ts" }],
    },
    isError: false,
  }, ctx);

  const searchTool = fake.tools.get("memory_search");
  const getTool = fake.tools.get("memory_get_observations");
  const search = await searchTool?.execute("call-1", { query: "JWT auth", project: "app" }, undefined, ctx);
  const details = await getTool?.execute("call-2", { ids: [1] }, undefined, ctx);

  expect((beforeResult as { systemPrompt?: string }).systemPrompt).toContain("base prompt");
  expect((beforeResult as { systemPrompt?: string }).systemPrompt).toContain("Memory Guidance");
  expect(search?.content[0]?.text).toContain("#1");
  expect(search?.content[0]?.text).not.toContain("regression in src/auth.ts\n");
  expect(details?.content[0]?.text).toContain("Fixed JWT auth regression");
});

test("deduplicates tool_execution_end and tool_result for the same tool call", async () => {
  const fake = createFakeApi();
  const ctx = createContext();
  await registerOmpMemExtension(fake.api, { memoryRoot: tempRoot, dbPath: ":memory:", now: () => 1_700_000_000 });

  await fake.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "Fix JWT auth", systemPrompt: "base prompt" }, ctx);
  await fake.handlers.get("tool_execution_end")?.[0]?.({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "Fixed JWT auth regression in src/auth.ts" }] },
    isError: false,
  }, ctx);
  await fake.handlers.get("tool_result")?.[0]?.({
    type: "tool_result",
    toolCallId: "tool-1",
    toolName: "bash",
    input: { command: "bun test auth.test.ts" },
    content: [{ type: "text", text: "Fixed JWT auth regression in src/auth.ts" }],
    isError: false,
  }, ctx);

  const details = await fake.tools.get("memory_get_observations")?.execute("call-1", { ids: [1, 2] }, undefined, ctx);

  expect(details?.content[0]?.text).toContain("#1");
  expect(details?.content[0]?.text).not.toContain("#2");
});

test("uses configured OMP model extraction for captured tool observations", async () => {
  const fake = createFakeApi();
  const ctx = createContext();
  await registerOmpMemExtension(fake.api, {
    memoryRoot: tempRoot,
    dbPath: ":memory:",
    now: () => 1_700_000_000,
    config: resolveOmpMemConfig({ ai: { provider: "omp", model: "current" } }),
    completeText: async request => {
      expect(request.model.provider).toBe("test");
      expect(request.apiKey).toBe("test-api-key");
      return JSON.stringify({
        title: "Model extracted hook observation",
        narrative: "Model extracted the hook output into a concise observation.",
        type: "discovery",
        facts: ["model extraction ran"],
        files: ["agent/extensions/omp-mem/src/extension.ts"],
        concepts: ["model-extraction"],
      });
    },
  });

  await fake.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "Check model extraction", systemPrompt: "base" }, ctx);
  await fake.handlers.get("tool_execution_end")?.[0]?.({
    type: "tool_execution_end",
    toolCallId: "tool-model",
    toolName: "bash",
    result: "raw hook output",
    isError: false,
  }, ctx);

  const details = await fake.tools.get("memory_get_observations")?.execute("call-model", { ids: [1] }, undefined, ctx);

  expect(details?.content[0]?.text).toContain("Model extracted hook observation");
  expect(details?.content[0]?.text).toContain("model extraction ran");
});

test("respects configured skipped tools", async () => {
  const fake = createFakeApi();
  const ctx = createContext();
  await registerOmpMemExtension(fake.api, {
    memoryRoot: tempRoot,
    dbPath: ":memory:",
    now: () => 1_700_000_000,
    config: resolveOmpMemConfig({ capture: { skipTools: ["bash"] } }),
  });

  await fake.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "Skip bash", systemPrompt: "base" }, ctx);
  await fake.handlers.get("tool_execution_end")?.[0]?.({
    type: "tool_execution_end",
    toolCallId: "tool-skip",
    toolName: "bash",
    result: "should not be recorded",
    isError: false,
  }, ctx);

  const search = await fake.tools.get("memory_search")?.execute("call-skip", { query: "should not be recorded" }, undefined, ctx);

  expect(search?.content[0]?.text).toBe("No memory results found.");
});
