# Admin Skills

> **Access:** Admin-only (except where noted) · **Resolver:** `storage-admin-resolver.js`

Admin skills are restricted to users in the Gustiel admin registry, or to the designated super-admin. Non-admins receive an access-denied error.

Use **Skill 10** (`get-my-account-id`) to find your `accountId`, then ask a current admin to grant you access.

---

## Admin Registry

Gustiel maintains a **dynamic admin registry** in Forge Storage alongside a **static super-admin** ID hardcoded in `src/config/constants.js`. The super-admin cannot be removed; dynamic admins can be added and removed at runtime.

---

## Admin Actions

### 🔍 Inspect All Storage *(extends Skill 09)*

Admins calling `inspect-storage` with no key see **all** storage keys across all users.

- *"Inspect storage"* → lists every key in the app
- *"Show storage key `<any-key>`"* → reads any key, including other users' sessions

→ Action: `inspect-storage` (no key param) · See also: `docs/skills/09-storage.md`

---

### 🗑️ Wipe All Storage

Deletes ALL cached session data for ALL users. Irreversible. Use with caution.

- *"Wipe all storage"*, *"Clear all sessions"*, *"Reset all user caches"*, *"Nuke storage"*

→ Action: `wipe-global-storage` with `confirm = "YES"`

---

### 👥 List Admins

Lists the super-admin and all dynamic admins (display name + email).

- *"List admins"*, *"Who are the admins?"*, *"Show admin registry"*

→ Action: `list-admins` with `confirm = "YES"` · **READ-ONLY — never triggers destructive actions.**

---

### ➕ Add Admin *(Super-admin only)*

Grants admin access to a user by their Atlassian `accountId`. The user must provide their ID first via Skill 10.

- *"Add admin"*, *"Grant admin access to [accountId]"*, *"Make [X] an admin"*

→ Action: `add-admin` with `adminAccountId = "<the accountId>"`

---

### ➖ Remove Admin

Removes a dynamic admin from the registry. Cannot remove the super-admin.

- *"Remove admin"*, *"Revoke admin access from [accountId]"*, *"Remove [X] as admin"*

→ Action: `remove-admin` with `adminAccountId = "<the accountId>"`

---

### 🗑️ Clear Admin Registry

Resets the entire dynamic admin registry to empty. Super-admin is unaffected. Only trigger for explicit clear/reset requests — never for read-only intents like "list" or "show".

- *"Clear the admin registry"*, *"Reset the admin registry"*

→ Action: `clear-admin-registry` with `confirm = "YES"`

---

## Technical Notes

- The admin check runs at the top of every restricted action in `storage-admin-resolver.js`.
- Security boundary for non-admins: `startsWith('export_session:<accountId>:')` prefix check.
- Dynamic admin list is stored in Forge Storage as a dedicated registry key (separate from portfolio sessions).

---

## See Also

- `docs/skills/09-storage.md` → storage inspection (all users + admin extension)
- `docs/skills/10-account-id.md` → how to find your accountId before requesting access
- `src/resolvers/storage-admin-resolver.js`
- `src/config/constants.js` → super-admin ID
