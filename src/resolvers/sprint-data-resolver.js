/**
 * Sprint Data Resolver — Step 3 of the ETL Pipeline
 *
 * Reads the pre-collected recentClosedSprints per team from the session (Step 1),
 * delegates all GreenHopper fetching to fetchSprintReportsForTeams() in the shared
 * sprint extractor, and writes the results back to Forge Storage.
 *
 * Uses the Batched Accumulator Pattern to avoid Forge's 25 s timeout on large
 * portfolios (e.g. WX-1770 with 19 teams):
 *   - Processes ANALYSIS_SPRINT_TEAMS_PER_BATCH teams per invocation.
 *   - Persists progress in session.sprintTeamIndex + session.sprintAcc.
 *   - Returns PARTIAL until all teams are done; Rovo re-calls until SUCCESS.
 *
 * Idempotent: if session.sprintsByTeam is already fully populated (no batch in
 * progress), returns SUCCESS immediately with zero API calls.
 *
 * Returns:
 *   PARTIAL        — more teams remain; Rovo must call again immediately
 *   SUCCESS        — all teams done; session.sprintsByTeam is finalised
 *   NO_SPRINT_DATA — no teams had sprint boards
 *   NO_SESSION     — session not found (prepare-portfolio-export not run yet)
 *   ERROR          — unrecoverable failure
 *
 * Storage key: export_session:<accountId>:<portfolioKey>  (via makeSessionKey)
 */

import { storage }                                                    from '@forge/api';
import { getCurrentAccountId }                                        from '../services/jira-api-service.js';
import { makeSessionKey, ANALYSIS_SPRINT_TEAMS_PER_BATCH }           from '../config/constants.js';
import { fetchSprintReportsForTeams }                                 from '../extractors/sprint-extractor.js';

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

    // ── IDEMPOTENCY — already complete, no batch in progress ─────────────────
    // Safe to call on every key (including "use cache" sessions) — zero API calls.
    if (session.sprintsByTeam && !session.sprintTeamIndex && Object.keys(session.sprintsByTeam).length > 0) {
        const n = Object.keys(session.sprintsByTeam).length;
        console.log(`[SprintData] ${portfolioKey} already complete — ${n} team(s) cached, skipping re-fetch`);
        return {
            status:         'SUCCESS',
            portfolioKey,
            teamsProcessed: n,
            message:        `✅ Sprint data already complete for **${portfolioKey}** — ${n} team(s) cached.`,
        };
    }

    // ── NO DATA ───────────────────────────────────────────────────────────────
    if (teamsWithSprints.length === 0) {
        // Detect old session format — clear any stale sprint fields
        const hasOldFormat = allTeams.length > 0 && Object.keys(newestSprintIdByTeam).length > 0;
        if (hasOldFormat) {
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
                message: `⚠️ Session for **${portfolioKey}** uses an older format with no sprint snapshots. Wipe the session and re-run \`prepare-portfolio-export\`, then retry.`,
            };
        }
        return {
            status: 'NO_SPRINT_DATA',
            portfolioKey,
            message: `⚠️ No sprint data found for **${portfolioKey}**. Teams may not have stories assigned to sprints.`,
        };
    }

    // ── BATCHED EXTRACTION ────────────────────────────────────────────────────
    // Pick up where the previous invocation left off (or start at 0).
    const startIndex = session.sprintTeamIndex ?? 0;
    const acc        = session.sprintAcc        ?? {};

    const batch      = teamsWithSprints.slice(startIndex, startIndex + ANALYSIS_SPRINT_TEAMS_PER_BATCH);
    const nextIndex  = startIndex + batch.length;

    console.log(`[SprintData] ${portfolioKey} batch ${startIndex + 1}–${nextIndex} of ${teamsWithSprints.length} teams`);

    const batchResults = await fetchSprintReportsForTeams(batch, newestSprintIdByTeam);
    const newAcc       = { ...acc, ...batchResults };

    // ── MORE BATCHES REMAIN — persist and signal PARTIAL ──────────────────────
    if (nextIndex < teamsWithSprints.length) {
        try {
            await storage.set(makeSessionKey(accountId, portfolioKey), {
                ...session,
                sprintTeamIndex: nextIndex,
                sprintAcc:       newAcc,
            });
        } catch (e) {
            return { status: 'ERROR', message: `Failed to save batch progress: ${e.message}` };
        }
        return {
            status:      'PARTIAL',
            portfolioKey,
            batchDone:   nextIndex,
            totalTeams:  teamsWithSprints.length,
            message:     `⏳ Sprint data: ${nextIndex}/${teamsWithSprints.length} teams processed — continuing…`,
        };
    }

    // ── ALL BATCHES DONE — finalise and write ─────────────────────────────────
    try {
        await storage.set(makeSessionKey(accountId, portfolioKey), {
            ...session,
            sprintsByTeam:   newAcc,
            sprintTeamIndex: undefined,
            sprintAcc:       undefined,
        });
        console.log(`[SprintData] ${portfolioKey} SUCCESS — ${Object.keys(newAcc).length}/${teamsWithSprints.length} teams written`);
    } catch (e) {
        return { status: 'ERROR', message: `Failed to save sprint results: ${e.message}` };
    }

    return {
        status:         'SUCCESS',
        portfolioKey,
        teamsProcessed: teamsWithSprints.length,
        message:        `✅ Sprint data collected for **${portfolioKey}** — ${teamsWithSprints.length} team(s) analysed.\n\n` +
            Object.entries(newAcc)
                .map(([t, d]) => d.error
                    ? `- **${t}**: ⚠️ ${d.error}`
                    : `- **${t}**: ${d.boardName} · ${d.sprints.length} sprint(s)`)
                .join('\n'),
    };
};
