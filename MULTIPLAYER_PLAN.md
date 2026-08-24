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

**Third non-negotiable: no in-memory state as the primary copy of
anything that matters.** `server.js` today keeps single-player games in
a plain `Map()` living in the process's RAM — fine for a prototype, not
fine once real people depend on it, because that state vanishes
completely (no error, just gone) the instant the process restarts —
a crash, a deploy, or (on free-tier hosting) simply going to sleep
after idle time and waking up as a fresh process. Anything worth not
losing goes in the database instead:

- **User accounts** — DB (already the plan).
- **Lobbies** (roster, countdown state) — DB, not a `Map()`.
- **Active rounds** — DB, but cheaply: only the round's **seed** and
  start time need storing, not the racks themselves, since the same
  seed always regenerates the same 6 racks deterministically. A
  mid-round restart just re-derives the racks from the stored seed —
  nothing is lost, no special recovery path needed.
- **Single-player games** — same fix as multiplayer, for the same
  reason and for consistency, even though today's `Map()` is low-stakes
  on its own.

One database for all of it — the same Postgres already planned for
accounts (§8/§9). No Redis or second data store; at this scale a
database is fast enough for all of this, and running two stores would
be exactly the premature complexity §"Launch strategy" below says to
avoid.

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
  - **Resolved**: the instant that 2nd player joins, a **5-minute
    countdown starts immediately** (changed from the originally-stated
    2 minutes — 5 min "for now," may be revisited) — it does not wait
    to fill up to 6. Anyone who joins during those 5 minutes gets into
    the same round; late arrivals after countdown-zero go into a fresh
    lobby.
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

## 3a. Competitive scoring rules (multiplayer)

Resolved rules from the competitive-mechanics brainstorm, specific to
multiplayer (single-player keeps its existing behavior unless noted):

- **No word reuse — scoped to one scramble, not the whole round.** Once
  any player successfully plays a word on a given rack, that exact word
  is locked on *that rack only* — unavailable to every other player on
  that same rack for the rest of the round. It does **not** block the
  word anywhere else: if "MARKET" gets claimed on rack 1, it's still
  completely playable on rack 3, rack 5, or any other rack in the same
  round — each of the 6 racks tracks its own independent locked-word
  list. This is the "first claim locks it" mechanic from the
  brainstorm, now resolved as a firm rule rather than an option.
  Requires near-real-time visibility into claimed words per rack (see
  §7 — this is the case that actually needs faster-than-polling
  updates, not just the leaderboard). Does **not**
  change single-player, which still explicitly allows repeating a word
  across your own 6 racks (an earlier, separate decision — see
  `SESSION_SUMMARY.md`).
- **Bonus tile generation rate** — **done** in `server.js`, verified
  empirically at 9.96%/8.99% over 100k samples: of a rack's 10 guess slots, 10% are
  double-letter, and 10% of the *remaining* (non-2L) slots are
  triple-letter — roughly 1 double + ~0.9 triple per 10-slot rack on
  average, but as a genuine per-cell probability (10% / 9% absolute),
  not the fixed "always exactly one of each" the current mockups and
  `server.js` hardcode. This updates the original all6.js rates
  (`DOUBLE_LETTER_CHANCE = 0.08`, `TRIPLE_LETTER_CHANCE = 0.04`) to
  10% / 9%. Still open from the brainstorm, not yet resolved: whether
  bonus tiles are also *scarce across players* (first use consumes the
  cell for everyone, same as word-locking) — this rule only answers how
  many exist per rack, not whether they're shared.
- **Long-word bonus** — **done** in `server.js`: +10 flat points for any word 8 letters or
  longer, on top of normal scoring (including any bonus-tile
  multipliers on that word). Straightforward addition, no interaction
  with the other rules above.

---

## 4. API surface (sketch)

| Endpoint | Purpose |
|---|---|
| `POST /api/register` | Create account with a unique username + password |
| `POST /api/login` | Authenticate |
| `POST /api/single/new` | Start a private single-player game immediately (already built in step 1 — `server.js`) |
| `POST /api/lobby/join` | Join or create a waiting multiplayer lobby (max 6). Returns lobby id + current roster |
| `GET /api/lobby/:id` | Poll lobby state: roster, whether the 5-minute countdown has started, seconds until round start |
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

**Player history — store outcomes, not events.** `best_scores` above
already *is* a full permanent history of every player's every round,
essentially for free — that's the key design point that makes "keep
everyone's history forever" cheap: it holds one row per rack per round
per player (a best word + a number), not a log of every keystroke,
every wildcard pick, or every losing guess along the way. Do **not** add
a table that logs every guess attempt — that's the thing that would
actually make storage grow fast, and it's not needed for history
purposes.

Rough size check: 6 rows/round/player, each maybe 50-100 bytes → a
player who plays 5 rounds a day generates roughly 2-3 KB/day, ~1 MB/
year. Even at several thousand active daily players that's under a few
GB/year — a non-issue on any real database, free tier included, for a
long time. Add an index on `(user_id)` for fast "show my full history"
lookups. If storage ever genuinely becomes a concern at much larger
scale, the lever available then is dropping the `best_word` text on old
rows (keep the score, drop the word) rather than deleting history
outright — not needed now.

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
- **Database choice now depends on where this deploys — see §9.**
  SQLite (via `better-sqlite3`) is still simplest for local dev and for
  any host with a real persistent disk (e.g. Render's paid tier). But
  Render's *free* tier wipes local files on every restart, so the $0
  deployment path means starting with hosted Postgres (Neon's free
  tier) from day one rather than migrating to it later.
- **bcrypt** for password hashing; simple session cookies or JWT for
  auth.
- Existing `index.html`/`style.css`/`game.js` get adapted to call the
  API instead of running the logic locally; served by the same Express
  app.

## 9. Deployment

**Fly.io's free tier is gone** (removed 2024 — new accounts get a
2-hour/7-day trial, then it's paid). Checked current (Aug 2026) options
instead:

- **$0 path**: Render's free web service (750 hrs/month, no card) +
  Neon's free Postgres (0.5 GB, no card, never expires) hosted
  separately. **Catch**: Render's free tier has an ephemeral
  filesystem — a local SQLite file gets wiped on every restart/redeploy
  — so this path means swapping §8's SQLite plan for Postgres (`pg`
  instead of `better-sqlite3`; the query logic itself barely changes).
  Free compute also sleeps after 15 min idle, ~30-60s cold start on the
  next request.
- **Koyeb's free tier** includes a small persistent SSD (2 GB) alongside
  free compute, which might let SQLite survive as-is with no DB swap —
  worth verifying Koyeb's actual redeploy-persistence guarantee
  directly before relying on it; similar 1-hour-idle sleep behavior.
- **~$7/mo path**: Render's cheapest paid tier removes the sleep *and*
  adds a real persistent disk, so SQLite works completely unmodified —
  worth it once cold-start delays actually annoy real players. Railway
  is a similar story: "free" tier is thin in practice (~$1/mo for one
  always-on light service once the trial credit runs out).

A single instance is plenty at this scale either way — no load
balancer or horizontal scaling needed to start.

---

## 10. Suggested build order

1. ~~**Server-authoritative single-player**~~ — **done** (`server.js`):
   rack generation, dictionary, and scoring all moved server-side;
   client just displays what the server returns.
2. ~~**Accounts**~~ — **done** (`db.js`, `auth.js`): registration/login,
   unique usernames + bcrypt-hashed passwords, stateless JWT-cookie
   sessions. `/api/game/new` and `/api/game/:id/guess` now require
   login and are scoped to the owning user.
3. **Lobby matchmaking** — join/leave a waiting lobby, 5-minute countdown,
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
