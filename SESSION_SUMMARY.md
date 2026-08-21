# Session Summary — "Many Words" Game Design & Emulator

Date: 2026-08-18

## What this session produced

A complete game design document plus a playable browser-based emulator for
a new Scrabble-inspired word game called **Many Words**.

## Files in this folder

| File | Purpose |
|---|---|
| `GAME_DESIGN.md` | The full game design document — rules, scoring, tile pool, UI spec. Source of truth for how the game is supposed to work. |
| `index.html` | Emulator page structure. |
| `style.css` | Emulator styling, including the tile point-value color scheme. |
| `game.js` | All emulator game logic (tile dealing, scoring, guess evaluation, timer). |
| `words.js` | Dictionary used to validate guesses — the public-domain **ENABLE** word list (172,727 words), used as a stand-in since the official NASPA Word List (NWL) is licensed and can't be redistributed here. |

## How the game evolved today

1. **Initial concept** — a Scrabble-style word game: draw 9 letter tiles
   (Scrabble letter proportions and point values), race a 10-minute clock
   to form as many words as possible, score = sum of letter values.
2. **First refinements** — minimum word length set to 3 letters; capped the
   game at 9 total "rack refills"; made racks revisitable instead of
   disappearing; laid out as one rack per page (tiles on top, words found
   below).
3. **Built the first emulator** — a single HTML/CSS/JS app with the ENABLE
   word list for validation, paginated rack-by-rack UI, tile-clicking to
   build words, refill button capped at 9 pages.
4. **Major redesign — single page, best-word-per-scramble scoring**:
   - All scrambles visible at once on one page (no more pagination).
   - Each scramble tracks only its **best-scoring guess**, not a running
     list of every word found. Total score = sum of best scores.
   - Guesses are typed into a per-row input box with a **live score
     preview**: red if it doesn't beat the current best, promoted to green
     and locked in if it does.
   - Dropped the invalid-word time penalty and the global no-repeat rule
     (the same word can now be a scramble's best word more than once
     across different rows) — both by explicit choice, to keep
     experimentation free and each row independent.
5. **Sizing changes** — scrambles went from 10 → 6; rack size went from
   9 → 7 → 10 tiles.
6. **Wildcard rule** — every rack now gets **exactly one** wildcard
   (blank) tile, guaranteed, rather than blanks being drawn proportionally
   from the shared pool (which could leave a rack with zero or two).
7. **Custom point values** — replaced standard Scrabble letter values with
   a custom scale (kept the standard Scrabble letter *frequencies*, i.e.
   how many of each letter exist, but reassigned the points):
   - 1 pt: A E I N O R S T
   - 2 pt: C D L P U
   - 3 pt: B G H M Y
   - 5 pt: F K V W
   - 7 pt: X Z
   - 10 pt: J Q
8. **Tile visuals** — point value shown to the left of the letter on each
   tile (was previously a small corner badge). Tiles are now color-coded
   by point value: 1 = brown, 2 = red, 3 = orange, 4 = yellow (reserved,
   not currently used by any letter), 5 = green, 7 = purple, 10 = blue.
   Wildcards keep a separate neutral blue-gray so they don't get confused
   with the 10-point blue.

## How to play

Open `index.html` in a browser (double-click it, or run `open index.html`
from Terminal in this folder — no server needed). Click **Start Game**,
type a word into any row's box, and press **Enter** to try it — if it beats
that row's best score, it locks in and your total score updates.
