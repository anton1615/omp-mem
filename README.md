# omp-mem

Claude-mem-compatible replacement memory extension for Oh My Pi / OMP.

`omp-mem` records OMP session context, prompts, tool observations, compact events, and session summaries into a project-scoped SQLite store. It exposes the familiar progressive memory workflow through `memory_search`, `memory_timeline`, and `memory_get_observations`, then injects a compact memory summary into future agent turns.

## What it does

- Captures session starts and user prompts through OMP lifecycle events.
- Records tool results from `tool_result` and `tool_execution_end`, deduplicating the same tool call when both events fire.
- Skips recording its own memory tools to avoid feedback loops.
- Records `session_compact` entries as observations.
- Writes compatible artifacts:
  - `memory_summary.md`
  - `MEMORY.md`
- Stores project memory in SQLite at:
  - `~/.omp/agent/omp-mem/state/<encoded-project-path>/omp-mem.sqlite` by default; set `ompMem.dataDir` to move this root

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
    provider: omp        # "omp" uses OMP's model registry; "heuristic" disables model calls
    model: current       # current, canonical ID, or provider/model-id
    maxTokens: 1024
    failOpen: true       # fall back to heuristic extraction if the model call fails
  capture:
    prompts: true
    tools: true
    agentEnd: true
    sessionCompact: true
    skipTools:
      - memory_search
      - memory_timeline
      - memory_get_observations
      - todo_write
      - ask
  context:
    enabled: true
    observations: 50
    sessions: 10
    fullCount: 5
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

With `ai.provider: omp`, the extension can use an OMP model to extract durable observations and summarize session-end assistant output. It resolves the configured model from the active OMP context/model registry, obtains the provider API key through `ctx.modelRegistry.getApiKey(...)`, and calls `@oh-my-pi/pi-ai` for a compact JSON observation or markdown session summary.

If no model/API key is available or the model call fails while `failOpen: true`, `omp-mem` stores a deterministic heuristic observation instead of blocking the agent turn.

Supported `~/.omp/agent/omp-mem/settings.json` compatibility aliases include:

```json
{
  "CLAUDE_MEM_MODEL": "google/gemini-2.5-flash",
  "CLAUDE_MEM_MODE": "code",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50",
  "CLAUDE_MEM_CONTEXT_SESSION_COUNT": "10",
  "CLAUDE_MEM_CONTEXT_FULL_COUNT": "5",
  "CLAUDE_MEM_SKIP_TOOLS": "memory_search,memory_timeline,memory_get_observations"
}
```

Provider selection is OMP-native: use an OMP model reference (`current`, canonical ID, or `provider/model-id`) rather than Claude Code's original `CLAUDE_MEM_PROVIDER` worker setting.

## Tools

### `memory_search`

Step 1 of the progressive lookup flow. It returns compact matching IDs only, so the agent can filter before loading details.

Common parameters:

- `query` — full-text search query
- `project` — project filter
- `type` / `obs_type` — observation filters
- `dateStart` / `dateEnd` — date bounds
- `limit` / `offset` — pagination
- `orderBy` — `date_desc`, `date_asc`, or `relevance`

### `memory_timeline`

Step 2. It returns chronological context around an anchor ID or around the best match for a query.

Common parameters:

- `anchor` — observation ID
- `query` — search query used to choose an anchor
- `depth_before` / `depth_after` — surrounding observations to include
- `project` — project filter

### `memory_get_observations`

Step 3. It fetches full observation details after IDs have been filtered.

Common parameters:

- `ids` — observation IDs to fetch
- `project` — project filter
- `limit` — maximum observations
- `orderBy` — `date_desc` or `date_asc`

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

### Local development

```bash
omp plugin link C:/Users/Anton/.omp/agent/extensions/omp-mem
```

If OMP is already running, restart it after linking or updating the extension.

### Explicit extension path

You can also load the extension directly:

```bash
omp --extension C:/Users/Anton/.omp/agent/extensions/omp-mem/index.ts
```

Or add the plugin root to your OMP settings extension paths.

### Marketplace install

This repository is intended to be both the plugin repo root and the marketplace repo root.

Add the GitHub repo as a marketplace:

```bash
omp plugin marketplace add anton1615/omp-mem
```

Install the plugin from that marketplace:

```bash
omp plugin install omp-mem@omp-mem
```

If your current OMP build does not auto-load extension modules installed from marketplace/plugin roots, use `omp plugin link` or an explicit `--extension` path and restart OMP.

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

This repo is intentionally both:

- the plugin repo root, and
- the marketplace repo root.

Relevant files:

- `package.json` — OMP extension manifest and package metadata
- `index.ts` — public entry point
- `src/extension.ts` — OMP adapter: lifecycle hooks, tools, and `/mem` command
- `src/service.ts` — SQLite-backed memory service and response formatting
- `test/` — service and extension behavior tests
- `.claude-plugin/marketplace.json` — marketplace catalog pointing to `./`

## Operational notes

- `omp-mem` stores memory outside this repository under `~/.omp/agent/omp-mem/state/`.
- Deleting a project state directory removes that project's local memory store and generated artifacts.
- The extension strips only explicit `<private>...</private>` spans; do not send secrets to tools unless you intend the surrounding non-private context to be recordable.
- `memory_search` should be used before `memory_get_observations` to avoid loading unnecessary detail into context.
