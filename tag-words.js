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
// most of it would come back unclassified.
//
// Each inflection pattern below only grants the specific POS that
// pattern actually represents grammatically — an earlier version
// checked every stripped candidate against all four POS and OR'd
// everything together onto the original word, which produced real
// false positives: ABANDONED (a verb past-tense/adjective) inherited
// NOUN because its base ABANDON happens to *also* be a noun in an
// unrelated sense ("with reckless abandon") that has no "abandoned"
// noun form; ABSOLUTELY (an adverb) inherited NOUN the same way via
// ABSOLUTE. Restricting each suffix to the POS it grammatically
// produces (comparative -er/-est -> adjective/adverb only, -ly ->
// adverb only if the base is an adjective, etc.) avoids that. Not a
// full morphological analyzer (irregular forms like MICE->MOUSE or
// WENT->GO aren't covered), just enough for the regular cases that
// make up the bulk of a curated Scrabble-style word list.
function inflectionCandidateGroups(lower) {
  // Plural noun / 3rd-person-singular verb share the same suffix and
  // are genuinely ambiguous by spelling alone, so this group checks
  // both — but nothing else (a stripped "-s" candidate doesn't grant
  // adjective or adverb just because it happens to also be one).
  const nounOrVerb = new Set();
  if (lower.endsWith('ies') && lower.length > 4) nounOrVerb.add(lower.slice(0, -3) + 'y');
  if (lower.endsWith('es')) { nounOrVerb.add(lower.slice(0, -2)); nounOrVerb.add(lower.slice(0, -1)); }
  if (lower.endsWith('s') && !lower.endsWith('ss')) nounOrVerb.add(lower.slice(0, -1));

  // Past tense / past participle. Grants verb always; adjective too
  // since -ed participles are routinely adjectival ("an abandoned
  // house") — but never noun, which is what caused the ABANDONED bug.
  const pastTense = new Set();
  if (lower.endsWith('ied') && lower.length > 4) pastTense.add(lower.slice(0, -3) + 'y');
  if (lower.endsWith('ed')) {
    pastTense.add(lower.slice(0, -2));
    pastTense.add(lower.slice(0, -1));
    if (lower.length > 4 && lower[lower.length - 3] === lower[lower.length - 4]) pastTense.add(lower.slice(0, -3));
  }

  // Gerund / present participle. Grants verb and adjective (same
  // reasoning as past tense — "running water") and noun too, since
  // gerunds genuinely are nouns ("the running of the bulls").
  const gerund = new Set();
  if (lower.endsWith('ing')) {
    gerund.add(lower.slice(0, -3));
    gerund.add(lower.slice(0, -3) + 'e');
    if (lower.length > 5 && lower[lower.length - 4] === lower[lower.length - 5]) gerund.add(lower.slice(0, -4));
  }

  // Comparative / superlative. Grants adjective or adverb only (never
  // noun/verb) — this is the -er/-est that attaches to adjectives
  // ("faster"), a different suffix in spelling-only terms from the
  // *unrelated* agent-noun -er ("teacher", verb+er=noun), which this
  // deliberately does not try to handle to avoid over-granting.
  const comparative = new Set();
  if (lower.endsWith('iest') && lower.length > 5) comparative.add(lower.slice(0, -4) + 'y'); // happiest -> happy
  if (lower.endsWith('est')) { comparative.add(lower.slice(0, -3)); comparative.add(lower.slice(0, -2)); }
  if (lower.endsWith('ier') && lower.length > 4) comparative.add(lower.slice(0, -3) + 'y'); // happier -> happy
  else if (lower.endsWith('er')) { comparative.add(lower.slice(0, -2)); comparative.add(lower.slice(0, -1)); }

  // Adverb formed from an adjective ("quick" -> "quickly"). Grants
  // *adverb* to the -ly word when the base is an adjective — grants
  // nothing else, which is what fixes the ABSOLUTELY-as-noun bug
  // (ABSOLUTE has an unrelated noun sense that must not leak here).
  const adverbFromAdjective = new Set();
  if (lower.endsWith('ly') && lower.length > 4) adverbFromAdjective.add(lower.slice(0, -2));

  for (const set of [nounOrVerb, pastTense, gerund, comparative, adverbFromAdjective]) {
    set.delete(lower);
    set.delete('');
  }
  return {
    nounOrVerb: [...nounOrVerb],
    pastTense: [...pastTense],
    gerund: [...gerund],
    comparative: [...comparative],
    adverbFromAdjective: [...adverbFromAdjective],
  };
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
    // would otherwise mask its inflected one (RUN as a verb). Each
    // group only grants the POS its own suffix pattern represents —
    // see inflectionCandidateGroups' comment for why that matters.
    const groups = inflectionCandidateGroups(lower);
    for (const c of groups.nounOrVerb) {
      const r = await checkAllPOS(c);
      isNoun = isNoun || r.isNoun;
      isVerb = isVerb || r.isVerb;
    }
    for (const c of groups.pastTense) {
      const r = await checkAllPOS(c);
      isVerb = isVerb || r.isVerb;
      isAdjective = isAdjective || r.isAdjective;
    }
    for (const c of groups.gerund) {
      const r = await checkAllPOS(c);
      isVerb = isVerb || r.isVerb;
      isAdjective = isAdjective || r.isAdjective;
      isNoun = isNoun || r.isNoun;
    }
    for (const c of groups.comparative) {
      const r = await checkAllPOS(c);
      isAdjective = isAdjective || r.isAdjective;
      isAdverb = isAdverb || r.isAdverb;
    }
    for (const c of groups.adverbFromAdjective) {
      const r = await checkAllPOS(c);
      isAdverb = isAdverb || r.isAdjective; // base is an adjective -> the -ly word is an adverb
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
