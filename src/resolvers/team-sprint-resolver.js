/**
 * Team Sprint Analysis Resolver
 *
 * On-demand chat skill — NOT part of the Confluence export ETL pipeline.
 * Answers: "Show me the sprint velocity for team X."
 *
 * ETL flow (strict layer separation — all sprint I/O delegated to sprint-extractor):
 *   EXTRACT   — discoverBoardIdForTeam()        (JQL-based boardId discovery)
 *   EXTRACT   — getRecentBoardClosedSprints()   (Board API — authoritative sprint list)
 *   EXTRACT   — fetchSprintReportsForTeams()    (GreenHopper + parse, shared semaphore)
 *   LOAD      — formatTeamSprintChat()
 *
 * No session or Forge Storage involved. Completes in a single Forge invocation.
 */

import { getEnvFromJira,
         getRecentBoardClosedSprints }         from '../services/jira-api-service.js';
import { discoverBoardIdForTeam,
         fetchSprintReportsForTeams }          from '../extractors/sprint-extractor.js';
import { formatTeamSprintChat }               from '../formatters/markdown-formatter.js';

export const getTeamSprintAnalysis = async (event) => {
    const teamName = (event?.payload?.teamName || event?.teamName || '').trim();

    if (!teamName) {
        return { status: 'ERROR', message: 'teamName is required.' };
    }

    try {
        // ── Environment ──────────────────────────────────────────────────────────
        const env          = await getEnvFromJira();
        const agileTeamNum = env.fields.agileTeam.replace('customfield_', '');
        const sprintField  = env.fields.sprint;

        // ── EXTRACT 1: boardId discovery (shared extractor — two-pass JQL strategy)
        const { boardId } = await discoverBoardIdForTeam(teamName, agileTeamNum, sprintField);

        if (!boardId) {
            return {
                status:  'NO_DATA',
                message: `No sprint board found for team **${teamName}**. Check the team name or confirm stories are assigned to sprint boards.`,
            };
        }

        // ── EXTRACT 2: Sprint list — authoritative from Board API
        const cutoffMs      = Date.now() - 6 * 30 * 24 * 60 * 60 * 1000;
        const boardSprints  = await getRecentBoardClosedSprints(boardId, 6);
        const targetSprints = boardSprints
            .filter(s => s.endDate && new Date(s.endDate).getTime() >= cutoffMs);

        console.log(`[TeamSprintAnalysis] team="${teamName}" boardId=${boardId} targeted=${targetSprints.length} sprints: ${targetSprints.map(s => s.name).join(', ')}`);

        if (targetSprints.length === 0) {
            return {
                status:  'NO_DATA',
                message: `No closed sprints found in the last 6 months for team **${teamName}**. Check the team name or confirm stories are assigned to sprint boards.`,
            };
        }

        // ── EXTRACT 3: GreenHopper reports (shared extractor — semaphore rate-limiting)
        // Build a minimal newestSprintByTeam map so the shared function can be called
        // for a single team the same way the portfolio pipeline calls it for many.
        const sprintMap = { [teamName]: { boardId, recentClosedSprints: targetSprints } };
        const result    = await fetchSprintReportsForTeams([teamName], sprintMap);

        const { boardName, sprints, error: teamError } = result[teamName] || {};

        if (teamError) {
            return { status: 'ERROR', message: `Sprint report error for **${teamName}**: ${teamError}` };
        }

        // ── LOAD — render chat table
        const message = formatTeamSprintChat(teamName, boardName, boardId, sprints);

        return { status: 'SUCCESS', team: teamName, board: boardName, boardId, sprints, message };

    } catch (e) {
        console.error(`[TeamSprintAnalysis] Error for "${teamName}": ${e.message}`);
        return { status: 'ERROR', message: `Sprint analysis failed for **${teamName}**: ${e.message}` };
    }
};
