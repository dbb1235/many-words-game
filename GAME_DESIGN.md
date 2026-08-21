# Many Words — Game Design Document

## 1. Concept

A fast-paced, single-screen word game. At the start of the game, the player
is dealt **6 scrambles** — each a set of 10 letter tiles, drawn from a
shared Scrabble-proportioned pool — and all 6 are visible at once on one
page. For each scramble, the player repeatedly guesses words that can be
formed from that scramble's letters; only the **best-scoring word found so
far** counts toward the score. The total score is the sum of the best word
for each of the 6 scrambles. Whoever (or whatever score) accumulates the
most points before the 10-minute clock runs out wins.

**One-line pitch:** *Six scrambles, one page, one clock — keep hunting each
scramble for a better word before time runs out.*

---

## 2. Core Loop

1. At game start, all **6 scrambles** are drawn at once (10 tiles each) and
   displayed as 6 rows on a single page. Nothing is hidden or paginated —
   the whole game board is visible from the first second.
2. Each row shows: the scramble's 10 tiles, the **best word found so far**
   for that scramble (blank at first), and its **score**.
3. Each row also has a **guess box**. The player types a candidate word for
   that scramble. As they type/submit, the game shows what score that word
   *would* earn:
   - Shown in **red** if it does not beat the row's current best (including
     invalid words, worth nothing).
   - Shown as the **new best** (and promoted into the Best Word column) if
     it exceeds the row's current best score.
4. The player can attempt as many guesses as they want, on any row, in any
   order, at any time — there is no rack depletion, no refill limit, and no
   penalty for a losing or invalid guess. The only constraint is time.
5. **Total score** = sum of the best score across all 6 rows, recalculated
   live as better words are found.
6. Repeat until the 10-minute timer expires.
7. Final score and stats are displayed.

This is a deliberate departure from a "consume tiles" word game: nothing is
ever spent or lost. Every scramble is a standing, revisitable puzzle for the
entire game, and progress is monotonic — a row's score can only go up, never
down. The tension is purely about **time allocation**: keep milking a
promising scramble for a better word, or move on and try another row.

---

## 3. Tile Pool

Uses the standard Scrabble English tile **distribution** (letter frequency,
100 tiles total), but with **custom point values** — not the standard
Scrabble scoring:

| Letter | Count | Points | Letter | Count | Points |
|--------|-------|--------|--------|-------|--------|
| A | 9 | 1 | N | 6 | 1 |
| B | 2 | 3 | O | 8 | 1 |
| C | 2 | 2 | P | 2 | 2 |
| D | 4 | 2 | Q | 1 | 10 |
| E | 12 | 1 | R | 6 | 1 |
| F | 2 | 5 | S | 4 | 1 |
| G | 3 | 3 | T | 6 | 1 |
| H | 2 | 3 | U | 4 | 2 |
| I | 9 | 1 | V | 2 | 5 |
| J | 1 | 10 | W | 2 | 5 |
| K | 1 | 5 | X | 1 | 7 |
| L | 4 | 2 | Y | 2 | 3 |
| M | 2 | 3 | Z | 1 | 7 |
| Blank | 2 | 0 | | | |

- **Blanks** can represent any letter but score 0 points, same as Scrabble.
- **Every rack gets exactly two wildcard tiles — no more, no fewer.** This
  overrides the standard set's 2-blank total: wildcards are dealt
  separately from the 98 non-blank letter tiles, two per scramble by rule,
  rather than drawn proportionally from the pool. This guarantees each of
  the 6 racks has the same wildcard flexibility instead of leaving it to
  chance.
- The other 8 tiles in each rack are drawn randomly (shuffled bag, no
  replacement) from the 98 non-blank letters in standard Scrabble
  proportions: 6 scrambles × 8 real letters = **48 of the 98 non-blank
  tiles are drawn**, comfortably within the pool with no reshuffle needed.
- Every scramble's letters are **fixed for the entire game** — they are
  never consumed or replaced, since a scramble can be guessed against
  repeatedly.

---

## 4. Scoring

- **Guess score** = sum of the point values of each letter used (no board
  multipliers, since there's no shared board) + bonuses below.
- **Bingo bonus:** a guess that uses all 10 tiles of a scramble at once
  awards a **+50 bonus**, mirroring Scrabble's "bingo" rule.
- **Length bonus (optional/tunable):** +1 point per letter beyond length 5,
  keeping long words competitive with letter-value stacking. Tunable — see
  9. Tuning Levers.
- **Per-scramble score** = the single highest-scoring valid guess made for
  that scramble so far (not a sum of every word found — only the best one
  counts).
- **Total score** = sum of the 6 per-scramble scores, shown at the top of
  the page and updated instantly whenever any row's best score improves.
- **Running timer** counts down from 10:00, always visible at the top,
  paired with a color/urgency cue in the final minute.

---

## 5. Rules & Validity

### 5.1 Valid words
- Verified against the **public-domain ENABLE word list**, used as a
  stand-in for the official NASPA Word List (NWL, formerly known as
  TWL06/OTWL) — the standard tournament dictionary used in North American
  Scrabble play — since the licensed NWL can't be redistributed here. This
  is the single source of truth for word validity; no other word lists
  (e.g. SOWPODS) are used, keeping judging consistent and unambiguous.
- **Minimum length: 3 letters.** Shorter guesses are always invalid.
- No proper nouns, abbreviations, or hyphenated/apostrophe words — same
  restrictions as Scrabble.
- A guess must be formable from that **row's own letter multiset**
  (respecting duplicate tile counts and blank wildcards) — e.g. a scramble
  with only one E can't be used to spell a word needing two Es. Guessing a
  word using a different row's letters is not possible — each guess box
  only draws from its own row.

### 5.2 Repeated words
- The **same word may be used as the best word on more than one scramble.**
  There is no global no-repeat rule — since each row's score is
  independent, reusing a strong word across multiple scrambles (when its
  letters happen to allow it) is a legitimate, intentional strategy rather
  than an exploit.
- Re-submitting the exact word that is already a row's best is harmless
  (it simply doesn't exceed the existing best, so nothing changes).

### 5.3 Invalid or non-improving guesses
- There is **no time penalty** for an invalid guess (bad word, wrong
  letters, too short) or for a valid guess that fails to beat the current
  best. It's simply shown in red and discarded — free experimentation is
  the point of the format. The only cost of guessing is the seconds it
  takes to type.

---

## 6. Page Layout & UI

Everything lives on **one page** — no navigation, no hidden state:

- **Header (always visible):** total score (top-left) and the countdown
  timer (top-right).
- **6 rows, one per scramble**, each containing:
  - The scramble's 10 letter tiles (with point values shown, as in Scrabble).
  - **Best word** found so far for that scramble, and its score.
  - A **guess box** to type a new candidate word for that scramble.
  - A **live score preview** next to the guess box: the score that guess
    would earn, in **red** unless it beats the current best, in which case
    it's shown as a win (e.g. green) and immediately promoted into the Best
    Word column — the total score updates at the same moment.
- Rows are always visible and always interactive — the player can jump
  between guess boxes in any order, at any time, with a click or Tab.

---

## 7. Session Structure

- **Timer:** 10:00 countdown (configurable — see Tuning Levers).
- **End condition:** timer hits 0:00. (There is no other end condition —
  all 6 scrambles remain guessable for the entire session.)
- **Game over screen** shows:
  - Final total score
  - The 6 scrambles with their final best word and score
  - Longest best word
  - Highest-scoring single best word
  - Bingo count (scrambles where the best word used all 10 tiles)

---

## 8. Modes

- **Solo / Time Attack (default):** beat your own high score.
- **Head-to-head:** two players each get their own independent set of 6
  scrambles, race simultaneously, higher total score after 10:00 wins.
  Useful for local or async pass-and-play.
- **Daily Challenge:** the same 6 pre-seeded scrambles for all players
  each day, leaderboard-style comparison (like Wordle-style shared
  puzzles).

---

## 9. Tuning Levers

Everything below should be easy to adjust without redesigning the core loop:

| Parameter | Default | Notes |
|---|---|---|
| Timer length | 10:00 | Could offer 3/5/10 min modes |
| Number of scrambles | 6 | Fixed, all visible on one page |
| Rack size (tiles per scramble) | 10 | Larger racks = more word options |
| Wildcards per rack | Exactly 2 | Fixed by rule, not drawn from the pool |
| Minimum word length | 3 | Shorter minimum = more possible words |
| Invalid/non-improving guess penalty | None | Free experimentation by design |
| Bingo bonus | +50 | Rewards using a full scramble in one word |
| Length bonus | +1/letter past 5 | Keeps long words competitive |
| Word list | ENABLE (public-domain stand-in for NASPA NWL/US) | Fixed — not regionally configurable |
| Repeat-word rule | Allowed across scrambles | Each row scores independently |

---

## 10. Why this works as a game

- **Zero setup friction, full transparency:** the whole game board — every
  scramble, every score — is visible at once, so the player always knows
  exactly where the remaining points might be.
- **Familiar mechanic, distinct scoring:** the tile-and-points format reads
  as instantly familiar from Scrabble, while the custom point values (see
  3. Tile Pool) give the game its own identity rather than just replaying
  Scrabble's scoring.
- **Monotonic progress removes anxiety:** because a score can only go up,
  every guess is purely upside — there's nothing to lose by trying a long
  shot.
- **Pure time-allocation strategy:** with no refill limits or penalties,
  the entire skill of the game is deciding which of the 6 scrambles still
  has a better word hiding in it, and when to stop digging and move to
  another row.
- **Live feedback loop:** the red/green scoring preview on every keystroke
  turns each guess into an instant, low-stakes signal, keeping the pacing
  snappy for a short time box.
