---
title: Sprint Review — Chat & Export
status: Proposed
created: 2026-04-30
---

## 🎯 Intent

A new skill focused on a single sprint — the **most recently closed sprint** of a given team — designed to be the input/companion for the team's Sprint Review ceremony. Two delivery modes, same data:

1. **Chat mode** — quick conversational summary in Rovo (no Confluence needed).
2. **Export mode** — full Confluence page suitable for sharing with stakeholders.

Conceptually a sibling to **Sprint Analysis** (Skill 06), but where Sprint Analysis looks at the last 6 sprints to study *trends*, Sprint Review zooms into one sprint to study *what was actually delivered*.

## 🧭 Report shape

```
# Sprint Review — <Team> · <Sprint name>            ← title
> Sprint window · Velocity · Say/Do · Carry-over    ← one-line headline

## 📊 Sprint Summary                                ← same metrics block as the
                                                       most-recent-sprint card in
                                                       Sprint Analysis, but
                                                       standalone (no trend chart)

## 🏆 Key Deliverables                              ← NEW — see "open question" below

## 📋 Items Delivered                               ← detailed per-item section
  └── For each completed item:
        - Key, type, status, story points
        - Summary
        - Description
        - Acceptance criteria
        - Assignee
        - (link back to Jira)
```

The headline + Sprint Summary reuses the existing per-sprint logic from `sprint-extractor.js` / `formatSprintSection` — single sprint, no trend math.

## 🤔 Open question — what powers "Key Deliverables"?

This is the section that needs design discussion. It should be a short, human-readable consolidation of "what shipped this sprint that matters" — not the raw item list.

Candidate approaches, roughly cheapest → richest:

| Approach | Source of truth | Pros | Cons |
|---|---|---|---|
| **A. Top-N by story points** | Item story points | Trivial to implement; deterministic | Story points ≠ value; noisy for teams that don't estimate |
| **B. Group by parent Epic** | `parent` field of each story | Surfaces "which epics moved" — already aligned with portfolio view | Misses bug-fixes / standalone work; epic titles may be opaque |
| **C. Items flagged with a label** (e.g. `key-deliverable`, `demo-worthy`) | Manual label set during sprint | Explicit author intent; clean output | Requires team discipline; empty if nobody labels |
| **D. Items linked to a Milestone or Initiative** | `is delivered by` link | Matches the milestones idea (cross-cutting view) | Only useful for teams that maintain those links |
| **E. Top items by description length / acceptance-criteria richness** | Issue body | Proxy for "non-trivial work" | Heuristic; easy to game |
| **F. LLM consolidation** | All completed items + descriptions | Best narrative output | Cost, latency, non-deterministic, needs Rovo LLM tooling |

A reasonable v1 would be **B (group by parent Epic) + C (label override when present)** — predictable, no extra config, and the team can still curate with a label when they want a specific story to lead the section. F (LLM) is tempting but is its own ticket.

## 🚦 Triggering

- *"Sprint review for <Team>"*, *"Last sprint review for <Team>"* → chat mode (no Confluence).
- *"Export sprint review for <Team>"*, *"Sprint review report for <Team>"* → Confluence export.
- Same team-name resolution path as Skill 06 (`get-team-sprint`).

## 🛠️ Implementation sketch

- New extractor function in `sprint-extractor.js` (or a sibling `sprint-review-extractor.js`) that picks **the single most recently closed sprint** for the team and returns its `completed` items with full description + acceptance-criteria fields fetched.
- Reuse `getGreenHopperSprintReport` for the per-sprint metrics and item bucketing (completed vs not).
- New formatter section for the "Key Deliverables" block — once the approach above is chosen.
- New formatter section for the per-item detail block — long-form, one card per item.
- Two new resolvers: `sprint-review-chat-resolver.js` (returns markdown to Rovo) and `sprint-review-export-resolver.js` (writes to Confluence with the standard `[YYYY-MM-DD] Sprint Review — <Team> · <Sprint>` dynamic title — this is a point-in-time snapshot, not a stable doc).

## ❓ Other open questions

- **Acceptance criteria field.** Confirm which custom field holds AC in this Jira (we already handle some custom fields env-aware).
- **Description rendering.** Jira descriptions are ADF — do we render them as markdown in Confluence (we have a converter for the storage format) or paste a Jira link and let Confluence smart-link?
- **Items with status ≠ Done at sprint close.** Include them under a "Carried Over" subsection of "Items Delivered", or omit (rollover is already in the Sprint Summary numbers)?
- **Bugs / sub-tasks.** Same treatment as stories, or grouped separately at the bottom?
- **Page title stability.** Per-sprint reports are point-in-time — keep the dynamic `[YYYY-MM-DD] … by [email]` pattern (consistent with portfolio/team reports), not the stable doc-export titles.
- **Permissions.** Same scopes as Skill 06; no new ones needed.

## 🔗 Related

- Skill 06 — Team Sprint Analysis (last 6 sprints, trend-focused) — this new skill is the deep-dive sibling.
- The `Milestones in Portfolio` idea — if it ships, "Key Deliverables" approach D becomes very natural.
