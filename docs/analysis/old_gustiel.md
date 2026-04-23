# Old Gustiel — Analysis of hb-jira-program-sentinel

> **Source:** `C:\workspace\_other\jira_forge\hb-jira-program-sentinel`
> **Platform:** Atlassian Forge · Rovo Agent · Node.js
> **Scanned:** 2026-04-20
> **Purpose:** Reference document for capabilities to consider porting to gus-gustiel, with architecture caveats.

---

## Overview

The predecessor agent had a broader individual-analysis surface area but lacked the ETL discipline and the portfolio-as-master-layer design of the current solution. It was organized as a flat `resolvers/` + `services/` structure with no extractor or transformer layer — services contained business logic, and resolvers orchestrated I/O, calculations, and formatting together.

---

## Source Folder Structure

```
src/
├── config/
│   └── constants.js                      # Field IDs, workflow dicts, status constants
│
├── services/
│   ├── jira-api-service.js               # Jira HTTP I/O (shared with current solution)
│   ├── confluence-api-service.js         # Confluence CRUD
│   ├── cycle-time-service.js             # ⚠️ Business logic in service: changelog parsing,
│   │                                     #   time-in-status, workflow metrics, flow efficiency
│   ├── status-service.js                 # ⚠️ Business logic in service: project status categories
│   ├── portfolio-storage-service.js      # Forge Storage read/write for multi-phase portfolio
│   └── cfd-service.js                    # Cumulative Flow Diagram data generation
│
├── resolvers/
│   ├── portfolio-resolvers.js            # ⚠️ Monolith: I/O + calculations + formatting in one file
│   ├── cycle-time-resolvers.js           # Per-issue and per-sprint cycle time analysis
│   ├── team-throughput-resolver.js       # Epic + story/task throughput per team
│   ├── portfolio-forecast-advanced-resolver.js  # Per-epic forecasting using throughput data
│   ├── portfolio-extract-resolver.js     # Phase 1: extract hierarchy + filter by quarter
│   ├── portfolio-complete-resolver.js    # Phase 2: epic baseline calculation
│   ├── portfolio-finalize-resolver.js    # Phase 3: scope validation + RYG
│   ├── add-throughput-resolver.js        # Phase 4: attach team throughput to portfolio data
│   ├── board-resolvers.js               # Board-level sprint analytics (by boardId)
│   ├── sprint-resolvers.js              # Sprint status breakdown, content inspection
│   ├── timeframe-resolvers.js           # N-month cycle time + issue type comparison
│   └── (discovery resolvers)            # discover-fields, list-issue-types, list-project-statuses
│
└── utils/
    ├── stats-utils.js                    # calculateStats(), calculatePercentile() — MISSING in current
    ├── sle-utils.js                      # SLE text generator (P85-based) — MISSING in current
    ├── wip-utils.js                      # WIP limits via Little's Law — MISSING in current
    ├── date-utils.js                     # Date formatting helpers
    └── jql-utils.js                      # JQL escaping
```

---

## Capability Inventory

### 🔬 Cycle Time Engine (entirely missing from current solution)

Powered by `cycle-time-service.js`. Functions:
- `parseChangelogForStatusTransitions()` — extracts every status hop with timestamps from issue changelog
- `calculateTimeInStatus()` — time spent in each status; handles synthetic initial "Backlog" state
- `calculateEnhancedWorkflowMetrics()` — Lead Time, Cycle Time, Client Lead Time, rework detection, complexity score
- `buildIssueTimeInStatusMap()` — status → seconds map per issue
- `calculateFlowEfficiency()` — working time % vs. waiting time %

This engine is the shared foundation for all analytics below.

### 📊 Standalone Individual Skills (no portfolio key needed)

| Skill | Resolver | What it does |
|---|---|---|
| Per-issue cycle time | `cycle-time-resolvers.js` | Lead/Cycle/Client Lead Time, time-in-status table, rework flag, complexity score, flow efficiency for a single issue |
| Sprint cycle time | `cycle-time-resolvers.js` | Batch P50/P90 cycle time, lead time, flow efficiency, rework %, distribution buckets for a sprint or timeframe |
| Timeframe analysis | `timeframe-resolvers.js` | N-month P50/P75/P85/P95 per issue type |
| Issue type comparison | `timeframe-resolvers.js` | Story vs Bug vs Task: slower types, variance, flow efficiency |
| Stale work detection | `cycle-time-resolvers.js` | Current WIP items exceeding P85 historical cycle time |
| Cumulative Flow Diagram | `cfd-service.js` | WIP bands over time; blockage pattern detection |
| Board sprint analytics | `board-resolvers.js` | Velocity + trends by boardId (not team name) |
| Sprint status breakdown | `sprint-resolvers.js` | Total/Done/WIP/ToDo counts by team |
| Sprint content inspection | `sprint-resolvers.js` | Sprint item listing with dynamic columns |
| Traverse hierarchy | `portfolio-resolvers.js` | Walk Story → Epic → Initiative → Objective → Strategic Investment |
| Google Chat send | *(dedicated resolver)* | Push any report to a Google Chat webhook |
| Field/type discovery | *(discovery resolvers)* | `discover-fields`, `list-issue-types`, `list-project-statuses`, `list-field-options` |

### 🔮 Portfolio Forecasting Pipeline (4-phase, LLM-orchestrated)

Multi-phase pipeline requiring the LLM to carry intermediate JSON between calls:

| Phase | What happens |
|---|---|
| **Extract** | Hierarchy crawl + quarter filtering (QP Planning Sessions field) |
| **Baseline** | Per-team: avg stories/epic, std dev from last 12 months of completed epics |
| **Scope validation** | Flags epics below `avg − 1 stdDev` threshold; adjusts progress to baseline-adjusted % |
| **Throughput** | Epic completion rate per month per team; story/task lead time (P50/P85) |
| **Forecast** | Per-epic: remaining stories ÷ throughput = months needed → forecasted date vs. due date → RYG |

Three progression signals per epic: `currentPctProgression`, `expectedPctProgression`, `baselineAdjustedPctProgression`.

Forecast uses P85 lead time + team throughput (stories/month). Monte Carlo framing documented (1,000 iterations) but deterministic in the actual implementation.

### 📐 Statistical Utilities (missing from current solution)

| File | Functions |
|---|---|
| `stats-utils.js` | `calculateStats(values)` → `{avg, sd}`; `calculatePercentile(sortedValues, percentile)` |
| `sle-utils.js` | P85-based SLE recommendation text + comparison table per issue type |
| `wip-utils.js` | Little's Law WIP limit (`throughput × leadTime`), distributed across statuses |

---

## Architecture Caveats

These patterns **must not** be carried over. Each violates the ETL architecture rules defined in `docs/architecture.md`.

### ❌ CAV-1: No layer separation
No `extractors/` or `transformers/` folder exists. Raw JSON interpretation, business logic calculations, and Markdown formatting happen in the same file — often in the same function. A fix in one place never propagates; every resolver is independently maintaining its own logic.

### ❌ CAV-2: Business logic in services
`cycle-time-service.js` and `status-service.js` contain pure domain calculations (lead time formulas, workflow metrics, status classification). These belong in `transformers/`; services should be I/O only.

### ❌ CAV-3: Monolith resolver
`portfolio-resolvers.js` performs Jira I/O, calculations, and formatting in a single file. Violates the "resolver is only the entry/exit door" rule entirely.

### ❌ CAV-4: LLM-orchestrated multi-phase pipeline
The portfolio pipeline stores intermediate state in Forge Storage and requires the LLM to pass JSON blobs between phases. This is fragile — the LLM can lose state, truncate payloads, or mis-sequence steps. The current ETL session model (write-once per step, read at export time) is the correct architecture.

### ❌ CAV-5: Inline statistics
`calculateStatsForArray` is defined inline inside `cycle-time-resolvers.js` and duplicated across files. Stats belong in a shared `utils/stats-utils.js`.

### ❌ CAV-6: No concurrency primitive
GreenHopper rate-limiting used a mix of sequential delays and no-limit parallel calls depending on the resolver. No shared semaphore existed.

---

## What Should Come In — Mapping to ETL Layers

| Old capability | Target layer in gus-gustiel |
|---|---|
| `parseChangelogForStatusTransitions`, `calculateTimeInStatus`, `calculateEnhancedWorkflowMetrics` | `src/extractors/changelog-extractor.js` (new) |
| `buildIssueTimeInStatusMap`, `calculateFlowEfficiency` | `src/transformers/flow-transformer.js` (new) |
| `calculateStats`, `calculatePercentile` | `src/utils/stats-utils.js` (new) |
| Epic baseline, scope validation, baseline-adjusted RYG | `src/transformers/portfolio-transformer.js` (extend existing) |
| Per-epic forecasting (remaining ÷ throughput) | `src/transformers/forecast-transformer.js` (new) |
| SLE text, WIP recommendation text | `src/formatters/` (output only, no calculations) |
| All individual analytics skills | Thin resolvers → `src/resolvers/` calling shared ETL chain |
| Traverse hierarchy | `src/extractors/jira-extractor.js` new function + thin resolver |
| Google Chat send | `src/services/google-chat-service.js` (new) + thin resolver |

**The cycle time engine is the shared foundation.** Once `parseChangelogForStatusTransitions` + `calculateEnhancedWorkflowMetrics` are in the extractor + transformer layers, all skills — per-issue, per-sprint, per-team, and portfolio forecast — call the same functions. That is the ETL architecture working as designed.
