/**
 * Storage Admin Resolver
 *
 * Hidden maintenance + admin-management skills:
 *
 *   inspectStorage     — lists/reads storage keys. Non-admins see only their own session keys;
 *                        admins see all keys.
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

import { storage, startsWith } from '@forge/api';
import { SUPER_ADMIN_ACCOUNT_ID, ADMIN_REGISTRY_KEY,
         SESSION_KEY_PREFIX }                         from '../config/constants.js';
import { getCurrentAccountId } from '../services/jira-api-service.js';

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

    if (key.startsWith(`${SESSION_KEY_PREFIX}:`)) {
        const portfolioKey = key.split(':')[2] || '?';
        const lines = [`📦 **Session: ${portfolioKey}**`];

        // Phase + timestamp
        if (value.phase)     lines.push(`- **Phase:** \`${value.phase}\``);
        if (value.timestamp) {
            const saved = new Date(value.timestamp).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' });
            const ageMs  = Date.now() - value.timestamp;
            const ageH   = Math.floor(ageMs / 3_600_000);
            const ageM   = Math.floor((ageMs % 3_600_000) / 60_000);
            const ageLbl = ageH > 0 ? `${ageH}h ${ageM}m ago` : `${ageM}m ago`;
            lines.push(`- **Saved:** ${saved} EDT (${ageLbl}) ${ageMs > 86_400_000 ? '⚠️ LCT expired (>24h)' : '✅ LCT fresh'}`);
        }

        // Teams + portfolio key
        if (value.allTeams)   lines.push(`- **Teams (${value.allTeams.length}):** ${value.allTeams.join(', ')}`);
        if (value.portfolioKey) lines.push(`- **Portfolio key:** ${value.portfolioKey}`);

        // Story counts
        if (value.storyCount != null) {
            const byStatus = value.storyStatusSummary
                ? Object.entries(value.storyStatusSummary).map(([s, v]) => `${s}: ${v.count}`).join(' · ')
                : null;
            lines.push(`- **Stories:** ${value.storyCount}${byStatus ? ` (${byStatus})` : ''}`);
        }

        // Sprint data
        if (value.sprintsByTeam) {
            const st = Object.entries(value.sprintsByTeam);
            lines.push(`- **Sprint data:** ${st.length} teams`);
            st.forEach(([t, d]) => {
                if (d.error) { lines.push(`  - ${t}: ⚠️ ${d.error}`); return; }
                lines.push(`  - **${t}** — ${d.boardName || '?'} · ${d.sprints?.length ?? 0} sprint(s)`);
                (d.sprints || []).forEach(s => {
                    if (s.error) { lines.push(`    - ${s.name}: ⚠️ ${s.error}`); return; }
                    const pct  = s.sayDo != null ? `${Math.round(s.sayDo * 100)}%` : '—';
                    const rag  = s.sayDoRag || '';
                    lines.push(`    - ${s.name}: P:${s.planned ?? '—'} A:${s.added ?? '—'} R:${s.removed ?? '—'} ✅:${s.completed ?? '—'} 🔄:${s.rolledOver ?? '—'} ${rag}${pct}`);
                });
            });
        } else if (value.sprintTeamIndex !== undefined) {
            lines.push(`- **Sprint data:** ⏳ In progress (${value.sprintTeamIndex} teams done)`);
        } else {
            lines.push(`- **Sprint data:** ❌ not yet collected`);
        }

        // Board/sprint index
        if (value.newestSprintIdByTeam) lines.push(`- **Board/sprint index:** ${Object.keys(value.newestSprintIdByTeam).length} team(s)`);

        // Velocity
        if (value.velocityByTeam) {
            const vTeams = Object.entries(value.velocityByTeam);
            lines.push(`- **Velocity (Innovation):** ${vTeams.length} teams`);
            vTeams.forEach(([t, v]) => lines.push(`  - ${t}: ${v.averageDays != null ? `${v.averageDays}d avg` : '—'} · ${v.epicCount ?? 0} epics`));
        } else {
            lines.push(`- **Velocity:** ❌ not yet collected`);
        }

        // LCT — structure: lctByTeam[team].overall.leadTime.averageDays / .count
        if (value.lctByTeam) {
            const lTeams = Object.entries(value.lctByTeam);
            lines.push(`- **Lead/Cycle Time:** ${lTeams.length} teams`);
            lTeams.forEach(([t, l]) => {
                const lead  = l.overall?.leadTime?.averageDays  ?? '—';
                const cycle = l.overall?.cycleTime?.averageDays ?? '—';
                const count = Math.max(l.overall?.leadTime?.count ?? 0, l.overall?.cycleTime?.count ?? 0);
                lines.push(`  - ${t}: lead ${lead}d · cycle ${cycle}d · ${count} issues`);
            });
        } else {
            lines.push(`- **Lead/Cycle Time:** ❌ not yet collected`);
        }

        // Overall velocity
        if (value.overallVelocity) lines.push(`- **Overall velocity:** ${value.overallVelocity.averageDays}d avg · ${value.overallVelocity.epicCount} epics`);

        // Partial sprint accumulator
        if (value.sprintAcc) lines.push(`- **Sprint accumulator (partial):** ${Object.keys(value.sprintAcc).length} teams buffered`);

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

    if (!accountId) {
        return { status: 'ERROR', message: '🚫 Could not determine your account ID.' };
    }

    const admin      = await isAdmin(accountId);
    const userPrefix = `${SESSION_KEY_PREFIX}:${accountId}:`;

    // ── Non-admin path: read-only access to own session keys only ─────────────
    if (!admin) {
        try {
            if (key) {
                if (!key.startsWith(userPrefix)) {
                    return { status: 'ERROR', message: '🚫 **Access denied.** You can only inspect your own session keys.\n\n_Tip: Use **"Inspect my storage"** (no key) to list your sessions, or **"What is my account ID?"** to confirm your ID._' };
                }
                const value = await storage.get(key);
                if (value === undefined || value === null) {
                    return { status: 'NOT_FOUND', message: `🔍 Key \`${key}\` does not exist in storage.` };
                }
                return { status: 'SUCCESS', key, message: summarizeStorageValue(key, value) };
            }

            // No key — list only the caller's own session keys
            const result  = await storage.query().where('key', startsWith(userPrefix)).getMany();
            const entries = result?.results || [];
            if (entries.length === 0) {
                return { status: 'SUCCESS', message: `🗂️ **Your session storage** — no cached sessions found.\n\n_Tip: Run a portfolio export or analysis to create a session._` };
            }
            const lines = entries.map(({ key: k, value: v }) => {
                const portfolioKey = k.split(':')[2] || '?';
                const phase        = v?.phase || 'unknown';
                const teams        = (v?.allTeams || []).length;
                return `- \`${k}\`\n  → **${portfolioKey}** · phase: \`${phase}\` · ${teams} team(s)`;
            });
            return {
                status:  'SUCCESS',
                count:   entries.length,
                message: `🗂️ **Your session storage (${entries.length} session${entries.length === 1 ? '' : 's'}):**\n${lines.join('\n')}\n\n_Tip: Ask me to "inspect storage key \`<key>\`" to see full details._`,
            };
        } catch (err) {
            return { status: 'ERROR', message: `Storage inspection failed: ${err.message}` };
        }
    }

    // ── Admin path: full access to all keys ───────────────────────────────────
    try {
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
            message: `🗄️ **All storage keys (${keys.length}):**\n${lines.join('\n')}\n\n_Tip: Ask me to "inspect storage key \`<key>\`" to see its contents._`,
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
        const deleted = await deleteAllMatchingKeys(`${SESSION_KEY_PREFIX}:${accountId}:`);
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
