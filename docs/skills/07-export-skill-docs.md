# Skill 07 — Export Skill Documentation

## 📋 User Guide

### What It Does

Exports a formatted Confluence page with the **Gustiel User Guide** — all skills, what they do, and how to trigger them. Ideal for onboarding teammates or creating a reference in Confluence.

A companion export, **Export Architecture Guide**, creates the developer-focused Technical Reference page.

### How to Trigger It

- *"Export skill documentation"*, *"Create a Gustiel user guide in Confluence"*
- *"Export Gustiel docs"*, *"Export the help to Confluence"*

### Interaction Steps

1. Gustiel asks which Confluence space to export to
2. Gustiel asks where to place the page (under a page path, inside a folder, or at space root)
3. The export runs and returns a link to the page

### What Gets Exported

The User Guide page contains:
- A DEV vs PROD orientation section (so users know which agent they're on)
- A User Guide section for every Gustiel skill
- Trigger phrases and usage descriptions in plain language

## 🔧 Technical Reference

> **Action:** `export-skill-docs` · **Resolver:** `skill-docs-resolver.js`

### How It Works

Content comes from the bundled `USER_GUIDE_MD` export in `src/docs/index.js`, generated at deploy time by `scripts/bundle-docs.mjs`. Each skill doc's `## 📋 User Guide` section is extracted and concatenated. The DEV/PROD preamble and environment metadata are prepended at runtime.

After the page is upserted, the resolver uploads any bundled screenshots as Confluence attachments (`uploadAttachment` in `confluence-api-service.js`), then re-PUTs the same page body so Confluence re-resolves the `<ri:attachment>` references with the now-present files.

### Key Patterns

- **Bundled screenshots**: `ATTACH:filename.png` in markdown → `<ac:image ac:align="center"><ri:attachment ri:filename="…"/></ac:image>` (centered)
- **Two-step upload flow**: upsert page → upload attachment → re-PUT page body (required; without the re-PUT Confluence shows "Preview unavailable" even after a successful upload)
- **Attachment scope**: `write:confluence-file` (classic Atlassian scope) is the correct scope for `uploadAttachment`. `write:attachment:confluence` (granular, v2-only) and `write:confluence-content` (page content) both fail with "scope does not match"
- **Upsert logic**: find by title → update in place → move + update → create (same as portfolio export)
- **No Jira ETL**: documentation-only. No session, no cache.

### See Also

- `scripts/bundle-docs.mjs` → how docs are bundled and screenshots are base64-encoded
- `src/resolvers/skill-docs-resolver.js`
- `src/services/confluence-api-service.js` → `uploadAttachment`
- `docs/architecture.md` → **Attachment Upload (Two-Step Flow)** subsection for the full auth decision table
