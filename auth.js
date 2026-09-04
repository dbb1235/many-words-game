// Stateless auth: a signed JWT in an httpOnly cookie carries the
// player's identity. Deliberately no server-side session store — that
// would just reintroduce the in-memory-state problem (MULTIPLAYER_PLAN.md
// "no in-memory state as the primary copy of anything that matters") in
// a different shape. Verifying a token needs nothing but the secret
// below; nothing to look up, nothing that gets wiped on a restart.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const SECRET_FILE = path.join(__dirname, '.jwt-secret');
const COOKIE_NAME = 'gerbil_token';
const TOKEN_TTL = '365d';
const BCRYPT_ROUNDS = 10;

// Generated once per machine and persisted (gitignored) so existing
// logins survive a server restart — regenerating it on every boot would
// silently invalidate every player's session each time the process
// restarts, which defeats the point of a stateless token in the first
// place. In real deployment this becomes an actual env var/secret.
function loadOrCreateSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const secret = require('crypto').randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}

const SECRET = loadOrCreateSecret();

function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function issueToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

// Rejects the request if there's no valid token. Use on any route that
// needs to know who the player is.
function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Not logged in' });
  req.user = { id: payload.sub, username: payload.username };
  next();
}

// Attaches req.user if a valid token is present, but doesn't reject the
// request otherwise — for routes that behave differently when logged in
// without strictly requiring it.
function attachUserIfPresent(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const payload = token && verifyToken(token);
  if (payload) req.user = { id: payload.sub, username: payload.username };
  next();
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
  attachUserIfPresent,
};
