// All persistent state lives here, behind a small set of functions —
// nothing else in the app touches SQLite directly. That boundary is
// deliberate: when this moves to hosted Postgres for real deployment
// (see MULTIPLAYER_PLAN.md §9), only this file needs to change.
//
// Lobbies and rounds are deliberately NOT tracked in server memory —
// see MULTIPLAYER_PLAN.md's "no in-memory state as the primary copy of
// anything that matters" — so a server restart never silently drops a
// waiting lobby or an in-progress round. Time-based fields (countdown
// start, round start/end) are stored as integer ms-since-epoch so phase
// transitions can be computed lazily from `Date.now()` on read, rather
// than needing a background scheduler to flip a status flag.

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'gerbil.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS lobbies (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'waiting', -- waiting | counting_down | started
    countdown_started_at INTEGER,
    round_id TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lobby_players (
    lobby_id TEXT NOT NULL REFERENCES lobbies(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    joined_at INTEGER NOT NULL,
    UNIQUE (lobby_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    lobby_id TEXT,
    seed TEXT NOT NULL,
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS best_scores (
    round_id TEXT NOT NULL REFERENCES rounds(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    scramble_index INTEGER NOT NULL,
    best_word TEXT,
    best_score INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE (round_id, user_id, scramble_index)
  );

  CREATE TABLE IF NOT EXISTS blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id),
    blocked_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    UNIQUE (blocker_id, blocked_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL REFERENCES users(id),
    recipient_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS round_comments (
    round_id TEXT NOT NULL REFERENCES rounds(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (round_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS single_player_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    total_score INTEGER NOT NULL,
    played_at INTEGER NOT NULL
  );
`);

// users.avatar_data/location were added after the table already existed
// in deployed databases — SQLite has no "ADD COLUMN IF NOT EXISTS", so
// this checks PRAGMA table_info first rather than risking a duplicate-
// column error on every server start.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('users', 'avatar_data', 'TEXT');
ensureColumn('users', 'location', 'TEXT');

// ---------- Users ----------

function createUser(username, passwordHash) {
  const stmt = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
  const info = stmt.run(username, passwordHash);
  return { id: info.lastInsertRowid, username };
}

function findUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function findUserById(id) {
  return db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(id);
}

// Deliberately separate from findUserById/findUserByUsername — those
// are called on every request in the auth-check hot path, and there's
// no reason to pull a (possibly tens-of-KB) avatar blob along for that
// every time. Only the handful of call sites that actually need profile
// display data reach for this one.
function getProfile(userId) {
  return db.prepare('SELECT id, username, avatar_data, location FROM users WHERE id = ?').get(userId);
}

function updateProfile(userId, { avatarData, location }) {
  db.prepare('UPDATE users SET avatar_data = ?, location = ? WHERE id = ?')
    .run(avatarData ?? null, location ?? null, userId);
}

// ---------- Lobbies ----------

const MAX_LOBBY_PLAYERS = 6;

// A lobby is still joinable if it hasn't started a round yet and has
// room — this includes 'counting_down' lobbies, not just 'waiting'
// ones, per the resolved rule that anyone joining during the 5-minute
// countdown gets into that same round.
function findJoinableLobby() {
  return db.prepare(`
    SELECT l.id FROM lobbies l
    WHERE l.round_id IS NULL
      AND (SELECT COUNT(*) FROM lobby_players WHERE lobby_id = l.id) < ?
    ORDER BY l.created_at ASC
    LIMIT 1
  `).get(MAX_LOBBY_PLAYERS);
}

// The not-yet-started lobby this user is already sitting in, if any —
// makes /api/lobby/join idempotent instead of adding them to a second
// lobby on a repeated call.
function findLobbyForUser(userId) {
  return db.prepare(`
    SELECT l.* FROM lobbies l
    JOIN lobby_players lp ON lp.lobby_id = l.id
    WHERE lp.user_id = ? AND l.round_id IS NULL
    ORDER BY l.created_at DESC
    LIMIT 1
  `).get(userId);
}

function createLobby(id) {
  db.prepare('INSERT INTO lobbies (id, status, created_at) VALUES (?, ?, ?)')
    .run(id, 'waiting', Date.now());
}

function addPlayerToLobby(lobbyId, userId) {
  db.prepare('INSERT OR IGNORE INTO lobby_players (lobby_id, user_id, joined_at) VALUES (?, ?, ?)')
    .run(lobbyId, userId, Date.now());
}

function removePlayerFromLobby(lobbyId, userId) {
  db.prepare('DELETE FROM lobby_players WHERE lobby_id = ? AND user_id = ?').run(lobbyId, userId);
}

function getLobby(lobbyId) {
  return db.prepare('SELECT * FROM lobbies WHERE id = ?').get(lobbyId);
}

function getLobbyRoster(lobbyId) {
  return db.prepare(`
    SELECT u.id, u.username FROM lobby_players lp
    JOIN users u ON u.id = lp.user_id
    WHERE lp.lobby_id = ?
    ORDER BY lp.joined_at ASC
  `).all(lobbyId);
}

function startLobbyCountdown(lobbyId) {
  db.prepare("UPDATE lobbies SET status = 'counting_down', countdown_started_at = ? WHERE id = ?")
    .run(Date.now(), lobbyId);
}

// Used when the roster drops below 2 mid-countdown — resets back to
// waiting for a 2nd player rather than letting a 1-player "multiplayer"
// round start (this specific case was left open in the plan; resetting
// matches the stated intent of requiring 2+ for real competition).
function resetLobbyToWaiting(lobbyId) {
  db.prepare("UPDATE lobbies SET status = 'waiting', countdown_started_at = NULL WHERE id = ?")
    .run(lobbyId);
}

function attachRoundToLobby(lobbyId, roundId) {
  db.prepare("UPDATE lobbies SET status = 'started', round_id = ? WHERE id = ?")
    .run(roundId, lobbyId);
}

// ---------- Rounds ----------

function createRound(id, lobbyId, seed, startAt, endAt) {
  db.prepare('INSERT INTO rounds (id, lobby_id, seed, start_at, end_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, lobbyId, seed, startAt, endAt);
}

function getRound(roundId) {
  return db.prepare('SELECT * FROM rounds WHERE id = ?').get(roundId);
}

function getRoundPlayers(roundId) {
  const round = getRound(roundId);
  if (!round || !round.lobby_id) return [];
  return getLobbyRoster(round.lobby_id);
}

// ---------- Single-player results ----------

function recordSinglePlayerResult(userId, totalScore, playedAt) {
  db.prepare('INSERT INTO single_player_results (user_id, total_score, played_at) VALUES (?, ?, ?)')
    .run(userId, totalScore, playedAt);
}

// Daily average groups sessions by calendar day (played_at is ms-since-
// epoch, SQLite's date() wants seconds) and sums same-day sessions
// before averaging across days — a person who plays 3 games in one day
// gets that day counted once, at its combined total, not three times.
function getSinglePlayerScoreboard(userId) {
  const personalBest = db.prepare(
    'SELECT MAX(total_score) AS best FROM single_player_results WHERE user_id = ?'
  ).get(userId).best || 0;

  const dailyAverage = db.prepare(`
    SELECT AVG(day_total) AS avg FROM (
      SELECT SUM(total_score) AS day_total
      FROM single_player_results
      WHERE user_id = ?
      GROUP BY date(played_at / 1000, 'unixepoch')
    )
  `).get(userId).avg || 0;

  return { personalBest, dailyAverage: Math.round(dailyAverage) };
}

// ---------- Scores ----------

// Only overwrites if the new score actually beats the stored one —
// resubmitting a worse word for the same rack is a no-op, same as the
// single-player behavior of "best word per scramble."
function upsertBestScore(roundId, userId, scrambleIndex, word, score) {
  db.prepare(`
    INSERT INTO best_scores (round_id, user_id, scramble_index, best_word, best_score, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (round_id, user_id, scramble_index)
    DO UPDATE SET best_word = excluded.best_word, best_score = excluded.best_score, updated_at = excluded.updated_at
    WHERE excluded.best_score > best_scores.best_score
  `).run(roundId, userId, scrambleIndex, word, score, Date.now());
}

// Unlike upsertBestScore, this always wins regardless of the stored
// score — the deliberate escape hatch for a player's own Override
// action, which lets them choose to score a lower word on purpose.
function forceSetBestScore(roundId, userId, scrambleIndex, word, score) {
  db.prepare(`
    INSERT INTO best_scores (round_id, user_id, scramble_index, best_word, best_score, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (round_id, user_id, scramble_index)
    DO UPDATE SET best_word = excluded.best_word, best_score = excluded.best_score, updated_at = excluded.updated_at
  `).run(roundId, userId, scrambleIndex, word, score, Date.now());
}

function getBestScore(roundId, userId, scrambleIndex) {
  return db.prepare(`
    SELECT * FROM best_scores WHERE round_id = ? AND user_id = ? AND scramble_index = ?
  `).get(roundId, userId, scrambleIndex);
}

// One row per (user, scramble) with each user's current total —
// totals are computed on read (SUM grouped by user), never stored.
function getRoundScores(roundId) {
  return db.prepare(`
    SELECT bs.user_id, u.username, bs.scramble_index, bs.best_word, bs.best_score
    FROM best_scores bs
    JOIN users u ON u.id = bs.user_id
    WHERE bs.round_id = ?
  `).all(roundId);
}

// One optional public comment per (round, user) — only ever written by
// whoever is the round's overall top scorer (enforced in server.js, not
// here), shown alongside the per-round winner callout. Upsert rather
// than insert-only so they can revise it while the round's still live.
function upsertRoundComment(roundId, userId, body) {
  db.prepare(`
    INSERT INTO round_comments (round_id, user_id, body, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (round_id, user_id) DO UPDATE SET body = excluded.body, created_at = excluded.created_at
  `).run(roundId, userId, body, Date.now());
}

function getRoundComment(roundId, userId) {
  return db.prepare('SELECT body FROM round_comments WHERE round_id = ? AND user_id = ?').get(roundId, userId);
}

// ---------- Blocks & direct messages ----------
//
// Messaging is only reachable from a shared standings panel (you can
// only message someone whose username you already know from playing
// against them) — there's no user search/directory, so this is
// naturally scoped without needing a separate access-control layer.
// Blocking is one-directional to record but checked both ways before
// any message is allowed to send.

function blockUser(blockerId, blockedId) {
  db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)')
    .run(blockerId, blockedId, Date.now());
}

function unblockUser(blockerId, blockedId) {
  db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(blockerId, blockedId);
}

function isBlocked(blockerId, blockedId) {
  return !!db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(blockerId, blockedId);
}

function isBlockedEitherWay(userAId, userBId) {
  return isBlocked(userAId, userBId) || isBlocked(userBId, userAId);
}

function getBlockedUsers(userId) {
  return db.prepare(`
    SELECT u.id, u.username FROM blocks b
    JOIN users u ON u.id = b.blocked_id
    WHERE b.blocker_id = ?
    ORDER BY b.created_at DESC
  `).all(userId);
}

function createMessage(senderId, recipientId, body) {
  const createdAt = Date.now();
  const info = db.prepare(`
    INSERT INTO messages (sender_id, recipient_id, body, created_at) VALUES (?, ?, ?, ?)
  `).run(senderId, recipientId, body, createdAt);
  return { id: info.lastInsertRowid, senderId, recipientId, body, createdAt };
}

function getConversation(userAId, userBId, limit = 200) {
  return db.prepare(`
    SELECT m.*, su.username AS sender_username FROM messages m
    JOIN users su ON su.id = m.sender_id
    WHERE (m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?)
    ORDER BY m.created_at ASC
    LIMIT ?
  `).all(userAId, userBId, userBId, userAId, limit);
}

function markMessagesRead(recipientId, senderId) {
  db.prepare(`
    UPDATE messages SET read_at = ? WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL
  `).run(Date.now(), recipientId, senderId);
}

// One row per other-user this player has ever exchanged messages with,
// most-recently-active first, each carrying its own unread count —
// everything the conversation-list UI needs in a single query.
function getConversations(userId) {
  return db.prepare(`
    SELECT
      other.id AS user_id,
      other.username,
      lm.body AS last_body,
      lm.created_at AS last_at,
      lm.sender_id AS last_sender_id,
      (SELECT COUNT(*) FROM messages
        WHERE recipient_id = ? AND sender_id = other.id AND read_at IS NULL) AS unread
    FROM (
      SELECT DISTINCT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS other_id
      FROM messages WHERE sender_id = ? OR recipient_id = ?
    ) t
    JOIN users other ON other.id = t.other_id
    JOIN messages lm ON lm.id = (
      SELECT id FROM messages
      WHERE (sender_id = ? AND recipient_id = other.id) OR (sender_id = other.id AND recipient_id = ?)
      ORDER BY created_at DESC LIMIT 1
    )
    ORDER BY lm.created_at DESC
  `).all(userId, userId, userId, userId, userId, userId);
}

module.exports = {
  createUser, findUserByUsername, findUserById, getProfile, updateProfile,
  MAX_LOBBY_PLAYERS, findJoinableLobby, findLobbyForUser, createLobby, addPlayerToLobby,
  removePlayerFromLobby, getLobby, getLobbyRoster, startLobbyCountdown,
  resetLobbyToWaiting, attachRoundToLobby,
  createRound, getRound, getRoundPlayers,
  recordSinglePlayerResult, getSinglePlayerScoreboard,
  upsertBestScore, forceSetBestScore, getBestScore, getRoundScores, upsertRoundComment, getRoundComment,
  blockUser, unblockUser, isBlocked, isBlockedEitherWay, getBlockedUsers,
  createMessage, getConversation, markMessagesRead, getConversations,
};
