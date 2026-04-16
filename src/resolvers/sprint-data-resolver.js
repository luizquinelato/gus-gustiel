/**
 * Sprint Data Resolver — Step 3 of the ETL Pipeline
 *
 * For each agile team identified in the session, this resolver:
 *   1. Uses the stored newest sprint ID to discover the team's Jira board
 *   2. Fetches the board's most recent closed sprints (last 6 months, max 6)
 *   3. Calls the GreenHopper sprint report API for each sprint
 *   4. Computes velocity, say/do ratio, and rolled-over SP per sprint
 *
 * Uses the same PARTIAL → SUCCESS pattern as calculate-lead-time-data.
 * Processes ANALYSIS_SPRINT_TEAMS_PER_BATCH teams per Forge invocation to
 * stay well within the 25-second timeout (~9 API calls per team).
 *
 * Resume token: session.sprintTeamIndex (int, 0 on first call)
 * Accumulator:  session.sprintAcc       (object, built up across PARTIAL calls)
 * Final output: session.sprintsByTeam   (written only on SUCCESS)
 *
 * Storage key: export_session:<accountId>:<portfolioKey>
 */

import { storage }                                                        from '@forge/api';
import { getBoardById, getSprintReport }                                  from '../services/jira-api-service.js';
import { ANALYSIS_SPRINT_TEAMS_PER_BATCH }                               from '../config/constants.js';

const sessionKey = (accountId, portfolioKey) =>
    `export_session:${accountId}:${portfolioKey}`;

/** Say/Do RAG thresholds */
const sayDoRag = ratio => ratio >= 0.8 ? '🟢' : ratio >= 0.5 ? '🟡' : '🔴';

export const calculateSprintData = async (event) => {
    const portfolioKey = (event?.payload?.portfolioKey || event?.portfolioKey || '').trim().toUpperCase();
    const accountId    = event?.context?.accountId || 'shared';

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

    // Only process teams for which we captured a sprint ID in Step 1
    const teamsWithSprints = allTeams.filter(t => newestSprintIdByTeam[t]?.id);

    if (teamsWithSprints.length === 0) {
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
            // 1. Board ID is embedded in the sprint field on the issue (fetched in Step 1)
            const boardId = newestSprint.boardId;
            if (!boardId) {
                sprintAcc[team] = { error: `No boardId found on sprint ${newestSprint.id} (${newestSprint.name}). Team stories may not be assigned to a sprint board.` };
                continue;
            }

            // 2. Resolve board name (best-effort; falls back gracefully)
            const boardMeta = await getBoardById(boardId);
            const boardName = boardMeta?.name || `Board ${boardId}`;

            // 3. Use pre-collected closed sprints from Step 1 (embedded in story sprint field).
            //    recentClosedSprints is already filtered to last 6 months and sorted newest-first.
            const targetSprints = newestSprint.recentClosedSprints || [];

            if (targetSprints.length === 0) {
                sprintAcc[team] = { boardId, boardName, sprints: [], warning: 'No closed sprints found in story sprint history for the last 6 months.' };
                continue;
            }

            // 4. GreenHopper report per sprint
            const sprintsWithData = [];
            for (const sprint of targetSprints) {
                const report = await getSprintReport(boardId, sprint.id);
                if (!report) {
                    sprintsWithData.push({ id: sprint.id, name: sprint.name, endDate: sprint.endDate, error: 'Report unavailable' });
                    continue;
                }
                const finalScope = report.planned + report.added - report.removed;
                const sayDo      = finalScope > 0 ? report.completed / finalScope : 0;
                sprintsWithData.push({
                    id:          sprint.id,
                    name:        sprint.name,
                    endDate:     sprint.endDate,
                    planned:     Math.round(report.planned),
                    added:       Math.round(report.added),
                    removed:     Math.round(report.removed),
                    completed:   Math.round(report.completed),
                    rolledOver:  Math.round(report.notCompleted),
                    finalScope:  Math.round(finalScope),
                    sayDo:       Math.round(sayDo * 100) / 100,
                    sayDoRag:    sayDoRag(sayDo),
                });
            }

            sprintAcc[team] = { boardId, boardName, sprints: sprintsWithData };
            console.log(`[SprintData] ${team}: board="${boardName}" (${boardId}), ${sprintsWithData.length} sprint(s) collected`);

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
