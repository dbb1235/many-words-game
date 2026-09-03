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

// Point values match standard Scrabble exactly (1/2/3/4/5/8/10 tiers) —
// deliberate choice for familiarity, not because simulation favored
// these numbers over the higher/wider-variance values tried earlier.
// Letter *quantities* stay the custom-tuned ones (see
// project_letter_bag_tuning in memory) — only points reverted.
const LETTER_DATA = {
  A: { count: 7, points: 1 }, B: { count: 1, points: 3 }, C: { count: 2, points: 3 },
  D: { count: 7, points: 2 }, E: { count: 15, points: 1 }, F: { count: 1, points: 4 },
  G: { count: 6, points: 2 }, H: { count: 1, points: 4 }, I: { count: 9, points: 1 },
  J: { count: 1, points: 8 }, K: { count: 1, points: 5 }, L: { count: 8, points: 1 },
  M: { count: 3, points: 3 }, N: { count: 6, points: 1 }, O: { count: 4, points: 1 },
  P: { count: 1, points: 3 }, Q: { count: 1, points: 10 }, R: { count: 6, points: 1 },
  S: { count: 5, points: 1 }, T: { count: 3, points: 1 }, U: { count: 5, points: 1 },
  V: { count: 1, points: 4 }, W: { count: 1, points: 4 }, X: { count: 1, points: 8 },
  Y: { count: 1, points: 4 }, Z: { count: 1, points: 10 }, '?': { count: 2, points: 0 },
};

const RACK_SIZE = 10;
const NUM_SCRAMBLES = 3;
const MIN_WORD_LEN = 3;
const MAX_DUPLICATE_LETTERS = 2;
// Vowel/duplicate bounds for the 9 dealt letters in a scramble — the
// wildcard is exempt from both since it can stand in for any letter, so
// it never enters either count. Enforced by re-rolling the draw until it
// fits (see scrambleLettersValid/dealScramble) rather than trying to
// constrain it incrementally.
const VOWELS = new Set(['A', 'E', 'I', 'O', 'U']);
const MAX_VOWELS_PER_SCRAMBLE = 5;
const MIN_VOWELS_PER_SCRAMBLE = 2;
const MAX_SCRAMBLE_DEAL_ATTEMPTS = 500;
const LONG_WORD_MIN_LEN = 8;
const LONG_WORD_BONUS = 10;
const WILDCARDS_PER_SCRAMBLE = 1;
// Temporarily off per earlier request — flip back to true to restore
// 2L/3L/2W. The client never needs its own toggle: it only colors/labels
// a slot based on what bottomBonuses says is there, so an all-empty
// array here already suppresses the tile coloring and the
// "2L"/"3L"/"2W" labels too.
const BONUS_TILES_ENABLED = false;
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

// Checks the vowel/duplicate rules against a scramble's 9 dealt letters
// (never the wildcard, which is exempt because it can stand in for
// anything).
function scrambleLettersValid(letters) {
  const counts = {};
  let vowels = 0;
  for (const letter of letters) {
    counts[letter] = (counts[letter] || 0) + 1;
    if (counts[letter] > MAX_DUPLICATE_LETTERS) return false;
    if (VOWELS.has(letter)) vowels++;
  }
  return vowels >= MIN_VOWELS_PER_SCRAMBLE && vowels <= MAX_VOWELS_PER_SCRAMBLE;
}

// Every rack gets exactly one 2L, one 3L, and one 2W slot — no longer a
// per-slot probability. The three get distinct positions by shuffling
// all slot indices and claiming the first three: index 0 is 2L, index 1
// is 3L, index 2 is 2W — so 2W always lands on a slot not already
// claimed by 2L or 3L.
function rollBottomBonuses(count, rng) {
  const bonuses = Array.from({ length: count }, () => undefined);
  if (!BONUS_TILES_ENABLED) return bonuses;
  const indices = shuffle(Array.from({ length: count }, (_, i) => i), rng);
  bonuses[indices[0]] = '2L';
  bonuses[indices[1]] = '3L';
  bonuses[indices[2]] = '2W';
  return bonuses;
}

function dealScramble(rng) {
  // The 9 dealt letters are re-rolled as a whole until the vowel/
  // duplicate rules pass. Attempts are cheap and the bag's vowel share
  // makes failures rare, so a bounded retry loop is simpler and more
  // robust than trying to constrain the draw incrementally.
  let letters;
  for (let attempt = 0; attempt < MAX_SCRAMBLE_DEAL_ATTEMPTS; attempt++) {
    const bag = buildLetterBag(rng);
    letters = drawRackLetters(bag, RACK_SIZE - WILDCARDS_PER_SCRAMBLE, MAX_DUPLICATE_LETTERS, rng);
    if (scrambleLettersValid(letters)) break;
  }

  const tiles = letters.map((letter) => ({ letter, points: LETTER_DATA[letter].points }));
  // Only the real letters get shuffled — wildcards are appended after,
  // unshuffled, so they always land in the rightmost WILDCARDS_PER_SCRAMBLE
  // slots rather than being randomly scattered through the rack.
  shuffle(tiles, rng);
  for (let i = 0; i < WILDCARDS_PER_SCRAMBLE; i++) tiles.push({ letter: '?', points: 0 });
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

  // 2W doubles the whole word's score (letter bonuses and the long-word
  // bonus included) rather than multiplying a single letter's points —
  // it only applies when a tile actually landed on the 2W slot.
  const coversDoubleWord = sorted.some((cell) => scramble.bottomBonuses[cell.position] === '2W');
  if (coversDoubleWord) rawScore *= 2;

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
app.use(express.json({ limit: '1mb' })); // default 100kb is too tight for a resized profile photo
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

// --- Profile (avatar + location) ----------------------------------------
// Stored as a small data URL directly in SQLite rather than a file on
// disk — likely free-tier hosting has an ephemeral filesystem (see
// MULTIPLAYER_PLAN.md's hosting notes), so anything saved to disk
// outside the DB would vanish on the next redeploy. The client resizes
// the image before it ever gets here; MAX_AVATAR_CHARS is just a floor
// against a request that skips that step.

const MAX_AVATAR_CHARS = 400000; // ~300KB raw — generous for a resized avatar, not for a full-size photo
const MAX_LOCATION_LEN = 60;

// Icons only, no photos — checked against the actual file bytes, not
// the client-claimed MIME type, so this can't be bypassed by relabeling
// a JPEG as a PNG before it hits this endpoint. The color-complexity
// heuristic that also runs client-side (see multiplayer.html) can't be
// meaningfully replicated here without an image-decoding dependency, so
// this format check is the one authoritative, unbypassable backstop.
const ALLOWED_AVATAR_FORMATS = new Set(['png', 'gif', 'webp', 'svg']);

function sniffImageFormat(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (/^(<\?xml|<svg)/i.test(buffer.subarray(0, 200).toString('utf8').trimStart())) return 'svg';
  return null;
}

app.get('/api/profile', auth.requireAuth, (req, res) => {
  const profile = db.getProfile(req.user.id);
  res.json({ avatarData: profile?.avatar_data || null, location: profile?.location || null });
});

app.post('/api/profile', auth.requireAuth, (req, res) => {
  let { avatarData, location } = req.body || {};

  if (avatarData != null) {
    const match = typeof avatarData === 'string' && /^data:image\/[a-zA-Z+.-]+;base64,(.+)$/.exec(avatarData);
    if (!match || avatarData.length > MAX_AVATAR_CHARS) {
      return res.status(400).json({ error: 'Invalid image.' });
    }
    const format = sniffImageFormat(Buffer.from(match[1], 'base64'));
    if (!format || !ALLOWED_AVATAR_FORMATS.has(format)) {
      return res.status(400).json({ error: 'Photos are not allowed — please upload a PNG, GIF, WEBP, or SVG icon/graphic.' });
    }
  } else {
    avatarData = null;
  }

  if (location != null) {
    if (typeof location !== 'string') return res.status(400).json({ error: 'Invalid location.' });
    location = location.trim().slice(0, MAX_LOCATION_LEN) || null;
  } else {
    location = null;
  }

  db.updateProfile(req.user.id, { avatarData, location });
  res.json({ ok: true });
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

// --- Direct messages & blocking -----------------------------------------
// Scoped by construction rather than by an explicit permission check:
// there's no user search/directory, so a player can only message someone
// whose exact username they already know — in practice, an opponent
// they've seen on a standings panel. Blocking is checked both directions
// before a send is allowed, but a GET only ever reveals blocks *you*
// placed, not whether the other person blocked you — no reason to tell
// a blocked sender why their message didn't go through.

const MAX_MESSAGE_LEN = 1000;

app.post('/api/messages', auth.requireAuth, (req, res) => {
  if (isRateLimited(`msg:${req.user.id}`, 20, 60 * 1000)) {
    return res.status(429).json({ error: 'Too many messages — slow down a bit.' });
  }
  const { toUsername, body } = req.body || {};
  if (typeof toUsername !== 'string' || !toUsername.trim()) {
    return res.status(400).json({ error: 'Recipient is required.' });
  }
  if (typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty.' });
  }
  const cleanBody = body.trim().slice(0, MAX_MESSAGE_LEN);
  const recipient = db.findUserByUsername(toUsername.trim());
  if (!recipient) return res.status(404).json({ error: 'That player was not found.' });
  if (recipient.id === req.user.id) return res.status(400).json({ error: "You can't message yourself." });
  if (db.isBlockedEitherWay(req.user.id, recipient.id)) {
    return res.status(403).json({ error: 'Unable to deliver this message.' });
  }

  const message = db.createMessage(req.user.id, recipient.id, cleanBody);
  res.status(201).json({
    id: message.id, body: cleanBody, senderUsername: req.user.username,
    mine: true, createdAt: message.createdAt,
  });
});

app.get('/api/messages', auth.requireAuth, (req, res) => {
  const conversations = db.getConversations(req.user.id).map((c) => ({
    username: c.username,
    lastBody: c.last_body,
    lastAt: c.last_at,
    lastFromMe: c.last_sender_id === req.user.id,
    unread: c.unread,
  }));
  res.json({ conversations });
});

app.get('/api/messages/:username', auth.requireAuth, (req, res) => {
  const other = db.findUserByUsername(req.params.username);
  if (!other) return res.status(404).json({ error: 'That player was not found.' });

  const messages = db.getConversation(req.user.id, other.id).map((m) => ({
    id: m.id, body: m.body, senderUsername: m.sender_username,
    mine: m.sender_id === req.user.id, createdAt: m.created_at,
  }));
  db.markMessagesRead(req.user.id, other.id);

  res.json({ messages, blockedByMe: db.isBlocked(req.user.id, other.id) });
});

app.post('/api/block', auth.requireAuth, (req, res) => {
  const { username } = req.body || {};
  const target = typeof username === 'string' && db.findUserByUsername(username.trim());
  if (!target) return res.status(404).json({ error: 'That player was not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't block yourself." });
  db.blockUser(req.user.id, target.id);
  res.json({ ok: true });
});

app.post('/api/unblock', auth.requireAuth, (req, res) => {
  const { username } = req.body || {};
  const target = typeof username === 'string' && db.findUserByUsername(username.trim());
  if (!target) return res.status(404).json({ error: 'That player was not found.' });
  db.unblockUser(req.user.id, target.id);
  res.json({ ok: true });
});

app.get('/api/blocked', auth.requireAuth, (req, res) => {
  res.json({ blocked: db.getBlockedUsers(req.user.id) });
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

const LOBBY_COUNTDOWN_MS = 5 * 1000; // temporarily shortened from 5 min for easier testing
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

  const { scrambleIndex, cells, force } = req.body || {};
  const scrambles = regenerateRacks(round.seed);
  const scramble = scrambles[scrambleIndex];
  if (!scramble) return res.status(400).json({ error: 'Invalid scrambleIndex' });
  if (!Array.isArray(cells)) return res.status(400).json({ error: 'cells must be an array' });

  const result = scoreGuess(scramble, cells);
  if (result.valid) {
    // `force` is the Override button — a player deliberately choosing to
    // score a lower word than one already on record for this rack.
    // Everywhere else (Hold, and single-player), the normal "only if
    // higher" rule applies.
    if (force) db.forceSetBestScore(round.id, req.user.id, scrambleIndex, result.word, result.score);
    else db.upsertBestScore(round.id, req.user.id, scrambleIndex, result.word, result.score);
  }
  res.json(result);
});

// Shared by the leaderboard GET and the winner-comment POST so "who's
// currently in first" is computed exactly one way — the same reasoning
// as scoring living in one place (see MULTIPLAYER_PLAN.md).
function computeRoundStandings(roundId) {
  const rows = db.getRoundScores(roundId);
  const totals = new Map();
  const perRack = Array.from({ length: NUM_SCRAMBLES }, () => null);
  for (const row of rows) {
    const entry = totals.get(row.user_id) || { userId: row.user_id, username: row.username, total: 0 };
    entry.total += row.best_score;
    totals.set(row.user_id, entry);

    const leader = perRack[row.scramble_index];
    if (!leader || row.best_score > leader.score) {
      perRack[row.scramble_index] = { username: row.username, score: row.best_score };
    }
  }
  const overall = [...totals.values()].sort((a, b) => b.total - a.total);
  return { overall, perRack };
}

app.get('/api/round/:id/leaderboard', auth.requireAuth, (req, res) => {
  const round = db.getRound(req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const players = db.getRoundPlayers(req.params.id);
  if (!players.some((p) => p.id === req.user.id)) {
    return res.status(403).json({ error: 'Not a player in this round' });
  }

  const { overall, perRack } = computeRoundStandings(round.id);

  // The winner callout only appears once the round is actually over —
  // showing it mid-round would crown whoever's ahead at that instant,
  // not the eventual winner.
  let winner = null;
  if (Date.now() >= round.end_at && overall.length > 0) {
    const top = overall[0];
    const profile = db.getProfile(top.userId);
    const comment = db.getRoundComment(round.id, top.userId);
    winner = {
      username: top.username,
      total: top.total,
      avatarData: profile ? profile.avatar_data : null,
      location: profile ? profile.location : null,
      comment: comment ? comment.body : null,
    };
  }

  res.json({ overall, perRack, winner });
});

const MAX_COMMENT_LEN = 500;

app.post('/api/round/:id/comment', auth.requireAuth, (req, res) => {
  const round = db.getRound(req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const { body } = req.body || {};
  if (typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'Comment cannot be empty.' });
  }

  const { overall } = computeRoundStandings(round.id);
  const winnerId = overall.length > 0 ? overall[0].userId : null;
  if (winnerId !== req.user.id) {
    return res.status(403).json({ error: 'Only the round winner can leave a comment.' });
  }

  db.upsertRoundComment(round.id, req.user.id, body.trim().slice(0, MAX_COMMENT_LEN));
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
