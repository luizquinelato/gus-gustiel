# Skill 08 — Clear My Session Cache

> **Access:** Everyone (own data only) · **Action:** `wipe-user-storage` · **Resolver:** `storage-admin-resolver.js`

---

## What It Does

Deletes **your own** cached portfolio session data from Forge Storage. Forces fresh extraction on your next portfolio export or chat analysis. Other users are completely unaffected.

---

## Trigger Phrases

- *"Clear my cache"*, *"Wipe my sessions"*, *"Reset my storage"*, *"Clear my data"*

---

## When to Use

| Situation | Action |
|---|---|
| Jira data has changed significantly since the last extraction | Clear cache → re-run the portfolio pipeline |
| Session shows `layers_1_4` phase but you want a full fresh start | Clear cache |
| Portfolio export showed stale or incorrect team/sprint data | Clear cache → re-run all three ETL steps |
| You ran a test extraction and want to discard it | Clear cache |

> 💡 Stale cache is the most common cause of "Sprint data not available" errors in portfolio exports. When in doubt, clear and re-run.

---

## How Sessions Are Stored

Each ETL pipeline run writes one Forge Storage entry per portfolio key:

```
export_session:<accountId>:<portfolioKey>
```

`wipe-user-storage` deletes **all keys** matching `export_session:<your-accountId>:*`. If you want to clear only a specific key, use Skill 09 (Storage Inspection) to identify it first — or ask an admin.

---

## Technical Notes

- Requires `confirm = "YES"` (the LLM passes this automatically — no user action needed).
- Uses `startsWith` prefix filtering on `export_session:<accountId>:` as the security boundary — non-admins cannot reach other users' keys.
- Admins wiping ALL storage use a different action: `wipe-global-storage` (Admin skill).

---

## See Also

- `docs/skills/09-storage.md` → inspect session state before clearing
- `docs/skills/04-05-portfolio.md` → how sessions are built and when they expire
- `src/resolvers/storage-admin-resolver.js`
