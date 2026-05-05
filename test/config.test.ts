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
  expect(DEFAULT_OMP_MEM_CONFIG.ai.provider).toBe("omp");
  expect(DEFAULT_OMP_MEM_CONFIG.ai.model).toBe("current");
  expect(DEFAULT_OMP_MEM_CONFIG.capture.skipTools).toContain("memory_search");
  expect(DEFAULT_OMP_MEM_CONFIG.capture.skipTools).toContain("todo_write");
  expect(DEFAULT_OMP_MEM_CONFIG.context.observations).toBe(50);
  expect(DEFAULT_OMP_MEM_CONFIG.context.sessions).toBe(10);
  expect(DEFAULT_OMP_MEM_CONFIG.context.fullCount).toBe(5);
});

test("loads ompMem block from agent config.yml before plugin settings.json", async () => {
  await writeHome(".omp/agent/config.yml", [
    "ompMem:",
    "  enabled: true",
    "  mode: code--zh-tw",
    "  ai:",
    "    provider: omp",
    "    model: cliproxyapi/gpt-5.5:xhigh",
    "    maxTokens: 2048",
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
  ].join("\n"));
  await writeHome(".omp/agent/omp-mem/settings.json", JSON.stringify({
    CLAUDE_MEM_MODEL: "ignored/model",
    CLAUDE_MEM_CONTEXT_OBSERVATIONS: "5",
  }));

  const config = await loadOmpMemConfigFromHome(tempHome);

  expect(config.mode).toBe("code--zh-tw");
  expect(config.ai.model).toBe("cliproxyapi/gpt-5.5:xhigh");
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
    CLAUDE_MEM_MODEL: "google/gemini-2.5-flash",
    CLAUDE_MEM_MODE: "code--ja",
    CLAUDE_MEM_CONTEXT_OBSERVATIONS: "33",
    CLAUDE_MEM_CONTEXT_SESSION_COUNT: "7",
    CLAUDE_MEM_CONTEXT_FULL_COUNT: "4",
    CLAUDE_MEM_SKIP_TOOLS: "bash,ask,todo_write",
    CLAUDE_MEM_DATA_DIR: "D:/omp-mem-data",
  }));

  const config = await loadOmpMemConfigFromHome(tempHome);

  expect(config.dataDir?.replaceAll("\\", "/")).toBe("D:/omp-mem-data");
  expect(config.mode).toBe("code--ja");
  expect(config.ai.model).toBe("google/gemini-2.5-flash");
  expect(config.context.observations).toBe(33);
  expect(config.context.sessions).toBe(7);
  expect(config.context.fullCount).toBe(4);
  expect(config.capture.skipTools).toEqual(["bash", "ask", "todo_write"]);
});

test("normalizes unsafe scalar config values back to defaults", () => {
  const config = resolveOmpMemConfig({
    enabled: "nope",
    ai: { provider: "bad", maxTokens: -1 },
    context: { observations: 9999, sessions: 0, fullCount: -3 },
    search: { defaultLimit: 0, maxLimit: 10000 },
  });

  expect(config.enabled).toBe(DEFAULT_OMP_MEM_CONFIG.enabled);
  expect(config.ai.provider).toBe(DEFAULT_OMP_MEM_CONFIG.ai.provider);
  expect(config.ai.maxTokens).toBe(DEFAULT_OMP_MEM_CONFIG.ai.maxTokens);
  expect(config.context.observations).toBe(200);
  expect(config.context.sessions).toBe(1);
  expect(config.context.fullCount).toBe(0);
  expect(config.search.defaultLimit).toBe(DEFAULT_OMP_MEM_CONFIG.search.defaultLimit);
  expect(config.search.maxLimit).toBe(200);
});
