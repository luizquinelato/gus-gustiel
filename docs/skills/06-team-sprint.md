# Skill 06 — Team Sprint Analysis

> **Access:** Everyone · **Action:** `get-team-sprint-analysis` · **Resolver:** `team-sprint-resolver.js`

---

## What It Does

Delivers an instant sprint velocity report for a **single agile team** — no portfolio key required. Returns the last 6 closed sprints with velocity, say/do ratio, rolled-over story points, and sprint names, sourced directly from the Jira board (GreenHopper API).

This skill works **independently** — it never requires a prior portfolio extraction or any cached session.

---

## Trigger Phrases

| Intent | Example phrases |
|---|---|
| Sprint performance | *"Sprint analysis for Titan"*, *"How has Comet been performing?"*, *"Velocity for Vanguard"* |
| Say/Do | *"Sprint say/do for team X"*, *"What's the sprint history for Titan?"* |
| Sprint names | *"List the past sprint names for Titan"*, *"What were Titan's last sprints called?"* |
| Board info | *"What board is the Titan team on?"*, *"What's the board ID for Vanguard?"* |
| General performance | *"How is Bushido performing?"*, *"How are things going for Comet?"* |

> ⚠️ **Team name vs. Jira key:** A team name (`Titan`, `Comet`) NEVER matches the `PROJECT-NUMBER` pattern. When the user asks about a team name (no Jira key), route **directly** here — do not apply the portfolio disambiguation flow.

---

## Response Fields (all on `status === "SUCCESS"`)

| Field | Use |
|---|---|
| `response.message` | Pre-formatted Markdown table — display verbatim for full sprint reports |
| `response.sprints[].name` | List of sprint names — answer *"what were the sprint names?"* |
| `response.boardId` | Numeric board ID — answer *"what's the board ID for X?"* |
| `response.board` | Board display name |

All four fields are populated from a **single action call**. Rovo selects the relevant field per question type. See the **Response Reuse Pattern** in `docs/architecture.md`.

---

## How It Works Internally

```
team-sprint-resolver.js (thin orchestrator)
    │
    ├─ discoverBoardIdForTeam(teamName, ...)     ← sprint-extractor.js
    │   Two-pass JQL: finds boardId from open + closed sprint issues
    │
    ├─ getRecentBoardClosedSprints(boardId, 6)   ← jira-api-service.js
    │   Board API — lists last 6 closed sprint IDs
    │
    └─ fetchSprintReportsForTeams(teams, ...)     ← sprint-extractor.js
        GreenHopper sprint reports per sprint
        Bounded by shared semaphore (max 3 concurrent) ← concurrency.js
```

**Key point:** `fetchSprintReportsForTeams` is the same function used by the portfolio pipeline's Step 3 (`sprint-data-resolver.js`). There is one implementation, shared by both. Any fix to sprint report fetching applies to both the individual skill and the portfolio — by design.

---

## Relationship to Portfolio (Skills 04/05)

The portfolio pipeline (Skill 04/05, Step 3) uses **the same underlying sprint extraction functions** (`sprint-extractor.js`) as this skill. The difference:

| | Skill 06 (this skill) | Skill 04/05 Step 3 |
|---|---|---|
| Scope | One team | All teams in the portfolio |
| Board discovery | `discoverBoardIdForTeam` (JQL-based, no session needed) | `extractNewestSprintIdByTeam` (reads from session, faster) |
| Output | Chat message | Written to Forge Storage session for later use in export |
| Requires session | ❌ Never | ✅ Yes (Step 1 must run first) |

---

## See Also

- `docs/skills/04-05-portfolio.md` → how sprint data feeds the full portfolio report
- `docs/architecture.md` → sprint-extractor.js details, Response Reuse Pattern
- `src/extractors/sprint-extractor.js` → `discoverBoardIdForTeam`, `fetchSprintReportsForTeams`
- `src/utils/concurrency.js` → `makeSemaphore` (GreenHopper rate-limit primitive)
