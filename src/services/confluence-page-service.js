/**
 * Confluence Page Service — Shared page-level operations
 *
 * Centralises the two reusable blocks that every Confluence export resolver
 * needs but that would otherwise be copy-pasted across resolvers:
 *
 *   resolveDestination(spaceKey, folderId, newFolderTitle, parentPath)
 *     Priority chain: folderId > newFolderTitle > parentPath > space root
 *     → { space, parentId, parentIsFolder }
 *
 *   buildPageStorageBody(markdown)
 *     Wraps raw markdown in the standard page envelope:
 *     anchor + timestamp + TOC + <hr/> + markdownToStorage(markdown)
 *     → Confluence storage-format string
 *
 *   upsertPage(space, env, pageTitle, storageBody, parentId, parentIsFolder)
 *     3-tier upsert: update-in-place → move+update → create
 *     → { page, pageUrl, wasUpdated, wasMoved }
 */

import { getSpaceByKey, findPageByTitle, createConfluencePage,
         updateConfluencePage, createFolder, findFolderByTitle,
         findOrCreatePageByPath }                                from './confluence-api-service.js';
import { markdownToStorage, buildTocMacro,
         buildAnchorMacro }                                      from '../formatters/confluence-formatter.js';
import { REPORT_TIMEZONE }                                       from '../config/constants.js';

// ── resolveDestination ────────────────────────────────────────────────────────
/**
 * Resolves the Confluence parent location for a page export.
 *
 * @param {string} spaceKey      - Confluence space key (e.g. "PROJ")
 * @param {string} folderId      - Numeric folder ID (highest priority, no API call needed)
 * @param {string} newFolderTitle - Create (or locate) a folder with this title
 * @param {string} parentPath    - Slash-separated path of existing pages (lowest priority)
 * @returns {{ space, parentId: string|null, parentIsFolder: boolean }}
 */
export async function resolveDestination(spaceKey, folderId = '', newFolderTitle = '', parentPath = '') {
    const space = await getSpaceByKey(spaceKey);

    let parentId       = null;
    let parentIsFolder = false;

    if (folderId) {
        parentId       = folderId;
        parentIsFolder = true;
    } else if (newFolderTitle) {
        // Try to create the folder. If Confluence rejects with HTTP 400 (name conflict),
        // fall back to a title search so the same newFolderTitle can be reused on
        // every re-export without the caller having to switch to folderId manually.
        try {
            const folder = await createFolder(space.id, newFolderTitle);
            parentId       = String(folder.id);
            parentIsFolder = true;
        } catch (folderErr) {
            const errMsg     = folderErr?.message ?? String(folderErr);
            const isConflict = /HTTP 400/i.test(errMsg) || /already exist/i.test(errMsg);

            if (!isConflict) {
                throw new Error(`Could not create folder "${newFolderTitle}": ${errMsg}`);
            }

            // HTTP 400 → folder likely already exists; try to locate it by title.
            const existing = await findFolderByTitle(space.id, spaceKey, newFolderTitle);
            if (existing) {
                parentId       = String(existing.id);
                parentIsFolder = true;
            } else {
                throw new Error(
                    `Could not create folder "${newFolderTitle}" (conflict) and could not locate it by title. ` +
                    `Original error: ${errMsg}. ` +
                    `Open the folder in Confluence, copy the numeric ID from the URL ` +
                    `(e.g. /folder/52592641 → "52592641"), and re-export using folderId instead of newFolderTitle.`
                );
            }
        }
    } else if (parentPath) {
        parentId       = await findOrCreatePageByPath(space.id, parentPath);
        parentIsFolder = false;
    }

    return { space, parentId, parentIsFolder };
}

// ── buildPageStorageBody ──────────────────────────────────────────────────────
/**
 * Wraps markdown content in the standard page envelope used by all export resolvers:
 *   anchor[top] + timestamp paragraph + TOC macro + <hr/> + markdownToStorage(markdown)
 *
 * @param {string} markdown - Full report markdown (may contain multiple H1 sections)
 * @returns {string} Confluence storage-format XML string
 */
export function buildPageStorageBody(markdown) {
    const anchor    = buildAnchorMacro('top');
    const toc       = buildTocMacro(1, 4);
    const now       = new Date();
    const createdAt = new Intl.DateTimeFormat('en-CA', {
        timeZone: REPORT_TIMEZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(now).replace(',', ''); // → "YYYY-MM-DD HH:MM"
    const tzLabel   = new Intl.DateTimeFormat('en', { timeZone: REPORT_TIMEZONE, timeZoneName: 'short' })
        .formatToParts(now).find(p => p.type === 'timeZoneName')?.value ?? REPORT_TIMEZONE;

    return (
        `<p>${anchor}<em>📅 <strong>Created at:</strong> ${createdAt} ${tzLabel}</em></p>\n` +
        toc + '\n<hr/>\n' +
        markdownToStorage(markdown)
    );
}

// ── upsertPage ────────────────────────────────────────────────────────────────
/**
 * 3-tier upsert strategy:
 *   1. Page exists at the target location → update in-place.
 *   2. Page exists elsewhere in the space → MOVE + update content.
 *   3. No existing page → create fresh at the target location.
 *
 * @param {{ id: string }} space
 * @param {{ baseUrl: string, name: string }} env   - from getEnvFromJira()
 * @param {string} spaceKey
 * @param {string} pageTitle
 * @param {string} storageBody                      - from buildPageStorageBody()
 * @param {string|null} parentId
 * @param {boolean} parentIsFolder
 * @returns {{ page, pageUrl: string, wasUpdated: boolean, wasMoved: boolean }}
 */
export async function upsertPage(space, env, spaceKey, pageTitle, storageBody, parentId, parentIsFolder) {
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
    return { page, pageUrl, wasUpdated, wasMoved };
}
