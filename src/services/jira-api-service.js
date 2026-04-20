/**
 * Jira API Service
 *
 * Core Jira API interaction functions.
 * Handles environment detection (Sandbox vs Production) and paginated JQL search.
 */

import { asApp, asUser, route } from '@forge/api';
import { ENV_CONFIG } from '../config/constants.js';

/**
 * Detect the current Jira environment (Sandbox vs Production).
 * Returns the matching ENV_CONFIG entry plus the live baseUrl.
 *
 * @returns {Promise<Object>} Environment config object with baseUrl attached
 */
export async function getEnvFromJira() {
    try {
        const response = await asApp().requestJira(route`/rest/api/3/serverInfo`, {
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) return { ...ENV_CONFIG.PRODUCTION, baseUrl: 'Unknown' };

        const data = await response.json();
        const baseUrl = data.baseUrl || '';

        if (baseUrl.toLowerCase().includes(ENV_CONFIG.SANDBOX.urlPart)) {
            return { ...ENV_CONFIG.SANDBOX, baseUrl };
        }

        return { ...ENV_CONFIG.PRODUCTION, baseUrl };
    } catch (e) {
        return { ...ENV_CONFIG.PRODUCTION, baseUrl: 'Error' };
    }
}

/**
 * Resolve the current user's accountId.
 * Tries event.context first (available in some Forge module types),
 * then falls back to the Jira /myself API (always reliable in Rovo actions).
 *
 * @param {object} [event] - Forge event object (optional)
 * @returns {Promise<string>} accountId, or 'shared' as last resort
 */
export async function getCurrentAccountId(event) {
    const fromContext = event?.context?.accountId || null;
    if (fromContext) return fromContext;
    try {
        const res  = await asUser().requestJira(route`/rest/api/3/myself`, { headers: { Accept: 'application/json' } });
        const data = await res.json();
        return data.accountId || 'shared';
    } catch (_) {
        return 'shared';
    }
}

/**
 * Fetch the email address of the requesting Jira user.
 *
 * Strategy (two attempts, first win):
 *   1. asUser() + /rest/api/3/myself  — user always sees their own email regardless
 *      of Jira privacy settings. Works when Forge injects a user OAuth token (most
 *      Rovo action invocations).
 *   2. asApp() + /rest/api/3/user?accountId=… — fallback for contexts where asUser()
 *      has no token. Returns email only if the user has not hidden it from apps.
 *
 * @param {string} accountId - Jira user accountId (from event.context.accountId)
 * @returns {Promise<string|null>}
 */
export async function getUserEmail(accountId) {
    // Attempt 1: asUser() — bypasses privacy settings for the user's own profile
    try {
        const r1 = await asUser().requestJira(
            route`/rest/api/3/myself`,
            { headers: { 'Accept': 'application/json' } }
        );
        if (r1.ok) {
            const d1 = await r1.json();
            if (d1.emailAddress) return d1.emailAddress;
        }
    } catch { /* fall through to attempt 2 */ }

    // Attempt 2: asApp() — works when asUser() has no token in the current context
    try {
        const r2 = await asApp().requestJira(
            route`/rest/api/3/user?accountId=${accountId}`,
            { headers: { 'Accept': 'application/json' } }
        );
        if (r2.ok) {
            const d2 = await r2.json();
            if (d2.emailAddress) return d2.emailAddress;
        }
    } catch { /* both attempts failed */ }

    return null;
}

/**
 * Search Jira issues using JQL with automatic pagination (nextPageToken).
 *
 * @param {string} jql - JQL query string
 * @param {string[]} fieldsArray - Fields to retrieve
 * @param {string[]} [expandArray=[]] - Expand options (e.g. ['changelog'])
 * @param {number} [maxResults=100] - Max results per page (Jira limit: 100)
 * @param {number} [maxTotalResults=Infinity] - Hard cap on total items returned.
 *   Use this for expensive queries (e.g. changelog expansion) to prevent the
 *   paginator from exceeding Forge's 25-second function timeout.
 * @returns {Promise<Array>} Array of all matching issue objects
 */
export async function searchJira(jql, fieldsArray, expandArray = [], maxResults = 100, maxTotalResults = Infinity) {
    try {
        let allIssues = [];
        let nextPageToken = null;
        let isLast = false;
        let pageCount = 0;

        do {
            pageCount++;
            const body = { jql, fields: fieldsArray, maxResults };
            if (nextPageToken) body.nextPageToken = nextPageToken;
            if (expandArray.length > 0) body.expand = expandArray.join(',');

            const response = await asApp().requestJira(route`/rest/api/latest/search/jql`, {
                method: 'POST',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                console.error(`[searchJira] Failed ${response.status} on page ${pageCount}`);
                return allIssues;
            }

            const data = await response.json();
            const issues = data.issues || [];
            isLast = data.isLast !== undefined ? data.isLast : true;
            nextPageToken = data.nextPageToken || null;
            allIssues = allIssues.concat(issues);

            console.log(`[searchJira] Page ${pageCount}: ${issues.length} issues (total: ${allIssues.length}, isLast: ${isLast})`);

            // Stop early when the caller set a total-results cap (e.g. for changelog queries)
            if (allIssues.length >= maxTotalResults) {
                allIssues = allIssues.slice(0, maxTotalResults);
                console.log(`[searchJira] maxTotalResults cap (${maxTotalResults}) reached — stopping pagination.`);
                break;
            }
        } while (nextPageToken && !isLast);

        return allIssues;
    } catch (error) {
        console.error(`[searchJira] Exception: ${error.message}`);
        return [];
    }
}

// ── Agile / GreenHopper API helpers ──────────────────────────────────────────

/**
 * Fetch a single sprint by its ID from the Agile API.
 * Returns the sprint object (includes originBoardId) or null on failure.
 * @param {number|string} sprintId
 * @returns {Promise<Object|null>}
 */
export async function getSprintById(sprintId) {
    try {
        const res = await asApp().requestJira(
            route`/rest/agile/1.0/sprint/${sprintId}`,
            { headers: { 'Accept': 'application/json' } }
        );
        return res.ok ? await res.json() : null;
    } catch (e) {
        console.error(`[getSprintById] Error for sprint ${sprintId}: ${e.message}`);
        return null;
    }
}

/**
 * Fetch a board by its ID from the Agile API.
 * Returns the board object (includes name) or null on failure.
 * @param {number|string} boardId
 * @returns {Promise<Object|null>}
 */
export async function getBoardById(boardId) {
    try {
        const res = await asApp().requestJira(
            route`/rest/agile/1.0/board/${boardId}`,
            { headers: { 'Accept': 'application/json' } }
        );
        return res.ok ? await res.json() : null;
    } catch (e) {
        console.error(`[getBoardById] Error for board ${boardId}: ${e.message}`);
        return null;
    }
}

/**
 * Fetch the most recent closed sprints for a board.
 * Returns an array of sprint objects sorted oldest-first (as Jira returns them).
 * Caller is responsible for re-sorting and slicing.
 * @param {number|string} boardId
 * @param {number} [maxResults=15] - Fetch buffer; caller slices to desired count
 * @returns {Promise<Array>}
 */
export async function getBoardClosedSprints(boardId, maxResults = 15) {
    try {
        const res = await asApp().requestJira(
            route`/rest/agile/1.0/board/${boardId}/sprint?state=closed&maxResults=${maxResults}`,
            { headers: { 'Accept': 'application/json' } }
        );
        if (!res.ok) return [];
        const data = await res.json();
        return data.values || [];
    } catch (e) {
        console.error(`[getBoardClosedSprints] Error for board ${boardId}: ${e.message}`);
        return [];
    }
}

/**
 * Fetch the N most recent closed sprints for a board.
 *
 * Jira's board sprint API always returns sprints oldest-first (ascending by ID).
 * A board with years of history may have 100+ closed sprints; fetching from
 * startAt=0 with a small maxResults therefore returns ancient sprints, not recent ones.
 *
 * This function uses a two-phase approach:
 *   Phase 1 — probe with maxResults=1 to read the `total` sprint count.
 *   Phase 2 — fetch from startAt=(total - buffer) to land at the most recent end.
 *
 * Returns sprints sorted newest-first, capped at `count`.
 *
 * @param {number|string} boardId
 * @param {number} [count=6]   - How many recent sprints to return
 * @returns {Promise<Array>}
 */
export async function getRecentBoardClosedSprints(boardId, count = 6) {
    try {
        // Phase 1: probe to get total number of closed sprints on this board
        const probeRes = await asApp().requestJira(
            route`/rest/agile/1.0/board/${boardId}/sprint?state=closed&maxResults=1`,
            { headers: { 'Accept': 'application/json' } }
        );
        console.log(`[getRecentBoardClosedSprints] board=${boardId} probe HTTP=${probeRes.status}`);
        if (!probeRes.ok) {
            const body = await probeRes.text().catch(() => '(unreadable)');
            console.error(`[getRecentBoardClosedSprints] probe failed: ${body}`);
            return [];
        }
        const probe = await probeRes.json();
        const total = probe.total ?? 0;
        console.log(`[getRecentBoardClosedSprints] board=${boardId} total closed sprints=${total}`);
        if (total === 0) return [];

        // Phase 2: fetch from near the end — small buffer guards against off-by-one
        const buffer  = count + 3;
        const startAt = Math.max(0, total - buffer);
        const pageRes = await asApp().requestJira(
            route`/rest/agile/1.0/board/${boardId}/sprint?state=closed&startAt=${startAt}&maxResults=${buffer}`,
            { headers: { 'Accept': 'application/json' } }
        );
        console.log(`[getRecentBoardClosedSprints] board=${boardId} page HTTP=${pageRes.status} startAt=${startAt}`);
        if (!pageRes.ok) {
            const body = await pageRes.text().catch(() => '(unreadable)');
            console.error(`[getRecentBoardClosedSprints] page failed: ${body}`);
            return [];
        }
        const page    = await pageRes.json();
        const results = (page.values || [])
            .sort((a, b) => new Date(b.endDate) - new Date(a.endDate))
            .slice(0, count);
        console.log(`[getRecentBoardClosedSprints] board=${boardId} returning ${results.length} sprint(s): ${results.map(s => s.name).join(', ')}`);
        return results;
    } catch (e) {
        console.error(`[getRecentBoardClosedSprints] Error for board ${boardId}: ${e.message}`);
        return [];
    }
}

/**
 * Fetch the GreenHopper sprint report for a given board and sprint.
 * Uses asApp() — consistent with all other Agile API calls, works in any Forge context.
 * Returns the full report object or null on failure.
 *
 * @param {number|string} boardId
 * @param {number|string} sprintId
 * @returns {Promise<Object|null>}
 */
export async function getGreenHopperSprintReport(boardId, sprintId) {
    const MAX_ATTEMPTS = 3;
    const delay = ms => new Promise(r => setTimeout(r, ms));

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const res = await asApp().requestJira(
                route`/rest/greenhopper/1.0/rapid/charts/sprintreport?rapidViewId=${boardId}&sprintId=${sprintId}`,
                { headers: { 'Accept': 'application/json' } }
            );

            if (res.status === 429) {
                // Back off with jitter so parallel retries don't all fire together again.
                const baseMs  = attempt * 1000;
                const jitterMs = Math.floor(Math.random() * 500);
                const waitMs  = baseMs + jitterMs;
                console.warn(`[GreenHopper] Sprint ${sprintId} board ${boardId} → 429 (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${waitMs}ms`);
                if (attempt < MAX_ATTEMPTS) await delay(waitMs);
                continue;
            }

            if (!res.ok) {
                console.warn(`[GreenHopper] Sprint ${sprintId} board ${boardId} → HTTP ${res.status}`);
                return null;
            }

            return await res.json();
        } catch (e) {
            console.error(`[GreenHopper] Error sprint ${sprintId}: ${e.message}`);
            return null;
        }
    }

    console.warn(`[GreenHopper] Sprint ${sprintId} board ${boardId} → gave up after ${MAX_ATTEMPTS} attempts`);
    return null;
}

/**
 * Compute sprint metrics via a standard JQL search (asApp, no GreenHopper needed).
 * Returns a normalised { planned, added, removed, completed, notCompleted } object
 * or null if the request fails.
 *
 * Note: without the GreenHopper "planned at start" snapshot, `planned` is approximated
 * as completed + notCompleted (all SP in the sprint at close time). `added` and `removed`
 * are returned as 0 because mid-sprint scope changes are not available via JQL.
 *
 * @param {number|string} sprintId
 * @param {string}        storyPointsField  - e.g. 'customfield_10038'
 * @returns {Promise<Object|null>}
 */
export async function getSprintReport(sprintId, storyPointsField) {
    try {
        const issues = await searchJira(
            `sprint = ${sprintId} AND issuetype in standardIssueTypes()`,
            ['status', storyPointsField]
        );

        let completed    = 0;
        let notCompleted = 0;

        for (const issue of issues) {
            const raw = issue.fields?.[storyPointsField];
            const sp  = typeof raw === 'number' ? raw
                      : raw?.value != null       ? parseFloat(raw.value)
                      : 0;
            if (!sp) continue;

            const statusKey = issue.fields?.status?.statusCategory?.key;
            if (statusKey === 'done') {
                completed += sp;
            } else {
                notCompleted += sp;
            }
        }

        const planned = completed + notCompleted; // approximation (completed + rolled-over at sprint close)
        return { planned, added: 0, removed: 0, completed, notCompleted };
    } catch (e) {
        console.error(`[getSprintReport] Error for sprint ${sprintId}: ${e.message}`);
        return null;
    }
}

/**
 * Resumable paginated Jira search — fetches exactly `maxPages` pages per call.
 *
 * Designed for the batched LCT flow where each Forge invocation fetches a fixed
 * number of pages, saves the returned nextPageToken to storage, and resumes on
 * the next invocation — keeping every call well within the 25-second timeout.
 *
 * @param {string}   jql             - JQL query string
 * @param {string[]} fieldsArray     - Fields to retrieve
 * @param {string[]} [expandArray=[]]- Expand options (e.g. ['changelog'])
 * @param {number}   [pageSize=100]  - Results per Jira page (max 100)
 * @param {number}   [maxPages=5]    - Max pages to fetch in this single call
 * @param {string|null} [startPageToken=null] - Resume token from a previous call
 * @returns {Promise<{ issues: Array, nextPageToken: string|null, isLast: boolean, pagesRead: number }>}
 */
export async function searchJiraBatch(jql, fieldsArray, expandArray = [], pageSize = 100, maxPages = 5, startPageToken = null) {
    const issues = [];
    let nextPageToken = startPageToken;
    let isLast = false;
    let pagesRead = 0;

    try {
        while (pagesRead < maxPages) {
            pagesRead++;
            const body = { jql, fields: fieldsArray, maxResults: pageSize };
            if (nextPageToken) body.nextPageToken = nextPageToken;
            if (expandArray.length > 0) body.expand = expandArray.join(',');

            const response = await asApp().requestJira(route`/rest/api/latest/search/jql`, {
                method: 'POST',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                console.error(`[searchJiraBatch] Failed ${response.status} on page ${pagesRead}`);
                isLast = true;
                break;
            }

            const data = await response.json();
            const pageIssues = data.issues || [];
            isLast = data.isLast !== undefined ? data.isLast : true;
            nextPageToken = data.nextPageToken || null;
            issues.push(...pageIssues);

            console.log(`[searchJiraBatch] Page ${pagesRead}/${maxPages}: ${pageIssues.length} issues (batch total: ${issues.length}, isLast: ${isLast})`);

            if (isLast || !nextPageToken) break;
        }
    } catch (error) {
        console.error(`[searchJiraBatch] Exception: ${error.message}`);
        isLast = true;
    }

    return { issues, nextPageToken: isLast ? null : nextPageToken, isLast, pagesRead };
}

