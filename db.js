// All persistent state lives here, behind a small set of functions —
// nothing else in the app touches SQLite directly. That boundary is
// deliberate: when this moves to hosted Postgres for real deployment
// (see MULTIPLAYER_PLAN.md §9), only this file needs to change.

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
`);

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

module.exports = { createUser, findUserByUsername, findUserById };
