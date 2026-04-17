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

import { getEnvFromJira, searchJira }   from '../services/jira-api-service.js';
import { extractClosedSprints }          from '../extractors/jira-extractor.js';
import { computeSprintMetrics }          from '../transformers/portfolio-transformer.js';
import { formatTeamSprintChat }          from '../formatters/markdown-formatter.js';

export const getTeamSprintAnalysis = async (event) => {
    const teamName = (event?.payload?.teamName || event?.teamName || '').trim();

    if (!teamName) {
        return { status: 'ERROR', message: 'teamName is required.' };
    }

    try {
        // ── Environment ──────────────────────────────────────────────────────────
        const env           = await getEnvFromJira();
        const agileTeamNum  = env.fields.agileTeam.replace('customfield_', '');
        const sprintField   = env.fields.sprint;
        const storyPtsField = env.fields.storyPoints;

        // ── EXTRACT 1: Discovery — find active team issues to surface sprint history
        // Uses the user's JQL approach: active issues (not Done) ordered by most recent.
        // The sprint field on each issue contains the full sprint history for that story.
        const seedIssues = await searchJira(
            `cf[${agileTeamNum}] = "${teamName}" AND sprint is not null AND statusCategory != "Done" ORDER BY statusCategory desc, updated desc`,
            ['status', sprintField],
            [],   // no expand
            100,  // maxResults per page
            100   // maxTotalResults — 100 active issues is enough to discover all recent sprints
        );

        let targetSprints = extractClosedSprints(seedIssues, sprintField);

        // ── EXTRACT 1b: Fallback — if all stories are Done, seed from closed sprints directly
        if (targetSprints.length === 0) {
            const closedIssues = await searchJira(
                `cf[${agileTeamNum}] = "${teamName}" AND sprint in closedSprints() ORDER BY updated desc`,
                [sprintField],
                [], 50, 50
            );
            targetSprints = extractClosedSprints(closedIssues, sprintField);
        }

        if (targetSprints.length === 0) {
            return {
                status:  'NO_DATA',
                message: `No closed sprints found in the last 6 months for team **${teamName}**. Check the team name or confirm stories are assigned to sprint boards.`,
            };
        }

        // ── EXTRACT 2: Data — all team issues in those sprints (status + SP + sprint field)
        const sprintIds  = targetSprints.map(s => s.id).join(',');
        const dataIssues = await searchJira(
            `cf[${agileTeamNum}] = "${teamName}" AND sprint in (${sprintIds}) AND issuetype in standardIssueTypes()`,
            ['status', storyPtsField, sprintField]
        );

        // ── TRANSFORM — pure: compute velocity, rolled-over, planned, Say/Do per sprint
        const sprintResults = computeSprintMetrics(dataIssues, targetSprints, sprintField, storyPtsField);

        // ── LOAD — pure: render markdown table for chat display
        const message = formatTeamSprintChat(teamName, sprintResults);

        return { status: 'SUCCESS', team: teamName, sprints: sprintResults, message };

    } catch (e) {
        console.error(`[TeamSprintAnalysis] Error for "${teamName}": ${e.message}`);
        return { status: 'ERROR', message: `Sprint analysis failed for **${teamName}**: ${e.message}` };
    }
};
