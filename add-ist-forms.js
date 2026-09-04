// Generates -ist agent/practitioner/adherent forms from every noun
// (ART -> ARTIST, GUITAR -> GUITARIST, CYCLE -> CYCLIST, PIANO ->
// PIANIST, THEORY -> THEORIST) — unlike -er, this suffix attaches to
// nouns (a field, instrument, or ideology), not verbs. Checks each
// candidate against ENABLE, adds whatever's missing. Same methodology
// as the other add-*-forms.js scripts: over-generate the plausible
// spelling variants, let ENABLE be the real filter.

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

const { NOUN_WORDS } = require('./words-pos.js');
const MAX_WORD_LEN = 10;

function istForms(lower) {
  const forms = new Set();
  forms.add(lower + 'ist'); // art -> artist, guitar -> guitarist
  if (lower.endsWith('e')) forms.add(lower.slice(0, -1) + 'ist'); // cycle -> cyclist
  if (lower.endsWith('o')) forms.add(lower.slice(0, -1) + 'ist'); // piano -> pianist, cello -> cellist
  if (lower.endsWith('y') && lower.length > 1 && !'aeiou'.includes(lower[lower.length - 2])) {
    forms.add(lower.slice(0, -1) + 'ist'); // theory -> theorist
  }
  return [...forms];
}

const candidates = new Map();
for (const noun of NOUN_WORDS) {
  for (const form of istForms(noun.toLowerCase())) {
    const upper = form.toUpperCase();
    if (upper.length <= MAX_WORD_LEN) candidates.set(upper, noun);
  }
}

console.log(`Generated ${candidates.size} unique candidate forms.`);

const toAdd = [];
let alreadyIn = 0;
let notReal = 0;
for (const word of candidates.keys()) {
  if (currentSet.has(word)) { alreadyIn++; continue; }
  if (ENABLE.has(word)) toAdd.push(word);
  else notReal++;
}

toAdd.sort();
console.log(`  already in words.js: ${alreadyIn}`);
console.log(`  not a real word (not in ENABLE): ${notReal}`);
console.log(`  real, missing -> ADDING: ${toAdd.length}`);
console.log(`\nFirst 40: ${toAdd.slice(0, 40).join(', ')}`);

fs.writeFileSync(path.join(__dirname, 'ist-forms-to-add.json'), JSON.stringify(toAdd, null, 2));

const merged = [...new Set([...currentWords, ...toAdd])].sort();
fs.writeFileSync(wordsPath, wordsRaw.replace(wordsMatch[1], JSON.stringify(merged)));
console.log(`\nwords.js: ${currentWords.length} -> ${merged.length} words`);
