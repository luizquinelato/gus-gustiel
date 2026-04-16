# Team-Level Analysis — Feature Plan

## Overview

A new standalone Gustiel skill that performs direct Lead/Cycle Time analysis for a given
Agile team — **independent of any portfolio, initiative, or epic**.

Triggered when the user asks something like:
> *"I need an analysis for my team X"*
> *"Show me lead time for the Core Platform team"*

This is the foundation of a broader team-level analysis capability. LCT is the first
metric; additional metrics will be added in subsequent iterations.

---

## What It Is NOT

- **Not** a modification of `calculate-lead-time-data` (that action remains dedicated to
  portfolio ETL step 2 and is untouched).
- **Not** part of the portfolio report flow (`prepare-portfolio-export` is not involved).

---

## Architecture

Follows strict ETL rules. New resolver only — no new extractor, transformer, or formatter
functions needed for the initial LCT phase.

### New files
| File | Purpose |
|---|---|
| `src/resolvers/team-analysis-resolver.js` | Thin orchestrator — team-direct LCT skill |

### Existing files that change
| File | Change |
|---|---|
| `manifest.yml` | New action `analyze-team` with `teamName` + `timeframeDays` inputs |
| `src/index.js` | Export `analyzeTeam` from the new resolver |
| `prompts/main_prompt.md` | New skill section: when and how to call `analyze-team` |
| `doc/architecture.md` | Add `team-analysis-resolver.js` to the resolver layer map |

### Existing files that are NOT touched
| File | Reason |
|---|---|
| `src/extractors/jira-extractor.js` | `extractItemForLCT` already generic |
| `src/transformers/portfolio-transformer.js` | `mergeItemsIntoLCTAccumulator` / `finalizeLCTAccumulator` already generic |
| `src/formatters/` | No new format needed for initial phase |
| `src/resolvers/lead-time-resolver.js` | Portfolio ETL step 2 — untouched |
| `src/resolvers/prepare-export-resolver.js` | Not part of team-direct flow |

---

## Inputs

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `teamName` | string | Yes | — | Exact agile team field value as-is (e.g. `"Core Platform"`) |
| `timeframeDays` | integer | No | `180` | Lookback window in days (6 months default) |

---

## Storage / Cache

Per-user storage using the same pattern as portfolio sessions.

- **Key:** `team_analysis_session:<accountId>:<sanitizedTeamName>`
- `sanitizedTeamName`: lowercase, spaces → underscores, special chars stripped
- Same PARTIAL → SUCCESS batching pattern as `calculate-lead-time-data`
- Reused by future team-level skills (no re-fetch needed if cache is fresh)

---

## Batching / PARTIAL Flow

Same pattern as the portfolio LCT resolver:
- Fetches `LCT_PAGES_PER_BATCH` pages per Forge invocation
- Returns `PARTIAL` with progress message while more pages remain (Rovo auto-calls)
- Returns `SUCCESS` when all pages are done; finalises and saves session

---

## JQL Strategy

```
hierarchyLevel in (0, 1)
AND cf[<agileTeamFieldNum>] in ("<teamName>")
AND ((statusCategory = Done AND updated >= -<timeframeDays>d) OR statusCategory = "In Progress")
```

- `agileTeamFieldNum` derived from `getEnvFromJira()` (env-aware, no hardcoding)
- `timeframeDays` replaces the hardcoded `-180d` used in the portfolio flow

---

## Output (Phase 1 — LCT only)

On `SUCCESS`, the resolver returns:
- `status: 'SUCCESS'`
- `teamName`
- `timeframeDays`
- `itemCount`, `pagesRead`
- `lctByTeam`, `velocityByTeam`, `overallVelocity` (saved to storage)
- Human-readable `message` with per-type LCT breakdown

---

## Planned Future Additions (subsequent iterations)

Items to be defined and added to this document as the skill grows:

- [ ] TBD — additional team-level metrics beyond LCT/velocity
- [ ] TBD — Confluence export for team-level report
- [ ] TBD — cache check action for team sessions (`check-report-cache` extension or new action)

---

## Open Questions (to resolve before implementation)

- [ ] Final action name: `analyze-team` (proposed)
- [ ] PARTIAL pattern vs single-response: use PARTIAL (consistent with portfolio flow)
