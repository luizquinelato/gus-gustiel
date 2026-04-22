/**
 * Confluence Formatter
 *
 * Converts Markdown strings produced by markdown-formatter.js into
 * Confluence storage format (XHTML) suitable for the Confluence REST API.
 * No I/O, no calculation — presentation only.
 * All functions are pure and stateless.
 */

/**
 * Build a Confluence Table of Contents macro in storage format.
 *
 * The TOC macro auto-scans all headings on the page and renders clickable
 * anchor links. Works for both single-key pages (H2 sections) and combined
 * multi-key pages (H1 per-key + H2 sub-sections).
 *
 * @param {number} [minLevel=1] - Minimum heading level to include (1 = H1)
 * @param {number} [maxLevel=2] - Maximum heading level to include (2 = H2)
 * @returns {string} Confluence storage format XML for the TOC macro
 */
export function buildTocMacro(minLevel = 1, maxLevel = 3) {
    return [
        '<ac:structured-macro ac:name="toc" ac:schema-version="1">',
        `  <ac:parameter ac:name="minLevel">${minLevel}</ac:parameter>`,
        `  <ac:parameter ac:name="maxLevel">${maxLevel}</ac:parameter>`,
        '  <ac:parameter ac:name="style">none</ac:parameter>',
        '  <ac:parameter ac:name="indent">40px</ac:parameter>',
        '</ac:structured-macro>',
    ].join('\n');
}

/**
 * Build a named Confluence anchor macro in storage format.
 *
 * Place this at the target location on the page (e.g. very top) so that
 * "#anchorName" fragment links elsewhere on the page jump back to it.
 *
 * @param {string} [anchorName='top'] - The anchor identifier used in href="#…"
 * @returns {string} Confluence storage format XML for the anchor macro
 */
export function buildAnchorMacro(anchorName = 'top') {
    // Single-line so it can be embedded inline inside a <p> tag without
    // Confluence treating it as a standalone block element (which adds visual space).
    return `<ac:structured-macro ac:name="anchor" ac:schema-version="1"><ac:parameter ac:name="anchorName">${anchorName}</ac:parameter></ac:structured-macro>`;
}

/**
 * Convert inline Markdown syntax to HTML inline elements.
 * Handles: **bold**, [link](url), _italic_
 * @param {string} text
 * @returns {string}
 */
function inlineToHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
        .replace(/_([^_\s][^_]*)_/g, '<em>$1</em>');
}

/**
 * Parse a Markdown pipe-table row into an array of trimmed cell strings.
 * e.g. "| A | B | C |" → ["A", "B", "C"]
 * @param {string} line
 * @returns {string[]}
 */
function parseTableRow(line) {
    return line.split('|').slice(1, -1).map(c => c.trim());
}

/**
 * Render a Confluence storage-format table from a header row and body rows.
 *
 * Layout: full-width. The first column (issue key / name) gets 2x the width
 * of every other column via phantom virtual columns + colspan, which Confluence
 * always respects (unlike inline col `style="width"` which is often stripped).
 *
 * Strategy: create (n + 1) equal-width virtual columns in the colgroup.
 *   First cell  → colspan="2"  (spans 2 virtual cols → ~2x width of others)
 *   Other cells → colspan="1"  (default — 1 virtual col each)
 *
 * e.g. 4 actual cols → 5 virtual cols → first = 2/5 = 40%, others = 1/5 = 20%
 *      6 actual cols → 7 virtual cols → first = 2/7 ≈ 28.6%, others = 1/7 ≈ 14.3%
 *
 * @param {string[]}   headers  - Header cell strings
 * @param {string[][]} bodyRows - Array of body row cell arrays
 * @returns {string}
 */
/**
 * Background colours applied to the Status cell of status summary and epic tables.
 * Keyed by the exact Jira status name as it appears in the cell.
 *
 * Values are Confluence named highlight colours (not hex codes).
 * Named colours are theme-aware in Confluence Cloud dark mode — they render
 * with appropriate contrast in both light and dark themes.
 * Hex codes bypass this mapping and always render as-is, causing light
 * backgrounds with invisible light text in dark mode.
 */
const STATUS_BG = {
    'Backlog':                'light-grey',   // neutral / not started
    'In Progress':            'light-blue',   // active
    'Development':            'light-blue',   // active
    'Deployed to Production': 'light-green',  // completed
    'Released':               'light-green',  // completed
};

/**
 * Return attribute string for a <td> when the cell content matches a known
 * status.  Uses the Confluence-native data-highlight-colour attribute which
 * accepts named colours that adapt to dark mode.  No inline style fallback —
 * named colours are not valid CSS colour values so the fallback would render
 * as the wrong colour anyway.
 */
function tdStyle(content) {
    const plain = content.trim();
    const bg    = STATUS_BG[plain];
    return bg ? ` data-highlight-colour="${bg}"` : '';
}

/**
 * Convert a single cell value to inner HTML content.
 * Cells containing the ↵ sentinel (inserted by dateDeltaCell) are split into
 * multiple <p> paragraphs so each line renders on its own row within the cell.
 */
function cellToHtml(content) {
    if (!content.includes('↵')) return `<p>${inlineToHtml(content)}</p>`;
    return content.split('↵').map(part => `<p>${inlineToHtml(part.trim())}</p>`).join('');
}

/**
 * Column headers that should receive colspan="2" (same as the first/Epic column)
 * to give them extra width for multi-line date content.
 */
const WIDE_HEADERS = new Set(['Start', 'Due']);

function renderTable(headers, bodyRows) {
    const n = headers.length;

    // Build the set of column indexes that should be wide (colspan=2).
    // The first column is always wide; additionally any column whose header
    // matches WIDE_HEADERS (e.g. "Start", "Due") gets the same treatment.
    const wideIndexes = new Set(
        headers.reduce((acc, h, i) => {
            if (i === 0 || WIDE_HEADERS.has(h.trim())) acc.push(i);
            return acc;
        }, [])
    );

    // Each wide column consumes 2 virtual columns; regular columns consume 1.
    const virtualCols = n === 1 ? 1 : n + wideIndexes.size;

    const colgroup = `<colgroup>${
        Array.from({ length: virtualCols }, () => '<col />').join('')
    }</colgroup>`;

    const thCells = headers.map((h, i) =>
        wideIndexes.has(i)
            ? `<th colspan="2">${cellToHtml(h)}</th>`
            : `<th>${cellToHtml(h)}</th>`
    ).join('');

    const bodyHtml = bodyRows.map(row => {
        const tds = row.map((c, i) => {
            if (wideIndexes.has(i)) return `<td colspan="2">${cellToHtml(c)}</td>`;
            const style = tdStyle(c);
            return `<td${style}>${cellToHtml(c)}</td>`;
        }).join('');
        return `<tr>${tds}</tr>`;
    }).join('');

    return `<table data-layout="full-width">${colgroup}<tbody><tr>${thCells}</tr>${bodyHtml}</tbody></table>`;
}

/**
 * Build a Confluence storage-format table with explicit per-column colspan values.
 *
 * Use this instead of markdown pipe tables when you need specific column width
 * ratios that the auto-colspan logic in renderTable() cannot express — for
 * example, a narrow label column (colspan=1) beside a wide description column
 * (colspan=3).
 *
 * The virtual-column strategy is the same as renderTable(): a <colgroup> with
 * (sum of colspans) equal-width phantom columns gives Confluence a consistent
 * width grid to snap to, which survives page re-renders.
 *
 * Cell content supports the same inline Markdown as the rest of the formatter:
 *   **bold**, `code`, _italic_, [link](url)
 *
 * @param {string[]}   headers   - Header cell strings (one per column)
 * @param {string[][]} bodyRows  - Body rows: array of cell-string arrays
 * @param {number[]}   colspans  - Colspan for each column, e.g. [1, 1, 3]
 * @returns {string} Confluence storage-format table XHTML
 *
 * @example
 *   buildCustomTable(
 *     ['#', 'Action', 'What It Does'],
 *     [['1', '`prepare-portfolio-export`', 'Extracts...']],
 *     [1, 1, 3]   // # narrow | Action normal | What It Does wide
 *   )
 */
export function buildCustomTable(headers, bodyRows, colspans) {
    const virtualCols = colspans.reduce((a, b) => a + b, 0);
    const colgroup    = `<colgroup>${Array.from({ length: virtualCols }, () => '<col />').join('')}</colgroup>`;

    const thCells = headers.map((h, i) => {
        const span = colspans[i] || 1;
        return span > 1
            ? `<th colspan="${span}">${cellToHtml(h)}</th>`
            : `<th>${cellToHtml(h)}</th>`;
    }).join('');

    const bodyHtml = bodyRows.map(row => {
        const tds = row.map((c, i) => {
            const span = colspans[i] || 1;
            return span > 1
                ? `<td colspan="${span}">${cellToHtml(c)}</td>`
                : `<td>${cellToHtml(c)}</td>`;
        }).join('');
        return `<tr>${tds}</tr>`;
    }).join('');

    return `<table data-layout="full-width">${colgroup}<tbody><tr>${thCells}</tr>${bodyHtml}</tbody></table>`;
}

/**
 * Convert a Markdown string to Confluence storage format (XHTML).
 *
 * Supported constructs (covering all output from markdown-formatter.js):
 *   # H1 / ## H2 / ### H3   → <h1> / <h2> / <h3>
 *   ---                      → <hr/>
 *   > blockquote             → <blockquote><p>…</p></blockquote>
 *   - item / * item          → <ul><li><p>…</p></li></ul>
 *   | table | rows |         → <table><tbody>…</tbody></table>
 *   [⬆ Back to top](#top)   → right-aligned <p>
 *   **bold**, [link](url),   → inline HTML
 *   _italic_
 *   plain text               → <p>…</p>
 *
 * @param {string} markdown
 * @returns {string} Confluence storage format HTML string
 */
// Map common fenced-code-block language hints to Confluence-supported identifiers.
// Keys are lowercase; anything not listed falls back to 'none' (plain text).
const LANG_MAP = {
    js:         'javascript',
    javascript: 'javascript',
    ts:         'javascript',
    typescript: 'javascript',
    java:       'java',
    python:     'python',
    py:         'python',
    bash:       'bash',
    sh:         'bash',
    sql:        'sql',
    yaml:       'none',
    yml:        'none',
    json:       'javascript',
    css:        'css',
    html:       'html/xml',
    xml:        'html/xml',
    powershell: 'powershell',
    ps1:        'powershell',
};

export function markdownToStorage(markdown) {
    // Normalize line endings — docs may originate from Windows (CRLF) or Unix (LF).
    markdown = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const lines = markdown.split('\n');
    const html  = [];
    let i = 0;
    let firstH1  = true;   // skip back-to-top before the very first H1
    let firstH2  = true;   // skip back-to-top before the very first H2
    let h2Counter = 0;     // resets on each H1
    let h3Counter = 0;     // resets on each H2
    let h4Counter = 0;     // resets on each H3

    while (i < lines.length) {
        const line    = lines[i];
        const trimmed = line.trim();

        // Headings — inject a right-aligned "Back to top" link before every H2 except the first.
        // H1 resets the H2 counter so the first H2 under a new H1 also gets the link skipped.
        if (line.startsWith('# '))   {
            if (firstH1) {
                firstH1 = false;
            }
            firstH2 = true;   // first H2 after any H1 gets no back-to-top
            h2Counter = 0;
            h3Counter = 0;
            h4Counter = 0;
            html.push(`<h1>${inlineToHtml(line.slice(2))}</h1>`);
            i++; continue;
        }
        if (line.startsWith('#### ')) {
            h4Counter++;
            html.push(`<h4>${h2Counter}.${h3Counter}.${h4Counter}. ${inlineToHtml(line.slice(5))}</h4>`);
            i++; continue;
        }
        if (line.startsWith('### '))  {
            h3Counter++;
            h4Counter = 0;
            html.push(`<h3>${h2Counter}.${h3Counter}. ${inlineToHtml(line.slice(4))}</h3>`);
            i++; continue;
        }
        if (line.startsWith('## '))   {
            if (firstH2) {
                firstH2 = false;
            } else {
                const backToTop = '<p style="text-align: right;"><a href="#top">⬆ Back to top</a></p>';
                if (html.length > 0 && html[html.length - 1] === '<hr/>') {
                    html.splice(html.length - 1, 0, backToTop);
                } else {
                    html.push(backToTop);
                }
            }
            h2Counter++;
            h3Counter = 0;
            h4Counter = 0;
            html.push(`<h2>${h2Counter}. ${inlineToHtml(line.slice(3))}</h2>`);
            i++; continue;
        }

        // Horizontal rule
        if (trimmed === '---') { html.push('<hr/>'); i++; continue; }

        // Blockquote — collect consecutive '> ' lines into a single <blockquote> block
        if (line.startsWith('> ')) {
            const bqLines = [];
            while (i < lines.length && lines[i].startsWith('> ')) {
                bqLines.push(`<p>${inlineToHtml(lines[i].slice(2))}</p>`);
                i++;
            }
            html.push(`<blockquote>${bqLines.join('')}</blockquote>`);
            continue;
        }

        // Unordered list — collect consecutive list items into a single <ul>
        // Note: use <li>text</li> without an inner <p> tag — Confluence Cloud loses
        // the bullet style ("Bullet style = none") when <li> contains block-level <p>.
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
            const listItems = [];
            while (i < lines.length && (lines[i].trimStart().startsWith('- ') || lines[i].trimStart().startsWith('* '))) {
                const itemContent = lines[i].replace(/^\s*[-*]\s+/, '');
                listItems.push(`<li>${inlineToHtml(itemContent)}</li>`);
                i++;
            }
            html.push(`<ul>${listItems.join('')}</ul>`);
            continue;
        }

        // Right-aligned "Back to top" link
        if (trimmed === '[⬆ Back to top](#top)') {
            html.push('<p style="text-align: right;"><a href="#top">⬆ Back to top</a></p>');
            i++; continue;
        }

        // Table: current line starts with '|' and next line is a separator (|---|)
        if (line.startsWith('|') && i + 1 < lines.length && /^\|[\s\-:|]+\|/.test(lines[i + 1])) {
            const headers = parseTableRow(line);
            i += 2; // skip header row + separator row
            const bodyRows = [];
            while (i < lines.length && lines[i].startsWith('|')) {
                bodyRows.push(parseTableRow(lines[i]));
                i++;
            }
            html.push(renderTable(headers, bodyRows));
            continue;
        }

        // Fenced code block: ``` (with optional language hint) … ```
        // Rendered using Confluence's native code macro so content is preserved verbatim
        // and the Fabric editor does not reject it as an "unsupported extension".
        if (trimmed.startsWith('```')) {
            const rawLang  = trimmed.slice(3).trim().toLowerCase();
            const lang     = LANG_MAP[rawLang] || (rawLang ? 'none' : 'none');
            i++; // skip opening fence
            const codeLines = [];
            while (i < lines.length && !lines[i].trim().startsWith('```')) {
                codeLines.push(lines[i]);
                i++;
            }
            i++; // skip closing fence
            const codeContent = codeLines.join('\n');
            const langParam   = `\n  <ac:parameter ac:name="language">${lang}</ac:parameter>`;
            // Escape sequences that Confluence's validator misinterprets even inside CDATA:
            //   1. ]]>  → split CDATA to prevent premature closure
            //   2. <ac: / </ac: → split CDATA and emit as HTML entity so the validator
            //      doesn't count them as real (unclosed) macro elements
            const safeCdata = codeContent
                .replace(/\]\]>/g,  ']]]]><![CDATA[>')
                .replace(/<(\/?)ac:/g, ']]>&lt;$1ac:<![CDATA[');
            html.push(
                `<ac:structured-macro ac:name="code" ac:schema-version="1">${langParam}\n` +
                `  <ac:plain-text-body><![CDATA[${safeCdata}]]></ac:plain-text-body>\n` +
                `</ac:structured-macro>`
            );
            continue;
        }

        // Empty line — skip (Confluence renders vertical space automatically)
        if (trimmed === '') { i++; continue; }

        // Inline image with ATTACH: prefix → Confluence attachment image macro
        // Syntax: ![alt](ATTACH:filename.png)
        // Renders as a Confluence attachment inline image (no external URL needed).
        const attachMatch = trimmed.match(/^!\[([^\]]*)\]\(ATTACH:([^)]+)\)$/);
        if (attachMatch) {
            const filename = attachMatch[2].trim();
            html.push(`<ac:image><ri:attachment ri:filename="${filename}"/></ac:image>`);
            i++; continue;
        }

        // Paragraph
        html.push(`<p>${inlineToHtml(line)}</p>`);
        i++;
    }

    return html.join('\n');
}

