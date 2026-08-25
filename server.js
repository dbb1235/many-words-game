// Server-authoritative ALL6 game: rack generation, the dictionary, and
// guess scoring all live here now instead of in the browser. The client
// (all6.js) only renders what this returns and never sees WORD_LIST or
// the letter bag logic — see MULTIPLAYER_PLAN.md step 1.

const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const db = require('./db');
const auth = require('./auth');
const mailer = require('./mailer');

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
// 10% of a rack's slots are double-letter; of the slots that leaves,
// 10% are triple-letter (9% absolute, since it's 10% of the remaining
// 90%) — see MULTIPLAYER_PLAN.md §3a "Competitive scoring rules" (was
// 8%/4%, resolved to 10%/10%-of-remainder). rollBottomBonuses only
// evaluates the 3L check once the 2L check has already failed, so this
// constant is itself the "of remainder" conditional rate (0.10), not
// the resulting 9% absolute figure — the 90%-remainder math falls out
// of that structure automatically.
const DOUBLE_LETTER_CHANCE = 0.10;
const TRIPLE_LETTER_CHANCE = 0.10;
const LONG_WORD_MIN_LEN = 8;
const LONG_WORD_BONUS = 10;
const WILDCARDS_PER_SCRAMBLE = 2;
// A word must clear this many points to count at all, even if it's a
// real dictionary word — see MULTIPLAYER_PLAN.md §3a. Matches the
// front-end mockup's previous client-only floor.
const MIN_WORD_SCORE = 4;

// Games expire after this long so the in-memory Map doesn't grow forever
// (no accounts/persistence yet — see plan step 1).
const GAME_TTL_MS = 60 * 60 * 1000;

// --- Dictionary (server-only) ---------------------------------------

const wordsRaw = fs.readFileSync(path.join(__dirname, 'words.js'), 'utf8');
const wordsMatch = wordsRaw.match(/new Set\((\[[\s\S]*\])\)/);
if (!wordsMatch) throw new Error('Could not parse words.js — expected `const WORD_LIST = new Set([...]);`');
const WORD_LIST = new Set(JSON.parse(wordsMatch[1]));

// --- Rack generation (ported from all6.js, unchanged logic) ---------
//
// Every function here takes an `rng` — a () => [0,1) function — instead
// of calling Math.random() directly. Single-player passes Math.random
// itself (unchanged behavior). Multiplayer rounds pass a seeded PRNG
// (mulberry32 below) so every player in a lobby gets identical racks
// from the same seed — MULTIPLAYER_PLAN.md §3.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Folds a hex seed string down to a 32-bit int to feed mulberry32.
function seedToInt(seedStr) {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) {
    h = (Math.imul(31, h) + seedStr.charCodeAt(i)) | 0;
  }
  return h;
}

function rngFromSeed(seed) {
  return mulberry32(seedToInt(seed));
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildLetterBag(rng) {
  const b = [];
  for (const [letter, data] of Object.entries(LETTER_DATA)) {
    if (letter === '?') continue;
    for (let i = 0; i < data.count; i++) b.push(letter);
  }
  return shuffle(b, rng);
}

function drawRackLetters(bag, count, maxPerLetter, rng) {
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
  shuffle(bag, rng);
  return drawn;
}

function rollBottomBonuses(count, rng) {
  return Array.from({ length: count }, () => {
    if (rng() < DOUBLE_LETTER_CHANCE) return '2L';
    if (rng() < TRIPLE_LETTER_CHANCE) return '3L';
    return undefined;
  });
}

function dealScramble(rng) {
  const bag = buildLetterBag(rng);
  const letters = drawRackLetters(bag, RACK_SIZE - WILDCARDS_PER_SCRAMBLE, MAX_DUPLICATE_LETTERS, rng);
  const tiles = letters.map((letter) => ({ letter, points: LETTER_DATA[letter].points }));
  for (let i = 0; i < WILDCARDS_PER_SCRAMBLE; i++) tiles.push({ letter: '?', points: 0 });
  shuffle(tiles, rng);
  return {
    tiles,
    bottomBonuses: rollBottomBonuses(RACK_SIZE, rng),
  };
}

function dealGame(rng) {
  const scrambles = [];
  for (let s = 0; s < NUM_SCRAMBLES; s++) scrambles.push(dealScramble(rng));
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
  const empty = { valid: false, word: '', score: 0, belowMinimum: false, rawScore: 0 };
  if (cells.length === 0) return empty;

  const sorted = [...cells].sort((a, b) => a.position - b.position);
  const word = sorted.map((c) => c.letter).join('').toUpperCase();

  if (!cellsAreSourceable(sorted, scramble)) {
    return { ...empty, word };
  }

  const inDictionary = word.length >= MIN_WORD_LEN && WORD_LIST.has(word);
  if (!inDictionary) return { ...empty, word };

  let rawScore = sorted.reduce((sum, cell) => {
    const points = cell.isWildcard ? 0 : (LETTER_DATA[cell.letter]?.points || 0);
    const bonus = bonusMultiplier(scramble.bottomBonuses[cell.position]);
    return sum + points * bonus;
  }, 0);

  if (word.length >= LONG_WORD_MIN_LEN) rawScore += LONG_WORD_BONUS;

  // A word must clear a minimum point value to count at all, even if
  // it's real — see MULTIPLAYER_PLAN.md §3a. This was previously only
  // enforced client-side in the front-end prototype; it belongs here so
  // single-player and multiplayer share one scoring authority.
  const belowMinimum = rawScore < MIN_WORD_SCORE;
  const valid = !belowMinimum;
  return { valid, word, score: valid ? rawScore : 0, belowMinimum, rawScore };
}

// --- HTTP app ----------------------------------------------------------

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname));

// --- Accounts ---------------------------------------------------------
// Registration/login required before either game mode — see
// MULTIPLAYER_PLAN.md §2. Sessions are a stateless JWT cookie (auth.js),
// not a server-side session store, so there's no in-memory session
// state to lose on a restart.

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const MIN_PASSWORD_LEN = 8;

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, underscore.' });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` });
  }
  if (db.findUserByUsername(username)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  const passwordHash = await auth.hashPassword(password);
  const user = db.createUser(username, passwordHash);
  auth.setAuthCookie(res, auth.issueToken(user));
  res.status(201).json({ id: user.id, username: user.username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const user = db.findUserByUsername(username);
  const passwordOk = user && await auth.verifyPassword(password, user.password_hash);
  if (!passwordOk) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }

  auth.setAuthCookie(res, auth.issueToken(user));
  res.json({ id: user.id, username: user.username });
});

app.post('/api/logout', (req, res) => {
  auth.clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', auth.attachUserIfPresent, (req, res) => {
  res.json({ user: req.user || null });
});

// --- Owner-notification endpoints --------------------------------------
// There's no self-service password reset yet — both of these just relay
// a message to the site owner's inbox via mailer.js, who handles it
// manually. Pure abuse-prevention throttle below (not durable state, so
// losing it on a restart is fine — see MULTIPLAYER_PLAN.md's "no
// in-memory state as the primary copy of anything that matters", which
// this isn't: nothing here is the source of truth for game state).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const rateLimitHits = new Map(); // ip -> recent request timestamps

function isRateLimited(ip, max, windowMs) {
  const now = Date.now();
  const hits = (rateLimitHits.get(ip) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  rateLimitHits.set(ip, hits);
  return hits.length > max;
}

app.post('/api/forgot-password', async (req, res) => {
  if (isRateLimited(req.ip, 5, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many requests — please try again later.' });
  }
  const { username, contactEmail, message } = req.body || {};
  if (typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'Username is required.' });
  }
  if (typeof contactEmail !== 'string' || !EMAIL_RE.test(contactEmail.trim())) {
    return res.status(400).json({ error: 'A valid email is required so we can reach you.' });
  }
  const cleanUsername = username.trim();
  const cleanMessage = typeof message === 'string' ? message.trim().slice(0, 2000) : '';
  const user = db.findUserByUsername(cleanUsername);

  await mailer.sendOwnerEmail({
    subject: `Gerbil password reset request: ${cleanUsername}`,
    text: [
      `Username: ${cleanUsername}`,
      `Account found: ${user ? 'yes' : 'no'}`,
      `Contact email: ${contactEmail.trim()}`,
      cleanMessage ? `Message: ${cleanMessage}` : null,
    ].filter(Boolean).join('\n'),
  });

  // Always a generic success, regardless of whether the username was
  // found — avoids letting this endpoint be used to test which
  // usernames exist.
  res.json({ ok: true });
});

app.post('/api/feedback', auth.attachUserIfPresent, async (req, res) => {
  if (isRateLimited(req.ip, 5, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many requests — please try again later.' });
  }
  const { message } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required.' });
  }
  const cleanMessage = message.trim().slice(0, 2000);

  await mailer.sendOwnerEmail({
    subject: `Gerbil feedback${req.user ? ` from ${req.user.username}` : ''}`,
    text: [
      `From: ${req.user ? req.user.username : 'anonymous (not logged in)'}`,
      `Message: ${cleanMessage}`,
    ].join('\n'),
  });

  res.json({ ok: true });
});

app.post('/api/game/new', auth.requireAuth, (req, res) => {
  pruneExpiredGames();
  const scrambles = dealGame(Math.random);
  const gameId = crypto.randomUUID();
  games.set(gameId, { scrambles, createdAt: Date.now(), userId: req.user.id });

  res.json({
    gameId,
    scrambles: scrambles.map((s) => ({ tiles: s.tiles, bottomBonuses: s.bottomBonuses })),
  });
});

app.post('/api/game/:gameId/guess', auth.requireAuth, (req, res) => {
  const game = games.get(req.params.gameId);
  if (!game) return res.status(404).json({ error: 'Game not found or expired' });
  if (game.userId !== req.user.id) return res.status(403).json({ error: 'Not your game' });

  const { scrambleIndex, cells } = req.body || {};
  const scramble = game.scrambles[scrambleIndex];
  if (!scramble) return res.status(400).json({ error: 'Invalid scrambleIndex' });
  if (!Array.isArray(cells)) return res.status(400).json({ error: 'cells must be an array' });

  const result = scoreGuess(scramble, cells);
  res.json(result);
});

// --- Lobbies & multiplayer rounds --------------------------------------
// See MULTIPLAYER_PLAN.md §2. Lobby/round phase is computed lazily from
// stored timestamps on every read — no background scheduler needed, same
// "any request just calculates what phase we're in" approach the
// original round-scheduling design used.

const LOBBY_COUNTDOWN_MS = 5 * 60 * 1000;
const ROUND_MS = 10 * 60 * 1000;

function regenerateRacks(seed) {
  return dealGame(rngFromSeed(seed));
}

// Reads a lobby's current state, performing the counting_down ->
// started transition inline if the 5 minutes have elapsed and no round
// exists yet. Synchronous and side-effecting on purpose: better-sqlite3
// is blocking, so this whole function runs to completion before Node
// picks up any other request — the read-then-maybe-write here can't
// race with a second request doing the same thing.
function getLobbyView(lobbyId) {
  const lobby = db.getLobby(lobbyId);
  if (!lobby) return null;

  if (lobby.status === 'counting_down' && !lobby.round_id) {
    const elapsed = Date.now() - lobby.countdown_started_at;
    if (elapsed >= LOBBY_COUNTDOWN_MS) {
      const roundId = crypto.randomUUID();
      const seed = crypto.randomBytes(16).toString('hex');
      const startAt = Date.now();
      db.createRound(roundId, lobbyId, seed, startAt, startAt + ROUND_MS);
      db.attachRoundToLobby(lobbyId, roundId);
      return getLobbyView(lobbyId); // re-read the now-'started' row
    }
  }

  const roster = db.getLobbyRoster(lobbyId);
  const view = {
    id: lobby.id,
    status: lobby.status,
    roster: roster.map((p) => p.username),
    maxPlayers: db.MAX_LOBBY_PLAYERS,
  };
  if (lobby.status === 'counting_down') {
    const remaining = LOBBY_COUNTDOWN_MS - (Date.now() - lobby.countdown_started_at);
    view.secondsUntilStart = Math.max(0, Math.ceil(remaining / 1000));
  }
  if (lobby.round_id) view.roundId = lobby.round_id;
  return view;
}

function isLobbyMember(lobbyId, userId) {
  return db.getLobbyRoster(lobbyId).some((p) => p.id === userId);
}

app.post('/api/lobby/join', auth.requireAuth, (req, res) => {
  // Idempotent: if you're already sitting in a not-yet-started lobby,
  // rejoin that one instead of getting dropped into a second lobby.
  let lobbyId;
  const already = db.findLobbyForUser(req.user.id);
  if (already) {
    lobbyId = already.id;
  } else {
    const joinable = db.findJoinableLobby();
    lobbyId = joinable ? joinable.id : crypto.randomUUID();
    if (!joinable) db.createLobby(lobbyId);
    db.addPlayerToLobby(lobbyId, req.user.id);
  }

  const roster = db.getLobbyRoster(lobbyId);
  const lobby = db.getLobby(lobbyId);
  if (lobby.status === 'waiting' && roster.length >= 2) {
    db.startLobbyCountdown(lobbyId);
  }

  res.json(getLobbyView(lobbyId));
});

app.get('/api/lobby/:id', auth.requireAuth, (req, res) => {
  if (!isLobbyMember(req.params.id, req.user.id)) {
    return res.status(403).json({ error: 'Not in this lobby' });
  }
  const view = getLobbyView(req.params.id);
  if (!view) return res.status(404).json({ error: 'Lobby not found' });
  res.json(view);
});

app.post('/api/lobby/:id/leave', auth.requireAuth, (req, res) => {
  const lobby = db.getLobby(req.params.id);
  if (!lobby) return res.status(404).json({ error: 'Lobby not found' });

  db.removePlayerFromLobby(req.params.id, req.user.id);

  const roster = db.getLobbyRoster(req.params.id);
  if (lobby.status === 'counting_down' && !lobby.round_id && roster.length < 2) {
    db.resetLobbyToWaiting(req.params.id);
  }

  res.json({ ok: true });
});

app.get('/api/round/:id/current', auth.requireAuth, (req, res) => {
  const round = db.getRound(req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const players = db.getRoundPlayers(req.params.id);
  if (!players.some((p) => p.id === req.user.id)) {
    return res.status(403).json({ error: 'Not a player in this round' });
  }

  const now = Date.now();
  const phase = now < round.end_at ? 'active' : 'ended';
  const secondsRemaining = Math.max(0, Math.ceil((round.end_at - now) / 1000));

  const response = { roundId: round.id, phase, secondsRemaining };
  if (phase === 'active') {
    const scrambles = regenerateRacks(round.seed);
    response.scrambles = scrambles.map((s) => ({ tiles: s.tiles, bottomBonuses: s.bottomBonuses }));
  }
  res.json(response);
});

app.post('/api/round/:id/guess', auth.requireAuth, (req, res) => {
  const round = db.getRound(req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const players = db.getRoundPlayers(req.params.id);
  if (!players.some((p) => p.id === req.user.id)) {
    return res.status(403).json({ error: 'Not a player in this round' });
  }
  if (Date.now() >= round.end_at) {
    return res.status(400).json({ error: 'Round has ended' });
  }

  const { scrambleIndex, cells } = req.body || {};
  const scrambles = regenerateRacks(round.seed);
  const scramble = scrambles[scrambleIndex];
  if (!scramble) return res.status(400).json({ error: 'Invalid scrambleIndex' });
  if (!Array.isArray(cells)) return res.status(400).json({ error: 'cells must be an array' });

  const result = scoreGuess(scramble, cells);
  if (result.valid) {
    db.upsertBestScore(round.id, req.user.id, scrambleIndex, result.word, result.score);
  }
  res.json(result);
});

app.get('/api/round/:id/leaderboard', auth.requireAuth, (req, res) => {
  const round = db.getRound(req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const players = db.getRoundPlayers(req.params.id);
  if (!players.some((p) => p.id === req.user.id)) {
    return res.status(403).json({ error: 'Not a player in this round' });
  }

  const rows = db.getRoundScores(round.id);

  const totals = new Map();
  const perRack = Array.from({ length: NUM_SCRAMBLES }, () => null);
  for (const row of rows) {
    totals.set(row.user_id, (totals.get(row.user_id) || { username: row.username, total: 0 }));
    totals.get(row.user_id).total += row.best_score;
    totals.get(row.user_id).username = row.username;

    const leader = perRack[row.scramble_index];
    if (!leader || row.best_score > leader.score) {
      perRack[row.scramble_index] = { username: row.username, score: row.best_score };
    }
  }

  const overall = [...totals.values()].sort((a, b) => b.total - a.total);
  res.json({ overall, perRack });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
