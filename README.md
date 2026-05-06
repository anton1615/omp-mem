# omp-mem

Claude-mem-compatible replacement memory extension for Oh My Pi / OMP.

`omp-mem` records OMP session context, prompts, tool observations, compact events, manual memories, and session summaries into a project-scoped SQLite store. It exposes the familiar progressive memory workflow through `memory_search`, `memory_timeline`, and `memory_get_observations`, adds `memory_remember` for explicit saves, then injects a compact memory summary into future agent turns.

## Compatibility

- Supported OMP version: `>= 14.7.0`.
- This extension uses the OMP 14.7.0 `systemPrompt: string[]` hook contract for `before_agent_start` context injection.
- OMP versions before 14.7.0 used the legacy `systemPrompt: string` contract and are not supported by this branch. Use an older `omp-mem` revision if you need to run on pre-14.7.0 OMP.

## What it does

- Captures session starts and user prompts through OMP lifecycle events.
- Records tool results from `tool_result` and `tool_execution_end`, deduplicating the same tool call when both events fire.
- Skips recording its own memory tools to avoid feedback loops.
- Records `session_compact` entries as observations.
- Records manual memories through `memory_remember` using the same redaction and observation store.
- Writes compatible artifacts:
  - `memory_summary.md`
  - `MEMORY.md`
- Stores project memory in SQLite at:
  - `~/.omp/agent/omp-mem/state/<encoded-project-path>/omp-mem.sqlite` by default; set `ompMem.dataDir` to move this root
- Maintains claude-mem-aligned core columns for sessions, observations, prompts, session summaries, pending ingestion metadata, and observation feedback; daemon-only tables are present for schema compatibility but not used as a worker queue.

Private spans wrapped in `<private>...</private>` are stripped before observations are stored.

## Configuration

`omp-mem` reads user-facing config from the `ompMem:` block in `~/.omp/agent/config.yml`. If that block is absent, it can also read a plugin-owned compatibility file at `~/.omp/agent/omp-mem/settings.json` with common `CLAUDE_MEM_*` flat keys.

Example:

```yml
ompMem:
  enabled: true
  dataDir: auto
  mode: code
  ai:
    source: omp          # omp, direct, or heuristic
    maxTokens: 1024
    failOpen: true       # fall back to heuristic extraction if model work fails
    omp:
      provider: current  # current, or an OMP provider id such as cliproxyapi
      model: current     # current, or a model id within that OMP provider
    direct:
      api: openai-chat   # OpenAI-compatible /chat/completions
      baseUrl: ""        # e.g. https://openrouter.ai/api/v1
      apiKeyEnv: OMP_MEM_DIRECT_API_KEY
      model: ""
      headers: {}
  capture:
    prompts: true
    tools: true
    agentEnd: true
    sessionCompact: true
    skipTools:
      - memory_search
      - memory_timeline
      - memory_get_observations
      - memory_remember
      - todo_write
      - ask
  context:
    enabled: true
    observations: 50
    sessions: 10
    types: []
    concepts: []
    fullCount: 5
    fullField: narrative # narrative or facts
    includeSummary: true
  artifacts:
    enabled: true
    writeSummary: true
    writeMemoryMd: true
    maxObservations: 50
  search:
    defaultLimit: 20
    maxLimit: 100
  redaction:
    privateTag: true
```

### Model-based compression

`ai.source` intentionally separates model selection into two paths:

| Source | Required fields | Behavior |
|---|---|---|
| `omp` | `ai.omp.provider`, `ai.omp.model` | Uses OMP's configured providers, credentials, model registry, and default/inherited thinking settings. Use `current/current` to follow the active conversation model. |
| `direct` | `ai.direct.baseUrl`, `ai.direct.apiKey` or `apiKeyEnv`, `ai.direct.model` | Calls an OpenAI-compatible `/chat/completions` endpoint directly. This is for providers not configured in OMP. |
| `heuristic` | none | Disables model calls and uses deterministic local extraction only. |

`omp-mem` does not expose a thinking-effort setting for memory compression. When `source: omp`, thinking behavior is inherited from OMP/model defaults; when `source: direct`, no thinking parameter is sent.

Supported `~/.omp/agent/omp-mem/settings.json` compatibility aliases include:

```json
{
  "CLAUDE_MEM_PROVIDER": "openrouter",
  "CLAUDE_MEM_OPENROUTER_API_KEY": "sk-or-v1-...",
  "CLAUDE_MEM_OPENROUTER_MODEL": "xiaomi/mimo-v2-flash:free",
  "CLAUDE_MEM_MODE": "code",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50",
  "CLAUDE_MEM_CONTEXT_SESSION_COUNT": "10",
  "CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES": "bugfix,decision,discovery",
  "CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS": "how-it-works,gotcha",
  "CLAUDE_MEM_CONTEXT_FULL_COUNT": "5",
  "CLAUDE_MEM_CONTEXT_FULL_FIELD": "narrative",
  "CLAUDE_MEM_SKIP_TOOLS": "memory_search,memory_timeline,memory_get_observations,memory_remember"
}
```

### Claude-mem setting alignment

| Claude-mem setting | omp-mem status | Reason |
|---|---|---|
| `CLAUDE_MEM_MODE` | `mode` | Same concept. |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `context.observations` | Same range goal, used for injected index size. |
| `CLAUDE_MEM_CONTEXT_SESSION_COUNT` | `context.sessions` | Same concept, used for recent summaries. |
| `CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES` | `context.types` | Supported for context filtering. |
| `CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS` | `context.concepts` | Supported for context filtering against extracted concepts. |
| `CLAUDE_MEM_CONTEXT_FULL_COUNT` | `context.fullCount` | Supported for expanded observations. |
| `CLAUDE_MEM_CONTEXT_FULL_FIELD` | `context.fullField` | Supports `narrative` and `facts`. |
| `CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY` | `context.includeSummary` | Supported through generated `memory_summary.md` plus recent session summaries. |
| `CLAUDE_MEM_DATA_DIR` | `dataDir` | Supported but defaults to OMP-owned `~/.omp/agent/omp-mem`. |
| `CLAUDE_MEM_SKIP_TOOLS` | `capture.skipTools` | Supported with OMP tool names. |
| `POST /api/memory/save` | `memory_remember` | Implemented as an in-process OMP tool instead of an HTTP route. Stores a redacted manual `discovery` observation. |
| `CLAUDE_MEM_PROVIDER` / provider model keys | `ai.source`, `ai.omp`, `ai.direct` | Split because OMP itself already has provider/model configuration. Direct mode covers explicit base URL/API key/model. |
| Worker host/port, MCP server, Python/chroma, Claude Code path, hook timeouts | intentionally omitted | OMP extension runs in-process and exposes tools through OMP; no separate worker, Chroma daemon, Claude Code hook installer, or MCP server is required. |
| Web UI/version channel/folder `CLAUDE.md` generation | intentionally omitted | User requested no Web UI; `omp-mem` keeps memory files plugin-owned and avoids writing project folder context files. |
| Token economics display toggles, Chroma/vector search, and last-message injection | intentionally omitted for now | Current store does not persist read/work token economics, does not run a vector daemon, and does not store raw final-message artifacts as first-class context fields. |

`omp-mem` adds OMP-specific knobs not present in claude-mem: `enabled`, capture hook toggles, artifact write toggles, search result caps, private-tag redaction toggle, and optional retention pruning. These exist because OMP extensions can be enabled/disabled and can inject/write artifacts without a separate worker UI.

## Tools

### `memory_search`

Step 1 of the progressive lookup flow. It returns compact matching IDs only, so the agent can filter before loading details. Observation search is the default for backward compatibility; request `obs_type: prompt` or `obs_type: session` to search captured prompts or session summaries.

Common parameters:

- `query` — full-text search query
- `project` — project filter
- `type` — observation subtype filter, or a record family such as `observation`, `session`, or `prompt`
- `obs_type` — observation subtype or record family filter retained for claude-mem compatibility
- `concept` / `concepts` — concept filter for observations
- `filePath` / `files` — file filter for observations
- `dateStart` / `dateEnd` — date bounds
- `limit` / `offset` — pagination
- `orderBy` — `date_desc`, `date_asc`, or `relevance`

### `memory_timeline`

Step 2. It returns chronological context around an anchor ID or around the best match for a query. Numeric anchors refer to observations; `S<id>` anchors session summaries; `P<id>` anchors captured prompts.

Common parameters:

- `anchor` — observation ID, `S<summary-id>`, `P<prompt-id>`, or timestamp
- `query` — search query used to choose an observation anchor
- `depth_before` / `depth_after` — surrounding records to include
- `project` — project filter

### `memory_get_observations`

Step 3. It fetches full observation details after IDs have been filtered.

Common parameters:

- `ids` — observation IDs to fetch
- `project` — project filter
- `limit` — maximum observations
- `orderBy` — `date_desc` or `date_asc`


### `memory_remember`

Manual save path corresponding to claude-mem's memory-save API, exposed as an OMP tool instead of HTTP.

Common parameters:

- `text` — durable memory text to save
- `title` — optional short title
- `project` — optional project name; defaults to current project
- `metadata` — optional JSON metadata, redacted before storage

The tool stores a `discovery` observation with `tool_name = memory_remember` and applies `<private>...</private>` redaction before writing SQLite, FTS, or artifacts.

## Command

`/mem` manages the local memory artifacts.

```text
/mem status
/mem flush
/mem rebuild
```

- `status` reports whether `omp-mem` is ready and how many recent results were found.
- `flush` and `rebuild` write `memory_summary.md` and `MEMORY.md` from the current store.

## Install

Clone the repository directly into the OMP user extension directory:

```bash
mkdir -p ~/.omp/agent/extensions
cd ~/.omp/agent/extensions
git clone git@github.com:anton1615/omp-mem.git
cd omp-mem
bun install --production
```

On this Windows workstation, the equivalent target path is:

```bash
C:/Users/Anton/.omp/agent/extensions/omp-mem
```

If the repository already exists, update it in place:

```bash
cd ~/.omp/agent/extensions/omp-mem
git pull --ff-only
bun install --production
```

Restart OMP after cloning or updating the extension so the extension manifest is reloaded.

## Development

```bash
bun install
bun run check
```

The check script runs:

```bash
bun test ./test
bunx --package typescript tsc --noEmit
```

## Repository layout

This repo is intentionally the OMP extension package root. Clone it directly under `~/.omp/agent/extensions/`.

Relevant files:

- `package.json` — OMP extension manifest and package metadata
- `index.ts` — public entry point
- `src/extension.ts` — OMP adapter: lifecycle hooks, tools, and `/mem` command
- `src/service.ts` — SQLite-backed memory service and response formatting
- `test/` — service and extension behavior tests

## Operational notes

- `omp-mem` stores memory outside this repository under `~/.omp/agent/omp-mem/state/`.
- Deleting a project state directory removes that project's local memory store and generated artifacts.
- The extension strips only explicit `<private>...</private>` spans; do not send secrets to tools unless you intend the surrounding non-private context to be recordable.
- `memory_search` should be used before `memory_get_observations` to avoid loading unnecessary detail into context.
