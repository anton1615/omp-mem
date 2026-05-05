import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type OmpMemAiProvider = "omp" | "heuristic";

export interface OmpMemConfig {
  enabled: boolean;
  dataDir?: string;
  mode: string;
  capture: {
    prompts: boolean;
    tools: boolean;
    agentEnd: boolean;
    sessionCompact: boolean;
    skipTools: string[];
  };
  ai: {
    provider: OmpMemAiProvider;
    model: string;
    maxTokens: number;
    failOpen: boolean;
  };
  context: {
    enabled: boolean;
    observations: number;
    sessions: number;
    fullCount: number;
    includeSummary: boolean;
  };
  artifacts: {
    enabled: boolean;
    writeSummary: boolean;
    writeMemoryMd: boolean;
    maxObservations: number;
  };
  search: {
    defaultLimit: number;
    maxLimit: number;
  };
  redaction: {
    privateTag: boolean;
  };
  retention: {
    maxObservations: number | null;
    pruneDays: number | null;
  };
}

export type OmpMemConfigInput = Partial<{
  enabled: unknown;
  dataDir: unknown;
  mode: unknown;
  capture: Partial<Record<keyof OmpMemConfig["capture"], unknown>>;
  ai: Partial<Record<keyof OmpMemConfig["ai"], unknown>>;
  context: Partial<Record<keyof OmpMemConfig["context"], unknown>>;
  artifacts: Partial<Record<keyof OmpMemConfig["artifacts"], unknown>>;
  search: Partial<Record<keyof OmpMemConfig["search"], unknown>>;
  redaction: Partial<Record<keyof OmpMemConfig["redaction"], unknown>>;
  retention: Partial<Record<keyof OmpMemConfig["retention"], unknown>>;
}>;

export const DEFAULT_OMP_MEM_CONFIG: OmpMemConfig = Object.freeze({
  enabled: true,
  mode: "code",
  capture: Object.freeze({
    prompts: true,
    tools: true,
    agentEnd: true,
    sessionCompact: true,
    skipTools: Object.freeze([
      "memory_search",
      "memory_timeline",
      "memory_get_observations",
      "todo_write",
      "ask",
    ]) as string[],
  }),
  ai: Object.freeze({
    provider: "omp",
    model: "current",
    maxTokens: 1024,
    failOpen: true,
  }),
  context: Object.freeze({
    enabled: true,
    observations: 50,
    sessions: 10,
    fullCount: 5,
    includeSummary: true,
  }),
  artifacts: Object.freeze({
    enabled: true,
    writeSummary: true,
    writeMemoryMd: true,
    maxObservations: 50,
  }),
  search: Object.freeze({
    defaultLimit: 20,
    maxLimit: 100,
  }),
  redaction: Object.freeze({
    privateTag: true,
  }),
  retention: Object.freeze({
    maxObservations: null,
    pruneDays: null,
  }),
});

const THINKING_SUFFIXES = new Set(["off", "none", "minimal", "low", "medium", "high", "xhigh"]);

export async function loadOmpMemConfigFromHome(homeDir = os.homedir()): Promise<OmpMemConfig> {
  const agentConfig = await readYamlObject(path.join(homeDir, ".omp", "agent", "config.yml"));
  const ompMemBlock = getObject(agentConfig?.ompMem);
  if (ompMemBlock) {
    return resolveOmpMemConfig(ompMemBlock);
  }

  const pluginSettings = await readJsonObject(path.join(homeDir, ".omp", "agent", "omp-mem", "settings.json"));
  if (pluginSettings) {
    return resolveOmpMemConfig(mapClaudeMemSettings(pluginSettings));
  }

  return resolveOmpMemConfig({});
}

export function resolveOmpMemConfig(input: OmpMemConfigInput = {}): OmpMemConfig {
  const capture = getObject(input.capture) ?? {};
  const ai = getObject(input.ai) ?? {};
  const context = getObject(input.context) ?? {};
  const artifacts = getObject(input.artifacts) ?? {};
  const search = getObject(input.search) ?? {};
  const redaction = getObject(input.redaction) ?? {};
  const retention = getObject(input.retention) ?? {};

  const maxLimit = boundedInteger(search.maxLimit, DEFAULT_OMP_MEM_CONFIG.search.maxLimit, 1, 200);

  return {
    enabled: optionalBoolean(input.enabled, DEFAULT_OMP_MEM_CONFIG.enabled),
    dataDir: optionalString(input.dataDir),
    mode: optionalString(input.mode) ?? DEFAULT_OMP_MEM_CONFIG.mode,
    capture: {
      prompts: optionalBoolean(capture.prompts, DEFAULT_OMP_MEM_CONFIG.capture.prompts),
      tools: optionalBoolean(capture.tools, DEFAULT_OMP_MEM_CONFIG.capture.tools),
      agentEnd: optionalBoolean(capture.agentEnd, DEFAULT_OMP_MEM_CONFIG.capture.agentEnd),
      sessionCompact: optionalBoolean(capture.sessionCompact, DEFAULT_OMP_MEM_CONFIG.capture.sessionCompact),
      skipTools: optionalStringArray(capture.skipTools) ?? [...DEFAULT_OMP_MEM_CONFIG.capture.skipTools],
    },
    ai: {
      provider: optionalProvider(ai.provider, DEFAULT_OMP_MEM_CONFIG.ai.provider),
      model: normalizeModelReference(optionalString(ai.model) ?? DEFAULT_OMP_MEM_CONFIG.ai.model),
      maxTokens: boundedInteger(ai.maxTokens, DEFAULT_OMP_MEM_CONFIG.ai.maxTokens, 1, 16_384),
      failOpen: optionalBoolean(ai.failOpen, DEFAULT_OMP_MEM_CONFIG.ai.failOpen),
    },
    context: {
      enabled: optionalBoolean(context.enabled, DEFAULT_OMP_MEM_CONFIG.context.enabled),
      observations: boundedInteger(context.observations, DEFAULT_OMP_MEM_CONFIG.context.observations, 1, 200),
      sessions: boundedInteger(context.sessions, DEFAULT_OMP_MEM_CONFIG.context.sessions, 1, 100),
      fullCount: boundedInteger(context.fullCount, DEFAULT_OMP_MEM_CONFIG.context.fullCount, 0, 50),
      includeSummary: optionalBoolean(context.includeSummary, DEFAULT_OMP_MEM_CONFIG.context.includeSummary),
    },
    artifacts: {
      enabled: optionalBoolean(artifacts.enabled, DEFAULT_OMP_MEM_CONFIG.artifacts.enabled),
      writeSummary: optionalBoolean(artifacts.writeSummary, DEFAULT_OMP_MEM_CONFIG.artifacts.writeSummary),
      writeMemoryMd: optionalBoolean(artifacts.writeMemoryMd, DEFAULT_OMP_MEM_CONFIG.artifacts.writeMemoryMd),
      maxObservations: boundedInteger(artifacts.maxObservations, DEFAULT_OMP_MEM_CONFIG.artifacts.maxObservations, 1, 500),
    },
    search: {
      defaultLimit: boundedInteger(search.defaultLimit, DEFAULT_OMP_MEM_CONFIG.search.defaultLimit, 1, maxLimit),
      maxLimit,
    },
    redaction: {
      privateTag: optionalBoolean(redaction.privateTag, DEFAULT_OMP_MEM_CONFIG.redaction.privateTag),
    },
    retention: {
      maxObservations: optionalNullableInteger(retention.maxObservations, DEFAULT_OMP_MEM_CONFIG.retention.maxObservations, 1, Number.MAX_SAFE_INTEGER),
      pruneDays: optionalNullableInteger(retention.pruneDays, DEFAULT_OMP_MEM_CONFIG.retention.pruneDays, 1, Number.MAX_SAFE_INTEGER),
    },
  };
}

export function resolveDataDir(homeDir: string, configured?: string): string {
  if (!configured) {
    return path.join(homeDir, ".omp", "agent", "omp-mem");
  }
  if (configured === "auto") {
    return path.join(homeDir, ".omp", "agent", "omp-mem");
  }
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return path.join(homeDir, configured.slice(2));
  }
  return path.resolve(configured);
}

function mapClaudeMemSettings(settings: Record<string, unknown>): OmpMemConfigInput {
  const skipTools = parseCommaList(settings.CLAUDE_MEM_SKIP_TOOLS);
  return {
    dataDir: settings.CLAUDE_MEM_DATA_DIR,
    mode: settings.CLAUDE_MEM_MODE,
    capture: skipTools ? { skipTools } : undefined,
    ai: {
      provider: settings.OMP_MEM_AI_PROVIDER,
      model: settings.OMP_MEM_MODEL ?? settings.CLAUDE_MEM_MODEL,
      maxTokens: settings.OMP_MEM_AI_MAX_TOKENS,
      failOpen: settings.OMP_MEM_AI_FAIL_OPEN,
    },
    context: {
      observations: settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS,
      sessions: settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT,
      fullCount: settings.CLAUDE_MEM_CONTEXT_FULL_COUNT,
      includeSummary: settings.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY,
    },
    search: {
      defaultLimit: settings.OMP_MEM_SEARCH_DEFAULT_LIMIT,
      maxLimit: settings.OMP_MEM_SEARCH_MAX_LIMIT,
    },
    artifacts: {
      maxObservations: settings.OMP_MEM_ARTIFACT_MAX_OBSERVATIONS,
    },
  };
}

async function readYamlObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = Bun.YAML.parse(text);
    return getObject(parsed);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return getObject(JSON.parse(text));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function optionalProvider(value: unknown, fallback: OmpMemAiProvider): OmpMemAiProvider {
  return value === "omp" || value === "heuristic" ? value : fallback;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = value.map(item => optionalString(item)).filter((item): item is string => Boolean(item));
  return result.length > 0 ? result : undefined;
}

function optionalNullableInteger(value: unknown, fallback: number | null, min: number, max: number): number | null {
  if (value === null) return null;
  if (value === undefined) return fallback;
  return boundedInteger(value, fallback ?? min, min, max);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === "string" ? Number(value) : value;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

function parseCommaList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return optionalStringArray(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const result = value.split(",").map(item => item.trim()).filter(Boolean);
  return result.length > 0 ? result : undefined;
}

function normalizeModelReference(model: string): string {
  const separator = model.lastIndexOf(":");
  if (separator === -1) return model;
  const suffix = model.slice(separator + 1).toLowerCase();
  if (!THINKING_SUFFIXES.has(suffix)) return model;
  return model;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
