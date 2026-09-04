// Reviews missing-plurals.json (from verify-plurals.js) against the
// EXACT SAME quality bar the rest of words.js was built with — ENABLE
// intersect SCOWL size-50 — rather than inventing a new standard for
// just this batch. See project_dictionary_curation in memory for the
// original methodology this mirrors.
//
// A "missing" plural can be missing for three different reasons, and
// only one of them is an actual gap worth fixing:
//   (a) not a real word at all (not in ENABLE either) -> correctly absent
//   (b) a real word, but ENABLE has it and SCOWL-50 doesn't (not common
//       enough) -> correctly absent, the curation filter did its job
//   (c) real AND common (in both ENABLE and SCOWL-50), just missing
//       from words.js's final 50,027 -> genuine gap, add it
//
// This checks each candidate against both sources and only adds
// case (c). Does not re-run the acronym/trade-name hand-review from
// the original curation — these are all regular plurals of nouns
// already approved in words.js, and a plural of an approved common
// noun essentially never independently becomes a problematic acronym
// or trade name, so that risk is negligible here.

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
const inEnableNotScowl = [];
const alreadyPresent = [];

for (const { noun, expectedPlural } of missing) {
  if (currentSet.has(expectedPlural)) { alreadyPresent.push(expectedPlural); continue; }
  const inEnable = ENABLE.has(expectedPlural);
  const inScowl = SCOWL_50.has(expectedPlural);
  if (inEnable && inScowl) {
    toAdd.push(expectedPlural);
  } else if (!inEnable) {
    notInEnable.push(expectedPlural);
  } else {
    inEnableNotScowl.push(expectedPlural);
  }
}

const uniqueToAdd = [...new Set(toAdd)].sort();

console.log(`\nOf ${missing.length} candidates:`);
console.log(`  already present (shouldn't happen, sanity check): ${alreadyPresent.length}`);
console.log(`  not a real word (not in ENABLE): ${notInEnable.length}`);
console.log(`  real but not common enough (in ENABLE, not SCOWL-50): ${inEnableNotScowl.length}`);
console.log(`  real AND common, genuinely missing -> ADDING: ${uniqueToAdd.length}`);

fs.writeFileSync(path.join(__dirname, 'plurals-to-add.json'), JSON.stringify(uniqueToAdd, null, 2));
console.log(`\nWrote ${uniqueToAdd.length} words to plurals-to-add.json`);
console.log('First 40:', uniqueToAdd.slice(0, 40).join(', '));

// Apply directly to words.js, preserving its existing sorted format.
const merged = [...new Set([...currentWords, ...uniqueToAdd])].sort();
const newContent = wordsRaw.replace(wordsMatch[1], JSON.stringify(merged));
fs.writeFileSync(wordsPath, newContent);
console.log(`\nwords.js: ${currentWords.length} -> ${merged.length} words`);
