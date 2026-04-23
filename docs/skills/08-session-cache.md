# Skill 08 — Clear My Session Cache

## 📋 User Guide

### What It Does

Clears your own cached portfolio session data. This forces a fresh extraction the next time you run a portfolio report or analysis. Other users are not affected.

### How to Trigger It

- *"Clear my cache"*, *"Wipe my sessions"*, *"Reset my storage"*, *"Clear my data"*

### When to Use It

| Situation | What to do |
|---|---|
| Jira data changed since the last extraction | Clear cache, then re-run the portfolio pipeline |
| Portfolio export showed stale or incorrect data | Clear cache, then re-run all three ETL steps |
| You ran a test extraction and want to discard it | Clear cache |

> 💡 Stale cache is the most common cause of "Sprint data not available" in portfolio exports. When in doubt, clear and re-run.

## 🔧 Technical Reference

> **Action:** `wipe-user-storage` · **Resolver:** `storage-admin-resolver.js`

### How It Works

Deletes all Forge Storage keys matching `export_session:<your-accountId>:*`. Requires `confirm = "YES"` (the LLM passes this automatically).

The security boundary is enforced via `startsWith` prefix filtering — non-admins cannot reach other users' keys.

To wipe all storage for all users, admins use the separate `wipe-global-storage` action.

### See Also

- `docs/skills/09-storage.md` → inspect session state before clearing
- `docs/skills/04-05-portfolio.md` → how sessions are built
- `src/resolvers/storage-admin-resolver.js`
