/**
 * bundle-docs.mjs — Documentation bundler (prebuild step)
 *
 * Reads all skill markdown files from docs/skills/ and generates src/docs/index.js.
 * Each skill file must have two sections separated by these exact headings:
 *   ## 📋 User Guide
 *   ## 🔧 Technical Reference
 *
 * Exports:
 *   USER_GUIDE_MD  — all skill User Guide sections combined (for Confluence User Guide page)
 *   TECH_REF_MD    — all skill Tech Reference sections + architecture doc (for Tech Reference page)
 *   ARCHITECTURE_MD — the raw architecture doc (for backward compat / standalone use)
 *   SCREENSHOTS    — JSON object { 'filename.png': 'base64...' } from assets/screenshots/
 *
 * Usage:
 *   node scripts/bundle-docs.mjs        (direct)
 *   .\deploy.ps1 --docs                 (via deploy script)
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, extname }                               from 'path';
import { fileURLToPath }                                        from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = join(__dirname, '..');

function read(relPath) {
    try {
        // Normalize CRLF → LF so section extraction (which looks for '\n## …\n')
        // works regardless of how the source file is saved on disk.
        return readFileSync(join(root, relPath), 'utf8').replace(/\r\n/g, '\n');
    } catch (e) {
        console.error(`ERROR: could not read ${relPath}: ${e.message}`);
        process.exit(1);
    }
}

function readBinary(relPath) {
    try {
        return readFileSync(join(root, relPath));
    } catch (e) {
        console.error(`ERROR: could not read binary ${relPath}: ${e.message}`);
        process.exit(1);
    }
}

/**
 * Extract the H1 title from a skill doc (strips "Skill XX — " prefix).
 * e.g. "# Skill 04 — Portfolio Report" → "Portfolio Report"
 * e.g. "# Admin Skills"               → "Admin Skills"
 */
function getSkillTitle(md) {
    const m = md.match(/^# (?:Skills? \S[\S]* — )?(.+)/m);
    return m ? m[1].trim() : '';
}

/**
 * Extract content between two H2 section headings.
 * Returns the body text after the start heading, up to (but not including) the end heading.
 */
function extractSection(md, startHeading, endHeading) {
    const startMarker = `\n## ${startHeading}\n`;
    const startIdx    = md.indexOf(startMarker);
    if (startIdx === -1) return null;

    const bodyStart = startIdx + startMarker.length;
    const endMarker = endHeading ? `\n## ${endHeading}\n` : null;
    const endIdx    = endMarker ? md.indexOf(endMarker, bodyStart) : -1;

    return endIdx !== -1
        ? md.slice(bodyStart, endIdx).trim()
        : md.slice(bodyStart).trim();
}

// ── Skill source files (display order) ───────────────────────────────────────
const SKILL_FILES = [
    'docs/skills/01-identity.md',
    'docs/skills/02-version.md',
    'docs/skills/03-system-info.md',
    'docs/skills/04-portfolio.md',
    'docs/skills/05-lct.md',
    'docs/skills/06-team-sprint.md',
    'docs/skills/07-export-skill-docs.md',
    'docs/skills/08-session-cache.md',
    'docs/skills/09-storage.md',
    'docs/skills/10-account-id.md',
    'docs/skills/admin.md',
];

const USER_GUIDE_HEADING = '📋 User Guide';
const TECH_REF_HEADING   = '🔧 Technical Reference';

// ── Parse each skill file into { title, userGuide, techRef } ─────────────────
const skills = SKILL_FILES.map(filePath => {
    const md       = read(filePath);
    const title    = getSkillTitle(md);
    const userGuide = extractSection(md, USER_GUIDE_HEADING, TECH_REF_HEADING);
    const techRef   = extractSection(md, TECH_REF_HEADING, null);
    if (!userGuide) console.warn(`⚠️  No User Guide section found in ${filePath}`);
    if (!techRef)   console.warn(`⚠️  No Tech Reference section found in ${filePath}`);
    return { title, userGuide: userGuide || '', techRef: techRef || '' };
});

// ── Assemble combined markdown for each export ────────────────────────────────

/** User Guide page: one H2 per skill, skill User Guide content below */
const USER_GUIDE_MD = skills
    .map(s => `## ${s.title}\n\n${s.userGuide}`)
    .join('\n\n---\n\n');

/** Technical Reference page: one H2 per skill, tech ref content below, then architecture */
const archBody = read('docs/architecture.md')
    .replace(/^# .+(\r?\n|$)/m, '')   // strip H1 title line
    .trimStart();

const TECH_REF_MD = [
    ...skills.map(s => `## ${s.title}\n\n${s.techRef}`),
    '',
    '---',
    '',
    archBody,
].join('\n\n---\n\n').replace(/\n\n---\n\n\n\n---\n\n/g, '\n\n---\n\n'); // collapse double-dividers

/** Raw architecture doc — kept for standalone use in skill-docs-resolver if needed */
const ARCHITECTURE_MD = read('docs/architecture.md');

// ── Screenshots — base64-encode all files in assets/screenshots/ ──────────────
const screenshotsDir  = join(root, 'assets', 'screenshots');
const screenshotsObj  = {};
try {
    const files = readdirSync(screenshotsDir).filter(f => ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extname(f).toLowerCase()));
    for (const file of files) {
        const buf = readBinary(`assets/screenshots/${file}`);
        screenshotsObj[file] = buf.toString('base64');
        console.log(`  📸 ${file} (${Math.round(buf.length / 1024)} KB)`);
    }
} catch (e) {
    console.warn(`⚠️  Could not read screenshots directory: ${e.message}`);
}

// ── Generate src/docs/index.js ────────────────────────────────────────────────
const timestamp = new Date().toISOString();

const lines = [
    '// AUTO-GENERATED — do not edit manually.',
    `// Generated: ${timestamp}`,
    '// Source:    docs/  —  run ".\\deploy.ps1 --docs" to regenerate.',
    '// Imported by skill-docs-resolver.js and architecture-guide-resolver.js.',
    '',
    `export const USER_GUIDE_MD   = ${JSON.stringify(USER_GUIDE_MD)};`,
    `export const TECH_REF_MD     = ${JSON.stringify(TECH_REF_MD)};`,
    `export const ARCHITECTURE_MD = ${JSON.stringify(ARCHITECTURE_MD)};`,
    `export const SCREENSHOTS     = ${JSON.stringify(screenshotsObj)};`,
    '',
];

const outDir = join(root, 'src', 'docs');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.js'), lines.join('\n'));

const screenshotCount = Object.keys(screenshotsObj).length;
console.log(`✅ docs bundled → src/docs/index.js  (${SKILL_FILES.length} skills, ${screenshotCount} screenshots, ${timestamp})`);
