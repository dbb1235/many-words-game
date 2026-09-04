// Runs all 10 "most productive next candidate" affixes in one pass:
// suffixes -ness, -ment, -tion/-sion/-ation, -able/-ible, -ful, -less
// and prefixes un-, re-, dis-, in-/im-/il-/ir-. Same methodology as
// every other add-*-forms.js script: generate plausible spelling
// variants per pattern, validate against ENABLE, add what's real.
// Reports a per-pattern breakdown before merging everything into
// words.js in one write.

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
const isVowel = (ch) => 'aeiou'.includes(ch);

function yToI(lower) {
  return lower.endsWith('y') && lower.length > 1 && !isVowel(lower[lower.length - 2]);
}

// ---------- Suffixes ----------

function nessForms(lower) {
  const f = new Set();
  if (yToI(lower)) f.add(lower.slice(0, -1) + 'iness'); // happy -> happiness
  else f.add(lower + 'ness'); // dark -> darkness
  return [...f];
}

function mentForms(lower) {
  const f = new Set();
  f.add(lower + 'ment'); // govern -> government
  if (lower.endsWith('e')) f.add(lower.slice(0, -1) + 'ment'); // argue -> argument, judge -> judgment
  return [...f];
}

function tionForms(lower) {
  const f = new Set();
  const stem = lower.endsWith('e') ? lower.slice(0, -1) : lower;
  f.add(lower + 'tion'); f.add(lower + 'ation'); f.add(lower + 'ition');
  f.add(stem + 'tion'); f.add(stem + 'ation'); f.add(stem + 'ition'); f.add(stem + 'sion'); f.add(stem + 'ion');
  return [...f];
}

function ableForms(lower) {
  const f = new Set();
  f.add(lower + 'able'); f.add(lower + 'ible');
  if (lower.endsWith('e')) { const stem = lower.slice(0, -1); f.add(stem + 'able'); f.add(stem + 'ible'); }
  return [...f];
}

function fulLessForms(lower) {
  const f = new Set();
  if (yToI(lower)) { const stem = lower.slice(0, -1) + 'i'; f.add(stem + 'ful'); f.add(stem + 'less'); }
  else { f.add(lower + 'ful'); f.add(lower + 'less'); }
  return [...f];
}

// ---------- Prefixes ----------

function unForms(lower) { return ['un' + lower]; }
function reForms(lower) { return ['re' + lower]; }
function disForms(lower) { return ['dis' + lower]; }
function inForms(lower) {
  const f = new Set(['in' + lower]);
  const c = lower[0];
  if (c === 'm' || c === 'p' || c === 'b') f.add('im' + lower);
  if (c === 'l') f.add('il' + lower);
  if (c === 'r') f.add('ir' + lower);
  return [...f];
}

// pattern name -> { source list, generator, label }
const PATTERNS = [
  { name: '-ness', source: ADJECTIVE_WORDS, gen: nessForms },
  { name: '-ment', source: VERB_WORDS, gen: mentForms },
  { name: '-tion/-sion/-ation', source: VERB_WORDS, gen: tionForms },
  { name: '-able/-ible', source: VERB_WORDS, gen: ableForms },
  { name: '-ful/-less', source: NOUN_WORDS, gen: fulLessForms },
  { name: 'un-', source: [...ADJECTIVE_WORDS, ...VERB_WORDS], gen: unForms },
  { name: 're-', source: VERB_WORDS, gen: reForms },
  { name: 'dis-', source: [...VERB_WORDS, ...ADJECTIVE_WORDS], gen: disForms },
  { name: 'in-/im-/il-/ir-', source: ADJECTIVE_WORDS, gen: inForms },
];

const allToAdd = new Set();
const report = [];

for (const { name, source, gen } of PATTERNS) {
  const candidates = new Set();
  for (const word of source) {
    for (const form of gen(word.toLowerCase())) {
      const upper = form.toUpperCase();
      if (upper.length <= MAX_WORD_LEN) candidates.add(upper);
    }
  }
  let already = 0, real = 0;
  for (const word of candidates) {
    if (currentSet.has(word) || allToAdd.has(word)) { already++; continue; }
    if (ENABLE.has(word)) { allToAdd.add(word); real++; }
  }
  report.push({ name, candidates: candidates.size, already, real });
}

console.log('Pattern breakdown:');
for (const r of report) {
  console.log(`  ${r.name.padEnd(20)} candidates: ${String(r.candidates).padStart(6)}  already present: ${String(r.already).padStart(5)}  added: ${r.real}`);
}

const toAdd = [...allToAdd].sort();
console.log(`\nTotal unique new words across all patterns: ${toAdd.length}`);
console.log(`First 40: ${toAdd.slice(0, 40).join(', ')}`);

fs.writeFileSync(path.join(__dirname, 'productive-affixes-to-add.json'), JSON.stringify(toAdd, null, 2));

const merged = [...new Set([...currentWords, ...toAdd])].sort();
fs.writeFileSync(wordsPath, wordsRaw.replace(wordsMatch[1], JSON.stringify(merged)));
console.log(`\nwords.js: ${currentWords.length} -> ${merged.length} words`);
