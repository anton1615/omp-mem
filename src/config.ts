import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type OmpMemAiSource = "omp" | "direct" | "heuristic";
export type OmpMemDirectApi = "openai-chat";
export type OmpMemFullField = "narrative" | "facts";

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
    source: OmpMemAiSource;
    maxTokens: number;
    failOpen: boolean;
    omp: {
      provider: string;
      model: string;
    };
    direct: {
      api: OmpMemDirectApi;
      baseUrl?: string;
      apiKey?: string;
      apiKeyEnv?: string;
      model?: string;
      headers: Record<string, string>;
    };
  };
  context: {
    enabled: boolean;
    observations: number;
    sessions: number;
    types: string[];
    concepts: string[];
    fullCount: number;
    fullField: OmpMemFullField;
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
  capture: Record<string, unknown>;
  ai: Record<string, unknown>;
  context: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  search: Record<string, unknown>;
  redaction: Record<string, unknown>;
  retention: Record<string, unknown>;
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
      "memory_remember",
      "todo_write",
      "ask",
    ]) as string[],
  }),
  ai: Object.freeze({
    source: "omp",
    maxTokens: 1024,
    failOpen: true,
    omp: Object.freeze({
      provider: "current",
      model: "current",
    }),
    direct: Object.freeze({
      api: "openai-chat",
      apiKeyEnv: "OMP_MEM_DIRECT_API_KEY",
      headers: Object.freeze({}) as Record<string, string>,
    }),
  }),
  context: Object.freeze({
    enabled: true,
    observations: 50,
    sessions: 10,
    types: [] as string[],
    concepts: [] as string[],
    fullCount: 5,
    fullField: "narrative",
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
  const source = optionalAiSource(ai.source, optionalAiSource(ai.provider, DEFAULT_OMP_MEM_CONFIG.ai.source));
  const legacyModel = optionalString(ai.model);
  const omp = resolveOmpModelConfig(getObject(ai.omp), legacyModel);
  const direct = resolveDirectModelConfig(getObject(ai.direct), ai, source, legacyModel);

  return {
    enabled: optionalBoolean(input.enabled, DEFAULT_OMP_MEM_CONFIG.enabled),
    dataDir: optionalString(input.dataDir),
    mode: optionalString(input.mode) ?? DEFAULT_OMP_MEM_CONFIG.mode,
    capture: {
      prompts: optionalBoolean(capture.prompts, DEFAULT_OMP_MEM_CONFIG.capture.prompts),
      tools: optionalBoolean(capture.tools, DEFAULT_OMP_MEM_CONFIG.capture.tools),
      agentEnd: optionalBoolean(capture.agentEnd, DEFAULT_OMP_MEM_CONFIG.capture.agentEnd),
      sessionCompact: optionalBoolean(capture.sessionCompact, DEFAULT_OMP_MEM_CONFIG.capture.sessionCompact),
      skipTools: optionalStringList(capture.skipTools) ?? [...DEFAULT_OMP_MEM_CONFIG.capture.skipTools],
    },
    ai: {
      source,
      maxTokens: positiveIntegerOrFallback(ai.maxTokens, DEFAULT_OMP_MEM_CONFIG.ai.maxTokens, 16_384),
      failOpen: optionalBoolean(ai.failOpen, DEFAULT_OMP_MEM_CONFIG.ai.failOpen),
      omp,
      direct,
    },
    context: {
      enabled: optionalBoolean(context.enabled, DEFAULT_OMP_MEM_CONFIG.context.enabled),
      observations: boundedInteger(context.observations, DEFAULT_OMP_MEM_CONFIG.context.observations, 1, 200),
      sessions: boundedInteger(context.sessions, DEFAULT_OMP_MEM_CONFIG.context.sessions, 1, 100),
      types: optionalStringList(context.types ?? context.observationTypes) ?? [...DEFAULT_OMP_MEM_CONFIG.context.types],
      concepts: optionalStringList(context.concepts ?? context.observationConcepts) ?? [...DEFAULT_OMP_MEM_CONFIG.context.concepts],
      fullCount: boundedInteger(context.fullCount, DEFAULT_OMP_MEM_CONFIG.context.fullCount, 0, 50),
      fullField: optionalFullField(context.fullField, DEFAULT_OMP_MEM_CONFIG.context.fullField),
      includeSummary: optionalBoolean(context.includeSummary, DEFAULT_OMP_MEM_CONFIG.context.includeSummary),
    },
    artifacts: {
      enabled: optionalBoolean(artifacts.enabled, DEFAULT_OMP_MEM_CONFIG.artifacts.enabled),
      writeSummary: optionalBoolean(artifacts.writeSummary, DEFAULT_OMP_MEM_CONFIG.artifacts.writeSummary),
      writeMemoryMd: optionalBoolean(artifacts.writeMemoryMd, DEFAULT_OMP_MEM_CONFIG.artifacts.writeMemoryMd),
      maxObservations: boundedInteger(artifacts.maxObservations, DEFAULT_OMP_MEM_CONFIG.artifacts.maxObservations, 1, 500),
    },
    search: {
      defaultLimit: positiveIntegerOrFallback(search.defaultLimit, DEFAULT_OMP_MEM_CONFIG.search.defaultLimit, maxLimit),
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
  if (!configured || configured === "auto") {
    return path.join(homeDir, ".omp", "agent", "omp-mem");
  }
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return path.join(homeDir, configured.slice(2));
  }
  return path.resolve(configured);
}

function resolveOmpModelConfig(input: Record<string, unknown> | undefined, legacyModel: string | undefined): OmpMemConfig["ai"]["omp"] {
  if (input) {
    return {
      provider: optionalString(input.provider) ?? DEFAULT_OMP_MEM_CONFIG.ai.omp.provider,
      model: optionalString(input.model ?? input.modelName) ?? DEFAULT_OMP_MEM_CONFIG.ai.omp.model,
    };
  }
  if (legacyModel) {
    return splitOmpModelReference(legacyModel);
  }
  return { ...DEFAULT_OMP_MEM_CONFIG.ai.omp };
}

function resolveDirectModelConfig(
  input: Record<string, unknown> | undefined,
  ai: Record<string, unknown>,
  source: OmpMemAiSource,
  legacyModel: string | undefined,
): OmpMemConfig["ai"]["direct"] {
  const direct = input ?? {};
  const model = optionalString(direct.model ?? direct.modelName ?? ai.modelName) ?? (source === "direct" ? legacyModel : undefined);
  return {
    api: optionalDirectApi(direct.api, DEFAULT_OMP_MEM_CONFIG.ai.direct.api),
    baseUrl: optionalString(direct.baseUrl ?? ai.baseUrl),
    apiKey: optionalString(direct.apiKey ?? ai.apiKey),
    apiKeyEnv: optionalString(direct.apiKeyEnv ?? ai.apiKeyEnv) ?? DEFAULT_OMP_MEM_CONFIG.ai.direct.apiKeyEnv,
    model,
    headers: sanitizeHeaders(optionalStringRecord(direct.headers ?? ai.headers) ?? DEFAULT_OMP_MEM_CONFIG.ai.direct.headers),
  };
}

function splitOmpModelReference(modelRef: string): OmpMemConfig["ai"]["omp"] {
  if (modelRef === "current") {
    return { provider: "current", model: "current" };
  }
  const slash = modelRef.indexOf("/");
  if (slash > 0) {
    return { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
  }
  return { provider: "current", model: modelRef };
}

function mapClaudeMemSettings(settings: Record<string, unknown>): OmpMemConfigInput {
  const provider = optionalString(settings.CLAUDE_MEM_PROVIDER)?.toLowerCase();
  const skipTools = parseCommaList(settings.CLAUDE_MEM_SKIP_TOOLS);
  const ai = mapClaudeMemAiSettings(provider, settings);
  return {
    dataDir: settings.CLAUDE_MEM_DATA_DIR,
    mode: settings.CLAUDE_MEM_MODE,
    capture: skipTools ? { skipTools } : undefined,
    ai,
    context: {
      observations: settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS,
      sessions: settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT,
      types: settings.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES,
      concepts: settings.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS,
      fullCount: settings.CLAUDE_MEM_CONTEXT_FULL_COUNT,
      fullField: settings.CLAUDE_MEM_CONTEXT_FULL_FIELD,
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

function mapClaudeMemAiSettings(provider: string | undefined, settings: Record<string, unknown>): Record<string, unknown> {
  if (provider === "openrouter") {
    return {
      source: "direct",
      maxTokens: settings.OMP_MEM_AI_MAX_TOKENS,
      failOpen: settings.OMP_MEM_AI_FAIL_OPEN,
      direct: {
        api: "openai-chat",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: settings.CLAUDE_MEM_OPENROUTER_API_KEY,
        apiKeyEnv: "OPENROUTER_API_KEY",
        model: settings.CLAUDE_MEM_OPENROUTER_MODEL ?? "xiaomi/mimo-v2-flash:free",
        headers: {
          "HTTP-Referer": settings.CLAUDE_MEM_OPENROUTER_SITE_URL,
          "X-Title": settings.CLAUDE_MEM_OPENROUTER_APP_NAME ?? "claude-mem",
        },
      },
    };
  }
  if (provider === "gemini") {
    return {
      source: "direct",
      maxTokens: settings.OMP_MEM_AI_MAX_TOKENS,
      failOpen: settings.OMP_MEM_AI_FAIL_OPEN,
      direct: {
        api: "openai-chat",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: settings.CLAUDE_MEM_GEMINI_API_KEY,
        apiKeyEnv: "GEMINI_API_KEY",
        model: settings.CLAUDE_MEM_GEMINI_MODEL ?? "gemini-2.5-flash-lite",
      },
    };
  }
  return {
    source: settings.OMP_MEM_AI_SOURCE ?? settings.OMP_MEM_AI_PROVIDER,
    maxTokens: settings.OMP_MEM_AI_MAX_TOKENS,
    failOpen: settings.OMP_MEM_AI_FAIL_OPEN,
    omp: {
      provider: settings.OMP_MEM_OMP_PROVIDER,
      model: settings.OMP_MEM_OMP_MODEL ?? settings.OMP_MEM_MODEL ?? settings.CLAUDE_MEM_MODEL,
    },
    direct: {
      api: settings.OMP_MEM_DIRECT_API,
      baseUrl: settings.OMP_MEM_DIRECT_BASE_URL,
      apiKey: settings.OMP_MEM_DIRECT_API_KEY,
      apiKeyEnv: settings.OMP_MEM_DIRECT_API_KEY_ENV,
      model: settings.OMP_MEM_DIRECT_MODEL,
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
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function optionalAiSource(value: unknown, fallback: OmpMemAiSource): OmpMemAiSource {
  return value === "omp" || value === "direct" || value === "heuristic" ? value : fallback;
}

function optionalDirectApi(value: unknown, fallback: OmpMemDirectApi): OmpMemDirectApi {
  return value === "openai-chat" ? value : fallback;
}

function optionalFullField(value: unknown, fallback: OmpMemFullField): OmpMemFullField {
  return value === "narrative" || value === "facts" ? value : fallback;
}

function optionalStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const result = value.map(item => optionalString(item)).filter((item): item is string => Boolean(item));
    return result.length > 0 ? result : undefined;
  }
  return parseCommaList(value);
}

function optionalStringRecord(value: unknown): Record<string, string> | undefined {
  const record = getObject(value);
  if (!record) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    const normalizedKey = optionalString(key);
    const normalizedValue = optionalString(entry);
    if (normalizedKey && normalizedValue) result[normalizedKey] = normalizedValue;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (normalized === "authorization" || normalized === "content-type") continue;
    result[key] = value;
  }
  return result;
}

function optionalNullableInteger(value: unknown, fallback: number | null, min: number, max: number): number | null {
  if (value === null) return null;
  if (value === undefined) return fallback;
  return boundedInteger(value, fallback ?? min, min, max);
}

function positiveIntegerOrFallback(value: unknown, fallback: number, max: number): number {
  const raw = typeof value === "string" ? Number(value) : value;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) {
    return Math.min(max, fallback);
  }
  return Math.min(max, Math.floor(raw));
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === "string" ? Number(value) : value;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

function parseCommaList(value: unknown): string[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const result = value.split(",").map(item => item.trim()).filter(Boolean);
  return result.length > 0 ? result : undefined;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
