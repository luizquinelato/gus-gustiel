# Sprint ETL Refactor — Deep Architecture Assessment

> **Version assessed:** 4.46.0 → **Implemented in 4.47.x**
> **Status:** ✅ Complete — all critical and major items from the plan have been implemented.
> **Problem that triggered this:** Portfolio Confluence export showed _"Sprint data not available. Run `calculate-sprint-data`…"_ even after the step had been run. Individual team sprint analysis worked correctly (different boardId discovery path).

---

## 1. Executive Summary

The sprint extraction pipeline is **not a pipeline** — it is three independent codepaths doing the same job with different implementations, different rate-limiting strategies, and no shared functions. Every bug fix applied to one path must be remembered and manually re-applied to the others. The current failure (portfolio sprint section blank) is a direct consequence: we fixed the individual resolver but the portfolio resolver has a different code branch that was not updated.

**The user's diagnosis is correct:** portfolio is the master data source and individual analysis is a subset of it. Every sprint-related operation should be a single function called by both. The plan below describes exactly what to extract, where to put it, and what each resolver becomes after the refactor.

---

## 2. Current Architecture — What Actually Exists

### 2.1 Sprint data flows today (three separate islands)

```
Individual Sprint Analysis (Skill 7)
─────────────────────────────────────
team-sprint-resolver.js
  │
  ├─ [EXTRACT] 2 JQL queries to find boardId from issues
  │    searchJira("agileTeam = X AND sprint in closedSprints()")
  │    searchJira("agileTeam = X AND sprint in openSprints()")
  │
  ├─ [EXTRACT] getRecentBoardClosedSprints(boardId, 6)  ← Board API
  │
  ├─ [EXTRACT] sequential loop + 300ms delay  ← rate-limit strategy A
  │    getGreenHopperSprintReport(boardId, sprintId) per sprint
  │
  └─ [FORMAT]  formatTeamSprintChat()  ← markdown-formatter.js ✅ shared


Portfolio Step 1 — prepare-export-resolver.js
─────────────────────────────────────────────
  │
  ├─ [EXTRACT] extractNewestSprintIdByTeam()  ← PRIVATE FUNCTION IN RESOLVER ❌
  │    Reads boardId from story issue sprint fields
  │    Builds recentClosedSprints from issue sprint fields (incomplete — root cause)
  │
  └─ [EXTRACT] enrichSprintListsFromBoardApi()  ← PRIVATE FUNCTION IN RESOLVER ❌
       Replaces issue-field sprints with Board API sprints per team
       getRecentBoardClosedSprints(boardId, 6) in parallel


Portfolio Step 3 — sprint-data-resolver.js
──────────────────────────────────────────
  │
  ├─ [UTILITY] makeSemaphore(3)  ← DEFINED INLINE IN RESOLVER ❌
  │
  ├─ [EXTRACT] getBoardById(boardId) per team  ← Board API
  │
  ├─ [EXTRACT] getGreenHopperSprintReport() via semaphore  ← rate-limit strategy B
  │    Different from strategy A (semaphore vs sequential delay)
  │
  └─ [TRANSFORM] parseGreenHopperSprintReport()  ← transformer ✅ shared
```

### 2.2 File inventory — where sprint logic lives today

| File | Sprint Responsibility | Correct Layer? |
|---|---|---|
| `services/jira-api-service.js` | `getGreenHopperSprintReport`, `getBoardById`, `getRecentBoardClosedSprints` | ✅ Correct |
| `transformers/portfolio-transformer.js` | `parseGreenHopperSprintReport`, `computeSprintMetrics` | ✅ Correct |
| `formatters/markdown-formatter.js` | `formatSprintSection`, `formatTeamSprintChat` | ✅ Correct |
| `resolvers/prepare-export-resolver.js` | `extractNewestSprintIdByTeam`, `enrichSprintListsFromBoardApi` | ❌ Wrong layer |
| `resolvers/sprint-data-resolver.js` | `makeSemaphore` + full GreenHopper fetch loop | ❌ Wrong layer |
| `resolvers/team-sprint-resolver.js` | JQL boardId discovery + sequential GH fetch | ❌ Wrong layer, duplicated |

### 2.3 Shared constants duplicated across resolvers

The `sessionKey` helper is copy-pasted into four resolvers:

```js
const sessionKey = (accountId, portfolioKey) =>
    `export_session:${accountId}:${portfolioKey}`;
```

Found in: `prepare-export-resolver.js`, `lead-time-resolver.js`,
`sprint-data-resolver.js`, `confluence-export-resolver.js`.

---

## 3. Identified Problems

### P1 — Sprint extraction is not shared (critical)
The board-discovery + GreenHopper fetch operations exist in **three separate files** with **no shared function**. A fix in one place does not propagate. This is what caused today's failure.

### P2 — Two rate-limiting strategies for the same API (critical)
- Individual path: sequential with 300 ms fixed delay.
- Portfolio path: semaphore with max-3 concurrency.
These strategies have different behaviour under load. A 429 on one path may not reproduce on the other, making bugs hard to diagnose. There should be one strategy, defined in one place.

### P3 — `extractNewestSprintIdByTeam` is business logic in a resolver (major)
This is a pure mapping function (issues → domain object). It belongs in `extractors/jira-extractor.js`. Its placement in `prepare-export-resolver.js` violates the architecture rule: _"the resolver is only the entry/exit door — it never contains business logic."_

### P4 — `enrichSprintListsFromBoardApi` is I/O orchestration in a resolver (major)
This function coordinates service calls (Board API) and mutates an in-memory structure. It is an **extraction pipeline step**, not resolver logic. It belongs in an extractor module that is allowed to be async and call services.

### P5 — `makeSemaphore` is a generic utility buried in a resolver (moderate)
Semaphore is a concurrency primitive. It belongs in `src/utils/` (alongside the existing `token-estimator.js`), not inline in `sprint-data-resolver.js`. As soon as a second resolver needs bounded concurrency, it would duplicate this.

### P6 — `sessionKey` defined in four resolvers (moderate)
A shared storage-key format should be defined once in `config/constants.js` or a dedicated `utils/session.js` and imported everywhere.

### P7 — `getEnvFromJira()` called in every resolver independently (minor)
Each step of the ETL pipeline (prepare, lead-time, sprint-data, export) calls `getEnvFromJira()` at startup. That is 4 separate HTTP calls per full pipeline run. The result is stable for the lifetime of the app. It cannot be memoized across invocations in Forge's stateless model, but documenting this as a known cost is important. Future optimization: cache env in Forge Storage with a 1-hour TTL.

### P8 — Individual sprint resolver diverges from portfolio pipeline (critical)
`team-sprint-resolver.js` uses JQL to discover boardId (two queries), then `getRecentBoardClosedSprints`. The portfolio path uses issue sprint fields to discover boardId, then also `getRecentBoardClosedSprints`. These are different discovery methods — and one might work while the other doesn't. The rule should be: one discovery strategy, used by both.

---

## 4. Root Cause of "Sprint Not Available" in Portfolio

The portfolio Confluence export reads `sprintsByTeam` from the Forge Storage session. This field is written by `sprint-data-resolver.js` (Step 3). The blank section means one of:

**A.** `calculate-sprint-data` was never called after the latest `prepare-portfolio-export`.  
**B.** `calculate-sprint-data` was called but wrote nothing (zero teams had sprint lists).  
**C.** `sprintsByTeam` was written with data but the export resolver read a stale session.  

The most likely cause based on the code: after the last deploy that fixed `enrichSprintListsFromBoardApi` in Step 1, the **existing cached session still had empty `recentClosedSprints`**. The prompt's Step E-cache flow then offers to "use cached data (fast)" and the user does so — meaning Step 3 is never re-run against the new code. The fix is simple: wipe the session and run all three steps fresh. But the deeper fix is to make Step 3 bulletproof by sharing the same board discovery code as Step 1 and the individual resolver.

---

## 5. Proposed Solution — Shared Sprint ETL Layer

### 5.1 New files

#### `src/extractors/sprint-extractor.js` (new)
Single source of truth for all sprint extraction operations. **Async** (calls services). Exports:

```js
// ── Pure extraction (no I/O) ──────────────────────────────────────────────────

/**
 * Given raw Jira story issues, extract boardId + sprint metadata per team.
 * Replaces the private extractNewestSprintIdByTeam() in prepare-export-resolver.
 * Pure function — no I/O.
 */
export function extractNewestSprintIdByTeam(rawIssues, sprintField, epicKeyToTeam)
// Returns: { [teamName]: { id, name, boardId, endDate, startDate, recentClosedSprints[] } }

// ── Async extraction (calls services) ────────────────────────────────────────

/**
 * Given a newestSprintIdByTeam map (boardId already populated), replace
 * issue-field-derived recentClosedSprints with authoritative Board API data.
 * Replaces the private enrichSprintListsFromBoardApi() in prepare-export-resolver.
 * Mutates in-place. Runs parallel (Board API — no 429 risk at this scale).
 */
export async function enrichTeamSprintListsFromBoardApi(newestSprintIdByTeam, count = 6, cutoffMs?)

/**
 * Discover boardId for a single team via JQL when no issue sprint fields are available.
 * Used by the individual sprint resolver when there is no existing session.
 * Replaces the inline JQL discovery block in team-sprint-resolver.
 */
export async function discoverBoardIdForTeam(teamName, agileTeamFieldNum, sprintField)
// Returns: { boardId: string|null, latestSprintId: string|null }

/**
 * Fetch GreenHopper sprint reports for all teams in the newestSprintIdByTeam map.
 * Applies a shared semaphore (default limit = 3) across all concurrent calls.
 * Replaces the inline fetch loop in sprint-data-resolver and team-sprint-resolver.
 */
export async function fetchSprintReportsForTeams(teamsWithSprints, newestSprintIdByTeam, semaphoreLimit = 3)
// Returns: { [team]: { boardId, boardName, sprints[] } }
```

#### `src/utils/concurrency.js` (new)
Generic concurrency primitives, extracted from resolver files:

```js
/**
 * Creates a semaphore that limits concurrent async operations to `limit`.
 * Extracted from sprint-data-resolver.js.
 */
export function makeSemaphore(limit)

/**
 * Runs asyncFn for each item in sequence, with an optional delay between calls.
 * Extracted from team-sprint-resolver.js (the 300ms sequential loop).
 */
export async function sequential(items, asyncFn, delayMs = 0)
```

### 5.2 Modified files

#### `config/constants.js`
Add the shared session key builder:
```js
export const makeSessionKey = (accountId, portfolioKey) =>
    `export_session:${accountId}:${portfolioKey}`;
```

#### `extractors/jira-extractor.js`
Move `extractNewestSprintIdByTeam` here from `prepare-export-resolver.js`.
(Pure function — no I/O. Belongs in extractors per the architecture rules.)

#### `resolvers/prepare-export-resolver.js` → becomes thin
- Remove `extractNewestSprintIdByTeam` (moved to extractor)
- Remove `enrichSprintListsFromBoardApi` (moved to sprint-extractor)
- Import both from new locations
- Import `makeSessionKey` from constants (remove the local definition)

#### `resolvers/sprint-data-resolver.js` → becomes thin
- Remove `makeSemaphore` (moved to utils/concurrency)
- Remove the inline GreenHopper fetch loop (replaced by `fetchSprintReportsForTeams`)
- Import from sprint-extractor + concurrency utils
- Import `makeSessionKey` from constants

#### `resolvers/team-sprint-resolver.js` → becomes thin
- Remove the JQL-based board discovery block (replaced by `discoverBoardIdForTeam`)
- Remove the sequential fetch loop (replaced by `fetchSprintReportsForTeams`)
- Import from sprint-extractor

---

## 6. Target Architecture

```
Sprint ETL — unified data flow after refactor
═══════════════════════════════════════════════

SERVICE LAYER (jira-api-service.js — unchanged)
  getRecentBoardClosedSprints(boardId, n)
  getGreenHopperSprintReport(boardId, sprintId)
  getBoardById(boardId)
  searchJira(jql, fields)

EXTRACT LAYER — sprint-extractor.js (NEW)
  extractNewestSprintIdByTeam()          ← pure, moved from prepare-export-resolver
  enrichTeamSprintListsFromBoardApi()    ← async, moved from prepare-export-resolver
  discoverBoardIdForTeam()               ← async, moved from team-sprint-resolver
  fetchSprintReportsForTeams()           ← async, consolidated from both resolvers

UTILITY — concurrency.js (NEW)
  makeSemaphore()                        ← moved from sprint-data-resolver
  sequential()                           ← moved from team-sprint-resolver

TRANSFORM LAYER (portfolio-transformer.js — unchanged)
  parseGreenHopperSprintReport()         ← already shared ✅
  computeSprintMetrics()                 ← already shared ✅

FORMAT LAYER (markdown-formatter.js — unchanged)
  formatSprintSection()                  ← already shared ✅
  formatTeamSprintChat()                 ← already shared ✅

RESOLVERS — thin orchestrators after refactor
  team-sprint-resolver.js               ← calls discoverBoardIdForTeam + fetchSprintReportsForTeams
  prepare-export-resolver.js            ← calls extractNewestSprintIdByTeam + enrichTeamSprintListsFromBoardApi
  sprint-data-resolver.js               ← calls fetchSprintReportsForTeams only
  confluence-export-resolver.js         ← unchanged (reads session, calls formatSprintSection)
```

---

## 7. Migration Plan — Implementation Status

### ✅ Step 0 — Fix the immediate failure
Stale cache confirmed as root cause. Session wiped; all three steps re-run fresh. Sprint section populated correctly. Code was already correct in 4.46.0.

### ✅ Step 1 — `src/utils/concurrency.js` created
`makeSemaphore` extracted from `sprint-data-resolver.js`. `sequential` utility added. All GreenHopper callers now use the shared semaphore.

### ✅ Step 2 — `src/extractors/sprint-extractor.js` created (pure functions)
`extractNewestSprintIdByTeam` moved from `prepare-export-resolver.js`. All callers updated.

### ✅ Step 3 — Async extraction added to `sprint-extractor.js`
`enrichTeamSprintListsFromBoardApi` and `discoverBoardIdForTeam` moved from their respective resolvers. Both `prepare-export-resolver.js` and `team-sprint-resolver.js` import from the extractor.

### ✅ Step 4 — `fetchSprintReportsForTeams` consolidated
GreenHopper fetch loops from both `sprint-data-resolver.js` and `team-sprint-resolver.js` merged into one function in `sprint-extractor.js` using the shared semaphore. Single rate-limiting strategy now applied everywhere.

### ✅ Step 5 — `makeSessionKey` centralised in `config/constants.js`
Four local `sessionKey` definitions removed. All resolvers import from constants.

### ✅ Step 6 — Verified
Individual sprint analysis tested for multiple teams. Portfolio sprint section populates across all scopes. GreenHopper 429 handling confirmed stable.

### ✅ Step 7 — `docs/architecture.md` updated
Sprint extractor, concurrency util, new resolvers, and rules 7–9 added to the architecture guide.

---

## 8. Rules Going Forward

> These rules prevent the same duplication from happening again.

1. **Any function used by 2+ resolvers belongs in a layer file** (extractor, transformer, formatter, or utility). Never copy-paste across resolvers.

2. **Sprint-specific extraction lives in `sprint-extractor.js`**. Resolvers import; they never inline board discovery, sprint list fetching, or GreenHopper call loops.

3. **Concurrency primitives live in `utils/concurrency.js`**. Never define `makeSemaphore` or a sequential delay loop inside a resolver.

4. **The storage key format is defined once** in `config/constants.js` as `makeSessionKey`. Every resolver imports it.

5. **Rate-limiting strategy is unified**: one semaphore via `makeSemaphore`, same limit for all GreenHopper calls regardless of which resolver triggers them. No mix of sequential-delay and semaphore approaches.

6. **Portfolio pipeline is the source of truth**. When fixing a sprint extraction bug in the portfolio path, verify that `team-sprint-resolver.js` calls the same underlying shared function and therefore gets the same fix automatically.

---

## 9. Open Questions — Resolved

1. **Step 0 confirmation** ✅ — Confirmed. Stale cache was the root cause. After wipe + re-run, sprint section populated for all teams.

2. **GreenHopper semaphore limit** ✅ — Limit of 3 is empirically stable; no 429s observed in production. Left as a constant in `sprint-extractor.js`. Future: promote to `constants.js` if tuning is needed across environments.

3. **Board API rate limit** ✅ — No issues observed with parallel Board API calls across 10+ teams. The Board API does not enforce the same strict 429 limits as GreenHopper. Parallel calls remain without a semaphore.

4. **`discoverBoardIdForTeam` strategy** ✅ — Unified. `extractNewestSprintIdByTeam` (pure, reads issue fields) is the fast first pass; `enrichTeamSprintListsFromBoardApi` (Board API) replaces the sprint lists with authoritative data afterward. `discoverBoardIdForTeam` (two-pass JQL) is the fallback for the individual resolver when no session exists. Both paths now call `fetchSprintReportsForTeams` with the same shared semaphore.

---

*Document created: 2026-04-20. Update this file whenever the sprint ETL is modified.*
