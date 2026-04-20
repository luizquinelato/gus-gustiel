/**
 * Check Report Cache Resolver — Entry/Exit Handler
 *
 * Returns the state of the per-user export session for a given portfolio key.
 * Used by the Confluence export flow to let the user choose between:
 *   - Using existing cached data (fast export)
 *   - Starting a fresh extraction (wipes cache, re-runs all layers)
 *
 * Storage key: export_session:<accountId>:<portfolioKey>
 * Phases:
 *   'layers_1_4' — extraction complete, LCT not yet calculated
 *   'complete'   — full data including LCT, ready for export
 */

import { storage }                from '@forge/api';
import { REPORT_TIMEZONE, makeSessionKey } from '../config/constants.js';
import { searchJira, getCurrentAccountId } from '../services/jira-api-service.js';
import { extractItemScope }      from '../extractors/jira-extractor.js';

export const checkReportCache = async (event) => {
    const portfolioKey = (event?.payload?.portfolioKey || event?.portfolioKey || '').trim().toUpperCase();
    const accountId    = await getCurrentAccountId(event);

    if (!portfolioKey) {
        return { status: 'ERROR', message: 'portfolioKey is required.' };
    }

    // ── Scope detection — always performed so the agent knows whether to skip extraction ──
    let detectedScope = 'unknown';
    let parentKey     = null;
    try {
        const scopeItems = await searchJira(`key = "${portfolioKey}"`, ['summary', 'issuetype', 'parent']);
        if (scopeItems.length > 0) {
            const { scope } = extractItemScope(scopeItems[0]);
            detectedScope   = scope;
            parentKey       = scopeItems[0]?.fields?.parent?.key || null;
        }
    } catch (_) { /* non-fatal — scope stays 'unknown' */ }

    let cached = null;
    try {
        cached = await storage.get(makeSessionKey(accountId, portfolioKey));
    } catch (_e) {
        return { hasCachedData: false, portfolioKey, detectedScope, parentKey };
    }

    // No session at all → no cached data.
    // For Epic/Initiative scopes: a session written by the OLD code (before scope-aware extraction)
    // will have allTeams=[] and no detectedScope field — treat those as stale/invalid.
    const isLegacyMisfire = cached && (detectedScope === 'epic' || detectedScope === 'initiative')
        && !cached.detectedScope && (cached.allTeams || []).length === 0;

    if (!cached || isLegacyMisfire) {
        return { hasCachedData: false, portfolioKey, detectedScope, parentKey };
    }

    const _ts     = new Date(cached.timestamp);
    const _fmt    = new Intl.DateTimeFormat('en-CA', {
        timeZone: REPORT_TIMEZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(_ts).replace(',', '');
    const _tz     = new Intl.DateTimeFormat('en', { timeZone: REPORT_TIMEZONE, timeZoneName: 'short' })
        .formatToParts(_ts).find(p => p.type === 'timeZoneName')?.value ?? REPORT_TIMEZONE;
    const cachedAt = `${_fmt} ${_tz}`;

    return {
        hasCachedData:    true,
        phase:            cached.phase,        // 'layers_1_4' | 'complete'
        cachedAt,
        portfolioKey:     cached.portfolioKey || portfolioKey,
        detectedScope,
        parentKey,
        allTeams:         cached.allTeams      || [],
        teamCount:        (cached.allTeams     || []).length,
        initiativeCount:  cached.initiativeCount ?? 0,
        epicCount:        cached.epicCount       ?? 0,
        hasLctData:       cached.phase === 'complete' && !!cached.lctByTeam,
    };
};

