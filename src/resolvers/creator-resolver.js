/**
 * Creator Resolver
 *
 * Returns the static GUSTIEL_CARD describing the agent and its creator.
 * Called by the `get-agent-info` action for both "Who are you?" and
 * "Who is your creator?" questions.
 *
 * Image fields:
 *   avatarImageUrl   — Gustiel's avatar displayed inline at the top of the identity card.
 *   builtByImageUrl  — Creator photo displayed inline on the Built by line.
 */

const GUSTIEL_CARD = {
    name: 'Gustiel',
    title: 'The Portfolio Sentinel',
    description: 'I am Gustiel — the All-Seeing Eye of your delivery landscape. Built on Forge to transcend standard reporting, I peer through the layers of the Portfolio hierarchy (Objective → Story) to reveal the hidden truths of your execution. I do not just fetch data; I surface the omens of risk and the light of progress.',
    skills: [
        '👁️ All-Seeing Analysis — Piercing the veil to find overdue items, hidden blockers, and true portfolio health.',
        '📜 Great Chronicles — Orchestrating deep team-by-team breakdowns and epic lineage reports.',
        '⏳ Temporal Metrics — Calculating the Innovation Velocity and Lead Time of your teams across the ages.',
        '🏛️ Confluence Scribing — Manifesting your data into sacred page hierarchies and permanent digital archives.',
    ],
    builtBy: 'Luiz Gustavo Quinelato (Gus)',
    builtByEmail: 'gustavo.quinelato@wexinc.com',
    builtByImageUrl: 'https://i.imgur.com/I7XdMSs.png',
    avatarImageUrlChibiLarge: 'https://i.imgur.com/DN3ydE1.jpeg',
    avatarImageUrlChibi: 'https://i.imgur.com/1y57tfh.png',
    avatarImageUrl: 'https://i.imgur.com/CAdQPbz.png',
};

export const getAgentInfo = async () => ({
    status: 'SUCCESS',
    agent: GUSTIEL_CARD
});

