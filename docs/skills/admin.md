# Admin Skills

## 📋 User Guide

### What Are Admin Skills?

Admin skills give trusted users additional control over Gustiel — such as viewing all cached sessions, clearing all data, and managing who has admin access. These skills are restricted to users in the Gustiel admin registry.

To become an admin: ask *"What is my account ID?"* to find your account ID, then ask a current admin to add you.

### Admin Actions

**🔍 Inspect All Storage** — see every session across all users
- *"Inspect storage"* → lists all keys · *"Show storage key `<any-key>`"* → reads any key

**🗑️ Wipe All Storage** — deletes ALL cached sessions for ALL users (irreversible)
- *"Wipe all storage"*, *"Clear all sessions"*, *"Nuke storage"*

**👥 List Admins** — shows who currently has admin access
- *"List admins"*, *"Who are the admins?"*, *"Show admin registry"*
- The caller's own row always shows their email (looked up via `/myself`); other admins may show `(no email)` if their Atlassian profile-level email visibility is set to *Only you* / *Atlassian only*.

**➕ Add Admin** *(super-admin only)* — grant access by `accountId`
- *"Add admin"*, *"Grant admin access to [accountId]"*, *"Make [X] an admin"*

**➖ Remove Admin** — remove a dynamic admin (cannot remove the super-admin)
- *"Remove admin"*, *"Revoke admin access from [accountId]"*

**🗑️ Clear Admin Registry** — reset the dynamic admin list to empty
- *"Clear the admin registry"*, *"Reset the admin registry"*

## 🔧 Technical Reference

> **Resolver:** `storage-admin-resolver.js`

### Two-Tier Access Model

Gustiel uses a static super-admin (`SUPER_ADMIN_ACCOUNT_ID` in `src/config/constants.js`) and a dynamic admin registry stored as a dedicated Forge Storage key. The super-admin cannot be removed. Dynamic admins can be added and removed at runtime.

### Email lookup — `fetchUserProfile`

`fetchUserProfile(accountId, callerAccountId)` tries three paths in order:

0. **`asUser()` + `/rest/api/3/myself`** — used **only** when `accountId === callerAccountId`. Bypasses Atlassian's profile-level email privacy and reliably returns the caller's email even when their profile hides it from `/user?accountId=…`.
1. **`asApp()` + `/rest/api/3/user?accountId=…`** — works for any user via the app token. `emailAddress` may be omitted if the user's privacy settings hide it.
2. **`asUser()` + `/rest/api/3/user?accountId=…`** — fallback when the app token lacks visibility into the requested user's profile.

`listAdmins` passes the caller's `accountId` to both the super-admin lookup and the per-registry-entry re-enrichment, so each admin always sees their own email — but other admins' rows depend on those users' privacy settings.

### Security Boundary

Admin check runs at the top of every restricted action. Non-admins are restricted by prefix:
`startsWith('export_session:<accountId>:')` — they can only see their own sessions.

### Action Map

| Intent | Action | Required params |
|---|---|---|
| Inspect all | `inspect-storage` | no key |
| Wipe all sessions | `wipe-global-storage` | `confirm = "YES"` |
| List admins | `list-admins` | `confirm = "YES"` |
| Add admin | `add-admin` | `adminAccountId` |
| Remove admin | `remove-admin` | `adminAccountId` |
| Clear registry | `clear-admin-registry` | `confirm = "YES"` |

### See Also

- `docs/skills/09-storage.md` → storage inspection
- `docs/skills/10-account-id.md` → finding accountId
- `src/resolvers/storage-admin-resolver.js`
- `src/config/constants.js` → `SUPER_ADMIN_ACCOUNT_ID`
