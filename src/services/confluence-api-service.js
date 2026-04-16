/**
 * Confluence API Service
 *
 * Handles all Confluence API interactions.
 * Returns raw API responses — no business logic, no formatting.
 * This is the ONLY layer allowed to call the Confluence REST API.
 *
 * Public API:
 *   getSpaceByKey(spaceKey)                               → { id, key, name }
 *   findPageByTitle(spaceId, title, parentId?, isFolder?) → page object | null
 *   createConfluencePage(spaceId, title, body, parentId?) → page object
 *   updateConfluencePage(pageId, version, title, body, newParentId?) → page object
 *   createFolder(spaceId, title, parentId?)               → { id, type, ... }
 *   findFolderByTitle(spaceKey, title)                    → { id, title } | null
 *   findOrCreatePageByPath(spaceId, pathString)           → parentId string | null
 *
 * NOTE on folder support:
 *   The Confluence v2 API does NOT provide a way to search/list folders by title.
 *   Folders can only be created, deleted, or fetched by their known numeric ID.
 *   Use createFolder() to create new folders; use findFolderByTitle() to locate
 *   an existing folder by its title (best-effort via v1 content API + CQL).
 *   Pass known folder IDs directly as parentId to createConfluencePage().
 */

import { asApp, route } from '@forge/api';

/**
 * Look up a Confluence space by its key.
 * @param {string} spaceKey - e.g. "PROJ"
 * @returns {Promise<{ id: string, key: string, name: string }>}
 * @throws {Error} if the space is not found or the request fails
 */
export async function getSpaceByKey(spaceKey) {
    const response = await asApp().requestConfluence(
        route`/wiki/api/v2/spaces?keys=${spaceKey}&limit=1`,
        { headers: { 'Accept': 'application/json' } }
    );

    if (!response.ok) {
        throw new Error(`Confluence space lookup failed: HTTP ${response.status}`);
    }

    const data = await response.json();
    const space = data.results?.[0];

    if (!space) {
        throw new Error(`Space "${spaceKey}" not found. Check the space key and try again.`);
    }

    return space;
}

/**
 * Find a Confluence page by title, scoped to a specific parent when provided.
 *
 * When parentId is given the search is limited to that parent's direct children,
 * so a page with the same title in a *different* location is NOT matched. This
 * makes the upsert location-aware: re-exporting to Folder A never overwrites a
 * page that lives in Folder B or at the space root.
 *
 * Children endpoints return minimal objects without version info, so when a
 * match is found via parent search we fetch the full page to get version.number.
 *
 * @param {string}  spaceId    - Numeric space ID
 * @param {string}  title      - Exact page title
 * @param {string}  [parentId] - Optional parent page/folder ID to scope the search
 * @param {boolean} [parentIsFolder] - true when parentId is a native Confluence folder
 * @returns {Promise<{ id: string, title: string, version: { number: number }, _links: { webui: string } } | null>}
 */
export async function findPageByTitle(spaceId, title, parentId = null, parentIsFolder = false) {
    const titleLower = title.toLowerCase();

    if (parentId) {
        // Search only within the target parent's direct children.
        // Folder parents use /folders/{id}/children (returns pages + sub-folders).
        // Page parents use /pages/{id}/children (returns pages only).
        const endpoint = parentIsFolder
            ? route`/wiki/api/v2/folders/${parentId}/children?limit=250`
            : route`/wiki/api/v2/pages/${parentId}/children?limit=250`;

        const res = await asApp().requestConfluence(endpoint, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) return null;

        const data  = await res.json();
        const match = data.results?.find(p => p.title?.toLowerCase() === titleLower && p.type !== 'folder');
        if (!match) return null;

        // Children endpoints return minimal objects — fetch full page for version.number.
        const pageRes = await asApp().requestConfluence(
            route`/wiki/api/v2/pages/${match.id}`,
            { headers: { 'Accept': 'application/json' } }
        );
        return pageRes.ok ? await pageRes.json() : null;
    }

    // No parent specified — space-wide search (used for space-root exports).
    const response = await asApp().requestConfluence(
        route`/wiki/api/v2/pages?spaceId=${spaceId}&title=${title}&status=current&limit=1`,
        { headers: { 'Accept': 'application/json' } }
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data.results?.[0] || null;
}

/**
 * Create a new Confluence page in the specified space.
 * @param {string}      spaceId     - Numeric space ID (from getSpaceByKey)
 * @param {string}      title       - Page title
 * @param {string}      storageBody - Confluence storage format (XHTML)
 * @param {string|null} parentId    - Optional parent page ID
 * @returns {Promise<{ id: string, title: string, _links: { webui: string } }>}
 * @throws {Error} if the page creation fails
 */
export async function createConfluencePage(spaceId, title, storageBody, parentId = null) {
    const payload = { spaceId, status: 'current', title, body: { representation: 'storage', value: storageBody } };
    if (parentId) payload.parentId = parentId;

    const response = await asApp().requestConfluence(route`/wiki/api/v2/pages`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown error');
        throw new Error(`Failed to create Confluence page: HTTP ${response.status} — ${errText}`);
    }

    return await response.json();
}

/**
 * Update an existing Confluence page's content and optionally move it to a new parent.
 *
 * Passing newParentId causes the page to be relocated in the page/folder tree in the
 * same PUT call — the Confluence v2 API moves AND updates content atomically.
 *
 * @param {string}      pageId        - ID of the page to update
 * @param {number}      versionNumber - Current version number (new = versionNumber + 1)
 * @param {string}      spaceId       - Numeric space ID
 * @param {string}      title         - Page title (can be same as existing)
 * @param {string}      storageBody   - Confluence storage format (XHTML)
 * @param {string|null} [newParentId] - Optional new parent page/folder ID (moves the page when provided)
 * @returns {Promise<{ id: string, title: string, _links: { webui: string } }>}
 * @throws {Error} if the update fails
 */
export async function updateConfluencePage(pageId, versionNumber, spaceId, title, storageBody, newParentId = null) {
    const payload = {
        id: pageId,
        spaceId,
        status: 'current',
        title,
        version: { number: versionNumber + 1 },
        body: { representation: 'storage', value: storageBody }
    };
    if (newParentId) payload.parentId = newParentId;

    const response = await asApp().requestConfluence(route`/wiki/api/v2/pages/${pageId}`, {
        method: 'PUT',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown error');
        throw new Error(`Failed to update Confluence page: HTTP ${response.status} — ${errText}`);
    }

    return await response.json();
}

/**
 * Create a new Confluence folder in the specified space.
 *
 * NOTE: The v2 API does NOT support searching/listing folders by title.
 * Folders can only be created, deleted, or fetched by their known numeric ID.
 * Folder IDs ARE accepted as parentId in POST /pages (v2).
 *
 * @param {string}      spaceId  - Numeric space ID
 * @param {string}      title    - Folder title
 * @param {string|null} parentId - Optional parent page/folder ID (null = space root)
 * @returns {Promise<{ id: string, type: string, _links: { webui: string }, ... }>}
 * @throws {Error} if folder creation fails
 */
export async function createFolder(spaceId, title, parentId = null) {
    const payload = { spaceId, title };
    if (parentId) payload.parentId = parentId;

    const response = await asApp().requestConfluence(route`/wiki/api/v2/folders`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown error');
        throw new Error(`Failed to create Confluence folder: HTTP ${response.status} — ${errText}`);
    }

    return await response.json();
}

/**
 * Find an existing Confluence (native) folder by title within a space.
 *
 * Tries three approaches in order, stopping at the first match:
 *   0. v2 folders API — GET /wiki/api/v2/folders?spaceId=…&limit=250
 *      Finds folders created in the same session (no indexing delay).
 *   1. v1 content API — GET /wiki/rest/api/content?type=folder&spaceKey=…&title=…
 *   2. v1 CQL search  — type=folder AND space.key="…" AND title="…"
 *
 * Returns null (never throws) so callers can decide what to do when not found.
 *
 * @param {string} spaceId  - Numeric space ID (e.g. "98308")
 * @param {string} spaceKey - Space key (e.g. "GUSTIEL")
 * @param {string} title    - Folder title to find
 * @returns {Promise<{ id: string, title: string } | null>}
 */
export async function findFolderByTitle(spaceId, spaceKey, title) {
    const titleLower = title.toLowerCase();

    // ── Attempt 0: v2 folders listing (no search index needed) ───────────
    // Folders created by the v2 API appear here immediately, before CQL/v1
    // content-search indexes them. Paginate with limit=250 until found or exhausted.
    try {
        let cursor = null;
        let keepGoing = true;
        while (keepGoing) {
            const url = cursor
                ? route`/wiki/api/v2/folders?spaceId=${spaceId}&limit=250&cursor=${cursor}`
                : route`/wiki/api/v2/folders?spaceId=${spaceId}&limit=250`;
            const res = await asApp().requestConfluence(url, { headers: { 'Accept': 'application/json' } });
            if (!res.ok) break;
            const data  = await res.json();
            const match = data.results?.find(f => f.title?.toLowerCase() === titleLower);
            if (match) return { id: String(match.id), title: match.title };
            cursor    = data._links?.next ? new URL(data._links.next, 'https://x').searchParams.get('cursor') : null;
            keepGoing = !!cursor;
        }
    } catch { /* swallow — try next approach */ }

    // ── Attempt 1: v1 content endpoint with type=folder ──────────────────
    try {
        const res = await asApp().requestConfluence(
            route`/wiki/rest/api/content?type=folder&spaceKey=${spaceKey}&title=${title}&status=current&limit=10`,
            { headers: { 'Accept': 'application/json' } }
        );
        if (res.ok) {
            const data  = await res.json();
            const match = data.results?.find(f => f.title?.toLowerCase() === titleLower);
            if (match) return { id: String(match.id), title: match.title };
        }
    } catch { /* swallow — try next approach */ }

    // ── Attempt 2: v1 CQL search ─────────────────────────────────────────
    try {
        const cql = `type=folder AND space.key="${spaceKey}" AND title="${title}"`;
        const res = await asApp().requestConfluence(
            route`/wiki/rest/api/search?cql=${cql}&limit=5`,
            { headers: { 'Accept': 'application/json' } }
        );
        if (res.ok) {
            const data  = await res.json();
            const match = data.results?.find(f => f.title?.toLowerCase() === titleLower);
            if (match) return { id: String(match.content?.id || match.id), title: match.title };
        }
    } catch { /* swallow */ }

    return null;
}

/**
 * Walk a slash-separated path of PAGE segments, finding or creating each one.
 * Returns the ID of the deepest page (to be used as parentId for the report).
 *
 * This function handles PAGE hierarchy only. For folder parents, pass the
 * folder ID directly to createConfluencePage() — do not use this function.
 *
 * @param {string} spaceId    - Numeric space ID
 * @param {string} pathString - e.g. "Reports/2026" (relative to space root)
 * @returns {Promise<string | null>} parentId of the last segment, or null
 */
export async function findOrCreatePageByPath(spaceId, pathString) {
    const parts = pathString.split('/').map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) return null;

    let parentId = null;

    for (const part of parts) {
        // Search for an existing page with this title in the space.
        const searchRes = await asApp().requestConfluence(
            route`/wiki/api/v2/pages?spaceId=${spaceId}&title=${part}&status=current&limit=10`,
            { headers: { 'Accept': 'application/json' } }
        );
        let existing = null;
        if (searchRes.ok) {
            const data = await searchRes.json();
            existing = data.results?.find(p => p.title.toLowerCase() === part.toLowerCase()) || null;
        }

        if (existing) {
            parentId = existing.id;
        } else {
            const created = await createConfluencePage(spaceId, part, '<p></p>', parentId);
            parentId = created.id;
        }
    }

    return parentId;
}

