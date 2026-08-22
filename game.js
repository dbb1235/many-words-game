// Many Words — emulator
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

const HISTORY_KEY = 'manyWordsHistory';

const el = (id) => document.getElementById(id);

// --- Coordinate-reference grid overlay ---
// Toggled by #grid-toggle-btn. Purely a communication aid: lets the user
// point at a spot on the page by cell label (e.g. "move X from c45 to
// g32") instead of describing position in words. Click-through
// (pointer-events: none) and semi-transparent so it never blocks play.
const GRID_TARGET_CELLS = 300;
let gridOverlayEl = null;
let gridVisible = false;

// Spreadsheet-style column labels: 0->a, 25->z, 26->aa, 27->ab, ...
function colLabel(index) {
  let n = index + 1;
  let label = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(97 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

// Sizes cells so cols*rows lands near GRID_TARGET_CELLS while covering the
// full scrollable page (not just the viewport), so labels stay valid as
// the user scrolls.
function buildGridOverlay() {
  if (gridOverlayEl) gridOverlayEl.remove();

  const docWidth = document.documentElement.scrollWidth;
  const docHeight = document.documentElement.scrollHeight;
  const cellSize = Math.sqrt((docWidth * docHeight) / GRID_TARGET_CELLS);
  const cols = Math.max(1, Math.round(docWidth / cellSize));
  const rows = Math.max(1, Math.round(docHeight / cellSize));

  const overlay = document.createElement('div');
  overlay.id = 'coord-grid-overlay';
  overlay.style.width = `${docWidth}px`;
  overlay.style.height = `${docHeight}px`;
  overlay.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  overlay.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      cell.innerHTML = `<span>${colLabel(c)}${r + 1}</span>`;
      overlay.appendChild(cell);
    }
  }

  document.body.appendChild(overlay);
  gridOverlayEl = overlay;
}

function refreshGridIfVisible() {
  if (gridVisible) buildGridOverlay();
}

function toggleGrid() {
  gridVisible = !gridVisible;
  el('grid-toggle-btn').textContent = gridVisible ? 'Hide Grid' : 'Show Grid';
  if (gridVisible) {
    buildGridOverlay();
  } else if (gridOverlayEl) {
    gridOverlayEl.remove();
    gridOverlayEl = null;
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Default display order: highest point value first (stable for ties).
// The wildcard always sits at the far right.
function defaultOrderTiles(tiles) {
  const letters = tiles.filter((t) => t.letter !== '?').sort((a, b) => b.points - a.points);
  const blanks = tiles.filter((t) => t.letter === '?');
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
      displayTiles: defaultOrderTiles(tiles), guessOrigins: [],
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
  renderStatsPanel();
  clearInterval(timerHandle);
  timerHandle = setInterval(tick, 1000);
  updateTimerDisplay();
  refreshGridIfVisible();
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
  el('timer').textContent = `${m}:${s}`;
  el('timer').classList.toggle('low-time', secondsLeft <= 30);
}

function updateScore() {
  el('score').textContent = score;
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

// --- Per-scramble guess building (typing + click-to-build) ---
// A "ctx" bundles a scramble with the specific DOM elements that drive it.
// Every scramble now gets its own permanent card (built once in
// renderAllScrambles), so — unlike the old single "active" slot — there's
// no need to reattach anything between renders.

// Mirrors the guess input as individual letter tiles, so each letter can be
// double-clicked (a plain <input>'s text can't be targeted per-character).
function renderGuessTiles(ctx) {
  const strip = ctx.guessTilesEl;
  strip.innerHTML = '';
  const value = ctx.inputEl.value;
  Array.from(value).forEach((ch, i) => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.innerHTML = `<span class="letter">${ch}</span>`;
    tile.addEventListener('dblclick', () => removeGuessChar(ctx, i));
    strip.appendChild(tile);
  });
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

  const rect = tileEl.getBoundingClientRect();
  let left = rect.left;
  const maxLeft = window.innerWidth - menu.offsetWidth - 8;
  if (left > maxLeft) left = Math.max(8, maxLeft);
  menu.style.left = `${left}px`;
  menu.style.top = `${rect.bottom + 6}px`;

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
  ctx.inputEl.value += letter;
  ctx.scramble.guessOrigins.push(originTile || null);
  if (originTile) originTile.classList.add('used-in-guess');
  renderGuessTiles(ctx);
}

// Removes one character (by position) from the guess — used when
// double-clicking a guess tile. Restores the rack tile it came from, if any.
function removeGuessChar(ctx, index) {
  const chars = Array.from(ctx.inputEl.value);
  const origin = ctx.scramble.guessOrigins[index];
  chars.splice(index, 1);
  ctx.scramble.guessOrigins.splice(index, 1);
  ctx.inputEl.value = chars.join('');
  if (origin) origin.classList.remove('used-in-guess');
  renderGuessTiles(ctx);
}

// Keeps guessOrigins the same length as the input's value after ordinary
// typing (as opposed to clicks, which update it directly). Assumes edits
// happen at the end, which covers normal typing/backspacing.
function syncGuessOriginsToLength(ctx, newLength) {
  const origins = ctx.scramble.guessOrigins;
  while (origins.length > newLength) {
    const removed = origins.pop();
    if (removed) removed.classList.remove('used-in-guess');
  }
  while (origins.length < newLength) {
    origins.push(null);
  }
}

function clearGuess(ctx) {
  if (openMenuCtx === ctx) closeLetterMenu();
  ctx.scramble.guessOrigins.forEach((origin) => {
    if (origin) origin.classList.remove('used-in-guess');
  });
  ctx.scramble.guessOrigins = [];
  ctx.inputEl.value = '';
  renderGuessTiles(ctx);
}

function submitGuess(ctx) {
  const scramble = ctx.scramble;
  const word = ctx.inputEl.value.trim().toUpperCase();
  if (!word) return;
  const result = evaluateGuess(word, scramble.tiles);
  if (!result.valid || result.score <= scramble.bestScore) return;

  score += result.score - scramble.bestScore;
  scramble.bestWord = word;
  scramble.bestScore = result.score;
  updateScore();
  clearGuess(ctx);

  ctx.bestWordEl.textContent = word;
  ctx.bestWordEl.classList.remove('empty');
  ctx.bestScoreEl.textContent = `${scramble.bestScore} pts`;

  ctx.cardEl.classList.remove('just-improved');
  void ctx.cardEl.offsetWidth;
  ctx.cardEl.classList.add('just-improved');
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

    const top = document.createElement('div');
    top.className = 'scramble-top';
    const shuffleBtn = document.createElement('button');
    shuffleBtn.type = 'button';
    shuffleBtn.className = 'row-shuffle-btn';
    shuffleBtn.textContent = 'Shuffle';
    const tilesDiv = document.createElement('div');
    tilesDiv.className = 'tiles row-tiles';
    top.appendChild(shuffleBtn);
    top.appendChild(tilesDiv);

    const bottom = document.createElement('div');
    bottom.className = 'scramble-bottom';

    const bestDiv = document.createElement('div');
    bestDiv.className = 'best';
    const bestWordSpan = document.createElement('span');
    bestWordSpan.className = `best-word ${scramble.bestWord ? '' : 'empty'}`;
    bestWordSpan.textContent = scramble.bestWord || 'no word yet';
    const bestScoreSpan = document.createElement('span');
    bestScoreSpan.className = 'best-score';
    bestScoreSpan.textContent = `${scramble.bestScore} pts`;
    bestDiv.appendChild(bestWordSpan);
    bestDiv.appendChild(bestScoreSpan);

    const guessCol = document.createElement('div');
    guessCol.className = 'guess-area-col';
    const guessTilesDiv = document.createElement('div');
    guessTilesDiv.className = 'tiles guess-tiles-strip';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'guess-input';
    input.placeholder = 'Type a word, or click letters above…';
    input.maxLength = RACK_SIZE;
    guessCol.appendChild(guessTilesDiv);
    guessCol.appendChild(input);

    bottom.appendChild(bestDiv);
    bottom.appendChild(guessCol);
    card.appendChild(top);
    card.appendChild(bottom);
    container.appendChild(card);

    const ctx = {
      scramble,
      tilesEl: tilesDiv,
      guessTilesEl: guessTilesDiv,
      inputEl: input,
      bestWordEl: bestWordSpan,
      bestScoreEl: bestScoreSpan,
      cardEl: card,
    };
    scrambleCtxs.push(ctx);

    renderTileEls(tilesDiv, scramble.displayTiles);
    attachTileClickHandlers(ctx);
    clearGuess(ctx);

    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      submitGuess(ctx);
    });
    input.addEventListener('input', (e) => {
      syncGuessOriginsToLength(ctx, e.target.value.length);
      renderGuessTiles(ctx);
    });
    shuffleBtn.addEventListener('click', () => {
      scramble.displayTiles = shuffleTiles(scramble.tiles);
      renderTileEls(tilesDiv, scramble.displayTiles);
      attachTileClickHandlers(ctx);
      clearGuess(ctx);
    });
  });
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function recordGameResult(finalScore, highestWord, highestWordScore, longestWord) {
  const h = loadHistory() || {
    gamesPlayed: 0, bestScore: 0,
    highestWord: '', highestWordScore: 0, longestWord: '', totalScoreSum: 0,
  };
  h.gamesPlayed += 1;
  h.totalScoreSum += finalScore;
  if (finalScore > h.bestScore) {
    h.bestScore = finalScore;
  }
  if (highestWordScore > h.highestWordScore) {
    h.highestWordScore = highestWordScore;
    h.highestWord = highestWord;
  }
  if (longestWord.length > (h.longestWord || '').length) {
    h.longestWord = longestWord;
  }
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
}

// Bottom-right panel: all-time best/average score, highest-scoring word,
// and longest word.
function renderStatsPanel() {
  const h = loadHistory();
  const panel = el('stats-panel');
  if (!h || h.gamesPlayed === 0) {
    panel.innerHTML = `
      <h3>Your stats</h3>
      <p class="stats-empty">Finish a game to start tracking your stats.</p>
    `;
    return;
  }
  const avg = Math.round(h.totalScoreSum / h.gamesPlayed);
  panel.innerHTML = `
    <h3>Your stats</h3>
    <div class="stat-line"><span>Best game score</span><span>${h.bestScore}</span></div>
    <div class="stat-line"><span>Highest-scoring word</span><span>${h.highestWord ? `${h.highestWord} (${h.highestWordScore})` : '—'}</span></div>
    <div class="stat-line"><span>Longest word</span><span>${h.longestWord || '—'}</span></div>
    <div class="stat-line"><span>Average score</span><span>${avg}</span></div>
    <div class="stat-line"><span>Games played</span><span>${h.gamesPlayed}</span></div>
  `;
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

  recordGameResult(score, highest.word, Math.max(highest.score, 0), longest);
  renderStatsPanel();
  refreshGridIfVisible();
}

el('start-btn').addEventListener('click', startGame);
el('play-again-btn').addEventListener('click', startGame);
el('grid-toggle-btn').addEventListener('click', toggleGrid);
window.addEventListener('resize', refreshGridIfVisible);
