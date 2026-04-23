# Skill 05 — Lead Time / Cycle Time

## 📋 User Guide

### What It Does

Measures how efficiently your agile teams deliver work — from when an item starts to when it is done. Two metrics:

| Metric | What it measures |
|---|---|
| **Lead Time** | Total elapsed time from when an Epic or Story enters "In Progress" to when it reaches "Done" |
| **Cycle Time** | Active working time for Stories — excludes wait time in intermediate states |

Results are broken down by issue type (Epic, Story, Bug) and team, using the last 6 months of completed items.

### How to Trigger It

| Intent | Example phrases |
|---|---|
| Quick report | *"Lead time for Titan"*, *"Cycle time for Comet"*, *"LCT for Titan and Vanguard"* |
| Export to Confluence | *"Export lead time for Titan to Confluence"*, *"LCT Confluence page for Comet and Titan"* |

### What You'll See

For each team, broken down by issue type:
- **Average Lead Time** — how many days items typically take from start to done
- **Average Cycle Time** — the active working time component
- Sample size (number of items used to compute each average)

> **Tip:** A large gap between Lead Time and Cycle Time reveals queue/wait time — items are sitting between states, not actively blocked.

### Connection to the Portfolio Report

When you run a portfolio report, Lead / Cycle Time is automatically calculated as **Step 2** of the pipeline — no separate action is needed. The standalone skill lets you check individual teams on demand, without a portfolio key or an extracted session.

## 🔧 Technical Reference

> **Actions:** `get-team-lead-time` (inline response) · `export-team-lead-time` (Confluence page)
> **Resolvers:** `team-lead-time-resolver.js` · `team-lead-time-export-resolver.js`

### ETL Flow

Both standalone resolvers share the same extraction and transform functions as the portfolio pipeline Step 2:

```
searchJira (hierarchyLevel in (0,1), last 6 months, Done or In Progress)
  → extractItemForLCT()             [jira-extractor.js]
  → mergeItemsIntoLCTAccumulator()  [portfolio-transformer.js]
  → finalizeLCTAccumulator()        [portfolio-transformer.js]
  → formatLCTSection()              [markdown-formatter.js]
```

### Standalone vs Portfolio

| | Standalone | Portfolio Step 2 |
|---|---|---|
| Scope | One or more teams by name | All teams from portfolio session |
| Input | `teamNames` (comma-separated) | Team list read from session |
| Session required | ❌ Never | ✅ Yes |
| Output | Inline response or Confluence page | Written to session for Step 4 export |

### Response Fields (Inline — `get-team-lead-time`)

| Field | Use |
|---|---|
| `response.message` | Pre-formatted Markdown table — display verbatim |
| `response.teams` | Array of team names analyzed |
| `response.lctByTeam` | Structured LCT data per team — use for follow-up questions |

### See Also

- `docs/skills/04-portfolio.md` → portfolio pipeline (Step 2 context)
- `docs/architecture.md` → Batched Accumulator Pattern, ETL layer map
- `src/resolvers/team-lead-time-resolver.js` · `team-lead-time-export-resolver.js`
- `src/transformers/portfolio-transformer.js` → `finalizeLCTAccumulator`
- `src/extractors/jira-extractor.js` → `extractItemForLCT`
