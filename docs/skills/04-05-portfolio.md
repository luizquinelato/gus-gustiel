# Skills 04 & 05 — Portfolio Report (Confluence + Chat)

> **Access:** Everyone · **Resolvers:** `confluence-export-resolver.js`, `portfolio-analysis-resolver.js`, `portfolio-report-resolver.js`

---

## What It Does

Delivers a full portfolio health report for one or more Jira portfolio keys — either as a **permanent Confluence page** (Skill 4) or interactively **in chat** section by section (Skill 5). Both modes run the exact same ETL pipeline and produce the same data. The output format is the only difference.

The report covers the full hierarchy: Objective → Initiative → Epic → Story, including:
- Progress by initiative and epic (current %, expected %, RYG status)
- Epics grouped by team
- Innovation Velocity & Lead/Cycle Time (LCT) per team
- Sprint velocity analysis per team (last 6 closed sprints)

**This skill is the top of the hierarchy.** It consolidates data that the individual team sprint skill (Skill 06) also surfaces, but at portfolio scale across all teams simultaneously.

---

## Trigger Phrases

| Mode | Example phrases |
|---|---|
| Ambiguous (ask first) | *"Analyze WX-1145"*, *"What's the status of WX-1145?"*, *"Show me WX-1145"* |
| Chat explicit | *"Analyze WX-1145 in chat"*, *"Portfolio report in chat for WX-1145"* |
| Confluence explicit | *"Export WX-1145 to Confluence"*, *"Give me a full report for WX-1145"* |

When intent is ambiguous, Gustiel **always asks** before proceeding (see Disambiguation Rule in `prompts/main_prompt.md`).

---

## Scope Support

The portfolio key can point to any level of the hierarchy:

| Key type | What is analyzed |
|---|---|
| **Objective** | Full hierarchy: Objective → Initiatives → Epics → Stories |
| **Initiative** | Direct-child Epics + Stories under that Initiative |
| **Epic** | Stories under that Epic only |

Scope is auto-detected at runtime via `extractItemScope()` (→ `src/extractors/jira-extractor.js`).

---

## ETL Pipeline (Four Steps)

The portfolio report is produced by a **four-step ETL pipeline**. Each step is a separate Forge invocation — required by Forge's 25-second execution limit.

```
Step 1 — EXTRACT (prepare-portfolio-export)
  prepare-export-resolver.js
  ├─ Layers 1-3: Objective + Initiatives + Epics + Story counts
  ├─ Sprint board discovery per team (→ sprint-extractor.js)
  └─ Writes session to Forge Storage: phase = 'layers_1_4'

Step 2 — LCT (calculate-lead-time-data)               ← "L" in LCT
  lead-time-resolver.js
  ├─ Batched Epic + Story changelog query (may loop: returns PARTIAL until done)
  ├─ Calculates Lead Time, Cycle Time per team
  └─ Updates session: phase = 'complete', adds lctByTeam, velocityByTeam

Step 3 — SPRINT (calculate-sprint-data)
  sprint-data-resolver.js
  ├─ Reads team list from session
  ├─ Calls fetchSprintReportsForTeams() → sprint-extractor.js   ← shared with Skill 06
  └─ Updates session: adds sprintsByTeam

Step 4 — LOAD (export-to-confluence / analyze-portfolio-chat)
  confluence-export-resolver.js  OR  portfolio-analysis-resolver.js
  └─ Reads full session, formats output, delivers to Confluence or chat
```

> **Sprint data reuse:** Step 3 uses the exact same `fetchSprintReportsForTeams()` function that powers Skill 06 (Team Sprint Analysis). See → `docs/skills/06-team-sprint.md`.

> **LCT detail:** Lead/Cycle Time is calculated from changelog history (status transitions). The LCT step batches issues across multiple Forge invocations and loops silently until complete.

---

## Multi-Key Support

Multiple portfolio keys can be analyzed in a single request:

| Mode | Behaviour |
|---|---|
| **Isolated** | One Confluence page, each key in its own section with a clear divider |
| **Merged** | One Confluence page, all keys pooled into shared tables |
| **Individual** | One separate Confluence page per key |

Multi-key always requires a confirmation step (Step E-confirm) before any export call is made.

---

## Session Cache

The ETL pipeline stores results in Forge Storage using the key:
```
export_session:<accountId>:<portfolioKey>
```

On subsequent requests, Gustiel checks the cache (Step E-cache / Step CA-cache) and offers to reuse it. Cache state can be inspected with Skill 09 and cleared with Skill 08.

---

## See Also

- `docs/architecture.md` → full ETL layer map, Data Flow diagram, Pagination Model, Layered Crawl
- `docs/skills/06-team-sprint.md` → how sprint reports are fetched (shared pipeline, Step 3)
- `docs/skills/08-session-cache.md` → clearing stale cache
- `docs/skills/09-storage.md` → inspecting session state
- `src/resolvers/prepare-export-resolver.js` — Step 1
- `src/resolvers/lead-time-resolver.js` — Step 2
- `src/resolvers/sprint-data-resolver.js` — Step 3
- `src/extractors/sprint-extractor.js` — shared sprint extraction
