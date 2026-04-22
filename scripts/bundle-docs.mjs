/**
 * bundle-docs.mjs — Documentation bundler (prebuild step)
 *
 * Reads all markdown files from docs/ and generates src/docs/index.js
 * as an ES module with one exported string constant per file.
 *
 * skill-docs-resolver.js imports from src/docs/index.js so the Confluence
 * skill docs page is always in sync with the local docs/ source files.
 *
 * Usage:
 *   node scripts/bundle-docs.mjs        (direct)
 *   .\deploy.ps1 --docs                 (via deploy script)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname }                           from 'path';
import { fileURLToPath }                           from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = join(__dirname, '..');

function read(relPath) {
    try {
        return readFileSync(join(root, relPath), 'utf8');
    } catch (e) {
        console.error(`ERROR: could not read ${relPath}: ${e.message}`);
        process.exit(1);
    }
}

// ── Source files ──────────────────────────────────────────────────────────────
// Skills are listed in display order (matches the Confluence page section order).
const docs = {
    SKILL_01_MD:    read('docs/skills/01-identity.md'),
    SKILL_02_MD:    read('docs/skills/02-version.md'),
    SKILL_03_MD:    read('docs/skills/03-system-info.md'),
    SKILL_04_05_MD: read('docs/skills/04-05-portfolio.md'),
    SKILL_06_MD:    read('docs/skills/06-team-sprint.md'),
    SKILL_07_MD:    read('docs/skills/07-export-skill-docs.md'),
    SKILL_08_MD:    read('docs/skills/08-session-cache.md'),
    SKILL_09_MD:    read('docs/skills/09-storage.md'),
    SKILL_10_MD:    read('docs/skills/10-account-id.md'),
    SKILL_ADMIN_MD: read('docs/skills/admin.md'),
    ARCHITECTURE_MD: read('docs/architecture.md'),
};

// ── Generate src/docs/index.js ────────────────────────────────────────────────
const timestamp = new Date().toISOString();

const lines = [
    '// AUTO-GENERATED — do not edit manually.',
    `// Generated: ${timestamp}`,
    '// Source:    docs/  —  run ".\\deploy.ps1 --docs" to regenerate.',
    '// Imported by skill-docs-resolver.js to build the Confluence skill docs page.',
    '',
    ...Object.entries(docs).map(([name, content]) =>
        `export const ${name} = ${JSON.stringify(content)};`
    ),
    '',
];

const outDir = join(root, 'src', 'docs');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.js'), lines.join('\n'));

console.log(`✅ docs bundled → src/docs/index.js  (${Object.keys(docs).length} files, ${timestamp})`);
