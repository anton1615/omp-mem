import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_OMP_MEM_CONFIG, loadOmpMemConfigFromHome, resolveOmpMemConfig } from "../src/config";

let tempHome: string;

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mem-config-"));
});

afterEach(async () => {
  await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function writeHome(relativePath: string, content: string): Promise<void> {
  const filePath = path.join(tempHome, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

test("defaults expose claude-mem-like config knobs with OMP model extraction enabled", () => {
  expect(DEFAULT_OMP_MEM_CONFIG.enabled).toBe(true);
  expect(DEFAULT_OMP_MEM_CONFIG.mode).toBe("code");
  expect(DEFAULT_OMP_MEM_CONFIG.ai.source).toBe("omp");
  expect(DEFAULT_OMP_MEM_CONFIG.ai.omp.provider).toBe("current");
  expect(DEFAULT_OMP_MEM_CONFIG.ai.omp.model).toBe("current");
  expect(DEFAULT_OMP_MEM_CONFIG.ai.direct.api).toBe("openai-chat");
  expect(DEFAULT_OMP_MEM_CONFIG.capture.skipTools).toContain("memory_search");
  expect(DEFAULT_OMP_MEM_CONFIG.capture.skipTools).toContain("todo_write");
  expect(DEFAULT_OMP_MEM_CONFIG.context.observations).toBe(50);
  expect(DEFAULT_OMP_MEM_CONFIG.context.sessions).toBe(10);
  expect(DEFAULT_OMP_MEM_CONFIG.context.fullCount).toBe(5);
  expect(DEFAULT_OMP_MEM_CONFIG.context.fullField).toBe("narrative");
});

test("loads ompMem block from agent config.yml before plugin settings.json", async () => {
  await writeHome(".omp/agent/config.yml", [
    "ompMem:",
    "  enabled: true",
    "  mode: code--zh-tw",
    "  ai:",
    "    source: omp",
    "    maxTokens: 2048",
    "    omp:",
    "      provider: cliproxyapi",
    "      model: gpt-5.5",
    "  capture:",
    "    skipTools:",
    "      - bash",
    "      - memory_search",
    "  context:",
    "    observations: 80",
    "    sessions: 12",
    "    fullCount: 8",
    "  artifacts:",
    "    maxObservations: 120",
    "  search:",
    "    maxLimit: 50",
  ].join("\n"));
  await writeHome(".omp/agent/omp-mem/settings.json", JSON.stringify({
    CLAUDE_MEM_MODEL: "ignored/model",
    CLAUDE_MEM_CONTEXT_OBSERVATIONS: "5",
  }));

  const config = await loadOmpMemConfigFromHome(tempHome);

  expect(config.mode).toBe("code--zh-tw");
  expect(config.ai.source).toBe("omp");
  expect(config.ai.omp.provider).toBe("cliproxyapi");
  expect(config.ai.omp.model).toBe("gpt-5.5");
  expect(config.ai.maxTokens).toBe(2048);
  expect(config.capture.skipTools).toEqual(["bash", "memory_search"]);
  expect(config.context.observations).toBe(80);
  expect(config.context.sessions).toBe(12);
  expect(config.context.fullCount).toBe(8);
  expect(config.artifacts.maxObservations).toBe(120);
});

test("maps claude-mem-style flat settings when config.yml has no ompMem block", async () => {
  await writeHome(".omp/agent/config.yml", "other: true\n");
  await writeHome(".omp/agent/omp-mem/settings.json", JSON.stringify({
    CLAUDE_MEM_PROVIDER: "openrouter",
    CLAUDE_MEM_OPENROUTER_API_KEY: "sk-test",
    CLAUDE_MEM_OPENROUTER_MODEL: "xiaomi/mimo-v2-flash:free",
    CLAUDE_MEM_OPENROUTER_SITE_URL: "https://example.test",
    CLAUDE_MEM_OPENROUTER_APP_NAME: "omp-mem-test",
    OMP_MEM_AI_MAX_TOKENS: "2048",
    OMP_MEM_AI_FAIL_OPEN: "false",
    CLAUDE_MEM_MODE: "code--ja",
    CLAUDE_MEM_CONTEXT_OBSERVATIONS: "33",
    CLAUDE_MEM_CONTEXT_SESSION_COUNT: "7",
    CLAUDE_MEM_CONTEXT_FULL_COUNT: "4",
    CLAUDE_MEM_CONTEXT_FULL_FIELD: "facts",
    CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES: "bugfix,decision",
    CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS: "gotcha,pattern",
    CLAUDE_MEM_SKIP_TOOLS: "bash,ask,todo_write",
    CLAUDE_MEM_DATA_DIR: "D:/omp-mem-data",
  }));

  const config = await loadOmpMemConfigFromHome(tempHome);

  expect(config.dataDir?.replaceAll("\\", "/")).toBe("D:/omp-mem-data");
  expect(config.mode).toBe("code--ja");
  expect(config.ai.source).toBe("direct");
  expect(config.ai.direct.baseUrl).toBe("https://openrouter.ai/api/v1");
  expect(config.ai.direct.apiKey).toBe("sk-test");
  expect(config.ai.direct.model).toBe("xiaomi/mimo-v2-flash:free");
  expect(config.ai.direct.headers["HTTP-Referer"]).toBe("https://example.test");
  expect(config.ai.direct.headers["X-Title"]).toBe("omp-mem-test");
  expect(config.ai.maxTokens).toBe(2048);
  expect(config.ai.failOpen).toBe(false);
  expect(config.context.observations).toBe(33);
  expect(config.context.sessions).toBe(7);
  expect(config.context.fullCount).toBe(4);
  expect(config.context.fullField).toBe("facts");
  expect(config.context.types).toEqual(["bugfix", "decision"]);
  expect(config.context.concepts).toEqual(["gotcha", "pattern"]);
  expect(config.capture.skipTools).toEqual(["bash", "ask", "todo_write"]);
});

test("normalizes unsafe scalar config values back to defaults", () => {
  const config = resolveOmpMemConfig({
    enabled: "nope",
    ai: { source: "bad", maxTokens: -1, omp: { provider: "", model: "" }, direct: { api: "bad", model: "" } },
    context: { observations: 9999, sessions: 0, fullCount: -3, fullField: "bad" },
    search: { defaultLimit: 0, maxLimit: 10000 },
  });

  expect(config.enabled).toBe(DEFAULT_OMP_MEM_CONFIG.enabled);
  expect(config.ai.source).toBe(DEFAULT_OMP_MEM_CONFIG.ai.source);
  expect(config.ai.maxTokens).toBe(DEFAULT_OMP_MEM_CONFIG.ai.maxTokens);
  expect(config.context.observations).toBe(200);
  expect(config.context.sessions).toBe(1);
  expect(config.context.fullCount).toBe(0);
  expect(config.context.fullField).toBe(DEFAULT_OMP_MEM_CONFIG.context.fullField);
  expect(config.search.defaultLimit).toBe(DEFAULT_OMP_MEM_CONFIG.search.defaultLimit);
  expect(config.search.maxLimit).toBe(200);
});

test("clamps fallback search default to configured max limit", () => {
  const config = resolveOmpMemConfig({
    search: { defaultLimit: 0, maxLimit: 5 },
  });

  expect(config.search.defaultLimit).toBe(5);
  expect(config.search.maxLimit).toBe(5);
});

test("supports legacy ai.provider/model shape by splitting OMP provider and model", () => {
  const config = resolveOmpMemConfig({
    ai: { provider: "omp", model: "cliproxyapi/gpt-5.5:xhigh" } as Record<string, unknown>,
  });

  expect(config.ai.source).toBe("omp");
  expect(config.ai.omp.provider).toBe("cliproxyapi");
  expect(config.ai.omp.model).toBe("gpt-5.5:xhigh");
});

test("supports explicit direct OpenAI-compatible model config", () => {
  const config = resolveOmpMemConfig({
    ai: {
      source: "direct",
      direct: {
        baseUrl: "https://llm.example.test/v1",
        apiKeyEnv: "TEST_KEY",
        model: "memory-model",
        headers: { "X-Test": "yes", Authorization: "ignored" },
      },
    },
  });

  expect(config.ai.source).toBe("direct");
  expect(config.ai.direct.baseUrl).toBe("https://llm.example.test/v1");
  expect(config.ai.direct.apiKeyEnv).toBe("TEST_KEY");
  expect(config.ai.direct.model).toBe("memory-model");
  expect(config.ai.direct.headers).toEqual({ "X-Test": "yes" });
});

test("supports legacy OMP_MEM_AI_PROVIDER alias for source", async () => {
  await writeHome(".omp/agent/config.yml", "other: true\n");
  await writeHome(".omp/agent/omp-mem/settings.json", JSON.stringify({
    OMP_MEM_AI_PROVIDER: "heuristic",
  }));

  const config = await loadOmpMemConfigFromHome(tempHome);

  expect(config.ai.source).toBe("heuristic");
});
