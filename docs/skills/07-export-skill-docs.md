# Skill 07 — Export Documentation (User Guide / Architecture Guide / Release Notes / Ideas Backlog)

## 📋 User Guide

### What It Does

Exports the Gustiel documentation set to Confluence. There are **four pages** with **stable titles**, so re-running the export upserts the existing pages in place — no duplicates, no date suffixes:

| Page | Stable title | What it contains |
|---|---|---|
| 📖 User Guide | `📖 Gustiel User Guide` | Every skill in business-friendly language, with a DEV vs PROD orientation section and bundled screenshots |
| 🏗️ Architecture Guide | `🏗️ Gustiel Architecture Guide` | Developer-focused — Technical Reference of every skill plus the full architecture document |
| 📣 Release Notes | `📣 Gustiel Release Notes` (root, organizer) → `v4`, `v5`, … (major buckets, organizers) → `vX.Y — <title>` (per release, full content) | Historical record of changes per `MAJOR.MINOR` release, sorted newest first. The root and bucket pages have no per-release listing — Confluence's native page tree handles navigation, and deleting a release file from the repo simply leaves an orphan page under its `vX` bucket (intentional — the export is **additive only**). |
| 💡 Ideas Backlog | `💡 Gustiel Ideas Backlog` (root, organizer) → one child page per idea, sorted alphabetically | Forward-looking proposals open for discussion. Uses **destructive sync** scoped to the immediate children of the root — deleting an idea file from the repo deletes its Confluence page on the next export. |

The User Guide and Architecture Guide always reflect the **current state** of Gustiel. The Release Notes are the **historical** record. The Ideas Backlog is the **forward-looking** record — proposals being explored, nothing committed.

### How to Trigger It

- All four: *"Export Gustiel docs"*, *"Export documents"*, *"Export everything"*, *"Export all"*
- User Guide only: *"Export skill documentation"*, *"Create a Gustiel user guide in Confluence"*, *"Export the help to Confluence"*
- Architecture Guide only: *"Export architecture guide"*, *"Export Gustiel technical reference"*
- Release Notes only: *"Export release notes"*, *"Export Gustiel release notes"*, *"Export the changelog"*
- Ideas Backlog only: *"Export ideas backlog"*, *"Export Gustiel ideas"*, *"Export the backlog"*

### Interaction Steps

1. Gustiel asks which Confluence space to export to
2. Gustiel asks where to place the pages (under a page path, inside a folder, or at space root)
3. The export runs and returns a link to each page (and, for the Ideas Backlog, the count of pages removed by destructive sync)

### What Gets Exported

- **User Guide** page — DEV/PROD orientation section, then a User Guide section for every skill
- **Architecture Guide** page — Technical Reference for every skill, then the full architecture doc
- **Release Notes** — three-tier hierarchy: root organizer → major bucket organizers (`v4`, `v5`) → per-release pages (`v4.54 — …`)
- **Ideas Backlog** — two-tier hierarchy: root organizer → one child per idea (alphabetical). Orphan children are deleted.

## 🔧 Technical Reference

> **Actions:** `export-skill-docs`, `export-architecture-guide`, `export-release-notes`, `export-ideas-backlog`
> **Resolvers:** `skill-docs-resolver.js`, `architecture-guide-resolver.js`, `release-notes-resolver.js`, `ideas-backlog-resolver.js`

### How It Works

Content comes from the bundled `USER_GUIDE_MD`, `TECH_REF_MD`, `RELEASES`, and `IDEAS` exports in `src/docs/index.js`, generated at deploy time by `scripts/bundle-docs.mjs`:

- `USER_GUIDE_MD` / `TECH_REF_MD` — concatenation of every skill doc's `## 📋 User Guide` / `## 🔧 Technical Reference` section
- `RELEASES` — array of `{ version, major, minor, date, title, whatsNew, techChanges }` parsed from `docs/releases/MAJOR.MINOR.md` files (front-matter + two H2 sections), sorted newest-first
- `IDEAS` — array of `{ title, status, created, body }` parsed from `docs/ideas/*.md` files (front-matter + freeform body), sorted alphabetically by title

The pre-release scratchpad `docs/pre-release/NEXT.md` is **never bundled** — it is dev-only context for the next consolidation.

After the User Guide page is upserted, the resolver uploads any bundled screenshots as Confluence attachments (`uploadAttachment` in `confluence-api-service.js`), then re-PUTs the same page body so Confluence re-resolves the `<ri:attachment>` references with the now-present files. `uploadAttachment` is idempotent — on re-runs it detects the existing attachment by filename and replaces it via the `/data` sub-endpoint instead of POSTing a duplicate (which would return HTTP 400).

### Key Patterns

- **Stable titles for docs** — User Guide / Architecture Guide / Release Notes / Ideas Backlog pages omit date and email suffixes so re-runs upsert in place. Portfolio and team reports keep their dynamic `[YYYY-MM-DD] … by [email]` titles.
- **Three-tier Release Notes** — `release-notes-resolver` upserts root → major-bucket → per-release pages in one call. Root and major buckets are **organizers** (no per-release listing in their body); only per-release pages carry content. Order is newest-first by `(major desc, minor desc)`. The export is **additive only** — deleting a release file leaves an orphan Confluence page that must be cleaned up manually if undesired.
- **Two-tier Ideas Backlog with destructive sync** — `ideas-backlog-resolver` lists the immediate children of the `💡 Gustiel Ideas Backlog` root, deletes any whose title doesn't match a current idea file, then upserts each idea page (alphabetical). Deletion is **strictly scoped** to immediate children of that one root — no other Confluence content is ever deleted. Trade-off: deleting a page also deletes its Confluence comments; idea feedback is therefore collected via chat / talk, not Confluence comments.
- **Bundled screenshots**: `ATTACH:filename.png` in markdown → `<ac:image ac:align="center"><ri:attachment ri:filename="…"/></ac:image>` (centered)
- **Two-step upload flow**: upsert page → upload attachment → re-PUT page body (required; without the re-PUT Confluence shows "Preview unavailable" even after a successful upload)
- **Idempotent attachment upsert**: `uploadAttachment` calls `findAttachmentByFilename` first; existing files go to `/child/attachment/{id}/data` (new version), missing files go to `/child/attachment` (create). Avoids the HTTP 400 duplicate-filename failure on re-deploys.
- **Attachment scope**: `write:confluence-file` (classic Atlassian scope) is the correct scope for `uploadAttachment`. `write:attachment:confluence` (granular, v2-only) does NOT cover the v1 attachment endpoint and fails with "scope does not match".
- **Deletion scope**: `delete:page:confluence` is required by `deleteConfluencePage` — used **only** by the Ideas Backlog resolver, and only against immediate children of the backlog root.
- **Upsert logic**: find by title at target → find by title elsewhere (move) → create stub + update (same pattern across all four doc resolvers and the portfolio export)
- **Error visibility**: per-screenshot upload outcomes are returned in `response.screenshots[]`; per-idea deletion outcomes are returned in `response.deleted[]`; any failures (and re-render errors) are appended to `response.message` as `⚠️` warning lines so they show up in Rovo chat.
- **No Jira ETL**: documentation-only. No session, no cache.

### See Also

- `scripts/bundle-docs.mjs` → how docs are bundled and screenshots are base64-encoded
- `src/resolvers/skill-docs-resolver.js`, `architecture-guide-resolver.js`, `release-notes-resolver.js`, `ideas-backlog-resolver.js`
- `src/services/confluence-api-service.js` → `uploadAttachment`, `findPageByTitle`, `updateConfluencePage`, `getPageChildren`, `deleteConfluencePage`
- `docs/architecture.md` → **Attachment Upload (Two-Step Flow)** subsection for the full auth decision table
- `docs/releases/` → per-`MAJOR.MINOR` release files in front-matter + two H2 sections format
- `docs/ideas/` → one `.md` per idea (front-matter + freeform body); deleted files are removed from Confluence on next export
