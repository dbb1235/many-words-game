// Generates adverb forms from every adjective (QUICK -> QUICKLY) with
// the standard spelling changes (y->ily: HAPPY->HAPPILY; le->ly after
// a consonant: SIMPLE->SIMPLY; ic->ically: BASIC->BASICALLY), checks
// each candidate against ENABLE, adds whatever's missing. Same
// methodology as add-adjective-forms.js — over-generate candidates,
// let the ENABLE check be the real filter.

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

const { ADJECTIVE_WORDS } = require('./words-pos.js');
const MAX_WORD_LEN = 10;

function adverbForms(lower) {
  const forms = new Set();
  const vowels = 'aeiou';
  if (lower.endsWith('y') && lower.length > 1 && !vowels.includes(lower[lower.length - 2])) {
    forms.add(lower.slice(0, -1) + 'ily'); // happy -> happily
  }
  if (lower.endsWith('le') && lower.length > 2 && !vowels.includes(lower[lower.length - 3])) {
    forms.add(lower.slice(0, -2) + 'ly'); // simple -> simply
  }
  if (lower.endsWith('ic')) {
    forms.add(lower + 'ally'); // basic -> basically
  }
  forms.add(lower + 'ly'); // quick -> quickly, safe -> safely, fallback for everything else
  return [...forms];
}

const candidates = new Map();
for (const adj of ADJECTIVE_WORDS) {
  for (const form of adverbForms(adj.toLowerCase())) {
    const upper = form.toUpperCase();
    if (upper.length <= MAX_WORD_LEN) candidates.set(upper, adj);
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

fs.writeFileSync(path.join(__dirname, 'adverb-forms-to-add.json'), JSON.stringify(toAdd, null, 2));

const merged = [...new Set([...currentWords, ...toAdd])].sort();
fs.writeFileSync(wordsPath, wordsRaw.replace(wordsMatch[1], JSON.stringify(merged)));
console.log(`\nwords.js: ${currentWords.length} -> ${merged.length} words`);
