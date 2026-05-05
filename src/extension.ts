import {
  createMemoryService,
  formatMemoryGetResponse,
  formatMemorySearchResponse,
  formatMemoryTimelineResponse,
  resolveMemoryRoot,
  type GetObservationsRequest,
  type MemoryService,
  type MemoryServiceOptions,
  type SearchRequest,
  type TimelineRequest,
} from "./service";

export interface OmpMemExtensionOptions extends Partial<MemoryServiceOptions> {
  homeDir?: string;
}

interface ExtensionAPI {
  typebox: {
    Type: {
      Object(shape: Record<string, unknown>): unknown;
      String(options?: Record<string, unknown>): unknown;
      Number(options?: Record<string, unknown>): unknown;
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

interface ExtensionContext {
  cwd?: string;
  ui?: {
    notify?(message: string, type?: "info" | "warning" | "error"): void;
  };
  sessionManager?: {
    getSessionId(): string;
    getSessionName?(): string | undefined;
  };
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

const SELF_TOOL_NAMES = new Set(["memory_search", "memory_timeline", "memory_get_observations"]);

export default function ompMemExtension(pi: ExtensionAPI): void {
  void registerOmpMemExtension(pi);
}

export async function registerOmpMemExtension(pi: ExtensionAPI, options: OmpMemExtensionOptions = {}): Promise<void> {
  const services = new Map<string, Promise<MemoryService>>();
  const capturedToolCallIds = new Set<string>();
  const getService = async (ctx?: ExtensionContext): Promise<MemoryService> => {
    const cwd = ctx?.cwd ?? process.cwd();
    const memoryRoot = options.memoryRoot ?? resolveMemoryRoot({ cwd, homeDir: options.homeDir });
    const existing = services.get(memoryRoot);
    if (existing) return existing;
    const created = createMemoryService({
      memoryRoot,
      dbPath: options.dbPath,
      now: options.now,
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
      prompt,
      platformSource: "omp",
      customTitle: ctx.sessionManager?.getSessionName?.(),
    });
    const memoryContext = await service.injectContext({ project, q: prompt, limit: 5 });
    const systemPrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
    return { systemPrompt: `${systemPrompt}\n\n${memoryContext}`.trim() };
  });

  const recordToolEvent = async (
    event: Record<string, unknown>,
    ctx: ExtensionContext,
    toolInput: unknown,
    toolResponse: unknown,
  ) => {
    const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
    if (SELF_TOOL_NAMES.has(toolName)) return;
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    if (toolCallId && capturedToolCallIds.has(toolCallId)) return;
    if (toolCallId) {
      if (capturedToolCallIds.size > 1000) capturedToolCallIds.clear();
      capturedToolCallIds.add(toolCallId);
    }
    const service = await getService(ctx);
    await service.recordObservation({
      contentSessionId: getContentSessionId(ctx),
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      cwd: ctx.cwd,
      platformSource: "omp",
      tool_use_id: toolCallId,
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
    const service = await getService(ctx);
    await service.summarizeSession({
      contentSessionId: getContentSessionId(ctx),
      last_assistant_message: extractAgentEndText(event.messages),
      platformSource: "omp",
    });
  });

  pi.on("session_compact", async (event, ctx) => {
    const service = await getService(ctx);
    await service.recordObservation({
      contentSessionId: getContentSessionId(ctx),
      tool_name: "session_compact",
      tool_input: { fromExtension: event.fromExtension },
      tool_response: event.compactionEntry,
      cwd: ctx.cwd,
      platformSource: "omp",
    });
    await service.flushArtifacts(getProjectName(ctx));
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
