/**
 * Token Budget Estimator — Pure Utility
 *
 * Estimates token consumption of Markdown strings using a conservative
 * character-to-token ratio (3.5 chars/token for Claude).
 *
 * Used by resolvers to ensure only complete sections that fit within the
 * safe output token budget are included in each response — preventing
 * mid-table truncation without relying on the LLM to self-police.
 *
 * ETL placement: pure utility (no I/O, no rendering, no side effects).
 */

import { SAFE_TOKEN_BUDGET, CHARS_PER_TOKEN } from '../config/constants.js';

/**
 * Estimates the token count for a string.
 *
 * @param {string} text
 * @returns {number} estimated token count
 */
export function estimateTokens(text) {
    return Math.ceil((text?.length || 0) / CHARS_PER_TOKEN);
}

/**
 * Greedily packs complete team sections within the safe token budget.
 *
 * Iterates sections in order, accumulating character count. Stops before
 * adding any section that would push the total over the budget. This
 * guarantees every returned section is complete — no partial tables.
 *
 * @param {Array<{team: string, markdown: string}>} sections
 *   All remaining team sections to consider, in display order.
 * @param {number} [reservedTokens=0]
 *   Tokens already consumed by non-team content (prose, labels, headers)
 *   so they are excluded from the available budget.
 * @returns {{
 *   fitted:          Array<{team: string, markdown: string}>,
 *   hasMore:         boolean,
 *   estimatedTokens: number
 * }}
 */
export function fitWithinBudget(sections, reservedTokens = 0) {
    const availableTokens = SAFE_TOKEN_BUDGET - reservedTokens;
    const budgetChars     = availableTokens * CHARS_PER_TOKEN;

    let   usedChars = 0;
    const fitted    = [];

    for (const section of sections) {
        const sectionChars = section.markdown.length;
        if (usedChars + sectionChars > budgetChars) break;
        fitted.push(section);
        usedChars += sectionChars;
    }

    return {
        fitted,
        hasMore:         fitted.length < sections.length,
        estimatedTokens: Math.ceil(usedChars / CHARS_PER_TOKEN),
    };
}

