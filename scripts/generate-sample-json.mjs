/**
 * Generates user_guide_page_sample.json at the workspace root.
 * Run: node scripts/generate-sample-json.mjs
 */
import { markdownToStorage, buildTocMacro, buildAnchorMacro } from '../src/formatters/confluence-formatter.js';
import { USER_GUIDE_MD } from '../src/docs/index.js';
import { VERSION } from '../src/config/constants.js';
import fs from 'fs';

const envName = 'Wex Inc Sandbox';
const isDev   = true;

const envBadge  = isDev
  ? '⚠️ **This page was exported from the DEV (Sandbox) instance.**'
  : '✅ **This page was exported from the PRODUCTION instance.**';
const agentNote = isDev
  ? 'When using Rovo Chat, make sure you are talking to **[DEV] Gustiel** for test features, or **Gustiel (Portfolio Sentinel)** for stable production features.'
  : 'When using Rovo Chat, use **Gustiel (Portfolio Sentinel)** for daily work. The **[DEV] Gustiel** agent runs experimental features on the Sandbox instance.';

const preamble = [
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

const rawMarkdown = [
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

const anchor      = buildAnchorMacro('top');
const toc         = buildTocMacro();
const storageBody = anchor + toc + markdownToStorage(rawMarkdown, { uniformColumns: true });

const today     = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const pageTitle = `📖 [${today}] Gustiel User Guide by [gustavo.quinelato@wexinc.com]`;

const output = {
  _comment: [
    'Full PUT body for PUT /wiki/api/v2/pages/{page_id}',
    'Step 1: POST /wiki/rest/api/content/{page_id}/child/attachment  (multipart, X-Atlassian-Token: nocheck)',
    'Step 2: PUT  /wiki/api/v2/pages/{page_id}  with this body (Content-Type: application/json)',
    'Replace PAGE_ID, SPACE_ID, VERSION_NUMBER with real values before sending.',
  ],
  id:      'PAGE_ID',
  spaceId: 'SPACE_ID',
  status:  'current',
  title:   pageTitle,
  version: { number: 'VERSION_NUMBER', message: 'Re-render with attachments resolved' },
  body:    { representation: 'storage', value: storageBody },
};

const outPath = new URL('../user_guide_page_sample.json', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
console.log(`Written to ${outPath}`);
console.log(`storageBody length: ${storageBody.length} chars`);
