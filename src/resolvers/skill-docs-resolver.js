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
import { markdownToStorage, buildTocMacro, buildAnchorMacro,
         buildCustomTable }                                    from '../formatters/confluence-formatter.js';

// ── Documentation markdown ────────────────────────────────────────────────────

function buildSkillDocsMarkdown(envName) {
    return [

`# 🤖 Gustiel — The Portfolio Sentinel`,
``,
`> **Gustiel** is an AI-powered Jira Portfolio Analyst running as a Rovo Agent on Atlassian Forge.`,
`> It delivers portfolio health reports, sprint velocity metrics, and lead/cycle time analytics`,
`> through natural language — no commands to memorize.`,
``,
`**Version:** ${VERSION} · **Environment:** ${envName} · **Built by:** Gustavo Quinelato`,
``,
`---`,
``,
`## 📌 What Can Gustiel Do?`,
``,
`Gustiel understands natural questions and routes them to the right skill automatically. You never need to type commands or remember syntax — just describe what you want.`,
``,
`| Capability | Access |`,
`|---|---|`,
`| Portfolio reports (Confluence + chat) | 🔓 Everyone |`,
`| Team sprint velocity & say/do analysis | 🔓 Everyone |`,
`| Lead/Cycle Time per team (ETL pipeline) | 🔓 Everyone |`,
`| Clear your own session cache | 🔓 Everyone |`,
`| Export this skill guide to Confluence | 🔓 Everyone |`,
`| View your Forge account ID | 🔓 Everyone |`,
`| Inspect all storage / wipe all data | 🔐 Admin only |`,
`| Add / remove admins | 🔐 Super-admin |`,
``,
`---`,
``,
`## 🔓 Skills Available to Everyone`,
``,
`### 1. 🤖 Who Are You / Creator Info`,
``,
`Returns Gustiel's identity card — name, description, skills summary, creator info, and avatar.`,
``,
`**Trigger phrases:**`,
`- *"Who are you?"*, *"What are you?"*, *"Tell me about yourself"*`,
`- *"Who created you?"*, *"Who built you?"*, *"Show creator info"*`,
``,
`---`,
``,
`### 2. 🔍 Version`,
``,
`Returns the current deployed version of the app.`,
``,
`**Trigger phrases:**`,
`- *"What version are you?"*, *"What is your version?"*`,
``,
`---`,
``,
`### 3. 🌐 Environment Info`,
``,
`Shows which Jira environment is connected (Sandbox or Production).`,
``,
`**Trigger phrases:**`,
`- *"What environment is this?"*, *"Show system info"*, *"What instance am I on?"*`,
``,
`---`,
``,
`### 4. 📄 Portfolio Export → Confluence`,
``,
`Exports a full portfolio report (Objective → Initiative → Epic → Story) as a permanent, shareable Confluence page. Includes Innovation Velocity, Lead/Cycle Time, and Sprint Analysis sections per team.`,
``,
`**Trigger phrases:**`,
`- *"Export WX-1145 to Confluence"*`,
`- *"Create a portfolio report for WX-1145 and WX-1770"*`,
`- *"Give me a full report for WX-1145"*, *"Show me all epics for WX-1145"*`,
``,
`**Key options:**`,
`- Single key → one page. Multiple keys → combined page (merged or isolated).`,
`- Target by space name, page path, or folder ID.`,
`- Pages are upserted — never duplicated.`,
``,
`---`,
``,
`### 5. 💬 Portfolio Analysis in Chat`,
``,
`Same data as the Confluence export, delivered interactively in the Rovo chat window through a series of **NEXT** confirmations. Best for quick questions on a single key.`,
``,
`**Trigger phrases:**`,
`- *"Analyze WX-1145 in chat"*, *"Show me the portfolio analysis for WX-1145"*`,
`- *"Portfolio report in chat for WX-1145"*`,
``,
`**Sections:** Portfolio Summary → Epics by Team (paginated) → Innovation Velocity & LCT (paginated)`,
``,
`---`,
``,
`### 6. 🏃 Team Sprint Analysis`,
``,
`On-demand sprint velocity report for a single agile team. Shows the last 6 closed sprints with velocity (SP completed), say/do ratio, SP added, SP removed, and rolled-over stories. No portfolio key or prior setup needed.`,
``,
`**Also answers naturally (no extra skill required):**`,
`- *"List the past sprint names for Titan"* → reads sprint names directly from the analysis response`,
`- *"What board is the Titan team on?"* / *"What's the board ID for X?"* → the board name and ID are included in every response`,
``,
`**Trigger phrases:**`,
`- *"How is Bushido performing?"*, *"Sprint analysis for Titan"*`,
`- *"Velocity for Vanguard"*, *"How has Comet been doing lately?"*`,
`- *"Sprint say/do for team Warriors"*, *"What are the last sprints for B-Sharps?"*`,
`- *"List sprint names for Titan"*, *"What board is Warriors on?"*, *"Board ID for Comet?"*`,
``,
`---`,
``,
`### 7. 📚 Export Skill Documentation`,
``,
`Exports this guide — a complete Confluence page documenting all skills, usage examples, access levels, and the ETL pipeline. Use it to onboard teammates or create a formal reference page.`,
``,
`**Trigger phrases:**`,
`- *"Export skill documentation"*, *"Create a Gustiel user guide in Confluence"*`,
`- *"Document all Gustiel skills to Confluence"*, *"Export the help to Confluence"*`,
``,
`---`,
``,
`### 8. 🗑️ Clear My Session Cache`,
``,
`Deletes your own cached portfolio session data (all \`export_session\` entries stored under your account). Forces a fresh extraction on your next export or analysis run. Affects only **your** data — other users are unaffected.`,
``,
`**Trigger phrases:**`,
`- *"Clear my cache"*, *"Wipe my sessions"*, *"Reset my storage"*, *"Clear my data"*`,
``,
`---`,
``,
`### 9. 🪪 My Account ID`,
``,
`Returns the Atlassian \`accountId\` that the Forge runtime sees for the current user, along with whether you are a super-admin. Useful for debugging admin access issues or providing your ID for the admin registry.`,
``,
`**Trigger phrases:**`,
`- *"What is my account ID?"*, *"Show my account ID"*, *"What accountId does Forge see for me?"*`,
``,
`---`,
``,
`## 🔐 Admin-Only Skills`,
``,
`> ⚠️ These skills require admin access. Non-admins receive an access-denied error.`,
`> Admins are managed via the dynamic admin registry (see **Add Admin** below).`,
``,
`### 🔍 Inspect Storage *(Admin)*`,
``,
`Lists all Forge storage keys or reads and summarizes the contents of a specific key. Session keys show teams, sprint status, board index, and LCT phase. Never dumps raw JSON.`,
``,
`**Trigger phrases:**`,
`- *"Inspect storage"*, *"List storage keys"*, *"What's in storage?"*`,
`- *"Show storage key export_session:…"*, *"Inspect key admin:registry"*`,
``,
`---`,
``,
`### 🗑️ Wipe All Storage *(Admin)*`,
``,
`Permanently deletes **all** cached session data for **all users** across the entire app. Use with caution — every user will need to re-run extraction next time.`,
``,
`**Trigger phrases:**`,
`- *"Wipe all storage"*, *"Clear all sessions"*, *"Reset all user caches"*, *"Nuke storage"*`,
``,
`---`,
``,
`### 👥 List Admins *(Admin)*`,
``,
`Lists the super-admin and all dynamic admins with their display name and email address.`,
``,
`**Trigger phrases:**`,
`- *"List admins"*, *"Who are the admins?"*, *"Show admin registry"*`,
``,
`---`,
``,
`### 🗑️ Clear Admin Registry *(Admin)*`,
``,
`Resets the dynamic admin registry to empty. The hardcoded super-admin is never affected.`,
``,
`**Trigger phrases:**`,
`- *"Clear the admin registry"*, *"Reset the admin registry"*`,
``,
`---`,
``,
`### ➕ Add Admin *(Super-admin only)*`,
``,
`Grants admin access to a new Atlassian accountId. Only the super-admin can add admins. Provide the accountId (use **My Account ID** skill to find yours).`,
``,
`**Trigger phrases:**`,
`- *"Add admin"*, *"Grant admin access to [accountId]"*, *"Make [X] an admin"*`,
``,
`---`,
``,
`### ➖ Remove Admin *(Admin)*`,
``,
`Revokes admin access from an Atlassian accountId. Any admin (not just super-admin) can remove admins.`,
``,
`**Trigger phrases:**`,
`- *"Remove admin"*, *"Revoke admin access from [accountId]"*, *"Remove [X] as admin"*`,
``,
`---`,
``,
`## 💬 Example Conversations`,
``,
`### Sprint Analysis`,
``,
`\`\`\``,
`You:      How is Bushido performing?`,
`Gustiel:  🏃 Sprint Analysis — Bushido`,
`          | Sprint | Planned | Velocity | Say/Do |`,
`          | Bushido 2026.05 | 41 SP | 62 SP | 🟢 151% |`,
`          ...`,
`\`\`\``,
``,
`### Portfolio Export — Single Key`,
``,
`\`\`\``,
`You:      Export WX-1145 to Confluence`,
`Gustiel:  Which Confluence space should this report go to?`,
`You:      Gustiel`,
`Gustiel:  Where in GUSTIEL should the report be placed? (path, folder URL, or new folder name)`,
`You:      Reports/2026`,
`Gustiel:  ✅ WX-1145 exported to Confluence.`,
`          📄 [page title] → https://…`,
`\`\`\``,
``,
`### Portfolio Analysis in Chat`,
``,
`\`\`\``,
`You:      Analyze WX-1145 in chat`,
`Gustiel:  ⚠️ Heads up — this is a heavy analysis...`,
`          [Summary section]`,
`You:      NEXT`,
`Gustiel:  [Epics by Team — page 1]`,
`You:      NEXT`,
`Gustiel:  [Innovation Velocity & LCT]`,
`\`\`\``,
``,
`### Multi-Key Combined Export`,
``,
`\`\`\``,
`You:      Export WX-1145 and WX-1770 to Confluence in isolated mode`,
`Gustiel:  Which Confluence space?`,
`You:      Gustiel`,
`Gustiel:  Where should the report be placed?`,
`You:      folder ID 52592641`,
`Gustiel:  ✅ Before I start — 2 keys, isolated layout, folder 52592641. Type YES.`,
`You:      YES`,
`Gustiel:  ✅ WX-1145 · WX-1770 exported → https://…`,
`\`\`\``,
``,
`---`,
``,
`## 🔄 ETL Pipeline (Portfolio Reports)`,
``,
`Heavy portfolio reports run in three async steps to stay within Forge's 25-second function timeout:`,
``,
`__ETL_TABLE__`,
``,
`The results are cached in Forge Storage per user. On re-export, you can reuse the cached data (fast) or trigger a fresh extraction.`,
``,
`---`,
``,
`## 📐 Jira Hierarchy Support`,
``,
`Gustiel auto-detects the scope of the key you provide:`,
``,
`__HIERARCHY_TABLE__`,
``,
`---`,
``,
`## 🗂️ Session Cache`,
``,
`Gustiel saves extracted data to Forge Storage under \`export_session:<accountId>:<portfolioKey>\`. Each user has their own isolated cache — your cache never affects other users and vice versa.`,
``,
`Cached extraction results stay valid for **24 hours**. After that, your next export automatically reruns the lead and cycle time calculation using the latest issue data. Sprint history (velocity, say/do) is stored permanently — past sprint results never change.`,
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

    // ── Build custom-width tables and inject via placeholder replacement ──────
    // markdownToStorage's renderTable() gives equal width to all columns.
    // These tables need a narrow label column and a triple-wide description column.
    const etlTable = buildCustomTable(
        ['#', 'Action', 'What It Does'],
        [
            ['1', '`prepare-portfolio-export`', 'Extracts agile teams, epics, stories, and sprint board IDs from Jira'],
            ['2', '`calculate-lead-time-data`', 'Computes lead and cycle time per team by reading issue change history'],
            ['3', '`calculate-sprint-data`',    'Fetches the last 6 closed sprints per team from the sprint board API and pulls velocity metrics'],
            ['4', '`export-to-confluence`',     'Reads the saved session and renders the final formatted Confluence page'],
        ],
        [1, 1, 3]  // # narrow | Action normal | What It Does triple-wide
    );
    const hierarchyTable = buildCustomTable(
        ['Scope', 'What Gustiel Reports'],
        [
            ['**Objective**',  'Full report: Portfolio Summary → Initiatives → Epics by Team → Sprint Velocity → Lead & Cycle Time → Sprints'],
            ['**Initiative**', 'Summary → Epics by Team → Sprint Velocity → Lead & Cycle Time → Sprints'],
            ['**Epic**',       'Story status → Sprint Velocity → Lead & Cycle Time → Sprints'],
        ],
        [1, 3]  // Scope narrow | What Gustiel Reports triple-wide
    );

    const fullContent = markdownToStorage(rawMarkdown)
        .replace('<p>__ETL_TABLE__</p>',       etlTable)
        .replace('<p>__HIERARCHY_TABLE__</p>', hierarchyTable);

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
