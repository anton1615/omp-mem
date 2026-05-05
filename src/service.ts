import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type ObservationKind = "bugfix" | "feature" | "decision" | "discovery" | "refactor" | "change" | "preference";
export type ObservationConfidence = "observed" | "inferred";

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
}

export interface SummarizeRequest {
  contentSessionId: string;
  last_assistant_message?: string;
  agentId?: string;
  platformSource?: string;
}

export interface SearchRequest {
  query?: string;
  limit?: number | string;
  offset?: number | string;
  type?: ObservationKind | string;
  obs_type?: "observation" | "session" | "prompt" | string;
  project?: string;
  dateStart?: string;
  dateEnd?: string;
  orderBy?: "date_desc" | "date_asc" | "relevance" | string;
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

export interface MemoryObservation {
  id: number;
  contentSessionId: string;
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
}

export interface MemorySearchIndexResult {
  id: number;
  createdAt: number;
  project: string;
  type: ObservationKind;
  title: string;
  files: string[];
  concepts: string[];
}

export interface MemorySearchResponse {
  results: MemorySearchIndexResult[];
  total: number;
}

export interface MemoryTimelineResponse {
  anchor: number | null;
  items: MemoryObservation[];
}

export interface MemoryGetResponse {
  observations: MemoryObservation[];
}

export interface MemoryServiceOptions {
  memoryRoot: string;
  dbPath?: string;
  now?: () => number;
}

export interface ResolveMemoryRootOptions {
  cwd: string;
  homeDir?: string;
}

interface ObservationRow {
  id: number;
  content_session_id: string;
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
}

interface SearchRow {
  id: number;
  created_at: number;
  project: string;
  type: ObservationKind;
  title: string;
  files_json: string;
  concepts_json: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_PROJECT = "default";
const PRIVATE_TAG_PATTERN = /<private>[\s\S]*?<\/private>/gi;
const FILE_PATTERN = /(?:[A-Za-z]:)?[\w.-]+(?:[\\/][\w.@()[\]-]+)+(?:\.[A-Za-z0-9]+)?/g;
const DB_NAME = "omp-mem.sqlite";


export function resolveMemoryRoot(options: ResolveMemoryRootOptions): string {
  const homeDir = options.homeDir ?? os.homedir();
  return path.join(homeDir, ".omp", "agent", "omp-mem", "state", encodeProjectPath(options.cwd));
}

export async function resolveMemoryDatabasePath(options: MemoryServiceOptions): Promise<string> {
  if (options.dbPath) return options.dbPath;
  return path.join(options.memoryRoot, DB_NAME);
}

export async function createMemoryService(options: MemoryServiceOptions): Promise<MemoryService> {
  await fs.mkdir(options.memoryRoot, { recursive: true });
  const db = new Database(await resolveMemoryDatabasePath(options));
  const service = new MemoryService(db, options.memoryRoot, options.now ?? unixNow);
  service.initialize();
  return service;
}

export class MemoryService {
  constructor(
    readonly db: Database,
    readonly memoryRoot: string,
    readonly now: () => number,
  ) {}

  initialize(): void {
    this.db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS sdk_sessions (
  content_session_id TEXT PRIMARY KEY,
  memory_session_id TEXT,
  project TEXT NOT NULL,
  custom_title TEXT,
  platform_source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_use_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  narrative TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  files_json TEXT NOT NULL,
  concepts_json TEXT NOT NULL,
  confidence TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  cwd TEXT,
  platform_source TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title,
  narrative,
  facts,
  files,
  concepts,
  content=''
);

CREATE TABLE IF NOT EXISTS session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);
  }

  async initSession(request: SessionInitRequest): Promise<void> {
    const now = this.now();
    const project = normalizeProject(request.project);
    this.db
      .prepare(`
INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, custom_title, platform_source, created_at, updated_at)
VALUES (?, NULL, ?, ?, ?, ?, ?)
ON CONFLICT(content_session_id) DO UPDATE SET
  project = excluded.project,
  custom_title = COALESCE(excluded.custom_title, sdk_sessions.custom_title),
  platform_source = excluded.platform_source,
  updated_at = excluded.updated_at
`)
      .run(request.contentSessionId, project, request.customTitle ?? null, request.platformSource ?? "omp", now, now);

    const promptText = stripPrivateTags(request.prompt ?? "").trim();
    if (promptText) {
      this.db
        .prepare("INSERT INTO user_prompts (content_session_id, project, prompt_text, created_at) VALUES (?, ?, ?, ?)")
        .run(request.contentSessionId, project, promptText, now);
    }
  }

  async recordObservation(request: ObservationRequest): Promise<number> {
    const now = this.now();
    const session = this.getSession(request.contentSessionId);
    const project = session?.project ?? normalizeProject(undefined);
    const toolResponse = unknownToText(request.tool_response);
    const toolInput = unknownToText(request.tool_input);
    const combinedText = stripPrivateTags([toolInput, toolResponse].filter(Boolean).join("\n")).trim();
    const narrative = clampText(combinedText || `${request.tool_name} completed`, 8_000);
    const files = extractFiles(narrative);
    const concepts = extractConcepts(narrative, request.tool_name);
    const facts = extractFacts(narrative);
    const type = classifyObservation(narrative);
    const title = buildTitle(toolResponse || toolInput || request.tool_name);
    const toolUseId = request.tool_use_id ?? request.toolUseId ?? null;
    const platformSource = request.platformSource ?? "omp";

    const insert = this.db
      .prepare(`
INSERT INTO observations (
  content_session_id, project, tool_name, tool_use_id, type, title, narrative,
  facts_json, files_json, concepts_json, confidence, created_at, cwd, platform_source
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
      .run(
        request.contentSessionId,
        project,
        request.tool_name,
        toolUseId,
        type,
        title,
        narrative,
        JSON.stringify(facts),
        JSON.stringify(files),
        JSON.stringify(concepts),
        "observed",
        now,
        request.cwd ?? null,
        platformSource,
      );

    const id = Number(insert.lastInsertRowid);
    this.db
      .prepare("INSERT INTO observations_fts (rowid, title, narrative, facts, files, concepts) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, title, narrative, facts.join(" "), files.join(" "), concepts.join(" "));
    return id;
  }

  async summarizeSession(request: SummarizeRequest): Promise<void> {
    const session = this.getSession(request.contentSessionId);
    const project = session?.project ?? DEFAULT_PROJECT;
    const summary = stripPrivateTags(request.last_assistant_message ?? "").trim();
    if (!summary) return;
    this.db
      .prepare("INSERT INTO session_summaries (content_session_id, project, summary, created_at) VALUES (?, ?, ?, ?)")
      .run(request.contentSessionId, project, clampText(summary, 8_000), this.now());
    await this.flushArtifacts(project);
  }

  async search(request: SearchRequest): Promise<MemorySearchResponse> {
    if (request.obs_type && request.obs_type !== "observation") {
      return { results: [], total: 0 };
    }
    const limit = parseLimit(request.limit, DEFAULT_LIMIT);
    const offset = parseOffset(request.offset);
    const clauses: string[] = [];
    const params: unknown[] = [];
    const query = sanitizeFtsQuery(request.query);
    const useFts = Boolean(query);

    if (request.project) {
      clauses.push("o.project = ?");
      params.push(request.project);
    }
    if (request.type) {
      clauses.push("o.type = ?");
      params.push(request.type);
    }
    if (request.dateStart) {
      clauses.push("o.created_at >= ?");
      params.push(dateToUnix(request.dateStart));
    }
    if (request.dateEnd) {
      clauses.push("o.created_at <= ?");
      params.push(dateToUnix(request.dateEnd, true));
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const orderSql = request.orderBy === "date_asc" ? "o.created_at ASC, o.id ASC" : "o.created_at DESC, o.id DESC";
    let rows: SearchRow[];

    if (useFts) {
      const ftsWhere = clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "";
      rows = this.db
        .prepare(`
SELECT o.id, o.created_at, o.project, o.type, o.title, o.files_json, o.concepts_json
FROM observations_fts f
JOIN observations o ON o.id = f.rowid
WHERE observations_fts MATCH ? ${ftsWhere}
ORDER BY ${request.orderBy === "date_asc" ? "o.created_at ASC, o.id ASC" : "rank, o.created_at DESC"}
LIMIT ? OFFSET ?
`)
        .all(query, ...params, limit, offset) as SearchRow[];
    } else {
      rows = this.db
        .prepare(`
SELECT o.id, o.created_at, o.project, o.type, o.title, o.files_json, o.concepts_json
FROM observations o
${whereSql}
ORDER BY ${orderSql}
LIMIT ? OFFSET ?
`)
        .all(...params, limit, offset) as SearchRow[];
    }

    return {
      results: rows.map(row => ({
        id: row.id,
        createdAt: row.created_at,
        project: row.project,
        type: row.type,
        title: row.title,
        files: parseJsonArray(row.files_json),
        concepts: parseJsonArray(row.concepts_json),
      })),
      total: rows.length,
    };
  }

  async timeline(request: TimelineRequest): Promise<MemoryTimelineResponse> {
    const anchor = await this.resolveAnchor(request);
    if (!anchor) return { anchor: null, items: [] };

    const depthBefore = parseLimit(request.depth_before, 3);
    const depthAfter = parseLimit(request.depth_after, 3);
    const project = request.project ?? anchor.project;
    const beforeRows = this.db
      .prepare(`
SELECT * FROM observations
WHERE project = ? AND (created_at < ? OR (created_at = ? AND id < ?))
ORDER BY created_at DESC, id DESC
LIMIT ?
`)
      .all(project, anchor.createdAt, anchor.createdAt, anchor.id, depthBefore) as ObservationRow[];
    const afterRows = this.db
      .prepare(`
SELECT * FROM observations
WHERE project = ? AND (created_at > ? OR (created_at = ? AND id > ?))
ORDER BY created_at ASC, id ASC
LIMIT ?
`)
      .all(project, anchor.createdAt, anchor.createdAt, anchor.id, depthAfter) as ObservationRow[];

    const items = [...beforeRows.reverse().map(rowToObservation), anchor, ...afterRows.map(rowToObservation)];
    return { anchor: anchor.id, items };
  }

  async getObservations(request: GetObservationsRequest): Promise<MemoryGetResponse> {
    const ids = request.ids.filter(id => Number.isInteger(id) && id > 0);
    if (ids.length === 0) return { observations: [] };
    const limit = parseLimit(request.limit, ids.length);
    const placeholders = ids.map(() => "?").join(", ");
    const params: unknown[] = [...ids];
    const clauses = [`id IN (${placeholders})`];
    if (request.project) {
      clauses.push("project = ?");
      params.push(request.project);
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
    const search = await this.search({ query: request.q, project: request.project, limit: request.limit ?? 5 });
    const summary = await readOptional(path.join(this.memoryRoot, "memory_summary.md"));
    const lines = [
      "# Memory Guidance",
      "Memory source: omp-mem claude-mem-compatible replacement plugin.",
      "Treat memory as advisory; current repository state and user instructions win.",
      "",
    ];
    if (summary.trim()) {
      lines.push("## Memory summary", summary.trim(), "");
    }
    if (search.results.length > 0) {
      lines.push("## Relevant memory index");
      for (const result of search.results) {
        lines.push(`- #${result.id} [${result.type}] ${result.title}`);
      }
      lines.push("Use memory_get_observations with filtered IDs before relying on details.");
    }
    return lines.join("\n").trim();
  }

  async flushArtifacts(project?: string): Promise<void> {
    await fs.mkdir(this.memoryRoot, { recursive: true });
    const search = await this.search({ project, limit: 50, orderBy: "date_desc" });
    const details = await this.getObservations({ ids: search.results.map(result => result.id), orderBy: "date_desc" });
    const summary = buildSummaryArtifact(details.observations);
    const full = buildFullArtifact(details.observations);
    await Bun.write(path.join(this.memoryRoot, "memory_summary.md"), summary);
    await Bun.write(path.join(this.memoryRoot, "MEMORY.md"), full);
  }

  close(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      this.db.close();
    }
  }

  private getSession(contentSessionId: string): { project: string } | undefined {
    return this.db
      .prepare("SELECT project FROM sdk_sessions WHERE content_session_id = ?")
      .get(contentSessionId) as { project: string } | undefined;
  }

  private async resolveAnchor(request: TimelineRequest): Promise<MemoryObservation | undefined> {
    const anchorId = typeof request.anchor === "string" ? Number(request.anchor) : request.anchor;
    if (anchorId && Number.isInteger(anchorId)) {
      const rows = await this.getObservations({ ids: [anchorId], project: request.project });
      return rows.observations[0];
    }
    if (request.query) {
      const search = await this.search({ query: request.query, project: request.project, limit: 1 });
      const id = search.results[0]?.id;
      if (id) {
        const rows = await this.getObservations({ ids: [id], project: request.project });
        return rows.observations[0];
      }
    }
    return undefined;
  }
}

export function formatMemorySearchResponse(response: MemorySearchResponse): string {
  if (response.results.length === 0) return "No memory results found.";
  const lines = ["| ID | Type | Title | Files |", "|---|---|---|---|"];
  for (const result of response.results) {
    lines.push(`| #${result.id} | ${result.type} | ${escapeTable(result.title)} | ${escapeTable(result.files.slice(0, 3).join(", "))} |`);
  }
  return lines.join("\n");
}

export function formatMemoryTimelineResponse(response: MemoryTimelineResponse): string {
  if (response.items.length === 0) return "No memory timeline found.";
  return response.items
    .map(item => `${item.id === response.anchor ? "*" : "-"} #${item.id} [${item.type}] ${item.title}\n  ${clampText(item.narrative, 240)}`)
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

function rowToObservation(row: ObservationRow): MemoryObservation {
  return {
    id: row.id,
    contentSessionId: row.content_session_id,
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
  };
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

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseLimit(value: number | string | undefined, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!parsed || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed)));
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
