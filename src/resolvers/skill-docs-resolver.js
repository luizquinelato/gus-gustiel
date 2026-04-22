/**
 * Skill Docs Resolver — export-skill-docs action
 *
 * Exports a comprehensive, formatted Confluence page documenting all
 * Gustiel skills, usage examples, access levels, and the ETL pipeline.
 * Content is static documentation with dynamic version/environment metadata.
 * Follows the same upsert/folder/path logic as exportToConfluence.
 */

import { getEnvFromJira, getUserEmail, getCurrentAccountId } from '../services/jira-api-service.js';
import { getSpaceByKey, findPageByTitle, createConfluencePage,
         updateConfluencePage, findOrCreatePageByPath }      from '../services/confluence-api-service.js';
import { REPORT_TIMEZONE, VERSION }                          from '../config/constants.js';
import { markdownToStorage, buildTocMacro, buildAnchorMacro } from '../formatters/confluence-formatter.js';
import {
    SKILL_01_MD, SKILL_02_MD, SKILL_03_MD, SKILL_04_05_MD,
    SKILL_06_MD, SKILL_07_MD, SKILL_08_MD, SKILL_09_MD,
    SKILL_10_MD, SKILL_ADMIN_MD, ARCHITECTURE_MD,
} from '../docs/index.js';

// ── Documentation helpers ─────────────────────────────────────────────────────

/**
 * Extract the display title from a doc's H1 heading.
 * Strips the "Skill XX — " prefix so each skill becomes a clean H2 in output.
 * e.g. "# Skill 06 — Team Sprint Analysis" → "Team Sprint Analysis"
 *      "# Admin Skills"                    → "Admin Skills"
 */
function getSkillTitle(md) {
    const m = md.match(/^# (?:Skill \S+ — )?(.+)/m);
    return m ? m[1].trim() : '';
}

/**
 * Strip the H1 line and demote remaining headings by one level (H2→H3, H3→H4).
 * Processes in reverse order to avoid double-demotion.
 * (?!#) lookahead ensures exact hash count is matched, not a longer heading.
 */
function demoteHeadings(md) {
    return md
        .replace(/^# .+(\r?\n|$)/m, '')    // strip first H1 line
        .replace(/^#{3}(?!#)/gm, '####')   // H3 → H4  (before H2→H3)
        .replace(/^#{2}(?!#)/gm, '###')    // H2 → H3
        .trimStart();
}

// ── Documentation markdown ────────────────────────────────────────────────────

/**
 * Compose the full Confluence page markdown from the bundled docs.
 *
 * Page structure:
 *   # 📖 Skills & Business Reference
 *     ## <skill title>          ← one H2 per skill (H1 stripped, title extracted)
 *       ### What It Does        ← original H2 demoted to H3
 *       ### Trigger Phrases
 *   ---
 *   # 🏗️ Technical Architecture
 *     ## What Is Gustiel?       ← architecture H2s kept at H2
 *     ## Architecture Overview
 *     ...
 */
function buildSkillDocsMarkdown(envName) {
    const skillFiles = [
        SKILL_01_MD, SKILL_02_MD, SKILL_03_MD, SKILL_04_05_MD,
        SKILL_06_MD, SKILL_07_MD, SKILL_08_MD, SKILL_09_MD,
        SKILL_10_MD, SKILL_ADMIN_MD,
    ];

    const skillsBody = skillFiles.map(doc => {
        const title = getSkillTitle(doc);
        const body  = demoteHeadings(doc);
        return `## ${title}\n\n${body}`;
    }).join('\n\n---\n\n');

    // Architecture: strip the H1 only — H2s stay as H2s
    const archBody = ARCHITECTURE_MD
        .replace(/^# .+(\r?\n|$)/m, '')
        .trimStart();

    return [
        `# 📖 Skills & Business Reference`,
        ``,
        `> **Version:** ${VERSION} · **Environment:** ${envName} · **Built by:** Gustavo Quinelato`,
        ``,
        skillsBody,
        ``,
        `---`,
        ``,
        `# 🏗️ Technical Architecture`,
        ``,
        archBody,
        ``,
        `[⬆ Back to top](#top)`,
    ].join('\n');
}


// ── Resolver ──────────────────────────────────────────────────────────────────

export const exportSkillDocs = async (event) => {
    const spaceKey   = (event?.payload?.spaceKey   || event?.spaceKey   || '').trim().toUpperCase();
    const parentPath = (event?.payload?.parentPath || event?.parentPath || '').trim();
    const folderId   = (event?.payload?.folderId   || event?.folderId   || '').trim();
    const accountId  = await getCurrentAccountId(event);

    if (!spaceKey) return { status: 'ERROR', message: 'Please provide a Confluence space key (e.g. GUSTIEL).' };

    let env;
    try {
        env = await getEnvFromJira();
    } catch (e) {
        return { status: 'ERROR', message: `Could not detect Jira environment: ${e.message}` };
    }

    const today     = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const userEmail = await getUserEmail(accountId);
    const byClause  = userEmail ? ` by [${userEmail}]` : '';
    const pageTitle = `📘 [${today}] Gustiel Skill Reference${byClause}`;

    const rawMarkdown = buildSkillDocsMarkdown(env.name);
    const fullContent = markdownToStorage(rawMarkdown);

    try {
        const space = await getSpaceByKey(spaceKey);

        const anchor = buildAnchorMacro('top');
        const toc    = buildTocMacro(1, 3);
        const now    = new Date();
        const createdAt = new Intl.DateTimeFormat('en-CA', {
            timeZone: REPORT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(now).replace(',', '');
        const tzLabel = new Intl.DateTimeFormat('en', { timeZone: REPORT_TIMEZONE, timeZoneName: 'short' })
            .formatToParts(now).find(p => p.type === 'timeZoneName')?.value ?? REPORT_TIMEZONE;

        const storageBody =
            `<p>${anchor}<em>📅 <strong>Created at:</strong> ${createdAt} ${tzLabel}</em></p>\n` +
            toc + '\n<hr/>\n' + fullContent;

        // ── Resolve parentId ──────────────────────────────────────────────────
        let parentId = null, parentIsFolder = false;
        if (folderId) {
            parentId       = folderId;
            parentIsFolder = true;
        } else if (parentPath) {
            parentId       = await findOrCreatePageByPath(space.id, parentPath);
            parentIsFolder = false;
        }

        // ── Upsert (3-tier) ───────────────────────────────────────────────────
        const existingAtTarget = await findPageByTitle(space.id, pageTitle, parentId, parentIsFolder);
        let page, wasUpdated = false, wasMoved = false;

        if (existingAtTarget) {
            page       = await updateConfluencePage(existingAtTarget.id, existingAtTarget.version.number, space.id, pageTitle, storageBody);
            wasUpdated = true;
        } else {
            const existingElsewhere = await findPageByTitle(space.id, pageTitle);
            if (existingElsewhere) {
                page       = await updateConfluencePage(existingElsewhere.id, existingElsewhere.version.number, space.id, pageTitle, storageBody, parentId || null);
                wasUpdated = true;
                wasMoved   = true;
            } else {
                page = await createConfluencePage(space.id, pageTitle, storageBody, parentId);
            }
        }

        const pageUrl = `${env.baseUrl}/wiki${page._links?.webui || `/spaces/${spaceKey}/pages/${page.id}`}`;
        const action  = wasMoved ? 'moved and updated' : wasUpdated ? 'updated' : 'exported';

        return {
            status:    'SUCCESS',
            pageTitle,
            pageUrl,
            spaceKey,
            action,
            wasUpdated,
            wasMoved,
            message:   `✅ Gustiel Skill Reference ${action} → ${pageUrl}`,
        };
    } catch (err) {
        return { status: 'ERROR', message: err.message };
    }
};
