/**
 * bundle-docs.mjs — Documentation bundler (prebuild step)
 *
 * Reads all skill markdown files from docs/skills/ and generates src/docs/index.js.
 * Each skill file must have two sections separated by these exact headings:
 *   ## 📋 User Guide
 *   ## 🔧 Technical Reference
 *
 * Also reads release notes from docs/releases/MAJOR.MINOR.md (front-matter +
 * "📣 What's New" + optional "🔧 Technical Changes" sections) and emits a
 * RELEASES array sorted newest-first. Also reads ideas from docs/ideas/*.md
 * (front-matter + freeform body) and emits an IDEAS array sorted alphabetically
 * by title. The docs/pre-release/ folder is NOT bundled — it is a dev-only
 * scratchpad.
 *
 * Exports:
 *   USER_GUIDE_MD   — all skill User Guide sections combined (for Confluence User Guide page)
 *   TECH_REF_MD     — all skill Tech Reference sections + architecture doc (for Architecture Guide page)
 *   ARCHITECTURE_MD — the raw architecture doc (for backward compat / standalone use)
 *   SCREENSHOTS     — JSON object { 'filename.png': 'base64...' } from assets/screenshots/
 *   RELEASES        — array of { version, major, minor, date, title, whatsNew, techChanges } sorted newest-first
 *   IDEAS           — array of { title, status, created, body } sorted alphabetically by title
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

// ── Release notes — docs/releases/MAJOR.MINOR.md ─────────────────────────────
//
// Each release file has YAML-ish front-matter with `version`, `date`, `title`,
// followed by "## 📣 What's New" and optionally "## 🔧 Technical Changes".
// Pre-release scratchpad (docs/pre-release/NEXT.md) is NOT bundled.

const RELEASE_WHATS_NEW_HEADING  = "📣 What's New";
const RELEASE_TECH_HEADING       = '🔧 Technical Changes';

function parseFrontMatter(md) {
    const m = md.match(/^---\n([\s\S]*?)\n---\n/);
    if (!m) return { meta: {}, body: md };
    const meta = {};
    for (const line of m[1].split('\n')) {
        const kv = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.+)\s*$/);
        if (kv) meta[kv[1]] = kv[2].trim();
    }
    return { meta, body: md.slice(m[0].length) };
}

function parseReleaseFile(filePath) {
    const md          = read(filePath);
    const { meta, body } = parseFrontMatter(md);
    const versionStr  = String(meta.version || filePath.match(/([0-9]+\.[0-9]+)\.md$/)?.[1] || '');
    const [majStr, minStr] = versionStr.split('.');
    const major       = parseInt(majStr, 10);
    const minor       = parseInt(minStr, 10);
    if (Number.isNaN(major) || Number.isNaN(minor)) {
        console.warn(`⚠️  Skipping release file with unparseable version: ${filePath}`);
        return null;
    }
    const whatsNew    = extractSection('\n' + body, RELEASE_WHATS_NEW_HEADING, RELEASE_TECH_HEADING) || '';
    const techChanges = extractSection('\n' + body, RELEASE_TECH_HEADING, null) || '';
    return {
        version:  `${major}.${minor}`,
        major,
        minor,
        date:     meta.date  || '',
        title:    meta.title || '',
        whatsNew,
        techChanges,
    };
}

const releasesDir = join(root, 'docs', 'releases');
let releaseFiles  = [];
try {
    releaseFiles = readdirSync(releasesDir)
        .filter(f => extname(f).toLowerCase() === '.md')
        .map(f => `docs/releases/${f}`);
} catch (e) {
    console.warn(`⚠️  Could not read releases directory: ${e.message}`);
}

// Newest-first by (major desc, minor desc)
const RELEASES = releaseFiles
    .map(parseReleaseFile)
    .filter(Boolean)
    .sort((a, b) => (b.major - a.major) || (b.minor - a.minor));

// ── Ideas backlog — docs/ideas/*.md ──────────────────────────────────────────
//
// Each file: front-matter (title, status, created) + freeform markdown body.
// Sorted alphabetically by title (case-insensitive). The Confluence export
// uses destructive sync — files removed here are deleted from Confluence.

function parseIdeaFile(filePath) {
    const md             = read(filePath);
    const { meta, body } = parseFrontMatter(md);
    const title          = meta.title || filePath.match(/([^/\\]+)\.md$/)?.[1] || filePath;
    return {
        title,
        status:  meta.status  || '',
        created: meta.created || '',
        body:    body.trim(),
    };
}

const ideasDir = join(root, 'docs', 'ideas');
let ideaFiles  = [];
try {
    ideaFiles = readdirSync(ideasDir)
        .filter(f => extname(f).toLowerCase() === '.md')
        .map(f => `docs/ideas/${f}`);
} catch (e) {
    console.warn(`⚠️  Could not read ideas directory: ${e.message}`);
}

const IDEAS = ideaFiles
    .map(parseIdeaFile)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));

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
    `export const RELEASES        = ${JSON.stringify(RELEASES)};`,
    `export const IDEAS           = ${JSON.stringify(IDEAS)};`,
    '',
];

const outDir = join(root, 'src', 'docs');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.js'), lines.join('\n'));

const screenshotCount = Object.keys(screenshotsObj).length;
console.log(`✅ docs bundled → src/docs/index.js  (${SKILL_FILES.length} skills, ${screenshotCount} screenshots, ${RELEASES.length} release(s), ${IDEAS.length} idea(s), ${timestamp})`);
