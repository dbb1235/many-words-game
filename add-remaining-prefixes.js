// Runs the remaining prefixes from the earlier list that weren't part
// of add-productive-affixes.js's un-/re-/dis-/in-: non-, mis-, pre-,
// over-, under-, out-, sub-, super-, inter-, de-, co-, bi-, tri-,
// semi-, multi-. All are simple prepends (no spelling change to the
// base word), so unlike the suffix scripts there's no per-pattern
// generator needed — each prefix is checked against the combined pool
// of nouns/verbs/adjectives rather than guessing which POS a given
// prefix "should" attach to; ENABLE is the real filter either way, so
// over-checking is cheap and safe.

const fs = require('fs');
const path = require('path');

const ENABLE_PATH = '/tmp/words-enable-full.js';
const enableRaw = fs.readFileSync(ENABLE_PATH, 'utf8');
const ENABLE = new Set(JSON.parse(enableRaw.match(/new Set\((\[[\s\S]*\])\)/)[1]));

const wordsPath = path.join(__dirname, 'words.js');
const wordsRaw = fs.readFileSync(wordsPath, 'utf8');
const wordsMatch = wordsRaw.match(/new Set\((\[[\s\S]*\])\)/);
const currentWords = JSON.parse(wordsMatch[1]);
const currentSet = new Set(currentWords);

const { NOUN_WORDS, VERB_WORDS, ADJECTIVE_WORDS } = require('./words-pos.js');
const MAX_WORD_LEN = 10;

const basePool = new Set([...NOUN_WORDS, ...VERB_WORDS, ...ADJECTIVE_WORDS]);
console.log(`Base pool (nouns + verbs + adjectives, deduped): ${basePool.size} words.`);

const PREFIXES = ['non', 'mis', 'pre', 'over', 'under', 'out', 'sub', 'super', 'inter', 'de', 'co', 'bi', 'tri', 'semi', 'multi'];

const allToAdd = new Set();
const report = [];

for (const prefix of PREFIXES) {
  let candidateCount = 0, already = 0, real = 0;
  for (const word of basePool) {
    const candidate = (prefix + word.toLowerCase()).toUpperCase();
    if (candidate.length > MAX_WORD_LEN) continue;
    candidateCount++;
    if (currentSet.has(candidate) || allToAdd.has(candidate)) { already++; continue; }
    if (ENABLE.has(candidate)) { allToAdd.add(candidate); real++; }
  }
  report.push({ prefix, candidateCount, already, real });
}

console.log('\nPrefix breakdown:');
for (const r of report) {
  console.log(`  ${(r.prefix + '-').padEnd(8)} candidates: ${String(r.candidateCount).padStart(6)}  already present: ${String(r.already).padStart(5)}  added: ${r.real}`);
}

const toAdd = [...allToAdd].sort();
console.log(`\nTotal unique new words across all prefixes: ${toAdd.length}`);
console.log(`First 40: ${toAdd.slice(0, 40).join(', ')}`);

fs.writeFileSync(path.join(__dirname, 'remaining-prefixes-to-add.json'), JSON.stringify(toAdd, null, 2));

const merged = [...new Set([...currentWords, ...toAdd])].sort();
fs.writeFileSync(wordsPath, wordsRaw.replace(wordsMatch[1], JSON.stringify(merged)));
console.log(`\nwords.js: ${currentWords.length} -> ${merged.length} words`);
