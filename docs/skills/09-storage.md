# Skill 09 — Storage Inspection

## 📋 User Guide

### What It Does

Shows your cached portfolio session data — which portfolio keys have been extracted, what phase they are in, and when they were last updated. Useful for checking the state of a session before deciding whether to re-run the pipeline.

Admins see all sessions across all users.

### How to Trigger It

| Intent | Example phrases |
|---|---|
| List own sessions | *"Inspect my storage"*, *"What's in my storage?"*, *"Show my sessions"* |
| Read a specific key | *"Inspect storage key `export_session:…`"* |
| Admin: list all | *"Inspect storage"* (admin) |

### What You'll See

For each session:
- Portfolio key
- Phase: `layers_1_4` (extraction done, Lead / Cycle Time pending) or `complete` (all steps done)
- Team count, sprint data present, Lead / Cycle Time data present
- When the session was last updated

Sessions are always shown as a human-readable summary — never raw JSON.

### Phase Guide

| Phase | Meaning | Next step |
|---|---|---|
| `layers_1_4` | Extraction done; Lead/Cycle Time not yet run | Run `calculate-lead-time-data` (Step 2) |
| `complete` | All steps done; ready for export | Export, analyze, or refresh if data is stale |
| *(missing)* | No session found | Run `prepare-portfolio-export` (Step 1) |

## 🔧 Technical Reference

> **Action:** `inspect-storage` · **Resolver:** `storage-admin-resolver.js`

### How It Works

Non-admins: filtered to keys starting with `export_session:<accountId>:`.
Admins: access to all keys including other users' sessions and the admin registry.

The `phase` field drives the ETL state machine — see `docs/architecture.md` → Storage Architecture section.

### See Also

- `docs/skills/08-session-cache.md` → clearing sessions
- `docs/skills/10-account-id.md` → finding your accountId
- `docs/skills/admin.md` → admin-level storage operations
- `src/resolvers/storage-admin-resolver.js`
