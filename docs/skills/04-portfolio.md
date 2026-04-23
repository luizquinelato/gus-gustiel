# Skill 04 — Portfolio Report

## 📋 User Guide

### What It Does

Delivers a full portfolio health report for one or more Jira portfolio keys, exported directly to a Confluence page. The report covers the full Jira hierarchy (Objective → Initiative → Epic → Story) and includes:

- Initiative and epic progress (current %, expected %, Red/Yellow/Green status)
- Epics grouped by team
- Lead / Cycle Time per team
- Sprint velocity analysis per team (last 6 closed sprints)

This is Gustiel's flagship skill and the most comprehensive view of portfolio health.

### How to Trigger It

| Example phrases | Result |
|---|---|
| *"Analyze WX-1145"*, *"What's the status of WX-1145?"* | Full Confluence report |
| *"Export WX-1145 to Confluence"*, *"Give me a full report for WX-1145"* | Full Confluence report |
| *"Portfolio report for WX-1145"* | Full Confluence report |

### Scope Support

The portfolio key can point to any level of the hierarchy:

| Key type | What is analyzed |
|---|---|
| **Objective** | Full hierarchy — all initiatives, epics, and stories |
| **Initiative** | Direct-child epics and stories under that initiative |
| **Epic** | Stories under that epic only |

### Multi-Key Reports

You can analyze multiple portfolio keys together:

| Mode | Result |
|---|---|
| **Isolated** | One Confluence page, each key in its own section |
| **Merged** | One Confluence page, all keys pooled into shared tables |
| **Individual** | A separate Confluence page per key |

### Session Cache

Gustiel caches the extracted data so you can re-run steps without re-fetching from Jira. If data has changed, say *"fresh"* or *"redo"* to force a new extraction. You can also clear your session cache by asking *"Clear my cache"*.

## 🔧 Technical Reference

> **Resolvers:** `confluence-export-resolver.js`, `prepare-export-resolver.js`, `lead-time-resolver.js`, `sprint-data-resolver.js`

### ETL Pipeline (Four Steps)

Each step is a separate Forge invocation — required by Forge's 25-second execution limit.

**Step 1 — EXTRACT** (`prepare-portfolio-export` → `prepare-export-resolver.js`)
- Layers 1–3: Objective + Initiatives + Epics + Story counts
- Sprint board discovery per team (`sprint-extractor.js`)
- Writes session to Forge Storage: `phase = 'layers_1_4'`

**Step 2 — LCT** (`calculate-lead-time-data` → `lead-time-resolver.js`)
- Batched Epic + Story changelog JQL (loops across invocations: returns `PARTIAL` until done)
- Calculates Lead Time and Cycle Time per team
- Updates session: `phase = 'complete'`, adds `lctByTeam`, `velocityByTeam`

**Step 3 — SPRINT** (`calculate-sprint-data` → `sprint-data-resolver.js`)
- Reads team list from session
- Calls `fetchSprintReportsForTeams()` from `sprint-extractor.js` — same function used by the Team Sprint skill
- Updates session: adds `sprintsByTeam`

**Step 4 — LOAD** (`export-to-confluence` → `confluence-export-resolver.js`)
- Reads full session, formats output, delivers to Confluence

### Session Key Format

`export_session:<accountId>:<portfolioKey>`

### See Also

- `docs/architecture.md` → full ETL layer map, Data Flow diagram, Batched Accumulator Pattern
- `docs/skills/06-team-sprint.md` → shared sprint extraction (Step 3)
- `docs/skills/08-session-cache.md` → clearing stale cache
- `docs/skills/09-storage.md` → inspecting session state
- `src/resolvers/prepare-export-resolver.js`, `lead-time-resolver.js`, `sprint-data-resolver.js`
- `src/extractors/sprint-extractor.js` — shared sprint extraction
