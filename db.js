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
`);

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

module.exports = {
  createUser, findUserByUsername, findUserById,
  MAX_LOBBY_PLAYERS, findJoinableLobby, findLobbyForUser, createLobby, addPlayerToLobby,
  removePlayerFromLobby, getLobby, getLobbyRoster, startLobbyCountdown,
  resetLobbyToWaiting, attachRoundToLobby,
  createRound, getRound, getRoundPlayers,
  upsertBestScore, getBestScore, getRoundScores,
};
