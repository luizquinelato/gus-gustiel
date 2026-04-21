/**
 * Confluence Export Resolver — Entry/Exit Handler
 *
 * Exports one or more portfolio reports to a single Confluence page.
 * Accepts a comma-separated `portfolioKeys` list:
 *   • 1 key  → standard single-report page (same as before)
 *   • N keys → reports concatenated with "# KEY — Title" headings + "---" dividers
 *
 * ETL pipeline per key:
 *   Extract   → jira-extractor       (raw Jira API → domain objects)
 *   Transform → portfolio-transformer (calculations + data shaping)
 *   Load      → markdown-formatter + confluence-formatter (domain data → Confluence page)
 *
 * Returns: { status, portfolioKey, pageTitle, pageUrl, counts, overdueCount }
 */

import { storage }                                                                      from '@forge/api';
import { getEnvFromJira, searchJira, getUserEmail, getCurrentAccountId }                  from '../services/jira-api-service.js';
import { getSpaceByKey, findPageByTitle, createConfluencePage,
         updateConfluencePage, createFolder, findFolderByTitle,
         findOrCreatePageByPath }                                                   from '../services/confluence-api-service.js';
import { PORTFOLIO_WORKFLOWS, REPORT_TIMEZONE,
         makeSessionKey }                                    from '../config/constants.js';
import { extractItem, extractStoryStatus, chunk,
         extractItemScope }                                   from '../extractors/jira-extractor.js';
import { groupByStatusOrdered, buildCountMap,
         filterOverdue, computeSprintTrends }                from '../transformers/portfolio-transformer.js';
import { formatProgress, formatStatusTable,
         formatStoryStatusTable, formatInitiativeTable,
         formatEpicsByTeam,
         formatInnovationVelocityByTeam, formatLCTSection,
         formatSprintSection,
         EPIC_RYG_LEGEND }                                   from '../formatters/markdown-formatter.js';
import { markdownToStorage, buildTocMacro,
         buildAnchorMacro }                                   from '../formatters/confluence-formatter.js';

// ── Private helper — builds a trendsByTeam map from sprintsByTeam ─────────────
// Resolver is thin: just maps computeSprintTrends() across all teams.
// Returns null when sprintsByTeam is null/empty.
function buildTrendsByTeam(teams, sprintsByTeam) {
    if (!sprintsByTeam || !teams || teams.length === 0) return null;
    const result = {};
    for (const team of teams) {
        const data = sprintsByTeam[team];
        if (!data || data.error || !Array.isArray(data.sprints)) continue;
        const validSprints = data.sprints.filter(s => !s.error);
        result[team] = computeSprintTrends(validSprints);
    }
    return result;
}

// ── Private helper — full ETL for one portfolio key ──────────────────────────
// Returns { portfolioKey, objectiveTitle, markdown, counts, overdueCount }
// Returns null when no initiatives are found under the key (NO_DATA).
// accountId: used to read the per-user LCT session (written by calculate-lead-time-data).
export const buildReportForKey = async (portfolioKey, quarters, env, accountId) => {
    const fields           = env.fields;
    const qpFieldNumber    = fields.qpPlanningSessions.replace('customfield_', '');
    const fieldsToFetch    = ['summary', 'status', 'parent', fields.plannedStartDate, fields.startDate, fields.agileTeam, fields.dueDate, fields.endDate, fields.qpPlanningSessions];
    const hasQuarterFilter = quarters.length > 0;

    // ── SCOPE DETECTION — fetch the key itself to decide which ETL branch to use ──
    // Include agileTeam + parent so the Epic scope block can resolve team and LCT session.
    const scopeItems = await searchJira(`key = "${portfolioKey}"`, ['summary', 'issuetype', 'parent', fields.agileTeam]);
    if (scopeItems.length === 0) return null;
    const { scope: detectedScope, summary: scopeSummary } = extractItemScope(scopeItems[0]);

    // ── EPIC SCOPE (early return) ─────────────────────────────────────────────
    if (detectedScope === 'epic') {
        const epicDomain         = extractItem(scopeItems[0], fields);
        const epicTeam           = epicDomain.agileTeam;
        const epicParentKey      = epicDomain.parentKey; // initiative or objective key
        const storyQuarterClause = hasQuarterFilter ? ` AND cf[${qpFieldNumber}] in (${quarters.map(q => `"${q}"`).join(', ')})` : '';
        const quarterLabel       = hasQuarterFilter ? ` — filtered by **${quarters.join(', ')}**` : '';

        const allStories = (await searchJira(
            `parent = "${portfolioKey}" AND hierarchyLevel in (0, 1)${storyQuarterClause} ORDER BY status ASC`,
            ['status', 'parent']
        )).map(extractStoryStatus);

        // ── LCT / Velocity ────────────────────────────────────────────────────
        // LCT session data is keyed by the parent (initiative / objective) that was
        // analyzed with prepare-portfolio-export + calculate-lead-time-data.
        // Try the parent key first; fall back to the epic key itself (rare but possible).
        const allTeamsE  = epicTeam ? [epicTeam] : [];
        const teamStatsE = {};
        let   lctReadyE      = false;
        let   sprintsByTeamE = null;

        if (epicTeam) {
            const avgItemsPerEpic = allStories.length;
            teamStatsE[epicTeam] = { velocity: null, inProgressCount: 0, doneCount: 0, avgItemsPerEpic, lct: null };
            try {
                const sessionKeys = [
                    ...(epicParentKey ? [makeSessionKey(accountId, epicParentKey)] : []),
                    makeSessionKey(accountId, portfolioKey),
                ];
                // Read all candidate sessions up-front
                const sessions = [];
                for (const sk of sessionKeys) {
                    const s = await storage.get(sk);
                    if (s) sessions.push(s);
                }
                // Sprint data: take from the first session that has it, regardless of age
                const sprintSession = sessions.find(s => s.sprintsByTeam);
                if (sprintSession) sprintsByTeamE = sprintSession.sprintsByTeam;

                // LCT data: only from a recent, complete session
                const cached = sessions.find(s => s.phase === 'complete' && (Date.now() - s.timestamp) < 86_400_000) || null;
                if (cached) {
                    lctReadyE = true;
                    const v = cached.velocityByTeam?.[epicTeam];
                    if (v) {
                        teamStatsE[epicTeam].velocity        = { averageDays: v.averageDays, epicCount: v.epicCount, zeroTimeKeys: v.zeroTimeKeys || [] };
                        teamStatsE[epicTeam].inProgressCount = v.inProgressCount ?? 0;
                        teamStatsE[epicTeam].doneCount       = v.doneCount ?? 0;
                    }
                    if (cached.lctByTeam?.[epicTeam]) teamStatsE[epicTeam].lct = cached.lctByTeam[epicTeam];
                    teamStatsE._overall = cached.overallVelocity || null;
                }
            } catch (_) { /* LCT will show "No data" */ }
        }

        const markdown = [
            `# ${portfolioKey} — ${scopeSummary}`,
            '',
            `**Epic:** [${portfolioKey}](${env.baseUrl}/browse/${portfolioKey}) · **Env:** ${env.name}${quarterLabel}`,
            '',
            '## 📋 Epic Summary',
            '',
            `### Stories (${allStories.length})`,
            formatStoryStatusTable(allStories, PORTFOLIO_WORKFLOWS.STORY),
            '',
            '---',
            '',
            '## 🚀 Innovation Velocity',
            '',
            allTeamsE.length > 0
                ? formatInnovationVelocityByTeam(allTeamsE, teamStatsE, lctReadyE, true)
                : '> ℹ️ No team assigned to this epic — velocity data not available.',
            '',
            '---',
            '',
            '## ⏱️ Lead / Cycle Time',
            '',
            ...(!lctReadyE && allTeamsE.length > 0 ? [`> ⚠️ **Lead and Cycle Time data not available.** If you just ran the export, try refreshing — the calculation may still be processing. Otherwise, re-run the export to recompute.`, ''] : []),
            formatLCTSection(allTeamsE, teamStatsE, lctReadyE, false),
            '',
            '---',
            '',
            '## 🏃 Sprint Analysis',
            '',
            formatSprintSection(allTeamsE, sprintsByTeamE, buildTrendsByTeam(allTeamsE, sprintsByTeamE)),
            '',
            '[⬆ Back to top](#top)',
        ].join('\n');

        return {
            portfolioKey,
            objectiveTitle: scopeSummary,
            markdown,
            counts:       { initiatives: 0, epics: 1, stories: allStories.length },
            overdueCount: { initiatives: 0, epics: 0 },
        };
    }

    // ── INITIATIVE SCOPE (early return) ──────────────────────────────────────
    if (detectedScope === 'initiative') {
        const quarterClause      = hasQuarterFilter ? ` AND cf[${qpFieldNumber}] in (${quarters.map(q => `"${q}"`).join(', ')})` : '';
        const storyQuarterClause = hasQuarterFilter ? ` AND cf[${qpFieldNumber}] in (${quarters.map(q => `"${q}"`).join(', ')})` : '';
        const quarterLabel       = hasQuarterFilter ? ` — filtered by **${quarters.join(', ')}**` : '';

        const epicsI = (await searchJira(
            `parent = "${portfolioKey}" AND issuetype = Epic${quarterClause} ORDER BY status ASC`,
            fieldsToFetch
        )).map(i => extractItem(i, fields));
        if (epicsI.length === 0) return null;

        const allStoriesI = [];
        for (const epicChunk of chunk(epicsI.map(e => e.key), 50)) {
            const storyJql = `parent in (${epicChunk.map(k => `"${k}"`).join(', ')}) AND hierarchyLevel in (0, 1)${storyQuarterClause} ORDER BY status ASC`;
            allStoriesI.push(...(await searchJira(storyJql, ['status', 'parent'])).map(extractStoryStatus));
        }

        const storyCountByEpicI = buildCountMap(allStoriesI, s => s.parentKey, s => s.statusCategoryKey === 'done');
        const overdueEpicsI     = filterOverdue(epicsI);
        const allTeamsI         = [...new Set(epicsI.map(e => e.agileTeam).filter(Boolean))].sort();
        const teamStatsI        = {};
        let   lctReadyI         = false;
        let   sprintsByTeamI    = null;

        for (const team of allTeamsI) {
            const te = epicsI.filter(e => e.agileTeam === team);
            const avgItemsPerEpic = te.length > 0 ? Math.round(te.reduce((s, e) => s + (storyCountByEpicI[e.key]?.total ?? 0), 0) / te.length) : 0;
            teamStatsI[team] = { velocity: null, inProgressCount: 0, doneCount: 0, avgItemsPerEpic, lct: null };
        }
        if (allTeamsI.length > 0) {
            try {
                // Session is stored under whichever key was used with prepare-portfolio-export —
                // typically the parent objective. Try parent first, fall back to own key.
                const initiativeParentKey = extractItem(scopeItems[0], fields).parentKey;
                const sessionKeys = [
                    ...(initiativeParentKey ? [makeSessionKey(accountId, initiativeParentKey)] : []),
                    makeSessionKey(accountId, portfolioKey),
                ];
                const sessions = [];
                for (const sk of sessionKeys) {
                    const s = await storage.get(sk);
                    if (s) sessions.push(s);
                }
                // Sprint data: take from first session that has it (no TTL — historical)
                const sprintSession = sessions.find(s => s.sprintsByTeam);
                if (sprintSession) sprintsByTeamI = sprintSession.sprintsByTeam;
                // LCT: only from a recent, complete session
                const cached = sessions.find(s => s.phase === 'complete' && (Date.now() - s.timestamp) < 86_400_000) || null;
                if (cached) {
                    lctReadyI = true;
                    for (const team of allTeamsI) {
                        const v = cached.velocityByTeam?.[team];
                        if (teamStatsI[team] && v) {
                            teamStatsI[team].velocity        = { averageDays: v.averageDays, epicCount: v.epicCount, zeroTimeKeys: v.zeroTimeKeys || [] };
                            teamStatsI[team].inProgressCount = v.inProgressCount ?? 0;
                            teamStatsI[team].doneCount       = v.doneCount ?? 0;
                        }
                        if (teamStatsI[team] && cached.lctByTeam?.[team]) teamStatsI[team].lct = cached.lctByTeam[team];
                    }
                    teamStatsI._overall = cached.overallVelocity || null;
                }
            } catch (_) { /* LCT will show "No data" */ }
        }

        const epicCountsI   = groupByStatusOrdered(epicsI, PORTFOLIO_WORKFLOWS.EPIC);
        const teamSectionsI = formatEpicsByTeam(epicsI, env.baseUrl, PORTFOLIO_WORKFLOWS.EPIC, storyCountByEpicI);
        const markdownI = [
            `# ${portfolioKey} — ${scopeSummary}`,
            '',
            `**Initiative:** [${portfolioKey}](${env.baseUrl}/browse/${portfolioKey}) · **Env:** ${env.name}${quarterLabel}`,
            '',
            '## 📋 Initiative Summary',
            '',
            `### Epics (${epicsI.length})`,
            formatStatusTable(epicCountsI),
            '',
            `### Stories (${allStoriesI.length})`,
            formatStoryStatusTable(allStoriesI, PORTFOLIO_WORKFLOWS.STORY),
            '',
            '---',
            '',
            `## 🏆 Epics by Team (${epicsI.length} epics · ${teamSectionsI.length} teams)`,
            '',
            EPIC_RYG_LEGEND,
            '',
            ...teamSectionsI.map(t => t.markdown),
            '',
            '---',
            '',
            '## 🚀 Innovation Velocity',
            '',
            formatInnovationVelocityByTeam(allTeamsI, teamStatsI, lctReadyI, true),
            '',
            '---',
            '',
            '## ⏱️ Lead / Cycle Time',
            '',
            ...(!lctReadyI && allTeamsI.length > 0 ? [`> ⚠️ **Lead and Cycle Time data not available.** If you just ran the export, try refreshing — the calculation may still be processing. Otherwise, re-run the export to recompute.`, ''] : []),
            formatLCTSection(allTeamsI, teamStatsI, lctReadyI, false),
            '',
            '---',
            '',
            '## 🏃 Sprint Analysis',
            '',
            formatSprintSection(allTeamsI, sprintsByTeamI, buildTrendsByTeam(allTeamsI, sprintsByTeamI)),
            '',
            '[⬆ Back to top](#top)',
        ].join('\n');

        return {
            portfolioKey,
            objectiveTitle: scopeSummary,
            markdown: markdownI,
            counts:       { initiatives: 0, epics: epicsI.length, stories: allStoriesI.length },
            overdueCount: { initiatives: 0, epics: overdueEpicsI.length },
        };
    }

    // ── EXTRACT — Layer 1: Objective + ALL Initiatives ────────────────────
    const layer1Jql   = `(key = "${portfolioKey}" OR parent = "${portfolioKey}") ORDER BY issuetype DESC, status ASC`;
    const layer1Items = (await searchJira(layer1Jql, fieldsToFetch)).map(i => extractItem(i, fields));

    const objective   = layer1Items.find(i => i.key === portfolioKey) || null;
    let   initiatives = layer1Items.filter(i => i.key !== portfolioKey);

    if (initiatives.length === 0) return null;

    // Layer 2: Epics (optional quarter filter)
    const quarterClause = hasQuarterFilter ? ` AND cf[${qpFieldNumber}] in (${quarters.map(q => `"${q}"`).join(', ')})` : '';
    const epicJql       = `parent in (${initiatives.map(i => `"${i.key}"`).join(', ')}) AND issuetype = Epic${quarterClause} ORDER BY status ASC`;
    const epics         = (await searchJira(epicJql, fieldsToFetch)).map(i => extractItem(i, fields));

    const epicCountByInitiative = buildCountMap(epics, e => e.parentKey, e => e.statusCategoryKey === 'done');

    if (hasQuarterFilter && epics.length > 0) {
        const withEpics = new Set(epics.map(e => e.parentKey).filter(Boolean));
        initiatives = initiatives.filter(i => withEpics.has(i.key));
    }

    // Layer 3: Story counts — read from pre-computed session (written by prepare-export-resolver).
    // Avoids re-fetching hundreds of stories at export time, which causes the 25s timeout.
    // storyCountByEpic shape: { [epicKey]: { total, done } }
    // allStoriesCount is used only for the display counter in the markdown.
    // Both fall back gracefully when the session has no story data (legacy / cold cache).
    let cachedSession = null;
    try {
        cachedSession = await storage.get(makeSessionKey(accountId, portfolioKey));
    } catch (_) { /* ignore; we'll re-fetch below */ }

    let storyCountByEpic;
    let allStoriesCount = 0;

    // allStoriesForTable reconstructed from compact summary (one entry per unique status).
    // Using Array(count).fill(obj) is safe here — formatStoryStatusTable only reads the objects.
    let allStoriesForTable = [];

    if (cachedSession?.storyCountByEpic) {
        storyCountByEpic = cachedSession.storyCountByEpic;
        allStoriesCount  = cachedSession.storyCount ?? 0;
        if (cachedSession.storyStatusSummary) {
            allStoriesForTable = Object.entries(cachedSession.storyStatusSummary)
                .flatMap(([status, { count, statusCategoryKey }]) =>
                    Array(count).fill({ status, statusCategoryKey })
                );
        }
    } else {
        // Fallback: session missing or old — fetch stories inline (may be slow for large portfolios)
        // Mirrors the same Layer 3 logic as the analysis/report/prepare resolvers:
        // hierarchyLevel in (0, 1) + QP filter when active.
        const storyQuarterClause = hasQuarterFilter
            ? ` AND cf[${qpFieldNumber}] in (${quarters.map(q => `"${q}"`).join(', ')})`
            : '';
        const allStories = [];
        if (epics.length > 0) {
            for (const epicChunk of chunk(epics.map(e => e.key), 50)) {
                const storyJql = `parent in (${epicChunk.map(k => `"${k}"`).join(', ')}) AND hierarchyLevel in (0, 1)${storyQuarterClause} ORDER BY status ASC`;
                allStories.push(...(await searchJira(storyJql, ['status', 'parent'])).map(extractStoryStatus));
            }
        }
        storyCountByEpic   = buildCountMap(allStories, s => s.parentKey, s => s.statusCategoryKey === 'done');
        allStoriesCount    = allStories.length;
        allStoriesForTable = allStories;
    }

    // Transform
    const initiativeCounts   = groupByStatusOrdered(initiatives, PORTFOLIO_WORKFLOWS.INITIATIVE);
    const epicCounts         = groupByStatusOrdered(epics, PORTFOLIO_WORKFLOWS.EPIC);
    const overdueInitiatives = filterOverdue(initiatives);
    const overdueEpics       = filterOverdue(epics);
    const doneInitiatives    = initiatives.filter(i => i.statusCategoryKey === 'done').length;
    const objectiveProgress  = !hasQuarterFilter ? formatProgress(doneInitiatives, initiatives.length) : null;

    // ── Layers 4 + 5: Innovation Velocity + LCT from pre-computed session ────
    // The Confluence export NEVER re-runs the heavy changelog query.
    // Both velocityByTeam and lctByTeam are read from the per-user session
    // written by calculate-lead-time-data (or the legacy fallback from
    // reportPortfolio / analyzePortfolio).  This avoids the 25-second timeout.
    const allTeams     = [...new Set(epics.map(e => e.agileTeam).filter(Boolean))].sort();
    const teamStats    = {};
    let   lctReady     = false;
    let   sprintsByTeam = null;

    if (allTeams.length > 0) {
        // Initialise per-team slots with avgItemsPerEpic from Layer 2/3 data
        for (const team of allTeams) {
            const teamEpicsL2  = epics.filter(e => e.agileTeam === team);
            const totalStories = teamEpicsL2.reduce((sum, e) => sum + (storyCountByEpic[e.key]?.total ?? 0), 0);
            const avgItemsPerEpic = teamEpicsL2.length > 0 ? Math.round(totalStories / teamEpicsL2.length) : 0;
            teamStats[team] = { velocity: null, inProgressCount: 0, doneCount: 0, avgItemsPerEpic, lct: null };
        }

        const LCT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
        try {
            // Per-user session written by calculate-lead-time-data
            const cached = await storage.get(makeSessionKey(accountId, portfolioKey));

            // Sprint data: always read — historical metrics don't expire after 24h
            if (cached?.sprintsByTeam) sprintsByTeam = cached.sprintsByTeam;

            if (cached && cached.phase === 'complete' && (Date.now() - cached.timestamp) < LCT_CACHE_TTL_MS) {
                lctReady = true;
                // Populate Innovation Velocity from session
                if (cached.velocityByTeam) {
                    for (const team of allTeams) {
                        const v = cached.velocityByTeam[team];
                        if (teamStats[team] && v) {
                            teamStats[team].velocity        = { averageDays: v.averageDays, epicCount: v.epicCount, zeroTimeKeys: v.zeroTimeKeys || [] };
                            teamStats[team].inProgressCount = v.inProgressCount ?? 0;
                            teamStats[team].doneCount       = v.doneCount       ?? 0;
                            if (v.avgItemsPerEpic != null) teamStats[team].avgItemsPerEpic = v.avgItemsPerEpic;
                        }
                    }
                    teamStats._overall = cached.overallVelocity || null;
                }
                // Populate LCT from session
                if (cached.lctByTeam) {
                    for (const team of allTeams) {
                        if (teamStats[team] && cached.lctByTeam[team]) {
                            teamStats[team].lct = cached.lctByTeam[team];
                        }
                    }
                }
            }
        } catch (_storageErr) {
            // Storage read failure — velocity and LCT will show "No data" via formatter.
        }
    }

    // Load — build Markdown for this key
    const objectiveTitle = objective?.summary || portfolioKey;
    const quarterLabel   = hasQuarterFilter ? ` — filtered by **${quarters.join(', ')}**` : '';
    const teamSections   = formatEpicsByTeam(epics, env.baseUrl, PORTFOLIO_WORKFLOWS.EPIC, storyCountByEpic);

    const markdown = [
        `# ${portfolioKey} — ${objectiveTitle}`,
        '',
        `**Portfolio:** [${portfolioKey}](${env.baseUrl}/browse/${portfolioKey}) · **Env:** ${env.name}${quarterLabel}`,
        '',
        '## 📋 Portfolio Summary',
        '',
        ...(objectiveProgress ? [`🎯 **Objective Progress:** ${objectiveProgress} initiatives done`, '', '---', ''] : []),
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
            ? `> ⚠️ **% Complete reflects the selected quarter (${quarters.join(', ')}) only.** Epics planned for other quarters are not counted.`
            : `> ℹ️ **% Complete shows all epics across all quarters for each initiative.**`,
        '',
        formatInitiativeTable(initiatives, env.baseUrl, epicCountByInitiative),
        '',
        '---',
        '',
        `## 🏆 Epics by Team (${epics.length} epics · ${teamSections.length} teams)`,
        '',
        EPIC_RYG_LEGEND,
        '',
        ...teamSections.map(t => t.markdown),
        '',
        '---',
        '',
        `## 🚀 Innovation Velocity`,
        '',
        formatInnovationVelocityByTeam(allTeams, teamStats, lctReady, true),
        '',
        '---',
        '',
        '## ⏱️ Lead / Cycle Time',
        '',
        ...(!lctReady && allTeams.length > 0 ? [`> ⚠️ **Lead and Cycle Time data not available.** If you just ran the export, try refreshing — the calculation may still be processing. Otherwise, re-run the export to recompute.`, ''] : []),
        formatLCTSection(allTeams, teamStats, lctReady, false),
        '',
        '---',
        '',
        '## 🏃 Sprint Analysis',
        '',
        formatSprintSection(allTeams, sprintsByTeam, buildTrendsByTeam(allTeams, sprintsByTeam)),
        '',
        '[⬆ Back to top](#top)',
    ].join('\n');

    return {
        portfolioKey,
        objectiveTitle,
        markdown,
        counts:       { initiatives: initiatives.length, epics: epics.length, stories: allStoriesCount },
        overdueCount: { initiatives: overdueInitiatives.length, epics: overdueEpics.length },
    };
};

// ── Private helper — truly merged ETL across multiple portfolio keys ───────────
// Fetches Layer 1-2 from Jira per-key (tagging each item with its sourceKey),
// reads combined story + LCT data from sessions, and returns a single unified
// merged report markdown using mergedMode formatters (Objective column visible).
export const buildMergedReport = async (allKeys, quarters, env, accountId) => {
    const fields           = env.fields;
    const qpFieldNumber    = fields.qpPlanningSessions.replace('customfield_', '');
    const fieldsToFetch    = ['summary', 'status', 'parent', fields.plannedStartDate, fields.startDate, fields.agileTeam, fields.dueDate, fields.endDate, fields.qpPlanningSessions];
    const hasQuarterFilter = quarters.length > 0;
    const quarterClause    = hasQuarterFilter ? ` AND cf[${qpFieldNumber}] in (${quarters.map(q => `"${q}"`).join(', ')})` : '';
    const quarterLabel     = hasQuarterFilter ? ` — filtered by **${quarters.join(', ')}**` : '';
    const primaryKey       = allKeys[0];

    // Fetch scope + parent key + title per key (single parallel batch — no extra round-trips)
    const keyTitles   = {};
    const scopeByKey  = {};
    const parentByKey = {};
    await Promise.all(allKeys.map(async k => {
        const items = await searchJira(`key = "${k}"`, ['summary', 'issuetype', 'parent']);
        keyTitles[k]  = items[0]?.fields?.summary || k;
        if (items[0]) {
            scopeByKey[k]  = extractItemScope(items[0]).scope;
            parentByKey[k] = items[0].fields?.parent?.key || null;
        }
    }));

    // Route keys by scope: objective (or unknown) keys supply initiatives via children;
    // initiative keys ARE Layer-1 items — their epics go straight to Layer 2.
    const objectiveKeys  = allKeys.filter(k => scopeByKey[k] !== 'initiative');
    const initiativeKeys = allKeys.filter(k => scopeByKey[k] === 'initiative');

    // Layer 1 — objective keys: fetch children → filter to non-key items = initiatives
    const layer1PerObjective = objectiveKeys.length > 0
        ? await Promise.all(objectiveKeys.map(k => searchJira(`(key = "${k}" OR parent = "${k}") ORDER BY issuetype DESC, status ASC`, fieldsToFetch)))
        : [];
    let allInitiatives = [];
    for (let i = 0; i < objectiveKeys.length; i++) {
        const k = objectiveKeys[i];
        const items = layer1PerObjective[i].map(raw => extractItem(raw, fields));
        allInitiatives = allInitiatives.concat(items.filter(item => item.key !== k).map(item => ({ ...item, sourceKey: k })));
    }

    // Layer 1 — initiative keys: initiative itself is the Layer-1 item; epics bypass Layer 2
    let directEpics = [];
    if (initiativeKeys.length > 0) {
        await Promise.all(initiativeKeys.map(async k => {
            const [initRaw, epicRaw] = await Promise.all([
                searchJira(`key = "${k}"`, fieldsToFetch),
                searchJira(`parent = "${k}" AND issuetype = Epic${quarterClause} ORDER BY status ASC`, fieldsToFetch),
            ]);
            const initItem = initRaw.map(r => extractItem(r, fields)).find(i => i.key === k);
            if (initItem) allInitiatives.push({ ...initItem, sourceKey: k });
            directEpics.push(...epicRaw.map(r => ({ ...extractItem(r, fields), sourceKey: k })));
        }));
    }

    if (allInitiatives.length === 0) return null;

    // Layer 2: epics for initiatives that came from objective keys (initiative-key epics already collected)
    const initiativeToKey = Object.fromEntries(allInitiatives.map(i => [i.key, i.sourceKey]));
    const objInitiatives  = allInitiatives.filter(i => objectiveKeys.includes(i.sourceKey));
    let allEpics = objInitiatives.length > 0
        ? (await searchJira(`parent in (${objInitiatives.map(i => `"${i.key}"`).join(', ')}) AND issuetype = Epic${quarterClause} ORDER BY status ASC`, fieldsToFetch))
              .map(raw => { const e = extractItem(raw, fields); return { ...e, sourceKey: initiativeToKey[e.parentKey] || primaryKey }; })
        : [];
    allEpics = [...allEpics, ...directEpics];

    // Quarter filter: keep only initiatives that have qualifying epics
    const epicCountByInitiative = buildCountMap(allEpics, e => e.parentKey, e => e.statusCategoryKey === 'done');
    let filteredInitiatives = [...allInitiatives];
    if (hasQuarterFilter && allEpics.length > 0) {
        const withEpics = new Set(allEpics.map(e => e.parentKey).filter(Boolean));
        filteredInitiatives = filteredInitiatives.filter(i => withEpics.has(i.key));
    }

    // Story counts — read from ALL key sessions and sum (each key's session holds its own story data)
    let storyCountByEpic = {}, allStoriesCount = 0, allStoriesForTable = [];
    let hasAnyCachedData = false;
    for (const key of allKeys) {
        try {
            const cached = await storage.get(makeSessionKey(accountId, key));
            if (cached?.storyCountByEpic) {
                hasAnyCachedData = true;
                Object.assign(storyCountByEpic, cached.storyCountByEpic);
                allStoriesCount += cached.storyCount ?? 0;
                if (cached.storyStatusSummary) {
                    Object.entries(cached.storyStatusSummary).forEach(([status, { count, statusCategoryKey }]) => {
                        for (let i = 0; i < count; i++) allStoriesForTable.push({ status, statusCategoryKey });
                    });
                }
            }
        } catch (_) {}
    }
    if (!hasAnyCachedData) {
        // Fallback: fetch inline (slow for large portfolios)
        const storyQClause = hasQuarterFilter ? ` AND cf[${qpFieldNumber}] in (${quarters.map(q => `"${q}"`).join(', ')})` : '';
        for (const epicChunk of chunk(allEpics.map(e => e.key), 50)) {
            const stories = (await searchJira(`parent in (${epicChunk.map(k => `"${k}"`).join(', ')}) AND hierarchyLevel in (0, 1)${storyQClause} ORDER BY status ASC`, ['status', 'parent'])).map(extractStoryStatus);
            allStoriesForTable.push(...stories);
            allStoriesCount += stories.length;
        }
        storyCountByEpic = buildCountMap(allStoriesForTable, s => s.parentKey, s => s.statusCategoryKey === 'done');
    }

    // Transform
    const initiativeCounts   = groupByStatusOrdered(filteredInitiatives, PORTFOLIO_WORKFLOWS.INITIATIVE);
    const epicCounts         = groupByStatusOrdered(allEpics, PORTFOLIO_WORKFLOWS.EPIC);
    const overdueInitiatives = filterOverdue(filteredInitiatives);
    const overdueEpics       = filterOverdue(allEpics);
    const doneInitiatives    = filteredInitiatives.filter(i => i.statusCategoryKey === 'done').length;
    const objectiveProgress  = !hasQuarterFilter ? formatProgress(doneInitiatives, filteredInitiatives.length) : null;

    // LCT + Sprint — merge teamStats and sprintsByTeam from all key sessions
    const allTeams     = [...new Set(allEpics.map(e => e.agileTeam).filter(Boolean))].sort();
    const teamStats    = {};
    let   lctReady     = false;
    let   sprintsByTeam = null;
    const LCT_TTL      = 24 * 60 * 60 * 1000;

    if (allTeams.length > 0) {
        for (const team of allTeams) {
            const te = allEpics.filter(e => e.agileTeam === team);
            const avg = te.length > 0 ? Math.round(te.reduce((s, e) => s + (storyCountByEpic[e.key]?.total ?? 0), 0) / te.length) : 0;
            teamStats[team] = { velocity: null, inProgressCount: 0, doneCount: 0, avgItemsPerEpic: avg, lct: null };
        }
        let combinedDays = 0, combinedCount = 0;
        // For initiative keys, also try the parent (objective) session where LCT/Sprint is stored.
        // Deduplicate so the same session is never read twice.
        const sessionKeysToRead = [...new Set([
            ...allKeys.map(k => makeSessionKey(accountId, k)),
            ...allKeys.filter(k => parentByKey[k]).map(k => makeSessionKey(accountId, parentByKey[k])),
        ])];
        for (const sk of sessionKeysToRead) {
            try {
                const cached = await storage.get(sk);
                if (!cached) continue;

                // Sprint data: always read — historical metrics don't expire after 24h
                if (cached.sprintsByTeam) {
                    sprintsByTeam = sprintsByTeam || {};
                    for (const [team, data] of Object.entries(cached.sprintsByTeam)) {
                        if (!sprintsByTeam[team]) sprintsByTeam[team] = data;
                    }
                }

                // LCT data: only from recent, complete sessions
                if (cached.phase !== 'complete' || (Date.now() - cached.timestamp) >= LCT_TTL) continue;
                lctReady = true;
                for (const team of allTeams) {
                    const v = cached.velocityByTeam?.[team];
                    if (teamStats[team] && v && !teamStats[team].velocity) {
                        teamStats[team].velocity        = { averageDays: v.averageDays, epicCount: v.epicCount, zeroTimeKeys: v.zeroTimeKeys || [] };
                        teamStats[team].inProgressCount = v.inProgressCount ?? 0;
                        teamStats[team].doneCount       = v.doneCount ?? 0;
                        if (v.avgItemsPerEpic != null) teamStats[team].avgItemsPerEpic = v.avgItemsPerEpic;
                    }
                    if (teamStats[team] && cached.lctByTeam?.[team] && !teamStats[team].lct)
                        teamStats[team].lct = cached.lctByTeam[team];
                }
                if (cached.overallVelocity) { combinedDays += cached.overallVelocity.averageDays * cached.overallVelocity.epicCount; combinedCount += cached.overallVelocity.epicCount; }
            } catch (_) {}
        }
        if (combinedCount > 0) teamStats._overall = { averageDays: Math.round(combinedDays / combinedCount), epicCount: combinedCount };
    }

    // Render — single unified merged markdown
    const combinedLabel = allKeys.join(' + ');
    const teamSections  = formatEpicsByTeam(allEpics, env.baseUrl, PORTFOLIO_WORKFLOWS.EPIC, storyCountByEpic, true);
    const markdown = [
        `# ${combinedLabel}`,
        '',
        `**Portfolio:** ${allKeys.map(k => `[${k}](${env.baseUrl}/browse/${k})`).join(', ')} · **Env:** ${env.name}${quarterLabel}`,
        '',
        '## 📋 Portfolio Summary',
        '',
        ...(objectiveProgress ? [`🎯 **Objective Progress:** ${objectiveProgress} initiatives done`, '', '---', ''] : []),
        `### Initiatives (${filteredInitiatives.length})`,
        formatStatusTable(initiativeCounts),
        '',
        `### Epics (${allEpics.length})`,
        formatStatusTable(epicCounts),
        '',
        `### Stories (${allStoriesCount})`,
        formatStoryStatusTable(allStoriesForTable, PORTFOLIO_WORKFLOWS.STORY),
        '',
        '---',
        '',
        `## 📌 Initiatives (${filteredInitiatives.length})`,
        hasQuarterFilter
            ? `> ⚠️ **% Complete reflects the selected quarter (${quarters.join(', ')}) only.** Epics planned for other quarters are not counted.`
            : `> ℹ️ **% Complete shows all epics across all quarters for each initiative.**`,
        '',
        formatInitiativeTable(filteredInitiatives, env.baseUrl, epicCountByInitiative, true),
        '',
        '---',
        '',
        `## 🏆 Epics by Team (${allEpics.length} epics · ${teamSections.length} teams)`,
        '',
        EPIC_RYG_LEGEND,
        '',
        ...teamSections.map(t => t.markdown),
        '',
        '---',
        '',
        `## 🚀 Innovation Velocity`,
        '',
        formatInnovationVelocityByTeam(allTeams, teamStats, lctReady, true),
        '',
        '---',
        '',
        '## ⏱️ Lead / Cycle Time',
        '',
        ...(!lctReady && allTeams.length > 0 ? [`> ⚠️ **Lead and Cycle Time data not available.** If you just ran the export, try refreshing — the calculation may still be processing. Otherwise, re-run the export to recompute.`, ''] : []),
        formatLCTSection(allTeams, teamStats, lctReady, false),
        '',
        '---',
        '',
        '## 🏃 Sprint Analysis',
        '',
        formatSprintSection(allTeams, sprintsByTeam, buildTrendsByTeam(allTeams, sprintsByTeam)),
        '',
        '[⬆ Back to top](#top)',
    ].join('\n');

    return {
        portfolioKey:  allKeys.join(', '),
        objectiveTitle: allKeys.map(k => keyTitles[k]).join(' · '),
        markdown,
        counts:       { initiatives: filteredInitiatives.length, epics: allEpics.length, stories: allStoriesCount },
        overdueCount: { initiatives: overdueInitiatives.length, epics: overdueEpics.length },
    };
};

export const exportToConfluence = async (event) => {
    // Support both `portfolioKeys` (new, multi-key) and `portfolioKey` (legacy, single-key).
    const portfolioKeysRaw = (event?.payload?.portfolioKeys || event?.portfolioKeys || event?.payload?.portfolioKey || event?.portfolioKey || '').trim().toUpperCase();
    const quartersRaw      = (event?.payload?.quarters      || event?.quarters      || '').trim();
    const spaceKey         = (event?.payload?.spaceKey       || event?.spaceKey       || '').trim().toUpperCase();
    const parentPath       = (event?.payload?.parentPath     || event?.parentPath     || '').trim();
    const folderId         = (event?.payload?.folderId       || event?.folderId       || '').trim();
    const newFolderTitle   = (event?.payload?.newFolderTitle || event?.newFolderTitle || '').trim();
    const titleSuffix      = (event?.payload?.titleSuffix    || event?.titleSuffix    || '').trim();
    const mode             = (event?.payload?.mode           || event?.mode           || 'merged').trim().toLowerCase();
    // Per-user session key — isolates each user's LCT cache from others'.
    const accountId        = await getCurrentAccountId(event);

    if (!portfolioKeysRaw) return { status: 'ERROR', message: 'Please provide at least one portfolio key (e.g. WX-1145).' };
    if (!spaceKey)         return { status: 'ERROR', message: 'Please provide a Confluence space key (e.g. PROJ).' };

    const portfolioKeys    = portfolioKeysRaw.split(',').map(k => k.trim()).filter(Boolean);
    const quarters         = quartersRaw ? quartersRaw.split(',').map(q => q.trim()).filter(Boolean) : [];
    const hasQuarterFilter = quarters.length > 0;

    // ── Fetch env once — shared by all keys ──────────────────────────────
    let env;
    try {
        env = await getEnvFromJira();
    } catch (envErr) {
        return { status: 'ERROR', message: `Could not detect Jira environment: ${envErr.message}`, portfolioKey: portfolioKeysRaw };
    }

    // ── ETL: route by key count + mode ──────────────────────────────────────
    const results    = [];
    const noDataKeys = [];

    if (portfolioKeys.length > 1 && mode === 'merged') {
        // Multi-key merged → single unified report with Objective column
        let result;
        try {
            result = await buildMergedReport(portfolioKeys, quarters, env, accountId);
        } catch (etlErr) {
            return { status: 'ERROR', message: `ETL failed for merged report: ${etlErr.message}`, portfolioKey: portfolioKeysRaw };
        }
        if (result) results.push(result);
        else noDataKeys.push(...portfolioKeys);
    } else {
        // Single key OR isolated multi-key → one complete report per key
        for (const key of portfolioKeys) {
            let result;
            try {
                result = await buildReportForKey(key, quarters, env, accountId);
            } catch (etlErr) {
                return { status: 'ERROR', message: `ETL failed for ${key}: ${etlErr.message}`, portfolioKey: key };
            }
            if (result) results.push(result);
            else noDataKeys.push(key);
        }
    }

    if (results.length === 0) {
        return {
            status:  'NO_DATA',
            message: `No Initiatives found under portfolio **${noDataKeys.join(', ')}**. Check the key(s) and try again.`,
        };
    }

    // ── LOAD — Assemble final Markdown ────────────────────────────────────
    // Both single-key and merged paths now produce a single result with the key H1 built-in.
    const today      = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); // "YYYY-MM-DD" in BRT
    let fullMarkdown, pageTitle;

    // Fetch requesting user's email to namespace the page title and prevent overwrites.
    const userEmail = await getUserEmail(accountId);
    const byClause  = userEmail ? ` by [${userEmail}]` : '';

    // Page title rules:
    //  • Single key   : titleSuffix (if given) or the key itself.
    //  • Multi-key    : "(Merged)" / "(Isolated)" is ALWAYS appended — even when titleSuffix is
    //                   provided — so the two combined-report types can never share the same title.
    let baseTitle;
    if (portfolioKeys.length === 1) {
        baseTitle = titleSuffix || portfolioKeys[0];
    } else {
        const modeLabel = mode === 'merged' ? '(Merged)' : '(Isolated)';
        baseTitle = titleSuffix
            ? `${titleSuffix} ${modeLabel}`
            : `${portfolioKeys.join(' + ')} ${modeLabel}`;
    }
    pageTitle = `📊 [${today}] ${baseTitle}${hasQuarterFilter ? ` (${quarters.join(', ')})` : ''}${byClause}`;

    // Each result's markdown already starts with '# KEY — Title' (H1).
    // Single / merged: one result, use directly.
    // Isolated multi-key: concatenate with --- dividers; strip trailing back-to-top
    // from all but the last (markdownToStorage auto-injects one before every H1 after the first).
    if (results.length === 1) {
        fullMarkdown = results[0].markdown;
    } else {
        fullMarkdown = results
            .map((r, idx) => idx < results.length - 1
                ? r.markdown.replace(/\n\[⬆ Back to top\]\(#top\)\s*$/, '')
                : r.markdown)
            .join('\n\n---\n\n');
    }

    // Aggregate counts across all keys
    const totalCounts  = results.reduce((acc, r) => ({
        initiatives: acc.initiatives + r.counts.initiatives,
        epics:       acc.epics       + r.counts.epics,
        stories:     acc.stories     + r.counts.stories,
    }), { initiatives: 0, epics: 0, stories: 0 });

    const totalOverdue = results.reduce((acc, r) => ({
        initiatives: acc.initiatives + r.overdueCount.initiatives,
        epics:       acc.epics       + r.overdueCount.epics,
    }), { initiatives: 0, epics: 0 });

    // ── LOAD — Convert to Confluence storage format, then upsert page ──────
    try {
        const space = await getSpaceByKey(spaceKey);

        // Prepend anchor + TOC macro.
        // Heading structure: H1 = portfolio key title, H2 = sections, H3 = sub-sections, H4 = LCT teams.
        // TOC covers levels 1–3; H4 team headings stay out of the TOC (they're fine inline).
        const anchor      = buildAnchorMacro('top');
        const toc         = buildTocMacro(1, 4);
        const now         = new Date();
        const createdAt   = new Intl.DateTimeFormat('en-CA', {
            timeZone: REPORT_TIMEZONE,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(now).replace(',', ''); // → "YYYY-MM-DD HH:MM"
        const tzLabel     = new Intl.DateTimeFormat('en', { timeZone: REPORT_TIMEZONE, timeZoneName: 'short' })
            .formatToParts(now).find(p => p.type === 'timeZoneName')?.value ?? REPORT_TIMEZONE;
        const storageBody = `<p>${anchor}<em>📅 <strong>Created at:</strong> ${createdAt} ${tzLabel}</em></p>` + '\n' + toc + '\n<hr/>\n' + markdownToStorage(fullMarkdown);

        // ── Resolve parentId ──────────────────────────────────────────────
        // Priority: folderId > newFolderTitle > parentPath > none (space root)
        let parentId       = null;
        let parentIsFolder = false;

        if (folderId) {
            parentId       = folderId;
            parentIsFolder = true;
        } else if (newFolderTitle) {
            // Try to create the folder. If Confluence rejects with 400 (name conflict),
            // fall back to a title search so the same newFolderTitle can be reused on
            // every re-export without the caller having to switch to folderId manually.
            // Any other HTTP error (403, 422, 5xx …) is surfaced immediately with the
            // real Confluence response so it is diagnosable.
            try {
                const folder = await createFolder(space.id, newFolderTitle);
                parentId       = String(folder.id);
                parentIsFolder = true;
            } catch (folderErr) {
                const errMsg    = folderErr?.message ?? String(folderErr);
                const isConflict = /HTTP 400/i.test(errMsg) || /already exist/i.test(errMsg);

                if (!isConflict) {
                    // Not a name-conflict — surface the real Confluence error directly.
                    throw new Error(`Could not create folder "${newFolderTitle}": ${errMsg}`);
                }

                // HTTP 400 → folder likely already exists; try to locate it by title.
                const existing = await findFolderByTitle(space.id, spaceKey, newFolderTitle);
                if (existing) {
                    parentId       = String(existing.id);
                    parentIsFolder = true;
                } else {
                    // Conflict but can't find it — surface the original error for diagnosis.
                    throw new Error(
                        `Could not create folder "${newFolderTitle}" (conflict) and could not locate it by title. ` +
                        `Original error: ${errMsg}. ` +
                        `Open the folder in Confluence, copy the numeric ID from the URL ` +
                        `(e.g. /folder/52592641 → "52592641"), and re-export using folderId instead of newFolderTitle.`
                    );
                }
            }
        } else if (parentPath) {
            parentId       = await findOrCreatePageByPath(space.id, parentPath);
            parentIsFolder = false;
        }

        // ── Upsert logic (3-tier) — same for single-key and combined ────────
        // 1. Scoped search → page exists at target location → update in-place.
        // 2. Space-wide search → page exists elsewhere → MOVE + refresh content.
        // 3. No match anywhere → create fresh page at target location.
        // Same-day re-exports (individual or combined) always replace the existing page.
        const existingAtTarget = await findPageByTitle(space.id, pageTitle, parentId, parentIsFolder);
        let page, wasUpdated = false, wasMoved = false;

        if (existingAtTarget) {
            page       = await updateConfluencePage(existingAtTarget.id, existingAtTarget.version.number, space.id, pageTitle, storageBody);
            wasUpdated = true;
        } else {
            const existingElsewhere = await findPageByTitle(space.id, pageTitle);
            if (existingElsewhere) {
                page       = await updateConfluencePage(existingElsewhere.id, existingElsewhere.version.number, space.id, pageTitle, storageBody, parentId || null);
                wasUpdated = true;
                wasMoved   = true;
            } else {
                page = await createConfluencePage(space.id, pageTitle, storageBody, parentId);
            }
        }

        const pageUrl = `${env.baseUrl}/wiki${page._links?.webui || `/spaces/${spaceKey}/pages/${page.id}`}`;

        return {
            status:           'SUCCESS',
            portfolioKey:     results.map(r => r.portfolioKey).join(', '),
            objectiveSummary: results.map(r => r.objectiveTitle).join(' · '),
            pageTitle,
            pageUrl,
            spaceKey,
            parentPath:       parentPath || null,
            // resolvedFolderId — pass this as folderId for subsequent exports that share
            // the same folder, preventing duplicate createFolder 400 errors.
            resolvedFolderId: parentIsFolder ? parentId : null,
            wasUpdated,
            wasMoved,
            environment:      env.name,
            counts:           totalCounts,
            overdueCount:     totalOverdue,
        };
    } catch (err) {
        return { status: 'ERROR', message: err.message, portfolioKey: portfolioKeysRaw };
    }
};

// ── createConfluenceFolder — create-confluence-folder action ─────────────────
// Creates a new Confluence folder (or locates an existing one with the same title).
// Must be called BEFORE any export-to-confluence calls that target the folder.
// Returns { status, folderId, folderTitle } so the agent can pass folderId to exports.
//
// status values:
//   CREATED  — folder was just created; folderId is its numeric ID
//   EXISTS   — a folder with that title already exists; folderId is its numeric ID
//   ERROR    — creation failed; message contains the Confluence API error
export const createConfluenceFolder = async (payload) => {
    const { spaceKey: rawSpaceKey = '', folderTitle = '' } = payload?.payload ?? payload ?? {};
    const spaceKey = String(rawSpaceKey).toUpperCase().trim();
    const title    = String(folderTitle).trim();

    if (!spaceKey) return { status: 'ERROR', message: 'spaceKey is required.' };
    if (!title)    return { status: 'ERROR', message: 'folderTitle is required.' };

    try {
        const space = await getSpaceByKey(spaceKey);

        // ── Check if the folder already exists before trying to create it ──
        const existing = await findFolderByTitle(space.id, spaceKey, title);
        if (existing) {
            return {
                status:      'EXISTS',
                folderId:    String(existing.id),
                folderTitle: existing.title,
                message:     `A folder named "${existing.title}" already exists in the ${spaceKey} space.`,
            };
        }

        // ── Folder not found — create it ──────────────────────────────────
        try {
            const folder = await createFolder(space.id, title);
            return {
                status:      'CREATED',
                folderId:    String(folder.id),
                folderTitle: folder.title ?? title,
            };
        } catch (createErr) {
            const errMsg    = createErr?.message ?? String(createErr);
            const isConflict = /HTTP 400/i.test(errMsg) || /already exist/i.test(errMsg);

            if (isConflict) {
                // Race: another call created it between our check and our create.
                // Try one more find attempt.
                const retry = await findFolderByTitle(space.id, spaceKey, title);
                if (retry) {
                    return {
                        status:      'EXISTS',
                        folderId:    String(retry.id),
                        folderTitle: retry.title,
                        message:     `Folder "${retry.title}" already exists in ${spaceKey} (found after conflict).`,
                    };
                }
                return {
                    status:  'ERROR',
                    message: `Could not create folder "${title}" — Confluence reported a conflict (HTTP 400) ` +
                             `but the folder could not be located by title. ` +
                             `Please open the folder in Confluence, copy its numeric ID from the URL ` +
                             `(e.g. /folder/52592641 → "52592641"), and use folderId directly in the export call.`,
                };
            }

            // Non-conflict error (e.g. 403, 422, 5xx) — surface the real message.
            return { status: 'ERROR', message: `Could not create folder "${title}": ${errMsg}` };
        }
    } catch (err) {
        return { status: 'ERROR', message: err.message };
    }
};
