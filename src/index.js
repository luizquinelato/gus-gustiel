/**
 * Gustiel (The Portfolio Sentinel) - Entry Point
 *
 * Exports all Forge action handler functions referenced in manifest.yml.
 * Add exports here as new actions are implemented.
 */

export { getAgentVersion, getSystemInfo } from './resolvers/system-resolver.js';
export { getAgentInfo } from './resolvers/creator-resolver.js';
export { exportToConfluence, createConfluenceFolder } from './resolvers/confluence-export-resolver.js';
export { checkReportCache }       from './resolvers/check-cache-resolver.js';
export { preparePortfolioExport } from './resolvers/prepare-export-resolver.js';
export { calculateLeadTimeData }  from './resolvers/lead-time-resolver.js';
export { calculateSprintData }    from './resolvers/sprint-data-resolver.js';
export { inspectStorage, wipeGlobalStorage, wipeUserStorage, addAdmin, removeAdmin, deleteAllAdmins as clearAdminRegistry, listAdmins, getMyAccountId } from './resolvers/storage-admin-resolver.js';
export { chatAnalysisSection }                from './resolvers/chat-analysis-resolver.js';
export { getTeamSprintAnalysis }              from './resolvers/team-sprint-resolver.js';
export { exportSkillDocs }                    from './resolvers/skill-docs-resolver.js';

