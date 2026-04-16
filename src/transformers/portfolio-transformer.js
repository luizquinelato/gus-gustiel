/**
 * Portfolio Transformer
 *
 * Pure calculation and data-shaping functions for portfolio analysis.
 * No I/O, no Markdown rendering — only data in, data out.
 * All functions are stateless and safe under any level of concurrency.
 */

/**
 * Returns true if the item's due date is in the past and it is not Done.
 * @param {Object} item - Domain object with { dueDate, statusCategoryKey }
 * @returns {boolean}
 */
export function isOverdue(item) {
    if (!item.dueDate) return false;
    if (item.statusCategoryKey === 'done') return false;
    return new Date(item.dueDate) < new Date();
}

/**
 * Group items by status in workflow order.
 * Statuses absent from the workflow dict appear at the end, sorted by count desc.
 * @param {Array}  items    - Objects with a `.status` string property
 * @param {Object} workflow - Dict: statusName → { order, category, specialCategory }
 * @returns {Array} [{ status, count }, ...]
 */
export function groupByStatusOrdered(items, workflow) {
    const counts = {};
    for (const item of items) {
        const s = item.status || 'Unknown';
        counts[s] = (counts[s] || 0) + 1;
    }
    // Emit known statuses in declared order (only those with at least one item)
    const ordered = Object.entries(workflow)
        .sort((a, b) => a[1].order - b[1].order)
        .filter(([name]) => counts[name] !== undefined)
        .map(([name]) => {
            const result = { status: name, count: counts[name] };
            delete counts[name];
            return result;
        });
    // Append statuses not in the workflow, sorted by count desc
    const extras = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([status, count]) => ({ status, count }));
    return [...ordered, ...extras];
}

/**
 * Derive the display category for a Story item.
 * Reads `specialCategory` from the workflow dict first;
 * falls back to Jira's statusCategoryKey for unknown statuses.
 * @param {string} status            - Jira status name
 * @param {string} statusCategoryKey - Jira status category key ('new'|'indeterminate'|'done')
 * @param {Object} [workflow]        - PORTFOLIO_WORKFLOWS.STORY dict (optional)
 * @returns {'To Do'|'Waiting'|'Working'|'Done'}
 */
export function getSpecialCategory(status, statusCategoryKey, workflow) {
    if (workflow?.[status]?.specialCategory) return workflow[status].specialCategory;
    if (statusCategoryKey === 'done') return 'Done';
    if (statusCategoryKey === 'new')  return 'To Do';
    return 'Working';
}

/**
 * Calculate how many days past due an item is.
 * Returns 0 if the item has no due date, is Done, or is not yet overdue.
 * @param {Object} item - Domain object with { dueDate, statusCategoryKey }
 * @returns {number} Integer days late (0 = not late)
 */
export function getDaysOverdue(item) {
    if (!item.dueDate) return 0;
    if (item.statusCategoryKey === 'done') return 0;
    const diff = new Date() - new Date(item.dueDate);
    return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}

/**
 * Return only items that are overdue (dueDate in past, status not Done).
 * Filtering is a transform-layer concern; resolvers and formatters must not filter.
 * @param {Array} items - Domain objects with { dueDate, statusCategoryKey }
 * @returns {Array}
 */
export function filterOverdue(items) {
    return items.filter(isOverdue);
}

/**
 * Calculate Innovation Velocity (average lead time) for a list of work items.
 *
 * Generic: works for any hierarchy level — pass the matching PORTFOLIO_WORKFLOWS entry.
 * The workflow dict drives which statuses count as "In Progress" (active development)
 * and which count as "Done" (finished). Waiting time inside the In Progress phase is
 * intentionally included (per product spec).
 *
 * Algorithm per item:
 *   1. Find the FIRST transition where `toStatus` is an 'In Progress' workflow status
 *      → this is the start of the development phase.
 *   2. Find all transitions where `toStatus` is a 'Done' workflow status and occurred
 *      after the start → the LAST such transition is used as the end.
 *      If the item is still in progress (statusCategoryKey !== 'done'), use NOW.
 *   3. lead time = end − start (in fractional days).
 *   4. Items that never entered a known 'In Progress' workflow status are given a
 *      fallback: if Jira itself considers them "In Progress" (statusCategoryKey ===
 *      'indeterminate') or "Done" ('done'), and there is at least one changelog event,
 *      the FIRST status-change event is used as the start proxy. This handles teams
 *      that operate under a different epic workflow (e.g. "In Progress" instead of
 *      "Development") without requiring changes to PORTFOLIO_WORKFLOWS.
 *
 * Jira status category keys:
 *   'new'           → To Do     (not yet started — excluded)
 *   'indeterminate' → In Progress
 *   'done'          → Done
 *
 * @param {Array}  items    - Objects with { statusCategoryKey, statusHistory }
 *                            where statusHistory = [{ fromStatus, toStatus, timestamp }]
 * @param {Object} workflow - PORTFOLIO_WORKFLOWS entry for the relevant layer
 * @returns {{ averageDays: number, epicCount: number } | null}
 *          null when no qualifying items exist
 */
export function calculateLeadTime(items, workflow) {
    const inProgressStatuses = new Set(
        Object.entries(workflow).filter(([, v]) => v.category === 'In Progress').map(([k]) => k)
    );
    const doneStatuses = new Set(
        Object.entries(workflow).filter(([, v]) => v.category === 'Done').map(([k]) => k)
    );

    let totalDays    = 0;
    let count        = 0;
    const zeroTimeKeys = []; // epics whose start and end timestamps are equal (single-event changelog)

    for (const item of items) {
        const history = item.statusHistory || [];

        // Find the first entry into any "In Progress" workflow status (primary path)
        let startEvent = history.find(e => inProgressStatuses.has(e.toStatus));

        // Fallback: if no named match, but Jira's own status category says the epic
        // is (or was) active, use the first changelog event as the start proxy.
        // This covers teams whose epics use a different status name than what
        // PORTFOLIO_WORKFLOWS.EPIC defines (e.g. "In Progress" vs "Development").
        // Epics still in "To Do" (statusCategoryKey === 'new') are excluded.
        if (!startEvent && history.length > 0 &&
            (item.statusCategoryKey === 'indeterminate' || item.statusCategoryKey === 'done')) {
            startEvent = history[0];
        }

        if (!startEvent) continue; // Never left To Do — skip

        const startTime = new Date(startEvent.timestamp);

        // Collect all exits to a "Done" status that happened after the start
        const doneEvents = history.filter(
            e => doneStatuses.has(e.toStatus) && new Date(e.timestamp) >= startTime
        );

        let endTime;
        if (doneEvents.length > 0) {
            // Use the last transition to Done (handles reopen → re-done cycles)
            endTime = new Date(doneEvents[doneEvents.length - 1].timestamp);
        } else if (item.statusCategoryKey !== 'done') {
            // Still in progress — measure up to now
            endTime = new Date();
        } else {
            // Done per Jira but no matching Done workflow transition in the changelog
            // (same non-standard workflow scenario as the start-time fallback).
            // Use the last changelog event as the end proxy.
            endTime = new Date(history[history.length - 1].timestamp);
        }

        // Epics where start = end timestamp (e.g. single-event changelog, or statuses
        // changed in the same bulk operation) produce rawDays ≤ 0 — they are excluded
        // entirely from both totalDays and count so they don't distort the average.
        // They are captured in zeroTimeKeys and surfaced in the "Excluded" table column.
        const rawDays = (endTime - startTime) / (1000 * 60 * 60 * 24);
        if (rawDays <= 0) {
            if (item.key) zeroTimeKeys.push(item.key);
            continue;
        }
        totalDays += rawDays;
        count++;
    }

    if (count === 0) return null;
    return { averageDays: Math.round(totalDays / count), epicCount: count, zeroTimeKeys };
}

/**
 * Calculate the expected % completion today based on a linear burndown between
 * plannedStartDate and dueDate.
 *
 * @param {Object} item - Domain object with { plannedStartDate, dueDate }
 * @returns {number|null} Integer 0–100, or null if dates are missing/invalid
 */
export function calculateExpectedPct(item) {
    if (!item.plannedStartDate || !item.dueDate) return null;
    const start = new Date(item.plannedStartDate).getTime();
    const end   = new Date(item.dueDate).getTime();
    if (isNaN(start) || isNaN(end) || end <= start) return null;
    const pct = ((Date.now() - start) / (end - start)) * 100;
    return Math.min(100, Math.max(0, Math.round(pct)));
}

/**
 * Determine the RYG (Red / Yellow / Green) forecast badge for an epic or initiative.
 *
 * Two independent signals are evaluated; the WORST (most severe) color wins.
 *
 * Rules (in priority order):
 *  1. Done                                         → 🔵 ✓ (done)
 *  2. Not started (statusCategoryKey=new, no done  → 🔘 🚩⚠️  (missing dates)
 *     children) + not overdue                      → 🔘        (dates present)
 *
 *  3. Layer 1 — Overdue signal (calendar days past due date, item not Done):
 *       0 days        → no penalty
 *       1–14 days     → green
 *       15–28 days    → yellow
 *       29+ days      → red
 *
 *  4. Layer 2 — Completion delta signal (relative to expectedPct):
 *       If expectedPct is null (dates missing) → signal skipped
 *       delta = expectedPct − actualPct
 *       delta ≤ 20% of expectedPct  → green
 *       delta ≤ 50% of expectedPct  → yellow
 *       delta  > 50% of expectedPct → red
 *
 *  5. Final badge = worst of Layer 1 and Layer 2 (red > yellow > green).
 *     A number suffix (e.g. " 30d") is appended when the item is overdue.
 *     If neither layer produces a signal → "—"
 *
 * @param {Object}      item        - Domain object with { statusCategoryKey, plannedStartDate, dueDate }
 * @param {number}      actualPct   - Actual % completion (0–100), derived from story counts
 * @param {number|null} expectedPct - Output of calculateExpectedPct (null = can't compute)
 * @param {number}      daysOverdue - Output of getDaysOverdue (0 = not late)
 * @param {Object|null} counts      - Story counts { total, done } or null if no stories
 * @returns {string} Badge string ready to embed in a Markdown table cell
 */
export function getRygStatus(item, actualPct, expectedPct, daysOverdue, counts) {
    // 1. Done → blue
    if (item.statusCategoryKey === 'done') return '🔵 ✓ (done)';

    // 2. Not started: "To Do" category AND no done children AND not overdue → gray
    //    If past due date, fall through so the overdue signal applies.
    const isNotStarted = item.statusCategoryKey === 'new' && (counts?.done ?? 0) === 0;
    if (isNotStarted && daysOverdue === 0) {
        const missingDates = !item.plannedStartDate || !item.dueDate;
        return missingDates ? '🔘 🚩⚠️' : '🔘';
    }

    // Rank helper — higher rank = worse color
    const COLOR_RANK = { green: 0, yellow: 1, red: 2 };

    // Layer 1 — Overdue signal
    let overdueColor = null;
    if (daysOverdue > 0) {
        overdueColor = daysOverdue <= 14 ? 'green' : daysOverdue <= 28 ? 'yellow' : 'red';
    }

    // Layer 2 — Completion delta signal (relative thresholds)
    let completionColor = null;
    if (expectedPct !== null) {
        const delta = expectedPct - actualPct;
        if      (delta <= expectedPct * 0.20) completionColor = 'green';
        else if (delta <= expectedPct * 0.50) completionColor = 'yellow';
        else                                  completionColor = 'red';
    }

    // Neither signal available → dash
    if (overdueColor === null && completionColor === null) return '—';

    // Worst of both signals
    const signals    = [overdueColor, completionColor].filter(Boolean);
    const finalColor = signals.reduce((worst, c) => COLOR_RANK[c] > COLOR_RANK[worst] ? c : worst);

    const daysSuffix = daysOverdue > 0 ? ` ${daysOverdue}d` : '';
    if (finalColor === 'green')  return `🟢${daysSuffix}`;
    if (finalColor === 'yellow') return `🟡${daysSuffix}`;
    return `🔴${daysSuffix}`;
}

/**
 * Calculate Lead Time and Cycle Time for a list of work items, grouped by issue type.
 *
 * Lead Time  — elapsed time from the FIRST transition out of a "To Do" status category
 *              (i.e. the first event where toStatus is not a To Do status) to the last
 *              transition into a "Done" workflow status.  Items that never left "To Do"
 *              are excluded.
 *
 * Cycle Time — accumulated time spent in ALL contiguous "In Progress" status windows,
 *              correctly handling forward / backward moves (each window is measured and
 *              summed independently).
 *
 * Filtering  — items with NO "In Progress" transition anywhere in their changelog are
 *              excluded from BOTH metrics (e.g. quick-close / won't-fix items that went
 *              directly from To Do to Done without any development work).
 *
 * @param {Array}  items    - Objects with { issueType, statusCategoryKey, statusHistory }
 *                            where statusHistory = [{ fromStatus, toStatus, timestamp }]
 * @param {Object} workflow - PORTFOLIO_WORKFLOWS.STORY (or equivalent)
 * @returns {{
 *   byType:  { [issueType: string]: { leadTime: {averageDays, count}|null, cycleTime: {averageDays, count}|null } },
 *   overall: { leadTime: {averageDays, count}|null, cycleTime: {averageDays, count}|null }
 * }}
 */
export function calculateLeadCycleTime(items, workflow) {
    const toDoStatuses = new Set(
        Object.entries(workflow)
            .filter(([, v]) => v.category === 'To Do')
            .map(([k]) => k)
    );
    const inProgressStatuses = new Set(
        Object.entries(workflow)
            .filter(([, v]) => v.category === 'In Progress')
            .map(([k]) => k)
    );
    const doneStatuses = new Set(
        Object.entries(workflow)
            .filter(([, v]) => v.category === 'Done')
            .map(([k]) => k)
    );

    // Accumulator shape per type
    const byTypeData = {}; // { [type]: { totalLeadDays, leadCount, totalCycleDays, cycleCount } }
    let overallTotalLead = 0, overallLeadCount = 0;
    let overallTotalCycle = 0, overallCycleCount = 0;

    const ensureType = (type) => {
        if (!byTypeData[type]) byTypeData[type] = { totalLeadDays: 0, leadCount: 0, totalCycleDays: 0, cycleCount: 0 };
    };

    for (const item of items) {
        // Only measure items Jira itself considers Done
        if (item.statusCategoryKey !== 'done') continue;

        const history = item.statusHistory || [];
        if (history.length === 0) continue;

        // Requirement 4: exclude items with no In Progress transition in the changelog
        const hasInProgress = history.some(e => inProgressStatuses.has(e.toStatus));
        if (!hasInProgress) continue;

        // Find last Done transition (validates item actually closed via a known Done status)
        const doneEvents = history.filter(e => doneStatuses.has(e.toStatus));
        if (doneEvents.length === 0) continue;
        const lastDoneTime = new Date(doneEvents[doneEvents.length - 1].timestamp);

        // Lead Time start: first event where toStatus is NOT a "To Do" category status
        // This correctly handles items created in Backlog/To Do AND items created directly
        // in an active status, and items that bounced back to To Do before progressing.
        const firstNonTodoEvent = history.find(e => !toDoStatuses.has(e.toStatus));
        if (!firstNonTodoEvent) continue; // never left To Do — skip

        const leadStartTime = new Date(firstNonTodoEvent.timestamp);
        const leadDays      = (lastDoneTime - leadStartTime) / (1000 * 60 * 60 * 24);

        // Cycle Time: accumulate all contiguous In Progress windows
        let cycleMs         = 0;
        let inProgressSince = null;
        for (const event of history) {
            const ts = new Date(event.timestamp);
            if (inProgressStatuses.has(event.toStatus)) {
                // Opening a new In Progress window (or staying in one)
                if (inProgressSince === null) inProgressSince = ts;
            } else if (inProgressSince !== null) {
                // Leaving In Progress — close and accumulate
                cycleMs        += ts - inProgressSince;
                inProgressSince = null;
            }
        }
        // Edge case: final move was directly from In Progress to Done
        if (inProgressSince !== null) cycleMs += lastDoneTime - inProgressSince;

        const cycleDays = cycleMs / (1000 * 60 * 60 * 24);
        const issueType = item.issueType || 'Unknown';
        ensureType(issueType);

        if (leadDays > 0) {
            byTypeData[issueType].totalLeadDays += leadDays;
            byTypeData[issueType].leadCount++;
            overallTotalLead += leadDays;
            overallLeadCount++;
        }
        if (cycleDays > 0) {
            byTypeData[issueType].totalCycleDays += cycleDays;
            byTypeData[issueType].cycleCount++;
            overallTotalCycle += cycleDays;
            overallCycleCount++;
        }
    }

    const summarize = ({ totalLeadDays, leadCount, totalCycleDays, cycleCount }) => ({
        leadTime:  leadCount  > 0 ? { averageDays: Math.round(totalLeadDays  / leadCount),  count: leadCount  } : null,
        cycleTime: cycleCount > 0 ? { averageDays: Math.round(totalCycleDays / cycleCount), count: cycleCount } : null,
    });

    const byType = {};
    for (const [type, data] of Object.entries(byTypeData)) byType[type] = summarize(data);

    return {
        byType,
        overall: summarize({ totalLeadDays: overallTotalLead, leadCount: overallLeadCount, totalCycleDays: overallTotalCycle, cycleCount: overallCycleCount }),
    };
}

/**
 * Merge a batch of extracted LCT/velocity items into a running dual accumulator.
 *
 * Called once per Forge invocation during the batched LCT flow.  The accumulator
 * is stored in Forge Storage between calls (tiny — just sums/counts, never raw items).
 *
 * Routes items by type:
 *   - Epics (isEpic=true, isKTLO=false) → velocityAcc (innovation velocity)
 *   - Stories / Tasks / Bugs (isEpic=false) → lctAcc (lead/cycle time)
 *   - KTLO epics (isKTLO=true) → skipped entirely
 *
 * @param {Array}  items         - Items from extractItemForLCT
 * @param {Object} storyWorkflow - PORTFOLIO_WORKFLOWS.STORY
 * @param {Object} epicWorkflow  - PORTFOLIO_WORKFLOWS.EPIC
 * @param {Object} [acc]         - Combined accumulator: { lctAcc, velocityAcc } (mutated and returned)
 * @returns {Object} Updated combined accumulator
 */
export function mergeItemsIntoLCTAccumulator(items, storyWorkflow, epicWorkflow, acc = {}) {
    if (!acc.lctAcc)      acc.lctAcc      = {};
    if (!acc.velocityAcc) acc.velocityAcc = {};

    // ── Story workflow sets ───────────────────────────────────────────────────
    const storyToDo = new Set(Object.entries(storyWorkflow).filter(([, v]) => v.category === 'To Do').map(([k]) => k));
    const storyInProg = new Set(Object.entries(storyWorkflow).filter(([, v]) => v.category === 'In Progress').map(([k]) => k));
    const storyDone   = new Set(Object.entries(storyWorkflow).filter(([, v]) => v.category === 'Done').map(([k]) => k));

    // ── Epic workflow sets ────────────────────────────────────────────────────
    const epicInProg = new Set(Object.entries(epicWorkflow).filter(([, v]) => v.category === 'In Progress').map(([k]) => k));
    const epicDone   = new Set(Object.entries(epicWorkflow).filter(([, v]) => v.category === 'Done').map(([k]) => k));

    const ensureLct = (team, type) => {
        if (!acc.lctAcc[team]) acc.lctAcc[team] = {};
        if (!acc.lctAcc[team][type]) acc.lctAcc[team][type] = { totalLeadDays: 0, leadCount: 0, totalCycleDays: 0, cycleCount: 0 };
    };

    const ensureVel = (team) => {
        if (!acc.velocityAcc[team]) acc.velocityAcc[team] = { totalDays: 0, count: 0, zeroTimeKeys: [], inProgressCount: 0, doneCount: 0 };
    };

    for (const item of items) {
        const team = item.agileTeam || '__unknown__';

        if (item.isEpic) {
            // ── Epic: skip KTLO; accumulate innovation velocity ───────────────
            if (item.isKTLO) continue;
            ensureVel(team);
            const slot    = acc.velocityAcc[team];
            const history = item.statusHistory || [];

            if (item.statusCategoryKey === 'indeterminate') slot.inProgressCount++;
            if (item.statusCategoryKey === 'done')          slot.doneCount++;

            // Same algorithm as calculateLeadTime
            let startEvent = history.find(e => epicInProg.has(e.toStatus));
            if (!startEvent && history.length > 0 &&
                (item.statusCategoryKey === 'indeterminate' || item.statusCategoryKey === 'done')) {
                startEvent = history[0];
            }
            if (!startEvent) continue;

            const startTime  = new Date(startEvent.timestamp);
            const doneEvents = history.filter(e => epicDone.has(e.toStatus) && new Date(e.timestamp) >= startTime);
            let endTime;
            if (doneEvents.length > 0) {
                endTime = new Date(doneEvents[doneEvents.length - 1].timestamp);
            } else if (item.statusCategoryKey !== 'done') {
                endTime = new Date();
            } else {
                endTime = new Date(history[history.length - 1].timestamp);
            }

            const rawDays = (endTime - startTime) / (1000 * 60 * 60 * 24);
            if (rawDays <= 0) { if (item.key) slot.zeroTimeKeys.push(item.key); continue; }
            slot.totalDays += rawDays;
            slot.count++;

        } else {
            // ── Story / Task / Bug: accumulate lead/cycle time ────────────────
            if (item.statusCategoryKey !== 'done') continue;
            const history = item.statusHistory || [];
            if (history.length === 0) continue;

            const hasInProgress = history.some(e => storyInProg.has(e.toStatus));
            if (!hasInProgress) continue;

            const doneEvents = history.filter(e => storyDone.has(e.toStatus));
            if (doneEvents.length === 0) continue;
            const lastDoneTime = new Date(doneEvents[doneEvents.length - 1].timestamp);

            const firstNonTodo = history.find(e => !storyToDo.has(e.toStatus));
            if (!firstNonTodo) continue;

            const leadDays = (lastDoneTime - new Date(firstNonTodo.timestamp)) / (1000 * 60 * 60 * 24);

            let cycleMs = 0, inProgressSince = null;
            for (const event of history) {
                const ts = new Date(event.timestamp);
                if (storyInProg.has(event.toStatus)) {
                    if (inProgressSince === null) inProgressSince = ts;
                } else if (inProgressSince !== null) {
                    cycleMs += ts - inProgressSince;
                    inProgressSince = null;
                }
            }
            if (inProgressSince !== null) cycleMs += lastDoneTime - inProgressSince;
            const cycleDays = cycleMs / (1000 * 60 * 60 * 24);

            const issueType = item.issueType || 'Unknown';
            ensureLct(team, issueType);
            if (leadDays  > 0) { acc.lctAcc[team][issueType].totalLeadDays  += leadDays;  acc.lctAcc[team][issueType].leadCount++;  }
            if (cycleDays > 0) { acc.lctAcc[team][issueType].totalCycleDays += cycleDays; acc.lctAcc[team][issueType].cycleCount++; }
        }
    }

    return acc;
}

/**
 * Finalise a per-team LCT + velocity accumulator into human-readable averages.
 *
 * Called once after all batches have been processed (when isLast = true).
 * Accepts the new combined structure { lctAcc, velocityAcc } produced by
 * mergeItemsIntoLCTAccumulator, or the legacy flat lctAcc object for backward compat.
 *
 * @param {Object}   acc      - Combined accumulator: { lctAcc, velocityAcc }
 *                              (or legacy flat lctAcc for backward compat)
 * @param {string[]} allTeams - Ordered list of teams
 * @returns {{ lctByTeam, velocityByTeam, overallVelocity }}
 */
export function finalizeLCTAccumulator(acc, allTeams) {
    // Support both new { lctAcc, velocityAcc } and legacy flat lctAcc.
    const lctAcc      = acc.lctAcc      ?? acc;
    const velocityAcc = acc.velocityAcc ?? {};

    // ── LCT ──────────────────────────────────────────────────────────────────
    const summarize = ({ totalLeadDays, leadCount, totalCycleDays, cycleCount }) => ({
        leadTime:  leadCount  > 0 ? { averageDays: Math.round(totalLeadDays  / leadCount),  count: leadCount  } : null,
        cycleTime: cycleCount > 0 ? { averageDays: Math.round(totalCycleDays / cycleCount), count: cycleCount } : null,
    });

    const lctByTeam = {};
    for (const team of allTeams) {
        const teamAcc = lctAcc[team] || {};
        const byType  = {};
        const overall = { totalLeadDays: 0, leadCount: 0, totalCycleDays: 0, cycleCount: 0 };
        for (const [type, data] of Object.entries(teamAcc)) {
            byType[type]           = summarize(data);
            overall.totalLeadDays  += data.totalLeadDays;
            overall.leadCount      += data.leadCount;
            overall.totalCycleDays += data.totalCycleDays;
            overall.cycleCount     += data.cycleCount;
        }
        lctByTeam[team] = { byType, overall: summarize(overall) };
    }

    // ── Velocity ──────────────────────────────────────────────────────────────
    const velocityByTeam = {};
    let totalDaysAll = 0, countAll = 0;

    for (const team of allTeams) {
        const vSlot = velocityAcc[team];
        if (!vSlot || vSlot.count === 0) {
            velocityByTeam[team] = null;
            continue;
        }
        velocityByTeam[team] = {
            averageDays:     Math.round(vSlot.totalDays / vSlot.count),
            epicCount:       vSlot.count,
            inProgressCount: vSlot.inProgressCount,
            doneCount:       vSlot.doneCount,
            zeroTimeKeys:    vSlot.zeroTimeKeys || [],
        };
        totalDaysAll += vSlot.totalDays;
        countAll     += vSlot.count;
    }

    const overallVelocity = countAll > 0
        ? { averageDays: Math.round(totalDaysAll / countAll), epicCount: countAll }
        : null;

    return { lctByTeam, velocityByTeam, overallVelocity };
}

/**
 * Build a parentKey → { total, done } count map from any array of items.
 * Generic: handles both epic→initiative and story→epic rollups.
 *
 * @param {Array}    items        - Array of domain objects
 * @param {Function} getParentKey - (item) => string|null — extracts the parent key
 * @param {Function} checkDone   - (item) => boolean    — true if item counts as done
 * @returns {Object} Map of parentKey → { total, done }
 */
export function buildCountMap(items, getParentKey, checkDone) {
    const map = {};
    for (const item of items) {
        const key = getParentKey(item);
        if (!key) continue;
        if (!map[key]) map[key] = { total: 0, done: 0 };
        map[key].total++;
        if (checkDone(item)) map[key].done++;
    }
    return map;
}

