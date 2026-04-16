/**
 * Prepare Export Resolver — Entry/Exit Handler
 *
 * Runs Layers 1–2 of the ETL pipeline for a portfolio key, extracts the list
 * of agile teams and key counts, and persists them to per-user Forge Storage
 * under the key: export_session:<accountId>:<portfolioKey>
 *
 * Phase written: 'layers_1_4'  (teams + counts available; LCT not yet computed)
 *
 * This is step 1 of the two-step fresh-extraction flow:
 *   1. prepare-portfolio-export  → discover teams, save metadata
 *   2. calculate-lead-time-data  → run heavy LCT query, finalise session
 *
 * The Confluence export then reads the complete session without re-running
 * any Jira queries.
 */

import { storage }                                        from '@forge/api';
import { getEnvFromJira, searchJira }                     from '../services/jira-api-service.js';
import { PORTFOLIO_WORKFLOWS }                            from '../config/constants.js';
import { extractItem, extractStoryStatus, chunk,
         extractItemScope }                               from '../extractors/jira-extractor.js';
import { buildCountMap }                                  from '../transformers/portfolio-transformer.js';

const sessionKey = (accountId, portfolioKey) =>
    `export_session:${accountId}:${portfolioKey}`;

/**
 * Scan raw story issues and return the newest sprint ID seen per team.
 * Used by Step 3 (calculate-sprint-data) to locate each team's board.
 *
 * @param {Array}  rawStories    - Raw Jira issue objects (must include sprint + parent fields)
 * @param {string} sprintField   - Custom field ID for sprint (e.g. 'customfield_10020')
 * @param {Object} epicKeyToTeam - Map of epicKey → agileTeamName
 * @returns {Object} { [teamName]: { id, name, endDate, startDate } }
 */
function extractNewestSprintIdByTeam(rawStories, sprintField, epicKeyToTeam) {
    const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;
    const sixMonthsAgo  = Date.now() - SIX_MONTHS_MS;

    // First pass: collect all unique sprints per team
    const raw = {}; // { [team]: { sprintMap: { [id]: sprint }, newest: sprint|null } }
    for (const issue of rawStories) {
        const sprints = issue.fields?.[sprintField];
        if (!Array.isArray(sprints) || sprints.length === 0) continue;

        const team = epicKeyToTeam[issue.fields?.parent?.key];
        if (!team) continue;

        if (!raw[team]) raw[team] = { sprintMap: {}, newest: null };

        for (const s of sprints) {
            if (!s.id || s.state === 'future') continue;
            raw[team].sprintMap[s.id] = s; // dedup by sprint id

            // Track the most recent non-future sprint for boardId + fallback info
            const sDate   = new Date(s.endDate || s.startDate).getTime();
            const curDate  = raw[team].newest ? new Date(raw[team].newest.endDate || raw[team].newest.startDate).getTime() : 0;
            if (sDate > curDate) raw[team].newest = s;
        }
    }

    // Second pass: build final result with pre-filtered recentClosedSprints
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

export const preparePortfolioExport = async (event) => {
    // portfolioKeys (comma-separated) enables multi-key mode; falls back to portfolioKey.
    const portfolioKeysRaw = (event?.payload?.portfolioKeys || event?.portfolioKeys || '').trim().toUpperCase();
    const portfolioKey     = (event?.payload?.portfolioKey  || event?.portfolioKey  || '').trim().toUpperCase();
    const quartersRaw      = (event?.payload?.quarters      || event?.quarters      || '').trim();
    const accountId        = event?.context?.accountId || 'shared';

    const allKeys = portfolioKeysRaw
        ? portfolioKeysRaw.split(',').map(k => k.trim()).filter(Boolean)
        : portfolioKey ? [portfolioKey] : [];

    if (allKeys.length === 0) {
        return { status: 'ERROR', message: 'portfolioKey is required.' };
    }

    const primaryKey          = allKeys[0];
    const portfolioKeyDisplay = allKeys.join(', ');
    const quarters            = quartersRaw ? quartersRaw.split(',').map(q => q.trim()).filter(Boolean) : [];
    const hasQuarterFilter    = quarters.length > 0;

    // ── Environment + field config ────────────────────────────────────────────
    const env               = await getEnvFromJira();
    const fields            = env.fields;
    const qpFieldNumber     = fields.qpPlanningSessions.replace('customfield_', '');
    const agileTeamFieldNum = fields.agileTeam.replace('customfield_', '');
    const fieldsToFetch     = ['summary', 'status', 'issuetype', 'parent', fields.plannedStartDate, fields.startDate,
                               fields.agileTeam, fields.dueDate, fields.endDate, fields.qpPlanningSessions];

    // ── EXTRACT — Layer 1: Portfolio item + direct children (per key, pooled) ─
    const layer1Results = await Promise.all(
        allKeys.map(k => searchJira(`(key = "${k}" OR parent = "${k}") ORDER BY issuetype DESC, status ASC`, fieldsToFetch))
    );
    const layer1Raw   = layer1Results.flat();
    const layer1Items = layer1Raw.map(i => extractItem(i, fields));

    const portfolioRaw      = layer1Raw.find(i => i.key === primaryKey);
    const { scope: detectedScope } = portfolioRaw ? extractItemScope(portfolioRaw) : { scope: 'unknown' };

    // ── EPIC SCOPE (early return) ─────────────────────────────────────────────
    // The provided key IS an epic — fetch its stories directly.
    if (detectedScope === 'epic') {
        const epicDomain = layer1Items.find(i => i.key === primaryKey) || null;
        const epicTeam   = epicDomain?.agileTeam || null;
        const allTeams   = epicTeam ? [epicTeam] : [];

        const storyQuarterClause = hasQuarterFilter
            ? ` AND cf[${qpFieldNumber}] in (${quarters.map(q => `"${q}"`).join(', ')})`
            : '';
        const rawStoriesE = await searchJira(
            `parent = "${portfolioKey}" AND hierarchyLevel in (0, 1)${storyQuarterClause} ORDER BY status ASC`,
            ['status', 'parent', fields.sprint]
        );
        const allStories = rawStoriesE.map(extractStoryStatus);
        const newestSprintIdByTeamE = epicTeam
            ? extractNewestSprintIdByTeam(rawStoriesE, fields.sprint, { [primaryKey]: epicTeam })
            : {};

        const storyCountByEpic = { [primaryKey]: { total: allStories.length, done: allStories.filter(s => s.statusCategoryKey === 'done').length } };
        const storyStatusSummary = allStories.reduce((acc, s) => {
            const k = s.status || 'Unknown';
            if (!acc[k]) acc[k] = { statusCategoryKey: s.statusCategoryKey, count: 0 };
            acc[k].count++;
            return acc;
        }, {});

        // In multi-key mode each key saves its own session independently
        const sessionData = {
            phase: 'layers_1_4', timestamp: Date.now(), portfolioKey: primaryKey,
            detectedScope: 'epic',
            objectiveTitle: epicDomain?.summary || primaryKey,
            quarters, allTeams, agileTeamFieldNum,
            initiativeCount: 0, epicCount: allKeys.length, storyCount: allStories.length,
            storyCountByEpic, storyStatusSummary,
            newestSprintIdByTeam: newestSprintIdByTeamE,
        };
        for (const k of allKeys) {
            try { await storage.set(sessionKey(accountId, k), sessionData); }
            catch (storeErr) { return { status: 'ERROR', message: `Failed to save session data for ${k}: ${storeErr.message}` }; }
        }
        return {
            status: 'SUCCESS', portfolioKey: portfolioKeyDisplay, phase: 'layers_1_4',
            objectiveSummary: sessionData.objectiveTitle,
            teamCount: allTeams.length, allTeams,
            initiativeCount: 0, epicCount: allKeys.length, storyCount: allStories.length,
            message: `✅ Extraction complete for **${portfolioKeyDisplay}** (Epic scope): ${allKeys.length} epic(s) · ${allStories.length} story/task(s) · ${allTeams.length} team(s) identified. Ready to calculate lead/cycle time data.`,
        };
    }

    // ── INITIATIVE SCOPE (early return) ──────────────────────────────────────
    if (detectedScope === 'initiative') {
        const quarterClause      = hasQuarterFilter ? ` AND cf[${qpFieldNumber}] in (${quarters.map(q => `"${q}"`).join(', ')})` : '';
        const storyQuarterClause = hasQuarterFilter ? ` AND cf[${qpFieldNumber}] in (${quarters.map(q => `"${q}"`).join(', ')})` : '';

        // Fetch epics per key independently, then pool
        const epicsPerKey = await Promise.all(allKeys.map(async k => {
            if (hasQuarterFilter) {
                const raw = await searchJira(`parent = "${k}" AND issuetype = Epic${quarterClause} ORDER BY status ASC`, fieldsToFetch);
                return raw.map(i => extractItem(i, fields));
            }
            return layer1Items.filter(i => i.key !== k && layer1Raw.find(r => r.key === i.key && r.fields?.parent?.key === k));
        }));
        const epicsI = epicsPerKey.flat();

        if (epicsI.length === 0) {
            return { status: 'NO_DATA', message: `No Epics found under **${portfolioKeyDisplay}**. Verify the key and try again.`, objectiveSummary: null };
        }

        const allStoriesI = [];
        const rawStoriesI = [];
        const epicKeyToTeamI = Object.fromEntries(epicsI.map(e => [e.key, e.agileTeam]).filter(([, t]) => t));
        for (const epicChunk of chunk(epicsI.map(e => e.key), 50)) {
            const storyJql = `parent in (${epicChunk.map(k => `"${k}"`).join(', ')}) AND hierarchyLevel in (0, 1)${storyQuarterClause} ORDER BY status ASC`;
            const batch = await searchJira(storyJql, ['status', 'parent', fields.sprint]);
            rawStoriesI.push(...batch);
            allStoriesI.push(...batch.map(extractStoryStatus));
        }
        const newestSprintIdByTeamI = extractNewestSprintIdByTeam(rawStoriesI, fields.sprint, epicKeyToTeamI);

        const storyCountByEpicI   = buildCountMap(allStoriesI, s => s.parentKey, s => s.statusCategoryKey === 'done');
        const storyStatusSummaryI = allStoriesI.reduce((acc, s) => { const k = s.status || 'Unknown'; if (!acc[k]) acc[k] = { statusCategoryKey: s.statusCategoryKey, count: 0 }; acc[k].count++; return acc; }, {});
        const allTeamsI           = [...new Set(epicsI.map(e => e.agileTeam).filter(Boolean))].sort();

        const sessionDataI = {
            phase: 'layers_1_4', timestamp: Date.now(), portfolioKey: primaryKey,
            detectedScope: 'initiative',
            objectiveTitle: layer1Items.find(i => allKeys.includes(i.key))?.summary || primaryKey,
            quarters, allTeams: allTeamsI, agileTeamFieldNum,
            initiativeCount: 0, epicCount: epicsI.length, storyCount: allStoriesI.length,
            storyCountByEpic: storyCountByEpicI, storyStatusSummary: storyStatusSummaryI,
            newestSprintIdByTeam: newestSprintIdByTeamI,
        };
        for (const k of allKeys) {
            try { await storage.set(sessionKey(accountId, k), sessionDataI); }
            catch (storeErr) { return { status: 'ERROR', message: `Failed to save session data for ${k}: ${storeErr.message}` }; }
        }
        return {
            status: 'SUCCESS', portfolioKey: portfolioKeyDisplay, phase: 'layers_1_4',
            objectiveSummary: sessionDataI.objectiveTitle,
            teamCount: allTeamsI.length, allTeams: allTeamsI,
            initiativeCount: 0, epicCount: epicsI.length, storyCount: allStoriesI.length,
            message: `✅ Extraction complete for **${portfolioKeyDisplay}** (Initiative scope): ${epicsI.length} epic(s) · ${allStoriesI.length} story/task(s) · ${allTeamsI.length} team(s) identified. Ready to calculate lead/cycle time data.`,
        };
    }

    // ── OBJECTIVE SCOPE — Layer 1–3 flow (per key, pooled) ───────────────────
    let   initiatives = layer1Items.filter(i => !allKeys.includes(i.key));

    if (initiatives.length === 0) {
        return {
            status: 'NO_DATA',
            message: `No Initiatives found under **${portfolioKeyDisplay}**. Verify the key and try again.`,
            objectiveSummary: layer1Items.find(i => allKeys.includes(i.key))?.summary || null,
        };
    }

    // ── EXTRACT — Layer 2: Epics (optional quarter filter) ───────────────────
    const quarterClause = hasQuarterFilter
        ? ` AND cf[${qpFieldNumber}] in (${quarters.map(q => `"${q}"`).join(', ')})`
        : '';
    const epicJql = `parent in (${initiatives.map(i => `"${i.key}"`).join(', ')}) AND issuetype = Epic${quarterClause} ORDER BY status ASC`;
    const epics   = (await searchJira(epicJql, fieldsToFetch)).map(i => extractItem(i, fields));

    // Drop initiatives with no qualifying epics when quarter filter is active
    if (hasQuarterFilter && epics.length > 0) {
        const withEpics = new Set(epics.map(e => e.parentKey).filter(Boolean));
        initiatives = initiatives.filter(i => withEpics.has(i.key));
    }

    // ── EXTRACT — Layer 3: Story counts per epic ─────────────────────────────
    // hierarchyLevel in (0, 1) captures story-level items (0) and any intermediate
    // level (1) under an epic — same scope as the analysis and report resolvers.
    // QP filter applied at item level when active: items are manually tagged per-quarter
    // independently of their parent epic, so this gives the precise per-quarter count.
    const storyQuarterClause = hasQuarterFilter
        ? ` AND cf[${qpFieldNumber}] in (${quarters.map(q => `"${q}"`).join(', ')})`
        : '';
    const allStories = [];
    const allRawStories = [];
    const epicKeyToTeam = Object.fromEntries(epics.map(e => [e.key, e.agileTeam]).filter(([, t]) => t));
    if (epics.length > 0) {
        for (const epicChunk of chunk(epics.map(e => e.key), 50)) {
            const storyJql = `parent in (${epicChunk.map(k => `"${k}"`).join(', ')}) AND hierarchyLevel in (0, 1)${storyQuarterClause} ORDER BY status ASC`;
            const batch = await searchJira(storyJql, ['status', 'parent', fields.sprint]);
            allRawStories.push(...batch);
            allStories.push(...batch.map(extractStoryStatus));
        }
    }
    const newestSprintIdByTeam = extractNewestSprintIdByTeam(allRawStories, fields.sprint, epicKeyToTeam);

    const storyCountByEpic = buildCountMap(allStories, s => s.parentKey, s => s.statusCategoryKey === 'done');

    // Compact status summary (one entry per unique status name) — much smaller than the full
    // allStories array, fits within Forge Storage's 32 KB per-key limit even for large portfolios.
    const storyStatusSummary = allStories.reduce((acc, s) => {
        const k = s.status || 'Unknown';
        if (!acc[k]) acc[k] = { statusCategoryKey: s.statusCategoryKey, count: 0 };
        acc[k].count++;
        return acc;
    }, {});

    // ── Derive teams ──────────────────────────────────────────────────────────
    const allTeams     = [...new Set(epics.map(e => e.agileTeam).filter(Boolean))].sort();
    const objectiveObj = layer1Items.find(i => allKeys.includes(i.key)) || null;

    // ── LOAD — Persist one session per key (independent, combined at query time) ──
    const sessionData = {
        phase:               'layers_1_4',
        timestamp:           Date.now(),
        portfolioKey:        primaryKey,
        detectedScope:       'objective',
        objectiveTitle:      objectiveObj?.summary || primaryKey,
        quarters,
        allTeams,
        agileTeamFieldNum,
        initiativeCount:     initiatives.length,
        epicCount:           epics.length,
        storyCount:          allStories.length,
        storyCountByEpic,
        storyStatusSummary,
        newestSprintIdByTeam,
    };

    for (const k of allKeys) {
        try {
            await storage.set(sessionKey(accountId, k), sessionData);
        } catch (storeErr) {
            return { status: 'ERROR', message: `Failed to save session data for ${k}: ${storeErr.message}` };
        }
    }

    return {
        status:           'SUCCESS',
        portfolioKey:     portfolioKeyDisplay,
        objectiveSummary: sessionData.objectiveTitle,
        phase:            'layers_1_4',
        teamCount:        allTeams.length,
        allTeams,
        initiativeCount:  initiatives.length,
        epicCount:        epics.length,
        storyCount:       allStories.length,
        message:          `✅ Extraction complete for **${portfolioKeyDisplay}**: ${initiatives.length} initiative(s), ${epics.length} epic(s), ${allTeams.length} team(s) identified. Ready to calculate lead/cycle time data.`,
    };
};

