/**
 * Jira Extractor
 *
 * Responsible for mapping raw Jira API responses into clean domain objects.
 * The only layer allowed to interpret Jira's raw JSON shape.
 * All functions are pure and reusable across any resolver.
 */

/**
 * Map a raw Jira issue to a full domain object.
 * Handles environment-aware custom field keys and multi-select fields.
 * @param {Object} issue     - Raw Jira issue from the API
 * @param {Object} envFields - Field key map from ENV_CONFIG (environment-aware)
 * @returns {Object} Clean domain object
 */
export function extractItem(issue, envFields) {
    const f = issue.fields || {};

    const agileTeamRaw = f[envFields.agileTeam];
    const agileTeam = agileTeamRaw
        ? (agileTeamRaw.value || agileTeamRaw.name || String(agileTeamRaw))
        : null;

    // QP Planning Sessions is a multi-select: array of {value} objects or strings
    const qpRaw = f[envFields.qpPlanningSessions];
    const qpSessions = Array.isArray(qpRaw)
        ? qpRaw.map(v => v?.value || v?.name || String(v)).filter(Boolean)
        : (qpRaw ? [qpRaw.value || qpRaw.name || String(qpRaw)] : []);

    return {
        key:               issue.key,
        parentKey:         f.parent?.key || null,
        summary:           f.summary || null,
        status:            f.status?.name || null,
        statusCategoryKey: f.status?.statusCategory?.key || null,
        plannedStartDate:  f[envFields.plannedStartDate] || null,
        startDate:         f[envFields.startDate]        || null,
        agileTeam,
        qpSessions,
        dueDate:           f[envFields.dueDate]    || null,
        endDate:           f[envFields.endDate]    || null,
    };
}

/**
 * Minimal extraction for Story items where only ['status', 'parent'] are fetched.
 * Avoids the overhead of full extractItem for the high-volume Layer 3 fetch.
 * @param {Object} issue - Raw Jira issue from the API
 * @returns {{ status, statusCategoryKey, parentKey }}
 */
export function extractStoryStatus(issue) {
    const f = issue.fields || {};
    return {
        status:            f.status?.name || 'Unknown',
        statusCategoryKey: f.status?.statusCategory?.key || null,
        parentKey:         f.parent?.key || null
    };
}

/**
 * Extract status transition events from an issue's changelog.
 * Returns only 'status' field changes, sorted chronologically (oldest first).
 * Requires the issue to have been fetched with expand=changelog.
 *
 * @param {Object} issue - Raw Jira issue with a .changelog property
 * @returns {Array<{ fromStatus: string|null, toStatus: string|null, timestamp: string }>}
 */
export function extractStatusHistory(issue) {
    const histories = issue.changelog?.histories || [];
    const events = [];
    for (const history of histories) {
        for (const item of history.items || []) {
            if (item.fieldId === 'status') {
                events.push({
                    fromStatus: item.fromString || null,
                    toStatus:   item.toString  || null,
                    timestamp:  history.created
                });
            }
        }
    }
    events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return events;
}

/**
 * Minimal extraction for Epic items fetched for lead-time calculation.
 * Only agileTeam, statusCategoryKey, and statusHistory are returned —
 * no other fields are needed, so the JQL fetch stays lean.
 *
 * @param {Object} issue          - Raw Jira issue (fetched with expand=changelog)
 * @param {string} agileTeamField - Custom field key from ENV_CONFIG (e.g. 'customfield_10128')
 * @returns {{ key, agileTeam, statusCategoryKey, statusHistory }}
 */
export function extractEpicForLeadTime(issue, agileTeamField) {
    const f = issue.fields || {};
    const agileTeamRaw = f[agileTeamField];
    const agileTeam = agileTeamRaw
        ? (agileTeamRaw.value || agileTeamRaw.name || String(agileTeamRaw))
        : null;
    return {
        key:               issue.key,
        agileTeam,
        statusCategoryKey: f.status?.statusCategory?.key || null,
        statusHistory:     extractStatusHistory(issue)
    };
}

/**
 * Extraction for any work item (Epic, Story, Task, Bug, …) fetched for Lead / Cycle Time
 * or Innovation Velocity calculation.
 * Captures issueType, isEpic, and isKTLO so the accumulator can route each item to the
 * correct sub-accumulator (velocityAcc for epics, lctAcc for stories).
 * Requires the issue to have been fetched with expand=changelog and the
 * agileTeam + status + issuetype + summary fields.
 *
 * @param {Object} issue          - Raw Jira issue (fetched with expand=changelog)
 * @param {string} agileTeamField - Custom field key for the agile team (env-aware)
 * @returns {{ key, agileTeam, issueType, isEpic, isKTLO, statusCategoryKey, statusHistory }}
 */
export function extractItemForLCT(issue, agileTeamField) {
    const f = issue.fields || {};
    const agileTeamRaw = f[agileTeamField];
    const agileTeam = agileTeamRaw
        ? (agileTeamRaw.value || agileTeamRaw.name || String(agileTeamRaw))
        : null;
    const isEpic = (f.issuetype?.name || '').toLowerCase() === 'epic';
    const isKTLO = isEpic && /KTLO/i.test(f.summary || '');
    return {
        key:               issue.key,
        agileTeam,
        issueType:         f.issuetype?.name || null,
        isEpic,
        isKTLO,
        statusCategoryKey: f.status?.statusCategory?.key || null,
        statusHistory:     extractStatusHistory(issue)
    };
}

/**
 * Detect the portfolio hierarchy scope of a raw Jira issue.
 * Uses issuetype.hierarchyLevel to map to a named scope:
 *   hierarchyLevel >= 3 → 'objective'  (portfolio root)
 *   hierarchyLevel === 2 → 'initiative'
 *   hierarchyLevel === 1 → 'epic'      (Epic, Milestone, etc.)
 *   hierarchyLevel <= 0  → 'item'      (Story, Task, Bug — cannot be a portfolio root)
 *   null / missing       → 'unknown'
 *
 * @param {Object} issue - Raw Jira issue (needs at least issuetype + summary fields)
 * @returns {{ scope: 'objective'|'initiative'|'epic'|'item'|'unknown', hierarchyLevel: number|null, issuetypeName: string, summary: string }}
 */
export function extractItemScope(issue) {
    const f              = issue.fields || {};
    const hierarchyLevel = f.issuetype?.hierarchyLevel ?? null;
    const issuetypeName  = f.issuetype?.name || 'Unknown';
    const summary        = f.summary || issue.key;

    let scope;
    if (hierarchyLevel === null)   scope = 'unknown';
    else if (hierarchyLevel >= 3)  scope = 'objective';
    else if (hierarchyLevel === 2) scope = 'initiative';
    else if (hierarchyLevel === 1) scope = 'epic';
    else                           scope = 'item';

    return { scope, hierarchyLevel, issuetypeName, summary };
}

/**
 * Split an array into chunks of at most n elements.
 * Used to keep JQL IN clauses within character limits.
 * @param {Array}  arr - Input array
 * @param {number} n   - Max chunk size
 * @returns {Array[]}
 */
export function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

/**
 * Extract unique closed sprints from a set of raw Jira issues.
 *
 * Reads the sprint custom field (an array of sprint objects) from each issue,
 * deduplicates by sprint ID, filters to sprints whose endDate falls within the
 * look-back window, sorts newest-first, and caps the result at `maxSprints`.
 *
 * @param {Object[]} issues         - Raw Jira issue objects that include the sprint field.
 * @param {string}   sprintField    - Custom field key, e.g. 'customfield_10020'.
 * @param {number}   [months=6]     - Look-back window in calendar months.
 * @param {number}   [maxSprints=6] - Maximum sprints to return.
 * @returns {Object[]} Sorted array of sprint objects { id, name, state, boardId, startDate, endDate }.
 */
export function extractClosedSprints(issues, sprintField, months = 6, maxSprints = 6) {
    const cutoff    = Date.now() - months * 30 * 24 * 60 * 60 * 1000;
    const sprintMap = {};

    for (const issue of issues) {
        const sprints = issue.fields?.[sprintField];
        if (!Array.isArray(sprints)) continue;
        for (const s of sprints) {
            if (s.state === 'closed' && s.id && s.endDate && new Date(s.endDate).getTime() >= cutoff) {
                sprintMap[s.id] = s;
            }
        }
    }

    return Object.values(sprintMap)
        .sort((a, b) => new Date(b.endDate) - new Date(a.endDate))
        .slice(0, maxSprints);
}

