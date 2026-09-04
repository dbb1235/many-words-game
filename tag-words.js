// One-off (but re-runnable) script: tags every word in words.js with its
// part(s) of speech using WordPOS (offline, WordNet-backed — no network
// calls at runtime) and writes the result to words-pos.js. Re-run this
// whenever words.js's word list changes (see project_dictionary_curation
// in memory for the curation methodology itself).
//
// A word can be more than one part of speech (RUN is both a noun and a
// verb) — pos is always an array, and a word appears in every one of
// NOUN_WORDS/VERB_WORDS/ADJECTIVE_WORDS/ADVERB_WORDS it qualifies for,
// not just one. Words WordNet doesn't recognize at all (some of the
// curated modern-slang additions, mostly) get pos: [] and land in
// UNCLASSIFIED_WORDS instead — still perfectly valid for gameplay
// (words.js itself is untouched by this script), just not categorized.
//
// words-pos.js is deliberately NOT in server.js's PUBLIC_STATIC_FILES
// allowlist — same reasoning as words.js: the dictionary (and now its
// POS breakdown) lives only on the server.

const fs = require('fs');
const path = require('path');
const WordPOS = require('wordpos');

const wordpos = new WordPOS({ stopwords: false });

// WordNet's own lookup (and wordpos's isNoun/isVerb/etc.) only matches
// the literal string — 'abandons' and 'cats' return nothing even
// though 'abandon' and 'cat' are right there, because WordNet indexes
// base/lemma forms and expects the CALLER to de-inflect first (this is
// what the C `morphy` tool WordNet ships with does — wordpos doesn't
// wrap it). Our dictionary is full of plurals and verb conjugations
// (it's a word-tile game, not a vocabulary list), so without this,
// most of it would come back unclassified. This tries the regular
// English inflection patterns (plural -s/-es/-ies, verb -ed/-ing/-s
// with doubled-consonant handling, comparative -er/-est, -ly adverbs)
// and returns every plausible base form as a candidate — checked only
// when the literal word itself doesn't match anything, and only used
// if a candidate actually resolves. Not a full morphological analyzer
// (irregular forms like MICE->MOUSE or WENT->GO aren't covered), just
// enough to catch the regular cases that make up the bulk of a
// curated Scrabble-style word list.
function candidateBaseForms(lower) {
  const c = new Set();
  if (lower.endsWith('ies') && lower.length > 4) c.add(lower.slice(0, -3) + 'y');
  if (lower.endsWith('es')) { c.add(lower.slice(0, -2)); c.add(lower.slice(0, -1)); }
  if (lower.endsWith('s') && !lower.endsWith('ss')) c.add(lower.slice(0, -1));

  if (lower.endsWith('ied') && lower.length > 4) c.add(lower.slice(0, -3) + 'y');
  if (lower.endsWith('ed')) {
    c.add(lower.slice(0, -2));
    c.add(lower.slice(0, -1));
    if (lower.length > 4 && lower[lower.length - 3] === lower[lower.length - 4]) c.add(lower.slice(0, -3));
  }
  if (lower.endsWith('ing')) {
    c.add(lower.slice(0, -3));
    c.add(lower.slice(0, -3) + 'e');
    if (lower.length > 5 && lower[lower.length - 4] === lower[lower.length - 5]) c.add(lower.slice(0, -4));
  }

  if (lower.endsWith('iest') && lower.length > 5) c.add(lower.slice(0, -4) + 'y'); // happiest -> happy
  if (lower.endsWith('est')) { c.add(lower.slice(0, -3)); c.add(lower.slice(0, -2)); }
  if (lower.endsWith('ier') && lower.length > 4) c.add(lower.slice(0, -3) + 'y'); // happier -> happy
  else if (lower.endsWith('er')) { c.add(lower.slice(0, -2)); c.add(lower.slice(0, -1)); }
  if (lower.endsWith('ly') && lower.length > 4) c.add(lower.slice(0, -2));

  c.delete(lower);
  c.delete('');
  return [...c];
}

async function checkAllPOS(w) {
  const [isNoun, isVerb, isAdjective, isAdverb] = await Promise.all([
    wordpos.isNoun(w), wordpos.isVerb(w), wordpos.isAdjective(w), wordpos.isAdverb(w),
  ]);
  return { isNoun, isVerb, isAdjective, isAdverb };
}

async function main() {
  const wordsRaw = fs.readFileSync(path.join(__dirname, 'words.js'), 'utf8');
  const match = wordsRaw.match(/new Set\((\[[\s\S]*\])\)/);
  if (!match) throw new Error('Could not parse words.js — expected `const WORD_LIST = new Set([...]);`');
  const words = JSON.parse(match[1]);

  console.log(`Tagging ${words.length} words...`);
  const startedAt = Date.now();

  const WORD_POS = {};
  const NOUN_WORDS = [];
  const VERB_WORDS = [];
  const ADJECTIVE_WORDS = [];
  const ADVERB_WORDS = [];
  const UNCLASSIFIED_WORDS = [];

  let addedByInflection = 0;
  let done = 0;
  for (const word of words) {
    const lower = word.toLowerCase();
    let { isNoun, isVerb, isAdjective, isAdverb } = await checkAllPOS(lower);
    const literalHadAny = isNoun || isVerb || isAdjective || isAdverb;

    // Always check inflection candidates too, not just when the literal
    // word matched nothing — a word can have an unrelated literal sense
    // (RUNNING is directly a WordNet adjective, "a running joke") that
    // would otherwise mask its inflected one (RUN as a verb).
    for (const candidate of candidateBaseForms(lower)) {
      const r = await checkAllPOS(candidate);
      isNoun = isNoun || r.isNoun;
      isVerb = isVerb || r.isVerb;
      isAdjective = isAdjective || r.isAdjective;
      isAdverb = isAdverb || r.isAdverb;
    }
    if (!literalHadAny && (isNoun || isVerb || isAdjective || isAdverb)) addedByInflection++;

    const pos = [];
    if (isNoun) { pos.push('noun'); NOUN_WORDS.push(word); }
    if (isVerb) { pos.push('verb'); VERB_WORDS.push(word); }
    if (isAdjective) { pos.push('adjective'); ADJECTIVE_WORDS.push(word); }
    if (isAdverb) { pos.push('adverb'); ADVERB_WORDS.push(word); }
    if (pos.length === 0) UNCLASSIFIED_WORDS.push(word);

    WORD_POS[word] = pos;

    done++;
    if (done % 10000 === 0) console.log(`  ${done}/${words.length}...`);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s.`);
  console.log(`  nouns: ${NOUN_WORDS.length}, verbs: ${VERB_WORDS.length}, adjectives: ${ADJECTIVE_WORDS.length}, adverbs: ${ADVERB_WORDS.length}, unclassified: ${UNCLASSIFIED_WORDS.length}`);
  console.log(`  words with zero literal match, recovered via inflection: ${addedByInflection}`);

  const out = `// Generated by tag-words.js from words.js using WordPOS (WordNet-backed,
// offline — no network calls at runtime or at generation time beyond the
// one-time npm install). Re-run tag-words.js whenever words.js changes.
//
// WORD_POS maps every word to an array of the parts of speech it can be
// (many words are more than one — RUN is both a noun and a verb). The
// four *_WORDS lists are derived from that same map, one per part of
// speech; a word appears in every list it qualifies for. Words WordNet
// doesn't recognize at all get pos: [] and land only in
// UNCLASSIFIED_WORDS — still valid for gameplay (words.js is untouched
// by this), just not categorized here.
//
// Server-only, like words.js — deliberately not in server.js's
// PUBLIC_STATIC_FILES allowlist.

const WORD_POS = ${JSON.stringify(WORD_POS)};
const NOUN_WORDS = ${JSON.stringify(NOUN_WORDS)};
const VERB_WORDS = ${JSON.stringify(VERB_WORDS)};
const ADJECTIVE_WORDS = ${JSON.stringify(ADJECTIVE_WORDS)};
const ADVERB_WORDS = ${JSON.stringify(ADVERB_WORDS)};
const UNCLASSIFIED_WORDS = ${JSON.stringify(UNCLASSIFIED_WORDS)};

module.exports = { WORD_POS, NOUN_WORDS, VERB_WORDS, ADJECTIVE_WORDS, ADVERB_WORDS, UNCLASSIFIED_WORDS };
`;

  fs.writeFileSync(path.join(__dirname, 'words-pos.js'), out);
  console.log('Wrote words-pos.js');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
