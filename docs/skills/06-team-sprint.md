# Skill 06 — Team Sprint Analysis

## 📋 User Guide

### What It Does

Gives you an instant sprint velocity report for any single agile team — no portfolio key needed. Just ask by team name. The report shows the last 6 closed sprints with velocity, say/do ratio, and rollover story points.

When 5 or more closed sprints are available, the report also includes:
- **📈 Velocity Trend** — is the team's velocity stable, improving, or declining?
- **🔀 Scope Management** — how much scope is added during sprints, and how much of it gets completed?
- **🎯 Predictability Score** — a weighted composite score (max 6 pts) rating the team's consistency

This skill works independently — no portfolio extraction or cached session required.

### How to Trigger It

| Intent | Example phrases |
|---|---|
| Sprint performance | *"Sprint analysis for Titan"*, *"How has Comet been performing?"*, *"Velocity for Vanguard"* |
| Say/Do ratio | *"Sprint say/do for Titan"*, *"What's the sprint history for Comet?"* |
| Sprint names | *"List the past sprint names for Titan"*, *"What were Titan's last sprints called?"* |
| Board info | *"What board is the Titan team on?"*, *"What's the board ID for Vanguard?"* |

> **Tip:** Use a team name (e.g. *Titan*, *Comet*), not a Jira key. Team names never match the `PROJECT-NUMBER` pattern.

### What You'll See

A sprint velocity table for the last 6 closed sprints, followed by trend analysis sections when enough data is available. A single question like "Sprint analysis for Titan" returns everything.

## 🔧 Technical Reference

> **Action:** `get-team-sprint-analysis` · **Resolver:** `team-sprint-resolver.js`

### Response Fields

| Field | Use |
|---|---|
| `response.message` | Pre-formatted Markdown (table + trend sub-sections) — display verbatim |
| `response.sprints[].name` | Sprint names — answer *"what were the sprint names?"* |
| `response.boardId` | Numeric board ID — answer *"what's the board ID for X?"* |
| `response.board` | Board display name |
| `response.trendData` | Structured trend analytics — present when ≥5 valid sprints; `null` otherwise |

All fields are populated from a single action call (Response Reuse Pattern — see `docs/architecture.md`).

### Internal Pipeline

`team-sprint-resolver.js` orchestrates:
1. **EXTRACT** `discoverBoardIdForTeam` — two-pass JQL to find `boardId` without a session
2. **EXTRACT** `getRecentBoardClosedSprints(boardId, 6)` — Board API for last 6 sprint IDs
3. **EXTRACT** `fetchSprintReportsForTeams` — GreenHopper reports, bounded by semaphore (max 3 concurrent)
4. **TRANSFORM** `computeSprintTrends(validSprints)` — pure; returns `null` when < 5 valid sprints
5. **LOAD** `formatTeamSprintChat` — sprint table + trend sub-sections as Markdown

### Relationship to Portfolio (Skill 04)

The same `fetchSprintReportsForTeams` and `computeSprintTrends` functions power both this skill and the portfolio pipeline's Step 3. One implementation, shared.

| | Team Sprint skill | Portfolio Step 3 |
|---|---|---|
| Scope | One team | All teams |
| Board discovery | JQL-based (no session) | Reads from session (faster) |
| Output | Markdown response | Written to session for export |
| Requires session | ❌ Never | ✅ Yes |

### See Also

- `docs/skills/04-portfolio.md` → how sprint data feeds the portfolio
- `docs/architecture.md` → Response Reuse Pattern, sprint-extractor.js details
- `src/extractors/sprint-extractor.js` → `discoverBoardIdForTeam`, `fetchSprintReportsForTeams`
- `src/utils/concurrency.js` → `makeSemaphore`
