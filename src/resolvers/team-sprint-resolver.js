/**
 * Team Sprint Analysis Resolver
 *
 * On-demand chat skill — NOT part of the Confluence export ETL pipeline.
 * Answers: "Show me the sprint velocity for team X."
 *
 * ETL flow (strict layer separation):
 *   EXTRACT   — searchJira (discovery) → extractClosedSprints()
 *   EXTRACT   — searchJira (data)
 *   TRANSFORM — computeSprintMetrics()
 *   LOAD      — formatTeamSprintChat()
 *
 * No session or Forge Storage involved. Completes in a single Forge invocation.
 */

import { getEnvFromJira, searchJira,
         getBoardById, getGreenHopperSprintReport } from '../services/jira-api-service.js';
import { extractClosedSprints }                    from '../extractors/jira-extractor.js';
import { parseGreenHopperSprintReport }            from '../transformers/portfolio-transformer.js';
import { formatTeamSprintChat }                    from '../formatters/markdown-formatter.js';

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

        // ── EXTRACT 1: Discovery — active issues reveal recent sprint objects + boardId
        const seedIssues = await searchJira(
            `cf[${agileTeamNum}] = "${teamName}" AND sprint is not null AND statusCategory != "Done" ORDER BY statusCategory desc, updated desc`,
            ['status', sprintField],
            [], 100, 100
        );

        let targetSprints = extractClosedSprints(seedIssues, sprintField);

        // ── EXTRACT 1b: Fallback — seed from closed sprints if team has no active work
        if (targetSprints.length === 0) {
            const closedIssues = await searchJira(
                `cf[${agileTeamNum}] = "${teamName}" AND sprint in closedSprints() ORDER BY updated desc`,
                [sprintField], [], 50, 50
            );
            targetSprints = extractClosedSprints(closedIssues, sprintField);
        }

        if (targetSprints.length === 0) {
            return {
                status:  'NO_DATA',
                message: `No closed sprints found in the last 6 months for team **${teamName}**. Check the team name or confirm stories are assigned to sprint boards.`,
            };
        }

        // boardId comes from the sprint field on the issue — same source, most recent sprint first
        const boardId = targetSprints[0]?.boardId;
        if (!boardId) {
            return { status: 'ERROR', message: `Could not resolve board ID for team **${teamName}**.` };
        }

        // ── EXTRACT 2: GreenHopper — board name + all sprint reports in one parallel wave
        const [boardMeta, ...reports] = await Promise.all([
            getBoardById(boardId),
            ...targetSprints.map(s => getGreenHopperSprintReport(boardId, s.id)),
        ]);
        const boardName = boardMeta?.name || `Board ${boardId}`;

        // ── TRANSFORM — parse each GreenHopper report (nulls become error rows)
        const sprintResults = reports.map((report, idx) => {
            const sprint = targetSprints[idx];
            if (!report) {
                console.warn(`[TeamSprintAnalysis] GreenHopper null for ${teamName} sprint ${sprint.id}`);
                return { id: sprint.id, name: sprint.name, endDate: sprint.endDate, error: 'Sprint report unavailable' };
            }
            return parseGreenHopperSprintReport(report, sprint);
        });

        // ── LOAD — render chat table with richer GreenHopper columns
        const message = formatTeamSprintChat(teamName, boardName, sprintResults);

        return { status: 'SUCCESS', team: teamName, board: boardName, sprints: sprintResults, message };

    } catch (e) {
        console.error(`[TeamSprintAnalysis] Error for "${teamName}": ${e.message}`);
        return { status: 'ERROR', message: `Sprint analysis failed for **${teamName}**: ${e.message}` };
    }
};
