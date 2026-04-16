/**
 * System Resolver
 *
 * Handles version and system info queries.
 */

import { VERSION } from '../config/constants.js';
import { getEnvFromJira } from '../services/jira-api-service.js';

/**
 * Returns the current agent version.
 */
export const getAgentVersion = async () => {
    return {
        status: 'SUCCESS',
        version: VERSION,
        message: `Gustiel (The Portfolio Sentinel) — version ${VERSION}`
    };
};

/**
 * Returns the connected Jira environment and agent version.
 */
export const getSystemInfo = async () => {
    const env = await getEnvFromJira();
    return {
        status: 'SUCCESS',
        message: `Connected to: ${env.baseUrl} (${env.name}) — Agent version: ${VERSION}`,
        data: {
            instanceUrl: env.baseUrl,
            environmentType: env.name,
            agentVersion: VERSION
        }
    };
};

