/**
 * Architecture Guide Resolver — export-architecture-guide action
 *
 * Exports the Gustiel TECHNICAL REFERENCE to Confluence — a developer-focused
 * page containing the Technical Reference section from each skill doc,
 * followed by the full architecture document.
 *
 * For the User Guide export (business-friendly), see skill-docs-resolver.js.
 */

import { getEnvFromJira, getUserEmail, getCurrentAccountId } from '../services/jira-api-service.js';
import { getSpaceByKey, findPageByTitle, createConfluencePage,
         updateConfluencePage, findOrCreatePageByPath }       from '../services/confluence-api-service.js';
import { REPORT_TIMEZONE, VERSION }                           from '../config/constants.js';
import { markdownToStorage, buildTocMacro, buildAnchorMacro } from '../formatters/confluence-formatter.js';
import { TECH_REF_MD }                                        from '../docs/index.js';

// ── Page markdown ─────────────────────────────────────────────────────────────

function buildTechRefMarkdown(envName) {
    return [
        `# 🏗️ Gustiel — Technical Reference`,
        ``,
        `> **Version:** ${VERSION} · **Environment:** ${envName} · **Built by:** Gustavo Quinelato`,
        ``,
        `> This page documents internal implementation details — resolvers, ETL pipeline, data flow,`,
        `> and architectural patterns. For the user-facing guide, see the Gustiel User Guide page.`,
        ``,
        TECH_REF_MD,
        ``,
        `[⬆ Back to top](#top)`,
    ].join('\n');
}

// ── Resolver ──────────────────────────────────────────────────────────────────

export const exportArchitectureGuide = async (event) => {
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
    const pageTitle = `🏗️ [${today}] Gustiel Technical Reference${byClause}`;

    const rawMarkdown = buildTechRefMarkdown(env.name);
    const fullContent = markdownToStorage(rawMarkdown);

    try {
        const space = await getSpaceByKey(spaceKey);

        const anchor    = buildAnchorMacro('top');
        const toc       = buildTocMacro(1, 3);
        const now       = new Date();
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
            message:   `✅ Gustiel Technical Reference ${action} → ${pageUrl}`,
        };
    } catch (err) {
        return { status: 'ERROR', message: err.message };
    }
};
