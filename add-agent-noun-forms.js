// Generates agent-noun forms from every verb — "one who/something that
// does X" (TEACH -> TEACHER, BAKE -> BAKER) — with the standard
// spelling changes (silent-e: just add -r; consonant-doubling:
// RUN->RUNNER; y->ier after a consonant: CARRY->CARRIER), checks each
// candidate against ENABLE, adds whatever's missing. Same methodology
// as the other add-*-forms.js scripts.

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

const { VERB_WORDS } = require('./words-pos.js');
const MAX_WORD_LEN = 10;

function doublesFinalConsonant(w) {
  if (w.length < 3) return false;
  const [a, b, c] = [w[w.length - 3], w[w.length - 2], w[w.length - 1]];
  const vowels = new Set(['a', 'e', 'i', 'o', 'u']);
  return !vowels.has(a) && vowels.has(b) && !vowels.has(c) && !['w', 'x', 'y'].includes(c);
}

function agentNounForms(lower) {
  const forms = new Set();
  if (lower.endsWith('e')) {
    forms.add(lower + 'r'); // bake -> baker
  } else if (lower.endsWith('y') && lower.length > 1 && !'aeiou'.includes(lower[lower.length - 2])) {
    forms.add(lower.slice(0, -1) + 'ier'); // carry -> carrier
    forms.add(lower + 'er'); // flyer is also standard alongside flier
  } else if (doublesFinalConsonant(lower)) {
    forms.add(lower + lower[lower.length - 1] + 'er'); // run -> runner
  } else {
    forms.add(lower + 'er'); // teach -> teacher
  }
  return [...forms];
}

const candidates = new Map();
for (const verb of VERB_WORDS) {
  for (const form of agentNounForms(verb.toLowerCase())) {
    const upper = form.toUpperCase();
    if (upper.length <= MAX_WORD_LEN) candidates.set(upper, verb);
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

fs.writeFileSync(path.join(__dirname, 'agent-noun-forms-to-add.json'), JSON.stringify(toAdd, null, 2));

const merged = [...new Set([...currentWords, ...toAdd])].sort();
fs.writeFileSync(wordsPath, wordsRaw.replace(wordsMatch[1], JSON.stringify(merged)));
console.log(`\nwords.js: ${currentWords.length} -> ${merged.length} words`);
