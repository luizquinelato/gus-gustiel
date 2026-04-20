# Skill 09 — Storage Inspection

> **Access:** Everyone (own sessions); Admins (all sessions) · **Action:** `inspect-storage` · **Resolver:** `storage-admin-resolver.js`

---

## What It Does

Lists or reads Forge Storage session data. Non-admins see only their own sessions. Admins see all sessions across all users.

Useful for debugging portfolio pipeline state, verifying which phase a session is in, and confirming sprint/LCT data was written correctly.

---

## Trigger Phrases

| Intent | Example phrases |
|---|---|
| List own sessions | *"Inspect my storage"*, *"What's in my storage?"*, *"Show my sessions"* |
| Read a specific key | *"Inspect storage key `export_session:…`"*, *"Inspect key `export_session:…`"* |
| Admin: list all | *"Inspect storage"* (admin) |
| Admin: read any key | *"Show storage key `<any-key>`"* |

---

## Session Format

Portfolio sessions are stored as:
```
export_session:<accountId>:<portfolioKey>
```

A session summary shows:
- Portfolio key
- Phase (`layers_1_4` = extraction done, LCT pending; `complete` = all steps done)
- Team count
- Whether sprint data is present
- Whether LCT (Lead/Cycle Time) data is present
- `cachedAt` timestamp (in `REPORT_TIMEZONE`)

> Sessions are never dumped as raw JSON. Always displayed as a human-readable summary.

---

## Phase Guide

| `phase` | What it means | What to do next |
|---|---|---|
| `layers_1_4` | Extraction done; LCT not yet run | Run `calculate-lead-time-data` (Step 2) |
| `complete` | All steps done; ready for export | Export or analyze — or refresh if data is stale |
| *(missing)* | No session found for this key | Run `prepare-portfolio-export` (Step 1) |

---

## Admin Capabilities

Admins calling `inspect-storage` with no key see **all storage keys** across the entire app — including other users' sessions and the admin registry. They can read any key.

Non-admins are restricted by prefix: only keys starting with `export_session:<their-accountId>:` are accessible.

---

## See Also

- `docs/skills/08-session-cache.md` → clearing sessions
- `docs/skills/10-account-id.md` → finding your accountId (needed to read specific keys)
- `docs/skills/admin.md` → admin-level storage operations
- `docs/skills/04-05-portfolio.md` → how sessions are built
- `src/resolvers/storage-admin-resolver.js`
