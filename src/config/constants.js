/**
 * Configuration Constants
 *
 * Contains all configuration constants used throughout the application,
 * including environment-specific Jira custom field IDs for Sandbox and Production.
 */

// --- VERSION TRACKING ---
export const VERSION = "4.53.0";

// --- ANALYSIS PAGINATION ---
// Teams per NEXT page for the Epics-by-Team section (more data per team → smaller batches).
export const ANALYSIS_TEAMS_PER_PAGE = 7;
// Teams per NEXT page for the LCT/Velocity section (less data per team → larger batches).
export const ANALYSIS_LCT_TEAMS_PER_PAGE = 10;
// Teams processed per Forge invocation for sprint analysis.
// Each team: 1 board lookup + up to 6 GreenHopper calls ≈ 7 calls total.
// 6 teams × 7 calls = 42 calls at concurrency 3 → ~10–14 s, well within the 25 s limit.
export const ANALYSIS_SPRINT_TEAMS_PER_BATCH = 6;
// --- ADMIN ---
// Immutable root of trust — never changes, never stored in dynamic registry.
export const SUPER_ADMIN_ACCOUNT_ID = '641b50110e6828ab202643c3';
// Storage key for the dynamic admin registry (array of additional accountIds).
export const ADMIN_REGISTRY_KEY     = 'admin:registry';

// --- SESSION STORAGE ---
// Forge Storage key format for per-user portfolio sessions.
// All resolvers MUST use makeSessionKey — never define the format locally.
export const SESSION_KEY_PREFIX = 'export_session';
export const makeSessionKey = (accountId, portfolioKey) =>
    `${SESSION_KEY_PREFIX}:${accountId}:${portfolioKey}`;

// --- GREENHOPPER RATE LIMITING ---
// Maximum number of concurrent GreenHopper (Agile sprint report) API calls
// across the entire Forge invocation.  GreenHopper is rate-limited per Jira
// instance (not per board), so even calls to different boards count against
// the same quota.  Limit of 3 keeps us safely under the burst threshold while
// finishing within Forge's 25-second function timeout for large portfolios.
// Used by sprint-extractor.js → fetchSprintReportsForTeams via makeSemaphore.
export const GREENHOPPER_CONCURRENCY_LIMIT = 3;

// --- REPORT TIMEZONE ---
// IANA timezone string used to stamp "Created at" on Confluence reports.
// Examples: 'UTC', 'America/New_York', 'America/Chicago', 'Europe/London', 'Asia/Tokyo'
// Full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
export const REPORT_TIMEZONE = 'America/New_York';

// --- TOKEN BUDGET (LLM output truncation prevention) ---
// Server returns exactly 1 team per call. TEAMS_PER_BATCH controls how many
// teams are auto-chained per user "next" before Gustiel pauses. This caps the
// cumulative LLM output per turn to ≈ TEAMS_PER_BATCH × 500 tokens, well
// below Rovo's ~4K ceiling. Remaining teams require another "next".
// v3.5.x root cause: chars-to-token ratio of 3.5 was 2× too optimistic for
// URL-heavy pipe-table markdown, causing cumulative overflow at team 8.
export const TEAMS_PER_BATCH      = 4;
export const LCT_PAGES_PER_BATCH  = 5;  // pages fetched per Forge invocation during LCT batching; Rovo auto-calls until PARTIAL resolves to SUCCESS
export const CHARS_PER_TOKEN   = 3.5;   // retained for summary-phase estimation
export const SAFE_TOKEN_BUDGET = 2000;  // retained for reference

// ============================================================================
// ENVIRONMENT & FIELD CONFIGURATION
// ============================================================================
// IMPORTANT: Custom field IDs differ between Sandbox and Production.
// Always use getEnvFromJira() from jira-api-service.js to get the correct
// set of field IDs at runtime — never hardcode them directly.

// ============================================================================
// PORTFOLIO LAYER WORKFLOWS
// ============================================================================
// Each layer is a keyed dictionary: statusName → { order, category, specialCategory }
//   order           — integer that controls display sequence (lower = earlier)
//   category        — human-readable Jira status category label
//   specialCategory — story-level rollup label (null for Initiative / Epic layers):
//                       'To Do'   — initial / backlog statuses (not yet started)
//                       'Waiting' — gating statuses ("Ready for …")
//                       'Working' — active in-progress statuses
//                       'Done'    — completed, released, or removed statuses

export const PORTFOLIO_WORKFLOWS = {
    INITIATIVE: {
        'Backlog': { order: 1, category: 'To Do',       specialCategory: null },
        'Now':     { order: 2, category: 'In Progress', specialCategory: null },
        'Next':    { order: 3, category: 'To Do',       specialCategory: null },
        'Later':   { order: 4, category: 'To Do',       specialCategory: null },
        'Done':    { order: 5, category: 'Done',        specialCategory: null }
    },
    EPIC: {
        'Backlog':                { order: 1, category: 'To Do',       specialCategory: null },
        'Development':            { order: 2, category: 'In Progress', specialCategory: null },
        'Deployed to Production': { order: 3, category: 'Done',        specialCategory: null },
        'Released':               { order: 4, category: 'Done',        specialCategory: null }
    },
    STORY: {
        'Backlog':              { order: 1,  category: 'To Do',       specialCategory: 'To Do' },
        'To Do':                { order: 2,  category: 'To Do',       specialCategory: 'To Do' },
        'In Progress':          { order: 3,  category: 'In Progress', specialCategory: 'Working' },
        'In Review':            { order: 4,  category: 'In Progress', specialCategory: 'Working' },
        'Ready for Test':       { order: 5,  category: 'In Progress', specialCategory: 'Waiting' },
        'In Test':              { order: 6,  category: 'In Progress', specialCategory: 'Working' },
        'Ready for UAT':        { order: 7,  category: 'In Progress', specialCategory: 'Waiting' },
        'UAT':                  { order: 8,  category: 'In Progress', specialCategory: 'Working' },
        'Ready for Production': { order: 9,  category: 'In Progress', specialCategory: 'Waiting' },
        'Done':                 { order: 10, category: 'Done',        specialCategory: 'Done' },
        'Released':             { order: 11, category: 'Done',        specialCategory: 'Done' },
        'Removed':              { order: 12, category: 'Done',        specialCategory: 'Done' }
    }
};

export const ENV_CONFIG = {
    SANDBOX: {
        name: 'Sandbox',
        urlPart: 'wexinc-sandbox-new',
        fields: {
            // Standard System Fields
            assignee:           'assignee',
            status:             'status',
            summary:            'summary',
            priority:           'priority',
            labels:             'labels',
            parent:             'parent',
            dueDate:            'duedate',
            issueType:          'issuetype',
            project:            'project',

            // Custom Fields (Sandbox IDs)
            development:        'customfield_10000',
            storyPoints:        'customfield_10038',
            agileTeam:          'customfield_10700',
            team:               'customfield_10001',
            qpPlanningSessions: 'customfield_10613',
            plannedStartDate:   'customfield_11321',
            endDate:            'customfield_11010',
            startDate:          'customfield_10015',
            wexTShirtSize:      'customfield_10981',
            sprint:             'customfield_10020',
            projectCode:        'customfield_10284',
            investCategory:     'customfield_10989',
            businessArea:       'customfield_10963',
            qpCommitmentType:   'customfield_10669',
            gaLaunchDate:       'customfield_10567',
            expenseType:        'customfield_11110',
            cppId:              'customfield_10173',
            funding:            'customfield_10169',
            epicLink:           'customfield_10014',
            parentLink:         'customfield_10018'
        }
    },
    PRODUCTION: {
        name: 'Production',
        urlPart: 'wexinc.atlassian.net',
        fields: {
            // Standard System Fields
            assignee:           'assignee',
            status:             'status',
            summary:            'summary',
            priority:           'priority',
            labels:             'labels',
            parent:             'parent',
            dueDate:            'duedate',
            issueType:          'issuetype',
            project:            'project',

            // Custom Fields (Production IDs)
            development:        'customfield_10000',
            storyPoints:        'customfield_10024',
            agileTeam:          'customfield_10128',
            team:               'customfield_10001',
            qpPlanningSessions: 'customfield_10501',
            plannedStartDate:   'customfield_12525',
            endDate:            'customfield_10229',
            startDate:          'customfield_10015',
            wexTShirtSize:      'customfield_10412',
            sprint:             'customfield_10021',
            projectCode:        'customfield_10414',
            investCategory:     'customfield_10413',
            businessArea:       'customfield_12007',
            qpCommitmentType:   'customfield_10318',
            gaLaunchDate:       'customfield_13687',
            expenseType:        'customfield_10251',
            cppId:              'customfield_13780',
            funding:            'customfield_13779',
            epicLink:           'customfield_10014',
            parentLink:         'customfield_10018'
        }
    }
};

