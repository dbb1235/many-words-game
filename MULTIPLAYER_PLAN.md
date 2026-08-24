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

**Second non-negotiable: one shared rules module, not two copies.**
Word-length minimum, the 4-point minimum-to-count floor, the good/bad
scoring threshold, bonus-tile (2L/3L) multiplier logic, and wildcard
handling must live in a single piece of code that both single-player
and multiplayer call — never duplicated into two implementations that
can drift apart. A rule change (e.g. "make it a 5-point minimum instead
of 4") should be a one-line edit that both modes pick up automatically,
not an edit you have to remember to make twice. (The current
`all6-feedback-mockup.html` / `gerbil-multiplayer-mockup.html` pair
*are* two separate files with duplicated rule logic — that's fine for
throwaway front-end prototypes, but the real server build must not
repeat that pattern: `server.js`'s scoring/validation code is the one
place these rules live, and both a single-player route and a
multiplayer lobby/round route call into it.)

---

## 2. Game modes & matchmaking

**Superseded** — the fixed-clock "everyone in the world is on the same
12-minute cycle" model below (kept for the record, struck through) is
replaced by **lobby-based matchmaking**: small on-demand games instead
of one global scheduled round.

- **Login required first.** Registration + real username/password —
  see §11, this replaces the earlier "just a display name" option.
- After login, the player picks **Single Player** or **Multiplayer**.
- **Single Player**: starts immediately on demand. This is exactly
  what the server-authoritative build from step 1 already does — a
  private, randomly-seeded set of 6 racks for just that player, no
  lobby, no synchronization with anyone else needed.
- **Multiplayer**: the player joins a **lobby** (a waiting room, not a
  global clock).
  - A lobby holds **up to 6 players**.
  - **Resolved**: a lobby waits for a **minimum of 2 players** before
    anything counts down — one player alone just waits (no timeout for
    now; a solo player could wait indefinitely if no one else joins).
  - **Resolved**: the instant that 2nd player joins, the **2-minute
    warning/countdown starts immediately** — it does not wait to fill
    up to 6. Anyone who joins during those 2 minutes gets into the same
    round; late arrivals after countdown-zero go into a fresh lobby.
  - **Resolved**: any waiting player can **leave the lobby at any point
    before the countdown reaches zero** (a "Leave lobby" action).
  - When the countdown hits zero, the server generates **one seeded
    round shared by every player in that lobby** — same mechanism as
    the struck-through model below (seed = round start + server
    secret, deterministic PRNG for the 6 racks), just scoped to one
    lobby's roster instead of the whole server.
  - All players in the lobby start their 10-minute clock at the same
    instant and see identical racks, exactly as described in the
    original ask.

~~**Resolved**: each game keeps the current **10-minute** active length~~
~~(matches the existing `GAME_SECONDS` timer), followed by a **2-minute~~
~~pause** before the next one starts. That's a 12-minute cycle —~~
~~`10 min active + 2 min pause = 12 min`... round boundaries computed~~
~~from the clock (`cycleStart = floor(now / cycleMs) * cycleMs`), no~~
~~lobby, no cron job — any server request just calculates "what phase~~
~~are we in right now."~~ — this whole-server-scheduled approach is
replaced by per-lobby rounds above. The **seeding mechanism itself**
(HMAC of round start + server secret, feeding a seeded PRNG) carries
over unchanged — it just now seeds one lobby's round instead of a
global one.

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
| `POST /api/register` | Create account with a unique username + password |
| `POST /api/login` | Authenticate |
| `POST /api/single/new` | Start a private single-player game immediately (already built in step 1 — `server.js`) |
| `POST /api/lobby/join` | Join or create a waiting multiplayer lobby (max 6). Returns lobby id + current roster |
| `GET /api/lobby/:id` | Poll lobby state: roster, whether the 2-minute warning has started, seconds until round start |
| `POST /api/lobby/:id/leave` | Back out of a lobby before the round starts |
| `GET /api/round/:id/current` | Returns round phase, time remaining, and — if active — the 6 racks (tiles only, no answers) |
| `POST /api/round/:id/guess` | `{ scrambleIndex, word }` → server validates & scores, returns result |
| `GET /api/round/:id/leaderboard` | Live standings for everyone in that round — total + per-rack leader, matching the mockup |
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

lobbies
  id, status (waiting | counting_down | started | done), max_players (6),
  created_at, countdown_started_at, round_id (nullable until it starts)

lobby_players
  lobby_id, user_id, joined_at
  UNIQUE (lobby_id, user_id)

rounds
  id, lobby_id (nullable — single-player rounds have none), start_at,
  end_at, seed

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

1. ~~**Server-authoritative single-player**~~ — **done** (`server.js`):
   rack generation, dictionary, and scoring all moved server-side;
   client just displays what the server returns.
2. **Accounts** — registration/login, unique usernames + passwords.
   Required before either mode is playable (§2).
3. **Lobby matchmaking** — join/leave a waiting lobby, 2-minute warning,
   shared seeded round once it starts (§2). Replaces the earlier
   fixed-clock scheduling idea.
4. **Live standings** — per-round leaderboard, both per-rack leading
   score and overall totals; front-end shape already prototyped in the
   `gerbil-multiplayer-mockup.html` artifact.
5. *(Optional, later)* live updates (WebSockets/SSE), abuse/rate-limit
   hardening, round history, polish.

---

## 11. Open questions

- ~~Round interval~~ — **superseded** by lobby-based matchmaking (§2) —
  no more global 12-minute cycle; each lobby runs its own 10-minute
  round once it starts.
- ~~Round lock behavior~~ — **resolved, carries over**: round locks
  immediately at the 10-minute mark.
- ~~Auth~~ — **resolved**: full registration + username/password
  required before playing, for both modes.
- ~~Lobby minimum to start~~ — **resolved**: waits for 2 players, no
  timeout for now (a solo waiter could wait indefinitely).
- ~~Lobby start trigger~~ — **resolved**: countdown begins the instant
  the 2nd player joins, does not wait to fill to 6.
- ~~Leaving a lobby~~ — **resolved**: allowed any time before the
  countdown reaches zero. Still open: if someone leaves *during* the
  countdown and the roster drops back to 1, does the countdown cancel
  (back to waiting for a 2nd player) or keep running?
- Any rough expectation of concurrent *lobbies* running at once?
  (Sanity-checks the free-tier hosting plan — one lobby of 6 is trivial
  load; many simultaneous lobbies is a different sizing question.)
