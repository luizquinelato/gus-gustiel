---
title: Include Milestones in the Portfolio Analysis
status: Proposed
created: 2026-04-30
---

## 🎯 Intent

Surface **Milestones** in the Portfolio Report as an *informal*, parallel parent of Epics — alongside (not replacing) the formal **Objective → Initiative → Epic → Story** hierarchy.

Milestones in this Jira instance live at **hierarchy level 1** (same level as Epic), so they don't fit the formal parent-child chain. They relate to Epics horizontally via the **`is delivered by`** issue link, not via `parent`. The proposal is to keep treating Initiatives as the formal parent, and inject a Milestone block right after the Initiative summary as an additional cross-cutting view of the same epics.

## 🧭 Where it appears in the report

```
## Initiative summary
  └── (existing initiative table)

## 🎌 Milestones                                ← NEW block
  └── (one section per Milestone — same shape as the Initiative section)
        ├── Milestone summary (key, status, due date, % complete derived from linked epics)
        └── Epics delivering this milestone (table — identical to the per-Initiative epic table)

## Epics                                        ← unchanged (still grouped by Initiative)
```

The block is purely additive: an epic can appear under both its formal Initiative **and** under one or more Milestones. We need to make this explicit in the section intro so readers don't double-count.

## 🧪 Detection flow (first iteration)

The trigger is at the **scope detection** step (`extractItemScope` in `jira-extractor.js`) — currently `hierarchyLevel === 1` returns `'epic'`. Add a branch:

1. If `issuetype.name === 'Milestone'` (regardless of hierarchy level) → new scope `'milestone'`.
2. For a milestone scope, run a **different extraction**: don't follow `parent =`; instead query issue links and filter by link type `is delivered by` to get the list of Epics.
3. From there, treat the milestone as an "informal parent" — fetch each linked epic (and its stories) using the same epic/story extraction the rest of the pipeline already uses. The epic block is rendered identically to the per-Initiative one.

For the "include milestones inside an Objective/Initiative scope" case (the more interesting one), we'd add a second pass after Layer 1 that:

- collects every epic in scope,
- for each epic, follows `is delivered by` **inwards** to find its milestones,
- groups epics by milestone for the new section,
- leaves the formal Initiative grouping untouched.

## ❓ Open questions

- **Multiple ways of working with it.** First iteration above treats a milestone *as a portfolio key on its own*. Iteration 2 would surface milestones *inside* an Objective/Initiative report as a second grouping. Should both ship together, or stage them?
- **% complete for the milestone.** Derive from linked epics' completion % (same formula as Initiative)? Or from explicit Milestone fields if they exist (planned/start/end dates)?
- **RYG status for the milestone.** Reuse `getRygStatus` against the milestone's own dates and the derived completion %, same as Initiatives.
- **Link direction.** Does our Jira store the link as *Epic `is delivered by` Milestone* or *Milestone `delivers` Epic* (or both)? We'd need to confirm the canonical direction and possibly handle both.
- **Epics linked to multiple milestones.** How do we render an epic that delivers two milestones — duplicate the row under each, or list it once with a "+1 more milestone" hint?
- **Epics with no milestone.** The new section should clearly call out that "epics without a `is delivered by` milestone are still in the Epics section below" so nothing feels missing.
- **Stories.** Do we drill into stories under the Milestone view, or stop at the epic level (the Initiative view already covers stories)? Suggest stopping at epics for the first cut.
- **Performance.** Following links per epic could mean N extra REST calls. Worth batching via a single JQL `issuetype = Milestone AND issue in linkedIssues(...)` after Layer 2.

## ⚖️ Trade-offs

| Approach | Pro | Con |
|---|---|---|
| Inject milestones as a new section after Initiative summary (this proposal) | Keeps formal hierarchy intact; readers can ignore the section if they don't care | Adds visual length; risk of double-counting epics |
| Replace Initiative with Milestone for milestone-driven portfolios | Cleaner output for milestone-centric programs | Breaks the "single hierarchy" mental model; would need a per-portfolio toggle |
| Side panel / collapsible block | Compact | Confluence rendering is awkward; not worth the complexity |

## 📌 Out of scope (for the first iteration)

- Editing the underlying ETL to make Milestone a *first-class* node (would require schema changes in `portfolio-transformer` and likely break the cached session shape).
- Sprint Velocity per milestone — milestones span multiple teams; the existing per-team sprint analysis already covers this.
