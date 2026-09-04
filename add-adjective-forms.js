// Generates comparative/superlative forms for every adjective
// (QUICK -> QUICKER/QUICKEST) and participial-adjective forms for
// every verb (BURN -> BURNED, "burned toast" — the -ED form of a verb
// used adjectivally), checks each candidate against ENABLE (same bar
// as add-missing-plurals.js, per Chris: real-word-per-ENABLE is
// sufficient once the base word is already common enough to be in
// words.js), and adds whatever's missing.
//
// Doesn't try to encode which adjectives take -er/-est vs. more/most
// (BEAUTIFUL doesn't take BEAUTIFULER) — over-generating candidates is
// fine because the ENABLE check is the real filter; a bad candidate
// like BEAUTIFULER just won't be a real word and gets dropped there.

const fs = require('fs');
const path = require('path');

const ENABLE_PATH = '/tmp/words-enable-full.js';
const enableRaw = fs.readFileSync(ENABLE_PATH, 'utf8');
const enableMatch = enableRaw.match(/new Set\((\[[\s\S]*\])\)/);
const ENABLE = new Set(JSON.parse(enableMatch[1]));

const wordsPath = path.join(__dirname, 'words.js');
const wordsRaw = fs.readFileSync(wordsPath, 'utf8');
const wordsMatch = wordsRaw.match(/new Set\((\[[\s\S]*\])\)/);
const currentWords = JSON.parse(wordsMatch[1]);
const currentSet = new Set(currentWords);

const { ADJECTIVE_WORDS, VERB_WORDS } = require('./words-pos.js');

const MAX_WORD_LEN = 10;

// Standard English spelling-change rules for suffixing -er/-est/-ed.
// consonant-vowel-consonant (single syllable, not ending in w/x/y)
// doubles the final consonant: BIG->BIGGER, SAD->SADDER, STOP->STOPPED.
function doublesFinalConsonant(w) {
  if (w.length < 3) return false;
  const [a, b, c] = [w[w.length - 3], w[w.length - 2], w[w.length - 1]];
  const vowels = new Set(['a', 'e', 'i', 'o', 'u']);
  return !vowels.has(a) && vowels.has(b) && !vowels.has(c) && !['w', 'x', 'y'].includes(c);
}

function comparativeForms(lower) {
  const forms = new Set();
  if (lower.endsWith('e')) {
    forms.add(lower + 'r'); forms.add(lower + 'st');
  } else if (lower.endsWith('y') && lower.length > 1 && !'aeiou'.includes(lower[lower.length - 2])) {
    const stem = lower.slice(0, -1) + 'i';
    forms.add(stem + 'er'); forms.add(stem + 'est');
  } else if (doublesFinalConsonant(lower)) {
    const doubled = lower + lower[lower.length - 1];
    forms.add(doubled + 'er'); forms.add(doubled + 'est');
  } else {
    forms.add(lower + 'er'); forms.add(lower + 'est');
  }
  return [...forms];
}

function pastTenseForms(lower) {
  const forms = new Set();
  if (lower.endsWith('e')) {
    forms.add(lower + 'd');
  } else if (lower.endsWith('y') && lower.length > 1 && !'aeiou'.includes(lower[lower.length - 2])) {
    forms.add(lower.slice(0, -1) + 'ied');
  } else if (doublesFinalConsonant(lower)) {
    forms.add(lower + lower[lower.length - 1] + 'ed');
  } else {
    forms.add(lower + 'ed');
  }
  return [...forms];
}

const candidates = new Map(); // WORD -> { from, rule }

for (const adj of ADJECTIVE_WORDS) {
  for (const form of comparativeForms(adj.toLowerCase())) {
    const upper = form.toUpperCase();
    if (upper.length <= MAX_WORD_LEN) candidates.set(upper, { from: adj, rule: 'comparative/superlative' });
  }
}
for (const verb of VERB_WORDS) {
  for (const form of pastTenseForms(verb.toLowerCase())) {
    const upper = form.toUpperCase();
    if (upper.length <= MAX_WORD_LEN) candidates.set(upper, { from: verb, rule: 'participial adjective (-ed)' });
  }
}

console.log(`Generated ${candidates.size} unique candidate forms.`);

const toAdd = [];
const notReal = [];
for (const [word, info] of candidates) {
  if (currentSet.has(word)) continue; // already in the dictionary
  if (ENABLE.has(word)) toAdd.push(word);
  else notReal.push(word);
}

toAdd.sort();
console.log(`  already in words.js: ${candidates.size - toAdd.length - notReal.length}`);
console.log(`  not a real word (not in ENABLE): ${notReal.length}`);
console.log(`  real, missing -> ADDING: ${toAdd.length}`);

fs.writeFileSync(path.join(__dirname, 'adjective-forms-to-add.json'), JSON.stringify(toAdd, null, 2));
console.log(`\nFirst 40: ${toAdd.slice(0, 40).join(', ')}`);

const merged = [...new Set([...currentWords, ...toAdd])].sort();
const newContent = wordsRaw.replace(wordsMatch[1], JSON.stringify(merged));
fs.writeFileSync(wordsPath, newContent);
console.log(`\nwords.js: ${currentWords.length} -> ${merged.length} words`);
