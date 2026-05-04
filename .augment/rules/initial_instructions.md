---
type: "manual"
---

# Agent Rules — Gustiel (The Portfolio Sentinel)

Rules the agent must follow in every session for this project.

---

## Deployment Rule

When asked to deploy, **always deploy to dev** by running:

```powershell
.\deploy.ps1
```

No arguments. Never use `--prod` or `--all` unless explicitly instructed by the user.

---

## Versioning Rule

The app version is defined in `src/config/constants.js` as `export const VERSION = "X.Y.Z"`.

Use **Semantic Versioning (MAJOR.MINOR.PATCH)**:

| Part | When to increment | Examples |
|------|------------------|---------|
| `PATCH` (last) | Bug fixes, typo corrections, minor prompt tweaks | `1.0.0` → `1.0.1` |
| `MINOR` (middle) | New features of small or medium size (new action, new skill, new field) | `1.0.1` → `1.1.0` |
| `MAJOR` (first) | Big architectural changes, major new capability, breaking refactor | `1.1.0` → `2.0.0` |

**Rules:**
- Always update the version in `src/config/constants.js` when delivering a code change.
- When incrementing `MINOR`, reset `PATCH` to `0`.
- When incrementing `MAJOR`, reset `MINOR` and `PATCH` to `0`.
- Never update the version without also deploying or explicitly noting the bump in the response.

---

## Release Notes Lifecycle Rule

Documentation is split into two layers with **different update cadences**:

| Layer | Files | Reflects | Updated when |
|---|---|---|---|
| **Baseline** | User Guide (`docs/skills/*.md`) + Architecture Guide (`docs/architecture.md`) | Always the **current state** of Gustiel | Whenever a skill or architectural detail actually changes |
| **Release Notes** | `docs/releases/MAJOR.MINOR.md` | Historical **delta** between consecutive MINOR/MAJOR versions | Only at MINOR/MAJOR consolidation — never per PATCH |

### Pre-release scratchpad (PATCH cycle)

- `docs/pre-release/NEXT.md` is a single optional free-form scratchpad for context worth preserving across the PATCH cycle (rationale, dead-ends, Forge limits hit). **Not bundled, not exported, never shown to users.**
- For routine PATCH bumps (bug fixes, typo, prompt tweak) **nothing needs to be written** — the commit history and code state are enough.

### Consolidation (MINOR / MAJOR bump)

When the user asks to consolidate a release (e.g. "consolidate 4.54", "ship 5.0"), I:
1. Synthesize a new file `docs/releases/MAJOR.MINOR.md` describing the delta from the previous MINOR/MAJOR to current HEAD. Sources: `git log`, `git diff`, `NEXT.md`, and current code state. **Deduplicate intermediate iterations — describe only the final state.**
2. Update the **Baseline** (User Guide + Architecture Guide) for any skill/architecture that changed.
3. Bump `VERSION` in `src/config/constants.js` (MINOR/MAJOR rules above).
4. Reset `docs/pre-release/NEXT.md` to empty.

PATCH bumps **never** create a release file. Critical PATCH fixes (e.g. 4.54.1) are not retroactively edited into the existing 4.54 release page; they only resurface as a "Fixed since 4.54.0" line in the next MINOR's release note when relevant.

### Release file format

```markdown
---
version: 4.54
date: 2026-04-30
title: Release Notes Feature
---

## 📣 What's New
(user-facing description)

## 🔧 Technical Changes
(architecture/internal — optional; omit if none)
```

- File name is **`MAJOR.MINOR.md`** (no PATCH digit — e.g. `4.54.md`, `5.0.md`).
- `version` field matches the file name.
- `date` is the consolidation date (YYYY-MM-DD).

---

## Documentation Title Stability Rule

**Documentation pages** (User Guide, Architecture Guide, Release Notes root, Major bucket pages, per-Release pages, Ideas Backlog root, per-Idea pages) MUST use **stable Confluence titles** — no date, no user email, no run-specific suffix. This is what allows re-running the export to **replace the existing page tree in place** instead of creating duplicates.

| Page kind | Stable title pattern | Body |
|---|---|---|
| User Guide | `📖 Gustiel User Guide` | Full content |
| Architecture Guide | `🏗️ Gustiel Architecture Guide` | Full content |
| Release Notes root | `📣 Gustiel Release Notes` | Organizer (no per-release listing) |
| Major bucket | `v4`, `v5`, `v6` … | Organizer (no per-release listing) |
| Per-release page | `v4.54 — <title from front-matter>` | Full content |
| Ideas Backlog root | `💡 Gustiel Ideas Backlog` | Organizer (short intro only) |
| Per-idea page | `<title from front-matter>` | Full content |

**Release Notes are append-only** — the root and major-bucket pages are deliberately content-less organizers (Confluence's native page tree handles navigation). Deleting a release file from `docs/releases/` and re-exporting will **not** remove the corresponding Confluence page; the orphan stays under its `vX` bucket. This is intentional: the export is purely additive, never destructive. Manual cleanup in Confluence is required if you actually want a release page gone.

**Portfolio reports and team reports** (`export-to-confluence`, `export-team-sprint`, `export-team-lead-time`) keep their existing `[YYYY-MM-DD] … by [email]` titles — they are point-in-time snapshots, not living documents.

---

## Ideas Backlog Lifecycle Rule

The Ideas Backlog is the **only** documentation export that uses **destructive sync**. It mirrors `docs/ideas/*.md` exactly into Confluence.

| Action in `docs/ideas/` | Effect of next `export-ideas-backlog` |
|---|---|
| Add `<idea>.md` | Confluence page created under `💡 Gustiel Ideas Backlog`. |
| Edit body / front-matter (title unchanged) | Confluence page upserted in place. |
| **Rename** the `title:` in front-matter | Old-title page is **deleted** (orphan), new-title page is created. |
| **Delete** the `.md` file | Confluence page is **deleted**. |

### Hard guarantees

- **Scoped deletion.** `ideas-backlog-resolver.js` lists only the **immediate children** of the `💡 Gustiel Ideas Backlog` root and deletes only those whose title doesn't match a current idea file. Nothing outside that one parent is ever touched. Never widen this scope to the whole space.
- **Comments are lost on delete.** Confluence comments live on the page; deleting the page deletes its comments. Idea feedback must therefore be collected via chat / talk, **not** Confluence comments. Document this in any user-facing change to the feature.
- **Idea files live in `docs/ideas/`** — front-matter (`title`, optional `status`, `created`) plus a freeform markdown body. Bundled into `IDEAS` by `scripts/bundle-docs.mjs`.
- **Required scope:** `delete:page:confluence` in `manifest.yml`. Used only by `deleteConfluencePage` in `confluence-api-service.js`, which is in turn called only by `ideas-backlog-resolver.js`.

### When NOT to copy this pattern

Release Notes, User Guide, and Architecture Guide are explicitly **not** allowed to use destructive sync — historical and current-state docs must survive a missing/renamed source file, since the source of truth there is the consolidated repo, not the Confluence tree. Only the Ideas Backlog (where the local folder is the canonical "what's still being considered" list) gets destructive behaviour.

---

## ETL Architecture Rule

The codebase follows a strict **ETL (Extract → Transform → Load)** pattern.
Full details are in `docs/architecture.md`. This rule summarises what the agent must enforce.

### Layer ownership — never cross these boundaries

| Layer | Folder | Rule |
|---|---|---|
| **Extract** | `src/extractors/` | Maps raw Jira JSON → domain objects. No I/O beyond receiving raw data. |
| **Transform** | `src/transformers/` | Pure calculations and data shaping only. No I/O, no Markdown, no rendering. |
| **Load** | `src/formatters/` | Converts domain data → Markdown output. No I/O, no calculation. |
| **Orchestrate** | `src/resolvers/` | Entry/exit only. Calls Extract → Transform → Load. Contains **no business logic**. |
| **I/O** | `src/services/` | The only layer allowed to call the Jira API. |
| **Config** | `src/config/constants.js` | Workflow dicts, field IDs, version. No logic. |

### Rules for every new feature

1. **New data from Jira** → add a function to `src/extractors/`.
2. **New calculation or grouping** → add a function to `src/transformers/`.
3. **New output section or table** → add a function to `src/formatters/`.
4. **New Rovo action** → add a thin resolver in `src/resolvers/` that calls the three layers. No logic inside the resolver.
5. **New workflow status** → edit `src/config/constants.js` only. No resolver changes needed.
6. **Never duplicate logic** — if a second resolver needs the same extraction, transformation, or formatting function, it imports from the existing layer file. Do not copy-paste.
7. **All extractor, transformer, and formatter functions must be pure** (stateless, no side effects) so they are safe under any concurrency level and fully testable in isolation.

---

## Portfolio-as-Master-Layer Rule

**The portfolio is the highest consolidating layer.** Every individual skill (sprint analysis, lead/cycle time, throughput) must be implementable both as a standalone capability AND as a building block consumed by the portfolio layer. This is not optional — it is the reason the ETL architecture exists.

### What this means in practice

- **Individual skills are real, standalone features.** A user can call "sprint analysis for Team X" without any portfolio context. The resolver works end-to-end on its own.
- **The portfolio layer reuses those same functions.** When the portfolio pipeline needs sprint data for all teams, it calls the exact same underlying extractor/transformer functions that power the individual sprint skill. There is never a separate implementation for "portfolio sprint" vs "individual sprint".
- **New capabilities follow this order:** first build the individual skill correctly within ETL layers; then wire it into the portfolio resolver. Never build a portfolio-only capability that has no individual equivalent.
- **The portfolio resolver is the master consolidator** — it is the only place where data from multiple skills (LCT, sprint, hierarchy) is combined into a single report. No other resolver does cross-skill aggregation.

### The hierarchy

```
Portfolio Report (master layer)
  ├─ LCT / Innovation Velocity  ← lead-time-resolver + portfolio-transformer
  ├─ Sprint Velocity per team   ← sprint-extractor (same functions as Team Sprint skill)
  └─ Hierarchy + RYG            ← jira-extractor + portfolio-transformer
        ↑
Individual Skills (building blocks)
  ├─ Team Sprint Analysis       → sprint-extractor.js
  └─ (future: cycle time, throughput, forecast → same ETL chain)
```

