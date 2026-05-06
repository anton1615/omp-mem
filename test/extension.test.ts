import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerOmpMemExtension } from "../src/extension";
import { resolveOmpMemConfig } from "../src/config";

interface FakeTool {
  name: string;
  parameters?: unknown;
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
      Boolean: () => ({ type: "boolean" }),
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

function createContext(withModel = false): FakeContext {
  return {
    cwd: "/repo/app",
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionName: () => "app-session",
    },
    ...(withModel ? {
      model: { provider: "test", id: "model", name: "Test Model", api: "openai-responses" },
      modelRegistry: {
        getApiKey: async () => "test-api-key",
        getAvailable: () => [],
      },
    } : {}),
  };
}

test("registers claude-mem compatible memory tools", async () => {
  const fake = createFakeApi();

  await registerOmpMemExtension(fake.api, { memoryRoot: tempRoot, dbPath: ":memory:", now: () => 1_700_000_000 });

  expect([...fake.tools.keys()].sort()).toEqual(["memory_get_observations", "memory_remember", "memory_search", "memory_timeline"]);
  expect(fake.commands.has("mem")).toBe(true);
});

test("memory_search schema exposes folder file filter", async () => {
  const fake = createFakeApi();

  await registerOmpMemExtension(fake.api, { memoryRoot: tempRoot, dbPath: ":memory:", now: () => 1_700_000_000 });

  const parameters = fake.tools.get("memory_search")?.parameters as { shape?: Record<string, unknown> } | undefined;
  expect(parameters?.shape?.isFolder).toEqual({ type: "boolean" });
});

test("memory_remember stores manual memory through local tool", async () => {
  const fake = createFakeApi();
  const ctx = createContext();
  await registerOmpMemExtension(fake.api, { memoryRoot: tempRoot, dbPath: ":memory:", now: () => 1_700_000_000 });

  const remember = await fake.tools.get("memory_remember")?.execute("remember-1", {
    text: "Manual memory beta <private>secret</private>",
    title: "Manual beta",
    project: "app",
    metadata: { source: "extension-test" },
  }, undefined, ctx);
  const details = await fake.tools.get("memory_get_observations")?.execute("details-1", { ids: [1], project: "app" }, undefined, ctx);

  expect(remember?.content[0]?.text).toContain("Memory saved as observation #1");
  expect(details?.content[0]?.text).toContain("Manual beta");
  expect(details?.content[0]?.text).toContain("Manual memory beta");
  expect(details?.content[0]?.text).not.toContain("secret");
});

test("captures OMP prompt and tool_execution_end events then exposes progressive search", async () => {
  const fake = createFakeApi();
  const ctx = createContext();
  await registerOmpMemExtension(fake.api, { memoryRoot: tempRoot, dbPath: ":memory:", now: () => 1_700_000_000 });

  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0];
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0];
  expect(beforeAgentStart).toBeDefined();
  expect(toolExecutionEnd).toBeDefined();

  const beforeResult = await beforeAgentStart?.({ type: "before_agent_start", prompt: "Fix JWT auth", systemPrompt: ["base prompt"] }, ctx);
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

  const beforeSystemPrompt = (beforeResult as { systemPrompt?: unknown }).systemPrompt;
  expect(Array.isArray(beforeSystemPrompt)).toBe(true);
  expect((beforeSystemPrompt as string[])[0]).toBe("base prompt");
  expect((beforeSystemPrompt as string[]).join("\n\n")).toContain("Memory Guidance");
  expect(search?.content[0]?.text).toContain("#1");
  expect(search?.content[0]?.text).not.toContain("regression in src/auth.ts\n");
  expect(details?.content[0]?.text).toContain("Fixed JWT auth regression");
});

test("before_agent_start does not return legacy string systemPrompt when context is disabled", async () => {
  const fake = createFakeApi();
  const ctx = createContext();
  await registerOmpMemExtension(fake.api, {
    memoryRoot: tempRoot,
    dbPath: ":memory:",
    now: () => 1_700_000_000,
    config: resolveOmpMemConfig({ context: { enabled: false } }),
  });

  const beforeResult = await fake.handlers.get("before_agent_start")?.[0]?.({
    type: "before_agent_start",
    prompt: "No injected memory",
    systemPrompt: ["base prompt"],
  }, ctx);

  expect(beforeResult).toBe(undefined);
});

test("deduplicates tool_execution_end and tool_result for the same tool call", async () => {
  const fake = createFakeApi();
  const ctx = createContext();
  await registerOmpMemExtension(fake.api, { memoryRoot: tempRoot, dbPath: ":memory:", now: () => 1_700_000_000 });

  await fake.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "Fix JWT auth", systemPrompt: ["base prompt"] }, ctx);
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
  const ctx = createContext(true);
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

  await fake.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "Check model extraction", systemPrompt: ["base"] }, ctx);
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

test("uses configured OMP provider and model name instead of current model shorthand", async () => {
  const fake = createFakeApi();
  const ctx = createContext(true);
  ctx.modelRegistry = {
    getApiKey: async model => {
      expect((model as { provider: string }).provider).toBe("cliproxyapi");
      return "registry-key";
    },
    find: (provider, modelId) => ({ provider, id: modelId, name: modelId, api: "openai-responses" }),
    getAvailable: () => [],
  };
  await registerOmpMemExtension(fake.api, {
    memoryRoot: tempRoot,
    dbPath: ":memory:",
    now: () => 1_700_000_000,
    config: resolveOmpMemConfig({ ai: { source: "omp", omp: { provider: "cliproxyapi", model: "memory-model" } } }),
    completeText: async request => {
      expect(request.source).toBe("omp");
      expect(request.model.provider).toBe("cliproxyapi");
      expect(request.model.id).toBe("memory-model");
      expect(request.apiKey).toBe("registry-key");
      return JSON.stringify({ title: "Configured OMP model", narrative: "Configured OMP model ran." });
    },
  });

  await fake.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "Use configured model", systemPrompt: ["base"] }, ctx);
  await fake.handlers.get("tool_execution_end")?.[0]?.({
    type: "tool_execution_end",
    toolCallId: "tool-configured-model",
    toolName: "bash",
    result: "configured model output",
    isError: false,
  }, ctx);

  const details = await fake.tools.get("memory_get_observations")?.execute("call-configured-model", { ids: [1] }, undefined, ctx);
  expect(details?.content[0]?.text).toContain("Configured OMP model");
});

test("uses direct OpenAI-compatible model config without OMP registry", async () => {
  const fake = createFakeApi();
  const ctx = createContext(false);
  await registerOmpMemExtension(fake.api, {
    memoryRoot: tempRoot,
    dbPath: ":memory:",
    now: () => 1_700_000_000,
    config: resolveOmpMemConfig({
      ai: {
        source: "direct",
        direct: {
          baseUrl: "https://llm.example.test/v1",
          apiKey: "direct-key",
          model: "direct-memory-model",
          headers: { "X-Test": "yes" },
        },
      },
    }),
    completeText: async request => {
      expect(request.source).toBe("direct");
      expect(request.baseUrl).toBe("https://llm.example.test/v1");
      expect(request.apiKey).toBe("direct-key");
      expect(request.model.provider).toBe("direct");
      expect(request.model.id).toBe("direct-memory-model");
      expect(request.headers).toEqual({ "X-Test": "yes" });
      return JSON.stringify({ title: "Direct model", narrative: "Direct model ran." });
    },
  });

  await fake.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "Use direct model", systemPrompt: ["base"] }, ctx);
  await fake.handlers.get("tool_execution_end")?.[0]?.({
    type: "tool_execution_end",
    toolCallId: "tool-direct-model",
    toolName: "bash",
    result: "direct model output",
    isError: false,
  }, ctx);

  const details = await fake.tools.get("memory_get_observations")?.execute("call-direct-model", { ids: [1] }, undefined, ctx);
  expect(details?.content[0]?.text).toContain("Direct model");
});

test("redacts private spans before model extraction", async () => {
  const fake = createFakeApi();
  const ctx = createContext(true);
  const prompts: string[] = [];
  await registerOmpMemExtension(fake.api, {
    memoryRoot: tempRoot,
    dbPath: ":memory:",
    now: () => 1_700_000_000,
    config: resolveOmpMemConfig({ ai: { provider: "omp", model: "current" } }),
    completeText: async request => {
      prompts.push(request.prompt);
      return request.kind === "session-summary"
        ? "Safe session summary"
        : JSON.stringify({
          title: "Redacted observation",
          narrative: "Only public details were sent to the model.",
        });
    },
  });

  await fake.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "Check redaction", systemPrompt: ["base"] }, ctx);
  await fake.handlers.get("tool_execution_end")?.[0]?.({
    type: "tool_execution_end",
    toolCallId: "tool-private",
    toolName: "bash",
    result: "public output\n<private>secret token</private>",
    isError: false,
  }, ctx);

  await fake.handlers.get("agent_end")?.[0]?.({
    type: "agent_end",
    messages: [{ content: "Final <private>secret token</private> response" }],
  }, ctx);

  expect(prompts).toHaveLength(2);
  for (const prompt of prompts) {
    expect(prompt).toContain("[private redacted]");
    expect(prompt).not.toContain("secret token");
  }
});

test("clamps tool output before model extraction prompt", async () => {
  const fake = createFakeApi();
  const ctx = createContext(true);
  let prompt = "";
  await registerOmpMemExtension(fake.api, {
    memoryRoot: tempRoot,
    dbPath: ":memory:",
    now: () => 1_700_000_000,
    config: resolveOmpMemConfig({ ai: { provider: "omp", model: "current" } }),
    completeText: async request => {
      prompt = request.prompt;
      return JSON.stringify({ title: "Clamped observation", narrative: "The prompt was bounded." });
    },
  });

  await fake.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "Clamp", systemPrompt: ["base"] }, ctx);
  await fake.handlers.get("tool_execution_end")?.[0]?.({
    type: "tool_execution_end",
    toolCallId: "tool-large",
    toolName: "bash",
    result: `${"x".repeat(9_000)}TAIL_MARKER`,
    isError: false,
  }, ctx);

  expect(prompt).not.toContain("TAIL_MARKER");
});

test("clamps session summary before model prompt", async () => {
  const fake = createFakeApi();
  const ctx = createContext(true);
  let prompt = "";
  await registerOmpMemExtension(fake.api, {
    memoryRoot: tempRoot,
    dbPath: ":memory:",
    now: () => 1_700_000_000,
    config: resolveOmpMemConfig({ ai: { provider: "omp", model: "current" } }),
    completeText: async request => {
      if (request.kind === "session-summary") prompt = request.prompt;
      return request.kind === "session-summary"
        ? "Clamped summary"
        : JSON.stringify({ title: "Observation", narrative: "Observation" });
    },
  });

  await fake.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "Clamp summary", systemPrompt: ["base"] }, ctx);
  await fake.handlers.get("agent_end")?.[0]?.({
    type: "agent_end",
    messages: [{ content: `${"x".repeat(9_000)}TAIL_MARKER` }],
  }, ctx);

  expect(prompt).not.toContain("TAIL_MARKER");
});

test("falls back when model API key lookup fails open", async () => {
  const fake = createFakeApi();
  const ctx = createContext(true);
  ctx.modelRegistry = {
    getApiKey: async () => { throw new Error("missing key"); },
    getAvailable: () => [],
  };
  await registerOmpMemExtension(fake.api, {
    memoryRoot: tempRoot,
    dbPath: ":memory:",
    now: () => 1_700_000_000,
    config: resolveOmpMemConfig({ ai: { provider: "omp", model: "current", failOpen: true } }),
    completeText: async () => {
      throw new Error("should not call completion without API key");
    },
  });

  await fake.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "Fallback", systemPrompt: ["base"] }, ctx);
  await fake.handlers.get("tool_execution_end")?.[0]?.({
    type: "tool_execution_end",
    toolCallId: "tool-fallback",
    toolName: "bash",
    result: "heuristic fallback output",
    isError: false,
  }, ctx);

  const details = await fake.tools.get("memory_get_observations")?.execute("call-fallback", { ids: [1] }, undefined, ctx);

  expect(details?.content[0]?.text).toContain("heuristic fallback output");
});

test("throws when model lookup fails closed", async () => {
  const fake = createFakeApi();
  const ctx = createContext();
  await registerOmpMemExtension(fake.api, {
    memoryRoot: tempRoot,
    dbPath: ":memory:",
    now: () => 1_700_000_000,
    config: resolveOmpMemConfig({ ai: { provider: "omp", model: "current", failOpen: false } }),
  });

  await fake.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "Fail closed", systemPrompt: ["base"] }, ctx);
  let message = "";
  try {
    await fake.handlers.get("tool_execution_end")?.[0]?.({
      type: "tool_execution_end",
      toolCallId: "tool-fail-closed-model",
      toolName: "bash",
      result: "must not silently fallback",
      isError: false,
    }, ctx);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toContain("model not available");
});

test("throws when API key lookup returns empty and failOpen is false", async () => {
  const fake = createFakeApi();
  const ctx = createContext(true);
  ctx.modelRegistry = {
    getApiKey: async () => undefined,
    getAvailable: () => [],
  };
  await registerOmpMemExtension(fake.api, {
    memoryRoot: tempRoot,
    dbPath: ":memory:",
    now: () => 1_700_000_000,
    config: resolveOmpMemConfig({ ai: { provider: "omp", model: "current", failOpen: false } }),
  });

  await fake.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "Fail closed key", systemPrompt: ["base"] }, ctx);
  let message = "";
  try {
    await fake.handlers.get("tool_execution_end")?.[0]?.({
      type: "tool_execution_end",
      toolCallId: "tool-fail-closed-key",
      toolName: "bash",
      result: "must not silently fallback",
      isError: false,
    }, ctx);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toContain("API key not available");
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

  await fake.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "Skip bash", systemPrompt: ["base"] }, ctx);
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
