/**
 * Markdown Formatter
 *
 * Pure rendering functions that convert transformed domain data into Markdown output.
 * No I/O, no calculation — only presentation.
 * All functions are stateless and reusable across any resolver.
 */

import { getDaysOverdue, getSpecialCategory,
         calculateExpectedPct, getRygStatus,
         computeCarryOver } from '../transformers/portfolio-transformer.js';

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
export function formatLCTSection(allTeams, teamStats, lctReady = false, renderHeading = true, standalone = false) {
    const lines = [];
    const anyLctData = allTeams.some(t => {
        const lct = (teamStats[t] || {}).lct;
        return lct && lct.byType && Object.keys(lct.byType).length > 0;
    });

    // Standalone export: H1 is the page title → teams promoted to H2 directly
    // (mirrors the Sprint export structure where each team owns its own H2).
    // Portfolio chat (renderHeading=true): emit a ### section heading; teams = H4.
    // Portfolio Confluence (renderHeading=false): no section heading; teams = H3.
    if (renderHeading && !standalone) {
        lines.push('### ⏱️ Lead / Cycle Time by Issue Type');
        lines.push('');
    }

    // ── Explanation / Legend ─────────────────────────────────────────────────
    lines.push('> **Lead Time** = time from first exit of _To Do_ status → _Done_. Last 6 months, completed Story/Task/Bug only.');
    lines.push('> **Cycle Time** = time from _In Progress_ → _Done_ (accumulated across all active _In Progress_ windows). Items that never reached _In Progress_ are excluded.');
    lines.push('');

    if (!anyLctData) {
        // When renderHeading=false (and not standalone) we're inside a portfolio ## H2 —
        // the caller already emitted a ⚠️ banner, so stay silent here.
        if (standalone || renderHeading) {
            lines.push(lctReady
                ? '_No qualifying completed items found in the last 6 months._'
                : '_Lead/Cycle Time data is not yet available._');
        }
    } else {
        // Team heading level:
        //   standalone=true          → ## (H2, sits directly under the page H1)
        //   standalone=false, renderHeading=true  → #### (H4, sits under ### portfolio section)
        //   standalone=false, renderHeading=false → ### (H3, sits under ## portfolio section)
        const teamH = standalone ? '##' : (renderHeading ? '####' : '###');
        for (const team of allTeams) {
            const lct = (teamStats[team] || {}).lct;
            lines.push(`${teamH} ${team}`);
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
export function formatSprintSection(allTeams, sprintsByTeam, trendsByTeam = null, standalone = false) {
    if (!sprintsByTeam || Object.keys(sprintsByTeam).length === 0) {
        return '> ⚠️ **Sprint data not available.** Run `calculate-sprint-data` after `calculate-lead-time-data` to populate this section.';
    }

    const disclaimer =
        '> ⚠️ *Sprint history sourced from each team\'s most recently active board. ' +
        'If a team migrated boards during this period, earlier sprints from the previous board are not captured.*';

    const HEADER = '| 🗓️ Sprint | 📋 Planned | ➕ Added | ➖ Removed | ✅ Velocity | 🔄 Carry-over | 🎯 Say/Do |';
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

    // Standalone export: H1 is page title → teams = H2, trend sub-sections = H3.
    // Portfolio: teams = H3, trend sub-sections = H4.
    const teamH = standalone ? '##' : '###';

    const sections = [];

    for (const team of allTeams) {
        const data = sprintsByTeam[team];
        if (!data) { sections.push(`${teamH} ${team}\n> _No sprint data collected for this team._\n\n---\n`); continue; }
        if (data.error) { sections.push(`${teamH} ${team}\n> ⚠️ ${data.error}\n\n---\n`); continue; }

        const header = `${teamH} ${team} — ${data.boardName}`;

        if (!data.sprints || data.sprints.length === 0) {
            sections.push([header, `> ℹ️ ${data.warning || 'No closed sprints found in the last 6 months.'}`, '', '---', ''].join('\n'));
            continue;
        }

        // All sprint reports failed (GreenHopper unavailable) — skip the all-dash table,
        // show the sprint names that were found and suggest a retry.
        const validSprints = data.sprints.filter(s => !s.error);
        if (validSprints.length === 0) {
            const names = data.sprints.map(s => `- \`${s.name || s.id}\``).join('\n');
            const count = data.sprints.length;
            sections.push([
                header,
                `> ⚠️ Sprint data could not be loaded — the sprint board API was unavailable when reports were fetched.`,
                ``,
                `**${count} sprint${count === 1 ? '' : 's'} detected (no metrics loaded):**`,
                names,
                ``,
                `> _Re-run \`calculate-sprint-data\` to retry and load metrics._`,
                '',
                '---',
                '',
            ].join('\n'));
            continue;
        }
        // Headline averages render above the sprint table — readers see the
        // team-level summary before scanning sprint-by-sprint detail.
        const avgVelocity = Math.round(validSprints.reduce((a, s) => a + s.completed, 0) / validSprints.length);
        const avgSayDo    = validSprints.reduce((a, s) => a + s.sayDo, 0) / validSprints.length;
        const sdRag       = avgSayDo >= 0.8 ? '🟢' : avgSayDo >= 0.5 ? '🟡' : '🔴';
        const co          = computeCarryOver(validSprints);
        const coCell      = co ? ` · **Avg Carry-over:** ${co.rag} ${co.avgPct}% (${co.label})` : '';
        const summary     = `**Avg Velocity:** ${avgVelocity} SP · **Avg Say/Do:** ${sdRag} ${Math.round(avgSayDo * 100)}%${coCell}`;

        const trendSections = formatSprintTrendSections(trendsByTeam?.[team] ?? null, standalone, true);
        const trendNote = !trendSections && validSprints.length > 0 && validSprints.length < 5
            ? `\n> ℹ️ *Trend analysis requires at least 5 closed sprints. ${validSprints.length} found — collect more data to unlock Velocity Trend, Scope Management, and Predictability Score.*`
            : '';

        sections.push([
            header,
            ...formatSprintIntro(),
            '',
            summary,
            '',
            '<!--uniform-->',
            HEADER,
            DIVIDER,
            ...data.sprints.map(spRow),
            trendNote,
            trendSections,
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



// ─────────────────────────────────────────────────────────────────────────────
// Shared intro — RYG signal explanation + ⚠️ marker meaning. Rendered once per
// team right after the board/team header so the legend sits next to the first
// coloured cells the reader sees (Say/Do column in the sprint table).
// ─────────────────────────────────────────────────────────────────────────────
function formatSprintIntro() {
    // Every line carries the '> ' prefix so the quote bar wraps the entire
    // legend. The three colour lines render as <p> tags; the empty '> ' line
    // creates a visual gap; the trailing rules render as a <ul> inside the
    // same blockquote (parser groups consecutive '> -' lines).
    return [
        '> Each metric uses a 🟢 / 🟡 / 🔴 signal:',
        '> 🟢 healthy (within 20% of ideal)',
        '> 🟡 caution (20–50% off)',
        '> 🔴  concerning (more than 50% off)',
        '> ',
        '> - A ⚠️ after a value means it sits in the worst 30% of its band — counted as the '
        + 'next-worse colour when computing the section\'s overall signal.',
        '> - Velocity Stability is forced to 🔴 when avg velocity is below 10 SP/sprint '
        + '(~2 devs × 5 SP per 2-week sprint — below this, trend math becomes too noisy to be meaningful).',
    ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helper — renders the three trend analysis sections from a trendData
// object returned by computeSprintTrends(). Used by both chat and Confluence
// export formatters so the logic is never duplicated.
// ─────────────────────────────────────────────────────────────────────────────
function formatSprintTrendSections(trendData, standalone = false, forConfluence = false) {
    if (!trendData) return '';

    const { velocity, scope, carryOver, predictability, sprintCount } = trendData;

    const dirArrow = velocity.direction === 'UP' ? ' ⬆️' : velocity.direction === 'DOWN' ? ' ⬇️' : ' ➡️';
    const trendSign = velocity.trendPct > 0 ? '+' : '';
    // ⚠️ marker — appears next to a leaf metric's RAG when its value sits in the
    // worst 30% of its band, signalling that it contributed to a 70/30 demotion
    // when computing the section's overall RAG. Carry-over is exempt by design.
    const mark = b => b ? '⚠️' : '';

    // Standalone: team is H2, trend sub-sections are H3. Portfolio: team is H3, sub-sections are H4.
    const trendH = standalone ? '###' : '####';

    const ragWeight = rag => rag === '🟢' ? 2 : rag === '🟡' ? 1 : 0;

    // Per-table marker — consumed by markdownToStorage to disable colspan widening so
    // every column in the sprint section renders at the same width. Chat path leaves
    // it out (markers would render as visible text in chat renderers that don't strip
    // HTML comments).
    const uMark = forConfluence ? '<!--uniform-->' : null;

    const lines = [
        '',
        `${trendH} 📈 Velocity Trend`,
        '> *Measures how consistent and stable the team\'s delivery rate is over time. '
        + 'A stable velocity makes forecasting reliable; high variation signals unpredictability.*',
        '',
        `${velocity.combinedRag} **Overall Velocity Stability:** ${velocity.combinedLabel}`
        + (velocity.lowActivity ? ` _(forced 🔴 — avg velocity ${velocity.overallAvg} SP < 10 SP/sprint floor)_` : ''),
        '',
        uMark,
        `| Metric | Value |`,
        `|---|---|`,
        `| Sprints analysed | ${sprintCount} |`,
        `| Average velocity | **${velocity.overallAvg} SP/sprint** |`,
        `| Coefficient of Variation (CV) | ${velocity.cvRag} ${velocity.cv}%${mark(velocity.cvBorderline)} |`,
        `| Direction | ${velocity.directionRag}${dirArrow} ${trendSign}${velocity.trendPct}%${mark(velocity.directionBorderline)} trend (actual: ${velocity.actualFirst} → ${velocity.actualLast} SP · trend line points: ${velocity.fittedFirst} → ${velocity.fittedLast} SP) |`,
        '',
        '> *The trend line is the best-fit line through all sprints — it smooths out spikes and dips. '
        + 'The trend % compares the line\'s start and end values, not the raw first/last sprint.*',
        '',
        '\u00A0',
        '',
        `${trendH} 🔀 Scope Management`,
        '> *Tracks how much the sprint scope changed after it started. '
        + 'Low change (≤20%) means the team commits to a plan and sticks to it. '
        + 'Addition completion rate shows whether added work is actually finished or becomes carry-over.*',
        '',
        `${scope.combinedRag} **Overall Scope Volatility:** ${scope.combinedLabel}`
        + (scope.lowActivity ? ` _(forced 🔴 — avg velocity ${velocity.overallAvg} SP < 10 SP/sprint floor)_` : ''),
        '',
        uMark,
        `| Metric | Value |`,
        `|---|---|`,
        `| Avg scope change | ${scope.changeRag} ${scope.avgChangePct}%${mark(scope.changeBorderline)} of planned SP added or removed per sprint |`,
        scope.additionCompletionPct !== null
            ? `| Additions completed | ${scope.additionCompletionRag} ${scope.additionCompletionPct}%${mark(scope.additionCompletionBorderline)} of mid-sprint additions were delivered |`
            : `| Additions completed | — *(no mid-sprint additions recorded)* |`,
        '',
        '\u00A0',
        '',
        `${trendH} 🎯 Predictability Score`,
        '> *Combines overall velocity stability, scope volatility, and carry-over rate into a single score.*',
        '> *🟢 = 2 pts · 🟡 = 1 pt · 🔴 = 0 pts · max = 6 pts → normalized to 0–1.*',
        '',
        `${predictability.rag} **Overall Predictability:** ${predictability.label}`,
        '',
        uMark,
        `| Dimension | Signal | Weight |`,
        `|---|---|---|`,
        `| Velocity Stability | ${velocity.combinedRag} | ${ragWeight(velocity.combinedRag)} |`,
        `| Scope Volatility | ${scope.combinedRag} | ${ragWeight(scope.combinedRag)} |`,
        `| Carry-over | ${carryOver.rag} | ${ragWeight(carryOver.rag)} |`,
        `| **Total** | | ${predictability.rag} ${predictability.normalizedScore.toFixed(2)} |`,
    ].filter(l => l !== null);

    return lines.join('\n');
}

/**
 * Renders per-team sprint metrics as a Markdown table for chat output.
 * Uses GreenHopper data shape from parseGreenHopperSprintReport().
 *
 * Columns: 🗓️ Sprint | 📋 Planned | ➕ Added | ➖ Removed | ✅ Velocity | 🔄 Carry-over | 🎯 Say/Do
 *
 * @param {string}   teamName  - Display name of the agile team.
 * @param {string}   boardName - Board name resolved via getBoardById().
 * @param {string}   boardId   - Numeric board ID (for reference and debugging).
 * @param {Object[]} sprints   - Array produced by parseGreenHopperSprintReport().
 * @param {Object|null} trendData - Output of computeSprintTrends(); null if < 5 sprints.
 * @returns {string} Markdown string ready for Rovo chat output.
 */
export function formatTeamSprintChat(teamName, boardName, boardId, sprints, trendData = null) {
    if (!sprints || sprints.length === 0) {
        return `## 🏃 Sprint Analysis — ${teamName}\n\n_No sprint data available for the last 6 months._`;
    }

    // All sprint reports failed — list the sprint names found and skip the all-dash table.
    const validSprints = sprints.filter(s => !s.error);
    if (validSprints.length === 0) {
        const boardLabel = boardName ? `${boardName} *(ID: ${boardId})*` : (boardId ? `Board ID: ${boardId}` : '');
        const boardLine  = boardLabel ? `\n> 📋 **Board:** ${boardLabel}` : '';
        const names      = sprints.map(s => `- \`${s.name || s.id}\``).join('\n');
        const count      = sprints.length;
        return [
            `## 🏃 Sprint Analysis — ${teamName}${boardLine}`,
            ``,
            `> ⚠️ Sprint reports could not be loaded — the sprint board API was unavailable when data was fetched.`,
            ``,
            `**${count} sprint${count === 1 ? '' : 's'} detected (no metrics loaded):**`,
            names,
            ``,
            `_Ask me to re-run the sprint analysis for ${teamName} to try again._`,
        ].join('\n');
    }

    const spCell = (sp, noSp) => noSp > 0
        ? `${sp} SP _(${noSp} item${noSp === 1 ? '' : 's'} w/o SP)_`
        : `${sp} SP`;

    const boardLabel = boardName ? `${boardName} *(ID: ${boardId})*` : (boardId ? `Board ID: ${boardId}` : '');
    const lines = [`## 🏃 Sprint Analysis — ${teamName}`];
    if (boardLabel) lines.push(`> 📋 **Board:** ${boardLabel}`);

    // Intro (RYG legend + ⚠️ meaning) sits right after the board header so the
    // reader meets the legend before encountering any coloured cell.
    lines.push('', ...formatSprintIntro());

    // Headline averages render above the sprint table — readers see the
    // team-level summary before scanning sprint-by-sprint detail.
    const avgVelocity = Math.round(validSprints.reduce((a, s) => a + s.completed, 0) / validSprints.length);
    const avgSayDo    = validSprints.reduce((a, s) => a + s.sayDo, 0) / validSprints.length;
    const avgEmoji    = avgSayDo >= 0.8 ? '🟢' : avgSayDo >= 0.5 ? '🟡' : '🔴';
    const co          = computeCarryOver(validSprints);
    const coCell      = co ? ` · **Avg Carry-over:** ${co.rag} ${co.avgPct}% (${co.label})` : '';
    lines.push('');
    lines.push(`**Avg Velocity:** ${avgVelocity} SP/sprint · **Avg Say/Do:** ${avgEmoji} ${Math.round(avgSayDo * 100)}%${coCell}`);

    lines.push(
        '',
        '| 🗓️ Sprint | 📋 Planned | ➕ Added | ➖ Removed | ✅ Velocity | 🔄 Carry-over | 🎯 Say/Do |',
        '|---|---|---|---|---|---|---|',
    );

    for (const s of sprints) {
        if (s.error) {
            lines.push(`| **${s.name || s.id}** | — | — | — | — | — | ⚠️ ${s.error} |`);
            continue;
        }
        const sd = `${s.sayDoRag} ${Math.round(s.sayDo * 100)}%`;
        lines.push(`| **${s.name}** | ${spCell(s.planned, s.plannedNoSp)} | ${spCell(s.added, s.addedNoSp)} | ${spCell(s.removed, s.removedNoSp)} | **${spCell(s.completed, s.velocityNoSp)}** | ${spCell(s.rolledOver, s.rolledOverNoSp)} | ${sd} |`);
    }

    const trendSections = formatSprintTrendSections(trendData);
    if (trendSections) lines.push(trendSections);
    else if (validSprints.length > 0 && validSprints.length < 5) {
        lines.push('');
        lines.push(`> ℹ️ *Trend analysis requires at least 5 closed sprints. ${validSprints.length} found — collect more data to unlock Velocity Trend, Scope Management, and Predictability Score.*`);
    }

    return lines.join('\n');
}


/**
 * Format a Lead Time / Cycle Time chat response for one or more teams.
 *
 * @param {string[]} teams      - Team names in display order
 * @param {Object}   lctByTeam - { [team]: { byType: { [type]: { leadTime, cycleTime } }, overall } }
 *                               as returned by finalizeLCTAccumulator()
 * @returns {string} Markdown string
 */
export function formatTeamLeadTimeChat(teams, lctByTeam) {
    const lines = [];

    const label = teams.length === 1 ? teams[0] : teams.join(', ');
    lines.push(`## ⏱️ Lead Time / Cycle Time — ${label}`);
    lines.push('');
    lines.push('> **Lead Time** = time from first exit of _To Do_ → _Done_ (last 6 months, completed Story/Task/Bug only).');
    lines.push('> **Cycle Time** = accumulated time in all _In Progress_ windows. Items never reaching _In Progress_ are excluded.');
    lines.push('');

    for (const team of teams) {
        const lct = lctByTeam[team];
        if (teams.length > 1) {
            lines.push(`### ${team}`);
        }

        if (!lct || !lct.byType || Object.keys(lct.byType).length === 0) {
            lines.push('_No qualifying completed items found in the last 6 months._');
            lines.push('');
            continue;
        }

        const totalItems = Object.values(lct.byType)
            .reduce((sum, m) => sum + Math.max(m.leadTime?.count ?? 0, m.cycleTime?.count ?? 0), 0);

        lines.push(`**${totalItems} item${totalItems === 1 ? '' : 's'} analyzed** across ${Object.keys(lct.byType).length} issue type${Object.keys(lct.byType).length === 1 ? '' : 's'}:`);
        lines.push('');
        lines.push('| Issue Type | Items | Lead Time (avg) | Cycle Time (avg) |');
        lines.push('|---|:---:|:---:|:---:|');

        for (const type of Object.keys(lct.byType).sort()) {
            const m       = lct.byType[type];
            const items   = Math.max(m.leadTime?.count ?? 0, m.cycleTime?.count ?? 0);
            const leadAvg = m.leadTime  ? `**${m.leadTime.averageDays}d**`  : '—';
            const cycAvg  = m.cycleTime ? `**${m.cycleTime.averageDays}d**` : '—';
            lines.push(`| ${type} | ${items} | ${leadAvg} | ${cycAvg} |`);
        }

        // Overall summary row
        if (lct.overall) {
            const ov = lct.overall;
            const oLead = ov.leadTime  ? `**${ov.leadTime.averageDays}d**`  : '—';
            const oCyc  = ov.cycleTime ? `**${ov.cycleTime.averageDays}d**` : '—';
            lines.push(`| **Overall** | ${totalItems} | ${oLead} | ${oCyc} |`);
        }
        lines.push('');
    }

    return lines.join('\n');
}
