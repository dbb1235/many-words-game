// ChrisWerds — emulator
// Implements the rules from GAME_DESIGN.md:
// - 6 scrambles (10 tiles each) drawn once at game start, all shown on one
//   page, all the SAME size — no enlarged "active" scramble anymore
// - each rack has exactly two wildcard (blank) tiles, no more and no fewer
// - every scramble is independently playable at all times: its own
//   Shuffle button, its own clickable tiles, its own guess input
// - each scramble tracks only its BEST scoring guess so far
// - total score = sum of the 6 best scores, live-updated
// - min word length 3, standard Scrabble letter values, dictionary-checked
// - same word may be reused as best word across multiple scrambles
// - no time penalty for invalid or non-improving guesses
// - length bonus (+1 per letter past 5)
// - the game can be ended early at any time via the Stop Game button
// - no more than 2 of any identical real letter per scramble (wildcards
//   are exempt, and can still supply a 3rd+ copy of a letter in a guess)
// - tiles are filled squares colored by point value (1-point tiles get a
//   light brown square; every other value gets a richer, saturated fill)
// - scrambles are not numbered

const LETTER_DATA = {
  A: { count: 9, points: 1 }, B: { count: 2, points: 3 }, C: { count: 2, points: 2 },
  D: { count: 4, points: 2 }, E: { count: 12, points: 1 }, F: { count: 2, points: 5 },
  G: { count: 3, points: 3 }, H: { count: 2, points: 3 }, I: { count: 9, points: 1 },
  J: { count: 1, points: 10 }, K: { count: 1, points: 5 }, L: { count: 4, points: 2 },
  M: { count: 2, points: 3 }, N: { count: 6, points: 1 }, O: { count: 8, points: 1 },
  P: { count: 2, points: 2 }, Q: { count: 1, points: 10 }, R: { count: 6, points: 1 },
  S: { count: 4, points: 1 }, T: { count: 6, points: 1 }, U: { count: 4, points: 2 },
  V: { count: 2, points: 5 }, W: { count: 2, points: 5 }, X: { count: 1, points: 7 },
  Y: { count: 2, points: 3 }, Z: { count: 1, points: 7 }, '?': { count: 2, points: 0 },
};

const RACK_SIZE = 10;
const NUM_SCRAMBLES = 6;
const MIN_WORD_LEN = 3;
const GAME_SECONDS = 10 * 60;
const MAX_DUPLICATE_LETTERS = 2;

let scrambles = [];      // { tiles, bestWord, bestScore, displayTiles, guessOrigins }
let scrambleCtxs = [];   // per-card DOM element bundle, parallel to `scrambles`
let score = 0;
let secondsLeft = GAME_SECONDS;
let timerHandle = null;
let gameActive = false;

const el = (id) => document.getElementById(id);

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Default/reset display order: alphabetical by letter, but the two
// wildcards always sit in the rightmost two spaces, same as after Shuffle.
function alphabeticalOrderTiles(tiles) {
  const letters = tiles.filter((t) => t.letter !== '?');
  const blanks = tiles.filter((t) => t.letter === '?');
  letters.sort((a, b) => a.letter.localeCompare(b.letter));
  return [...letters, ...blanks];
}

// Random display order, but the wildcard always sits at the far right.
function shuffleTiles(tiles) {
  const letters = tiles.filter((t) => t.letter !== '?');
  const blanks = tiles.filter((t) => t.letter === '?');
  shuffle(letters);
  return [...letters, ...blanks];
}

// Bag of real (non-blank) letter tiles only, in standard Scrabble
// proportions. Blanks are handled separately so every rack gets exactly
// two, regardless of the standard set's 2-blank total.
function buildLetterBag() {
  const b = [];
  for (const [letter, data] of Object.entries(LETTER_DATA)) {
    if (letter === '?') continue;
    for (let i = 0; i < data.count; i++) b.push(letter);
  }
  return shuffle(b);
}

// Draws `count` letters from the bag, skipping (and later returning) any
// letter that would exceed maxPerLetter duplicates within this one draw —
// so a single rack never gets more than maxPerLetter of the same letter.
function drawRackLetters(bag, count, maxPerLetter) {
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

  // Extremely unlikely fallback: if the bag ran dry before the cap could
  // be satisfied, fill the rest from the skipped pile rather than fail.
  while (drawn.length < count && skipped.length > 0) {
    drawn.push(skipped.pop());
  }

  bag.push(...skipped);
  shuffle(bag);
  return drawn;
}

function startGame() {
  const bag = buildLetterBag();
  scrambles = [];
  for (let s = 0; s < NUM_SCRAMBLES; s++) {
    const letters = drawRackLetters(bag, RACK_SIZE - 2, MAX_DUPLICATE_LETTERS);
    const tiles = letters.map((letter) => ({ letter, points: LETTER_DATA[letter].points }));
    tiles.push({ letter: '?', points: 0 });
    tiles.push({ letter: '?', points: 0 });
    shuffle(tiles);
    scrambles.push({
      tiles, bestWord: '', bestScore: 0,
      displayTiles: alphabeticalOrderTiles(tiles), guessOrigins: [], isShuffled: false,
    });
  }

  score = 0;
  secondsLeft = GAME_SECONDS;
  gameActive = true;

  el('game').classList.remove('hidden');
  el('game-over').classList.add('hidden');
  el('start-btn').textContent = 'Restart';
  el('stop-btn').classList.remove('hidden');
  updateScore();
  renderAllScrambles();
  clearInterval(timerHandle);
  timerHandle = setInterval(tick, 1000);
  updateTimerDisplay();
}

function tick() {
  if (!gameActive) return;
  secondsLeft--;
  if (secondsLeft <= 0) {
    secondsLeft = 0;
    updateTimerDisplay();
    endGame();
    return;
  }
  updateTimerDisplay();
}

function updateTimerDisplay() {
  const m = Math.floor(secondsLeft / 60).toString().padStart(2, '0');
  const s = (secondsLeft % 60).toString().padStart(2, '0');
  const text = `${m}:${s}`;
  el('timer').textContent = text;
  el('timer').classList.toggle('low-time', secondsLeft <= 30);
  el('info-timer').textContent = text;
  el('info-timer').classList.toggle('low-time', secondsLeft <= 30);
}

function updateScore() {
  el('score').textContent = score;
  el('info-score').textContent = score;
}

// Given a word and a scramble's tiles, determine if the word can be formed
// (respecting duplicate letter counts, with blanks as 0-point wildcards),
// preferring real tiles over blanks for every letter (maximizes score).
// Returns the raw letter-value score, or null if it can't be formed.
function scoreIfFormable(word, tiles) {
  const available = {};
  let blanks = 0;
  for (const t of tiles) {
    if (t.letter === '?') blanks++;
    else available[t.letter] = (available[t.letter] || 0) + 1;
  }
  let raw = 0;
  for (const ch of word) {
    if (available[ch] > 0) {
      available[ch]--;
      raw += LETTER_DATA[ch].points;
    } else if (blanks > 0) {
      blanks--;
      // blank contributes 0 points
    } else {
      return null;
    }
  }
  return raw;
}

function evaluateGuess(word, tiles) {
  if (word.length < MIN_WORD_LEN) return { valid: false };
  const raw = scoreIfFormable(word, tiles);
  if (raw === null) return { valid: false };
  if (!WORD_LIST.has(word)) return { valid: false };

  const lengthBonus = Math.max(0, word.length - 5);
  const total = raw + lengthBonus;

  return { valid: true, score: total, lengthBonus };
}

function renderTileEls(tilesDiv, tiles) {
  tilesDiv.innerHTML = '';
  tiles.forEach((t) => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.pts = t.points;
    tile.innerHTML = `<span class="letter">${t.letter === '?' ? '?' : t.letter}</span><span class="pts">${t.points}</span>`;
    tilesDiv.appendChild(tile);
  });
}

// --- Per-scramble guess building (click-to-build only, no typing) ---
// A "ctx" bundles a scramble with the specific DOM elements that drive it.

// Mirrors the in-progress guess as plain text — no tile boxes, no color —
// one letter per span so each can still be double-clicked to remove it.
// This is the ONLY way a guess is built — there is no text entry,
// click-only.
function renderGuessTiles(ctx) {
  const strip = ctx.guessTilesEl;
  strip.innerHTML = '';
  Array.from(ctx.guessValue).forEach((ch, i) => {
    const span = document.createElement('span');
    span.className = 'guess-letter';
    span.textContent = ch;
    span.addEventListener('dblclick', () => removeGuessChar(ctx, i));
    strip.appendChild(span);
  });

  updateLiveScore(ctx);
}

// Live score preview: as soon as the letters clicked so far spell a valid
// word, shows what it would score — updating with every click. The moment
// that score beats the scramble's current best, it's locked in immediately
// (no Submit button) — the guess stays in place so the player can keep
// clicking to try to extend it into an even better word. Shows nothing
// while the in-progress guess isn't a real word yet.
function updateLiveScore(ctx) {
  const word = ctx.guessValue.toUpperCase();
  const result = evaluateGuess(word, ctx.scramble.tiles);
  if (!result.valid) {
    ctx.liveScoreEl.textContent = '';
    return;
  }
  ctx.liveScoreEl.textContent = `${result.score} pts`;

  if (result.score > ctx.scramble.bestScore) {
    score += result.score - ctx.scramble.bestScore;
    ctx.scramble.bestWord = word;
    ctx.scramble.bestScore = result.score;
    updateScore();
    ctx.cardEl.classList.remove('just-improved');
    void ctx.cardEl.offsetWidth;
    ctx.cardEl.classList.add('just-improved');
  }
}

// Marks rack tiles clickable (single click = append their letter to the
// guess). Wildcards open a pulldown menu to choose which letter they stand
// in for. Stops propagation so clicking a tile never also triggers a
// parent row's "make this scramble active" click handler.
function attachTileClickHandlers(ctx) {
  const tileEls = Array.from(ctx.tilesEl.children);
  tileEls.forEach((tileEl, i) => {
    const tile = ctx.scramble.displayTiles[i];
    tileEl.classList.add('clickable-letter');
    if (tile.letter === '?') {
      tileEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (tileEl.classList.contains('used-in-guess')) return;
        toggleLetterMenu(ctx, tileEl);
      });
    } else {
      tileEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (tileEl.classList.contains('used-in-guess')) return;
        appendGuessLetter(ctx, tile.letter, tileEl);
      });
    }
  });
}

let openMenuTile = null;
let openMenuCtx = null;

function toggleLetterMenu(ctx, tileEl) {
  if (openMenuTile === tileEl) {
    closeLetterMenu();
    return;
  }
  openLetterMenu(ctx, tileEl);
}

// Pulldown of A-Z shown when a wildcard tile is clicked, so the player can
// pick which letter that blank should spell in the guess.
function openLetterMenu(ctx, tileEl) {
  closeLetterMenu();
  openMenuTile = tileEl;
  openMenuCtx = ctx;

  const menu = document.createElement('div');
  menu.className = 'letter-menu';
  menu.id = 'letter-menu';
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = letter;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      appendGuessLetter(ctx, letter, tileEl);
      closeLetterMenu();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);

  // Anchor to the whole tile row (not just the clicked tile) and place the
  // menu just outside it, left or right — every row's tiles share the same
  // x-range, so this can never land on top of any row's letters.
  const rowRect = (tileEl.closest('.row-tiles') || tileEl).getBoundingClientRect();
  const tileRect = tileEl.getBoundingClientRect();
  // getBoundingClientRect (not offsetWidth/Height, which ignore the page's
  // CSS zoom) so this stays in the same coordinate space as rowRect/tileRect.
  const menuBox = menu.getBoundingClientRect();
  const gapX = 6;
  let left = rowRect.right + gapX;
  if (left + menuBox.width + 8 > window.innerWidth) {
    left = rowRect.left - menuBox.width - gapX;
  }
  left = Math.max(8, left);

  let top = tileRect.top;
  const maxTop = window.innerHeight - menuBox.height - 8;
  top = Math.min(Math.max(8, top), Math.max(8, maxTop));

  // A `position:fixed` descendant of a zoomed ancestor has its left/top
  // style re-multiplied by the zoom factor at render time, but left/top
  // here were computed in already-zoomed getBoundingClientRect coordinates
  // — divide back out so the two multiplications cancel.
  const zoomFactor = parseFloat(getComputedStyle(document.body).zoom) || 1;
  menu.style.left = `${left / zoomFactor}px`;
  menu.style.top = `${top / zoomFactor}px`;

  setTimeout(() => {
    document.addEventListener('click', handleOutsideMenuClick);
    document.addEventListener('keydown', handleMenuEscape);
  }, 0);
}

function closeLetterMenu() {
  const existing = document.getElementById('letter-menu');
  if (existing) existing.remove();
  openMenuTile = null;
  openMenuCtx = null;
  document.removeEventListener('click', handleOutsideMenuClick);
  document.removeEventListener('keydown', handleMenuEscape);
}

function handleOutsideMenuClick(e) {
  const menu = document.getElementById('letter-menu');
  if (menu && !menu.contains(e.target)) closeLetterMenu();
}

function handleMenuEscape(e) {
  if (e.key === 'Escape') closeLetterMenu();
}

function appendGuessLetter(ctx, letter, originTile) {
  ctx.guessValue += letter;
  ctx.scramble.guessOrigins.push(originTile || null);
  if (originTile) originTile.classList.add('used-in-guess');
  renderGuessTiles(ctx);
}

// Removes one character (by position) from the guess — used when
// double-clicking a guess tile. Restores the rack tile it came from, if any.
function removeGuessChar(ctx, index) {
  const chars = Array.from(ctx.guessValue);
  const origin = ctx.scramble.guessOrigins[index];
  chars.splice(index, 1);
  ctx.scramble.guessOrigins.splice(index, 1);
  ctx.guessValue = chars.join('');
  if (origin) origin.classList.remove('used-in-guess');
  renderGuessTiles(ctx);
}

function clearGuess(ctx) {
  if (openMenuCtx === ctx) closeLetterMenu();
  ctx.scramble.guessOrigins.forEach((origin) => {
    if (origin) origin.classList.remove('used-in-guess');
  });
  ctx.scramble.guessOrigins = [];
  ctx.guessValue = '';
  renderGuessTiles(ctx);
}

// Builds all 6 scramble cards from scratch — every scramble is its own
// permanent, fully interactive card (own Shuffle button, own clickable
// tiles, own guess input), no enlarged/focused one and no numbering.
function renderAllScrambles() {
  closeLetterMenu();
  const container = el('scrambles');
  container.innerHTML = '';
  scrambleCtxs = [];

  scrambles.forEach((scramble) => {
    const card = document.createElement('div');
    card.className = 'scramble-card';

    // One row: Shuffle, the rack (the scramble), Start Over, the word being
    // built (as plain text — no boxes/colors), then its live point value.
    // No Submit button — a valid word that beats the scramble's best is
    // locked in automatically the moment it's formed (see updateLiveScore).
    const top = document.createElement('div');
    top.className = 'scramble-top';
    const shuffleBtn = document.createElement('button');
    shuffleBtn.type = 'button';
    shuffleBtn.className = 'row-shuffle-btn';
    shuffleBtn.textContent = 'Shuffle';
    const tilesDiv = document.createElement('div');
    tilesDiv.className = 'tiles row-tiles';
    const guessTilesDiv = document.createElement('div');
    guessTilesDiv.className = 'guess-tiles-strip';
    const liveScoreSpan = document.createElement('span');
    liveScoreSpan.className = 'live-score';
    const startOverBtn = document.createElement('button');
    startOverBtn.type = 'button';
    startOverBtn.className = 'start-over-btn';
    startOverBtn.textContent = 'Start Over';

    top.appendChild(shuffleBtn);
    top.appendChild(tilesDiv);
    top.appendChild(startOverBtn);
    top.appendChild(guessTilesDiv);
    top.appendChild(liveScoreSpan);
    card.appendChild(top);
    container.appendChild(card);

    const ctx = {
      scramble,
      tilesEl: tilesDiv,
      guessTilesEl: guessTilesDiv,
      guessValue: '',
      cardEl: card,
      liveScoreEl: liveScoreSpan,
    };
    scrambleCtxs.push(ctx);

    renderTileEls(tilesDiv, scramble.displayTiles);
    attachTileClickHandlers(ctx);
    clearGuess(ctx);

    startOverBtn.addEventListener('click', () => clearGuess(ctx));
    // Alternates each click: randomize, then back to alphabetical, then a
    // fresh randomize, etc. — never two shuffles in a row.
    shuffleBtn.addEventListener('click', () => {
      if (scramble.isShuffled) {
        scramble.displayTiles = alphabeticalOrderTiles(scramble.tiles);
        scramble.isShuffled = false;
      } else {
        scramble.displayTiles = shuffleTiles(scramble.tiles);
        scramble.isShuffled = true;
      }
      renderTileEls(tilesDiv, scramble.displayTiles);
      attachTileClickHandlers(ctx);
      clearGuess(ctx);
    });
  });
}

el('stop-btn').addEventListener('click', () => {
  if (!gameActive) return;
  endGame();
});

function endGame() {
  gameActive = false;
  clearInterval(timerHandle);
  closeLetterMenu();

  let longest = '';
  let highest = { word: '', score: -1 };

  scrambles.forEach((s) => {
    if (s.bestWord.length > longest.length) longest = s.bestWord;
    if (s.bestScore > highest.score) highest = { word: s.bestWord, score: s.bestScore };
  });

  const rowsHtml = scrambles.map((s, i) => `
    <tr>
      <td>#${i + 1}</td>
      <td>${s.tiles.map((t) => (t.letter === '?' ? '_' : t.letter)).join('')}</td>
      <td>${s.bestWord || '—'}</td>
      <td>${s.bestScore}</td>
    </tr>
  `).join('');

  const stats = el('final-stats');
  stats.innerHTML = `
    <div class="stat-line"><span>Final score</span><span>${score}</span></div>
    <div class="stat-line"><span>Longest best word</span><span>${longest || '—'}</span></div>
    <div class="stat-line"><span>Highest-scoring word</span><span>${highest.word ? `${highest.word} (${highest.score})` : '—'}</span></div>
    <table>
      <thead><tr><th>#</th><th>Scramble</th><th>Best word</th><th>Score</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;
  el('game-over').classList.remove('hidden');
  el('stop-btn').classList.add('hidden');
}

el('start-btn').addEventListener('click', startGame);
el('play-again-btn').addEventListener('click', startGame);
