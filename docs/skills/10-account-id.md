# Skill 10 — My Account ID

> **Access:** Everyone · **Action:** `get-my-account-id` · **Resolver:** `storage-admin-resolver.js`

---

## What It Does

Returns the Atlassian `accountId` that the Forge runtime recognises for the currently logged-in user, plus whether that user holds super-admin status.

---

## Trigger Phrases

- *"What is my account ID?"*, *"Show my account ID"*, *"What accountId does Forge see for me?"*

---

## When to Use

The primary use case is **before requesting admin access**. An admin needs your `accountId` to add you to the Gustiel admin registry via the `add-admin` action. Without this skill, there is no easy way to discover your own ID from within Rovo.

Secondary use: when reading or wiping a specific storage key (e.g. `inspect-storage` with an explicit key), you need your `accountId` to construct the key path `export_session:<accountId>:<portfolioKey>`.

---

## Technical Notes

- Requires `confirm = "YES"` (the LLM passes this automatically — no user action needed).
- The `accountId` is read from the Forge execution context (`context.accountId`), not from a Jira API call.
- Super-admin status is checked against the static super-admin ID in `src/config/constants.js`, not the dynamic admin registry.

---

## See Also

- `docs/skills/admin.md` → how to use your accountId to grant or request admin access
- `docs/skills/09-storage.md` → constructing storage key paths
- `src/resolvers/storage-admin-resolver.js`
