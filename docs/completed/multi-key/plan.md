# Multi-Key Portfolio Analysis & Reporting — Feature Plan

> ✅ **Completed: 2026-04-07**

## Overview

Allow users to provide multiple Jira keys (objectives, initiatives, or epics) and choose
how Gustiel handles them — as **Isolated** items delivered together, or as a **Merged**
unified dataset.

---

## The Two Modes

| Mode | Term | What it does |
|---|---|---|
| **1** | **Isolated** | Each key analyzed/reported independently; results delivered together in one response or Confluence page. Each item keeps its own structure and heading. |
| **2** | **Merged** | All items from all keys pooled into a single dataset; analyzed/reported as one unified portfolio. An **Objective** column is added to tables to show which key each item belongs to. |

> **Note:** The existing single-key behaviour is unchanged. Multi-key always triggers the clarifying question.

---

## UX — Prompt-First Clarification

When the user provides 2+ keys for any analysis or report, Gustiel **always pauses and
asks before calling any action**:

> *"Got it — for **WX-1145** and **WX-1146**, would you like me to:*
> *1) **Isolated** — analyze/report each one separately but deliver them together in a single response or page; or*
> *2) **Merged** — pool all items from both into one combined dataset and treat them as a single portfolio (with an **Objective** column to show which key each item belongs to)?"*

This eliminates intent-inference from phrasing. The user's explicit choice is passed as a
clean flag to the actions (`mode: 'isolated'` vs `mode: 'merged'`).

---

## Scope Rules

- Same-level combinations only: **objectives + objectives**, **initiatives + initiatives**,
  **epics + epics**.
- Cross-level combinations (e.g. an objective mixed with an initiative) are **blocked**
  with a clear error message before any action is called.
- Scope is detected per key via `extractItemScope` (already exists).

---

## Extra Column (Merged Mode Only)

| Property | Decision |
|---|---|
| Column header | **Objective** |
| Value | Root objective key only (e.g. `WX-1145`) — no hyperlink |
| Appears in | Initiative table, Epic table (both `formatInitiativeTable` and epic row/formatters) |
| Condition | Only rendered when `mergedMode = true`; single-key calls are completely untouched |

For epics: the `sourceKey` (root objective) is stamped onto each item by the resolver
after extraction — `extractItem` itself is not changed (stays pure).

---

## Caching Strategy

**"Store per-key independently, combine at query time."**

- Individual sessions (`export_session:<accountId>:WX-1145`, `…:WX-1146`) remain exactly
  as they are — one per key, always independent.
- Merged mode **never writes a composite session**. It reads individual sessions and
  combines them in-memory at query time.
- Cache validity is checked **per key independently** — stale keys are re-fetched; fresh
  keys are reused as-is regardless of the requested mode.
- Storage overhead: O(n) per key — zero additional storage for merged queries.

---

## What Changes Across the Stack

### New behaviour (prompt layer)
| File | Change |
|---|---|
| `prompts/main_prompt.md` | Add clarifying-question rule for 2+ keys; define Isolated vs Merged; document the `mode` flag |

### Code changes (Isolated mode)
Isolated mode reuses the **existing single-key flow**, called once per key. No new
resolver logic needed — the prompt orchestrates sequential calls.

### Code changes (Merged mode)
| File | Change |
|---|---|
| `manifest.yml` | Add `portfolioKeys` (comma-separated, optional) + `mode` inputs to `analyze-portfolio`, `report-portfolio`, `prepare-portfolio-export` |
| `src/resolvers/portfolio-analysis-resolver.js` | Accept `portfolioKeys`; run Layer 1–3 per key; stamp `sourceKey` on items; pool datasets; pass `mergedMode` to formatters |
| `src/resolvers/portfolio-report-resolver.js` | Same multi-key extraction + tagging; pagination derives teams from pooled epic set |
| `src/resolvers/prepare-export-resolver.js` | Accept `portfolioKeys`; run per key independently; pool `allTeams` / counts |
| `src/formatters/markdown-formatter.js` | `formatInitiativeTable` + `epicRow` + `formatEpicList` / `formatEpicsByTeam`: add optional `Objective` column when `mergedMode = true` |

### Files that do NOT change
| File | Reason |
|---|---|
| `src/extractors/jira-extractor.js` | `extractItem` stays pure; `sourceKey` stamped by resolver |
| `src/transformers/portfolio-transformer.js` | All functions are item-array-agnostic |
| `src/resolvers/lead-time-resolver.js` | Portfolio ETL step 2 — untouched |
| `src/resolvers/check-cache-resolver.js` | Checks per-key sessions — already works for merged (check each key independently) |

---

## Confluence Page Title

Both **Merged** and **Isolated-combined** follow the existing pattern:
`Gustiel Portfolio Report by ...` — no change to the current title generation logic.

## Objective Column Position

**First column** in both the Initiative table and the Epic table, to the left of all
existing columns. Simplifies scanning — the reader immediately sees which portfolio each
row belongs to before reading its details.
