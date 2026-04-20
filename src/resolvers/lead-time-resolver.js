/**
 * Lead Time Resolver — Entry/Exit Handler (Batched Accumulator Pattern)
 *
 * Step 2 of the two-step fresh-extraction flow:
 *   1. prepare-portfolio-export  → layers 1–3, saves teams + counts
 *   2. calculate-lead-time-data  → combined Epic + Story changelog query (this file)
 *
 * A single JQL query using hierarchyLevel in (0, 1) fetches both epics and
 * story-level items in one paginated batch. Each item is routed to the correct
 * sub-accumulator (velocityAcc for epics, lctAcc for stories / tasks / bugs).
 *
 * Returns:
 *   PARTIAL  — more pages remain; Rovo auto-calls this action again
 *   SUCCESS  — all pages done; lctByTeam + velocityByTeam finalised and session marked 'complete'
 *   ERROR    — unrecoverable failure
 *
 * Storage key: export_session:<accountId>:<portfolioKey>
 */

import { storage }                                              from '@forge/api';
import { getEnvFromJira, searchJiraBatch,
         getCurrentAccountId }                                  from '../services/jira-api-service.js';
import { PORTFOLIO_WORKFLOWS, LCT_PAGES_PER_BATCH,
         makeSessionKey }                                       from '../config/constants.js';
import { extractItemForLCT }                                   from '../extractors/jira-extractor.js';
import { mergeItemsIntoLCTAccumulator, finalizeLCTAccumulator } from '../transformers/portfolio-transformer.js';

export const calculateLeadTimeData = async (event) => {
    const portfolioKey = (event?.payload?.portfolioKey || event?.portfolioKey || '').trim().toUpperCase();
    const accountId    = await getCurrentAccountId(event);

    if (!portfolioKey) {
        return { status: 'ERROR', message: 'portfolioKey is required.' };
    }

    // ── READ — session written by preparePortfolioExport ─────────────────────
    let session = null;
    try {
        session = await storage.get(makeSessionKey(accountId, portfolioKey));
    } catch (readErr) {
        return { status: 'ERROR', message: `Could not read session data: ${readErr.message}` };
    }

    if (!session) {
        return {
            status: 'NO_SESSION',
            message: `No extraction session found for **${portfolioKey}**. Run \`prepare-portfolio-export\` first.`,
        };
    }

    const { allTeams } = session;

    if (!allTeams || allTeams.length === 0) {
        return {
            status: 'NO_TEAMS',
            message: `No agile teams found in the session for **${portfolioKey}**. Re-run \`prepare-portfolio-export\`.`,
        };
    }

    // ── Environment + field config ────────────────────────────────────────────
    const env               = await getEnvFromJira();
    const fields            = env.fields;
    const agileTeamFieldNum = session.agileTeamFieldNum || fields.agileTeam.replace('customfield_', '');
    const teamList          = allTeams.map(t => `"${t}"`).join(', ');

    // ── Resume pagination state from session (null/0 on first call) ───────────
    // acc is the combined { lctAcc, velocityAcc } object.
    const acc = (session.lctAcc || session.velocityAcc)
        ? { lctAcc: session.lctAcc || {}, velocityAcc: session.velocityAcc || {} }
        : {};
    const lctPageToken = session.lctPageToken || null;
    const lctPagesRead = session.lctPagesRead || 0;
    const lctItemsRead = session.lctItemsRead || 0;

    // ── JQL — combined Epic + Story-level items ───────────────────────────────
    // hierarchyLevel in (0, 1) returns both epics (level 1) and story-level items (level 0).
    const lctJql = [
        `hierarchyLevel in (0, 1)`,
        `AND cf[${agileTeamFieldNum}] in (${teamList})`,
        `AND ((statusCategory = Done AND updated >= -180d) OR statusCategory = "In Progress")`
    ].join(' ');

    // ── EXTRACT — Fetch exactly LCT_PAGES_PER_BATCH pages from resume token ──
    const { issues: rawBatch, nextPageToken, isLast, pagesRead } = await searchJiraBatch(
        lctJql,
        [fields.agileTeam, 'status', 'issuetype', 'summary'],
        ['changelog'],
        100,                  // page size (max 100 per Jira API)
        LCT_PAGES_PER_BATCH,  // pages per Forge invocation
        lctPageToken          // null = first call; token = resume
    );

    // ── TRANSFORM — Extract minimal fields, route into dual accumulator ───────
    const extractedItems = rawBatch.map(raw => extractItemForLCT(raw, fields.agileTeam));
    mergeItemsIntoLCTAccumulator(extractedItems, PORTFOLIO_WORKFLOWS.STORY, PORTFOLIO_WORKFLOWS.EPIC, acc);

    const newPagesRead = lctPagesRead + pagesRead;
    const newItemsRead = lctItemsRead + extractedItems.length;

    // ── PARTIAL — More pages remain: persist state and return progress ─────────
    if (!isLast && nextPageToken) {
        const partialSession = {
            ...session,
            phase:        'lct_in_progress',
            lctAcc:       acc.lctAcc,
            velocityAcc:  acc.velocityAcc,
            lctPageToken: nextPageToken,
            lctPagesRead: newPagesRead,
            lctItemsRead: newItemsRead,
        };
        try {
            await storage.set(makeSessionKey(accountId, portfolioKey), partialSession);
        } catch (storeErr) {
            return { status: 'ERROR', message: `Failed to save partial LCT state: ${storeErr.message}` };
        }
        return {
            status:     'PARTIAL',
            portfolioKey,
            pagesRead:  newPagesRead,
            itemCount:  newItemsRead,
            message:    `⏳ **${portfolioKey}** — Pages Extracted: ${newPagesRead} (${newItemsRead} items processed so far). Continuing…`,
        };
    }

    // ── SUCCESS — All pages done: finalize averages and save ─────────────────
    const { lctByTeam, velocityByTeam, overallVelocity } = finalizeLCTAccumulator(acc, allTeams);

    const completedSession = {
        ...session,
        phase:           'complete',
        timestamp:       Date.now(),
        lctByTeam,
        velocityByTeam,
        overallVelocity,
        lctPagesRead:    newPagesRead,
        lctItemsRead:    newItemsRead,
        // Clean up intermediate accumulator fields
        lctAcc:          undefined,
        velocityAcc:     undefined,
        lctPageToken:    undefined,
    };

    try {
        await storage.set(makeSessionKey(accountId, portfolioKey), completedSession);
    } catch (storeErr) {
        return { status: 'ERROR', message: `Failed to save LCT results: ${storeErr.message}` };
    }

    // Build per-team summary for display
    const teamSummary = allTeams.map(team => {
        const lct = lctByTeam[team];
        const vel = velocityByTeam[team];
        const parts = [];
        if (vel) parts.push(`Velocity: ${vel.averageDays}d avg (${vel.epicCount} epics)`);
        if (lct?.overall?.leadTime)  parts.push(`Lead: ${lct.overall.leadTime.averageDays}d`);
        if (lct?.overall?.cycleTime) parts.push(`Cycle: ${lct.overall.cycleTime.averageDays}d`);
        return `- **${team}**: ${parts.length ? parts.join(' · ') : 'no data'}`;
    }).join('\n');

    return {
        status:      'SUCCESS',
        portfolioKey,
        phase:       'complete',
        teamCount:   allTeams.length,
        itemCount:   newItemsRead,
        pagesRead:   newPagesRead,
        message:     `✅ Innovation Velocity + Lead/Cycle Time calculated for **${portfolioKey}** across ${allTeams.length} team(s) using ${newItemsRead} items (${newPagesRead} pages).\n\n${teamSummary}`,
    };
};

