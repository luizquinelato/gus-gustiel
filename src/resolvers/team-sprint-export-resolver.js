/**
 * Team Sprint Export Resolver — Confluence Export Skill
 *
 * Standalone export skill — NOT part of the portfolio ETL pipeline.
 * Exports a Sprint Analysis page to Confluence for one or more agile teams.
 *
 * ETL flow (strict layer separation — same extractors as team-sprint-resolver.js):
 *   EXTRACT   — discoverBoardIdForTeam()        (JQL-based boardId discovery, parallel)
 *   EXTRACT   — getRecentBoardClosedSprints()   (Board API — authoritative sprint list)
 *   EXTRACT   — fetchSprintReportsForTeams()    (GreenHopper + parse, shared semaphore)
 *   TRANSFORM — computeSprintTrends()           (per-team trend analytics)
 *   LOAD      — formatSprintSection()           (Confluence-ready markdown)
 *   LOAD      — confluencePageService           (destination resolution + upsert)
 *
 * No session or Forge Storage involved. Completes in a single Forge invocation.
 */

import { getEnvFromJira, getRecentBoardClosedSprints,
         getUserEmail, getCurrentAccountId }                from '../services/jira-api-service.js';
import { resolveDestination, buildPageStorageBody,
         upsertPage }                                       from '../services/confluence-page-service.js';
import { discoverBoardIdForTeam,
         fetchSprintReportsForTeams }                       from '../extractors/sprint-extractor.js';
import { computeSprintTrends }                             from '../transformers/portfolio-transformer.js';
import { formatSprintSection }                             from '../formatters/markdown-formatter.js';
import { REPORT_TIMEZONE }                                 from '../config/constants.js';

export const exportTeamSprint = async (event) => {
    const teamNamesRaw  = (event?.payload?.teamNames    || event?.teamNames    || '').trim();
    const spaceKey      = (event?.payload?.spaceKey     || event?.spaceKey     || '').trim().toUpperCase();
    const parentPath    = (event?.payload?.parentPath   || event?.parentPath   || '').trim();
    const folderId      = (event?.payload?.folderId     || event?.folderId     || '').trim();
    const newFolderTitle = (event?.payload?.newFolderTitle || event?.newFolderTitle || '').trim();
    const titleSuffix   = (event?.payload?.titleSuffix  || event?.titleSuffix  || '').trim();
    const accountId     = await getCurrentAccountId(event);

    if (!teamNamesRaw) return { status: 'ERROR', message: 'teamNames is required (comma-separated, e.g. "Titan, Bushido").' };
    if (!spaceKey)     return { status: 'ERROR', message: 'spaceKey is required (e.g. "PROJ").' };

    const teams = teamNamesRaw.split(',').map(t => t.trim()).filter(Boolean);

    try {
        // ── Environment ──────────────────────────────────────────────────────────
        const env          = await getEnvFromJira();
        const agileTeamNum = env.fields.agileTeam.replace('customfield_', '');
        const sprintField  = env.fields.sprint;
        const cutoffMs     = Date.now() - 6 * 30 * 24 * 60 * 60 * 1000;

        // ── EXTRACT 1: Board discovery — parallel across all teams ───────────────
        const boardDiscoveries = await Promise.all(
            teams.map(team => discoverBoardIdForTeam(team, agileTeamNum, sprintField)
                .then(r  => ({ team, boardId: r.boardId, error: null }))
                .catch(e => ({ team, boardId: null, error: e.message }))
            )
        );

        // ── EXTRACT 2: Sprint lists — parallel for teams that have boards ─────────
        const sprintMap = {};
        await Promise.all(
            boardDiscoveries.map(async ({ team, boardId, error }) => {
                if (!boardId) {
                    sprintMap[team] = { boardId: null, recentClosedSprints: [], error: error || 'No board found' };
                    return;
                }
                try {
                    const boardSprints = await getRecentBoardClosedSprints(boardId, 6);
                    const targetSprints = boardSprints.filter(s => s.endDate && new Date(s.endDate).getTime() >= cutoffMs);
                    sprintMap[team] = { boardId, recentClosedSprints: targetSprints };
                } catch (e) {
                    sprintMap[team] = { boardId, recentClosedSprints: [], error: e.message };
                }
            })
        );

        const teamsWithBoards = teams.filter(t => sprintMap[t]?.boardId && !sprintMap[t]?.error);

        // ── EXTRACT 3: GreenHopper sprint reports ─────────────────────────────────
        let reportsByTeam = {};
        if (teamsWithBoards.length > 0) {
            reportsByTeam = await fetchSprintReportsForTeams(teamsWithBoards, sprintMap);
        }

        // Build final sprintsByTeam (include error teams too)
        const sprintsByTeam = {};
        for (const team of teams) {
            if (sprintMap[team]?.error) {
                sprintsByTeam[team] = { error: sprintMap[team].error };
            } else {
                sprintsByTeam[team] = reportsByTeam[team] || { sprints: [], warning: 'No sprint data.' };
            }
        }

        // ── TRANSFORM — trend analytics per team ──────────────────────────────────
        const trendsByTeam = {};
        for (const team of teams) {
            const validSprints = (sprintsByTeam[team]?.sprints || []).filter(s => !s.error);
            trendsByTeam[team] = computeSprintTrends(validSprints);
        }

        // ── LOAD — assemble markdown + Confluence page ────────────────────────────
        const today     = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        const userEmail = await getUserEmail(accountId);
        const byClause  = userEmail ? ` by [${userEmail}]` : '';
        const teamLabel = titleSuffix || teams.join(', ');
        const pageTitle = `🏃 [${today}] Sprint Analysis — ${teamLabel}${byClause}`;

        const sprintSection = formatSprintSection(teams, sprintsByTeam, trendsByTeam);
        const fullMarkdown  = `# 🏃 Sprint Analysis — ${teamLabel}\n\n${sprintSection}`;

        const storageBody = buildPageStorageBody(fullMarkdown);
        const { space, parentId, parentIsFolder } = await resolveDestination(spaceKey, folderId, newFolderTitle, parentPath);
        const { pageUrl, wasUpdated, wasMoved }   = await upsertPage(space, env, spaceKey, pageTitle, storageBody, parentId, parentIsFolder);

        return {
            status:          'SUCCESS',
            teams,
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
        console.error(`[ExportTeamSprint] Error for "${teamNamesRaw}": ${e.message}`);
        return { status: 'ERROR', message: `Sprint export failed for **${teamNamesRaw}**: ${e.message}` };
    }
};
