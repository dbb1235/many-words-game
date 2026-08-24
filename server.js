// Server-authoritative ALL6 game: rack generation, the dictionary, and
// guess scoring all live here now instead of in the browser. The client
// (all6.js) only renders what this returns and never sees WORD_LIST or
// the letter bag logic — see MULTIPLAYER_PLAN.md step 1.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8420;

const LETTER_DATA = {
  A: { count: 9, points: 1 }, B: { count: 2, points: 3 }, C: { count: 2, points: 2 },
  D: { count: 4, points: 2 }, E: { count: 12, points: 1 }, F: { count: 2, points: 5 },
  G: { count: 3, points: 3 }, H: { count: 2, points: 3 }, I: { count: 9, points: 1 },
  J: { count: 1, points: 10 }, K: { count: 1, points: 5 }, L: { count: 4, points: 2 },
  M: { count: 2, points: 3 }, N: { count: 6, points: 1 }, O: { count: 8, points: 1 },
  P: { count: 2, points: 2 }, Q: { count: 1, points: 10 }, R: { count: 6, points: 1 },
  S: { count: 4, points: 1 }, T: { count: 6, points: 1 }, U: { count: 4, points: 2 },
  V: { count: 2, points: 5 }, W: { count: 2, points: 5 }, X: { count: 1, points: 7 },
  Y: { count: 2, points: 3 }, Z: { count: 1, points: 7 }, '?': { count: 2, points: 0 },
};

const RACK_SIZE = 10;
const NUM_SCRAMBLES = 6;
const MIN_WORD_LEN = 3;
const MAX_DUPLICATE_LETTERS = 2;
const DOUBLE_LETTER_CHANCE = 0.08;
const TRIPLE_LETTER_CHANCE = 0.04;
const WILDCARDS_PER_SCRAMBLE = 2;

// Games expire after this long so the in-memory Map doesn't grow forever
// (no accounts/persistence yet — see plan step 1).
const GAME_TTL_MS = 60 * 60 * 1000;

// --- Dictionary (server-only) ---------------------------------------

const wordsRaw = fs.readFileSync(path.join(__dirname, 'words.js'), 'utf8');
const wordsMatch = wordsRaw.match(/new Set\((\[[\s\S]*\])\)/);
if (!wordsMatch) throw new Error('Could not parse words.js — expected `const WORD_LIST = new Set([...]);`');
const WORD_LIST = new Set(JSON.parse(wordsMatch[1]));

// --- Rack generation (ported from all6.js, unchanged logic) ---------

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildLetterBag() {
  const b = [];
  for (const [letter, data] of Object.entries(LETTER_DATA)) {
    if (letter === '?') continue;
    for (let i = 0; i < data.count; i++) b.push(letter);
  }
  return shuffle(b);
}

function drawRackLetters(bag, count, maxPerLetter) {
  const drawn = [];
  const counts = {};
  const skipped = [];

  while (drawn.length < count && bag.length > 0) {
    const letter = bag.pop();
    if ((counts[letter] || 0) < maxPerLetter) {
      drawn.push(letter);
      counts[letter] = (counts[letter] || 0) + 1;
    } else {
      skipped.push(letter);
    }
  }

  while (drawn.length < count && skipped.length > 0) {
    drawn.push(skipped.pop());
  }

  bag.push(...skipped);
  shuffle(bag);
  return drawn;
}

function rollBottomBonuses(count) {
  return Array.from({ length: count }, () => {
    if (Math.random() < DOUBLE_LETTER_CHANCE) return '2L';
    if (Math.random() < TRIPLE_LETTER_CHANCE) return '3L';
    return undefined;
  });
}

function dealScramble() {
  const bag = buildLetterBag();
  const letters = drawRackLetters(bag, RACK_SIZE - WILDCARDS_PER_SCRAMBLE, MAX_DUPLICATE_LETTERS);
  const tiles = letters.map((letter) => ({ letter, points: LETTER_DATA[letter].points }));
  for (let i = 0; i < WILDCARDS_PER_SCRAMBLE; i++) tiles.push({ letter: '?', points: 0 });
  shuffle(tiles);
  return {
    tiles,
    bottomBonuses: rollBottomBonuses(RACK_SIZE),
  };
}

function dealGame() {
  const scrambles = [];
  for (let s = 0; s < NUM_SCRAMBLES; s++) scrambles.push(dealScramble());
  return scrambles;
}

// --- Game state (in-memory; no accounts yet) -------------------------

const games = new Map(); // gameId -> { scrambles, createdAt }

function pruneExpiredGames() {
  const now = Date.now();
  for (const [id, game] of games) {
    if (now - game.createdAt > GAME_TTL_MS) games.delete(id);
  }
}

// --- Guess validation & scoring --------------------------------------

function bonusMultiplier(bonus) {
  if (bonus === '2L') return 2;
  if (bonus === '3L') return 3;
  return 1;
}

// Verifies the claimed cells are actually sourceable from this scramble's
// dealt rack (multiset check on non-wildcard letters, cap on wildcard
// count) — a client can't invent letters it was never dealt.
function cellsAreSourceable(cells, scramble) {
  const rackCounts = {};
  let rackWildcards = 0;
  for (const t of scramble.tiles) {
    if (t.letter === '?') rackWildcards++;
    else rackCounts[t.letter] = (rackCounts[t.letter] || 0) + 1;
  }

  const usedCounts = {};
  let usedWildcards = 0;
  for (const cell of cells) {
    if (cell.isWildcard) {
      usedWildcards++;
    } else {
      usedCounts[cell.letter] = (usedCounts[cell.letter] || 0) + 1;
    }
  }

  if (usedWildcards > rackWildcards) return false;
  for (const [letter, count] of Object.entries(usedCounts)) {
    if (count > (rackCounts[letter] || 0)) return false;
  }
  return true;
}

function scoreGuess(scramble, cells) {
  // cells: [{ position, letter, isWildcard }], only occupied positions.
  if (cells.length === 0) return { valid: false, word: '', score: 0 };

  const sorted = [...cells].sort((a, b) => a.position - b.position);
  const word = sorted.map((c) => c.letter).join('').toUpperCase();

  if (!cellsAreSourceable(sorted, scramble)) {
    return { valid: false, word, score: 0 };
  }

  const valid = word.length >= MIN_WORD_LEN && WORD_LIST.has(word);
  if (!valid) return { valid: false, word, score: 0 };

  const score = sorted.reduce((sum, cell) => {
    const points = cell.isWildcard ? 0 : (LETTER_DATA[cell.letter]?.points || 0);
    const bonus = bonusMultiplier(scramble.bottomBonuses[cell.position]);
    return sum + points * bonus;
  }, 0);

  return { valid: true, word, score };
}

// --- HTTP app ----------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.post('/api/game/new', (req, res) => {
  pruneExpiredGames();
  const scrambles = dealGame();
  const gameId = crypto.randomUUID();
  games.set(gameId, { scrambles, createdAt: Date.now() });

  res.json({
    gameId,
    scrambles: scrambles.map((s) => ({ tiles: s.tiles, bottomBonuses: s.bottomBonuses })),
  });
});

app.post('/api/game/:gameId/guess', (req, res) => {
  const game = games.get(req.params.gameId);
  if (!game) return res.status(404).json({ error: 'Game not found or expired' });

  const { scrambleIndex, cells } = req.body || {};
  const scramble = game.scrambles[scrambleIndex];
  if (!scramble) return res.status(400).json({ error: 'Invalid scrambleIndex' });
  if (!Array.isArray(cells)) return res.status(400).json({ error: 'cells must be an array' });

  const result = scoreGuess(scramble, cells);
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
