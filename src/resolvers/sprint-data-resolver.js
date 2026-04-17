/**
 * Sprint Data Resolver — Step 3 of the ETL Pipeline
 *
 * For each agile team identified in the session, this resolver:
 *   1. Reads the pre-collected recentClosedSprints per team from the session (Step 1)
 *   2. Calls the GreenHopper sprint report API for each sprint (asUser, per-sprint)
 *   3. Uses parseGreenHopperSprintReport() to extract planned (estimateStatistic) and
 *      velocity/rolledOver/removed/added (currentEstimateStatistic)
 *   4. Returns data shaped for formatSprintSection()
 *
 * Uses the same PARTIAL → SUCCESS pattern as calculate-lead-time-data.
 * Processes ANALYSIS_SPRINT_TEAMS_PER_BATCH teams per Forge invocation to
 * stay well within the 25-second timeout.
 *
 * Resume token: session.sprintTeamIndex (int, 0 on first call)
 * Accumulator:  session.sprintAcc       (object, built up across PARTIAL calls)
 * Final output: session.sprintsByTeam   (written only on SUCCESS)
 *
 * Storage key: export_session:<accountId>:<portfolioKey>
 */

import { storage }                                          from '@forge/api';
import { getBoardById, getGreenHopperSprintReport,
         getCurrentAccountId }                              from '../services/jira-api-service.js';
import { parseGreenHopperSprintReport }                     from '../transformers/portfolio-transformer.js';
import { ANALYSIS_SPRINT_TEAMS_PER_BATCH }                  from '../config/constants.js';

const sessionKey = (accountId, portfolioKey) =>
    `export_session:${accountId}:${portfolioKey}`;

export const calculateSprintData = async (event) => {
    const portfolioKey = (event?.payload?.portfolioKey || event?.portfolioKey || '').trim().toUpperCase();
    const accountId    = await getCurrentAccountId(event);

    if (!portfolioKey) {
        return { status: 'ERROR', message: 'portfolioKey is required.' };
    }

    // ── READ session ──────────────────────────────────────────────────────────
    let session;
    try {
        session = await storage.get(sessionKey(accountId, portfolioKey));
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
                await storage.set(sessionKey(accountId, portfolioKey), {
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

    // ── Resume state ──────────────────────────────────────────────────────────
    const sprintTeamIndex = session.sprintTeamIndex ?? 0;
    const sprintAcc       = session.sprintAcc       ?? {};

    // ── Process next batch of teams ───────────────────────────────────────────
    const batch = teamsWithSprints.slice(sprintTeamIndex, sprintTeamIndex + ANALYSIS_SPRINT_TEAMS_PER_BATCH);

    for (const team of batch) {
        const newestSprint = newestSprintIdByTeam[team];

        try {
            const boardId = newestSprint.boardId;
            const targetSprints = newestSprint.recentClosedSprints || [];

            // 1. Resolve board name (best-effort; falls back gracefully)
            const boardMeta = await getBoardById(boardId);
            const boardName = boardMeta?.name || (boardId ? `Board ${boardId}` : 'Unknown Board');

            // 2. EXTRACT — GreenHopper sprint report (asApp, works in all Forge contexts)
            const sprints = [];

            for (const sprint of targetSprints) {
                const report = await getGreenHopperSprintReport(boardId, sprint.id);
                if (!report) {
                    console.warn(`[SprintData] ${team}: GreenHopper returned null for sprint ${sprint.id} (${sprint.name})`);
                    sprints.push({ id: sprint.id, name: sprint.name, endDate: sprint.endDate, error: 'Sprint report unavailable' });
                    continue;
                }
                sprints.push(parseGreenHopperSprintReport(report, sprint));
            }

            sprintAcc[team] = { boardId, boardName, sprints };
            console.log(`[SprintData] ${team}: board="${boardName}" (${boardId}), ${sprints.length} sprint(s) collected`);

        } catch (teamErr) {
            console.error(`[SprintData] Error processing team ${team}: ${teamErr.message}`);
            sprintAcc[team] = { error: teamErr.message };
        }
    }

    const newIndex   = sprintTeamIndex + batch.length;
    const isComplete = newIndex >= teamsWithSprints.length;

    // ── PARTIAL — more teams remain ───────────────────────────────────────────
    if (!isComplete) {
        try {
            await storage.set(sessionKey(accountId, portfolioKey), {
                ...session,
                sprintTeamIndex: newIndex,
                sprintAcc,
            });
        } catch (e) {
            return { status: 'ERROR', message: `Failed to save partial sprint state: ${e.message}` };
        }
        return {
            status:         'PARTIAL',
            portfolioKey,
            teamsProcessed: newIndex,
            teamsTotal:     teamsWithSprints.length,
            message:        `⏳ Sprint data: ${newIndex}/${teamsWithSprints.length} teams processed. Continuing…`,
        };
    }

    // ── SUCCESS — all teams done ──────────────────────────────────────────────
    try {
        await storage.set(sessionKey(accountId, portfolioKey), {
            ...session,
            sprintsByTeam:   sprintAcc,
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
            Object.entries(sprintAcc)
                .map(([t, d]) => d.error
                    ? `- **${t}**: ⚠️ ${d.error}`
                    : `- **${t}**: ${d.boardName} · ${d.sprints.length} sprint(s)`)
                .join('\n'),
    };
};
