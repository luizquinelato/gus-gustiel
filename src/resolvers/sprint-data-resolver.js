/**
 * Sprint Data Resolver — Step 3 of the ETL Pipeline
 *
 * Reads the pre-collected recentClosedSprints per team from the session (Step 1),
 * delegates all GreenHopper fetching to fetchSprintReportsForTeams() in the shared
 * sprint extractor, and writes the results back to Forge Storage.
 *
 * Rate-limiting (semaphore) and board discovery are both handled by the extractor.
 * This resolver is a thin orchestrator: read session → extract → write session.
 *
 * Final output: session.sprintsByTeam
 * Storage key:  export_session:<accountId>:<portfolioKey>  (via makeSessionKey)
 */

import { storage }                                          from '@forge/api';
import { getCurrentAccountId }                              from '../services/jira-api-service.js';
import { makeSessionKey }                                   from '../config/constants.js';
import { fetchSprintReportsForTeams }                       from '../extractors/sprint-extractor.js';

export const calculateSprintData = async (event) => {
    const portfolioKey = (event?.payload?.portfolioKey || event?.portfolioKey || '').trim().toUpperCase();
    const accountId    = await getCurrentAccountId(event);

    if (!portfolioKey) {
        return { status: 'ERROR', message: 'portfolioKey is required.' };
    }

    // ── READ session ──────────────────────────────────────────────────────────
    let session;
    try {
        session = await storage.get(makeSessionKey(accountId, portfolioKey));
    } catch (e) {
        return { status: 'ERROR', message: `Could not read session: ${e.message}` };
    }

    if (!session) {
        return { status: 'NO_SESSION', message: `No session found for **${portfolioKey}**. Run \`prepare-portfolio-export\` first.` };
    }

    const newestSprintIdByTeam = session.newestSprintIdByTeam || {};
    const allTeams             = session.allTeams || [];

    // Only process teams that have pre-collected closed sprints from Step 1
    const teamsWithSprints = allTeams.filter(t => newestSprintIdByTeam[t]?.recentClosedSprints?.length > 0);

    // Detect old session format (no recentClosedSprints) — clear stale sprint data so
    // the export shows the placeholder rather than old "Report unavailable" rows.
    const hasOldFormat = allTeams.length > 0
        && Object.keys(newestSprintIdByTeam).length > 0
        && teamsWithSprints.length === 0;

    if (teamsWithSprints.length === 0) {
        if (hasOldFormat) {
            // Clear stale data so the Confluence export won't show outdated sprint rows
            try {
                await storage.set(makeSessionKey(accountId, portfolioKey), {
                    ...session,
                    sprintsByTeam:   undefined,
                    sprintTeamIndex: undefined,
                    sprintAcc:       undefined,
                });
            } catch (_) { /* best-effort */ }
            return {
                status: 'NO_SPRINT_DATA',
                portfolioKey,
                message: `⚠️ Session for **${portfolioKey}** is from an older format and does not contain sprint history snapshots.\n\nPlease **wipe the session** and re-run \`prepare-portfolio-export\` to capture sprint data, then run \`calculate-sprint-data\` again.`,
            };
        }
        return {
            status: 'NO_SPRINT_DATA',
            portfolioKey,
            message: `⚠️ No sprint data found for **${portfolioKey}**. Teams may not have stories assigned to sprints, or the sprint field was not populated.`,
        };
    }

    // ── EXTRACT — delegate entirely to the shared sprint extractor.
    // fetchSprintReportsForTeams runs teams in parallel, applies a shared semaphore
    // (GREENHOPPER_CONCURRENCY_LIMIT) across ALL GreenHopper calls, and parses reports.
    const sprintsByTeam = await fetchSprintReportsForTeams(teamsWithSprints, newestSprintIdByTeam);

    // ── SUCCESS — write results and return ────────────────────────────────────
    try {
        await storage.set(makeSessionKey(accountId, portfolioKey), {
            ...session,
            sprintsByTeam,
            sprintTeamIndex: undefined,
            sprintAcc:       undefined,
        });
    } catch (e) {
        return { status: 'ERROR', message: `Failed to save sprint results: ${e.message}` };
    }

    return {
        status:         'SUCCESS',
        portfolioKey,
        teamsProcessed: teamsWithSprints.length,
        message:        `✅ Sprint data collected for **${portfolioKey}** — ${teamsWithSprints.length} team(s) analysed.\n\n` +
            Object.entries(sprintsByTeam)
                .map(([t, d]) => d.error
                    ? `- **${t}**: ⚠️ ${d.error}`
                    : `- **${t}**: ${d.boardName} · ${d.sprints.length} sprint(s)`)
                .join('\n'),
    };
};
