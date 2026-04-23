/**
 * Skill Docs Resolver — export-skill-docs action
 *
 * Exports the Gustiel USER GUIDE to Confluence — a business-friendly page
 * containing the User Guide section from each skill doc, preceded by a
 * DEV vs PROD orientation preamble and the bundled screenshots.
 *
 * For the Technical Reference export, see architecture-guide-resolver.js.
 */

import { getEnvFromJira, getUserEmail, getCurrentAccountId } from '../services/jira-api-service.js';
import { getSpaceByKey, findPageByTitle, createConfluencePage,
         updateConfluencePage, findOrCreatePageByPath,
         uploadAttachment }                                   from '../services/confluence-api-service.js';
import { REPORT_TIMEZONE, VERSION }                           from '../config/constants.js';
import { markdownToStorage, buildTocMacro, buildAnchorMacro } from '../formatters/confluence-formatter.js';
import { USER_GUIDE_MD, SCREENSHOTS }                         from '../docs/index.js';

// ── DEV vs PROD preamble ──────────────────────────────────────────────────────

/**
 * Build the orientation preamble for the User Guide page.
 * Tells users which agent they are on (DEV vs PROD) and how to switch.
 */
function buildPreamble(envName) {
    const isDev     = envName?.toLowerCase().includes('sandbox') || envName?.toLowerCase().includes('dev');
    const envBadge  = isDev ? '⚠️ **This page was exported from the DEV (Sandbox) instance.**' : '✅ **This page was exported from the PRODUCTION instance.**';
    const agentNote = isDev
        ? 'When using Rovo Chat, make sure you are talking to **[DEV] Gustiel** for test features, or **Gustiel (Portfolio Sentinel)** for stable production features.'
        : 'When using Rovo Chat, use **Gustiel (Portfolio Sentinel)** for daily work. The **[DEV] Gustiel** agent runs experimental features on the Sandbox instance.';

    return [
        `## 🧭 Which Gustiel Am I On?`,
        ``,
        `> ${envBadge}`,
        `> ${agentNote}`,
        ``,
        `There are two Gustiel agents available in Rovo:`,
        ``,
        `| Agent | Instance | When to use |`,
        `|---|---|---|`,
        `| **Gustiel (Portfolio Sentinel)** | Production | Daily work — stable, recommended |`,
        `| **[DEV] Gustiel** | Sandbox | Testing new features |`,
        ``,
        `![How to browse agents in Rovo](ATTACH:doc_dev_prod_browse_agents.png)`,
        ``,
    ].join('\n');
}

// ── Page markdown ─────────────────────────────────────────────────────────────

function buildUserGuideMarkdown(envName) {
    const preamble = buildPreamble(envName);
    return [
        `# 📖 Gustiel — User Guide`,
        ``,
        `> **Version:** ${VERSION} · **Environment:** ${envName} · **Built by:** Gustavo Quinelato`,
        ``,
        preamble,
        `---`,
        ``,
        USER_GUIDE_MD,
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
    const pageTitle = `📖 [${today}] Gustiel User Guide${byClause}`;

    const rawMarkdown = buildUserGuideMarkdown(env.name);
    const fullContent = markdownToStorage(rawMarkdown, { uniformColumns: true });

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

        // ── Upload screenshots as attachments ─────────────────────────────────
        // Attachments must exist on the page before Confluence can render <ac:image> tags.
        // After uploading, we do a final page re-update so Confluence re-resolves all
        // ri:attachment references with the now-present files (avoids "Preview unavailable").
        const screenshotFiles = Object.keys(SCREENSHOTS);
        const uploadResults   = [];
        for (const filename of screenshotFiles) {
            try {
                await uploadAttachment(page.id, filename, SCREENSHOTS[filename]);
                uploadResults.push({ filename, status: 'ok' });
            } catch (uploadErr) {
                console.error(`[exportSkillDocs] Screenshot upload failed for "${filename}": ${uploadErr.message}`);
                uploadResults.push({ filename, status: 'failed', error: uploadErr.message });
            }
        }

        // Force re-render: re-PUT the same content now that attachments exist.
        // Pass parentId explicitly so the page is NOT moved to the space root
        // (Confluence v2 PUT moves the page if parentId is omitted and the page lives
        // inside a native folder).
        if (screenshotFiles.length > 0 && uploadResults.some(r => r.status === 'ok')) {
            try {
                const currentVersion = page.version?.number ?? (wasUpdated ? null : 1);
                if (currentVersion != null) {
                    page = await updateConfluencePage(page.id, currentVersion, space.id, pageTitle, storageBody, parentId || null);
                }
            } catch (reRenderErr) {
                // Non-fatal — images may still show on next page load
                console.warn(`[exportSkillDocs] Re-render update failed: ${reRenderErr.message}`);
            }
        }

        const pageUrl = `${env.baseUrl}/wiki${page._links?.webui || `/spaces/${spaceKey}/pages/${page.id}`}`;
        const action  = wasMoved ? 'moved and updated' : wasUpdated ? 'updated' : 'exported';

        return {
            status:        'SUCCESS',
            pageTitle,
            pageUrl,
            spaceKey,
            action,
            wasUpdated,
            wasMoved,
            screenshots:   uploadResults,
            message:       `✅ Gustiel User Guide ${action} → ${pageUrl}`,
        };
    } catch (err) {
        return { status: 'ERROR', message: err.message };
    }
};
