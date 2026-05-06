import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_OMP_MEM_CONFIG, type OmpMemConfig } from "./config";

export type ObservationKind = "bugfix" | "feature" | "decision" | "discovery" | "refactor" | "change" | "preference";
export type ObservationConfidence = "observed" | "inferred";

export type SearchRecordType = "observation" | "session" | "prompt";

export interface ObservationExtractionResult {
  title?: string;
  narrative?: string;
  facts?: string[];
  files?: string[];
  concepts?: string[];
  type?: ObservationKind | string;
  confidence?: ObservationConfidence | string;
}

export interface ObservationExtractionRequest {
  contentSessionId: string;
  project: string;
  toolName: string;
  toolInputText: string;
  toolResponseText: string;
  combinedText: string;
  cwd?: string;
  platformSource: string;
}

export interface SessionSummaryRequest {
  contentSessionId: string;
  project: string;
  lastAssistantMessage: string;
  platformSource: string;
}
export interface SessionInitRequest {
  contentSessionId: string;
  project?: string;
  prompt?: string;
  platformSource?: string;
  customTitle?: string;
}

export interface ObservationRequest {
  contentSessionId: string;
  tool_name: string;
  tool_input?: unknown;
  tool_response?: unknown;
  cwd?: string;
  agentId?: string;
  agentType?: string;
  platformSource?: string;
  tool_use_id?: string;
  toolUseId?: string;
  extraction?: ObservationExtractionResult;
  metadata?: Record<string, unknown>;
}

export interface SummarizeRequest {
  contentSessionId: string;
  last_assistant_message?: string;
  summary?: string;
  agentId?: string;
  platformSource?: string;
}

export interface SearchRequest {
  query?: string;
  limit?: number | string;
  offset?: number | string;
  type?: ObservationKind | SearchRecordType | string | string[];
  obs_type?: ObservationKind | SearchRecordType | string | string[];
  project?: string;
  dateStart?: string;
  dateEnd?: string;
  orderBy?: "date_desc" | "date_asc" | "relevance" | string;
  concept?: string | string[];
  concepts?: string | string[];
  filePath?: string | string[];
  files?: string | string[];
  isFolder?: boolean | string;
}

export interface TimelineRequest {
  anchor?: number | string;
  query?: string;
  depth_before?: number | string;
  depth_after?: number | string;
  project?: string;
}

export interface GetObservationsRequest {
  ids: number[];
  orderBy?: "date_desc" | "date_asc" | string;
  limit?: number | string;
  project?: string;
}

export interface ContextInjectRequest {
  q?: string;
  project?: string;
  limit?: number | string;
}

export interface MemoryTimelineItem {
  id: number;
  ref: string;
  recordType: SearchRecordType;
  createdAt: number;
  project: string;
  type: string;
  title: string;
  narrative: string;
  facts: string[];
  files: string[];
  concepts: string[];
}

export interface MemoryObservation {
  id: number;
  ref: string;
  recordType: "observation";
  contentSessionId: string;
  memorySessionId: string | null;
  project: string;
  toolName: string;
  toolUseId: string | null;
  type: ObservationKind;
  title: string;
  narrative: string;
  facts: string[];
  files: string[];
  concepts: string[];
  confidence: ObservationConfidence;
  createdAt: number;
  cwd: string | null;
  platformSource: string;
  agentId: string | null;
  agentType: string | null;
  generatedByModel: string | null;
  metadata: Record<string, unknown> | null;
}

export interface MemorySearchIndexResult {
  id: number;
  ref: string;
  recordType: SearchRecordType;
  createdAt: number;
  project: string;
  type: string;
  title: string;
  files: string[];
  concepts: string[];
}

export interface MemorySearchResponse {
  results: MemorySearchIndexResult[];
  total: number;
}

export interface MemoryTimelineResponse {
  anchor: number | string | null;
  items: MemoryTimelineItem[];
}

export interface MemoryGetResponse {
  observations: MemoryObservation[];
}

export interface RememberRequest {
  text: string;
  title?: string;
  project?: string;
  metadata?: Record<string, unknown>;
  contentSessionId?: string;
}

export interface MemoryServiceOptions {
  memoryRoot: string;
  dbPath?: string;
  now?: () => number;
  config?: OmpMemConfig;
  extractObservation?: (request: ObservationExtractionRequest) => Promise<ObservationExtractionResult | undefined>;
  summarizeText?: (request: SessionSummaryRequest) => Promise<string | undefined>;
}
export interface ResolveMemoryRootOptions {
  cwd: string;
  homeDir?: string;
  dataDir?: string;
}

interface ObservationRow {
  id: number;
  content_session_id: string;
  memory_session_id: string | null;
  project: string;
  tool_name: string;
  tool_use_id: string | null;
  type: ObservationKind;
  title: string;
  narrative: string;
  facts_json: string;
  files_json: string;
  concepts_json: string;
  confidence: ObservationConfidence;
  created_at: number;
  cwd: string | null;
  platform_source: string;
  agent_id: string | null;
  agent_type: string | null;
  generated_by_model: string | null;
  metadata: string | null;
}

interface SearchRow {
  id: number;
  created_at: number;
  project: string;
  type: string;
  title: string;
  files_json: string;
  concepts_json: string;
  rank?: number;
}

interface SessionSummaryRow {
  id: number;
  content_session_id: string;
  project: string;
  summary: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null;
  files_edited: string | null;
  notes: string | null;
  created_at: number;
}

interface PromptRow {
  id: number;
  content_session_id: string;
  project: string;
  prompt_text: string;
  created_at: number;
}

interface SessionRow {
  id: number;
  content_session_id: string;
  project: string;
  summary: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null;
  files_edited: string | null;
  notes: string | null;
  created_at: number;
}

interface SearchScope {
  recordTypes: SearchRecordType[];
  observationTypes: string[];
  concepts: string[];
  files: string[];
  isFolder: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_PROJECT = "default";
const PRIVATE_TAG_PATTERN = /<private>[\s\S]*?<\/private>/gi;
const FILE_PATTERN = /(?:[A-Za-z]:)?[\w.-]+(?:[\\/][\w.@()[\]-]+)+(?:\.[A-Za-z0-9]+)?/g;
const DB_NAME = "omp-mem.sqlite";


export function resolveMemoryRoot(options: ResolveMemoryRootOptions): string {
  const homeDir = options.homeDir ?? os.homedir();
  const dataDir = options.dataDir ?? path.join(homeDir, ".omp", "agent", "omp-mem");
  return path.join(dataDir, "state", encodeProjectPath(options.cwd));
}

export async function resolveMemoryDatabasePath(options: MemoryServiceOptions): Promise<string> {
  if (options.dbPath) return options.dbPath;
  return path.join(options.memoryRoot, DB_NAME);
}

export async function createMemoryService(options: MemoryServiceOptions): Promise<MemoryService> {
  await fs.mkdir(options.memoryRoot, { recursive: true });
  const db = new Database(await resolveMemoryDatabasePath(options));
  const service = new MemoryService(
    db,
    options.memoryRoot,
    options.now ?? unixNow,
    options.config ?? DEFAULT_OMP_MEM_CONFIG,
    options.extractObservation,
    options.summarizeText,
  );
  service.initialize();
  return service;
}

export class MemoryService {
  constructor(
    readonly db: Database,
    readonly memoryRoot: string,
    readonly now: () => number,
    readonly config: OmpMemConfig = DEFAULT_OMP_MEM_CONFIG,
    private readonly extractObservation?: (request: ObservationExtractionRequest) => Promise<ObservationExtractionResult | undefined>,
    private readonly summarizeText?: (request: SessionSummaryRequest) => Promise<string | undefined>,
  ) {}

  initialize(): void {
    this.db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS schema_versions (
  id INTEGER PRIMARY KEY,
  version INTEGER UNIQUE NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sdk_sessions (
  content_session_id TEXT PRIMARY KEY,
  memory_session_id TEXT UNIQUE,
  project TEXT NOT NULL,
  custom_title TEXT,
  platform_source TEXT NOT NULL,
  user_prompt TEXT,
  started_at TEXT,
  started_at_epoch INTEGER,
  completed_at TEXT,
  completed_at_epoch INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  worker_port INTEGER,
  prompt_counter INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  prompt_number INTEGER NOT NULL DEFAULT 0,
  prompt_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_at_epoch INTEGER
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT NOT NULL,
  memory_session_id TEXT,
  project TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_use_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  text TEXT,
  narrative TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  facts TEXT,
  files_json TEXT NOT NULL,
  files_read TEXT,
  files_modified TEXT,
  concepts_json TEXT NOT NULL,
  concepts TEXT,
  confidence TEXT NOT NULL,
  prompt_number INTEGER DEFAULT 0,
  discovery_tokens INTEGER DEFAULT 0,
  content_hash TEXT,
  agent_type TEXT,
  agent_id TEXT,
  merged_into_project TEXT,
  generated_by_model TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  cwd TEXT,
  platform_source TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title,
  subtitle,
  narrative,
  text,
  facts,
  files,
  concepts,
  content=''
);

CREATE TABLE IF NOT EXISTS session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT NOT NULL,
  memory_session_id TEXT,
  project TEXT NOT NULL,
  summary TEXT NOT NULL,
  request TEXT,
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  files_read TEXT,
  files_edited TEXT,
  notes TEXT,
  prompt_number INTEGER DEFAULT 0,
  discovery_tokens INTEGER DEFAULT 0,
  merged_into_project TEXT,
  created_at INTEGER NOT NULL,
  created_at_epoch INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
  summary,
  request,
  investigated,
  learned,
  completed,
  next_steps,
  notes,
  content=''
);

CREATE TABLE IF NOT EXISTS pending_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_db_id INTEGER,
  content_session_id TEXT NOT NULL,
  tool_use_id TEXT,
  message_type TEXT NOT NULL,
  tool_name TEXT,
  tool_input TEXT,
  tool_response TEXT,
  cwd TEXT,
  last_user_message TEXT,
  last_assistant_message TEXT,
  prompt_number INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at_epoch INTEGER NOT NULL,
  worker_pid INTEGER,
  agent_type TEXT,
  agent_id TEXT
);

CREATE TABLE IF NOT EXISTS observation_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id INTEGER NOT NULL,
  signal_type TEXT NOT NULL,
  session_db_id INTEGER,
  created_at_epoch INTEGER NOT NULL,
  metadata TEXT
);
`);
    this.ensureSchemaColumns();
    this.ensureFtsTables();
    this.db.exec(`
CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status);
CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_observations_memory_hash ON observations(memory_session_id, content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project);
CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project);
CREATE INDEX IF NOT EXISTS idx_user_prompts_project ON user_prompts(project);
CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_session_tool ON pending_messages(content_session_id, tool_use_id) WHERE tool_use_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_feedback_observation ON observation_feedback(observation_id);
`);
  }

  private ensureSchemaColumns(): void {
    const columns: Record<string, string[]> = {
      sdk_sessions: [
        "memory_session_id TEXT",
        "custom_title TEXT",
        "platform_source TEXT NOT NULL DEFAULT 'omp'",
        "user_prompt TEXT",
        "started_at TEXT",
        "started_at_epoch INTEGER",
        "completed_at TEXT",
        "completed_at_epoch INTEGER",
        "status TEXT NOT NULL DEFAULT 'active'",
        "worker_port INTEGER",
        "prompt_counter INTEGER DEFAULT 0",
        "created_at INTEGER NOT NULL DEFAULT 0",
        "updated_at INTEGER NOT NULL DEFAULT 0",
      ],
      user_prompts: [
        "project TEXT NOT NULL DEFAULT 'default'",
        "prompt_number INTEGER NOT NULL DEFAULT 0",
        "created_at_epoch INTEGER",
      ],
      observations: [
        "memory_session_id TEXT",
        "subtitle TEXT",
        "text TEXT",
        "facts TEXT",
        "files_read TEXT",
        "files_modified TEXT",
        "concepts TEXT",
        "prompt_number INTEGER DEFAULT 0",
        "discovery_tokens INTEGER DEFAULT 0",
        "content_hash TEXT",
        "agent_type TEXT",
        "agent_id TEXT",
        "merged_into_project TEXT",
        "generated_by_model TEXT",
        "metadata TEXT",
      ],
      session_summaries: [
        "memory_session_id TEXT",
        "request TEXT",
        "investigated TEXT",
        "learned TEXT",
        "completed TEXT",
        "next_steps TEXT",
        "files_read TEXT",
        "files_edited TEXT",
        "notes TEXT",
        "prompt_number INTEGER DEFAULT 0",
        "discovery_tokens INTEGER DEFAULT 0",
        "merged_into_project TEXT",
        "created_at_epoch INTEGER",
      ],
      pending_messages: ["worker_pid INTEGER"],
    };
    for (const [table, definitions] of Object.entries(columns)) {
      const existing = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name));
      for (const definition of definitions) {
        const column = definition.split(/\s+/, 1)[0];
        if (!existing.has(column)) this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${definition}`).run();
      }
    }
  }

  private ensureFtsTables(): void {
    this.dropFtsTriggers();
    const observationColumns = tableColumns(this.db, "observations_fts");
    const expectedObservationColumns = ["title", "subtitle", "narrative", "text", "facts", "files", "concepts"];
    if (observationColumns.length > 0 && !expectedObservationColumns.every(column => observationColumns.includes(column))) {
      this.db.exec("DROP TABLE IF EXISTS observations_fts;");
    }
    const summaryColumns = tableColumns(this.db, "session_summaries_fts");
    const expectedSummaryColumns = ["summary", "request", "investigated", "learned", "completed", "next_steps", "notes"];
    if (summaryColumns.length > 0 && !expectedSummaryColumns.every(column => summaryColumns.includes(column))) {
      this.db.exec("DROP TABLE IF EXISTS session_summaries_fts;");
    }
    this.db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title,
  subtitle,
  narrative,
  text,
  facts,
  files,
  concepts,
  content=''
);
CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
  summary,
  request,
  investigated,
  learned,
  completed,
  next_steps,
  notes,
  content=''
);
`);
    this.createFtsTriggers();
    this.rebuildFtsIndex();
    this.rebuildSessionSummaryFtsIndex();
  }

  private dropFtsTriggers(): void {
    this.db.exec(`
DROP TRIGGER IF EXISTS observations_fts_ai;
DROP TRIGGER IF EXISTS observations_fts_ad;
DROP TRIGGER IF EXISTS observations_fts_au;
DROP TRIGGER IF EXISTS session_summaries_fts_ai;
DROP TRIGGER IF EXISTS session_summaries_fts_ad;
DROP TRIGGER IF EXISTS session_summaries_fts_au;
`);
  }

  private createFtsTriggers(): void {
    this.db.exec(`
CREATE TRIGGER IF NOT EXISTS observations_fts_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, files, concepts)
  VALUES (new.id, new.title, new.subtitle, new.narrative, COALESCE(NULLIF(new.text, ''), new.narrative), COALESCE(NULLIF(new.facts, ''), new.facts_json), COALESCE(NULLIF(new.files_read, ''), new.files_json), COALESCE(NULLIF(new.concepts, ''), new.concepts_json));
END;
CREATE TRIGGER IF NOT EXISTS observations_fts_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, files, concepts)
  VALUES('delete', old.id, old.title, old.subtitle, old.narrative, COALESCE(NULLIF(old.text, ''), old.narrative), COALESCE(NULLIF(old.facts, ''), old.facts_json), COALESCE(NULLIF(old.files_read, ''), old.files_json), COALESCE(NULLIF(old.concepts, ''), old.concepts_json));
END;
CREATE TRIGGER IF NOT EXISTS observations_fts_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, files, concepts)
  VALUES('delete', old.id, old.title, old.subtitle, old.narrative, COALESCE(NULLIF(old.text, ''), old.narrative), COALESCE(NULLIF(old.facts, ''), old.facts_json), COALESCE(NULLIF(old.files_read, ''), old.files_json), COALESCE(NULLIF(old.concepts, ''), old.concepts_json));
  INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, files, concepts)
  VALUES (new.id, new.title, new.subtitle, new.narrative, COALESCE(NULLIF(new.text, ''), new.narrative), COALESCE(NULLIF(new.facts, ''), new.facts_json), COALESCE(NULLIF(new.files_read, ''), new.files_json), COALESCE(NULLIF(new.concepts, ''), new.concepts_json));
END;
CREATE TRIGGER IF NOT EXISTS session_summaries_fts_ai AFTER INSERT ON session_summaries BEGIN
  INSERT INTO session_summaries_fts(rowid, summary, request, investigated, learned, completed, next_steps, notes)
  VALUES (new.id, new.summary, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
END;
CREATE TRIGGER IF NOT EXISTS session_summaries_fts_ad AFTER DELETE ON session_summaries BEGIN
  INSERT INTO session_summaries_fts(session_summaries_fts, rowid, summary, request, investigated, learned, completed, next_steps, notes)
  VALUES('delete', old.id, old.summary, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
END;
CREATE TRIGGER IF NOT EXISTS session_summaries_fts_au AFTER UPDATE ON session_summaries BEGIN
  INSERT INTO session_summaries_fts(session_summaries_fts, rowid, summary, request, investigated, learned, completed, next_steps, notes)
  VALUES('delete', old.id, old.summary, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
  INSERT INTO session_summaries_fts(rowid, summary, request, investigated, learned, completed, next_steps, notes)
  VALUES (new.id, new.summary, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
END;
`);
  }

  async initSession(request: SessionInitRequest): Promise<void> {
    const now = this.now();
    const project = normalizeProject(request.project);
    const platformSource = request.platformSource ?? "omp";
    const promptText = this.redact(request.prompt ?? "").trim();
    const existing = this.db
      .prepare("SELECT prompt_counter FROM sdk_sessions WHERE content_session_id = ?")
      .get(request.contentSessionId) as { prompt_counter?: number } | undefined;
    const promptNumber = (existing?.prompt_counter ?? 0) + (promptText ? 1 : 0);
    const memorySessionId = memorySessionIdFor(request.contentSessionId);

    this.db
      .prepare(`
INSERT INTO sdk_sessions (
  content_session_id, memory_session_id, project, custom_title, platform_source, user_prompt,
  started_at, started_at_epoch, status, prompt_counter, created_at, updated_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
ON CONFLICT(content_session_id) DO UPDATE SET
  memory_session_id = COALESCE(sdk_sessions.memory_session_id, excluded.memory_session_id),
  project = excluded.project,
  custom_title = COALESCE(excluded.custom_title, sdk_sessions.custom_title),
  platform_source = excluded.platform_source,
  user_prompt = COALESCE(excluded.user_prompt, sdk_sessions.user_prompt),
  started_at = COALESCE(sdk_sessions.started_at, excluded.started_at),
  started_at_epoch = COALESCE(sdk_sessions.started_at_epoch, excluded.started_at_epoch),
  status = 'active',
  prompt_counter = excluded.prompt_counter,
  updated_at = excluded.updated_at
`)
      .run(
        request.contentSessionId,
        memorySessionId,
        project,
        request.customTitle ?? null,
        platformSource,
        promptText || null,
        isoFromUnix(now),
        now,
        promptNumber,
        now,
        now,
      );

    if (promptText) {
      this.db
        .prepare("INSERT INTO user_prompts (content_session_id, project, prompt_number, prompt_text, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?)")
        .run(request.contentSessionId, project, promptNumber, promptText, now, now);
    }
  }

  async recordObservation(request: ObservationRequest): Promise<number> {
    const now = this.now();
    let session = this.getSession(request.contentSessionId);
    const platformSource = request.platformSource ?? "omp";
    if (!session) {
      await this.initSession({ contentSessionId: request.contentSessionId, project: normalizeProject(undefined), platformSource });
      session = this.getSession(request.contentSessionId);
    }
    const project = session?.project ?? normalizeProject(undefined);
    const memorySessionId = session?.memory_session_id ?? memorySessionIdFor(request.contentSessionId);
    const toolResponse = unknownToText(request.tool_response);
    const toolInput = unknownToText(request.tool_input);
    const redactedToolInput = this.redact(toolInput);
    const redactedToolResponse = this.redact(toolResponse);
    const combinedText = [redactedToolInput, redactedToolResponse].filter(Boolean).join("\n").trim();
    const heuristicNarrative = clampText(combinedText || `${request.tool_name} completed`, 8_000);
    const extracted = request.extraction ?? await this.extractObservationSafe({
      contentSessionId: request.contentSessionId,
      project,
      toolName: request.tool_name,
      toolInputText: redactedToolInput,
      toolResponseText: redactedToolResponse,
      combinedText,
      cwd: request.cwd,
      platformSource,
    });
    const narrative = clampText(this.redact(extracted?.narrative ?? heuristicNarrative), 8_000);
    const files = unique(normalizeStringList(extracted?.files, extractFiles(narrative), 20).map(file => clampText(this.redact(file), 240)));
    const concepts = unique(normalizeStringList(extracted?.concepts, extractConcepts(narrative, request.tool_name), 30).map(concept => clampText(this.redact(concept), 120)));
    const facts = unique(normalizeStringList(extracted?.facts, extractFacts(narrative), 12).map(fact => clampText(this.redact(fact), 240)));
    const type = normalizeObservationKind(extracted?.type, classifyObservation(narrative));
    const title = clampText(this.redact(extracted?.title ?? buildTitle(toolResponse || toolInput || request.tool_name)), 96);
    const toolUseId = request.tool_use_id ?? request.toolUseId ?? null;
    const factsJson = JSON.stringify(facts);
    const filesJson = JSON.stringify(files);
    const conceptsJson = JSON.stringify(concepts);
    const metadata = request.metadata ? redactJsonValue(request.metadata, value => this.redact(value)) : null;
    const metadataJson = metadata ? JSON.stringify(metadata) : null;
    const contentHash = hashObservation(memorySessionId, toolUseId, request.tool_name, title, narrative);
    const existing = this.db
      .prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?")
      .get(memorySessionId, contentHash) as { id: number } | undefined;
    if (existing) return existing.id;

    const insert = this.db
      .prepare(`
INSERT INTO observations (
  content_session_id, memory_session_id, project, tool_name, tool_use_id, type, title, subtitle, text, narrative,
  facts_json, facts, files_json, files_read, files_modified, concepts_json, concepts, confidence,
  prompt_number, discovery_tokens, content_hash, agent_type, agent_id, generated_by_model, metadata,
  created_at, cwd, platform_source
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
      .run(
        request.contentSessionId,
        memorySessionId,
        project,
        request.tool_name,
        toolUseId,
        type,
        title,
        request.tool_name === "memory_remember" ? "Manual memory" : null,
        narrative,
        narrative,
        factsJson,
        factsJson,
        filesJson,
        filesJson,
        JSON.stringify([]),
        conceptsJson,
        conceptsJson,
        normalizeConfidence(extracted?.confidence, extracted ? "inferred" : "observed"),
        0,
        0,
        contentHash,
        request.agentType ?? null,
        request.agentId ?? null,
        extracted ? "omp-mem" : null,
        metadataJson,
        now,
        request.cwd ?? null,
        platformSource,
      );

    const id = Number(insert.lastInsertRowid);
    this.applyRetention(project);
    return id;
  }

  async remember(request: RememberRequest): Promise<number> {
    const rawProject = request.project ?? (typeof request.metadata?.project === "string" ? request.metadata.project : undefined);
    const project = normalizeProject(this.redact(rawProject ?? ""));
    const contentSessionId = request.contentSessionId ?? `manual:${project}`;
    await this.initSession({ contentSessionId, project, platformSource: "omp", customTitle: "Manual memory" });
    const redactedText = this.redact(request.text).trim();
    const title = clampText(this.redact(request.title ?? buildTitle(redactedText)), 96);
    return this.recordObservation({
      contentSessionId,
      tool_name: "memory_remember",
      tool_input: request.metadata ? { metadata: request.metadata } : undefined,
      tool_response: redactedText,
      platformSource: "omp",
      metadata: request.metadata,
      extraction: {
        title,
        narrative: redactedText,
        type: "discovery",
        facts: [],
        files: [],
        concepts: [],
        confidence: "observed",
      },
    });
  }

  async summarizeSession(request: SummarizeRequest): Promise<void> {
    const session = this.getSession(request.contentSessionId);
    const project = session?.project ?? DEFAULT_PROJECT;
    const memorySessionId = session?.memory_session_id ?? memorySessionIdFor(request.contentSessionId);
    const rawSummary = this.redact(request.last_assistant_message ?? "").trim();
    const injectedSummary = this.redact(request.summary ?? "").trim();
    if (!rawSummary && !injectedSummary) return;
    const summary = injectedSummary || await this.summarizeTextSafe({
      contentSessionId: request.contentSessionId,
      project,
      lastAssistantMessage: rawSummary,
      platformSource: request.platformSource ?? "omp",
    }) || rawSummary;
    const structured = parseStructuredSummary(this.redact(summary));
    const cleanSummary = structured
      ? buildStructuredSummaryText(structured)
      : clampText(this.redact(summary), 8_000);
    const persistedRequest = structured?.request ?? (injectedSummary ? null : rawSummary || null);
    const now = this.now();
    this.db
      .prepare(`
INSERT INTO session_summaries (
  content_session_id, memory_session_id, project, summary, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, created_at, created_at_epoch
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
      .run(
        request.contentSessionId,
        memorySessionId,
        project,
        cleanSummary,
        persistedRequest,
        structured?.investigated ?? null,
        structured?.learned ?? (structured ? null : cleanSummary),
        structured?.completed ?? null,
        structured?.next_steps ?? null,
        structured ? JSON.stringify(structured.files_read) : null,
        structured ? JSON.stringify(structured.files_edited) : null,
        structured?.notes ?? (structured ? null : cleanSummary),
        now,
        now,
      );
    this.db
      .prepare("UPDATE sdk_sessions SET status = 'completed', completed_at = ?, completed_at_epoch = ?, updated_at = ? WHERE content_session_id = ?")
      .run(isoFromUnix(now), now, now, request.contentSessionId);
    await this.flushArtifacts(project);
  }

  async search(request: SearchRequest): Promise<MemorySearchResponse> {
    const limit = parseLimit(request.limit, this.config.search.defaultLimit, this.config.search.maxLimit);
    const offset = parseOffset(request.offset);
    const query = sanitizeFtsQuery(request.query);
    const scope = normalizeSearchScope(request);
    const records: MemorySearchIndexResult[] = [];

    if (scope.recordTypes.includes("observation")) {
      records.push(...this.searchObservations(request, query, scope));
    }
    if (scope.recordTypes.includes("session")) {
      records.push(...this.searchSessions(request, scope));
    }
    if (scope.recordTypes.includes("prompt")) {
      records.push(...this.searchPrompts(request, scope));
    }

    records.sort((a, b) => compareSearchResults(a, b, request.orderBy, Boolean(query)));
    return {
      results: records.slice(offset, offset + limit),
      total: records.length,
    };
  }

  private searchObservations(request: SearchRequest, query: string, scope: SearchScope): MemorySearchIndexResult[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (request.project) {
      appendProjectClauses(clauses, params, "o");
      params.push(request.project, request.project);
    }
    if (scope.observationTypes.length === 1) {
      clauses.push("o.type = ?");
      params.push(scope.observationTypes[0]);
    } else if (scope.observationTypes.length > 1) {
      clauses.push(`o.type IN (${scope.observationTypes.map(() => "?").join(", ")})`);
      params.push(...scope.observationTypes);
    }
    appendDateClauses(clauses, params, "o.created_at", request.dateStart, request.dateEnd);

    const rows = query
      ? this.db
        .prepare(`
SELECT o.id, o.created_at, o.project, o.type, o.title, o.files_json, o.concepts_json, rank
FROM observations_fts f
JOIN observations o ON o.id = f.rowid
WHERE observations_fts MATCH ?${clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : ""}
`)
        .all(query, ...params) as SearchRow[]
      : this.db
        .prepare(`
SELECT o.id, o.created_at, o.project, o.type, o.title, o.files_json, o.concepts_json
FROM observations o
${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
`)
        .all(...params) as SearchRow[];

    return rows
      .filter(row => matchesJsonArrayFilters(parseJsonArray(row.concepts_json), scope.concepts, "exact"))
      .filter(row => matchesFileFilters(parseJsonArray(row.files_json), scope.files, scope.isFolder))
      .map(row => ({
        id: row.id,
        ref: `#${row.id}`,
        recordType: "observation",
        createdAt: row.created_at,
        project: row.project,
        type: row.type,
        title: row.title,
        files: parseJsonArray(row.files_json),
        concepts: parseJsonArray(row.concepts_json),
        ...(row.rank !== undefined ? { rank: row.rank } : {}),
      } as MemorySearchIndexResult & { rank?: number }));
  }

  private searchSessions(request: SearchRequest, _scope: SearchScope): MemorySearchIndexResult[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (request.project) {
      appendProjectClauses(clauses, params, "s");
      params.push(request.project, request.project);
    }
    appendDateClauses(clauses, params, "s.created_at", request.dateStart, request.dateEnd);
    const query = sanitizeFtsQuery(request.query);
    const rows = query
      ? this.db
        .prepare(`
SELECT s.id, s.content_session_id, s.project, s.summary, s.request, s.investigated, s.learned, s.completed, s.next_steps, s.files_read, s.files_edited, s.notes, s.created_at, rank
FROM session_summaries_fts f
JOIN session_summaries s ON s.id = f.rowid
WHERE session_summaries_fts MATCH ?${clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : ""}
`)
        .all(query, ...params) as Array<SessionRow & { rank?: number }>
      : this.db
        .prepare(`
SELECT s.id, s.content_session_id, s.project, s.summary, s.request, s.investigated, s.learned, s.completed, s.next_steps, s.files_read, s.files_edited, s.notes, s.created_at
FROM session_summaries s
${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
`)
        .all(...params) as Array<SessionRow & { rank?: number }>;
    return rows.map(row => ({
      id: row.id,
      ref: `S${row.id}`,
      recordType: "session",
      createdAt: row.created_at,
      project: row.project,
      type: "session",
      title: clampText(summaryTitle(row).replace(/\s+/g, " "), 96),
      files: unique([...parseJsonArray(row.files_read ?? "[]"), ...parseJsonArray(row.files_edited ?? "[]")]),
      concepts: [],
      ...(row.rank !== undefined ? { rank: row.rank } : {}),
    } as MemorySearchIndexResult & { rank?: number }));
  }

  private searchPrompts(request: SearchRequest, _scope: SearchScope): MemorySearchIndexResult[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (request.project) {
      clauses.push("project = ?");
      params.push(request.project);
    }
    appendDateClauses(clauses, params, "created_at", request.dateStart, request.dateEnd);
    appendLikeClause(clauses, params, ["prompt_text"], request.query);
    const rows = this.db
      .prepare(`
SELECT id, content_session_id, project, prompt_text, created_at
FROM user_prompts
${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
`)
      .all(...params) as PromptRow[];
    return rows.map(row => ({
      id: row.id,
      ref: `P${row.id}`,
      recordType: "prompt",
      createdAt: row.created_at,
      project: row.project,
      type: "prompt",
      title: clampText(row.prompt_text.replace(/\s+/g, " "), 96),
      files: [],
      concepts: [],
    }));
  }

  async timeline(request: TimelineRequest): Promise<MemoryTimelineResponse> {
    const anchor = await this.resolveTimelineAnchor(request);
    if (!anchor) return { anchor: null, items: [] };

    const depthBefore = parseLimit(request.depth_before, 3, this.config.search.maxLimit);
    const depthAfter = parseLimit(request.depth_after, 3, this.config.search.maxLimit);
    const project = request.project ?? anchor.project;
    const allItems = this.getTimelineItems(project);
    const anchorIndex = allItems.findIndex(item => item.ref === anchor.ref && item.recordType === anchor.recordType);
    if (anchorIndex < 0) return { anchor: null, items: [] };
    const items = allItems.slice(Math.max(0, anchorIndex - depthBefore), anchorIndex + depthAfter + 1);
    return { anchor: anchor.recordType === "observation" ? anchor.id : anchor.ref, items };
  }

  private getTimelineItems(project?: string): MemoryTimelineItem[] {
    const observationRows = project
      ? this.db.prepare("SELECT * FROM observations WHERE project = ? OR merged_into_project = ?").all(project, project)
      : this.db.prepare("SELECT * FROM observations").all();
    const promptRows = project
      ? this.db.prepare("SELECT id, content_session_id, project, prompt_text, created_at FROM user_prompts WHERE project = ?").all(project)
      : this.db.prepare("SELECT id, content_session_id, project, prompt_text, created_at FROM user_prompts").all();
    const summaryRows = project
      ? this.db.prepare("SELECT id, content_session_id, project, summary, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, created_at FROM session_summaries WHERE project = ? OR merged_into_project = ?").all(project, project)
      : this.db.prepare("SELECT id, content_session_id, project, summary, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, created_at FROM session_summaries").all();
    const observations = (observationRows as ObservationRow[]).map(rowToObservation);
    const prompts = (promptRows as PromptRow[]).map(rowToPromptTimelineItem);
    const summaries = (summaryRows as SessionRow[]).map(rowToSessionTimelineItem);
    return [...observations, ...prompts, ...summaries].sort(compareTimelineItems);
  }

  async getObservations(request: GetObservationsRequest): Promise<MemoryGetResponse> {
    const ids = request.ids.filter(id => Number.isInteger(id) && id > 0);
    if (ids.length === 0) return { observations: [] };
    const limit = parseLimit(request.limit, ids.length, this.config.search.maxLimit);
    const placeholders = ids.map(() => "?").join(", ");
    const params: unknown[] = [...ids];
    const clauses = [`id IN (${placeholders})`];
    if (request.project) {
      clauses.push("(project = ? OR merged_into_project = ?)");
      params.push(request.project, request.project);
    }
    const rows = this.db
      .prepare(`SELECT * FROM observations WHERE ${clauses.join(" AND ")}`)
      .all(...params) as ObservationRow[];
    const observations = rows.map(rowToObservation);

    if (request.orderBy === "date_desc") {
      observations.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    } else if (request.orderBy === "date_asc") {
      observations.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
    } else {
      const position = new Map(ids.map((id, index) => [id, index]));
      observations.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
    }

    return { observations: observations.slice(0, limit) };
  }

  async injectContext(request: ContextInjectRequest): Promise<string> {
    if (!this.config.context.enabled) return "";
    const finalLimit = parseLimit(request.limit, this.config.context.observations, this.config.search.maxLimit);
    const contextResults = this.searchContextIndex(request, finalLimit);
    const sessionSummaries = this.getRecentSessionSummaries(request.project, this.config.context.sessions);
    const fullDetails = this.config.context.fullCount > 0
      ? await this.getObservations({
        ids: contextResults.slice(0, this.config.context.fullCount).map(result => result.id),
        project: request.project,
      })
      : { observations: [] };
    const summary = await readOptional(path.join(this.memoryRoot, "memory_summary.md"));
    const lines = [
      "# Memory Guidance",
      "Memory source: omp-mem claude-mem-compatible replacement plugin.",
      "Treat memory as advisory; current repository state and user instructions win.",
      "",
    ];
    if (this.config.context.includeSummary && summary.trim()) {
      lines.push("## Memory summary", summary.trim(), "");
    }
    if (sessionSummaries.length > 0) {
      lines.push("## Recent session summaries");
      for (const item of sessionSummaries) {
        lines.push(`- ${clampText(item.summary, 480)}`);
      }
      lines.push("");
    }
    if (contextResults.length > 0) {
      lines.push("## Relevant memory index");
      for (const result of contextResults) {
        lines.push(`- #${result.id} [${result.type}] ${result.title}`);
      }
      lines.push("Use memory_get_observations with filtered IDs before relying on details.");
    }
    if (fullDetails.observations.length > 0) {
      lines.push("", "## Full memory details");
      for (const observation of fullDetails.observations) {
        lines.push(`#${observation.id} [${observation.type}] ${observation.title}`);
        lines.push(formatFullContextObservation(observation, this.config.context.fullField));
      }
    }
    return lines.join("\n").trim();
  }

  async flushArtifacts(project?: string): Promise<void> {
    if (!this.config.artifacts.enabled) return;
    await fs.mkdir(this.memoryRoot, { recursive: true });
    const observations = this.getRecentObservations(project, this.config.artifacts.maxObservations);
    const summary = buildSummaryArtifact(observations);
    const full = buildFullArtifact(observations);
    if (this.config.artifacts.writeSummary) await Bun.write(path.join(this.memoryRoot, "memory_summary.md"), summary);
    if (this.config.artifacts.writeMemoryMd) await Bun.write(path.join(this.memoryRoot, "MEMORY.md"), full);
  }

  private getRecentObservations(project: string | undefined, limit: number): MemoryObservation[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (project) {
      clauses.push("(project = ? OR merged_into_project = ?)");
      params.push(project, project);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = this.db
      .prepare(`
SELECT * FROM observations
${whereSql}
ORDER BY created_at DESC, id DESC
LIMIT ?
`)
      .all(...params, safeLimit) as ObservationRow[];
    return rows.map(rowToObservation);
  }

  private searchContextIndex(request: ContextInjectRequest, limit: number): MemorySearchIndexResult[] {
    const query = sanitizeFtsQuery(request.q);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (request.project) {
      appendProjectClauses(clauses, params, "o");
      params.push(request.project, request.project);
    }
    if (this.config.context.types.length === 1) {
      clauses.push("o.type = ?");
      params.push(this.config.context.types[0]);
    } else if (this.config.context.types.length > 1) {
      clauses.push(`o.type IN (${this.config.context.types.map(() => "?").join(", ")})`);
      params.push(...this.config.context.types);
    }

    const rows = query
      ? this.db
        .prepare(`
SELECT o.id, o.created_at, o.project, o.type, o.title, o.narrative, o.files_json, o.concepts_json, o.confidence
FROM observations_fts f
JOIN observations o ON o.id = f.rowid
WHERE observations_fts MATCH ?${clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : ""}
ORDER BY rank, o.created_at DESC, o.id DESC
`)
        .all(query, ...params) as SearchRow[]
      : this.db
        .prepare(`
SELECT o.id, o.created_at, o.project, o.type, o.title, o.narrative, o.files_json, o.concepts_json, o.confidence
FROM observations o
${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
ORDER BY o.created_at DESC, o.id DESC
`)
        .all(...params) as SearchRow[];

    return filterContextResults(rows.map(row => ({
      id: row.id,
      ref: `#${row.id}`,
      recordType: "observation",
      createdAt: row.created_at,
      project: row.project,
      type: row.type,
      title: row.title,
      files: parseJsonArray(row.files_json),
      concepts: parseJsonArray(row.concepts_json),
    })), [], this.config.context.concepts).slice(0, limit);
  }

  close(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      this.db.close();
    }
  }

  private getSession(contentSessionId: string): { project: string; memory_session_id: string | null } | undefined {
    return this.db
      .prepare("SELECT project, memory_session_id FROM sdk_sessions WHERE content_session_id = ?")
      .get(contentSessionId) as { project: string; memory_session_id: string | null } | undefined;
  }

  private async resolveTimelineAnchor(request: TimelineRequest): Promise<MemoryTimelineItem | undefined> {
    const anchor = request.anchor;
    const project = request.project;
    if (typeof anchor === "string") {
      const trimmed = anchor.trim();
      const prefixed = /^(#|S|P)(\d+)$/i.exec(trimmed);
      if (prefixed) {
        const ref = `${prefixed[1].toUpperCase() === "#" ? "#" : prefixed[1].toUpperCase()}${prefixed[2]}`;
        return this.getTimelineItems(project).find(item => item.ref === ref);
      }
      const numeric = Number(trimmed);
      if (Number.isInteger(numeric) && numeric > 0) {
        const rows = await this.getObservations({ ids: [numeric], project });
        return rows.observations[0];
      }
      const timestamp = Date.parse(trimmed);
      if (Number.isFinite(timestamp)) {
        const target = Math.floor(timestamp / 1000);
        return this.getTimelineItems(project).sort((a, b) => Math.abs(a.createdAt - target) - Math.abs(b.createdAt - target))[0];
      }
    } else if (typeof anchor === "number" && Number.isInteger(anchor) && anchor > 0) {
      const rows = await this.getObservations({ ids: [anchor], project });
      return rows.observations[0];
    }
    if (request.query) {
      const search = await this.search({ query: request.query, project, limit: 1, obs_type: "observation" });
      const id = search.results[0]?.id;
      if (id) {
        const rows = await this.getObservations({ ids: [id], project });
        return rows.observations[0];
      }
    }
    return undefined;
  }

  private redact(text: string): string {
    return this.config.redaction.privateTag ? stripPrivateTags(text) : text;
  }

  private async extractObservationSafe(request: ObservationExtractionRequest): Promise<ObservationExtractionResult | undefined> {
    if (!this.extractObservation || this.config.ai.source === "heuristic") return undefined;
    try {
      return await this.extractObservation(request);
    } catch (error) {
      if (this.config.ai.failOpen) return undefined;
      throw error;
    }
  }

  private async summarizeTextSafe(request: SessionSummaryRequest): Promise<string | undefined> {
    if (!this.summarizeText || this.config.ai.source === "heuristic") return undefined;
    try {
      const summary = await this.summarizeText(request);
      return summary?.trim() ? summary : undefined;
    } catch (error) {
      if (this.config.ai.failOpen) return undefined;
      throw error;
    }
  }

  private getRecentSessionSummaries(project: string | undefined, limit: number): SessionSummaryRow[] {
    if (limit <= 0) return [];
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (project) {
      clauses.push("(project = ? OR merged_into_project = ?)");
      params.push(project, project);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`
SELECT id, content_session_id, project, summary, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, created_at
FROM session_summaries
${whereSql}
ORDER BY created_at DESC, rowid DESC
LIMIT ?
`)
      .all(...params, limit) as SessionSummaryRow[];
  }

  private applyRetention(project: string): void {
    const idsToDelete: number[] = [];
    if (this.config.retention.pruneDays !== null) {
      const cutoff = this.now() - this.config.retention.pruneDays * 86_400;
      const rows = this.db
        .prepare("SELECT id FROM observations WHERE project = ? AND created_at < ?")
        .all(project, cutoff) as Array<{ id: number }>;
      idsToDelete.push(...rows.map(row => row.id));
    }
    if (this.config.retention.maxObservations !== null) {
      const rows = this.db
        .prepare(`
SELECT id FROM observations
WHERE project = ?
ORDER BY created_at DESC, id DESC
LIMIT -1 OFFSET ?
`)
        .all(project, this.config.retention.maxObservations) as Array<{ id: number }>;
      idsToDelete.push(...rows.map(row => row.id));
    }
    this.deleteObservations(uniqueNumbers(idsToDelete));
  }

  private deleteObservations(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM observations WHERE id IN (${placeholders})`).run(...ids);
    this.rebuildFtsIndex();
  }

  private rebuildFtsIndex(): void {
    this.db.prepare("INSERT INTO observations_fts(observations_fts) VALUES('delete-all')").run();
    const rows = this.db
      .prepare("SELECT id, title, subtitle, narrative, COALESCE(NULLIF(text, ''), narrative) AS text, COALESCE(NULLIF(facts, ''), facts_json) AS facts, COALESCE(NULLIF(files_read, ''), files_json) AS files_read, COALESCE(NULLIF(concepts, ''), concepts_json) AS concepts FROM observations")
      .all() as Array<{ id: number; title: string; subtitle: string | null; narrative: string; text: string | null; facts: string | null; files_read: string | null; concepts: string | null }>;
    const insert = this.db.prepare("INSERT INTO observations_fts (rowid, title, subtitle, narrative, text, facts, files, concepts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const row of rows) {
      insert.run(row.id, row.title, row.subtitle, row.narrative, row.text, row.facts, row.files_read, row.concepts);
    }
  }

  private rebuildSessionSummaryFtsIndex(): void {
    this.db.prepare("INSERT INTO session_summaries_fts(session_summaries_fts) VALUES('delete-all')").run();
    const rows = this.db
      .prepare("SELECT id, summary, request, investigated, learned, completed, next_steps, notes FROM session_summaries")
      .all() as Array<{ id: number; summary: string; request: string | null; investigated: string | null; learned: string | null; completed: string | null; next_steps: string | null; notes: string | null }>;
    const insert = this.db.prepare("INSERT INTO session_summaries_fts (rowid, summary, request, investigated, learned, completed, next_steps, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const row of rows) {
      insert.run(row.id, row.summary, row.request, row.investigated, row.learned, row.completed, row.next_steps, row.notes);
    }
  }
}

export function formatMemorySearchResponse(response: MemorySearchResponse): string {
  if (response.results.length === 0) return "No memory results found.";
  const lines = ["| ID | Record | Type | Title | Files |", "|---|---|---|---|---|"];
  for (const result of response.results) {
    lines.push(`| ${result.ref} | ${result.recordType} | ${result.type} | ${escapeTable(result.title)} | ${escapeTable(result.files.slice(0, 3).join(", "))} |`);
  }
  return lines.join("\n");
}

export function formatMemoryTimelineResponse(response: MemoryTimelineResponse): string {
  if (response.items.length === 0) return "No memory timeline found.";
  return response.items
    .map(item => `${isTimelineAnchor(item, response.anchor) ? "*" : "-"} ${item.ref} [${item.type}] ${item.title}\n  ${clampText(item.narrative, 240)}`)
    .join("\n");
}

export function formatMemoryGetResponse(response: MemoryGetResponse): string {
  if (response.observations.length === 0) return "No memory observations found.";
  return response.observations
    .map(item => {
      const facts = item.facts.map(fact => `  - ${fact}`).join("\n");
      const files = item.files.length > 0 ? `\nFiles: ${item.files.join(", ")}` : "";
      return `#${item.id} [${item.type}] ${item.title}\n${item.narrative}${files}${facts ? `\nFacts:\n${facts}` : ""}`;
    })
    .join("\n\n");
}

function filterContextResults(results: MemorySearchIndexResult[], types: string[], concepts: string[]): MemorySearchIndexResult[] {
  const typeSet = new Set(types.map(type => type.toLowerCase()));
  const conceptSet = new Set(concepts.map(concept => concept.toLowerCase()));
  return results.filter(result => {
    if (typeSet.size > 0 && !typeSet.has(result.type.toLowerCase())) return false;
    if (conceptSet.size > 0 && !result.concepts.some(concept => conceptSet.has(concept.toLowerCase()))) return false;
    return true;
  });
}

function formatFullContextObservation(observation: MemoryObservation, fullField: "narrative" | "facts"): string {
  const files = observation.files.length > 0 ? `\nFiles: ${observation.files.join(", ")}` : "";
  if (fullField === "facts") {
    const facts = observation.facts.map(fact => `  - ${fact}`).join("\n");
    return `${facts ? `Facts:\n${facts}` : "Facts: none captured"}${files}`;
  }
  const facts = observation.facts.map(fact => `  - ${fact}`).join("\n");
  return `${observation.narrative}${files}${facts ? `\nFacts:\n${facts}` : ""}`;
}

function rowToObservation(row: ObservationRow): MemoryObservation {
  return {
    id: row.id,
    ref: `#${row.id}`,
    recordType: "observation",
    contentSessionId: row.content_session_id,
    memorySessionId: row.memory_session_id,
    project: row.project,
    toolName: row.tool_name,
    toolUseId: row.tool_use_id,
    type: row.type,
    title: row.title,
    narrative: row.narrative,
    facts: parseJsonArray(row.facts_json),
    files: parseJsonArray(row.files_json),
    concepts: parseJsonArray(row.concepts_json),
    confidence: row.confidence,
    createdAt: row.created_at,
    cwd: row.cwd,
    platformSource: row.platform_source,
    agentId: row.agent_id,
    agentType: row.agent_type,
    generatedByModel: row.generated_by_model,
    metadata: parseJsonObject(row.metadata),
  };
}

function rowToPromptTimelineItem(row: PromptRow): MemoryTimelineItem {
  const title = clampText(row.prompt_text.replace(/\s+/g, " "), 96);
  return {
    id: row.id,
    ref: `P${row.id}`,
    recordType: "prompt",
    createdAt: row.created_at,
    project: row.project,
    type: "prompt",
    title,
    narrative: row.prompt_text,
    facts: [],
    files: [],
    concepts: [],
  };
}

function rowToSessionTimelineItem(row: SessionRow): MemoryTimelineItem {
  const title = clampText(summaryTitle(row).replace(/\s+/g, " "), 96);
  return {
    id: row.id,
    ref: `S${row.id}`,
    recordType: "session",
    createdAt: row.created_at,
    project: row.project,
    type: "session",
    title,
    narrative: row.summary,
    facts: [],
    files: unique([...parseJsonArray(row.files_read ?? "[]"), ...parseJsonArray(row.files_edited ?? "[]")]),
    concepts: [],
  };
}

function compareTimelineItems(a: MemoryTimelineItem, b: MemoryTimelineItem): number {
  return a.createdAt - b.createdAt || timelineWeight(a.recordType) - timelineWeight(b.recordType) || a.id - b.id;
}

function timelineWeight(recordType: SearchRecordType): number {
  if (recordType === "prompt") return 0;
  if (recordType === "observation") return 1;
  return 2;
}

function isTimelineAnchor(item: MemoryTimelineItem, anchor: number | string | null): boolean {
  if (anchor === null) return false;
  return typeof anchor === "number" ? item.recordType === "observation" && item.id === anchor : item.ref === anchor;
}

function buildSummaryArtifact(observations: MemoryObservation[]): string {
  const lines = [
    "# Memory summary",
    "",
    "This file is generated by omp-mem, a claude-mem-compatible replacement plugin.",
    "Memory is advisory; verify against current repo state before acting.",
    "",
  ];
  for (const observation of observations.slice(0, 12)) {
    lines.push(`- #${observation.id} [${observation.type}] ${observation.title}`);
  }
  if (observations.length === 0) {
    lines.push("No observations captured yet.");
  }
  lines.push("");
  return lines.join("\n");
}

function buildFullArtifact(observations: MemoryObservation[]): string {
  const lines = ["# MEMORY", "", "Generated by omp-mem.", ""];
  for (const observation of observations) {
    lines.push(`## #${observation.id} [${observation.type}] ${observation.title}`);
    lines.push("", observation.narrative, "");
    if (observation.files.length > 0) lines.push(`Files: ${observation.files.join(", ")}`, "");
    if (observation.facts.length > 0) {
      lines.push("Facts:");
      for (const fact of observation.facts) lines.push(`- ${fact}`);
      lines.push("");
    }
  }
  if (observations.length === 0) lines.push("No observations captured yet.", "");
  return lines.join("\n");
}

function stripPrivateTags(text: string): string {
  return text.replace(PRIVATE_TAG_PATTERN, "[private redacted]");
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

function classifyObservation(text: string): ObservationKind {
  const lower = text.toLowerCase();
  if (/\b(fix|fixed|bug|error|failure|failed|regression)\b/.test(lower)) return "bugfix";
  if (/\b(decided|decision|choose|chosen|tradeoff|because)\b/.test(lower)) return "decision";
  if (/\b(refactor|rename|cleanup|simplify)\b/.test(lower)) return "refactor";
  if (/\b(added|implemented|feature|support)\b/.test(lower)) return "feature";
  if (/\b(prefer|preference|always|never)\b/.test(lower)) return "preference";
  if (/\b(found|discovered|investigated|learned)\b/.test(lower)) return "discovery";
  return "change";
}

function buildTitle(text: string): string {
  const clean = stripPrivateTags(text).split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "Memory observation";
  return clampText(clean.replace(/\s+/g, " "), 96);
}

function extractFiles(text: string): string[] {
  return unique((text.match(FILE_PATTERN) ?? []).map(file => file.replaceAll("\\", "/"))).slice(0, 20);
}

function extractConcepts(text: string, toolName: string): string[] {
  const words = text
    .split(/[^A-Za-z0-9_-]+/)
    .filter(word => word.length >= 4 && !COMMON_WORDS.has(word.toLowerCase()))
    .slice(0, 30);
  return unique([toolName, ...words]);
}

function extractFacts(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .map(line => line.trim())
    .filter(line => line.length >= 8)
    .slice(0, 6)
    .map(line => clampText(line, 240));
}

function normalizeStringList(value: unknown, fallback: string[], limit: number): string[] {
  if (!Array.isArray(value)) return fallback;
  const normalized = value
    .map(item => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return unique(normalized).slice(0, limit);
}

function normalizeObservationKind(value: unknown, fallback: ObservationKind): ObservationKind {
  return value === "bugfix" ||
    value === "feature" ||
    value === "decision" ||
    value === "discovery" ||
    value === "refactor" ||
    value === "change" ||
    value === "preference"
    ? value
    : fallback;
}

function normalizeConfidence(value: unknown, fallback: ObservationConfidence): ObservationConfidence {
  return value === "observed" || value === "inferred" ? value : fallback;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}


interface StructuredSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string[];
  files_edited: string[];
  notes: string | null;
}

function tableColumns(db: Database, tableName: string): string[] {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map(row => row.name);
}
function normalizeSearchScope(request: SearchRequest): SearchScope {
  const rawTypeValues = [...parseStringValues(request.type), ...parseStringValues(request.obs_type)];
  const recordTypes = new Set<SearchRecordType>();
  const observationTypes = new Set<string>();
  for (const value of rawTypeValues) {
    const normalized = value.toLowerCase();
    const recordType = normalizeRecordType(normalized);
    if (recordType) {
      recordTypes.add(recordType);
    } else if (isObservationKind(normalized)) {
      observationTypes.add(normalized);
    }
  }
  if (rawTypeValues.length > 0 && recordTypes.size === 0 && observationTypes.size === 0) {
    return {
      recordTypes: [],
      observationTypes: [],
      concepts: parseStringValues(request.concepts ?? request.concept),
      files: parseStringValues(request.files ?? request.filePath),
      isFolder: parseBoolean(request.isFolder),
    };
  }
  if (recordTypes.size === 0) {
    recordTypes.add("observation");
  }
  return {
    recordTypes: [...recordTypes],
    observationTypes: [...observationTypes],
    concepts: parseStringValues(request.concepts ?? request.concept),
    files: parseStringValues(request.files ?? request.filePath),
    isFolder: parseBoolean(request.isFolder),
  };
}

function normalizeRecordType(value: string): SearchRecordType | undefined {
  if (value === "observation" || value === "observations") return "observation";
  if (value === "session" || value === "sessions" || value === "session_summary" || value === "session_summaries") return "session";
  if (value === "prompt" || value === "prompts" || value === "user_prompt" || value === "user_prompts") return "prompt";
  return undefined;
}

function isObservationKind(value: string): value is ObservationKind {
  return value === "bugfix" || value === "feature" || value === "decision" || value === "discovery" || value === "refactor" || value === "change" || value === "preference";
}

function parseStringValues(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.flatMap(item => parseStringValues(item));
  if (typeof value !== "string") return [];
  return value.split(",").map(item => item.trim()).filter(Boolean);
}

function appendDateClauses(clauses: string[], params: unknown[], column: string, dateStart?: string, dateEnd?: string): void {
  if (dateStart) {
    clauses.push(`${column} >= ?`);
    params.push(dateToUnix(dateStart));
  }
  if (dateEnd) {
    clauses.push(`${column} <= ?`);
    params.push(dateToUnix(dateEnd, true));
  }
}

function appendProjectClauses(clauses: string[], _params: unknown[], tableAlias: string): void {
  clauses.push(`(${tableAlias}.project = ? OR ${tableAlias}.merged_into_project = ?)`);
}

function appendJsonTextClauses(clauses: string[], params: unknown[], column: string, values: string[]): void {
  if (values.length === 0) return;
  clauses.push(`(${values.map(() => `LOWER(${column}) LIKE ? ESCAPE '\\'`).join(" OR ")})`);
  params.push(...values.map(value => `%${escapeLike(value.toLowerCase())}%`));
}

function matchesJsonArrayFilters(values: string[], filters: string[], mode: "exact" | "contains"): boolean {
  if (filters.length === 0) return true;
  const normalizedValues = values.map(value => normalizeFilterValue(value));
  return filters.some(filter => {
    const normalizedFilter = normalizeFilterValue(filter);
    return normalizedValues.some(value => mode === "exact" ? value === normalizedFilter : value.includes(normalizedFilter));
  });
}

function matchesFileFilters(values: string[], filters: string[], isFolder: boolean): boolean {
  if (filters.length === 0) return true;
  const normalizedValues = values.map(value => normalizePathFilterValue(value));
  return filters.some(filter => {
    const normalizedFilter = normalizePathFilterValue(filter).replace(/\/+$/g, "");
    if (!normalizedFilter) return false;
    if (!isFolder) return normalizedValues.some(value => value.includes(normalizedFilter));
    return normalizedValues.some(value => {
      const rest = value.startsWith(`${normalizedFilter}/`) ? value.slice(normalizedFilter.length + 1) : "";
      return rest.length > 0 && !rest.includes("/");
    });
  });
}

function appendLikeClause(clauses: string[], params: unknown[], columns: string[], query: string | undefined): void {
  const terms = parseStringValues(query).flatMap(value => value.split(/\s+/)).filter(Boolean);
  if (terms.length === 0) return;
  for (const term of terms) {
    clauses.push(`(${columns.map(column => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    params.push(...columns.map(() => `%${escapeLike(term)}%`));
  }
}

function compareSearchResults(a: MemorySearchIndexResult, b: MemorySearchIndexResult, orderBy: string | undefined, hasQuery: boolean): number {
  if (orderBy === "date_asc") return a.createdAt - b.createdAt || a.id - b.id;
  if (orderBy === "date_desc") return b.createdAt - a.createdAt || b.id - a.id;
  const aRank = (a as MemorySearchIndexResult & { rank?: number }).rank;
  const bRank = (b as MemorySearchIndexResult & { rank?: number }).rank;
  if (hasQuery && (aRank !== undefined || bRank !== undefined)) {
    return (aRank ?? Number.POSITIVE_INFINITY) - (bRank ?? Number.POSITIVE_INFINITY) || b.createdAt - a.createdAt || b.id - a.id;
  }
  return b.createdAt - a.createdAt || b.id - a.id;
}

function normalizeFilterValue(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePathFilterValue(value: string): string {
  return normalizeFilterValue(value).replaceAll("\\", "/");
}

function parseBoolean(value: boolean | string | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "y"].includes(value.trim().toLowerCase());
}

function parseStructuredSummary(value: string): StructuredSummary | null {
  const parsed = parseJsonObject(value);
  if (!parsed) return null;
  const keys = ["request", "investigated", "learned", "completed", "next_steps", "files_read", "files_edited", "notes"];
  if (!keys.some(key => Object.prototype.hasOwnProperty.call(parsed, key))) return null;
  const summary: StructuredSummary = {
    request: structuredText(parsed.request),
    investigated: structuredText(parsed.investigated),
    learned: structuredText(parsed.learned),
    completed: structuredText(parsed.completed),
    next_steps: structuredText(parsed.next_steps),
    files_read: structuredStringList(parsed.files_read, 80, 240),
    files_edited: structuredStringList(parsed.files_edited, 80, 240),
    notes: structuredText(parsed.notes),
  };
  return summary.request || summary.investigated || summary.learned || summary.completed || summary.next_steps || summary.notes || summary.files_read.length > 0 || summary.files_edited.length > 0
    ? summary
    : null;
}

function structuredText(value: unknown): string | null {
  if (typeof value === "string") return nullableTrimmed(value, 2_000);
  if (Array.isArray(value)) return nullableTrimmed(value.filter((item): item is string => typeof item === "string").join("\n"), 2_000);
  return null;
}

function structuredStringList(value: unknown, limit: number, maxLength: number): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return unique(values.filter((item): item is string => typeof item === "string").map(item => clampText(item.trim(), maxLength)).filter(Boolean)).slice(0, limit);
}

function nullableTrimmed(value: string, maxLength: number): string | null {
  const trimmed = value.trim();
  return trimmed ? clampText(trimmed, maxLength) : null;
}

function buildStructuredSummaryText(summary: StructuredSummary): string {
  const lines: string[] = [];
  if (summary.request) lines.push(`Request: ${summary.request}`);
  if (summary.investigated) lines.push(`Investigated: ${summary.investigated}`);
  if (summary.learned) lines.push(`Learned: ${summary.learned}`);
  if (summary.completed) lines.push(`Completed: ${summary.completed}`);
  if (summary.next_steps) lines.push(`Next steps: ${summary.next_steps}`);
  if (summary.files_read.length > 0) lines.push(`Files read: ${summary.files_read.join(", ")}`);
  if (summary.files_edited.length > 0) lines.push(`Files edited: ${summary.files_edited.join(", ")}`);
  if (summary.notes) lines.push(`Notes: ${summary.notes}`);
  return clampText(lines.join("\n"), 8_000);
}

function summaryTitle(row: SessionRow): string {
  return row.summary;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function memorySessionIdFor(contentSessionId: string): string {
  return `omp-mem:${contentSessionId}`;
}

function hashObservation(memorySessionId: string, toolUseId: string | null, toolName: string, title: string, narrative: string): string {
  return createHash("sha256").update([memorySessionId, toolUseId ?? "", toolName, title, narrative].join("\0")).digest("hex");
}

function isoFromUnix(value: number): string {
  return new Date(value * 1000).toISOString();
}

function redactJsonValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(item => redactJsonValue(item, redact));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) result[redact(key)] = redactJsonValue(entry, redact);
    return result;
  }
  return value;
}

function parseLimit(value: number | string | undefined, fallback: number, max = MAX_LIMIT): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!parsed || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function parseOffset(value: number | string | undefined): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!parsed || !Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function sanitizeFtsQuery(query: string | undefined): string {
  const terms = (query ?? "")
    .split(/[^\p{L}\p{N}_-]+/u)
    .map(term => term.trim())
    .filter(term => term.length > 0)
    .slice(0, 12);
  return terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" ");
}

function normalizeProject(project: string | undefined): string {
  const trimmed = project?.trim();
  return trimmed || DEFAULT_PROJECT;
}

function encodeProjectPath(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function clampText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter(value => Number.isInteger(value) && value > 0))];
}

function dateToUnix(value: string, endOfDay = false): number {
  const date = new Date(value);
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return Math.floor(date.getTime() / 1000);
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await Bun.file(filePath).text();
  } catch {
    return "";
  }
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

const COMMON_WORDS = new Set([
  "with",
  "that",
  "this",
  "from",
  "have",
  "were",
  "will",
  "tool",
  "response",
  "command",
  "fixed",
  "updated",
  "using",
  "into",
  "after",
]);
