# Multiplayer Architecture Plan (draft)

This sketches what it would take to turn the current static, single-player
page into a scheduled, competitive, multiplayer version with accounts and
leaderboards. Nothing here is built yet — it's a plan to react to and
adjust before any implementation starts.

---

## 1. The core shift

Today everything — rack generation, scoring, the dictionary — runs in the
browser (`game.js`, `words.js`). That's fine for single-player, but for
competitive play the **server has to become the source of truth**:

- The server generates each round's scrambles, not the browser.
- The server validates every guess and computes every score, not the
  browser.
- The client becomes mostly a display + input layer that talks to the
  server over an API.

This is the one non-negotiable change — without it, any player can open
dev tools and either read the word list, fake a score submission, or see
other players' answers.

---

## 2. Round scheduling

- **Resolved**: each game keeps the current **10-minute** active length
  (matches the existing `GAME_SECONDS` timer), followed by a **2-minute
  pause** before the next one starts. That's a 12-minute cycle —
  `10 min active + 2 min pause = 12 min` — which lands exactly on your
  original example times (12:00, 12:12, 12:24, …), i.e. **5 cycles/hour**.
  (Your "6 times per hour" phrasing and the 12-minute example didn't
  quite match on their own — the pause is what reconciles them, assuming
  the 12-minute spacing is what you actually want. Flag if you'd rather
  keep the active game shorter so the *whole* 12-min cycle isn't the
  active time.)
- The pause is the intermission where the just-finished round's
  leaderboard is on display and the game screen is locked/read-only
  until the next round's countdown begins.
- Round boundaries are computed from the clock, not a stored schedule:
  `cycleStart = floor(now / cycleMs) * cycleMs`, where `cycleMs` = 12
  minutes. `now - cycleStart < activeMs` (10 min) means a round is live;
  otherwise the server is in the 2-minute pause window before the next
  one. No cron job needed — any server request just calculates "what
  phase are we in right now."
- Each round gets a **seed** used to deterministically generate that
  round's 6 scrambles, so every player sees identical racks. The seed
  should combine the round's start time with a **server-side secret**
  (e.g. HMAC), not just the plain timestamp — otherwise a motivated
  player could pre-compute a future round's letters before it starts.

---

## 3. Deterministic scramble generation

The existing bag/rack logic (`buildLetterBag`, `shuffle`, tile
assignment in `game.js`) can move to the server almost unchanged — the
only change needed is swapping `Math.random()` for a **seeded PRNG**
(e.g. mulberry32) initialized from the round seed, so the same seed
always produces the same 6 racks. The server generates a round's
scrambles once and caches them for the duration of that round.

---

## 4. API surface (sketch)

| Endpoint | Purpose |
|---|---|
| `POST /api/register` | Create account with a unique username |
| `POST /api/login` | Authenticate |
| `GET /api/round/current` | Returns round id, phase (`active` or `paused`), time remaining in that phase, and — if active — the 6 racks (tiles only, no answers) |
| `POST /api/round/:id/guess` | `{ scrambleIndex, word }` → server validates & scores, returns result |
| `GET /api/round/:id/leaderboard` | Top scores for that round |
| `GET /api/rounds/history` | Past rounds, for browsing previous leaderboards |

The scoring logic already in `game.js` (`scoreIfFormable`,
`evaluateGuess`) is reusable server-side essentially as-is, since it's
plain JS with no browser dependencies.

---

## 5. Anti-cheat basics

- The dictionary (`words.js`) lives only on the server; the client
  never receives the full word list, only pass/fail + score per guess.
- Only the **best score per user per scramble per round** is stored;
  resubmitting a worse word is a no-op, same as today.
- Rate-limit the guess endpoint per user to block scripted brute-forcing
  of a scramble.
- Round seeds are unpredictable until the round officially starts (see
  §2).

---

## 6. Data model (suggested)

```
users
  id, username (unique), password_hash, created_at

rounds
  id, start_at, end_at, seed

best_scores
  round_id, user_id, scramble_index, best_word, best_score, updated_at
  UNIQUE (round_id, user_id, scramble_index)
```

A round's total score per player is just `SUM(best_score)` grouped by
user — computed on read, no need to store it separately.

---

## 7. Live updates

- **MVP**: the game page and leaderboard page just poll the API every
  few seconds (simple, cheap, plenty fast enough for a 10-12 minute
  round).
- **Later, if wanted**: WebSockets/SSE for instant leaderboard pushes.
  Not necessary to start.

---

## 8. Suggested stack

- **Node.js + Express** — same language as the existing client code, so
  the rack/scoring logic ports over directly.
- **SQLite** (via `better-sqlite3`) to start — zero external
  dependencies, a single file. Migrate to hosted Postgres (Neon/Supabase
  free tier) only if/when it's needed.
- **bcrypt** for password hashing; simple session cookies or JWT for
  auth.
- Existing `index.html`/`style.css`/`game.js` get adapted to call the
  API instead of running the logic locally; served by the same Express
  app.

## 9. Deployment

Fly.io / Render free tier, per the earlier cost discussion — a single
always-on instance is plenty at this scale, no load balancer or
horizontal scaling needed to start.

---

## 10. Suggested build order

1. **Server-authoritative single-player** — move rack generation and
   scoring to the server with no accounts yet; client just displays
   what the server returns. This alone closes the "read the JS to
   cheat" hole and is a good first checkpoint to verify end-to-end.
2. **Accounts** — registration/login, unique usernames.
3. **Scheduled rounds** — shared seeded scrambles per time window.
4. **Leaderboard page** — per-round and/or all-time.
5. *(Optional, later)* live updates, abuse/rate-limit hardening, polish.

---

## 11. Open questions

- ~~Round interval~~ — **resolved**: 10 min active + 2 min pause = 12
  min cycle (5/hour), matching your original example times. Confirm
  this is what you want, since it does mean 5 games/hour rather than 6.
- ~~Round lock behavior~~ — **resolved**: round locks immediately at the
  10-minute mark; the 2-minute pause is exactly the leaderboard-display
  window before the next round opens.
- **Auth**: full username+password, or something lighter (e.g. just a
  claimed username, no password, for low-stakes casual competition)?
- Any rough expectation of concurrent players? (Sanity-checks whether
  the free-tier hosting plan is realistic.)
