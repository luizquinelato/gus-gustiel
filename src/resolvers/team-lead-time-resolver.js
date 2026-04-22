/**
 * Team Lead Time / Cycle Time Resolver — Chat Skill
 *
 * On-demand chat skill — NOT part of the Confluence export ETL pipeline.
 * Answers: "What's the lead time / cycle time for teams X and Y?"
 *
 * Accepts a comma-separated `teamNames` input so multiple teams can be
 * analyzed in a single Forge invocation (one JQL query, `in (...)` clause).
 *
 * ETL flow (strict layer separation):
 *   EXTRACT   — searchJira() with changelog expansion (reuses same JQL as portfolio LCT)
 *   EXTRACT   — extractItemForLCT()                 (shared with lead-time-resolver.js)
 *   TRANSFORM — mergeItemsIntoLCTAccumulator()      (shared with lead-time-resolver.js)
 *   TRANSFORM — finalizeLCTAccumulator()            (shared with lead-time-resolver.js)
 *   LOAD      — formatTeamLeadTimeChat()
 *
 * No session or Forge Storage involved. Completes in a single Forge invocation.
 * For large portfolios (>5 teams), use the full ETL pipeline instead.
 */

import { getEnvFromJira, searchJira }                                    from '../services/jira-api-service.js';
import { PORTFOLIO_WORKFLOWS }                                            from '../config/constants.js';
import { extractItemForLCT }                                             from '../extractors/jira-extractor.js';
import { mergeItemsIntoLCTAccumulator,
         finalizeLCTAccumulator }                                        from '../transformers/portfolio-transformer.js';
import { formatTeamLeadTimeChat }                                        from '../formatters/markdown-formatter.js';

export const getTeamLeadTime = async (event) => {
    const teamNamesRaw = (event?.payload?.teamNames || event?.teamNames || '').trim();

    if (!teamNamesRaw) {
        return { status: 'ERROR', message: 'teamNames is required. Provide one or more team names separated by commas (e.g. "Titan, Bushido").' };
    }

    const teams = teamNamesRaw.split(',').map(t => t.trim()).filter(Boolean);

    if (teams.length === 0) {
        return { status: 'ERROR', message: 'At least one valid team name is required.' };
    }

    try {
        // ── Environment ──────────────────────────────────────────────────────────
        const env               = await getEnvFromJira();
        const fields            = env.fields;
        const agileTeamFieldNum = fields.agileTeam.replace('customfield_', '');

        // ── JQL — same query as the portfolio LCT step, scoped to requested teams
        // hierarchyLevel in (0, 1) fetches both epics (velocity) and story-level items (LCT).
        const teamList = teams.map(t => `"${t}"`).join(', ');
        const jql = [
            `hierarchyLevel in (0, 1)`,
            `AND cf[${agileTeamFieldNum}] in (${teamList})`,
            `AND ((statusCategory = Done AND updated >= -180d) OR statusCategory = "In Progress")`,
        ].join(' ');

        console.log(`[TeamLeadTime] teams="${teams.join(', ')}" JQL="${jql}"`);

        // ── EXTRACT — fetch all matching items (changelog required for LCT calc) ─
        // Max 500 items: covers realistic single/multi-team standalone use.
        // For large portfolios use the full ETL pipeline (calculate-lead-time-data).
        const rawIssues = await searchJira(
            jql,
            [fields.agileTeam, 'status', 'issuetype', 'summary'],
            ['changelog'],
            100,   // page size
            500    // maxTotalResults
        );

        console.log(`[TeamLeadTime] fetched ${rawIssues.length} items`);

        if (rawIssues.length === 0) {
            return {
                status:  'NO_DATA',
                message: `No completed items found in the last 6 months for team${teams.length > 1 ? 's' : ''} **${teams.join(', ')}**. ` +
                         `Check the team name(s) or confirm items are assigned to the Agile Team field.`,
            };
        }

        // ── TRANSFORM ────────────────────────────────────────────────────────────
        const acc = {};
        const extracted = rawIssues.map(raw => extractItemForLCT(raw, fields.agileTeam));
        mergeItemsIntoLCTAccumulator(extracted, PORTFOLIO_WORKFLOWS.STORY, PORTFOLIO_WORKFLOWS.EPIC, acc);
        const { lctByTeam } = finalizeLCTAccumulator(acc, teams);

        // ── LOAD — render chat output ────────────────────────────────────────────
        const message = formatTeamLeadTimeChat(teams, lctByTeam);

        return {
            status:    'SUCCESS',
            teams,
            itemCount: rawIssues.length,
            lctByTeam,
            message,
        };

    } catch (e) {
        console.error(`[TeamLeadTime] Error for "${teamNamesRaw}": ${e.message}`);
        return {
            status:  'ERROR',
            message: `Lead Time / Cycle Time analysis failed for **${teamNamesRaw}**: ${e.message}`,
        };
    }
};
