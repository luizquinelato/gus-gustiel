/**
 * Team Lead Time / Cycle Time Export Resolver — Confluence Export Skill
 *
 * Standalone export skill — NOT part of the portfolio ETL pipeline.
 * Exports a Lead Time / Cycle Time Analysis page to Confluence for one or more agile teams.
 *
 * ETL flow (strict layer separation — reuses same functions as lead-time-resolver.js):
 *   EXTRACT   — searchJira() with changelog expansion
 *   EXTRACT   — extractItemForLCT()               (shared with lead-time-resolver.js)
 *   TRANSFORM — mergeItemsIntoLCTAccumulator()    (shared with lead-time-resolver.js)
 *   TRANSFORM — finalizeLCTAccumulator()          (shared with lead-time-resolver.js)
 *   LOAD      — formatLCTSection()                (Confluence-ready markdown)
 *   LOAD      — confluencePageService             (destination resolution + upsert)
 *
 * No session or Forge Storage involved. Completes in a single Forge invocation.
 * For large portfolios (>5 teams), use the full ETL pipeline instead.
 */

import { getEnvFromJira, searchJira,
         getUserEmail, getCurrentAccountId }                from '../services/jira-api-service.js';
import { resolveDestination, buildPageStorageBody,
         upsertPage }                                       from '../services/confluence-page-service.js';
import { PORTFOLIO_WORKFLOWS, REPORT_TIMEZONE }            from '../config/constants.js';
import { extractItemForLCT }                               from '../extractors/jira-extractor.js';
import { mergeItemsIntoLCTAccumulator,
         finalizeLCTAccumulator }                          from '../transformers/portfolio-transformer.js';
import { formatLCTSection }                               from '../formatters/markdown-formatter.js';

export const exportTeamLeadTime = async (event) => {
    const teamNamesRaw   = (event?.payload?.teamNames     || event?.teamNames     || '').trim();
    const spaceKey       = (event?.payload?.spaceKey      || event?.spaceKey      || '').trim().toUpperCase();
    const parentPath     = (event?.payload?.parentPath    || event?.parentPath    || '').trim();
    const folderId       = (event?.payload?.folderId      || event?.folderId      || '').trim();
    const newFolderTitle = (event?.payload?.newFolderTitle || event?.newFolderTitle || '').trim();
    const titleSuffix    = (event?.payload?.titleSuffix   || event?.titleSuffix   || '').trim();
    const accountId      = await getCurrentAccountId(event);

    if (!teamNamesRaw) return { status: 'ERROR', message: 'teamNames is required (comma-separated, e.g. "Titan, Bushido").' };
    if (!spaceKey)     return { status: 'ERROR', message: 'spaceKey is required (e.g. "PROJ").' };

    const teams = teamNamesRaw.split(',').map(t => t.trim()).filter(Boolean);

    try {
        // ── Environment ──────────────────────────────────────────────────────────
        const env               = await getEnvFromJira();
        const fields            = env.fields;
        const agileTeamFieldNum = fields.agileTeam.replace('customfield_', '');

        // ── JQL — same as portfolio LCT step, scoped to requested teams ──────────
        const teamList = teams.map(t => `"${t}"`).join(', ');
        const jql = [
            `hierarchyLevel in (0, 1)`,
            `AND cf[${agileTeamFieldNum}] in (${teamList})`,
            `AND ((statusCategory = Done AND updated >= -180d) OR statusCategory = "In Progress")`,
        ].join(' ');

        console.log(`[ExportTeamLeadTime] teams="${teams.join(', ')}" JQL="${jql}"`);

        // ── EXTRACT ───────────────────────────────────────────────────────────────
        const rawIssues = await searchJira(
            jql,
            [fields.agileTeam, 'status', 'issuetype', 'summary'],
            ['changelog'],
            100,
            500
        );

        console.log(`[ExportTeamLeadTime] fetched ${rawIssues.length} items`);

        // ── TRANSFORM ─────────────────────────────────────────────────────────────
        const acc = {};
        const extracted = rawIssues.map(raw => extractItemForLCT(raw, fields.agileTeam));
        mergeItemsIntoLCTAccumulator(extracted, PORTFOLIO_WORKFLOWS.STORY, PORTFOLIO_WORKFLOWS.EPIC, acc);
        const { lctByTeam } = finalizeLCTAccumulator(acc, teams);

        // Build teamStats in the format expected by formatLCTSection
        const teamStats = {};
        for (const team of teams) {
            teamStats[team] = { lct: lctByTeam[team] };
        }

        // ── LOAD — assemble markdown ───────────────────────────────────────────────
        const today     = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        const userEmail = await getUserEmail(accountId);
        const byClause  = userEmail ? ` by [${userEmail}]` : '';
        const teamLabel = titleSuffix || teams.join(', ');
        const pageTitle = `⏱️ [${today}] Lead Time / Cycle Time — ${teamLabel}${byClause}`;

        // standalone=true: section heading = H2, teams = H3 (H1 is the page title)
        const lctSection   = formatLCTSection(teams, teamStats, true, true, true);
        const fullMarkdown = `# ⏱️ Lead Time / Cycle Time — ${teamLabel}\n\n${lctSection}`;

        const storageBody = buildPageStorageBody(fullMarkdown);
        const { space, parentId, parentIsFolder } = await resolveDestination(spaceKey, folderId, newFolderTitle, parentPath);
        const { pageUrl, wasUpdated, wasMoved }   = await upsertPage(space, env, spaceKey, pageTitle, storageBody, parentId, parentIsFolder);

        return {
            status:          'SUCCESS',
            teams,
            itemCount:       rawIssues.length,
            pageTitle,
            pageUrl,
            spaceKey,
            parentPath:      parentPath || null,
            resolvedFolderId: parentIsFolder ? parentId : null,
            wasUpdated,
            wasMoved,
            environment:     env.name,
        };

    } catch (e) {
        console.error(`[ExportTeamLeadTime] Error for "${teamNamesRaw}": ${e.message}`);
        return { status: 'ERROR', message: `Lead Time / Cycle Time export failed for **${teamNamesRaw}**: ${e.message}` };
    }
};
