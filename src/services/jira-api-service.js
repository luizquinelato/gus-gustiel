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
        const res = await asUser().requestJira(
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
 * Fetch a sprint report from the GreenHopper API.
 * Returns a normalised { planned, added, removed, completed, notCompleted } object
 * or null if the request fails.
 *
 * Story-point derivation:
 *   planned   = completedInit + notCompletedInit + puntedInit  (committed at sprint start)
 *   added     = max(0, (completed + notCompleted) − (planned − punted))  (added mid-sprint)
 *   removed   = punted  (removed mid-sprint)
 *   completed = completedIssuesEstimateSum  (velocity)
 *   notCompleted = issuesNotCompletedEstimateSum  (rolled over)
 *
 * @param {number|string} boardId  - rapidViewId in GreenHopper terms
 * @param {number|string} sprintId
 * @returns {Promise<Object|null>}
 */
export async function getSprintReport(boardId, sprintId) {
    try {
        const res = await asUser().requestJira(
            route`/rest/greenhopper/1.0/rapid/charts/sprintreport?rapidViewId=${boardId}&sprintId=${sprintId}`,
            { headers: { 'Accept': 'application/json' } }
        );
        if (!res.ok) return null;
        const data = await res.json();
        const c = data.contents;
        const val = obj => (obj && obj.value != null ? parseFloat(obj.value) : 0);

        const completedInit    = val(c.completedIssuesInitialEstimateSum);
        const notCompletedInit = val(c.issuesNotCompletedInitialEstimateSum);
        const puntedInit       = val(c.puntedIssuesInitialEstimateSum);
        const completed        = val(c.completedIssuesEstimateSum);
        const notCompleted     = val(c.issuesNotCompletedEstimateSum);
        const punted           = val(c.puntedIssuesEstimateSum);

        const planned = completedInit + notCompletedInit + puntedInit;
        const added   = Math.max(0, (completed + notCompleted) - (planned - punted));

        return { planned, added, removed: punted, completed, notCompleted };
    } catch (e) {
        console.error(`[getSprintReport] Error for board ${boardId} sprint ${sprintId}: ${e.message}`);
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

