# Skill 10 — My Account ID

## 📋 User Guide

### What It Does

Returns your Atlassian account ID — the unique identifier the Forge runtime associates with your login. Also shows whether you hold super-admin status.

### How to Trigger It

- *"What is my account ID?"*, *"Show my account ID"*, *"What accountId does Forge see for me?"*

### When to Use It

- **Requesting admin access**: an existing admin needs your `accountId` to add you to the Gustiel admin registry.
- **Reading a specific storage key**: to construct the key `export_session:<accountId>:<portfolioKey>` for `inspect-storage`.

## 🔧 Technical Reference

> **Action:** `get-my-account-id` · **Resolver:** `storage-admin-resolver.js`

### Technical Notes

- Requires `confirm = "YES"` (the LLM passes this automatically).
- The `accountId` is read from the Forge execution context (`context.accountId`) — not from a Jira API call.
- Super-admin status is checked against `SUPER_ADMIN_ACCOUNT_ID` in `src/config/constants.js`, not the dynamic admin registry.

### See Also

- `docs/skills/admin.md` → how to use accountId to grant admin access
- `docs/skills/09-storage.md` → constructing storage key paths
- `src/resolvers/storage-admin-resolver.js`
