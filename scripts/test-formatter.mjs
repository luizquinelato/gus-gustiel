/**
 * Test script — validates markdownToStorage output for TECH_REF_MD
 * Run: node scripts/test-formatter.mjs
 */

import { markdownToStorage } from '../src/formatters/confluence-formatter.js';
import { TECH_REF_MD } from '../src/docs/index.js';

const fullMd = '# Tech Ref\n\n' + TECH_REF_MD;
const result = markdownToStorage(fullMd);

console.log('Total storageBody length:', result.length, 'chars');

// Count code blocks
const codeBlocks = (result.match(/<ac:structured-macro ac:name="code"/g) || []).length;
console.log('Code blocks generated:', codeBlocks);

// Check for ]]> inside CDATA (would prematurely close CDATA)
const cdataRe = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
let m;
let cdataIssues = 0;
while ((m = cdataRe.exec(result)) !== null) {
    if (m[1].includes(']]>')) {
        console.error('CDATA premature close in block:', m[1].substring(0, 100));
        cdataIssues++;
    }
}
console.log('CDATA closure issues:', cdataIssues);

// Strip everything inside CDATA and XML tags, look for raw < or >
let outside = result;
// Remove CDATA sections
outside = outside.replace(/<!\[CDATA[\s\S]*?\]\]>/g, '');
// Remove XML tags
outside = outside.replace(/<[^>]*>/g, '');
// Remove known entities
outside = outside.replace(/&(amp|lt|gt|quot|apos);/g, '');

const rawLt = (outside.match(/</g) || []).length;
const rawGt = (outside.match(/>/g) || []).length;
console.log('Raw < in text (outside tags/CDATA):', rawLt);
console.log('Raw > in text (outside tags/CDATA):', rawGt);

if (rawLt > 0 || rawGt > 0) {
    // Find first occurrence
    const ltIdx = outside.indexOf('<');
    const gtIdx = outside.indexOf('>');
    const idx = Math.min(ltIdx === -1 ? Infinity : ltIdx, gtIdx === -1 ? Infinity : gtIdx);
    console.log('Context around first raw angle bracket:', JSON.stringify(outside.slice(Math.max(0, idx - 50), idx + 50)));
}

// Check for unbalanced macro tags
const macroOpen = (result.match(/<ac:structured-macro /g) || []).length;
const macroClose = (result.match(/<\/ac:structured-macro>/g) || []).length;
console.log('Macro open/close balance:', macroOpen, '/', macroClose, macroOpen === macroClose ? '✅' : '❌ MISMATCH');

// Check for unbalanced plain-text-body tags
const ptbOpen = (result.match(/<ac:plain-text-body>/g) || []).length;
const ptbClose = (result.match(/<\/ac:plain-text-body>/g) || []).length;
console.log('plain-text-body open/close:', ptbOpen, '/', ptbClose, ptbOpen === ptbClose ? '✅' : '❌ MISMATCH');

console.log('\nFirst 500 chars of output:');
console.log(result.slice(0, 500));

// Check for <ac: ANYWHERE (including inside CDATA)
const allAcMatches = [...result.matchAll(/<[\u200B]?(?:\/?)ac:/g)];
console.log('\nTotal <ac: pattern matches (incl ZWS variants):', allAcMatches.length);

// Count ZWS escapes specifically
const zwsMatches = (result.match(/<\u200B/g) || []).length;
console.log('Zero-width space escapes applied:', zwsMatches);

// Check if any raw <ac: (without ZWS) exist outside proper XML tag contexts
const allRawAc = [...result.matchAll(/<ac:/g)];
const allRawClosingAc = [...result.matchAll(/<\/ac:/g)];
console.log('Raw <ac: tags (should only be real macros, not inside CDATA):', allRawAc.length);
console.log('Raw </ac: tags:', allRawClosingAc.length);

// Write full output for manual inspection
import { writeFileSync } from 'fs';
writeFileSync('scripts/debug-output.xml', result, 'utf8');
console.log('\nFull output written to scripts/debug-output.xml');
