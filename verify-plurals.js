// Checks every noun in words-pos.js's NOUN_WORDS for whether its
// computed plural form is also present in the game dictionary
// (words.js's WORD_LIST). Uses `pluralize` for the actual English
// rules (regular -s/-es/-ies plus a solid irregular-word list: man->men,
// mouse->mice, ox->oxen, etc.) rather than hand-rolling that logic again.
//
// Caveat pluralize itself can't resolve: it has no concept of "mass/
// uncountable noun" (furniture, water-as-substance, information), so it
// still generates a rule-based plural for those (FURNITURES) that's not
// real standard English and correctly won't be found in our dictionary
// — those show up in the "missing" list as false positives alongside
// genuine gaps (a real count noun whose valid plural just isn't in the
// curated word list). Read-only — this doesn't modify words.js or
// words-pos.js, just reports.

const fs = require('fs');
const path = require('path');
const pluralize = require('pluralize');

const wordsRaw = fs.readFileSync(path.join(__dirname, 'words.js'), 'utf8');
const wordsMatch = wordsRaw.match(/new Set\((\[[\s\S]*\])\)/);
const WORD_SET = new Set(JSON.parse(wordsMatch[1]));

const { NOUN_WORDS } = require('./words-pos.js');

const MAX_WORD_LEN = 10; // matches RACK_SIZE in server.js — words.js never includes anything longer

let alreadyInvariant = 0; // plural === singular (sheep, fish, series...)
let hasPlural = 0;
let tooLongToInclude = 0; // plural exceeds MAX_WORD_LEN, so it could never be in words.js regardless
const missing = [];

for (const noun of NOUN_WORDS) {
  const plural = pluralize.plural(noun.toLowerCase()).toUpperCase();
  if (plural === noun) { alreadyInvariant++; continue; }
  if (WORD_SET.has(plural)) { hasPlural++; continue; }
  if (plural.length > MAX_WORD_LEN) { tooLongToInclude++; continue; }
  missing.push({ noun, expectedPlural: plural });
}

console.log(`Total nouns checked: ${NOUN_WORDS.length}`);
console.log(`  invariant (plural === singular, e.g. SHEEP): ${alreadyInvariant}`);
console.log(`  plural form present in dictionary: ${hasPlural}`);
console.log(`  plural exceeds ${MAX_WORD_LEN} letters (couldn't be included regardless): ${tooLongToInclude}`);
console.log(`  plural form NOT present (genuine gap or non-count noun): ${missing.length}`);
console.log();
console.log(`Coverage among pluralizable, in-range nouns: ${(hasPlural / (hasPlural + missing.length) * 100).toFixed(1)}%`);

fs.writeFileSync(
  path.join(__dirname, 'missing-plurals.json'),
  JSON.stringify(missing, null, 2)
);
console.log(`\nWrote ${missing.length} entries to missing-plurals.json`);
console.log('\nFirst 40:');
missing.slice(0, 40).forEach((m) => console.log(`  ${m.noun} -> ${m.expectedPlural} (not in dictionary)`));
