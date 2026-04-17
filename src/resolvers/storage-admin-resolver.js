/**
 * Storage Admin Resolver
 *
 * Hidden maintenance + admin-management skills:
 *
 *   inspectStorage     — lists all storage keys or reads a specific key (admin only).
 *   wipeGlobalStorage  — deletes ALL session entries for ALL users (admin only). Admin registry preserved.
 *   wipeUserStorage    — deletes the requesting user's own session entries (any user).
 *   addAdmin           — adds an accountId to the dynamic admin registry (super-admin only).
 *   removeAdmin        — removes a single accountId from the admin registry (any admin).
 *   deleteAllAdmins    — clears the entire admin registry (any admin).
 *   listAdmins         — lists all current admins with name + email (any admin).
 *
 * Registry format: [{ accountId, displayName, emailAddress }, ...]
 * Backward-compatible: legacy string entries are normalized on read.
 *
 * Authorization model:
 *   • SUPER_ADMIN_ACCOUNT_ID — hardcoded, immutable root of trust. Never in dynamic registry.
 *   • Dynamic registry       — stored at ADMIN_REGISTRY_KEY; managed by admins.
 *   • isAdmin()              — true if accountId === SUPER_ADMIN or is in registry.
 */

import api, { route, storage, startsWith } from '@forge/api';
import { SUPER_ADMIN_ACCOUNT_ID, ADMIN_REGISTRY_KEY } from '../config/constants.js';

// ── User identity ─────────────────────────────────────────────────────────────

/**
 * Resolve the current user's accountId.
 * Tries event.context first (available in some Forge module types),
 * then falls back to the Jira /myself API (always reliable in Rovo actions).
 */
async function getCurrentAccountId(event) {
    const fromContext = event?.context?.accountId || null;
    if (fromContext) return fromContext;
    try {
        const response = await api.asUser().requestJira(route`/rest/api/3/myself`, {
            headers: { Accept: 'application/json' },
        });
        const data = await response.json();
        return data.accountId || null;
    } catch (_) {
        return null;
    }
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

const isSuperAdmin = (accountId) => accountId === SUPER_ADMIN_ACCOUNT_ID;

/**
 * Normalize a raw registry entry to { accountId, displayName, emailAddress }.
 * Handles legacy format where entries were stored as plain accountId strings.
 */
function normalizeEntry(entry) {
    if (typeof entry === 'string') return { accountId: entry, displayName: null, emailAddress: null };
    return entry;
}

/** Returns the registry as an array of normalized { accountId, displayName, emailAddress } objects. */
async function getAdminRegistry() {
    const raw = (await storage.get(ADMIN_REGISTRY_KEY)) || [];
    return raw.map(normalizeEntry);
}

async function isAdmin(accountId) {
    if (isSuperAdmin(accountId)) return true;
    const registry = await getAdminRegistry();
    return registry.some(entry => entry.accountId === accountId);
}

/** Fetch a Jira user's display name and email by accountId. Returns partial data on failure. */
async function fetchUserProfile(accountId) {
    try {
        const resp = await api.asUser().requestJira(route`/rest/api/3/user?accountId=${accountId}`, {
            headers: { Accept: 'application/json' },
        });
        const data = await resp.json();
        return {
            accountId,
            displayName:  data.displayName  || null,
            emailAddress: data.emailAddress  || null,
        };
    } catch (_) {
        return { accountId, displayName: null, emailAddress: null };
    }
}

// ── Storage helpers ───────────────────────────────────────────────────────────

async function deleteAllMatchingKeys(prefix, excludeKeys = []) {
    let deleted = 0;
    let cursor  = undefined;
    do {
        let q = storage.query().limit(20);
        if (prefix) q = q.where('key', startsWith(prefix));
        if (cursor)  q = q.cursor(cursor);
        const result = await q.getMany();
        const toDelete = result.results
            .map(({ key }) => key)
            .filter(key => !excludeKeys.includes(key));
        await Promise.all(toDelete.map(key => storage.delete(key)));
        deleted += toDelete.length;
        cursor = result.nextCursor;
    } while (cursor);
    return deleted;
}

// ── Storage inspector helper ──────────────────────────────────────────────────

function summarizeStorageValue(key, value) {
    if (key === ADMIN_REGISTRY_KEY) {
        const entries = Array.isArray(value) ? value : [];
        return `🔑 **Admin registry** — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}\n` +
            (entries.length === 0 ? '_Empty_' :
                entries.map(e => `- \`${e.accountId}\` — ${e.displayName || '(no name)'} — ${e.emailAddress || '(no email)'}`).join('\n'));
    }

    if (key.startsWith('export_session:')) {
        const portfolioKey = key.split(':')[2] || '?';
        const lines = [`📦 **Session: ${portfolioKey}**`];

        if (value.allTeams)            lines.push(`- **Teams (${value.allTeams.length}):** ${value.allTeams.join(', ')}`);
        if (value.portfolioKey)        lines.push(`- **Portfolio key:** ${value.portfolioKey}`);
        if (value.newestSprintIdByTeam) lines.push(`- **Board/sprint index:** ${Object.keys(value.newestSprintIdByTeam).length} team(s)`);

        if (value.sprintsByTeam) {
            const st = Object.entries(value.sprintsByTeam);
            lines.push(`- **Sprint data:** ${st.length} teams`);
            st.forEach(([t, d]) => lines.push(
                d.error ? `  - ${t}: ⚠️ ${d.error}`
                        : `  - ${t}: ${d.boardName || '?'} · ${d.sprints?.length ?? 0} sprint(s)`
            ));
        } else if (value.sprintTeamIndex !== undefined) {
            lines.push(`- **Sprint data:** ⏳ In progress (${value.sprintTeamIndex} teams done)`);
        } else {
            lines.push(`- **Sprint data:** not yet collected`);
        }

        if (value.leadTimeByTeam)      lines.push(`- **Lead time data:** ${Object.keys(value.leadTimeByTeam).length} teams`);
        if (value.sprintAcc)           lines.push(`- **Sprint accumulator (partial):** ${Object.keys(value.sprintAcc).length} teams buffered`);

        return lines.join('\n');
    }

    // Generic fallback — truncated preview
    const json    = JSON.stringify(value, null, 2);
    const preview = json.length > 400 ? json.substring(0, 400) + '\n…(truncated)' : json;
    return `🔍 \`${key}\`\n\`\`\`json\n${preview}\n\`\`\``;
}

// ── Resolvers ─────────────────────────────────────────────────────────────────

export const inspectStorage = async (event) => {
    const accountId = await getCurrentAccountId(event);
    const key       = (event?.payload?.key || event?.key || '').trim();

    if (!accountId || !(await isAdmin(accountId))) {
        return { status: 'ERROR', message: '🚫 **Access denied.** This action is restricted to Gustiel administrators.' };
    }

    try {
        // Read a specific key
        if (key) {
            const value = await storage.get(key);
            if (value === undefined || value === null) {
                return { status: 'NOT_FOUND', message: `🔍 Key \`${key}\` does not exist in storage.` };
            }
            return { status: 'SUCCESS', key, message: summarizeStorageValue(key, value) };
        }

        // List all keys
        const keys   = [];
        let cursor   = undefined;
        do {
            let q = storage.query().limit(20);
            if (cursor) q = q.cursor(cursor);
            const result = await q.getMany();
            keys.push(...result.results.map(r => r.key));
            cursor = result.nextCursor;
        } while (cursor);

        if (keys.length === 0) {
            return { status: 'SUCCESS', message: '📭 Storage is empty — no keys found.' };
        }

        const lines = keys.map(k => `- \`${k}\``);
        return {
            status:  'SUCCESS',
            count:   keys.length,
            message: `🗄️ **Storage keys (${keys.length}):**\n${lines.join('\n')}\n\n_Tip: ask me to "inspect storage key \`<key>\`" to see its contents._`,
        };
    } catch (err) {
        return { status: 'ERROR', message: `Storage inspection failed: ${err.message}` };
    }
};

export const wipeGlobalStorage = async (event) => {
    const confirm   = (event?.payload?.confirm || event?.confirm || '').trim().toUpperCase();
    const accountId = await getCurrentAccountId(event);

    if (confirm !== 'YES') return { status: 'ERROR', message: '⚠️ Global wipe requires `confirm = "YES"`.' };
    if (!accountId || !(await isAdmin(accountId))) {
        return { status: 'ERROR', message: '🚫 **Access denied.** This action is restricted to Gustiel administrators.' };
    }

    try {
        const deleted = await deleteAllMatchingKeys(null, [ADMIN_REGISTRY_KEY]);
        return { status: 'SUCCESS', deleted, message: `🗑️ **Global storage wiped.** ${deleted} entr${deleted === 1 ? 'y' : 'ies'} deleted across all users. Admin registry preserved.` };
    } catch (err) {
        return { status: 'ERROR', message: `Storage wipe failed: ${err.message}` };
    }
};

export const wipeUserStorage = async (event) => {
    const confirm   = (event?.payload?.confirm || event?.confirm || '').trim().toUpperCase();
    const accountId = (await getCurrentAccountId(event)) || 'shared';

    if (confirm !== 'YES') return { status: 'ERROR', message: '⚠️ Please confirm with `confirm = "YES"` and try again.' };

    try {
        const deleted = await deleteAllMatchingKeys(`export_session:${accountId}:`);
        return { status: 'SUCCESS', deleted, message: `🗑️ **Your storage has been cleared.** ${deleted} session entr${deleted === 1 ? 'y' : 'ies'} deleted.${deleted === 0 ? ' (Nothing to clear — no cached sessions found.)' : ''}` };
    } catch (err) {
        return { status: 'ERROR', message: `Storage wipe failed: ${err.message}` };
    }
};

export const addAdmin = async (event) => {
    const accountId  = await getCurrentAccountId(event);
    const newAdminId = (event?.payload?.adminAccountId || event?.adminAccountId || '').trim();

    if (!accountId || !isSuperAdmin(accountId)) {
        return { status: 'ERROR', message: '🚫 **Access denied.** Only the super-admin can add admins.' };
    }
    if (!newAdminId) return { status: 'ERROR', message: '⚠️ Please provide `adminAccountId`.' };
    if (isSuperAdmin(newAdminId)) return { status: 'ERROR', message: '⚠️ The super-admin is always an admin — no need to add.' };

    const registry = await getAdminRegistry();
    if (registry.some(e => e.accountId === newAdminId)) {
        return { status: 'ERROR', message: `⚠️ \`${newAdminId}\` is already in the admin registry.` };
    }

    const profile = await fetchUserProfile(newAdminId);
    registry.push(profile);
    await storage.set(ADMIN_REGISTRY_KEY, registry);

    const label = profile.displayName || profile.emailAddress || newAdminId;
    return { status: 'SUCCESS', message: `✅ **Admin added.** ${label} (\`${newAdminId}\`) now has admin access. Total admins: ${registry.length}.` };
};

export const removeAdmin = async (event) => {
    const accountId     = await getCurrentAccountId(event);
    const targetAdminId = (event?.payload?.adminAccountId || event?.adminAccountId || '').trim();

    if (!accountId || !(await isAdmin(accountId))) {
        return { status: 'ERROR', message: '🚫 **Access denied.** Only admins can remove admins.' };
    }
    if (!targetAdminId) return { status: 'ERROR', message: '⚠️ Please provide `adminAccountId`.' };
    if (isSuperAdmin(targetAdminId)) return { status: 'ERROR', message: '⚠️ The super-admin cannot be removed.' };

    const registry = await getAdminRegistry();
    const updated  = registry.filter(e => e.accountId !== targetAdminId);
    if (updated.length === registry.length) {
        return { status: 'ERROR', message: `⚠️ \`${targetAdminId}\` was not found in the admin registry.` };
    }

    await storage.set(ADMIN_REGISTRY_KEY, updated);
    return { status: 'SUCCESS', message: `✅ **Admin removed.** \`${targetAdminId}\` no longer has admin access. Total admins: ${updated.length}.` };
};

export const deleteAllAdmins = async (event) => {
    const accountId = await getCurrentAccountId(event);
    const confirm   = (event?.payload?.confirm || event?.confirm || '').trim().toUpperCase();

    if (!accountId || !(await isAdmin(accountId))) {
        return { status: 'ERROR', message: '🚫 **Access denied.** Only admins can clear the admin registry.' };
    }
    if (confirm !== 'YES') return { status: 'ERROR', message: '⚠️ Please confirm with `confirm = "YES"`.' };

    await storage.set(ADMIN_REGISTRY_KEY, []);
    return { status: 'SUCCESS', message: '🗑️ **Admin registry cleared.** All dynamic admins removed. Super-admin is unaffected.' };
};

export const getMyAccountId = async (event) => {
    const fromContext = event?.context?.accountId || null;
    const fromApi     = await getCurrentAccountId(event);
    const isSuperAdminResult = fromApi ? isSuperAdmin(fromApi) : false;
    return {
        status:    'SUCCESS',
        accountId: fromApi,
        message: [
            `🔍 **Forge runtime identity**`,
            `- \`event.context.accountId\`: \`${fromContext ?? 'null'}\``,
            `- Jira API (\`/myself\`): \`${fromApi ?? 'null — API call failed'}\``,
            `- Is super-admin: **${isSuperAdminResult ? 'YES ✅' : 'NO ❌'}**`,
        ].join('\n'),
    };
};

export const listAdmins = async (event) => {
    const accountId = await getCurrentAccountId(event);

    if (!accountId || !(await isAdmin(accountId))) {
        return { status: 'ERROR', message: '🚫 **Access denied.** Only admins can list admins.' };
    }

    const [superAdminProfile, registry] = await Promise.all([
        fetchUserProfile(SUPER_ADMIN_ACCOUNT_ID),
        getAdminRegistry(),
    ]);

    const formatEntry = (e) => {
        const name  = e.displayName  || '_(no name)_';
        const email = e.emailAddress || '_(no email)_';
        return `- **${name}** — ${email} — \`${e.accountId}\``;
    };

    const lines = [
        `👑 **Super-admin (immutable):** ${formatEntry(superAdminProfile)}`,
        '',
        registry.length === 0
            ? '_No additional admins in the dynamic registry._'
            : `**Dynamic admins (${registry.length}):**\n${registry.map(formatEntry).join('\n')}`,
    ];
    return { status: 'SUCCESS', message: lines.join('\n') };
};
