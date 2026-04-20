/**
 * Sprint Extractor
 *
 * Single source of truth for all sprint-related extraction operations.
 * Used by both the individual team sprint resolver (Skill 7) and the
 * portfolio ETL pipeline (Steps 1 and 3).
 *
 * Layer rules:
 *  - Pure functions (no I/O): extractNewestSprintIdByTeam
 *  - Async extraction (calls services): enrichTeamSprintListsFromBoardApi,
 *    discoverBoardIdForTeam, fetchSprintReportsForTeams
 *
 * Rate-limiting strategy: a shared semaphore (GREENHOPPER_CONCURRENCY_LIMIT)
 * caps total concurrent GreenHopper calls across ALL teams in a single
 * invocation.  Both individual and portfolio resolvers share this one strategy.
 *
 * NEVER add sprint extraction logic directly to a resolver.
 * Import from here instead.
 */

import { searchJira, getBoardById,
         getRecentBoardClosedSprints,
         getGreenHopperSprintReport }      from '../services/jira-api-service.js';
import { parseGreenHopperSprintReport }   from '../transformers/portfolio-transformer.js';
import { makeSemaphore }                  from '../utils/concurrency.js';
import { GREENHOPPER_CONCURRENCY_LIMIT }  from '../config/constants.js';

// ── Pure extraction (no I/O) ──────────────────────────────────────────────────

/**
 * Given raw story issues, extract the most recent sprint metadata per team.
 * Reads boardId and sprint list directly from Jira issue sprint fields.
 *
 * ⚠️  This is a FAST, CHEAP starting point — it only sees sprints that happen
 * to appear on the crawled story issues.  Always follow up with
 * enrichTeamSprintListsFromBoardApi() to replace the derived sprint list with
 * authoritative Board API data (issue fields miss sprints with no recently-
 * updated stories, e.g. Quality, Warriors).
 *
 * @param {Object[]} rawIssues     - Raw Jira issue objects (must include sprint + parent fields)
 * @param {string}   sprintField   - Sprint custom field key (e.g. "customfield_10020")
 * @param {Object}   epicKeyToTeam - Map: epicKey → agileTeamName
 * @returns {Object} { [teamName]: { id, name, boardId, endDate, startDate, recentClosedSprints[] } }
 */
export function extractNewestSprintIdByTeam(rawIssues, sprintField, epicKeyToTeam) {
    const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;
    const sixMonthsAgo  = Date.now() - SIX_MONTHS_MS;

    const raw = {}; // { [team]: { sprintMap: { [id]: sprint }, newest: sprint|null } }
    for (const issue of rawIssues) {
        const sprints = issue.fields?.[sprintField];
        if (!Array.isArray(sprints) || sprints.length === 0) continue;

        const team = epicKeyToTeam[issue.fields?.parent?.key];
        if (!team) continue;

        if (!raw[team]) raw[team] = { sprintMap: {}, newest: null };

        for (const s of sprints) {
            if (!s.id || s.state === 'future') continue;
            raw[team].sprintMap[s.id] = s; // dedup by sprint id

            const sDate   = new Date(s.endDate || s.startDate).getTime();
            const curDate = raw[team].newest
                ? new Date(raw[team].newest.endDate || raw[team].newest.startDate).getTime()
                : 0;
            if (sDate > curDate) raw[team].newest = s;
        }
    }

    const result = {};
    for (const [team, data] of Object.entries(raw)) {
        if (!data.newest) continue;

        const recentClosedSprints = Object.values(data.sprintMap)
            .filter(s => s.state === 'closed' && s.endDate && new Date(s.endDate).getTime() >= sixMonthsAgo)
            .sort((a, b) => new Date(b.endDate) - new Date(a.endDate))
            .slice(0, 6);

        result[team] = {
            id:                  data.newest.id,
            name:                data.newest.name,
            endDate:             data.newest.endDate,
            startDate:           data.newest.startDate,
            boardId:             data.newest.boardId || null,
            recentClosedSprints,
        };
    }
    return result;
}

// ── Async extraction (calls services) ────────────────────────────────────────

/**
 * Replace issue-field-derived recentClosedSprints with authoritative Board API data.
 *
 * The Board API always returns the correct last-N closed sprints regardless of
 * issue sprint-field coverage — it is the source of truth for the board.
 * Issue fields only reflect sprints that happen to appear on crawled stories,
 * so teams with no recently-updated stories (e.g. Quality, Warriors) are missed.
 *
 * Mutates newestSprintByTeam in-place.
 * Board API calls run in parallel (different endpoint from GreenHopper; no 429 risk).
 *
 * @param {Object}  newestSprintByTeam  - Map produced by extractNewestSprintIdByTeam
 * @param {number}  [count=6]           - How many recent closed sprints to fetch per team
 * @param {number}  [cutoffMs]          - Epoch ms lower bound (defaults to 6 months ago)
 */
export async function enrichTeamSprintListsFromBoardApi(newestSprintByTeam, count = 6, cutoffMs) {
    const cutoff = cutoffMs ?? (Date.now() - 6 * 30 * 24 * 60 * 60 * 1000);
    await Promise.all(
        Object.entries(newestSprintByTeam).map(async ([team, data]) => {
            if (!data.boardId) return;
            try {
                const boardSprints = await getRecentBoardClosedSprints(data.boardId, count);
                const recent = boardSprints
                    .filter(s => s.endDate && new Date(s.endDate).getTime() >= cutoff);
                if (recent.length > 0) {
                    data.recentClosedSprints = recent;
                    console.log(`[SprintExtract] ${team}: board API → ${recent.length} sprint(s)`);
                }
            } catch (e) {
                console.warn(`[SprintExtract] ${team}: board API failed, keeping existing sprints — ${e.message}`);
            }
        })
    );
}

/**
 * Discover the boardId for a named agile team by querying issue sprint fields.
 *
 * Two-pass strategy:
 *  Pass 1 — any issue with a sprint (fast, covers active teams)
 *  Pass 2 — issues in closed sprints only (fallback for teams between sprints)
 *
 * Used by the individual sprint resolver (Skill 7) when there is no existing
 * portfolio session to read boardId from.
 *
 * @param {string} teamName          - Agile team display name (e.g. "Bushido")
 * @param {string} agileTeamFieldNum - Raw field number, no prefix (e.g. "10700")
 * @param {string} sprintField       - Sprint custom field key (e.g. "customfield_10020")
 * @returns {Promise<{ boardId: string|null }>}
 */
export async function discoverBoardIdForTeam(teamName, agileTeamFieldNum, sprintField) {
    // Pass 1 — any issue that has a sprint field set
    const seedIssues = await searchJira(
        `cf[${agileTeamFieldNum}] = "${teamName}" AND sprint is not null ORDER BY updated desc`,
        [sprintField], [], 10, 10
    );
    for (const issue of seedIssues) {
        const found = (issue.fields?.[sprintField] || []).find(s => s.boardId);
        if (found) {
            console.log(`[SprintExtract] discoverBoardId: team="${teamName}" boardId=${found.boardId} (pass 1)`);
            return { boardId: String(found.boardId) };
        }
    }

    // Pass 2 — closed sprints only (teams between active sprints)
    const closedIssues = await searchJira(
        `cf[${agileTeamFieldNum}] = "${teamName}" AND sprint in closedSprints() ORDER BY updated desc`,
        [sprintField], [], 10, 10
    );
    for (const issue of closedIssues) {
        const found = (issue.fields?.[sprintField] || []).find(s => s.boardId);
        if (found) {
            console.log(`[SprintExtract] discoverBoardId: team="${teamName}" boardId=${found.boardId} (pass 2)`);
            return { boardId: String(found.boardId) };
        }
    }

    console.warn(`[SprintExtract] discoverBoardId: no boardId found for team="${teamName}"`);
    return { boardId: null };
}

/**
 * Fetch GreenHopper sprint reports for all given teams and parse them into
 * the canonical sprint result shape.
 *
 * Teams run in parallel for board-name lookups (getBoardById — different API,
 * no 429 risk).  Every GreenHopper call is gated by a shared semaphore
 * (GREENHOPPER_CONCURRENCY_LIMIT) so the total in-flight count across ALL
 * teams never exceeds the limit, preventing burst 429s.
 *
 * This is the single GreenHopper fetch strategy used by both the individual
 * sprint resolver and the portfolio ETL pipeline.
 *
 * @param {string[]} teams              - Team names to process
 * @param {Object}   newestSprintByTeam - { [team]: { boardId, recentClosedSprints[] } }
 * @param {number}   [semaphoreLimit]   - Override the global concurrency limit (rarely needed)
 * @returns {Promise<Object>}           - { [team]: { boardId, boardName, sprints[] } | { error } }
 */
export async function fetchSprintReportsForTeams(teams, newestSprintByTeam, semaphoreLimit) {
    const limit      = semaphoreLimit ?? GREENHOPPER_CONCURRENCY_LIMIT;
    const runLimited = makeSemaphore(limit);
    const result     = {};

    await Promise.all(teams.map(async (team) => {
        const teamData      = newestSprintByTeam[team];
        const boardId       = teamData?.boardId;
        const targetSprints = teamData?.recentClosedSprints || [];

        try {
            // getBoardById is unrestricted — board names fetched concurrently
            const [boardMeta, ...reports] = await Promise.all([
                getBoardById(boardId),
                ...targetSprints.map(s => runLimited(() => getGreenHopperSprintReport(boardId, s.id))),
            ]);
            const boardName = boardMeta?.name || (boardId ? `Board ${boardId}` : 'Unknown Board');

            const sprints = reports.map((report, idx) => {
                const sprint = targetSprints[idx];
                if (!report) {
                    console.warn(`[SprintExtract] ${team}: null report for sprint ${sprint.id} (${sprint.name})`);
                    return { id: sprint.id, name: sprint.name, endDate: sprint.endDate, error: 'Sprint report unavailable' };
                }
                return parseGreenHopperSprintReport(report, sprint);
            });

            result[team] = { boardId, boardName, sprints };
            console.log(`[SprintExtract] ${team}: board="${boardName}" (${boardId}), ${sprints.length} sprint(s)`);
        } catch (err) {
            console.error(`[SprintExtract] ${team}: error — ${err.message}`);
            result[team] = { error: err.message };
        }
    }));

    return result;
}
