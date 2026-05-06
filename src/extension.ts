import * as os from "node:os";
import {
  createMemoryService,
  formatMemoryGetResponse,
  formatMemorySearchResponse,
  formatMemoryTimelineResponse,
  resolveMemoryRoot,
  type GetObservationsRequest,
  type MemoryService,
  type MemoryServiceOptions,
  type ObservationExtractionRequest,
  type ObservationExtractionResult,
  type SearchRequest,
  type SessionSummaryRequest,
  type TimelineRequest,
} from "./service";
import { loadOmpMemConfigFromHome, resolveDataDir, type OmpMemConfig } from "./config";

export interface OmpMemModelRequest {
  kind: "observation" | "session-summary";
  source: "omp" | "direct";
  model: ModelLike;
  apiKey: string;
  prompt: string;
  maxTokens: number;
  ctx: ExtensionContext;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export interface OmpMemExtensionOptions extends Partial<MemoryServiceOptions> {
  homeDir?: string;
  config?: OmpMemConfig;
  completeText?: (request: OmpMemModelRequest) => Promise<string>;
}

interface ExtensionAPI {
  typebox: {
    Type: {
      Object(shape: Record<string, unknown>): unknown;
      String(options?: Record<string, unknown>): unknown;
      Number(options?: Record<string, unknown>): unknown;
      Boolean(options?: Record<string, unknown>): unknown;
      Array(items: unknown, options?: Record<string, unknown>): unknown;
      Optional(schema: unknown): unknown;
      Union?(items: unknown[]): unknown;
      Literal?(value: unknown): unknown;
    };
  };
  logger?: {
    warn?(message: string, details?: Record<string, unknown>): void;
    error?(message: string, details?: Record<string, unknown>): void;
    debug?(message: string, details?: Record<string, unknown>): void;
  };
  on(eventName: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown> | unknown): void;
  registerTool(tool: ToolDefinition): void;
  registerCommand(
    name: string,
    command: { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
  ): void;
}

interface ModelLike {
  provider: string;
  id: string;
  name?: string;
  api?: string;
}

interface ModelRegistryLike {
  getApiKey(model: unknown, sessionId?: string): Promise<string | undefined>;
  find?(provider: string, modelId: string): unknown;
  resolveCanonicalModel?(canonicalId: string, options?: { availableOnly?: boolean }): unknown;
  getAvailable?(): unknown[];
}
interface ExtensionContext {
  cwd?: string;
  ui?: {
    notify?(message: string, type?: "info" | "warning" | "error"): void;
  };
  sessionManager?: {
    getSessionId(): string;
    getSessionName?(): string | undefined;
  };
  model?: ModelLike;
  modelRegistry?: ModelRegistryLike;
}

interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    onUpdate: unknown,
    ctx: ExtensionContext | undefined,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
}

const SELF_TOOL_NAMES = new Set(["memory_search", "memory_timeline", "memory_get_observations", "memory_remember"]);

export default async function ompMemExtension(pi: ExtensionAPI): Promise<void> {
  await registerOmpMemExtension(pi);
}

export async function registerOmpMemExtension(pi: ExtensionAPI, options: OmpMemExtensionOptions = {}): Promise<void> {
  const config = options.config ?? await loadOmpMemConfigFromHome(options.homeDir);
  if (!config.enabled) {
    pi.logger?.debug?.("omp-mem disabled by config");
    return;
  }

  const services = new Map<string, Promise<MemoryService>>();
  const capturedToolCallIds = new Set<string>();
  const getService = async (ctx?: ExtensionContext): Promise<MemoryService> => {
    const cwd = ctx?.cwd ?? process.cwd();
    const dataDir = resolveDataDir(options.homeDir ?? os.homedir(), config.dataDir);
    const memoryRoot = options.memoryRoot ?? resolveMemoryRoot({ cwd, homeDir: options.homeDir, dataDir });
    const existing = services.get(memoryRoot);
    if (existing) return existing;
    const created = createMemoryService({
      memoryRoot,
      dbPath: options.dbPath,
      now: options.now,
      config,
      extractObservation: options.extractObservation,
      summarizeText: options.summarizeText,
    });
    services.set(memoryRoot, created);
    return created;
  };

  registerMemoryTools(pi, getService);
  registerMemoryCommand(pi, getService);

  pi.on("session_start", async (_event, ctx) => {
    await getService(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const service = await getService(ctx);
    const contentSessionId = getContentSessionId(ctx);
    const project = getProjectName(ctx);
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    await service.initSession({
      contentSessionId,
      project,
      prompt: config.capture.prompts ? prompt : "",
      platformSource: "omp",
      customTitle: ctx.sessionManager?.getSessionName?.(),
    });
    const memoryContext = await service.injectContext({ project, q: prompt, limit: config.context.observations });
    if (!memoryContext) return undefined;
    return { systemPrompt: [...normalizeSystemPrompts(event.systemPrompt), memoryContext] };
  });

  const recordToolEvent = async (
    event: Record<string, unknown>,
    ctx: ExtensionContext,
    toolInput: unknown,
    toolResponse: unknown,
  ) => {
    const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
    if (!config.capture.tools) return;
    if (SELF_TOOL_NAMES.has(toolName) || config.capture.skipTools.includes(toolName)) return;
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    if (toolCallId && capturedToolCallIds.has(toolCallId)) return;
    if (toolCallId) {
      if (capturedToolCallIds.size > 1000) capturedToolCallIds.clear();
      capturedToolCallIds.add(toolCallId);
    }
    const service = await getService(ctx);
    const contentSessionId = getContentSessionId(ctx);
    const project = getProjectName(ctx);
    const platformSource = "omp";
    const extraction = await extractObservationWithModel(ctx, config, {
      contentSessionId,
      project,
      toolName,
      toolInput,
      toolResponse,
      cwd: ctx.cwd,
      platformSource,
      completeText: options.completeText,
      logger: pi.logger,
    });
    await service.recordObservation({
      contentSessionId,
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      cwd: ctx.cwd,
      platformSource,
      tool_use_id: toolCallId,
      extraction,
    });
    await service.flushArtifacts(getProjectName(ctx));
  };

  pi.on("tool_result", async (event, ctx) => {
    await recordToolEvent(event, ctx, event.input, extractToolResponse(event.content));
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    if (toolCallId && capturedToolCallIds.has(toolCallId)) return;
    const result = event.result;
    const resultRecord = result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
    await recordToolEvent(
      event,
      ctx,
      resultRecord?.input,
      resultRecord && "content" in resultRecord ? extractToolResponse(resultRecord.content) : result,
    );
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!config.capture.agentEnd) return;
    const service = await getService(ctx);
    const contentSessionId = getContentSessionId(ctx);
    const project = getProjectName(ctx);
    const lastAssistantMessage = extractAgentEndText(event.messages);
    const summary = await summarizeSessionWithModel(ctx, config, {
      contentSessionId,
      project,
      lastAssistantMessage,
      platformSource: "omp",
      completeText: options.completeText,
      logger: pi.logger,
    });
    await service.summarizeSession({
      contentSessionId,
      last_assistant_message: lastAssistantMessage,
      summary,
      platformSource: "omp",
    });
  });

  pi.on("session_compact", async (event, ctx) => {
    if (!config.capture.sessionCompact) return;
    const service = await getService(ctx);
    const contentSessionId = getContentSessionId(ctx);
    const project = getProjectName(ctx);
    const platformSource = "omp";
    const toolInput = { fromExtension: event.fromExtension };
    const toolResponse = event.compactionEntry;
    const extraction = await extractObservationWithModel(ctx, config, {
      contentSessionId,
      project,
      toolName: "session_compact",
      toolInput,
      toolResponse,
      cwd: ctx.cwd,
      platformSource,
      completeText: options.completeText,
      logger: pi.logger,
    });
    await service.recordObservation({
      contentSessionId,
      tool_name: "session_compact",
      tool_input: toolInput,
      tool_response: toolResponse,
      cwd: ctx.cwd,
      platformSource,
      extraction,
    });
    await service.flushArtifacts(project);
  });
}

function registerMemoryTools(
  pi: ExtensionAPI,
  getService: (ctx?: ExtensionContext) => Promise<MemoryService>,
): void {
  const Type = pi.typebox.Type;
  const optionalString = (description: string) => Type.Optional(Type.String({ description }));
  const optionalNumber = (description: string) => Type.Optional(Type.Number({ description }));

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Step 1 of claude-mem compatible workflow: search memory and return compact IDs only. Use memory_timeline or memory_get_observations after filtering.",
    parameters: Type.Object({
      query: optionalString("Full-text memory search query"),
      limit: optionalNumber("Maximum compact results"),
      offset: optionalNumber("Pagination offset"),
      type: optionalString("Observation type filter"),
      obs_type: optionalString("Record type filter retained for claude-mem compatibility"),
      project: optionalString("Project filter"),
      dateStart: optionalString("Start date YYYY-MM-DD"),
      dateEnd: optionalString("End date YYYY-MM-DD"),
      orderBy: optionalString("date_desc, date_asc, or relevance"),
      concept: optionalString("Concept filter or comma-separated concepts"),
      concepts: optionalString("Concept filters as comma-separated values"),
      filePath: optionalString("File path filter"),
      files: optionalString("File filters as comma-separated values"),
      isFolder: Type.Optional(Type.Boolean({ description: "Treat filePath/files as folder filters and match direct child files only" })),
    }),
    async execute(_toolCallId, params, _onUpdate, ctx) {
      const service = await getService(ctx);
      const response = await service.search(params as SearchRequest);
      return { content: [{ type: "text", text: formatMemorySearchResponse(response) }], details: response };
    },
  });

  pi.registerTool({
    name: "memory_timeline",
    label: "Memory Timeline",
    description:
      "Step 2 of claude-mem compatible workflow: get chronological context around an anchor ID or query before fetching full details.",
    parameters: Type.Object({
      anchor: Type.Optional(Type.Union ? Type.Union([Type.Number(), Type.String()]) : Type.Number()),
      query: optionalString("Search query used to choose an anchor automatically"),
      depth_before: optionalNumber("Observations before anchor"),
      depth_after: optionalNumber("Observations after anchor"),
      project: optionalString("Project filter"),
    }),
    async execute(_toolCallId, params, _onUpdate, ctx) {
      const service = await getService(ctx);
      const response = await service.timeline(params as TimelineRequest);
      return { content: [{ type: "text", text: formatMemoryTimelineResponse(response) }], details: response };
    },
  });

  pi.registerTool({
    name: "memory_get_observations",
    label: "Memory Details",
    description:
      "Step 3 of claude-mem compatible workflow: fetch full details for already-filtered memory IDs. Batch IDs in one call.",
    parameters: Type.Object({
      ids: Type.Array(Type.Number(), { description: "Observation IDs to fetch" }),
      orderBy: optionalString("date_desc or date_asc"),
      limit: optionalNumber("Maximum observations to return"),
      project: optionalString("Project filter"),
    }),
    async execute(_toolCallId, params, _onUpdate, ctx) {
      const service = await getService(ctx);
      const response = await service.getObservations(params as unknown as GetObservationsRequest);
      return { content: [{ type: "text", text: formatMemoryGetResponse(response) }], details: response };
    },
  });

  pi.registerTool({
    name: "memory_remember",
    label: "Remember Memory",
    description:
      "Save a durable manual memory as a redacted discovery observation in omp-mem. Use for explicit user-approved facts, preferences, or decisions.",
    parameters: Type.Object({
      text: Type.String({ description: "Memory text to save" }),
      title: optionalString("Optional short title"),
      project: optionalString("Project filter/name; defaults to current project"),
      metadata: Type.Optional(Type.Object({})),
    }),
    async execute(_toolCallId, params, _onUpdate, ctx) {
      const service = await getService(ctx);
      const text = typeof params.text === "string" ? params.text : "";
      if (!text.trim()) return { content: [{ type: "text", text: "Memory text is required." }] };
      const metadata = params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
        ? params.metadata as Record<string, unknown>
        : undefined;
      const project = typeof params.project === "string" ? params.project : (ctx ? getProjectName(ctx) : undefined);
      const id = await service.remember({
        text,
        title: typeof params.title === "string" ? params.title : undefined,
        project,
        metadata,
      });
      await service.flushArtifacts(project);
      return { content: [{ type: "text", text: `Memory saved as observation #${id}` }], details: { id } };
    },
  });
}

function registerMemoryCommand(pi: ExtensionAPI, getService: (ctx?: ExtensionContext) => Promise<MemoryService>): void {
  pi.registerCommand("mem", {
    description: "Manage omp-mem replacement memory",
    handler: async (args, ctx) => {
      const action = args.trim().split(/\s+/, 1)[0] || "status";
      const service = await getService(ctx);
      if (action === "rebuild" || action === "flush") {
        await service.flushArtifacts(getProjectName(ctx));
        ctx.ui?.notify?.("omp-mem artifacts rebuilt", "info");
        return;
      }
      if (action === "status") {
        const response = await service.search({ project: getProjectName(ctx), limit: 5 });
        ctx.ui?.notify?.(`omp-mem ready: ${response.total} recent result(s)`, "info");
        return;
      }
      ctx.ui?.notify?.("Usage: /mem <status|flush|rebuild>", "warning");
    },
  });
}

interface ModelExtractionOptions extends Omit<ObservationExtractionRequest, "toolInputText" | "toolResponseText" | "combinedText"> {
  toolInput: unknown;
  toolResponse: unknown;
  completeText?: (request: OmpMemModelRequest) => Promise<string>;
  logger?: ExtensionAPI["logger"];
}

interface ModelSessionSummaryOptions extends SessionSummaryRequest {
  completeText?: (request: OmpMemModelRequest) => Promise<string>;
  logger?: ExtensionAPI["logger"];
}

async function extractObservationWithModel(
  ctx: ExtensionContext,
  config: OmpMemConfig,
  options: ModelExtractionOptions,
): Promise<ObservationExtractionResult | undefined> {
  if (config.ai.source === "heuristic") return undefined;
  const toolInputText = clampModelText(redactForModel(unknownToText(options.toolInput), config));
  const toolResponseText = clampModelText(redactForModel(unknownToText(options.toolResponse), config));
  const combinedText = [toolInputText, toolResponseText].filter(Boolean).join("\n");
  const prompt = buildObservationExtractionPrompt({
    contentSessionId: options.contentSessionId,
    project: options.project,
    toolName: options.toolName,
    toolInputText,
    toolResponseText,
    combinedText,
    cwd: options.cwd,
    platformSource: options.platformSource,
  });
  const text = await completeModelText(ctx, config, "observation", prompt, options.completeText, options.logger);
  return text ? parseObservationExtraction(text) : undefined;
}

async function summarizeSessionWithModel(
  ctx: ExtensionContext,
  config: OmpMemConfig,
  options: ModelSessionSummaryOptions,
): Promise<string | undefined> {
  const lastAssistantMessage = clampModelText(redactForModel(options.lastAssistantMessage, config).trim());
  if (config.ai.source === "heuristic" || !lastAssistantMessage) return undefined;
  const prompt = `You are omp-mem, a claude-mem-compatible memory worker. Summarize the last assistant response for future memory. Keep only durable facts, decisions, changed files, open blockers, and next steps. Return plain markdown, no preamble.\n\n<assistant_response>\n${lastAssistantMessage}\n</assistant_response>`;
  return completeModelText(ctx, config, "session-summary", prompt, options.completeText, options.logger);
}

async function completeModelText(
  ctx: ExtensionContext,
  config: OmpMemConfig,
  kind: OmpMemModelRequest["kind"],
  prompt: string,
  injectedCompleteText: ((request: OmpMemModelRequest) => Promise<string>) | undefined,
  logger: ExtensionAPI["logger"] | undefined,
): Promise<string | undefined> {
  try {
    const request = await buildModelRequest(ctx, config, kind, prompt, logger);
    if (!request) return undefined;
    return await (injectedCompleteText ?? defaultCompleteText)(request);
  } catch (error) {
    if (!config.ai.failOpen) throw error;
    logger?.warn?.("omp-mem model extraction failed; falling back to heuristic memory", {
      kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function buildModelRequest(
  ctx: ExtensionContext,
  config: OmpMemConfig,
  kind: OmpMemModelRequest["kind"],
  prompt: string,
  logger: ExtensionAPI["logger"] | undefined,
): Promise<OmpMemModelRequest | undefined> {
  if (config.ai.source === "direct") {
    const modelName = config.ai.direct.model;
    const baseUrl = config.ai.direct.baseUrl;
    const apiKey = resolveDirectApiKey(config);
    if (!modelName) return handleModelExtractionUnavailable(config, logger, "direct model name not configured", { kind });
    if (!baseUrl) return handleModelExtractionUnavailable(config, logger, "direct baseUrl not configured", { kind, model: modelName });
    if (!apiKey) return handleModelExtractionUnavailable(config, logger, "direct API key not configured", { kind, model: modelName });
    return {
      kind,
      source: "direct",
      model: { provider: "direct", id: modelName, name: modelName, api: config.ai.direct.api },
      apiKey,
      prompt,
      maxTokens: config.ai.maxTokens,
      ctx,
      baseUrl,
      headers: config.ai.direct.headers,
    };
  }

  const model = selectOmpModel(ctx, config.ai.omp.provider, config.ai.omp.model);
  if (!model) {
    return handleModelExtractionUnavailable(config, logger, "OMP model not available", {
      provider: config.ai.omp.provider,
      model: config.ai.omp.model,
      kind,
    });
  }
  const apiKey = await ctx.modelRegistry?.getApiKey(model, getContentSessionId(ctx));
  if (!apiKey) {
    return handleModelExtractionUnavailable(config, logger, "OMP API key not available", { provider: model.provider, model: model.id, kind });
  }
  return {
    kind,
    source: "omp",
    model,
    apiKey,
    prompt,
    maxTokens: config.ai.maxTokens,
    ctx,
  };
}

function resolveDirectApiKey(config: OmpMemConfig): string | undefined {
  return config.ai.direct.apiKey ?? (config.ai.direct.apiKeyEnv ? process.env?.[config.ai.direct.apiKeyEnv] : undefined);
}

async function defaultCompleteText(request: OmpMemModelRequest): Promise<string> {
  if (request.source === "direct") {
    return completeDirectOpenAiText(request);
  }
  type CompletionResponse = { content: Array<{ type: string; text?: string }> };
  type PiAiModule = {
    complete(
      model: unknown,
      context: { messages: Array<{ role: "user" | "assistant" | "system"; content: Array<{ type: "text"; text: string }>; timestamp?: number }> },
      options: { apiKey?: string; maxTokens?: number; signal?: AbortSignal },
    ): Promise<CompletionResponse>;
  };
  const importModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<PiAiModule>;
  const ai = await importModule("@oh-my-pi/pi-ai");
  const response = await ai.complete(
    request.model,
    {
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: request.prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey: request.apiKey, maxTokens: request.maxTokens },
  );
  return response.content
    .filter((item): item is { type: string; text: string } => item.type === "text" && typeof item.text === "string")
    .map(item => item.text)
    .join("\n")
    .trim();
}

async function completeDirectOpenAiText(request: OmpMemModelRequest): Promise<string> {
  const response = await fetch(toOpenAiChatUrl(request.baseUrl ?? ""), {
    method: "POST",
    headers: {
      ...request.headers,
      Authorization: `Bearer ${request.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: request.model.id,
      messages: [{ role: "user", content: request.prompt }],
      max_tokens: request.maxTokens,
    }),
  });
  if (!response.ok) {
    throw new Error(`direct model request failed: HTTP ${response.status} ${await response.text()}`);
  }
  const payload = await response.json() as Record<string, unknown>;
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  return typeof content === "string" ? content.trim() : "";
}

function toOpenAiChatUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function handleModelExtractionUnavailable(
  config: OmpMemConfig,
  logger: ExtensionAPI["logger"] | undefined,
  message: string,
  details: Record<string, unknown>,
): undefined {
  if (!config.ai.failOpen) throw new Error(message);
  logger?.warn?.(`omp-mem model extraction skipped: ${message}`, details);
  return undefined;
}

function selectOmpModel(ctx: ExtensionContext, provider: string, modelName: string): ModelLike | undefined {
  if (provider === "current" && modelName === "current") return ctx.model;
  const registry = ctx.modelRegistry;
  if (!registry) return undefined;

  if (provider !== "current") {
    const exact = asModelLike(registry.find?.(provider, modelName));
    if (exact) return exact;
    const stripped = stripThinkingSuffix(modelName);
    if (stripped !== modelName) return asModelLike(registry.find?.(provider, stripped));
  }

  const canonical = asModelLike(registry.resolveCanonicalModel?.(modelName, { availableOnly: true }));
  if (canonical) return canonical;

  return registry.getAvailable?.()
    .map(asModelLike)
    .filter((model): model is ModelLike => Boolean(model))
    .find(model => model.id === modelName || `${model.provider}/${model.id}` === modelName);
}

function clampModelText(text: string): string {
  return text.length > 8_000 ? text.slice(0, 8_000) : text;
}

const PRIVATE_TAG_PATTERN = /<private>[\s\S]*?<\/private>/gi;

function redactForModel(text: string, config: OmpMemConfig): string {
  return config.redaction.privateTag ? text.replace(PRIVATE_TAG_PATTERN, "[private redacted]") : text;
}

function asModelLike(value: unknown): ModelLike | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.provider === "string" && typeof record.id === "string" ? (record as unknown as ModelLike) : undefined;
}

function stripThinkingSuffix(modelId: string): string {
  const separator = modelId.lastIndexOf(":");
  if (separator === -1) return modelId;
  const suffix = modelId.slice(separator + 1).toLowerCase();
  return suffix === "off" || suffix === "none" || suffix === "minimal" || suffix === "low" || suffix === "medium" || suffix === "high" || suffix === "xhigh"
    ? modelId.slice(0, separator)
    : modelId;
}

function buildObservationExtractionPrompt(request: ObservationExtractionRequest): string {
  return `You are omp-mem, a claude-mem-compatible memory extraction worker. Extract one durable memory observation from this OMP tool event. Ignore transient noise, progress chatter, and secrets. Return strict JSON only with this shape: {"title":"short title","narrative":"concise but useful detail","type":"bugfix|feature|decision|discovery|refactor|change|preference","facts":["durable fact"],"files":["path"],"concepts":["keyword"],"confidence":"observed|inferred"}.\n\n<context>\ncontentSessionId: ${request.contentSessionId}\nproject: ${request.project}\nplatformSource: ${request.platformSource}\ncwd: ${request.cwd ?? ""}\ntoolName: ${request.toolName}\n</context>\n\n<tool_input>\n${request.toolInputText}\n</tool_input>\n\n<tool_response>\n${request.toolResponseText}\n</tool_response>`;
}

function parseObservationExtraction(text: string): ObservationExtractionResult | undefined {
  const json = extractJsonObject(text);
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return {
      title: typeof parsed.title === "string" ? parsed.title : undefined,
      narrative: typeof parsed.narrative === "string" ? parsed.narrative : undefined,
      type: typeof parsed.type === "string" ? parsed.type : undefined,
      facts: arrayOfStrings(parsed.facts),
      files: arrayOfStrings(parsed.files),
      concepts: arrayOfStrings(parsed.concepts),
      confidence: typeof parsed.confidence === "string" ? parsed.confidence : undefined,
    };
  } catch {
    return undefined;
  }
}

function extractJsonObject(text: string): string | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : undefined;
}

function arrayOfStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return result.length > 0 ? result : undefined;
}

function unknownToText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeSystemPrompts(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((prompt): prompt is string => typeof prompt === "string" && prompt.length > 0);
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

function getContentSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager?.getSessionId() ?? "unknown-session";
}

function getProjectName(ctx: ExtensionContext): string {
  const cwd = ctx.cwd ?? process.cwd();
  const name = cwd.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);
  return name || "default";
}

function extractToolResponse(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content
    .map(item => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractAgentEndText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const message of messages.slice(-4)) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    const content = record.content;
    if (typeof content === "string") {
      parts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
          parts.push((block as Record<string, string>).text);
        }
      }
    }
  }
  return parts.join("\n");
}
