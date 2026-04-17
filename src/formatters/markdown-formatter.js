/**
 * Markdown Formatter
 *
 * Pure rendering functions that convert transformed domain data into Markdown output.
 * No I/O, no calculation — only presentation.
 * All functions are stateless and reusable across any resolver.
 */

import { getDaysOverdue, getSpecialCategory,
         calculateExpectedPct, getRygStatus } from '../transformers/portfolio-transformer.js';

/**
 * RYG status legend — insert once per report, directly after the Epics section heading.
 * Contains a brief key for all colour badges and special symbols used in the Epic table.
 *
 * Each badge reflects the WORST of two independent signals:
 *   • Overdue signal  — how many calendar days past the due date (if not Done)
 *   • Completion signal — how far actual % lags behind expected % (relative threshold)
 */
export const EPIC_RYG_LEGEND = [
    '> **Status key:**',
    '> 🔵 **Done** — work is complete',
    '> 🟢 **On Track** — actual progress within 20% of expected; and overdue ≤ 14 days',
    '> 🟡 **Slight Delay** — actual progress 20–50% behind expected; or overdue 15–28 days',
    '> 🔴 **At Risk** — actual progress >50% behind expected; or overdue 29+ days',
    '> 🔘 **Not Started** · 🚩 **Missing Dates** · ⚠️ **Alert**',
    '> _Each badge shows the worst of two signals: completion progress vs. schedule overdue._',
    '> _A number suffix (e.g. 30d) indicates days past the due date._',
].join('\n');

/**
 * Format a delay badge with colour-coded bullet + day count.
 * 🟢 ≤ 14 days · 🟡 15–28 days · 🔴 > 28 days
 * @param {number} days - Days overdue (>0)
 * @returns {string}
 */
function delayBadge(days) {
    if (days <= 0) return '-';
    const bullet = days <= 14 ? '🟢' : days <= 28 ? '🟡' : '🔴';
    return `${bullet} ${days}d`;
}

const CATEGORY_ICON = { 'To Do': '⬜', 'Waiting': '⏳', 'Working': '🔄', 'Done': '✅' };

/**
 * Format a done/total progress ratio as a readable string.
 * @param {number} done  - Count of completed items
 * @param {number} total - Total item count
 * @returns {string} e.g. "3/10 — 30%"
 */
export function formatProgress(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return `${done}/${total} — ${pct}%`;
}

/**
 * Render a compact 2-column Markdown table: Status | Count
 * @param {Array} grouped - [{ status, count }, ...]
 * @returns {string}
 */
export function formatStatusTable(grouped) {
    if (!grouped || grouped.length === 0) return '_No data._';
    const rows = grouped.map(g => `| ${g.status} | ${g.count} |`);
    return ['| Status | Count |', '|---|---|', ...rows].join('\n');
}

/**
 * Render a 3-column story status table: Status | Count | Category
 * Rows appear in workflow order; unknown statuses are appended sorted by count desc.
 * @param {Array}  items    - Story objects with { status, statusCategoryKey }
 * @param {Object} workflow - PORTFOLIO_WORKFLOWS.STORY dict
 * @returns {string}
 */
export function formatStoryStatusTable(items, workflow) {
    if (!items || items.length === 0) return '_No data._';

    const statusMap = {};
    for (const item of items) {
        const s = item.status || 'Unknown';
        if (!statusMap[s]) statusMap[s] = { count: 0, statusCategoryKey: item.statusCategoryKey };
        statusMap[s].count++;
    }

    const ordered = [];
    const knownSteps = Object.entries(workflow).sort((a, b) => a[1].order - b[1].order).map(([name]) => name);
    for (const step of knownSteps) {
        if (statusMap[step]) {
            ordered.push({ status: step, count: statusMap[step].count, category: getSpecialCategory(step, statusMap[step].statusCategoryKey, workflow) });
            delete statusMap[step];
        }
    }
    for (const [status, data] of Object.entries(statusMap).sort((a, b) => b[1].count - a[1].count)) {
        ordered.push({ status, count: data.count, category: getSpecialCategory(status, data.statusCategoryKey, workflow) });
    }

    const rows = ordered.map(r => {
        const icon = CATEGORY_ICON[r.category] || '';
        return `| ${r.status} | ${r.count} | ${icon} ${r.category} |`;
    });
    return ['| Status | Count | Category |', '|---|---|---|', ...rows].join('\n');
}

/**
 * Render Initiative layer as a Markdown table.
 * Columns: [Objective] | Issue | % Complete | Due Date | Days Late
 * The Objective column is prepended (key only, no link) only when mergedMode = true.
 * Days Late shows '-' for on-time items; coloured badge for overdue ones.
 * @param {Array}  items                 - Initiative domain objects (may carry .sourceKey in merged mode)
 * @param {string} baseUrl               - Jira base URL
 * @param {Object} epicCountByInitiative - Map: initiativeKey → { total, done }
 * @param {boolean} [mergedMode=false]   - When true, prepends the Objective column
 * @returns {string}
 */
export function formatInitiativeTable(items, baseUrl, epicCountByInitiative, mergedMode = false) {
    if (!items || items.length === 0) return '_No initiatives found._';
    const rows = items.map(item => {
        const summary     = (item.summary || '-').replace(/\|/g, '\uFF5C').slice(0, 60);
        const link        = `[${item.key}](${baseUrl}/browse/${item.key})`;
        const counts      = epicCountByInitiative?.[item.key];
        const actualPct   = counts && counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;
        const expectedPct = calculateExpectedPct(item);
        const days        = getDaysOverdue(item);
        const ryg         = getRygStatus(item, actualPct, expectedPct, days, counts);
        const dateParts   = [
            item.plannedStartDate ? `**Planned:** ${item.plannedStartDate}` : null,
            item.startDate        ? `**Start:** ${item.startDate}`          : null,
            item.dueDate          ? `**Due:** ${item.dueDate}`              : null,
        ].filter(Boolean);
        const dateCell        = dateParts.length > 0 ? dateParts.join('<br>') : '—';
        const actualPctCell   = `${actualPct}%`;
        const expectedPctCell = expectedPct !== null ? `${expectedPct}%` : '—';
        const base = `| ${link} | ${summary} | ${item.status || '—'} | ${dateCell} | ${actualPctCell} | ${expectedPctCell} | ${ryg} |`;
        return mergedMode ? `| ${item.sourceKey || '—'} ${base}` : base;
    });
    const header = mergedMode
        ? ['| Objective | Key | Initiative | Status | Dates | Done% | Expected% | Status |', '|---|---|---|---|---|---|---|---|']
        : ['| Key | Initiative | Status | Dates | Done% | Expected% | Status |', '|---|---|---|---|---|---|---|'];
    return [...header, ...rows].join('\n');
}


/**
 * Sort and group epics by team. Shared helper for both formatters below.
 * Sort: team asc → due date asc (nulls last) → workflow status order.
 * @returns {Array} [{ team, epics }, ...]
 */
function groupEpicsByTeam(items, workflow) {
    const statusOrder = (item) => workflow[item.status]?.order ?? 999;
    const sorted = [...items].sort((a, b) => {
        const teamDiff = (a.agileTeam || '\uFFFF').localeCompare(b.agileTeam || '\uFFFF');
        if (teamDiff !== 0) return teamDiff;
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        const dateDiff = new Date(a.dueDate) - new Date(b.dueDate);
        if (dateDiff !== 0) return dateDiff;
        return statusOrder(a) - statusOrder(b);
    });
    const groups = [];
    const groupIndex = {};
    for (const item of sorted) {
        const team = item.agileTeam || '—';
        if (groupIndex[team] === undefined) { groupIndex[team] = groups.length; groups.push({ team, epics: [] }); }
        groups[groupIndex[team]].epics.push(item);
    }
    return groups;
}

/**
 * Format a date-with-delta cell using a two-row layout separated by the ↵ sentinel.
 * Row 1 — labelled base date  (e.g. "Planned: 2026-01-15" or "Expected: 2026-01-15").
 * Row 2 — labelled actual date with optional delta  (e.g. "Actual: 2026-01-20 (+5d)").
 * The ↵ character is later split by the Confluence renderer into separate <p> tags.
 *
 * @param {string} baseDate    - Planned / expected date (ISO string or falsy)
 * @param {string} actualDate  - Actual start / end date (ISO string or falsy)
 * @param {string} baseLabel   - Label for row 1, e.g. "Planned" or "Expected"
 * @param {string} actualLabel - Label for row 2, e.g. "Actual"
 */
function dateDeltaCell(baseDate, actualDate, baseLabel = '', actualLabel = '') {
    if (!baseDate) return '—';
    const basePart = baseLabel ? `**${baseLabel}**: ${baseDate}` : baseDate;
    if (!actualDate) return basePart;
    const diffDays = Math.round((new Date(actualDate) - new Date(baseDate)) / (1000 * 60 * 60 * 24));
    const sign      = diffDays > 0 ? '+' : '';
    const deltaStr  = diffDays !== 0 ? ` (${sign}${diffDays}d)` : '';
    const actualPart = baseLabel
        ? `**${actualLabel}**: ${actualDate}${deltaStr}`
        : `${actualDate}${deltaStr}`;
    return `${basePart}↵${actualPart}`;
}

/**
 * Build a single epic table row.
 * Base columns (8): Epic | Status | % Complete | % Expected | QP Sessions | Start | Due | RYG
 * When mergedMode = true, prepends an Objective column (key only, no link).
 */
function epicRow(item, baseUrl, storyCountByEpic, mergedMode = false) {
    // Replace ASCII pipe with the Unicode fullwidth vertical line (U+FF5C) so that
    // special characters in epic summaries cannot break the Markdown table columns.
    const summary     = (item.summary || '-').replace(/\|/g, '\uFF5C');
    const label       = `${item.key} — ${summary}`;
    const counts      = storyCountByEpic?.[item.key];
    const actualPct   = counts && counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;
    const progressStr = counts ? formatProgress(counts.done, counts.total) : '-';
    const sessions    = item.qpSessions?.length > 0 ? item.qpSessions.join(', ') : '-';
    const days        = getDaysOverdue(item);
    const expectedPct = calculateExpectedPct(item);
    const expectedStr = expectedPct !== null ? `${expectedPct}%` : '—';
    const ryg         = getRygStatus(item, actualPct, expectedPct, days, counts);
    const plannedCol  = dateDeltaCell(item.plannedStartDate, item.startDate, 'Planned', 'Actual');
    const dueCol      = dateDeltaCell(item.dueDate, item.endDate, 'Expected', 'Actual');
    const base = `| [${label}](${baseUrl}/browse/${item.key}) | ${item.status || '-'} | ${progressStr} | ${expectedStr} | ${sessions} | ${plannedCol} | ${dueCol} | ${ryg} |`;
    return mergedMode ? `| ${item.sourceKey || '-'} ${base}` : base;
}

const EPIC_TABLE_HEADER        = ['| Epic | Status | % Complete | % Expected | QP Sessions | Start | Due | RYG |', '|---|---|---|---|---|---|---|---|'];
const EPIC_TABLE_HEADER_MERGED = ['| Objective | Epic | Status | % Complete | % Expected | QP Sessions | Start | Due | RYG |', '|---|---|---|---|---|---|---|---|---|'];

/**
 * Render Epic layer as one Markdown table per team — all teams joined into one string.
 * Used when the full output fits within rendering limits.
 * @param {Array}   items            - Epic domain objects (may carry .sourceKey in merged mode)
 * @param {string}  baseUrl          - Jira base URL
 * @param {Object}  workflow         - PORTFOLIO_WORKFLOWS.EPIC dict
 * @param {Object}  storyCountByEpic - Map: epicKey → { total, done }
 * @param {boolean} [mergedMode=false] - When true, prepends the Objective column
 * @returns {string}
 */
export function formatEpicList(items, baseUrl, workflow, storyCountByEpic, mergedMode = false) {
    if (!items || items.length === 0) return '_No epics found._';
    const header = mergedMode ? EPIC_TABLE_HEADER_MERGED : EPIC_TABLE_HEADER;
    const groups = groupEpicsByTeam(items, workflow);
    return groups.map(({ team, epics }) =>
        [`### ${team} _(${epics.length} epic${epics.length === 1 ? '' : 's'})_`, ...header, ...epics.map(i => epicRow(i, baseUrl, storyCountByEpic, mergedMode))].join('\n')
    ).join('\n\n');
}

/**
 * Render Epic layer as one Markdown block per team, returned as an array.
 * Allows the resolver to attach each team as a separate response field so
 * Rovo never has to render a single oversized string.
 * @param {Array}   items            - Epic domain objects (may carry .sourceKey in merged mode)
 * @param {string}  baseUrl          - Jira base URL
 * @param {Object}  workflow         - PORTFOLIO_WORKFLOWS.EPIC dict
 * @param {Object}  storyCountByEpic - Map: epicKey → { total, done }
 * @param {boolean} [mergedMode=false] - When true, prepends the Objective column
 * @returns {Array} [{ team: string, markdown: string }, ...]
 */
export function formatEpicsByTeam(items, baseUrl, workflow, storyCountByEpic, mergedMode = false) {
    if (!items || items.length === 0) return [];
    const header = mergedMode ? EPIC_TABLE_HEADER_MERGED : EPIC_TABLE_HEADER;
    return groupEpicsByTeam(items, workflow).map(({ team, epics }) => ({
        team,
        markdown: [`### ${team} _(${epics.length} epic${epics.length === 1 ? '' : 's'})_`, ...header, ...epics.map(i => epicRow(i, baseUrl, storyCountByEpic, mergedMode))].join('\n')
    }));
}

/**
 * Compact flat overdue-epics table for the portfolio analysis view.
 * One row per epic, sorted by team. Fits within Rovo's response limit
 * regardless of the number of overdue epics.
 *
 * Columns: Team | Key | Epic | Status | Days Late
 *
 * @param {Object[]} epics   - Overdue epic domain objects
 * @param {string}   baseUrl - Jira base URL
 * @returns {string} Markdown table string, or a "no overdue" message
 */
export function formatOverdueEpicsCompact(epics, baseUrl, mergedMode = false, keyLabel = 'Objective', storyCountByEpic = {}) {
    if (!epics || epics.length === 0) return '> ✅ No overdue epics — all epics are on track!';
    const qualifying = epics.filter(e => getDaysOverdue(e) > 1);
    if (qualifying.length === 0) return '> ✅ No epics overdue by more than 1 day.';
    const rows = [...qualifying]
        .sort((a, b) => (a.agileTeam || '').localeCompare(b.agileTeam || ''))
        .map(e => {
            const days        = getDaysOverdue(e);
            const counts      = storyCountByEpic[e.key];
            const actualPct   = counts && counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;
            const expectedPct = calculateExpectedPct(e);
            const ryg         = getRygStatus(e, actualPct, expectedPct, days, counts);
            const title       = (e.summary || e.key).replace(/\|/g, '\uFF5C').slice(0, 50);
            const link        = `[${e.key}](${baseUrl}/browse/${e.key})`;
            const dateParts   = [
                e.plannedStartDate ? `**Planned:** ${e.plannedStartDate}` : null,
                e.startDate        ? `**Start:** ${e.startDate}`          : null,
                e.dueDate          ? `**Due:** ${e.dueDate}`              : null,
            ].filter(Boolean);
            const dateCell  = dateParts.length > 0 ? dateParts.join('<br>') : '—';
            const actualPctCell   = `${actualPct}%`;
            const expectedPctCell = expectedPct !== null ? `${expectedPct}%` : '—';
            const statusCell      = ryg;
            const parentCol = mergedMode ? `| ${e.sourceKey || e.parentKey || '—'} ` : '';
            return `${parentCol}| ${e.agileTeam || '—'} | ${link} | ${title} | ${e.status || '—'} | ${dateCell} | ${actualPctCell} | ${expectedPctCell} | ${statusCell} |`;
        });
    const header = mergedMode
        ? [`| ${keyLabel} | Team | Key | Epic | Status | Dates | Done% | Expected% | Status |`, '|---|---|---|---|---|---|---|---|---|']
        : ['| Team | Key | Epic | Status | Dates | Done% | Expected% | Status |', '|---|---|---|---|---|---|---|---|'];
    return [...header, ...rows].join('\n');
}

/**
 * Render the Innovation Velocity summary table for all teams in the portfolio.
 * Columns: Team | Innovation Velocity | Avg Items/Epic | Epics In Progress | Epics Done | Excluded
 * Sorted alphabetically by team name.
 *
 * "Excluded" lists epics whose changelog start = end timestamp (zero measured lead
 * time) — they are removed from the velocity calculation to avoid distortion.
 *
 * @param {string[]} allTeams  - All team names (sorted)
 * @param {Object}   teamStats - Map: teamName → { velocity: {averageDays, epicCount, zeroTimeKeys}|null,
 *                              inProgressCount: number, doneCount: number }
 * @returns {string} Markdown table string
 */
export function formatInnovationVelocityTable(allTeams, teamStats) {
    if (!allTeams || allTeams.length === 0) return '_No teams found in this portfolio._';

    const header = '| Team | Innovation Velocity | Avg Items/Epic | Epics In Progress | Epics Done | Excluded |\n|---|---|---|---|---|---|';
    const rows = allTeams.map(team => {
        const stats    = teamStats[team] || {};
        const velocity = stats.velocity;
        const velCell  = velocity ? `${velocity.averageDays} days avg` : '_N/A_';
        const avgItems = stats.avgItemsPerEpic != null ? stats.avgItemsPerEpic : '-';
        const inProg   = stats.inProgressCount ?? 0;
        const done     = stats.doneCount       ?? 0;
        const zeroKeys = velocity?.zeroTimeKeys ?? [];
        const excluded = zeroKeys.length > 0 ? zeroKeys.join(', ') : '-';

        return `| ${team} | ${velCell} | ${avgItems} | ${inProg} | ${done} | ${excluded} |`;
    });

    return [header, ...rows].join('\n');
}

/**
 * Render the combined Innovation Velocity + Team Efficiency section as per-team bullet blocks.
 *
 * Replaces the two separate table formatters (formatInnovationVelocityTable and
 * formatTeamEfficiencyTable) with a single unified, no-table view.
 *
 * Data is always shown even when sparse:
 *   - Velocity null         → "_No data_"
 *   - lct null              → "_Run portfolio report first to cache this data._"
 *   - lct with empty byType → "_No items found_"
 *
 * @param {string[]} allTeams  - All team names (sorted)
 * @param {Object}   teamStats - Map: teamName → { velocity, inProgressCount, doneCount,
 *                               avgItemsPerEpic, lct: { byType, overall } | null }
 *                               plus _overall: { averageDays, epicCount } | null
 * @returns {string} Markdown string
 */
/**
 * @param {string[]} allTeams  - All team names (sorted)
 * @param {Object}   teamStats - Map: teamName → { velocity, lct, inProgressCount, doneCount, avgItemsPerEpic }
 * @param {boolean}  [lctReady=false] - True when a complete LCT session was found in cache.
 *   false = LCT was never run → show "run the steps first" guidance.
 *   true  = LCT ran but found no qualifying data → show "no data found" message.
 */
export function formatInnovationVelocityByTeam(allTeams, teamStats, lctReady = false, velocityOnly = false) {
    if (!allTeams || allTeams.length === 0) return '_No teams found in this portfolio._';

    const lines = [];

    // ── Explanation / Legend ─────────────────────────────────────────────────
    lines.push('> **Innovation Velocity** = average Epic lead time (days from first _In Progress_ → _Done_). Two types of epics are excluded from the calculation: **KTLO** epics (always excluded silently, not listed) and epics where start = end date (zero measured time, listed in the _Excluded_ column).');
    lines.push('');

    // ── Overall summary line ─────────────────────────────────────────────────
    const overall = teamStats._overall;
    lines.push('### 📈 Overall Innovation Velocity');
    lines.push('');
    if (overall) {
        lines.push(`- **${overall.averageDays} days** average velocity`);
        lines.push(`- **${overall.epicCount} epic${overall.epicCount !== 1 ? 's' : ''}** measured (all teams)`);
    } else if (lctReady) {
        lines.push('_No done epics measured — all epics may still be In Progress, or were excluded (KTLO / zero-duration)._');
    } else {
        lines.push('_Lead/Cycle Time data not yet available — see the Lead/Cycle Time section below._');
    }
    lines.push('');

    // ── Innovation Velocity Table (rows = team) ──────────────────────────────
    lines.push('| Team | Avg Velocity (days) | Done Epics | In Progress | Avg Items/Epic | Excluded |');
    lines.push('|---|---|---|---|---|---|');
    for (const team of allTeams) {
        const stats    = teamStats[team] || {};
        const velocity = stats.velocity;
        const velCell  = velocity ? `${velocity.averageDays}d avg` : '_No data_';
        const avgItems = stats.avgItemsPerEpic != null ? stats.avgItemsPerEpic : '-';
        const inProg   = stats.inProgressCount ?? '-';
        const done     = stats.doneCount       ?? '-';
        const excluded = velocity?.zeroTimeKeys?.length ? velocity.zeroTimeKeys.join(', ') : '—';
        lines.push(`| ${team} | ${velCell} | ${done} | ${inProg} | ${avgItems} | ${excluded} |`);
    }
    lines.push('');

    if (velocityOnly) return lines.join('\n');

    // ── Lead / Cycle Time — one table per team ───────────────────────────────
    const anyLctData = allTeams.some(t => {
        const lct = (teamStats[t] || {}).lct;
        return lct && lct.byType && Object.keys(lct.byType).length > 0;
    });

    lines.push('### ⏱️ Lead / Cycle Time by Issue Type');
    lines.push('');

    if (!anyLctData) {
        lines.push(lctReady
            ? '_No qualifying completed items found in the last 6 months._'
            : '_Lead/Cycle Time data is not yet available. Request a **Confluence export** to compute it — the calculation runs automatically as part of the export flow._');
        // ↑ This message only appears in the chat path (velocityOnly=false, no H2 split).
        //   In the Confluence export path, this block is never reached because
        //   velocityOnly=true causes an early return before this line.
    } else {
        // ── Total items analyzed (Gap 3) ─────────────────────────────────────
        let totalLctItems = 0;
        for (const team of allTeams) {
            const lct = (teamStats[team] || {}).lct;
            if (lct?.byType) {
                for (const m of Object.values(lct.byType)) {
                    totalLctItems += Math.max(m.leadTime?.count ?? 0, m.cycleTime?.count ?? 0);
                }
            }
        }
        if (totalLctItems > 0) {
            lines.push(`- **${totalLctItems} items** analyzed (all teams)`);
            lines.push('');
            lines.push('');
        }
        for (const team of allTeams) {
            const lct = (teamStats[team] || {}).lct;
            lines.push(`#### ${team}`);
            if (!lct || !lct.byType || Object.keys(lct.byType).length === 0) {
                lines.push('_No qualifying completed items found in the last 6 months._');
                lines.push('');
                continue;
            }
            const teamItems = Object.values(lct.byType).reduce((sum, m) => sum + Math.max(m.leadTime?.count ?? 0, m.cycleTime?.count ?? 0), 0);
            if (teamItems > 0) {
                lines.push(`- **${teamItems} items** analyzed`);
                lines.push('');
            }
            lines.push('| Issue Type | Items | Lead Time (avg) | Lead Count | Cycle Time (avg) | Cycle Count |');
            lines.push('|---|---|---|---|---|---|');
            for (const type of Object.keys(lct.byType).sort()) {
                const m       = lct.byType[type];
                const items   = Math.max(m.leadTime?.count ?? 0, m.cycleTime?.count ?? 0);
                const leadAvg = m.leadTime  ? `${m.leadTime.averageDays}d`  : '—';
                const leadCnt = m.leadTime  ? m.leadTime.count              : '—';
                const cycAvg  = m.cycleTime ? `${m.cycleTime.averageDays}d` : '—';
                const cycCnt  = m.cycleTime ? m.cycleTime.count             : '—';
                lines.push(`| ${type} | ${items} | ${leadAvg} | ${leadCnt} | ${cycAvg} | ${cycCnt} |`);
            }
            lines.push('');
        }
    }

    return lines.join('\n');
}

/**
 * Render only the Lead/Cycle Time section.
 * Used both as a standalone H3 sub-section (chat path) and as the body of a
 * dedicated H2 section in Confluence exports (renderHeading = false).
 * @param {string[]} allTeams      - All team names (sorted)
 * @param {Object}   teamStats     - Map: teamName → { lct: { byType: {...} } }
 * @param {boolean}  lctReady      - True when a complete LCT session exists
 * @param {boolean}  renderHeading - When true (default) emits the ### heading.
 *                                   Pass false when the caller provides its own ## heading.
 * @returns {string} Markdown string
 */
export function formatLCTSection(allTeams, teamStats, lctReady = false, renderHeading = true) {
    const lines = [];
    const anyLctData = allTeams.some(t => {
        const lct = (teamStats[t] || {}).lct;
        return lct && lct.byType && Object.keys(lct.byType).length > 0;
    });

    if (renderHeading) {
        lines.push('### ⏱️ Lead / Cycle Time by Issue Type');
        lines.push('');
    }

    // ── Explanation / Legend ─────────────────────────────────────────────────
    lines.push('> **Lead Time** = time from first exit of _To Do_ status → _Done_. Last 6 months, completed Story/Task/Bug only.');
    lines.push('> **Cycle Time** = time from _In Progress_ → _Done_ (accumulated across all active _In Progress_ windows). Items that never reached _In Progress_ are excluded.');
    lines.push('');

    if (!anyLctData) {
        // When renderHeading=false we're inside a Confluence ## H2 section —
        // the caller already emitted a ⚠️ banner, so stay silent here.
        if (renderHeading) {
            lines.push(lctReady
                ? '_No qualifying completed items found in the last 6 months._'
                : '_Lead/Cycle Time data is not yet available._');
        }
    } else {
        for (const team of allTeams) {
            const lct = (teamStats[team] || {}).lct;
            // When renderHeading=false the caller already provides ## H2 —
            // use ### so Confluence numbers teams as 5.1, 5.2, … instead of 5.0.1, 5.0.2, …
            lines.push(renderHeading ? `#### ${team}` : `### ${team}`);
            if (!lct || !lct.byType || Object.keys(lct.byType).length === 0) {
                lines.push('_No qualifying completed items found in the last 6 months._');
                lines.push('');
                continue;
            }
            const teamItems = Object.values(lct.byType).reduce((sum, m) => sum + Math.max(m.leadTime?.count ?? 0, m.cycleTime?.count ?? 0), 0);
            if (teamItems > 0) {
                lines.push(`- **${teamItems} items** analyzed`);
                lines.push('');
            }
            lines.push('| Issue Type | Items | Lead Time (avg) | Lead Count | Cycle Time (avg) | Cycle Count |');
            lines.push('|---|---|---|---|---|---|');
            for (const type of Object.keys(lct.byType).sort()) {
                const m       = lct.byType[type];
                const items   = Math.max(m.leadTime?.count ?? 0, m.cycleTime?.count ?? 0);
                const leadAvg = m.leadTime  ? `${m.leadTime.averageDays}d`  : '—';
                const leadCnt = m.leadTime  ? m.leadTime.count              : '—';
                const cycAvg  = m.cycleTime ? `${m.cycleTime.averageDays}d` : '—';
                const cycCnt  = m.cycleTime ? m.cycleTime.count             : '—';
                lines.push(`| ${type} | ${items} | ${leadAvg} | ${leadCnt} | ${cycAvg} | ${cycCnt} |`);
            }
            lines.push('');
        }
    }
    return lines.join('\n');
}

/**
 * Render the Team Efficiency table — Lead Time and Cycle Time broken down by team and issue type.
 *
 * Lead Time  = first transition out of "To Do" → last "Done" transition.
 * Cycle Time = accumulated time in all "In Progress" windows (handles back-and-forth moves).
 * Items with no "In Progress" event in their changelog are excluded from both metrics.
 *
 * @param {string[]} allTeams  - All team names (sorted)
 * @param {Object}   teamStats - Map: teamName → { lct: { byType, overall } | null }
 * @returns {string} Markdown table string
 */
/**
 * Render the Sprint Analysis H2 section.
 * Reads sprintsByTeam from session data (set by calculate-sprint-data).
 *
 * @param {string[]} allTeams       - Ordered list of team names
 * @param {Object}   sprintsByTeam  - { [team]: { boardId, boardName, sprints[], error?, warning? } }
 * @returns {string}                - Markdown string for the full section body
 */
export function formatSprintSection(allTeams, sprintsByTeam) {
    if (!sprintsByTeam || Object.keys(sprintsByTeam).length === 0) {
        return '> ⚠️ **Sprint data not available.** Run `calculate-sprint-data` after `calculate-lead-time-data` to populate this section.';
    }

    const disclaimer =
        '> ⚠️ *Sprint history sourced from each team\'s most recently active board. ' +
        'If a team migrated boards during this period, earlier sprints from the previous board are not captured.*';

    const HEADER = '| Sprint | Planned | Added | Removed | ✅ Velocity | 🔄 Rolled Over | Say/Do |';
    const DIVIDER = '|---|---|---|---|---|---|---|';

    // Renders a SP cell. When items lack estimates, the note appears on a second line
    // (↵ is split into separate <p> tags by cellToHtml in confluence-formatter.js).
    const spCell = (sp, noSp) => noSp > 0
        ? `${sp} SP↵_(${noSp} item${noSp === 1 ? '' : 's'} w/o SP)_`
        : `${sp} SP`;

    const spRow = (s) => {
        if (s.error) return `| ${s.name || s.id} | — | — | — | — | — | ⚠️ ${s.error} |`;
        const sd = `${s.sayDoRag} ${Math.round(s.sayDo * 100)}%`;
        return `| ${s.name} | ${spCell(s.planned, s.plannedNoSp)} | ${spCell(s.added, s.addedNoSp)} | ${spCell(s.removed, s.removedNoSp)} | **${spCell(s.completed, s.velocityNoSp)}** | ${spCell(s.rolledOver, s.rolledOverNoSp)} | ${sd} |`;
    };

    const sections = [];

    for (const team of allTeams) {
        const data = sprintsByTeam[team];
        if (!data) { sections.push(`### ${team}\n> _No sprint data collected for this team._\n\n---\n`); continue; }
        if (data.error) { sections.push(`### ${team}\n> ⚠️ ${data.error}\n\n---\n`); continue; }

        const header = `### ${team} — ${data.boardName}`;

        if (!data.sprints || data.sprints.length === 0) {
            sections.push([header, `> ℹ️ ${data.warning || 'No closed sprints found in the last 6 months.'}`, '', '---', ''].join('\n'));
            continue;
        }

        const validSprints = data.sprints.filter(s => !s.error);
        let summary = '';
        let reEstimNote = '';
        if (validSprints.length > 0) {
            const avgVelocity = Math.round(validSprints.reduce((a, s) => a + s.completed, 0) / validSprints.length);
            const avgSayDo    = validSprints.reduce((a, s) => a + s.sayDo, 0) / validSprints.length;
            const sdRag       = avgSayDo >= 0.8 ? '🟢' : avgSayDo >= 0.5 ? '🟡' : '🔴';
            summary = `\n**Avg Velocity:** ${avgVelocity} SP · **Avg Say/Do:** ${sdRag} ${Math.round(avgSayDo * 100)}%`;

            // Re-estimation note: sum of delta across sprints (non-zero = items were re-scoped)
            const totalDelta = validSprints.reduce((a, s) => a + (s.reEstimDelta || 0), 0);
            if (totalDelta !== 0) {
                const sign = totalDelta > 0 ? '+' : '';
                reEstimNote = `> 📊 *Planned SP reflects each story's original estimate at sprint start. ` +
                    `Committed items were net re-estimated by **${sign}${totalDelta} SP** across this period.*`;
            }
        }

        sections.push([
            header,
            HEADER,
            DIVIDER,
            ...data.sprints.map(spRow),
            summary,
            reEstimNote,
            '---',
            '',
        ].join('\n'));
    }

    return [disclaimer, '', ...sections].join('\n');
}

export function formatTeamEfficiencyTable(allTeams, teamStats) {
    if (!allTeams || allTeams.length === 0) return '_No teams found._';

    const header = '| Team | Issue Type | Lead Time (avg) | Cycle Time (avg) | Items |\n|---|---|---|---|---|';
    const rows   = [];

    for (const team of allTeams) {
        const lct = teamStats[team]?.lct;
        if (!lct || !lct.byType || Object.keys(lct.byType).length === 0) {
            rows.push(`| ${team} | _N/A_ | _N/A_ | _N/A_ | — |`);
            continue;
        }
        // Sort issue types alphabetically for deterministic output
        const types = Object.keys(lct.byType).sort();
        for (const type of types) {
            const m         = lct.byType[type];
            const leadCell  = m.leadTime  ? `${m.leadTime.averageDays}d`  : '_N/A_';
            const cycleCell = m.cycleTime ? `${m.cycleTime.averageDays}d` : '_N/A_';
            // Use the larger of the two counts as the representative item count
            const count     = Math.max(m.leadTime?.count ?? 0, m.cycleTime?.count ?? 0);
            rows.push(`| ${team} | ${type} | ${leadCell} | ${cycleCell} | ${count} |`);
        }
    }

    return [header, ...rows].join('\n');
}



/**
 * Renders per-team sprint metrics as a Markdown table for chat output.
 *
 * Columns: Sprint name | Velocity | Rolled Over | Planned | Say/Do (with RAG emoji).
 * A blockquote summary line with averages is appended below the table.
 *
 * @param {string}   teamName - Display name of the agile team.
 * @param {Object[]} sprints  - Array produced by computeSprintMetrics().
 * @returns {string} Markdown string ready for Rovo chat output.
 */
export function formatTeamSprintChat(teamName, sprints) {
    if (!sprints || sprints.length === 0) {
        return `## 🏃 Sprint Analysis — ${teamName}\n\n_No sprint data available for the last 6 months._`;
    }

    const lines = [
        `## 🏃 Sprint Analysis — ${teamName}`,
        '',
        '| Sprint | ✅ Velocity | 🔄 Rolled Over | 📋 Planned | Say/Do |',
        '|--------|:----------:|:--------------:|:---------:|:------:|',
    ];

    const spCell = (sp, noSp) => noSp > 0
        ? `${sp} SP _(${noSp} item${noSp === 1 ? '' : 's'} w/o SP)_`
        : `${sp} SP`;

    for (const s of sprints) {
        lines.push(`| **${s.name}** | ${spCell(s.velocity, s.velocityNoSp)} | ${spCell(s.rolledOver, s.rolledOverNoSp)} | ${spCell(s.planned, s.plannedNoSp)} | ${s.sayDoEmoji} ${s.sayDo}% |`);
    }

    const avgVelocity = Math.round(sprints.reduce((sum, s) => sum + s.velocity, 0) / sprints.length);
    const avgSayDo    = Math.round(sprints.reduce((sum, s) => sum + s.sayDo,    0) / sprints.length);
    const avgEmoji    = avgSayDo >= 80 ? '🟢' : avgSayDo >= 50 ? '🟡' : '🔴';

    lines.push('');
    lines.push(`> **Avg Velocity:** ${avgVelocity} SP/sprint · **Avg Say/Do:** ${avgEmoji} ${avgSayDo}%`);

    return lines.join('\n');
}
