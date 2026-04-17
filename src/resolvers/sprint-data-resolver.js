/**
 * Sprint Data Resolver — Step 3 of the ETL Pipeline
 *
 * For each agile team identified in the session, this resolver:
 *   1. Reads the pre-collected recentClosedSprints per team from the session (Step 1)
 *   2. Calls the GreenHopper sprint report API for each sprint (asApp, all teams in parallel)
 *   3. Uses parseGreenHopperSprintReport() to extract planned (estimateStatistic) and
 *      velocity/rolledOver/removed/added (currentEstimateStatistic)
 *   4. Returns data shaped for formatSprintSection()
 *
 * All teams are processed in a SINGLE invocation using Promise.all — no PARTIAL loop.
 * With parallel calls, 12 teams × 7 API calls = ~84 concurrent requests complete in ~3s,
 * well within Forge's 25-second timeout. This avoids the external-loop problem where
 * posting a PARTIAL message to the user ends the agent's turn before it can call again.
 *
 * Final output: session.sprintsByTeam
 * Storage key:  export_session:<accountId>:<portfolioKey>
 */

import { storage }                                          from '@forge/api';
import { getBoardById, getGreenHopperSprintReport,
         getCurrentAccountId }                              from '../services/jira-api-service.js';
import { parseGreenHopperSprintReport }                     from '../transformers/portfolio-transformer.js';

const sessionKey = (accountId, portfolioKey) =>
    `export_session:${accountId}:${portfolioKey}`;

export const calculateSprintData = async (event) => {
    const portfolioKey = (event?.payload?.portfolioKey || event?.portfolioKey || '').trim().toUpperCase();
    const accountId    = await getCurrentAccountId(event);

    if (!portfolioKey) {
        return { status: 'ERROR', message: 'portfolioKey is required.' };
    }

    // ── READ session ──────────────────────────────────────────────────────────
    let session;
    try {
        session = await storage.get(sessionKey(accountId, portfolioKey));
    } catch (e) {
        return { status: 'ERROR', message: `Could not read session: ${e.message}` };
    }

    if (!session) {
        return { status: 'NO_SESSION', message: `No session found for **${portfolioKey}**. Run \`prepare-portfolio-export\` first.` };
    }

    const newestSprintIdByTeam = session.newestSprintIdByTeam || {};
    const allTeams             = session.allTeams || [];

    // Only process teams that have pre-collected closed sprints from Step 1
    const teamsWithSprints = allTeams.filter(t => newestSprintIdByTeam[t]?.recentClosedSprints?.length > 0);

    // Detect old session format (no recentClosedSprints) — clear stale sprint data so
    // the export shows the placeholder rather than old "Report unavailable" rows.
    const hasOldFormat = allTeams.length > 0
        && Object.keys(newestSprintIdByTeam).length > 0
        && teamsWithSprints.length === 0;

    if (teamsWithSprints.length === 0) {
        if (hasOldFormat) {
            // Clear stale data so the Confluence export won't show outdated sprint rows
            try {
                await storage.set(sessionKey(accountId, portfolioKey), {
                    ...session,
                    sprintsByTeam:   undefined,
                    sprintTeamIndex: undefined,
                    sprintAcc:       undefined,
                });
            } catch (_) { /* best-effort */ }
            return {
                status: 'NO_SPRINT_DATA',
                portfolioKey,
                message: `⚠️ Session for **${portfolioKey}** is from an older format and does not contain sprint history snapshots.\n\nPlease **wipe the session** and re-run \`prepare-portfolio-export\` to capture sprint data, then run \`calculate-sprint-data\` again.`,
            };
        }
        return {
            status: 'NO_SPRINT_DATA',
            portfolioKey,
            message: `⚠️ No sprint data found for **${portfolioKey}**. Teams may not have stories assigned to sprints, or the sprint field was not populated.`,
        };
    }

    // ── EXTRACT — all teams in parallel, sprints within each team also in parallel ──
    // No batching or PARTIAL needed: Promise.all across 12 teams × ~7 API calls each
    // completes in ~3s, well within Forge's 25s limit.
    const sprintsByTeam = {};
    await Promise.all(teamsWithSprints.map(async (team) => {
        const newestSprint  = newestSprintIdByTeam[team];
        try {
            const boardId       = newestSprint.boardId;
            const targetSprints = newestSprint.recentClosedSprints || [];

            // Board name + all sprint reports fetched in one parallel wave
            const [boardMeta, ...reports] = await Promise.all([
                getBoardById(boardId),
                ...targetSprints.map(s => getGreenHopperSprintReport(boardId, s.id)),
            ]);
            const boardName = boardMeta?.name || (boardId ? `Board ${boardId}` : 'Unknown Board');

            // TRANSFORM
            const sprints = reports.map((report, idx) => {
                const sprint = targetSprints[idx];
                if (!report) {
                    console.warn(`[SprintData] ${team}: GreenHopper returned null for sprint ${sprint.id} (${sprint.name})`);
                    return { id: sprint.id, name: sprint.name, endDate: sprint.endDate, error: 'Sprint report unavailable' };
                }
                return parseGreenHopperSprintReport(report, sprint);
            });

            sprintsByTeam[team] = { boardId, boardName, sprints };
            console.log(`[SprintData] ${team}: board="${boardName}" (${boardId}), ${sprints.length} sprint(s) collected`);

        } catch (teamErr) {
            console.error(`[SprintData] Error processing team ${team}: ${teamErr.message}`);
            sprintsByTeam[team] = { error: teamErr.message };
        }
    }));

    // ── SUCCESS — write results and return ────────────────────────────────────
    try {
        await storage.set(sessionKey(accountId, portfolioKey), {
            ...session,
            sprintsByTeam,
            sprintTeamIndex: undefined,
            sprintAcc:       undefined,
        });
    } catch (e) {
        return { status: 'ERROR', message: `Failed to save sprint results: ${e.message}` };
    }

    return {
        status:         'SUCCESS',
        portfolioKey,
        teamsProcessed: teamsWithSprints.length,
        message:        `✅ Sprint data collected for **${portfolioKey}** — ${teamsWithSprints.length} team(s) analysed.\n\n` +
            Object.entries(sprintsByTeam)
                .map(([t, d]) => d.error
                    ? `- **${t}**: ⚠️ ${d.error}`
                    : `- **${t}**: ${d.boardName} · ${d.sprints.length} sprint(s)`)
                .join('\n'),
    };
};
