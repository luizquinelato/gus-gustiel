# Gustiel — Architecture & Technical Baseline

> **Current version:** see `src/config/constants.js` → `VERSION`
> **Platform:** Atlassian Forge (serverless, runs inside Atlassian cloud)
> **Agent type:** Rovo AI Agent (conversational, action-based)

---

## What Is Gustiel?

Gustiel is a **Rovo AI Agent for Jira Portfolio Analysis**. It lives inside the Atlassian ecosystem and is invoked conversationally through Rovo Chat. Users interact with it in plain English — Gustiel translates intent into structured Jira/Confluence API calls, runs the results through an analytics pipeline, and delivers formatted reports either in chat or as permanent Confluence pages.

### Full Capability Map

| Skill | # | Mode | Description |
|---|---|---|---|
| Portfolio Report (Confluence) | 04 | Export | Full ETL pipeline → permanent Confluence page per portfolio key |
| Portfolio Analysis (Chat) | 05 | Chat | Same ETL pipeline → interactive chat, section-by-section pagination |
| Team Sprint Analysis | 06 | Chat | On-demand sprint velocity + trend analytics for a single team |
| Export Skill Documentation | 07 | Export | Exports a Gustiel user guide / skill reference to Confluence |
| Clear My Session Cache | 08 | Action | Deletes the user's own cached ETL session from Forge Storage |
| Storage Inspection | 09 | Action | Inspects Forge Storage session state (own or all, depending on role) |
| Get My Account ID | 10 | Action | Returns the calling user's Atlassian accountId |
| Admin — Wipe All Storage | Admin | Action | Deletes all session data for all users (admin only) |
| Admin — Manage Admin Registry | Admin | Action | Add/remove/list dynamic admins |

### Report Content (per portfolio key)

A full portfolio export produces a single Confluence page with these sections, in order:

1. **Table of Contents** — auto-generated from H2 headings via the native Confluence TOC macro
2. **Portfolio Overview** — objective title, environment, creation timestamp, quarter filter (if applied)
3. **📊 Portfolio Summary** — initiative status table + overdue counts
4. **📋 Epic Status Summary** — epic counts by status, grouped by team
5. **🏁 Initiatives** — per-initiative table with % complete, expected %, RYG badge, due date, days late
6. **🏷️ Epics by Team** — per-team H3 section with epic table (RYG, lead time, story count, dates)
7. **🚀 Innovation Velocity** — throughput comparison table across teams
8. **⏱️ Lead / Cycle Time** — per-team lead time and cycle time tables with definitions
9. **🏃 Sprint Analysis** — per-team sprint velocity table (last 6 closed sprints) + optional trend analytics:
   - 📈 Velocity Trend (stability coefficient of variation + 3-sprint direction flag)
   - 🔀 Scope Management (churn rate, additions completion rate)
   - 🎯 Predictability Score (weighted composite: 🟢=2 · 🟡=1 · 🔴=0, max 6 pts)
10. **Back-to-top links** — automatically injected before every H2 (except the first)

Scope is auto-detected (Objective / Initiative / Epic) and the section set rendered adjusts accordingly — e.g., an Epic-scope page skips the Initiatives table and shows only the Epic's stories.

---

## Architecture Overview

Gustiel is built on an **ETL (Extract → Transform → Load)** pattern.
Every feature must follow this layered separation of concerns.
The resolver is only the entry/exit door — it never contains business logic.

---

## Layer Map

```
src/
├── config/
│   └── constants.js               # Version, workflow dicts, field IDs, makeSessionKey — no logic
│
├── services/
│   ├── jira-api-service.js        # Raw HTTP I/O — the ONLY layer that calls Jira
│   └── confluence-api-service.js  # Confluence page CRUD, folder + space resolution
│
├── extractors/               # EXTRACT layer
│   ├── jira-extractor.js     # Raw API response → clean domain objects
│   └── sprint-extractor.js   # Sprint board discovery, GreenHopper fetch, shared semaphore
│
├── transformers/             # TRANSFORM layer
│   └── portfolio-transformer.js  # Pure calculations — no I/O, no rendering
│
├── formatters/               # LOAD layer
│   ├── markdown-formatter.js      # Domain data → Markdown (chat + Confluence section bodies)
│   └── confluence-formatter.js    # Markdown → Confluence Storage Format (XHTML); custom table colspan
│
├── resolvers/                # Entry/Exit handlers — thin orchestrators only
│   ├── portfolio-report-resolver.js   # Full ETL report (summary + team pages); multi-key Isolated/Merged
│   ├── confluence-export-resolver.js  # Confluence export (single or combined page); scope-aware
│   ├── prepare-export-resolver.js     # ETL step 1 — team + sprint board discovery
│   ├── lead-time-resolver.js          # ETL step 2 — LCT batched changelog query
│   ├── sprint-data-resolver.js        # ETL step 3 — GreenHopper sprint reports per team
│   ├── team-sprint-resolver.js        # Individual team sprint analysis (chat); returns boardId
│   ├── check-cache-resolver.js        # ETL cache state probe; scope detection
│   ├── skill-docs-resolver.js         # Export Skill Documentation to Confluence
│   ├── storage-admin-resolver.js      # Admin: full storage access; users: own sessions only
│   ├── portfolio-analysis-resolver.js # Analysis / Q&A skills; multi-key Isolated/Merged
│   ├── system-resolver.js
│   └── creator-resolver.js
│
└── utils/
    ├── token-estimator.js    # fitWithinBudget() — used by summary phase
    └── concurrency.js        # makeSemaphore() — shared GreenHopper rate-limit primitive
```

---

## Layer Responsibilities

### `services/` — Raw I/O
- Only layer allowed to make HTTP calls to Jira.
- Rate limiting, retries, and any future caching belong here.
- Returns raw API JSON — never interprets it.

### `extractors/` — Extract
- Maps raw Jira JSON into clean **domain objects**. Also owns async extraction that coordinates service calls.
- The only layer allowed to know Jira's raw field structure.
- **`jira-extractor.js`** — Pure functions: `extractItem(issue, envFields)`, `extractStoryStatus(issue)`, `extractItemScope(issue)`, `extractItemForLCT(issue, agileTeamField)`, `chunk(arr, n)`.
- **`sprint-extractor.js`** — Sprint-specific extraction (async). `extractNewestSprintIdByTeam(rawIssues, sprintField, epicKeyToTeam)` — pure; maps issue sprint fields to team board/sprint metadata. `enrichTeamSprintListsFromBoardApi(newestSprintIdByTeam, count, cutoffMs)` — async; replaces issue-derived sprint lists with authoritative Board API data. `discoverBoardIdForTeam(teamName, agileTeamFieldNum, sprintField)` — async; two-pass JQL boardId discovery for single-team analysis. `fetchSprintReportsForTeams(teams, newestSprintIdByTeam)` — async; fetches GreenHopper reports with shared semaphore rate-limiting; used by both the portfolio pipeline and individual sprint resolver.
- All **pure** functions are stateless (no side effects, no I/O) and safe at any concurrency level.

### `transformers/` — Transform
- Pure calculations and data shaping.
- No I/O, no Markdown, no rendering of any kind.
- Functions: `isOverdue(item)`, `getDaysOverdue(item)`, `groupByStatusOrdered(items, workflow)`, `getSpecialCategory(...)`, `buildCountMap(items, getParentKey, checkDone)`, `filterOverdue(items)`, `calculateLeadTime(epics, workflow)`, `calculateExpectedPct(item)`, `getRygStatus(item, actualPct, expectedPct, days, counts)`.
- `getRygStatus` rules: Done → 🔵. Not Started (To Do + no done children + not overdue) → 🔘 / 🔘 🚩⚠️. Otherwise the badge is the **worst of two independent signals** — (1) Overdue signal: 1–14d → 🟢, 15–28d → 🟡, 29+d → 🔴; (2) Completion signal: delta ≤ 20% of expectedPct → 🟢, ≤ 50% → 🟡, > 50% → 🔴. A number suffix (e.g. 30d) is appended when overdue. Overdue backlog items fall through to RYG instead of defaulting to gray.
- All functions are **stateless** — safe at any concurrency level.

### `formatters/` — Load
- Converts transformed domain data into the final output format.
- No I/O, no calculation — only presentation.
- **`markdown-formatter.js`** — Domain data → Markdown (chat output).
  - `EPIC_RYG_LEGEND` — exported blockquote constant; inserted once per report below the Epics heading as a status key.
  - `formatProgress(done, total)`, `formatStatusTable(grouped)`, `formatStoryStatusTable(items, workflow)`, `formatInitiativeTable(items, baseUrl, countMap)`.
  - `formatEpicList(epics, baseUrl, workflow, countMap)` — all teams joined into one string (chat output).
  - `formatEpicsByTeam(epics, baseUrl, workflow, countMap)` — one `{ team, markdown }` object per team (Confluence export / analysis).
  - Both epic formatters include the team epic count in the `### 🏷️ Team _(N epics)_` heading.
  - `dateDeltaCell(baseDate, actualDate, baseLabel, actualLabel)` — internal helper; produces a two-row cell with bold labels (`**Planned**`, `**Expected**`, `**Actual**`) separated by the `↵` sentinel.
  - `formatInnovationVelocityTable(teams, teamStats)`.
  - `formatInnovationVelocityByTeam(allTeams, teamStats, lctReady, velocityOnly)` — combined velocity + per-team bullet blocks. Pass `velocityOnly=true` to emit only the velocity legend, overall summary, and velocity table (no Lead/Cycle Time tables); used in the chat analysis resolver when the LCT section is rendered separately.
  - `formatLCTSection(allTeams, teamStats, lctReady, renderHeading)` — standalone Lead and Cycle Time section. Renders its own legend (Lead Time and Cycle Time definitions) at the top. When `renderHeading=true` (chat/default) emits a `### H3` heading and team sub-headings as `#### H4`; when `renderHeading=false` (Confluence, caller owns `## H2`) emits team sub-headings as `### H3` so Confluence TOC numbering is correct (5.1, 5.2… not 5.0.1, 5.0.2…).
  - `formatSprintSection(allTeams, sprintsByTeam, trendsByTeam?)` — Sprint Analysis H2 block for Confluence export. Renders the velocity table per team followed by three H4 trend sub-sections (Velocity Trend, Scope Management, Predictability Score) when `trendsByTeam[team]` is present. Handles all-failed/partial/empty sprint states.
  - `formatTeamSprintChat(teamName, boardName, boardId, sprints, trendData?)` — Sprint velocity table for chat. Same structure as `formatSprintSection` for a single team. Appends trend sub-sections when `trendData` is non-null; emits a "need 5 sprints" note when data is insufficient.
  - `formatSprintTrendSections(trendData)` — Private helper shared by both sprint formatters. Renders the three H4 sub-sections with description blockquotes and metric tables from a `computeSprintTrends()` result object. Never called directly from resolvers.
- **`confluence-formatter.js`** — Markdown → Confluence Storage Format (XHTML). Pure and stateless.
  - `buildTocMacro(minLevel, maxLevel)` — native Confluence TOC macro prepended to every exported page.
  - `buildAnchorMacro(anchorName)` — named anchor macro (default `"top"`) for `[⬆ Back to top](#top)` links.
  - `markdownToStorage(markdown)` — handles headings, blockquotes (consecutive `> ` lines merged into one `<blockquote>`), unordered lists, `<hr/>`, tables, and inline formatting.
  - `renderTable(headers, bodyRows)` — full-width Confluence table with variable colspan widths. `WIDE_HEADERS = { 'Start', 'Due' }` gives those columns (and always the first/Epic column) `colspan="2"` so they render at 2× the width of other columns. Virtual column count adjusts automatically.
  - `buildCustomTable(headers, bodyRows, colspans)` — explicit per-column colspan control. Use when `renderTable` column widths are wrong (e.g., `[1, 1, 3]` for a narrow step column and a triple-wide description column). Supports the same inline Markdown as `markdownToStorage`.
  - `STATUS_BG` — map of exact Jira status names → **Confluence named highlight colours** (`light-grey`, `light-blue`, `light-green`). Named colours are theme-aware: Confluence Cloud maps them to appropriate shades in both light and dark mode. Hex codes bypass this mapping and always render light, making text invisible in dark mode — do not reintroduce hex codes here.
  - `tdStyle(content)` — returns the `data-highlight-colour="<named-colour>"` attribute for matching status cells. No `style=` fallback — named colour values are not valid CSS so the fallback would be ignored anyway. The `data-highlight-colour` attribute is the correct mechanism on Confluence Cloud.
  - `cellToHtml(content)` — splits on `↵` sentinel and wraps each part in its own `<p>` tag for multi-line cells.
- Only these files change when the output format changes — resolvers are untouched.

### `resolvers/` — Orchestrators
- Receive the Rovo event, call the ETL pipeline, return the structured response.
- Must **not** contain business logic, calculations, or Markdown string building.
- Pattern: `receive → extract → transform → format → return`.
- **`confluence-export-resolver.js`** — accepts `portfolioKeys` (one or comma-separated), resolves destination (folder / parent page / space root), calls `buildReportForKey` per key. Scope-aware: detects Objective / Initiative / Epic via `extractItemScope` and renders only the relevant sections. Reads pre-computed LCT session from Forge Storage (written by `lead-time-resolver`). Each report includes a `_Created at: YYYY-MM-DD HH:MM_` metadata line (timezone: `REPORT_TIMEZONE`) and a `[⬆ Back to top](#top)` link. The page title date is timezone-aware (BRT). Accepts optional `titleSuffix` — **mandatory when 2+ individual reports share the same destination** to prevent page overwrites (agent uses the portfolio key or objective name as suffix). Assembled page is prefixed with anchor + TOC macro, then upserted (Update → Move → Create). Returns `pageUrl`, `counts`, `wasMoved`, `wasUpdated`, `resolvedFolderId`.
- **`prepare-export-resolver.js`** — ETL step 1. Scope-aware: handles Objective (Layer 1–3), Initiative (direct-child epics + stories), and Epic (stories under epic) key types. Accepts `portfolioKeys` (comma-separated) for multi-key runs — saves one independent session per key (`export_session:<accountId>:<key>`). Sessions are combined at query time; no composite session is stored. Persists `phase: 'layers_1_4'` and `detectedScope` field.
- **`lead-time-resolver.js`** — ETL step 2. Reads session written by `prepare-export-resolver`, runs a combined Epic + Story changelog JQL query batched across multiple Forge invocations (returning `PARTIAL` until done). Finalises `lctByTeam`, `velocityByTeam`, `overallVelocity` and updates session to `phase: 'complete'`.
- **`check-cache-resolver.js`** — Probes the session for a given key. Detects scope via `extractItemScope`. Returns `hasCachedData`, `phase`, `detectedScope`, `parentKey`, and `cachedAt` (formatted in `REPORT_TIMEZONE`). Treats sessions written by old code (no `detectedScope` field + empty `allTeams`) as stale.
- **`creator-resolver.js`** — Static data only; no ETL pipeline. Exports `getAgentInfo` which returns the `GUSTIEL_CARD` constant. Called by the single `get-agent-info` action for both "Who are you?" and "Who is your creator?" questions. The card contains two image URL fields: `avatarImageUrl` (Gustiel's avatar shown inline at the top of the identity card) and `builtByImageUrl` (creator photo shown inline on the Built by line). Images are rendered as standard markdown `![alt](url)` — see **Image Rendering** section below.
- **`sprint-data-resolver.js`** — ETL step 3. Reads the session written by `prepare-export-resolver`, calls `fetchSprintReportsForTeams` from `sprint-extractor.js` for all teams, writes `sprintsByTeam` back to the session. Returns `PARTIAL` while teams are being processed across multiple invocations, `SUCCESS` when complete, `NO_SESSION` when the session is missing.
- **`team-sprint-resolver.js`** — Individual on-demand sprint analysis. Calls `discoverBoardIdForTeam` + `getRecentBoardClosedSprints` + `fetchSprintReportsForTeams` (extract), then `computeSprintTrends` (transform), then `formatTeamSprintChat` (load). Returns `{ status, team, board, boardId, sprints, trendData, message }` — `boardId`, `sprints[].name`, and `trendData` allow Rovo to answer derived questions without a separate skill.
- **`skill-docs-resolver.js`** — Exports a comprehensive Confluence page documenting all Gustiel skills, usage examples, access levels, the ETL pipeline, Jira hierarchy support, and session cache. Uses `buildCustomTable` for explicit colspan control in the ETL and hierarchy tables. Same upsert/folder/path logic as `confluence-export-resolver`.
- **`storage-admin-resolver.js`** — Multi-path storage management. Admins: list all keys, read any key, wipe all storage, manage the admin registry. Non-admins: list/read only their own `export_session:<accountId>:*` keys. Uses `makeSessionKey` prefix check as the security boundary. Uses `startsWith` from Forge Storage query API for efficient per-user key filtering.

### `utils/` — Shared Primitives
- **`token-estimator.js`** — `fitWithinBudget(sections, budget)` trims section array to stay within an LLM token budget. Used by the summary phase of the portfolio report resolver.
- **`concurrency.js`** — `makeSemaphore(limit)` creates a counting semaphore for bounded concurrency. Used by `sprint-extractor.js` to limit parallel GreenHopper API calls (default: 3). Never define semaphore primitives inside a resolver — import from here.

### `config/constants.js` — Configuration
- Single source of truth for version, workflow status dicts, field IDs, and the session key format.
- Workflow statuses are **dicts** (not arrays): `{ order, category, specialCategory }`.
- To change a status behaviour: edit the dict here only. No resolver logic to touch.
- `TEAMS_PER_BATCH = 4` — controls how many teams auto-chain per user "next" before a mandatory pause (see Pagination Model below).
- `makeSessionKey(accountId, portfolioKey)` — canonical Forge Storage key builder: `export_session:<accountId>:<portfolioKey>`. All resolvers import this; never define a local version.

---

## Response Reuse Pattern

### Principle

Gustiel resolvers return **rich, structured responses** — more fields than the primary use case strictly requires. This lets Rovo answer a family of related questions from a single action call, without creating separate thin GET resolvers for every possible follow-up.

This is a deliberate design choice. Rovo is an LLM — it can read a structured JSON response and extract exactly what the user asked for, whether that is the full formatted table, just a list of names, or a single ID field.

### Rule

> **Before creating a new resolver or action, ask: does an existing resolver already retrieve this data as part of its normal work?**
> If yes, add the field to that resolver's response and document it in the prompt. Do not create a new action.

### Current examples

| Question | Action called | Field used |
|---|---|---|
| "Show sprint velocity for Titan" | `get-team-sprint-analysis` | `response.message` (pre-formatted table) |
| "List the past sprint names for Titan" | `get-team-sprint-analysis` | `response.sprints[].name` |
| "What board is Titan on?" | `get-team-sprint-analysis` | `response.board`, `response.boardId` |
| "What's the board ID for Warriors?" | `get-team-sprint-analysis` | `response.boardId` |

All four questions use the same action. The resolver fetches and parses the data once; Rovo selects the relevant field for each question type.

### How to implement correctly

1. **Resolver** — return all fields the ETL pipeline already computed, not just those used by `response.message`.
2. **Prompt routing section** — document every response field by name and describe which user questions map to it. Example:
   ```
   response.message         → full sprint table + trend sections (display verbatim)
   response.boardId         → answer "what board is X on?" or "board ID for X?"
   response.sprints[].name  → answer "list sprint names for X"
   response.trendData       → structured analytics; Rovo generates insights on demand
   ```
3. **Skill description in the prompt help list** — mention the derived question types alongside the primary use case so users discover them.
4. **Skill Documentation export** — include the derived capabilities in the trigger phrase list for that skill section.

### Anti-patterns to avoid

- ❌ Creating a `get-board-id` resolver that only calls `discoverBoardIdForTeam` and returns one field — the existing sprint resolver already does this work.
- ❌ Returning only `message` from a resolver when the underlying data has richer structure that users may ask about.
- ❌ Documenting only the primary trigger phrases in the prompt, leaving derived questions unrouted (Rovo will either fail silently or call the wrong action).

---

## Rules for New Features

1. **New data from Jira?** → Add a function to `extractors/jira-extractor.js`.
2. **New calculation or grouping?** → Add a function to the relevant `transformers/` file.
3. **New output section or table?** → Add a function to `formatters/markdown-formatter.js`.
4. **New Rovo action?** → Add a resolver that calls the three layers above. No logic inside.
5. **New workflow status?** → Edit `config/constants.js` only. Zero other changes needed.
6. **Never duplicate logic** — if a second resolver needs the same extraction, transformation, or formatting, it imports from the existing layer file.
7. **Sprint extraction belongs in `sprint-extractor.js`** — never inline board discovery, sprint list fetching, or GreenHopper report loops in a resolver. Both the portfolio pipeline and individual sprint resolver call the same shared functions.
8. **Concurrency primitives belong in `utils/concurrency.js`** — never define `makeSemaphore` or a sequential delay loop inside a resolver.
9. **Confluence tables with unequal columns** → use `buildCustomTable(headers, rows, colspans)` instead of a markdown pipe table. The `colspans` array gives explicit width ratios per column.

---

## Data Flow (Portfolio Report)

```
Rovo Event  (teamPage param drives phase)
    │
    ▼
portfolio-report-resolver.js   ← entry/exit only
    │
    ├─ EXTRACT — Layer 1 (Objective + Initiatives) ──────────
    │   searchJira()              ← services/jira-api-service.js
    │   extractItem()             ← extractors/jira-extractor.js
    │
    ├─ EXTRACT — Layer 2 (Epics, optional QP filter) ────────
    │   searchJira()              ← services/jira-api-service.js
    │   extractItem()             ← extractors/jira-extractor.js
    │
    ├─ EXTRACT — Layer 3 (Story counts, chunked 50) ─────────
    │   searchJira()              ← services/jira-api-service.js
    │   extractStoryStatus()      ← extractors/jira-extractor.js
    │   chunk()                   ← extractors/jira-extractor.js
    │
    ├─ EXTRACT — Layer 4 (Epic changelogs → lead time) ──────
    │   searchJira(..., ['changelog']) ← services/jira-api-service.js
    │   extractEpicForLeadTime()  ← extractors/jira-extractor.js
    │
    ├─ TRANSFORM ────────────────────────────────────────────
    │   buildCountMap()           ← transformers/portfolio-transformer.js
    │   groupByStatusOrdered()    ← transformers/portfolio-transformer.js
    │   filterOverdue()           ← transformers/portfolio-transformer.js
    │   calculateLeadTime()       ← transformers/portfolio-transformer.js
    │   computeSprintTrends()     ← transformers/portfolio-transformer.js
    │
    ├─ LOAD ─────────────────────────────────────────────────
    │   formatProgress()              ← formatters/markdown-formatter.js
    │   formatStatusTable()           ← formatters/markdown-formatter.js
    │   formatStoryStatusTable()      ← formatters/markdown-formatter.js
    │   formatInitiativeTable()       ← formatters/markdown-formatter.js
    │   formatEpicsByTeam()           ← formatters/markdown-formatter.js
    │   formatInnovationVelocityTable()← formatters/markdown-formatter.js
    │
    ▼
Structured response { status, summary, pagination, team_* fields, ... }
```

---

## Pagination Model (Two-Phase Design)

Rovo's LLM output token limit (~4K per turn) prevents returning all team data in one response. The resolver solves this with a two-phase, server-controlled pagination model.

### Phase 1 — Summary (`teamPage = 0`)
Returns the portfolio summary, initiative table, and counts. No team fields. Gives the LLM a "breathing room" turn before the heavier team breakdown begins.

### Phase 2 — Team pages (`teamPage ≥ 1`)
Returns **exactly one team** per call. The server decides what the LLM must do next via a single `pagination.nextAction` field — no boolean logic required from the LLM.

| `nextAction` | Condition | LLM behaviour |
|---|---|---|
| `"AUTO_CONTINUE"` | Within a batch of 4 (`teamPage % 4 ≠ 0`) | Call again immediately — no text between table and call |
| `"PAUSE"` | Batch boundary (`teamPage % 4 === 0`) and more teams remain | Post the batch-pause message, wait for user "next" |
| `"COMPLETE"` | No more teams | Post the completion message |

**Why batch at 4?** Each team table costs ~300–500 LLM output tokens. Four teams ≈ 2,000 tokens — safely under the ~4K ceiling. Batching at the server prevents the LLM from chaining indefinitely and hitting a silent mid-report truncation.

**Key pagination fields returned:**

| Field | Purpose |
|---|---|
| `nextAction` | The only field the LLM reads to decide its next move |
| `nextTeamPage` | The exact integer to pass as `teamPage` in the next call |
| `teamNumber` | Display only — which team was just returned. **Never used as a call parameter** |
| `batchStartTeam` | First team number of the current batch — for the pause message |
| `totalTeams` | Total teams in this objective — for progress display |

---

## Layered Crawl (Forge 25-second limit)

The portfolio analysis fetches in three sequential layers to avoid large parallel fan-outs:

| Layer | What | JQL strategy | Scope |
|---|---|---|---|
| 1 | Portfolio root + direct children | `key = X OR parent = X` | Objective / Initiative / Epic |
| 2 | Epics (optional QP filter) | `parent in (initiativeKeys...)` | Objective only |
| 3 | Story counts | `parent in (epicKeys...)` chunked in groups of 50 | All scopes |
| 4 (async) | Epic + Story changelogs for LCT | `hierarchyLevel in (0,1) AND agileTeam in (...)` | All scopes |

Layer 3 uses `chunk()` to keep JQL `IN` clauses within character limits.
Layer 4 runs in a separate Forge invocation chain (`lead-time-resolver`) to avoid the 25-second execution limit.

---

## Image Rendering in Rovo Chat

Rovo's content security policy (CSP) aggressively blocks most external image embeds. The following table summarises what works and what doesn't:

| Method | Result | Notes |
|---|---|---|
| `![alt](external-url)` in prompt template | ✅ Works (inconsistent) | Rovo renders imgur URLs inline when the LLM outputs them as conversational text via the prompt template |
| `![alt](url)` returned from action data | ❌ Blocked | Rovo converts to a hyperlink or "Preview unavailable" |
| Raw URL from action data | ❌ Blocked | Rovo auto-titles it as a link |
| `manifest.yml` `icon` field | ✅ Guaranteed | Shown as the agent's avatar bubble on every message |

### How Gustiel handles images

**Agent avatar (`avatarImageUrl`)** — rendered inline at the top of the identity card:
```
![Gustiel]({agent.avatarImageUrl})
```

**Creator photo (`builtByImageUrl`)** — rendered inline on the Built by line:
```
**Built by:** {agent.builtBy} · {agent.builtByEmail} · ![Gustiel]({agent.builtByImageUrl})
```

Both URLs live in `GUSTIEL_CARD` inside `src/resolvers/creator-resolver.js`. The prompt template in `prompts/main_prompt.md` instructs the LLM to output them using `![alt](url)` markdown syntax, which Rovo renders inline.

**Manifest icon** — the agent's avatar in the Rovo UI is set via `manifest.yml`:
```yaml
modules:
  rovo:agent:
    - key: portfolio-analyst-agent
      icon: resource:agent-assets;icons/avatar.png
```
The image file is bundled at `assets/icons/avatar.png` and declared under `resources` as `agent-assets`. This is the only image Rovo is guaranteed to always display.

### Rule: image URLs belong in `creator-resolver.js`
Never hardcode image URLs directly in the prompt. Keep them in `GUSTIEL_CARD` so they can be updated in one place. The prompt references them via `{agent.avatarImageUrl}` and `{agent.builtByImageUrl}`.

---

## Batched Accumulator Pattern

This is the core engineering innovation that makes Gustiel possible on Forge. Understanding it is essential for any feature that touches large datasets.

### The Problem: Forge's 25-Second Execution Limit

Every Forge function invocation must complete within **25 seconds**. For a portfolio with 20+ teams and 1,000+ stories, querying Jira changelogs sequentially within a single invocation is impossible — each GreenHopper report fetch takes ~1–3 seconds, and changelog JQL with expansions for 400+ epics and stories takes 5–15 seconds alone.

Forge has no built-in "continue this function later" mechanism. Each invocation is completely independent.

### The Solution: Session-Based Resumable Processing

The Batched Accumulator Pattern breaks the work across **multiple sequential Forge invocations**, using Forge Storage as the shared state between them.

```
Invocation 1: process items 0–N, save progress to Storage, return PARTIAL
Invocation 2: read progress, process items N+1–M, save progress, return PARTIAL
...
Invocation K: process final items, save completed result, return SUCCESS
```

Each invocation:
1. Reads the current accumulator and `startIndex` from Forge Storage
2. Processes a fixed-size batch (e.g. 6 teams per invocation)
3. Merges results into the accumulator
4. Writes the updated accumulator + new `startIndex` back to Storage
5. Returns `{ status: "PARTIAL" }` if more work remains, `{ status: "SUCCESS" }` when done

Rovo's prompt loop drives the continuation: on `PARTIAL`, the prompt instructs Rovo to call the same resolver again immediately (no user input needed). The loop continues until `SUCCESS`.

### Session State Machine

```
[NOT PRESENT]
     │ prepare-portfolio-export called (Step 1)
     ▼
[phase: "layers_1_4"]   ← extraction done; LCT pending
     │ calculate-lead-time-data loops until done (Step 2)
     ▼
[phase: "complete"]     ← LCT data present; sprint data pending
     │ calculate-sprint-data loops until done (Step 3)
     ▼
[phase: "complete"]     ← session has allTeams + lctByTeam + sprintsByTeam
     │ export-to-confluence (Step 4) reads session, builds page
     ▼
[Confluence page created / updated]
```

### Batch Sizes (configured in `constants.js`)

| Resolver | Batch constant | Default | What one batch processes |
|---|---|---|---|
| `lead-time-resolver.js` | `ANALYSIS_LCT_BATCH_SIZE` | 100 issues | Issues per changelog JQL call |
| `sprint-data-resolver.js` | `ANALYSIS_SPRINT_TEAMS_PER_BATCH` | 6 teams | Teams per GreenHopper fetch invocation |

### Idempotency

Resolvers check for existing session data before starting work:
- If a complete session already exists **and** the user did not say "fresh", "redo", or "overwrite" → return the cached result immediately without any Jira API calls.
- If the session is in `PARTIAL` state (interrupted mid-batch) → resume from `startIndex`.
- If no session exists → start fresh from the beginning.

This makes retries safe and avoids redundant API calls after turn-limit pauses.

### Turn-Limit Pause Protocol

Rovo has a per-turn tool-call budget. When processing 5+ portfolio keys, extraction and LCT may exhaust this budget mid-way through. The prompt handles this with an explicit pause protocol:

- On each ETL phase (extract, LCT, sprint), if the budget is exhausted before all keys finish, Rovo posts a pause message listing the remaining pending keys and asks the user to reply "continue".
- On resume, Rovo picks up from the first incomplete key and continues without re-running completed keys (session idempotency prevents double-work).
- A mandatory pre-export guard in Step E verifies all three ETL phases are complete for every key before calling `export-to-confluence`. If any step is missing, Rovo goes back and runs it.

---

## Confluence Export — The Full Pipeline

This section documents what `confluence-export-resolver.js` does end-to-end, from receiving a Rovo action call to delivering a Confluence page URL.

### Page Assembly Order

Every exported page is assembled in this exact order before the API write:

```
1. Anchor macro          [ac:structured-macro name="anchor"] (anchorName="top")
2. TOC macro             [ac:structured-macro name="toc"]    (H1–H3, style=none)
3. Report body           markdownToStorage(markdown)
```

The anchor macro at position 1 is what the `[⬆ Back to top](#top)` links throughout the report jump to. It is always the first element so links work regardless of section depth. The TOC macro at position 2 auto-scans all headings on the rendered page and produces clickable anchor links — no manual maintenance required.

### markdownToStorage — The Conversion Pipeline

`markdownToStorage(markdown)` in `confluence-formatter.js` converts the Markdown produced by `markdown-formatter.js` into Confluence storage format (XHTML). It processes the string line-by-line and handles:

| Markdown construct | Confluence output |
|---|---|
| `# H1` | `<h1>` |
| `## H2` | `<h2>N. Title</h2>` (auto-numbered) + auto-inject back-to-top before every H2 except the first |
| `### H3` | `<h3>N.M. Title</h3>` (auto-numbered within H2) |
| `#### H4` | `<h4>N.M.P. Title</h4>` |
| `---` | `<hr/>` |
| `> blockquote` | `<blockquote>` (consecutive `> ` lines merged into one block) |
| `- item` / `* item` | `<ul><li>…</li></ul>` (consecutive items merged into one list; no inner `<p>` to preserve bullet styling) |
| `\| table \|` | `renderTable(headers, bodyRows)` — full Confluence XHTML table |
| `[⬆ Back to top](#top)` | Right-aligned `<p style="text-align:right;"><a href="#top">` |
| `![alt](ATTACH:filename.png)` | `<ac:image ac:align="center"><ri:attachment ri:filename="…"/></ac:image>` — centered Confluence attachment image (file must be uploaded first) |
| `**bold**` | `<strong>` |
| `[link](url)` | `<a href="…">` |
| `_italic_` | `<em>` |
| `` `code` `` | `<code>` |
| Plain text | `<p>` |

### Table Rendering (`renderTable`)

All Markdown pipe tables are rendered via `renderTable(headers, bodyRows)` which produces a full-width Confluence XHTML table with auto-calculated `colspan` widths:

- **Virtual column strategy**: a `<colgroup>` with `(n + wideCount)` equal-width phantom columns is written. Each wide column spans 2 virtual columns (rendered at ~2× width); other columns span 1.
- **First column** is always wide — it holds the issue key / name and needs extra space.
- **`WIDE_HEADERS`** (`Start`, `Due`) are also given `colspan="2"` — these cells contain multi-line date content (planned + actual date on separate `<p>` rows via the `↵` sentinel).
- **Status cell colouring**: `tdStyle(content)` checks if a cell exactly matches a status name in `STATUS_BG`. If yes, it adds `data-highlight-colour="<named-colour>"`. Named Confluence colours (`light-grey`, `light-blue`, `light-green`) adapt to the user's theme (light / dark mode). Hex codes do not — avoid them.
- **`buildCustomTable`**: when `renderTable`'s auto-colspan is not right (e.g. a 1-col label beside a 3-col description), use `buildCustomTable(headers, rows, colspans)` with explicit per-column width ratios. Used by `skill-docs-resolver.js` for the ETL and hierarchy tables.

### Scope-Aware Section Rendering

The same export resolver handles three key types without separate resolvers:

| Scope | Detected by | Sections rendered |
|---|---|---|
| **Objective** | `issuetype.name === "Objective"` | All 9 sections (full report) |
| **Initiative** | `issuetype.name === "Initiative"` | Epic summary, Epics by Team, Innovation Velocity, LCT, Sprint Analysis |
| **Epic** | `issuetype.hierarchyLevel === 1` | Story status table, Innovation Velocity (1 team), LCT, Sprint Analysis |

Scope is detected by calling `extractItemScope(issue)` on the key itself (a 1-item JQL fetch at the start of `buildReportForKey`). The result gates which code path runs.

### Multi-Key Modes

When the user provides multiple portfolio keys, the export resolver supports three modes:

| Mode | `portfolioKeys` value | `mode` param | Calls | Result |
|---|---|---|---|---|
| **Isolated** | `"WX-1145,WX-1770,…"` (all keys) | `"isolated"` | 1 total | One page; each key in its own `# KEY — Title` section with `---` dividers |
| **Merged** | `"WX-1145,WX-1770,…"` (all keys) | `"merged"` | 1 total | One page; all keys' data pooled (teams merged, tables combined) |
| **Individual** | `"WX-1145"` (one key at a time) | *(omit)* | 1 per key | Separate page per key |

Both Isolated and Merged are **single-call, single-page** operations — the resolver builds the entire multi-key page internally. Never loop over keys and call export multiple times for these modes.

### Upsert Logic (Find → Update → Move → Create)

Every export call attempts to upsert (not blindly create) to avoid duplicate pages:

1. **Find by title** — search the target space for a page with the exact title.
2. **Update in place** — if found in the right location, update its body.
3. **Move + update** — if found at a different location (user changed the folder), move it then update.
4. **Create** — if not found anywhere, create a new page at the target location.

Destination is resolved in this priority order:
- `folderId` (explicit Confluence page/folder ID or URL)
- `parentPath` (slash-separated page title path, e.g. `"Portfolio Reports/WX"`)
- Space root (if neither is provided)

The page title always includes the current date in `REPORT_TIMEZONE` (BRT) for traceability. An optional `titleSuffix` field prevents page overwrites when multiple individual keys share the same destination folder.

### Attachment Upload (Two-Step Flow)

When a page body contains `![alt](ATTACH:filename.png)` references, the attachment must be uploaded **before** Confluence can resolve it. `skill-docs-resolver.js` implements this as a mandatory two-step flow:

1. **Upsert the page** — create or update with the full body (including `<ac:image>` tags that still say "Preview unavailable" at this point).
2. **Upload each attachment** — call `uploadAttachment(pageId, filename, base64Data)` for every screenshot in `SCREENSHOTS`. On success, Confluence stores the binary file against the page ID.
3. **Re-PUT the page body** — a second `updateConfluencePage` call with the identical body forces Confluence to re-resolve all `<ri:attachment>` references now that the files exist. Without this step the images remain "Preview unavailable" even after upload.

#### `uploadAttachment` — Implementation Notes

| Decision | Value | Why |
|---|---|---|
| **API version** | v1 (`/wiki/rest/api/content/{id}/child/attachment`) | v2 has no `POST /pages/{id}/attachments` endpoint |
| **Auth context** | `asApp()` | `asUser()` returns "Authentication Required" in Forge backend resolvers; v1 rejects OAuth Bearer tokens |
| **Scope** | `write:confluence-file` (classic) | The only Atlassian scope that authorises attachment uploads; `write:confluence-content` (page content) and `write:attachment:confluence` (granular, v2-only) both fail with "scope does not match" |
| **CSRF bypass** | `X-Atlassian-Token: nocheck` | Required for all v1 multipart `POST` requests; without it Confluence returns 403 |
| **Body** | Native `FormData` with `Blob` | `atob(base64Data)` → `Uint8Array` → `Blob` → `formData.append('file', blob, filename)` |
| **Image alignment** | `ac:align="center"` on `<ac:image>` | Standard Confluence storage attribute for centered image rendering |

> **Scope pitfall**: `write:confluence-file` is a distinct scope from `write:confluence-content`. The former grants file/attachment upload rights; the latter grants page content write rights. They are not interchangeable and both must be declared in `manifest.yml` if both operations are needed.

### Report Metadata

Each page includes:
- `_Created at: YYYY-MM-DD HH:MM_` — rendered as italic text at the top of the body, in `REPORT_TIMEZONE`
- `[⬆ Back to top](#top)` — right-aligned link after the last section (and auto-injected before every H2 by `markdownToStorage`)
- `data-layout="full-width"` on every table — ensures tables use the full page width, not the default content column width

---

## Storage Architecture

### Storage Backend

Gustiel uses **`@forge/api` storage** — Atlassian's legacy Forge KV (Key-Value) module. It stores data as plain JSON objects keyed by string. There are no tables, no queries by field value, and no native TTL.

> ⚠️ **Do not attempt to pass a third `{ ttl: ... }` argument to `storage.set()`.**
> The legacy `@forge/api` storage module does not support TTL options — passing a third argument silently fails the write, breaking the entire session. TTL is only available in `@forge/kvs` (the newer module). A migration to `@forge/kvs` would unlock native per-key expiry.

### Key Format

All session keys follow the canonical format defined in `makeSessionKey()` (`src/config/constants.js`):

```
export_session:<accountId>:<portfolioKey>
```

Example: `export_session:557058:abc123ef-xxxx:WX-1770`

Every resolver that reads or writes sessions **must** call `makeSessionKey()` — never construct the key string manually. This ensures the security boundary (prefix-based access control) is consistently enforced.

### Session Lifecycle

| Phase | Trigger | Key state |
|---|---|---|
| **Created** | `prepare-portfolio-export` completes Step 1 | `{ phase: "layers_1_4", allTeams, allEpics, allStories, timestamp }` |
| **LCT added** | `calculate-lead-time-data` completes Step 2 | `{ phase: "complete", lctByTeam, velocityByTeam, overallVelocity, ... }` |
| **Sprint added** | `calculate-sprint-data` completes Step 3 | `{ phase: "complete", sprintsByTeam, ... }` |
| **Read** | `export-to-confluence` / `analyze-portfolio-chat` | Data is read; key is not modified |
| **Deleted** | User calls `wipe-user-storage` or admin calls `wipe-global-storage` | Key removed from storage |
| **Expired** | App uninstalled | Atlassian retains data for 60 days, then deletes |

### Data Lifetime

Without explicit deletion, sessions persist indefinitely. There is no automatic cleanup. Two approaches exist for manual cleanup:
1. **`wipe-user-storage`** — each user can delete their own sessions (all keys matching their `accountId` prefix)
2. **`wipe-global-storage`** — admin wipes all sessions for all users

The `timestamp` field on every session enables a future scheduled-trigger cleanup (weekly scan, delete entries older than N days) if needed.

### Storage Capacity

Forge Storage has a per-item size limit (approx. 500 KB per key). Large portfolios with many epics and stories can approach this. If a session is ever rejected, reduce the data stored per key (e.g. store only team-aggregated stats instead of raw issue arrays).

---

## Admin System

### Two-Tier Access Model

Gustiel uses a two-tier model: a **static super-admin** (hardcoded in `src/config/constants.js` → `SUPER_ADMIN_ACCOUNT_ID`) and a **dynamic admin registry** (a dedicated Forge Storage key). Both tiers have full admin access. Only the super-admin can add other admins.

```
SUPER_ADMIN_ACCOUNT_ID (constants.js)   ← permanent, cannot be removed
Admin registry (Forge Storage)          ← dynamic, managed at runtime via Rovo
```

### Security Boundary

Every action in `storage-admin-resolver.js` runs an admin check at the top before any other work. Non-admin requests are rejected with an explicit error message. The security boundary for non-admins is enforced via prefix filtering:

```js
// Non-admin: can only see keys that start with their own accountId
startsWith(`export_session:${accountId}:`)
```

An admin bypasses this filter and can read or delete any key in storage.

### Admin Actions

| Action | Who | What it does |
|---|---|---|
| `inspect-storage` (no key) | Admin | Lists all keys across all users |
| `inspect-storage` (with key) | Admin | Reads any key verbatim (displayed as human-readable summary, never raw JSON) |
| `wipe-global-storage` | Admin | Deletes ALL session data for ALL users (requires `confirm = "YES"`) |
| `list-admins` | Admin | Lists super-admin + all dynamic admins (name + email) |
| `add-admin` | Super-admin only | Grants admin access to a user by `accountId` |
| `remove-admin` | Admin | Removes a dynamic admin (cannot remove super-admin) |
| `clear-admin-registry` | Admin | Resets dynamic admin list to empty (super-admin unaffected) |

### Non-Admin (Self-Service) Actions

| Action | Who | What it does |
|---|---|---|
| `inspect-storage` (no key) | User | Lists only their own `export_session:<accountId>:*` keys |
| `inspect-storage` (with key) | User | Reads their own key if it starts with their prefix |
| `wipe-user-storage` | User | Deletes all their own sessions (requires `confirm = "YES"`) |

### Admin Registry Storage

The admin registry is stored as a single Forge Storage key (separate from portfolio sessions). Its format is a plain JSON object: `{ admins: [{ accountId, displayName, email }, ...] }`. It is never included in the `wipe-global-storage` operation — only portfolio session keys are wiped.
