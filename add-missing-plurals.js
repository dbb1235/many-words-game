// Reviews missing-plurals.json (from verify-plurals.js) against
// ENABLE only — not also requiring the plural itself to independently
// clear SCOWL-50's commonality bar. Revised standard, per Chris:
// a plural whose *base* word is already common enough to be in
// words.js should be included even if the plural form itself is
// comparatively rare — the commonality requirement is satisfied
// transitively through the singular, it doesn't need to be re-earned
// by the plural on its own. So the only remaining bar is "is this a
// real word at all," which ENABLE (a comprehensive tournament-Scrabble
// word list) is a reasonable check for. See project_dictionary_curation
// in memory for where ENABLE/SCOWL-50 themselves come from.
//
// A "missing" plural is missing for one of two reasons now:
//   (a) not a real word at all (not in ENABLE) -> correctly absent
//   (b) real (in ENABLE), just missing from words.js's 50,027 -> add it
//
// Does not re-run the acronym/trade-name hand-review from the original
// curation — these are all regular plurals of nouns already approved
// in words.js, and a plural of an approved common noun essentially
// never independently becomes a problematic acronym or trade name, so
// that risk is negligible here.

const fs = require('fs');
const path = require('path');

const ENABLE_PATH = '/tmp/words-enable-full.js';
const SCOWL_PATH = '/tmp/scowl-50.txt';

const enableRaw = fs.readFileSync(ENABLE_PATH, 'utf8');
const enableMatch = enableRaw.match(/new Set\((\[[\s\S]*\])\)/);
const ENABLE = new Set(JSON.parse(enableMatch[1]));

const scowlRaw = fs.readFileSync(SCOWL_PATH, 'utf8');
const SCOWL_50 = new Set(
  scowlRaw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && /^[a-zA-Z]+$/.test(line))
    .map((w) => w.toUpperCase())
);

console.log(`ENABLE: ${ENABLE.size} words. SCOWL-50: ${SCOWL_50.size} words.`);

const wordsPath = path.join(__dirname, 'words.js');
const wordsRaw = fs.readFileSync(wordsPath, 'utf8');
const wordsMatch = wordsRaw.match(/new Set\((\[[\s\S]*\])\)/);
const currentWords = JSON.parse(wordsMatch[1]);
const currentSet = new Set(currentWords);

const missing = JSON.parse(fs.readFileSync(path.join(__dirname, 'missing-plurals.json'), 'utf8'));

const toAdd = [];
const notInEnable = [];
const alreadyPresent = [];

for (const { noun, expectedPlural } of missing) {
  if (currentSet.has(expectedPlural)) { alreadyPresent.push(expectedPlural); continue; }
  if (ENABLE.has(expectedPlural)) {
    toAdd.push(expectedPlural);
  } else {
    notInEnable.push(expectedPlural);
  }
}

const uniqueToAdd = [...new Set(toAdd)].sort();
const inBothCount = uniqueToAdd.filter((w) => SCOWL_50.has(w)).length;

console.log(`\nOf ${missing.length} candidates:`);
console.log(`  already present (shouldn't happen, sanity check): ${alreadyPresent.length}`);
console.log(`  not a real word (not in ENABLE) -> staying out: ${notInEnable.length}`);
console.log(`  real (in ENABLE), regardless of SCOWL-50 -> ADDING: ${uniqueToAdd.length}`);
console.log(`    (of which ${inBothCount} also independently clear SCOWL-50, ${uniqueToAdd.length - inBothCount} rely on the base word's commonality)`);

fs.writeFileSync(path.join(__dirname, 'plurals-to-add.json'), JSON.stringify(uniqueToAdd, null, 2));
console.log(`\nWrote ${uniqueToAdd.length} words to plurals-to-add.json`);
console.log('First 40:', uniqueToAdd.slice(0, 40).join(', '));

// Apply directly to words.js, preserving its existing sorted format.
const merged = [...new Set([...currentWords, ...uniqueToAdd])].sort();
const newContent = wordsRaw.replace(wordsMatch[1], JSON.stringify(merged));
fs.writeFileSync(wordsPath, newContent);
console.log(`\nwords.js: ${currentWords.length} -> ${merged.length} words`);
