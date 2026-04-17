/**
 * Chat Analysis Resolver — Interactive NEXT-based portfolio analysis.
 *
 * Delivers the same data as the Confluence portfolio report but in chat,
 * split across multiple "NEXT" confirmations so Rovo's token budget is
 * never exceeded.  All heavy Jira queries are read from the per-user
 * session cache (written by prepare-export-resolver + lead-time-resolver).
 * The only live Jira calls here are the fast Layer-1/2 fetches for
 * initiatives and epics (needed to build team groups and initiative tables).
 *
 * Sections delivered in order:
 *   1. summary       — Portfolio Summary tables + full Initiatives table
 *   2. epic_teams    — Epics-by-Team, ANALYSIS_TEAMS_PER_PAGE (7) teams per call
 *   3. velocity_lct  — Innovation Velocity + LCT, ANALYSIS_LCT_TEAMS_PER_PAGE (10) per call
 *
 * Action name: analyze-portfolio-chat
 * Input:  portfolioKey, section ("summary"|"epic_teams"|"velocity_lct"), teamOffset
 * Output: { status, section, markdown, hasMoreTeams, nextTeamOffset, nextSection,
 *            teamTotal, teamsDelivered, portfolioKey, objectiveTitle,
 *            counts, overdueCount, lctReady }
 */

import { storage }                                                from '@forge/api';
import { getEnvFromJira, searchJira,
         getCurrentAccountId }                                    from '../services/jira-api-service.js';
import { PORTFOLIO_WORKFLOWS, ANALYSIS_TEAMS_PER_PAGE,
         ANALYSIS_LCT_TEAMS_PER_PAGE }                            from '../config/constants.js';
import { extractItem, extractItemScope }                          from '../extractors/jira-extractor.js';
import { groupByStatusOrdered, buildCountMap,
         filterOverdue }                                          from '../transformers/portfolio-transformer.js';
import { formatProgress, formatStatusTable,
         formatStoryStatusTable, formatInitiativeTable,
         formatEpicsByTeam, formatInnovationVelocityByTeam,
         formatLCTSection, EPIC_RYG_LEGEND }                      from '../formatters/markdown-formatter.js';

const sessionKey = (accountId, portfolioKey) =>
    `export_session:${accountId}:${portfolioKey}`;

// ── Build teamStats object from session cache ─────────────────────────────────
function buildTeamStats(allTeams, epics, storyCountByEpic, session, lctReady) {
    const velocityByTeam = session?.velocityByTeam || {};
    const lctByTeam      = session?.lctByTeam      || {};
    const teamStats      = {};

    for (const team of allTeams) {
        const teamEpics       = epics.filter(e => e.agileTeam === team);
        const totalStories    = teamEpics.reduce((s, e) => s + (storyCountByEpic[e.key]?.total ?? 0), 0);
        const avgItemsPerEpic = teamEpics.length > 0
            ? Math.round(totalStories / teamEpics.length) : 0;

        teamStats[team] = { velocity: null, inProgressCount: 0, doneCount: 0, avgItemsPerEpic, lct: null };

        if (lctReady) {
            const v = velocityByTeam[team];
            if (v) {
                teamStats[team].velocity        = { averageDays: v.averageDays, epicCount: v.epicCount, zeroTimeKeys: v.zeroTimeKeys || [] };
                teamStats[team].inProgressCount = v.inProgressCount ?? 0;
                teamStats[team].doneCount       = v.doneCount       ?? 0;
                if (v.avgItemsPerEpic != null) teamStats[team].avgItemsPerEpic = v.avgItemsPerEpic;
            }
            if (lctByTeam[team]) teamStats[team].lct = lctByTeam[team];
        }
    }
    if (lctReady && session?.overallVelocity) teamStats._overall = session.overallVelocity;
    return teamStats;
}

// ── Main resolver ─────────────────────────────────────────────────────────────
export const chatAnalysisSection = async (event) => {
    const portfolioKey = (event?.payload?.portfolioKey || event?.portfolioKey || '').trim().toUpperCase();
    const section      = (event?.payload?.section      || event?.section      || 'summary').trim().toLowerCase();
    const teamOffset   = parseInt(event?.payload?.teamOffset || event?.teamOffset || '0', 10) || 0;
    const accountId    = await getCurrentAccountId(event);

    if (!portfolioKey) return { status: 'ERROR', message: 'portfolioKey is required.' };

    // ── Read session cache ────────────────────────────────────────────────────
    let session = null;
    try { session = await storage.get(sessionKey(accountId, portfolioKey)); } catch (_) {}

    const lctReady         = session?.phase === 'complete' && !!session.lctByTeam;
    const storyCountByEpic = session?.storyCountByEpic || {};
    const allStoriesCount  = session?.storyCount ?? 0;
    const allStoriesForTable = session?.storyStatusSummary
        ? Object.entries(session.storyStatusSummary).flatMap(([st, { count, statusCategoryKey }]) =>
            Array(count).fill({ status: st, statusCategoryKey }))
        : [];

    // ── Fetch environment ─────────────────────────────────────────────────────
    let env;
    try { env = await getEnvFromJira(); }
    catch (e) { return { status: 'ERROR', message: `Could not detect Jira environment: ${e.message}` }; }

    const fields          = env.fields;
    const qpFieldNumber   = fields.qpPlanningSessions.replace('customfield_', '');
    const fieldsToFetch   = ['summary', 'status', 'parent', fields.plannedStartDate, fields.startDate,
                             fields.agileTeam, fields.dueDate, fields.endDate, fields.qpPlanningSessions];
    const quarters        = session?.quarters || [];
    const hasQuarterFilter = quarters.length > 0;
    const quarterClause   = hasQuarterFilter
        ? ` AND cf[${qpFieldNumber}] in (${quarters.map(q => `"${q}"`).join(', ')})` : '';
    const quarterLabel    = hasQuarterFilter ? ` — filtered by **${quarters.join(', ')}**` : '';

    // ── Scope detection ───────────────────────────────────────────────────────
    const scopeItems = await searchJira(
        `key = "${portfolioKey}"`, ['summary', 'issuetype', 'parent', fields.agileTeam]);
    if (scopeItems.length === 0)
        return { status: 'NO_DATA', message: `No item found for key **${portfolioKey}**.`, portfolioKey };

    const { scope: detectedScope } = extractItemScope(scopeItems[0]);

    // ── Layer 1: Objective + Initiatives ─────────────────────────────────────
    const layer1Raw  = await searchJira(
        `(key = "${portfolioKey}" OR parent = "${portfolioKey}") ORDER BY issuetype DESC, status ASC`,
        fieldsToFetch);
    const layer1Items = layer1Raw.map(i => extractItem(i, fields));

    const objective   = layer1Items.find(i => i.key === portfolioKey) || null;
    let   initiatives = layer1Items.filter(i => i.key !== portfolioKey);

    if (detectedScope === 'objective' && initiatives.length === 0)
        return { status: 'NO_DATA', message: `No Initiatives found under **${portfolioKey}**.`, portfolioKey };

    // ── Layer 2: Epics ────────────────────────────────────────────────────────
    const parentKeys = detectedScope === 'initiative'
        ? [portfolioKey]
        : initiatives.map(i => i.key);

    const epicJql = parentKeys.length > 0
        ? `parent in (${parentKeys.map(k => `"${k}"`).join(', ')}) AND issuetype = Epic${quarterClause} ORDER BY status ASC`
        : null;
    const epics = epicJql
        ? (await searchJira(epicJql, fieldsToFetch)).map(i => extractItem(i, fields))
        : [];

    const epicCountByInitiative = buildCountMap(epics, e => e.parentKey, e => e.statusCategoryKey === 'done');
    if (hasQuarterFilter && epics.length > 0) {
        const withEpics = new Set(epics.map(e => e.parentKey).filter(Boolean));
        initiatives     = initiatives.filter(i => withEpics.has(i.key));
    }

    const allTeams        = [...new Set(epics.map(e => e.agileTeam).filter(Boolean))].sort();
    const teamStats       = buildTeamStats(allTeams, epics, storyCountByEpic, session, lctReady);
    const overdueInitiatives = filterOverdue(initiatives);
    const overdueEpics       = filterOverdue(epics);
    const objectiveTitle     = objective?.summary || portfolioKey;
    const doneInits          = initiatives.filter(i => i.statusCategoryKey === 'done').length;
    const objectiveProgress  = !hasQuarterFilter ? formatProgress(doneInits, initiatives.length) : null;

    const baseCounts   = { initiatives: initiatives.length, epics: epics.length, stories: allStoriesCount };
    const baseOverdue  = { initiatives: overdueInitiatives.length, epics: overdueEpics.length };

    const noLctNote = !lctReady && allTeams.length > 0
        ? `> ⚠️ **Lead and Cycle Time data not ready.** Run **prepare-portfolio-export** then **calculate-lead-time-data** for **${portfolioKey}** to populate velocity and lead/cycle time metrics.\n\n`
        : '';

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION: summary
    // ══════════════════════════════════════════════════════════════════════════
    if (section === 'summary') {
        const initiativeCounts = groupByStatusOrdered(initiatives, PORTFOLIO_WORKFLOWS.INITIATIVE);
        const epicCounts       = groupByStatusOrdered(epics,       PORTFOLIO_WORKFLOWS.EPIC);

        const lines = [
            `# ${portfolioKey} — ${objectiveTitle}`,
            '',
            `**Portfolio:** [${portfolioKey}](${env.baseUrl}/browse/${portfolioKey}) · **Env:** ${env.name}${quarterLabel}`,
            '',
            '## 📋 Portfolio Summary',
            '',
            ...(objectiveProgress
                ? [`🎯 **Objective Progress:** ${objectiveProgress} initiatives done`, '', '---', ''] : []),
            `### Initiatives (${initiatives.length})`,
            formatStatusTable(initiativeCounts),
            '',
            `### Epics (${epics.length})`,
            formatStatusTable(epicCounts),
            '',
            `### Stories (${allStoriesCount})`,
            formatStoryStatusTable(allStoriesForTable, PORTFOLIO_WORKFLOWS.STORY),
            '',
            '---',
            '',
            `## 📌 Initiatives (${initiatives.length})`,
            hasQuarterFilter
                ? `> ⚠️ **% Complete reflects the selected quarter (${quarters.join(', ')}) only.**`
                : `> ℹ️ **% Complete shows all epics across all quarters for each initiative.**`,
            '',
            formatInitiativeTable(initiatives, env.baseUrl, epicCountByInitiative),
        ].join('\n');

        const nextSect = allTeams.length > 0 ? 'epic_teams' : (lctReady ? 'velocity_lct' : 'done');
        return {
            status: 'SUCCESS', section: 'summary', portfolioKey, objectiveTitle, lctReady,
            markdown: lines, teamTotal: allTeams.length, teamsDelivered: 0,
            hasMoreTeams: false, nextSection: nextSect, nextTeamOffset: 0,
            counts: baseCounts, overdueCount: baseOverdue,
        };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION: epic_teams
    // ══════════════════════════════════════════════════════════════════════════
    if (section === 'epic_teams') {
        const pageTeams  = allTeams.slice(teamOffset, teamOffset + ANALYSIS_TEAMS_PER_PAGE);
        const pageEpics  = epics.filter(e => pageTeams.includes(e.agileTeam));
        const teamSects  = formatEpicsByTeam(pageEpics, env.baseUrl, PORTFOLIO_WORKFLOWS.EPIC, storyCountByEpic);
        const fromNum    = teamOffset + 1;
        const toNum      = Math.min(teamOffset + ANALYSIS_TEAMS_PER_PAGE, allTeams.length);
        const hasMore    = toNum < allTeams.length;

        const lines = [
            `## 🏆 Epics by Team — Teams ${fromNum}–${toNum} of ${allTeams.length}`,
            '',
            EPIC_RYG_LEGEND,
            '',
            ...teamSects.map(t => t.markdown),
        ].join('\n');

        return {
            status: 'SUCCESS', section: 'epic_teams', portfolioKey, objectiveTitle, lctReady,
            markdown: lines, teamTotal: allTeams.length, teamsDelivered: toNum,
            hasMoreTeams: hasMore,
            nextSection:    hasMore ? 'epic_teams'    : 'velocity_lct',
            nextTeamOffset: hasMore ? teamOffset + ANALYSIS_TEAMS_PER_PAGE : 0,
            counts: baseCounts, overdueCount: baseOverdue,
        };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION: velocity_lct
    // ══════════════════════════════════════════════════════════════════════════
    if (section === 'velocity_lct') {
        const pageTeams   = allTeams.slice(teamOffset, teamOffset + ANALYSIS_LCT_TEAMS_PER_PAGE);
        const isFirstPage = teamOffset === 0;
        const fromNum     = teamOffset + 1;
        const toNum       = Math.min(teamOffset + ANALYSIS_LCT_TEAMS_PER_PAGE, allTeams.length);
        const hasMore     = toNum < allTeams.length;

        let lines;
        if (isFirstPage) {
            // First page: overall summary + velocity table (all teams) + LCT for first batch
            lines = [
                '## 🚀 Innovation Velocity & Lead/Cycle Time',
                '',
                noLctNote,
                // velocityOnly=true → legend + overall + velocity table only (no LCT tables)
                formatInnovationVelocityByTeam(allTeams, teamStats, lctReady, true),
                '',
                `### ⏱️ Lead / Cycle Time — Teams ${fromNum}–${toNum} of ${allTeams.length}`,
                '',
                formatLCTSection(pageTeams, teamStats, lctReady),
            ].join('\n');
        } else {
            // Subsequent pages: LCT for next batch of teams only
            lines = [
                `### ⏱️ Lead / Cycle Time — Teams ${fromNum}–${toNum} of ${allTeams.length}`,
                '',
                formatLCTSection(pageTeams, teamStats, lctReady),
            ].join('\n');
        }

        return {
            status: 'SUCCESS', section: 'velocity_lct', portfolioKey, objectiveTitle, lctReady,
            markdown: lines, teamTotal: allTeams.length, teamsDelivered: toNum,
            hasMoreTeams: hasMore,
            nextSection:    hasMore ? 'velocity_lct' : 'done',
            nextTeamOffset: hasMore ? teamOffset + ANALYSIS_LCT_TEAMS_PER_PAGE : 0,
            counts: baseCounts, overdueCount: baseOverdue,
        };
    }

    return { status: 'ERROR', message: `Unknown section "${section}". Valid values: summary, epic_teams, velocity_lct.` };
};
