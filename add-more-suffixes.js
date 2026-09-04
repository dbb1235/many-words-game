// Continues the suffix list beyond what add-productive-affixes.js
// covered: -hood, -ship, -dom, -ism, -ive/-ative, -ic/-ical, -ish,
// -y (adjective-forming), -ize/-ise, -ify, -en, -eer, -ette, -let.
// Same methodology throughout: generate plausible spelling variants
// per pattern from the appropriate source POS, validate against
// ENABLE, add what's real.

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
const yToI = (w) => w.endsWith('y') && w.length > 1 && !isVowel(w[w.length - 2]);

function doublesFinalConsonant(w) {
  if (w.length < 3) return false;
  const [a, b, c] = [w[w.length - 3], w[w.length - 2], w[w.length - 1]];
  const vowels = new Set(['a', 'e', 'i', 'o', 'u']);
  return !vowels.has(a) && vowels.has(b) && !vowels.has(c) && !['w', 'x', 'y'].includes(c);
}

function stemDropE(w) { return w.endsWith('e') ? w.slice(0, -1) : w; }

const hoodForms = (w) => [w + 'hood'];
const shipForms = (w) => [w + 'ship'];
const domForms = (w) => [w + 'dom', stemDropE(w) + 'dom'];
const ismForms = (w) => [w + 'ism', stemDropE(w) + 'ism'];
const iveForms = (w) => [w + 'ive', w + 'ative', stemDropE(w) + 'ive', stemDropE(w) + 'ative'];

function icForms(w) {
  const f = [w + 'ic', w + 'ical'];
  if (yToI(w)) { const stem = w.slice(0, -1); f.push(stem + 'ic', stem + 'ical'); }
  return f;
}

function ishForms(w) {
  const f = [w + 'ish'];
  if (doublesFinalConsonant(w)) f.push(w + w[w.length - 1] + 'ish');
  return f;
}

function yAdjForms(w) {
  const f = [w + 'y', stemDropE(w) + 'y'];
  if (doublesFinalConsonant(w)) f.push(w + w[w.length - 1] + 'y');
  return f;
}

function izeForms(w) {
  const stem = stemDropE(w);
  return [w + 'ize', w + 'ise', stem + 'ize', stem + 'ise'];
}

function ifyForms(w) {
  const f = [w + 'ify', stemDropE(w) + 'ify'];
  if (yToI(w)) f.push(w.slice(0, -1) + 'ify');
  return f;
}

const enForms = (w) => [w + 'en'];
const eerForms = (w) => [w + 'eer'];
const etteForms = (w) => [w + 'ette', stemDropE(w) + 'ette'];
const letForms = (w) => [w + 'let'];

const PATTERNS = [
  { name: '-hood', source: NOUN_WORDS, gen: hoodForms },
  { name: '-ship', source: NOUN_WORDS, gen: shipForms },
  { name: '-dom', source: [...NOUN_WORDS, ...ADJECTIVE_WORDS], gen: domForms },
  { name: '-ism', source: [...NOUN_WORDS, ...ADJECTIVE_WORDS], gen: ismForms },
  { name: '-ive/-ative', source: VERB_WORDS, gen: iveForms },
  { name: '-ic/-ical', source: NOUN_WORDS, gen: icForms },
  { name: '-ish', source: [...NOUN_WORDS, ...ADJECTIVE_WORDS], gen: ishForms },
  { name: '-y (adj)', source: NOUN_WORDS, gen: yAdjForms },
  { name: '-ize/-ise', source: [...ADJECTIVE_WORDS, ...NOUN_WORDS], gen: izeForms },
  { name: '-ify', source: [...NOUN_WORDS, ...ADJECTIVE_WORDS], gen: ifyForms },
  { name: '-en', source: [...ADJECTIVE_WORDS, ...NOUN_WORDS], gen: enForms },
  { name: '-eer', source: NOUN_WORDS, gen: eerForms },
  { name: '-ette', source: NOUN_WORDS, gen: etteForms },
  { name: '-let', source: NOUN_WORDS, gen: letForms },
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
  console.log(`  ${r.name.padEnd(14)} candidates: ${String(r.candidates).padStart(6)}  already present: ${String(r.already).padStart(5)}  added: ${r.real}`);
}

const toAdd = [...allToAdd].sort();
console.log(`\nTotal unique new words across all patterns: ${toAdd.length}`);
console.log(`First 40: ${toAdd.slice(0, 40).join(', ')}`);

fs.writeFileSync(path.join(__dirname, 'more-suffixes-to-add.json'), JSON.stringify(toAdd, null, 2));

const merged = [...new Set([...currentWords, ...toAdd])].sort();
fs.writeFileSync(wordsPath, wordsRaw.replace(wordsMatch[1], JSON.stringify(merged)));
console.log(`\nwords.js: ${currentWords.length} -> ${merged.length} words`);
